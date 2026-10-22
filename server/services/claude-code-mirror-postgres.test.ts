/** Claude Code mirror ingest and coverage against the CI job's disposable PostgreSQL (stage R-P1). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { blockDigest, filterEntry, rootDigest } from '@shared/claude-code-mirror-core.mjs';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

let opened = false;
after(async () => {
  if (opened) {
    const { closeDbConnections } = await import('../db');
    await closeDbConnections();
  }
});

test('mirror ingest keeps every observation immutable and converges coverage', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for mirror coverage');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  opened = true;
  const mirror = await import('./claude-code-mirror');
  const { getSharedDb } = await import('../db');
  const { sql } = await import('drizzle-orm');
  const session = `test-${randomUUID()}`;
  const actor = 'luca-claude-code';
  const u1 = filterEntry({ type: 'user', timestamp: 't1', origin: { kind: 'human' }, message: { content: 'hello' } });
  const a1 = filterEntry({ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'hi' }] } });
  const a1changed = filterEntry({ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'text', text: 'hi, edited' }] } });

  // First sync: two entries stored, retry is a no-op.
  let r = await mirror.ingestEntries(actor, session, [{ position: 0, uuid: 'U1', entry: u1 }, { position: 1, uuid: 'A1', entry: a1 }]);
  assert.deepEqual({ stored: r.stored, alreadyHeld: r.alreadyHeld }, { stored: 2, alreadyHeld: 0 });
  r = await mirror.ingestEntries(actor, session, [{ position: 1, uuid: 'A1', entry: a1 }]);
  assert.deepEqual({ stored: r.stored, alreadyHeld: r.alreadyHeld }, { stored: 0, alreadyHeld: 1 });

  // R6-1 and R6-9: a changed entry and a moved entry are new, flagged observations; nothing is overwritten.
  r = await mirror.ingestEntries(actor, session, [{ position: 1, uuid: 'A1', entry: a1changed }, { position: 2, uuid: 'U1', entry: u1 }]);
  assert.equal(r.stored, 2);
  assert.deepEqual(r.flagged.map((f) => f.flags), [['same-uuid-different-bytes'], ['position-moved']]);
  const rows = await getSharedDb().execute(sql`select count(*)::int as n from claude_code_entry_observations where session_id = ${session}`);
  assert.equal((rows as unknown as { rows: Array<{ n: number }> }).rows[0].n, 4);

  // Coverage: the local file now holds (0,U1,u1), (1,A1,a1changed), (2,U1,u1).
  const { contentSha256 } = await import('@shared/claude-code-mirror-core.mjs');
  const local = [
    { position: 0, uuid: 'U1', sha256: contentSha256(u1) },
    { position: 1, uuid: 'A1', sha256: contentSha256(a1changed) },
    { position: 2, uuid: 'U1', sha256: contentSha256(u1) },
  ];
  const digest = blockDigest(session, local);
  assert.deepEqual(await mirror.compareCoverage(actor, session, [{ index: 0, digest }]), { differing: [0], rootConfirmed: false });
  const check = await mirror.checkBlockTuples(session, 0, digest, local);
  assert.deepEqual(check, { missing: [], confirmed: true });
  // Test 13: variants converge. The server holds a superset, yet the unchanged local file differs nowhere.
  assert.deepEqual(await mirror.compareCoverage(actor, session, [{ index: 0, digest }]), { differing: [], rootConfirmed: true });
  assert.deepEqual(await mirror.confirmedRoots([session, `test-${randomUUID()}`]).then((x) => Object.values(x).map((v) => v === 'unknown')), [false, true]);
  assert.equal((await mirror.confirmedRoots([session]))[session], rootDigest(session, [{ index: 0, digest }]));

  // A missing tuple is reported and blocks confirmation; a wrong digest is refused.
  const extra = [...local, { position: 3, uuid: 'X', sha256: 'a'.repeat(64) }];
  assert.deepEqual((await mirror.checkBlockTuples(session, 0, blockDigest(session, extra), extra)).missing.map((t) => t.position), [3]);
  await assert.rejects(mirror.checkBlockTuples(session, 0, 'b'.repeat(64), local), /does not match/);
  await assert.rejects(mirror.ingestEntries(actor, session, [{ position: 0, entry: { type: 'user', cwd: '/x', message: { content: 'x' } } }]), /filtered form/);

  // Hook evidence: idempotent per occurrence and bytes; the same occurrence with other bytes is a flagged conflict.
  const occurrenceId = randomUUID();
  assert.deepEqual(await mirror.recordHookEvidence(actor, { occurrenceId, sessionId: session, kind: 'submitted-prompt', text: 'hello' }), { stored: true, conflict: false });
  assert.deepEqual(await mirror.recordHookEvidence(actor, { occurrenceId, sessionId: session, kind: 'submitted-prompt', text: 'hello' }), { stored: false, conflict: false });
  assert.deepEqual(await mirror.recordHookEvidence(actor, { occurrenceId, sessionId: session, kind: 'submitted-prompt', text: 'hello!' }), { stored: true, conflict: true });

  // Challenges carry the server clock.
  const challenge = await mirror.issueChallenge(actor, session);
  assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/);
  assert.ok(Math.abs(Date.parse(challenge.issuedAt) - Date.now()) < 5 * 60_000);
});
