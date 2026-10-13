import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKER_MINIMUM_DENYLIST, charterBodyDigest, type WorkerCharterBody } from '../../../shared/worker-contracts';
import { evaluateJobAuthority, type AuthorityInput } from './authority';

const COMMIT = 'c'.repeat(40);
const CHARTER_ID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-10-08T03:00:00.000Z');

const body: WorkerCharterBody = {
  schema: 'hh.worker.charter.v1', workerActor: 'luca-claude-code', host: 'LITTLENEMO',
  originators: ['luca-replit', 'david'], kinds: ['doc_inspect'], pathAllowlist: ['docs/**'],
  pathDenylist: [...WORKER_MINIMUM_DENYLIST], authProfiles: ['subscription', 'api'], models: ['sonnet', 'haiku'],
  qualifiedHarnesses: [],
  limits: { maxJobsPerWindow: 3, maxRuntimeSec: 900, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300 },
  window: { notBefore: '2026-10-08T00:00:00.000Z', notAfter: '2026-10-09T00:00:00.000Z' },
};

function input(over: Partial<AuthorityInput> = {}, payloadOver: Record<string, unknown> = {}): AuthorityInput {
  return {
    workerActor: 'luca-claude-code', nowMs: NOW,
    thread: { id: 't1', state: 'delivered', originActor: 'luca-replit', intendedRecipient: 'luca-claude-code', currentOwner: null, latestSequence: 2, sourceReference: null },
    created: {
      eventType: 'created', createdAt: '2026-10-08T02:00:00.000Z',
      payload: {
        schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola', commit: COMMIT,
        paths: ['docs/*.md'], question: 'q?', resultSchemaId: 'answer-with-citations.v1', authProfile: 'subscription',
        model: 'sonnet', limits: { maxRuntimeSec: 600 }, charterId: CHARTER_ID, charterVersion: 1,
        deadline: '2026-10-08T08:00:00.000Z', ...payloadOver,
      },
    },
    charter: { id: CHARTER_ID, version: 1, body, bodyDigest: charterBodyDigest(body), approvalState: 'approved', approvedAt: '2026-10-08T01:00:00.000Z' },
    commit: { exists: true, isAncestorOfOriginMain: true, fetchedAtMs: NOW - 60_000 },
    history: { complete: true, acceptedInWindow: 0 },
    tree: [{ mode: '100644', type: 'blob', size: 50, path: 'docs/operations-catalog.md' }],
    harnessQualified: true,
    ...over,
  };
}

const reason = (i: AuthorityInput) => {
  const d = evaluateJobAuthority(i);
  return d.eligible ? 'ELIGIBLE' : d.reason;
};

test('a fully valid job is eligible and returns its staging files', () => {
  const d = evaluateJobAuthority(input());
  assert.equal(d.eligible, true);
  if (d.eligible) assert.deepEqual(d.stagingFiles, [{ path: 'docs/operations-catalog.md', size: 50 }]);
});

test('addressing, state, ownership and agent_note source are enforced', () => {
  assert.equal(reason(input({ thread: { ...input().thread, intendedRecipient: 'alden' } })), 'not_addressed_to_worker');
  assert.equal(reason(input({ thread: { ...input().thread, state: 'accepted' } })), 'thread_state_not_claimable');
  assert.equal(reason(input({ thread: { ...input().thread, currentOwner: 'luca-claude-code' } })), 'thread_already_owned');
  assert.equal(reason(input({ thread: { ...input().thread, sourceReference: { type: 'agent_note' } } })), 'agent_note_source_rejected');
});

test('origin is the server-derived originActor, not a payload claim', () => {
  assert.equal(reason(input({ thread: { ...input().thread, originActor: 'luca-gemini' } }, { createdBy: 'david' })), 'job_schema_invalid:root');
  assert.equal(reason(input({ thread: { ...input().thread, originActor: 'luca-gemini' } })), 'originator_not_allowed');
});

