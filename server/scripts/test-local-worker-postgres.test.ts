/**
 * Local Read-only Worker v1 — disposable real-database proof (design §7).
 *
 * Runs ONLY against a verified disposable database:
 *   - CI's job-local PostgreSQL (getVerifiedCiDatabaseUrl), or
 *   - a Neon branch created with `npm run db:branch -- create ... --task-ref <n>`,
 *     with LRW_TEST_DATABASE_DISPOSABLE=1, LRW_TEST_DATABASE_URL equal to
 *     NEON_SHARED_DATABASE_URL, and LRW_FORBIDDEN_SHARED_URL set to the real
 *     shared URL (which must differ). Anything else skips or refuses.
 * The worker_charters migration must already be applied to that database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { WORKER_MINIMUM_DENYLIST, buildCompletionEvidence, type WorkerCharterBody } from '../../shared/worker-contracts';

function disposableTarget(): string | undefined {
  const ci = getVerifiedCiDatabaseUrl();
  if (ci) return ci;
  const url = process.env.NEON_SHARED_DATABASE_URL;
  if (!url || process.env.LRW_TEST_DATABASE_DISPOSABLE !== '1') return undefined;
  if (process.env.LRW_TEST_DATABASE_URL !== url || !process.env.LRW_FORBIDDEN_SHARED_URL || process.env.LRW_FORBIDDEN_SHARED_URL === url) {
    throw new Error('Local worker postgres proof refuses an unverified or shared database');
  }
  return url;
}

const W = 'luca-claude-code';
const target = (() => { try { return disposableTarget(); } catch (e) { return e as Error; } })();
const skip = target === undefined ? 'requires a verified disposable PostgreSQL database' : false;

function jobPayload(charterId: string) {
  return {
    schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola', commit: 'a'.repeat(40),
    paths: ['docs/*.md'], question: 'proof?', resultSchemaId: 'answer-with-citations.v1', authProfile: 'subscription', model: 'sonnet',
    limits: { maxRuntimeSec: 600 }, charterId, charterVersion: 1, deadline: new Date(Date.now() + 3600_000).toISOString(),
  };
}

test('disposable target is verified (or the suite is skipped)', () => {
  if (target instanceof Error) throw target;
});

test('charter repository: immutable versions and CAS transitions on the real table', { skip }, async () => {
  const { createPostgresWorkerCharterRepository, createCharterDraft, approveCharter, revokeCharter } = await import('../services/worker-charter-service');
  const repo = createPostgresWorkerCharterRepository();
  assert.equal(await repo.tableExists(), true, 'migration 0065 must be applied to the disposable database');
  const id = randomUUID();
  const body: WorkerCharterBody = {
    schema: 'hh.worker.charter.v1', workerActor: W, host: 'LITTLENEMO', originators: ['luca-replit'], kinds: ['doc_inspect'],
    pathAllowlist: ['docs/**'], pathDenylist: [...WORKER_MINIMUM_DENYLIST], authProfiles: ['subscription'], models: ['sonnet'], qualifiedHarnesses: [],
    limits: { maxJobsPerWindow: 3, maxRuntimeSec: 600, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300 },
    window: { notBefore: new Date(Date.now() - 3600_000).toISOString(), notAfter: new Date(Date.now() + 86_400_000).toISOString() },
  };
  const v1 = await createCharterDraft(repo, { id, body, createdBy: 'proof-founder' });
  const v2 = await createCharterDraft(repo, { id, body: { ...body, models: ['haiku'] }, createdBy: 'proof-founder' });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  await assert.rejects(revokeCharter(repo, id, 1, 'proof-founder'), /WORKER_CHARTER_STATE_CONFLICT/);
  assert.equal((await approveCharter(repo, id, 1, 'proof-founder')).approvalState, 'approved');
  await assert.rejects(approveCharter(repo, id, 1, 'proof-founder'), /WORKER_CHARTER_STATE_CONFLICT/);
  assert.equal((await revokeCharter(repo, id, 1, 'proof-founder')).approvalState, 'revoked');
  assert.equal((await repo.get(id, 2))?.approvalState, 'draft', 'other versions untouched');
});

test('real ledger: claim race, replay, completion evidence, reassignment authority loss, history count', { skip }, async () => {
  const ledger = await import('../services/coordination-ledger-service');
  const { createPostgresWorkerCharterRepository } = await import('../services/worker-charter-service');
  const charterId = randomUUID();
  const created = await ledger.createCoordinationThread({
    actor: 'luca-replit', intendedRecipient: W, title: 'LRW proof job', description: 'disposable proof',
    idempotencyKey: `lrw-proof-create-${charterId}`, payload: jobPayload(charterId),
  });
  const threadId = created.thread.id;
  const seq = created.thread.latestSequence;

  // Two concurrent claims with distinct instance keys at the same observed sequence.
  const k1 = `lrw.${randomUUID()}.${threadId}.accept.${randomUUID()}.${seq}`;
  const k2 = `lrw.${randomUUID()}.${threadId}.accept.${randomUUID()}.${seq}`;
  const results = await Promise.allSettled([k1, k2].map((k) => ledger.appendCoordinationEvent({
    threadId, actor: W, eventType: 'accepted', content: 'claim', idempotencyKey: k, expectedSequence: seq,
    payload: { claimKey: k, charterId, charterVersion: 1 },
  })));
  const winners = results.filter((r) => r.status === 'fulfilled' && !(r.value as { deduplicated?: boolean }).deduplicated);
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one fresh acceptance');
  assert.equal(losers.length, 1);
  assert.match(String((losers[0] as PromiseRejectedResult).reason?.code), /^(sequence_conflict|invalid_transition)$/);
  const winnerKey = results[0].status === 'fulfilled' ? k1 : k2;

  // Replay of the winning key returns the original event (dedupe-before-transition).
  const replay = await ledger.appendCoordinationEvent({ threadId, actor: W, eventType: 'accepted', content: 'claim', idempotencyKey: winnerKey, expectedSequence: seq, payload: { claimKey: winnerKey } });
  assert.equal(replay.deduplicated, true);

  const now = await ledger.getCoordinationThread(threadId, W);
  // Completion without evidence is refused; with §3.5 evidence it would succeed (checked on a second thread below).
  await assert.rejects(ledger.appendCoordinationEvent({
    threadId, actor: W, eventType: 'completed', content: 'done', idempotencyKey: `lrw-proof-bare-${charterId}`, expectedSequence: now.thread.latestSequence, payload: {},
  }), (e: { code?: string }) => e.code === 'completion_evidence_required');

  // Originator reassigns the running job away: the old worker is no longer a participant.
  await ledger.appendCoordinationEvent({ threadId, actor: 'luca-replit', eventType: 'reassigned', content: 'reassign', idempotencyKey: `lrw-proof-reassign-${charterId}`, expectedSequence: now.thread.latestSequence, recipientActor: 'alden' });
  await assert.rejects(ledger.getCoordinationThread(threadId, W), (e: { code?: string }) => e.code === 'not_participant');
  const afterReassign = await ledger.getCoordinationThread(threadId, 'luca-replit');
  assert.equal(afterReassign.thread.intendedRecipient, 'alden');
  assert.equal(afterReassign.thread.currentOwner, null);

  // Server-side discovery/history: creation-time recipient + accepted count survive reassignment.
  const repo = createPostgresWorkerCharterRepository();
  const jobs = await repo.listJobs({ workerActor: W, charterId, charterVersion: 1, afterGlobalSequence: 0, approvedAt: new Date(Date.now() - 3600_000).toISOString(), limit: 10 });
  assert.deepEqual(jobs.map((j) => j.threadId), [threadId]);
  const count = await repo.countAccepted({ workerActor: W, charterId, charterVersion: 1, notBefore: new Date(Date.now() - 3600_000).toISOString(), notAfter: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(count, 1, 'the reassigned-away acceptance still counts');

  // Completion WITH §3.5 evidence succeeds on a fresh owned thread.
  const c2 = await ledger.createCoordinationThread({ actor: 'luca-replit', intendedRecipient: W, title: 'LRW proof job 2', description: 'disposable proof', idempotencyKey: `lrw-proof-create2-${charterId}`, payload: jobPayload(charterId) });
  const kc = `lrw.${randomUUID()}.${c2.thread.id}.accept.${randomUUID()}.${c2.thread.latestSequence}`;
  const acc = await ledger.appendCoordinationEvent({ threadId: c2.thread.id, actor: W, eventType: 'accepted', content: 'claim', idempotencyKey: kc, expectedSequence: c2.thread.latestSequence, payload: { claimKey: kc } });
  const evidence = buildCompletionEvidence('a'.repeat(40), [{ path: 'docs/a.md', startLine: 1, endLine: 2, excerpt: 'x', excerptSha256: 'b'.repeat(64) }]);
  const done = await ledger.appendCoordinationEvent({ threadId: c2.thread.id, actor: W, eventType: 'completed', content: 'done', idempotencyKey: `lrw-proof-done-${charterId}`, expectedSequence: acc.thread.latestSequence, payload: { schema: 'hh.worker.result.v1' }, evidence: evidence as never });
  assert.equal(done.thread.state, 'completed');
});
