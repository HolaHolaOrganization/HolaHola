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

test('unique violations are recognized directly and when wrapped by the query layer', async () => {
  const { isUniqueViolation } = await import('./github-token-broker-store');
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23505' } })), true);
  assert.equal(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: { code: '23503' } })), false);
  assert.equal(isUniqueViolation(new Error('other')), false);
  assert.equal(isUniqueViolation(undefined), false);
});

test('grant store: founder transitions are conditional, one live grant per actor, revoke is terminal', async (t) => {
  if (!ciUrl) {
    t.skip('requires the job-local CI database (CI=true, CI_DATABASE_URL)');
    return;
  }
  opened = true;
  const { eq, inArray, sql } = await import('drizzle-orm');
  const { githubAppGrants, githubTokenAuditEvents } = await import('@shared/schema');
  const { getSharedDb } = await import('../db');
  const { githubTokenBrokerStore, GithubGrantError } = await import('./github-token-broker-store');
  const db = getSharedDb();
  const actor = 'luca-cursor';
  await db.delete(githubAppGrants).where(eq(githubAppGrants.actor, actor));

  const created: string[] = [];
  try {
    const first = await githubTokenBrokerStore.propose({ actor, appId: 111, installationId: 222 }, 'david');
    created.push(first.id);
    assert.equal(first.state, 'pending');
    assert.equal(await githubTokenBrokerStore.findLiveGrant(actor), null, 'a pending grant is not live');

    const approved = await githubTokenBrokerStore.decide(first.id, 'approve', 'david');
    assert.equal(approved.state, 'active');
    assert.ok(approved.expiresAt && approved.expiresAt.getTime() > Date.now());
    assert.equal((await githubTokenBrokerStore.findLiveGrant(actor))?.id, first.id);

    // A second live grant for the same actor is refused by the partial unique index.
    const second = await githubTokenBrokerStore.propose({ actor, appId: 333, installationId: 444 }, 'david');
    created.push(second.id);
    await assert.rejects(githubTokenBrokerStore.decide(second.id, 'approve', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT');

    // No skipping: approve twice, enable an active grant.
    await assert.rejects(githubTokenBrokerStore.decide(first.id, 'approve', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT');
    await assert.rejects(githubTokenBrokerStore.decide(first.id, 'enable', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT');

    assert.equal((await githubTokenBrokerStore.decide(first.id, 'disable', 'david')).state, 'disabled');
    assert.equal((await githubTokenBrokerStore.findLiveGrant(actor))?.state, 'disabled');

    // Re-enabling never resurrects an expired grant.
    await db.update(githubAppGrants).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(githubAppGrants.id, first.id));
    await assert.rejects(githubTokenBrokerStore.decide(first.id, 'enable', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT');

    const revoked = await githubTokenBrokerStore.decide(first.id, 'revoke', 'david');
    assert.equal(revoked.state, 'revoked');
    assert.ok(revoked.revokedAt);
    for (const decision of ['approve', 'enable', 'disable', 'revoke', 'reject'] as const) {
      await assert.rejects(githubTokenBrokerStore.decide(first.id, decision, 'david'),
        (error: unknown) => error instanceof GithubGrantError && error.code === 'CONFLICT', decision);
    }
    await assert.rejects(githubTokenBrokerStore.decide('00000000-0000-0000-0000-000000000000', 'approve', 'david'),
      (error: unknown) => error instanceof GithubGrantError && error.code === 'NOT_FOUND');
    assert.equal(await githubTokenBrokerStore.findLiveGrant(actor), null);

    // Audit rows exist for every decision and carry no credential material.
    await githubTokenBrokerStore.audit({ eventType: 'token_denied', success: false, actor, metadata: { token: 'ghs_secret', note: 'ok' } });
    const audits = await db.select().from(githubTokenAuditEvents).where(eq(githubTokenAuditEvents.actor, actor));
    assert.ok(audits.length >= 5);
    assert.ok(!JSON.stringify(audits).includes('ghs_secret'));
  } finally {
    if (created.length) await db.delete(githubAppGrants).where(inArray(githubAppGrants.id, created));
    await db.delete(githubTokenAuditEvents).where(eq(githubTokenAuditEvents.actor, actor));
  }
});