test('non-job threads and malformed jobs are not eligible', () => {
  assert.equal(reason(input({ created: { ...input().created, payload: { schema: 'something.else' } } })), 'not_a_worker_job');
  assert.equal(reason(input({}, { model: undefined })), 'job_schema_invalid:model');
});

test('charter: missing, mismatched, draft, revoked and tampered digest all fail closed', () => {
  assert.equal(reason(input({ charter: null })), 'charter_unavailable');
  assert.equal(reason(input({}, { charterVersion: 2 })), 'charter_mismatch');
  assert.equal(reason(input({ charter: { ...input().charter!, approvalState: 'draft' } })), 'charter_not_approved');
  assert.equal(reason(input({ charter: { ...input().charter!, approvalState: 'revoked' } })), 'charter_revoked');
  assert.equal(reason(input({ charter: { ...input().charter!, bodyDigest: 'f'.repeat(64) } })), 'charter_digest_mismatch');
  const tampered = { ...body, models: ['opus'] };
  assert.equal(reason(input({ charter: { ...input().charter!, body: tampered } })), 'charter_digest_mismatch');
});

test('approval time and window bound both creation and now', () => {
  assert.equal(reason(input({ created: { ...input().created, createdAt: '2026-10-08T00:30:00.000Z' } }, { deadline: '2026-10-08T08:00:00.000Z' })), 'job_predates_charter_approval');
  assert.equal(reason(input({ nowMs: Date.parse('2026-10-09T00:00:00.000Z') })), 'window_closed');
});

test('model selection is explicit: absent, unlisted and listed-but-different are handled (R6)', () => {
  assert.equal(reason(input({}, { model: 'opus' })), 'model_not_allowed');
  assert.equal(reason(input({}, { model: 'haiku' })), 'ELIGIBLE');
});

test('kind, profile, runtime and api budget must fit the charter', () => {
  assert.equal(reason(input({}, { kind: 'code_analysis' })), 'kind_not_allowed');
  assert.equal(reason(input({}, { limits: { maxRuntimeSec: 1200 } })), 'runtime_exceeds_charter');
  assert.equal(reason(input({}, { authProfile: 'api', limits: { maxRuntimeSec: 600, maxApiBudgetUsd: 5 } })), 'api_budget_exceeds_charter');
});

test('deadline, commit ancestry and fetch freshness are enforced', () => {
  assert.equal(reason(input({ nowMs: Date.parse('2026-10-08T08:00:00.000Z') })), 'deadline_passed');
  assert.equal(reason(input({ commit: { exists: false, isAncestorOfOriginMain: false, fetchedAtMs: NOW } })), 'commit_missing');
  assert.equal(reason(input({ commit: { exists: true, isAncestorOfOriginMain: false, fetchedAtMs: NOW } })), 'commit_not_on_origin_main');
  assert.equal(reason(input({ commit: { exists: true, isAncestorOfOriginMain: true, fetchedAtMs: NOW - 301_000 } })), 'origin_fetch_stale');
  assert.equal(reason(input({ commit: { exists: true, isAncestorOfOriginMain: true, fetchedAtMs: null } })), 'origin_fetch_stale');
});

test('window limit uses complete history; unknown never counts as zero (R3)', () => {
  assert.equal(reason(input({ history: { complete: false, acceptedInWindow: 0 } })), 'history_incomplete');
  assert.equal(reason(input({ history: { complete: true, acceptedInWindow: null } })), 'history_incomplete');
  assert.equal(reason(input({ history: { complete: true, acceptedInWindow: 3 } })), 'limit_reached');
});

test('unqualified harness refuses before staging (R4)', () => {
  assert.equal(reason(input({ harnessQualified: false })), 'unqualified_harness');
});

test('path problems surface as staging reasons', () => {
  assert.equal(reason(input({ tree: null })), 'tree_unavailable');
  assert.equal(reason(input({ tree: [{ mode: '100644', type: 'blob', size: 5, path: 'docs/.env.md' }] }, { paths: ['docs/*'] })), 'path_denylisted');
});
