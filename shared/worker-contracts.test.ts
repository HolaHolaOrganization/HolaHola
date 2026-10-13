import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKER_MINIMUM_DENYLIST, answerWithCitationsSchema, assertSendablePayload, buildCompletionEvidence,
  canonicalJson, charterBodyDigest, claimKeyFor, normalizeWorkerQuestion, parseWorkerJob,
  validateCreatePayload, validateWorkerCharterBody, workerFailureSchema, workerResultSchema, writeKeyFor,
  type WorkerCharterBody,
} from './worker-contracts';

const COMMIT = 'a'.repeat(40);
const CHARTER_ID = '11111111-2222-4333-8444-555555555555';
const CREATED = '2026-10-08T00:00:00.000Z';

function job(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola',
    commit: COMMIT, paths: ['docs/*.md'], question: 'What is the canonical executor?',
    resultSchemaId: 'answer-with-citations.v1', authProfile: 'subscription', model: 'sonnet',
    limits: { maxRuntimeSec: 600 }, charterId: CHARTER_ID, charterVersion: 1,
    deadline: '2026-10-08T06:00:00.000Z', ...overrides,
  };
}

function charter(overrides: Partial<WorkerCharterBody> = {}): WorkerCharterBody {
  return {
    schema: 'hh.worker.charter.v1', workerActor: 'luca-claude-code', host: 'LITTLENEMO',
    originators: ['luca-replit', 'david'], kinds: ['doc_inspect', 'code_analysis'],
    pathAllowlist: ['docs/**'], pathDenylist: [...WORKER_MINIMUM_DENYLIST],
    authProfiles: ['subscription', 'api'], models: ['sonnet'], qualifiedHarnesses: [],
    limits: { maxJobsPerWindow: 3, maxRuntimeSec: 900, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300 },
    window: { notBefore: '2026-10-08T00:00:00.000Z', notAfter: '2026-10-09T00:00:00.000Z' },
    ...overrides,
  };
}

test('valid job parses and the question is NFC-normalised', () => {
  const r = parseWorkerJob(job({ question: 'Cafe\u0301?' }), CREATED);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.question, 'Caf\u00e9?');
});

test('job: unknown field, missing model, bad commit and api without budget are rejected', () => {
  assert.equal(parseWorkerJob({ ...job(), extra: 1 }, CREATED).ok, false);
  const { model: _m, ...noModel } = job();
  assert.equal(parseWorkerJob(noModel, CREATED).ok, false);
  assert.equal(parseWorkerJob(job({ commit: 'abc' }), CREATED).ok, false);
  const api = parseWorkerJob(job({ authProfile: 'api' }), CREATED);
  assert.deepEqual(api, { ok: false, reason: 'job_api_budget_required' });
});

test('job: path traversal, absolute, drive, ADS and >2 globstars are rejected', () => {
  for (const p of ['../x', '/etc/x', 'C:/x', 'a:b', 'docs\\x', 'a/**/b/**/c/**/d', './x']) {
    assert.equal(parseWorkerJob(job({ paths: [p] }), CREATED).ok, false, p);
  }
});

test('job: deadline must be after creation and within 24h', () => {
  assert.equal(parseWorkerJob(job({ deadline: '2026-10-07T23:00:00.000Z' }), CREATED).ok, false);
  assert.equal(parseWorkerJob(job({ deadline: '2026-10-09T00:00:01.000Z' }), CREATED).ok, false);
});

test('question: control characters, lone surrogates, empty and oversize are rejected', () => {
  assert.equal(normalizeWorkerQuestion('a\u0007b').ok, false);
  assert.equal(normalizeWorkerQuestion('a\u0085b').ok, false);
  assert.equal(normalizeWorkerQuestion('a\uD800b').ok, false);
  assert.equal(normalizeWorkerQuestion('   ').ok, false);
  assert.equal(normalizeWorkerQuestion('x'.repeat(4001)).ok, false);
  assert.equal(normalizeWorkerQuestion('line1\n\tline2').ok, true);
});

test('charter: valid body passes; missing minimum denylist is rejected', () => {
  assert.equal(validateWorkerCharterBody(charter()).ok, true);
  const r = validateWorkerCharterBody(charter({ pathDenylist: ['.env*'] }));
  assert.deepEqual(r, { ok: false, reason: 'charter_minimum_denylist_missing' });
});

test('charter: poll interval, window bounds, empty models and duplicates are enforced', () => {
  assert.equal(validateWorkerCharterBody(charter({ limits: { ...charter().limits, pollIntervalSec: 60 } })).ok, false);
  assert.equal(validateWorkerCharterBody(charter({ window: { notBefore: '2026-10-08T00:00:00.000Z', notAfter: '2026-12-08T00:00:00.000Z' } })).ok, false);
  assert.equal(validateWorkerCharterBody(charter({ window: { notBefore: '2026-10-09T00:00:00.000Z', notAfter: '2026-10-08T00:00:00.000Z' } })).ok, false);
  assert.equal(validateWorkerCharterBody(charter({ models: [] })).ok, false);
  assert.equal(validateWorkerCharterBody(charter({ originators: ['david', 'david'] })).ok, false);
});

