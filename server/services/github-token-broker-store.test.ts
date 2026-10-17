/**
 * PostgreSQL-backed checks for the GitHub grant store. Runs only against the
 * job-local CI database (getVerifiedCiDatabaseUrl refuses anything else) and
 * skips elsewhere, so it never touches a shared or production database.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const ciUrl = getVerifiedCiDatabaseUrl();
let opened = false;
after(async () => {
  if (opened) {
    const { closeDbConnections } = await import('../db');
    await closeDbConnections();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('unique violations are recognized directly and when wrapped by the query layer', async () => {
  const { isUniqueViolation } = await import('./github-token-broker-store');
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23505' } })), true);
  assert.equal(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23503' } })), false);
  assert.equal(isUniqueViolation(new Error('other')), false);
  assert.equal(isUniqueViolation(undefined), false);
});

test('grant store on PostgreSQL: transitions, permanent App binding, fresh clock, decisions behind mints', async (t) => {
  if (!ciUrl) {
    t.skip('requires the job-local CI database (CI=true, CI_DATABASE_URL)');
    return;
  }
  opened = true;
  const { eq, inArray, sql } = await import('drizzle-orm');
  const { githubAppGrants, githubTokenAuditEvents } = await import('@shared/schema');
  const { getSharedDb } = await import('../db');
  const { githubTokenBrokerStore: store, GithubGrantError } = await import('./github-token-broker-store');
  const db = getSharedDb();
  const actorA = 'luca-cursor';
  const actorB = 'luca-openai-agents';
  const actors = [actorA, actorB];
  const conflict = (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT';
  const liveFor = (actor: string) => store.withMintLock(actor, async (grant) => grant);
  await db.delete(githubAppGrants).where(inArray(githubAppGrants.actor, actors));

  try {
    // ── Transitions ──────────────────────────────────────────────────────
    const first = await store.propose({ actor: actorA, appId: 111, installationId: 222 }, 'david');
    assert.equal(first.state, 'pending');
    assert.equal(await liveFor(actorA), null, 'a pending grant is not live');
    const approved = await store.decide(first.id, 'approve', 'david');
    assert.equal(approved.state, 'active');
    assert.ok(approved.expiresAt && approved.expiresAt.getTime() > Date.now());
    assert.equal((await liveFor(actorA))?.id, first.id);

    const secondForA = await store.propose({ actor: actorA, appId: 333, installationId: 444 }, 'david');
    await assert.rejects(store.decide(secondForA.id, 'approve', 'david'), conflict, 'one live grant per actor');
    await assert.rejects(store.decide(first.id, 'approve', 'david'), conflict, 'no re-approve');
    await assert.rejects(store.decide(first.id, 'enable', 'david'), conflict, 'cannot enable an active grant');
    assert.equal((await store.decide(first.id, 'disable', 'david')).state, 'disabled');
    await db.update(githubAppGrants).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(githubAppGrants.id, first.id));
    await assert.rejects(store.decide(first.id, 'enable', 'david'), conflict, 'never resurrect an expired grant');
    assert.equal((await store.decide(first.id, 'revoke', 'david')).state, 'revoked');
    for (const decision of ['approve', 'enable', 'disable', 'revoke', 'reject'] as const) {
      await assert.rejects(store.decide(first.id, decision, 'david'), conflict, `revoked is terminal: ${decision}`);
    }
    await assert.rejects(store.decide('00000000-0000-0000-0000-000000000000', 'approve', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'NOT_FOUND');

    // ── Permanent App binding (review R4 follow-up) ─────────────────────
    // App 111 / installation 222 were live for A (now revoked). B may never get them.
    const bSameApp = await store.propose({ actor: actorB, appId: 111, installationId: 900 }, 'david');
    const bSameInstall = await store.propose({ actor: actorB, appId: 901, installationId: 222 }, 'david');
    await assert.rejects(store.decide(bSameApp.id, 'approve', 'david'), conflict, 'revoked App stays bound to A');
    await assert.rejects(store.decide(bSameInstall.id, 'approve', 'david'), conflict, 'revoked installation stays bound to A');
    // A itself may be re-approved for its own App after a revoke.
    const aAgain = await store.propose({ actor: actorA, appId: 111, installationId: 222 }, 'david');
    assert.equal((await store.decide(aAgain.id, 'approve', 'david')).state, 'active');
    // While A is live, B cannot take the App either.
    const bWhileLive = await store.propose({ actor: actorB, appId: 111, installationId: 902 }, 'david');
    await assert.rejects(store.decide(bWhileLive.id, 'approve', 'david'), conflict);

    // ── Fresh clock: expiry during the lock wait is caught (review item 1) ─
    await db.update(githubAppGrants).set({ expiresAt: sql`clock_timestamp() + interval '1 second'` }).where(eq(githubAppGrants.id, aAgain.id));
    let releaseBlocker!: () => void;
    const blockerHeld = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    let blockerLocked!: () => void;
    const blockerReady = new Promise<void>((resolve) => { blockerLocked = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(githubAppGrants).where(eq(githubAppGrants.id, aAgain.id)).for('update');
      blockerLocked();
      await blockerHeld;
    });
    await blockerReady;
    const observed = store.withMintLock(actorA, async (grant, dbNow) => ({ grant, dbNow }));
    await sleep(1500); // the grant expires while the mint waits for its lock
    releaseBlocker();
    await blocker;
    const { grant: lockedGrant, dbNow } = await observed;
    assert.ok(lockedGrant?.expiresAt, 'grant row visible under the lock');
    assert.ok(dbNow.getTime() > lockedGrant.expiresAt.getTime(),
      'the clock read after acquiring the lock must show the grant as expired');

    // ── Decisions block behind an in-flight mint (review R1) ─────────────
    await db.update(githubAppGrants).set({ expiresAt: sql`now() + interval '1 day'` }).where(eq(githubAppGrants.id, aAgain.id));
    let releaseMint!: () => void;
    const mintHeld = new Promise<void>((resolve) => { releaseMint = resolve; });
    let lockedState: string | undefined;
    const mint = store.withMintLock(actorA, async (grant) => { lockedState = grant?.state; await mintHeld; return 'minted'; });
    await sleep(200);
    let revokeDone = false;
    const revoke = store.decide(aAgain.id, 'revoke', 'david').then((g) => { revokeDone = true; return g; });
    await sleep(500);
    assert.equal(revokeDone, false, 'the revoke must wait for the in-flight mint');
    releaseMint();
    assert.equal(await mint, 'minted');
    assert.equal(lockedState, 'active');
    assert.equal((await revoke).state, 'revoked');
    assert.equal(await liveFor(actorA), null, 'the next mint sees the committed revoke');

    // ── Audit rows are typed and scrubbed ────────────────────────────────
    await store.audit({ eventType: 'token_denied', success: false, actor: actorA, metadata: { token: 'ghs_secretmarker', nested: { token: 'ghs_secretmarker' }, authType: 'broker' } });
    const audits = await db.select().from(githubTokenAuditEvents).where(inArray(githubTokenAuditEvents.actor, actors));
    assert.ok(audits.length >= 8);
    assert.ok(!JSON.stringify(audits).includes('ghs_secretmarker'));
  } finally {
    await db.delete(githubAppGrants).where(inArray(githubAppGrants.actor, actors));
    await db.delete(githubTokenAuditEvents).where(inArray(githubTokenAuditEvents.actor, actors));
  }
});