test('charter digest covers the whole body and is key-order independent', () => {
  const a = charter();
  // Reverse key order at every level (a top-level replacer array would drop nested keys).
  const reorder = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)]))
    : Array.isArray(v) ? v.map(reorder) : v;
  const b = reorder(a) as WorkerCharterBody;
  assert.equal(charterBodyDigest(a), charterBodyDigest(b));
  assert.notEqual(charterBodyDigest(a), charterBodyDigest(charter({ models: ['opus'] })));
});

test('canonical JSON sorts keys recursively and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  assert.throws(() => canonicalJson({ x: Number.NaN }));
});

test('completion evidence maps citations to immutable git repository_path references (R1)', () => {
  const ev = buildCompletionEvidence(COMMIT, [{ path: 'docs/a.md', startLine: 3, endLine: 5, excerptSha256: 'b'.repeat(64), excerpt: 'x' }]);
  assert.deepEqual(ev[0], { type: 'commit', provider: 'git', identifier: COMMIT });
  assert.equal(ev[1].identifier, `davidwmcintosh/HolaHola@${COMMIT}:docs/a.md#L3-L5`);
  assert.equal(ev[1].digest, `sha256:${'b'.repeat(64)}`);
  assert.match(ev[1].digest!, /^[A-Za-z0-9:+/=_-]{16,255}$/); // ledger digest rule
  assert.throws(() => buildCompletionEvidence('nothex', []));
});

test('idempotency keys satisfy the ledger rule and distinguish claim attempts (§5.3)', () => {
  const ledgerRule = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/;
  const inst = '22222222-2222-4222-8222-222222222222';
  const thread = '33333333-3333-4333-8333-333333333333';
  const nonce = '44444444-4444-4444-8444-444444444444';
  const k1 = claimKeyFor(inst, thread, nonce, 2);
  const k2 = claimKeyFor(inst, thread, nonce, 5); // reassigned back: new observed sequence
  assert.match(k1, ledgerRule);
  assert.notEqual(k1, k2);
  const w = writeKeyFor(inst, thread, 'completed', k1);
  assert.match(w, ledgerRule);
  assert.notEqual(w, writeKeyFor(inst, thread, 'completed', k2));
});

test('answer schema enforces structure and citation ranges', () => {
  assert.equal(answerWithCitationsSchema.safeParse({ summary: 's', findings: [], citations: [{ path: 'a', startLine: 2, endLine: 1 }] }).success, false);
  assert.equal(answerWithCitationsSchema.safeParse({ summary: 's', findings: [], citations: [], extra: 1 }).success, false);
  assert.equal(answerWithCitationsSchema.safeParse({ summary: 's', findings: [{ statement: 'x' }], citations: [{ path: 'a', startLine: 1, endLine: 1 }] }).success, true);
});

test('result and failure payload schemas are strict; failure evidence has no free-text output', () => {
  const base = { schema: 'hh.worker.failure.v1', jobThreadId: 't', instanceId: CHARTER_ID, runNonce: CHARTER_ID,
    claimKey: 'lrw.claimkey', stage: 'run', failureClass: 'timeout', detail: 'x', evidence: { timings: { runMs: 1 } } };
  assert.equal(workerFailureSchema.safeParse(base).success, true);
  assert.equal(workerFailureSchema.safeParse({ ...base, evidence: { ...base.evidence, stderr: 'leak' } }).success, false);
  assert.equal(workerFailureSchema.safeParse({ ...base, failureClass: 'made_up' }).success, false);
  assert.equal(workerResultSchema.safeParse({}).success, false);
});

test('thread-create payload gate accepts only a strictly valid worker job (§4.3)', () => {
  assert.equal(validateCreatePayload(job(), CREATED).ok, true);
  assert.deepEqual(validateCreatePayload({ payloadKind: 'observation_source' }, CREATED), { ok: false, reason: 'payload_schema_not_supported' });
  assert.deepEqual(validateCreatePayload([1], CREATED), { ok: false, reason: 'payload_not_object' });
  assert.equal(validateCreatePayload({ ...job(), extra: true }, CREATED).ok, false);
});

test('sendable payload check rejects oversize and secret-looking content', () => {
  assert.equal(assertSendablePayload({ a: 'fine' }).ok, true);
  assert.deepEqual(assertSendablePayload({ a: 'x'.repeat(70_000) }), { ok: false, reason: 'payload_too_large' });
  assert.deepEqual(assertSendablePayload({ a: 'token sk-abcdefghijklmnopqrstuv' }), { ok: false, reason: 'payload_secret_pattern' });
});
