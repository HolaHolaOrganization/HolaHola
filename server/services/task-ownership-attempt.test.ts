import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalWindow, ownershipEndpoint, requestOwnershipAttempt, validateTaskRef } from './task-ownership-attempt';
import { promotionContextDigest, type PromotionCandidate } from './promotion-candidate';

const binding = {
  taskRef: '900003', actor: 'luca-replit', artifactSha256: 'a'.repeat(64),
  publicKey: 'synthetic-public-key', keyFingerprint: 'b'.repeat(64),
};
const expired = '10000000-0000-4000-8000-000000000001';
const endpoint = 'http://127.0.0.1:59999';
const due = new Date(0).toISOString();

test('promotion-v2 submits the exact descriptor with a bounded key and deep-canonical retry', async () => {
  await fixture(async (f, workspace) => {
    const promotion: PromotionCandidate = { purpose: 'cross-tool-promote', repository: 'github:davidwmcintosh/holahola', branch: 'fixture/review', candidateCommit: 'c'.repeat(40) };
    const input = { command: 'begin' as const, workspace, endpoint, binding: { ...binding, promotion }, client: f.client };
    const first = await requestOwnershipAttempt(input);
    const second = await requestOwnershipAttempt({ ...input, binding: { ...binding, promotion: JSON.parse(JSON.stringify(promotion)) } });
    assert.equal(first.challengeId, second.challengeId);
    const directories = await readdir(join(workspace, '.local', 'task-ownership-attempts'));
    const directory = join(workspace, '.local', 'task-ownership-attempts', directories[0]);
    const files = await readdir(directory);
    assert.deepEqual(files, [`begin-promotion-v2-${promotionContextDigest(promotion)}.json`]);
    const attempt = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.deepEqual(attempt.payload.promotionDescriptor, promotion);
    assert.equal(attempt.payload.contextDigest, promotionContextDigest(promotion));
    assert.ok(attempt.payload.idempotencyKey.length <= 128);
  });
});

async function fixture(run: (f: ReturnType<typeof fake>, workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'ownership-attempt-'));
  try { await run(fake(), workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
}
function fake() {
  const statuses = new Map<string, any>([[expired, {
    id: expired, taskRef: binding.taskRef, intendedActor: binding.actor,
    artifactSha256: binding.artifactSha256, keyFingerprint: binding.keyFingerprint,
    status: 'expired', expiresAt: due, receipt: null,
  }]]);
  const requests = new Map<string, { payload: any; response: any }>();
  let failAfterCommit = false;
  let statusPatch: Record<string, unknown> = {};
  let posts = 0;
  const client = {
    async status(id: string) { return { ...statuses.get(id), ...statusPatch }; },
    async challenge(payload: any) {
      posts++;
      let saved = requests.get(payload.idempotencyKey);
      if (saved) assert.deepEqual(payload, saved.payload);
      else {
        const response = { challengeId: randomUUID(), expiresAt: new Date(Date.now() + payload.ttlMs).toISOString() };
        saved = { payload: structuredClone(payload), response };
        requests.set(payload.idempotencyKey, saved);
        statuses.set(response.challengeId, {
          id: response.challengeId, taskRef: payload.taskRef, intendedActor: payload.intendedActor,
          artifactSha256: payload.artifactSha256, keyFingerprint: payload.keyFingerprint,
          status: 'pending', expiresAt: response.expiresAt, receipt: null,
        });
      }
      if (failAfterCommit) { failAfterCommit = false; throw new Error('Connection lost after server commit'); }
      return saved.response;
    },
  };
  return {
    client, statuses, requests,
    failNext: () => { failAfterCommit = true; },
    patch: (patch: Record<string, unknown>) => { statusPatch = patch; },
    posts: () => posts,
  };
}
function renew(f: ReturnType<typeof fake>, workspace: string, extra: Record<string, any> = {}) {
  return requestOwnershipAttempt({ command: 'renew', workspace, endpoint, binding, client: f.client, previousChallengeId: expired, ...extra });
}
async function attemptPath(workspace: string) {
  const directory = join(workspace, '.local/task-ownership-attempts',
    createHash('sha256').update(JSON.stringify([endpoint, binding.actor, binding.taskRef])).digest('hex'));
  return join(directory, `renew-${expired}.json`);
}

test('renew saves the exact identity and defaults to thirty minutes', () => fixture(async (f, workspace) => {
  const result = await renew(f, workspace);
  assert.equal(result.status, 'pending');
  assert.notEqual(result.challengeId, expired);
  const payload = [...f.requests.values()][0].payload;
  assert.equal(payload.ttlMs, 30 * 60_000);
  assert.equal(payload.artifactSha256, binding.artifactSha256);
  assert.equal(payload.keyFingerprint, binding.keyFingerprint);
  assert.equal(payload.publicKey, binding.publicKey);
  assert.equal(payload.intendedActor, binding.actor);
  assert.equal(payload.taskRef, binding.taskRef);
  assert.deepEqual(JSON.parse(await readFile(await attemptPath(workspace), 'utf8')).payload, payload);
  assert.match(result.approvalPath, /System → Ownership/);
}));

test('interrupted reply retries the committed attempt with the identical key', () => fixture(async (f, workspace) => {
  f.failNext();
  await assert.rejects(renew(f, workspace), /Connection lost/);
  const first = [...f.requests.values()][0].response.challengeId;
  assert.equal((await renew(f, workspace)).challengeId, first);
  assert.equal(f.requests.size, 1);
}));

test('concurrent renewals publish one complete attempt and converge on one result', () => fixture(async (f, workspace) => {
  const results = await Promise.all(Array.from({ length: 16 }, () => renew(f, workspace)));
  assert.equal(new Set(results.map(r => r.challengeId)).size, 1);
  assert.equal(f.requests.size, 1);
  const path = await attemptPath(workspace);
  assert.deepEqual(await readdir(join(path, '..')), [`renew-${expired}.json`]);
}));

for (const state of ['pending', 'approved', 'rejected']) {
  test(`renew refuses ${state} predecessors without a POST`, () => fixture(async (f, workspace) => {
    f.statuses.get(expired).status = state;
    await assert.rejects(renew(f, workspace), /Cannot renew/);
    assert.equal(f.posts(), 0);
  }));
}
test('an expired predecessor with any receipt is refused, including expired receipts', () => fixture(async (f, workspace) => {
  f.statuses.get(expired).receipt = { id: 'fixture', status: 'expired' };
  await assert.rejects(renew(f, workspace), /with a receipt/);
  assert.equal(f.posts(), 0);
}));
test('server says expired but expiry is future: fail closed', () => fixture(async (f, workspace) => {
  f.statuses.get(expired).expiresAt = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(renew(f, workspace), /Cannot renew/);
}));
for (const [field, value] of [
  ['taskRef', '900004'], ['intendedActor', 'luca-other'],
  ['artifactSha256', 'c'.repeat(64)], ['keyFingerprint', 'd'.repeat(64)],
  ['id', randomUUID()], ['artifactSha256', undefined],
] as const) {
  test(`remote ${field} mismatch or missing binding blocks renewal`, () => fixture(async (f, workspace) => {
    f.patch({ [field]: value });
    await assert.rejects(renew(f, workspace), /binding/);
    assert.equal(f.posts(), 0);
  }));
}
test('saved attempt approval-window drift cannot produce a second request', () => fixture(async (f, workspace) => {
  await renew(f, workspace);
  await assert.rejects(renew(f, workspace, { ttlMs: 10 * 60_000 }), /Saved attempt differs/);
  assert.equal(f.requests.size, 1);
}));
test('corrupt persisted state never gets replaced', () => fixture(async (f, workspace) => {
  await renew(f, workspace);
  const path = await attemptPath(workspace);
  await writeFile(path, '{partial');
  await assert.rejects(renew(f, workspace), /unreadable/);
  assert.equal(await readFile(path, 'utf8'), '{partial');
}));
test('a leftover partial staging record is ignored, never used as request authority', () => fixture(async (f, workspace) => {
  const path = await attemptPath(workspace);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(path, '..'), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  await writeFile(staging, '{"partial":');
  const result = await renew(f, workspace);
  assert.equal(result.status, 'pending');
  assert.equal(await readFile(staging, 'utf8'), '{"partial":');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
}));
test('an interruption before POST leaves a complete attempt that a new client can retry', () => fixture(async (f, workspace) => {
  let savedKey = '';
  await assert.rejects(renew(f, workspace, { client: {
    status: f.client.status,
    async challenge(payload: any) {
      savedKey = payload.idempotencyKey;
      assert.equal(JSON.parse(await readFile(await attemptPath(workspace), 'utf8')).payload.idempotencyKey, savedKey);
      throw new Error('Interrupted before POST');
    },
  } }), /Interrupted before POST/);
  assert.equal(f.requests.size, 0);
  await renew(f, workspace);
  assert.equal([...f.requests.keys()][0], savedKey);
}));
for (const state of ['expired', 'approved', 'rejected']) {
  test(`replaying a renewal preserves its ${state} result, not a fresh attempt`, () => fixture(async (f, workspace) => {
    const first = await renew(f, workspace);
    Object.assign(f.statuses.get(first.challengeId), { status: state, expiresAt: due });
    const retry = await renew(f, workspace);
    assert.equal(retry.challengeId, first.challengeId);
    assert.equal(retry.status, state);
    assert.equal(f.requests.size, 1);
  }));
}
test('a later explicit renewal names the newer expired challenge', () => fixture(async (f, workspace) => {
  const first = await renew(f, workspace);
  Object.assign(f.statuses.get(first.challengeId), { status: 'expired', expiresAt: due });
  const second = await renew(f, workspace, { previousChallengeId: first.challengeId });
  assert.notEqual(first.challengeId, second.challengeId);
  assert.equal(f.requests.size, 2);
}));
test('begin retains the legacy key and exact ten-minute digest fields', () => fixture(async (f, workspace) => {
  const input = { command: 'begin' as const, workspace, endpoint, binding, client: f.client };
  const first = await requestOwnershipAttempt(input);
  assert.equal((await requestOwnershipAttempt(input)).challengeId, first.challengeId);
  const payload = [...f.requests.values()][0].payload;
  assert.equal(payload.idempotencyKey, `${binding.taskRef}:${binding.keyFingerprint}`);
  assert.equal(payload.ttlMs, 10 * 60_000);
}));
test('a V2 commit-bound begin key fits the server limit, binds the request, and is stable per commit', () => fixture(async (f, workspace) => {
  const promotion = (candidateCommit: string) => ({
    purpose: 'cross-tool-promote' as const, repository: 'github:davidwmcintosh/holahola',
    branch: 'lcc/example', candidateCommit,
  });
  const input = (commit: string) => ({
    command: 'begin' as const, workspace, endpoint, client: f.client,
    binding: { ...binding, taskRef: '1000001', promotion: promotion(commit) },
  });
  const first = await requestOwnershipAttempt(input('c'.repeat(40)));
  assert.equal((await requestOwnershipAttempt(input('c'.repeat(40)))).challengeId, first.challengeId);
  await requestOwnershipAttempt(input('d'.repeat(40)));
  const keys = [...f.requests.values()].map(r => r.payload.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  for (const [index, key] of keys.entries()) {
    assert.ok(key.length <= 128, `${key.length}-character key`);
    assert.match(key, /^promotion-v2:[0-9a-f]{64}$/);
    const commit = (index === 0 ? 'c' : 'd').repeat(40);
    const digest = createHash('sha256')
      .update(JSON.stringify(['1000001', binding.keyFingerprint, promotionContextDigest(promotion(commit))]))
      .digest('hex');
    assert.equal(key, `promotion-v2:${digest}`);
  }
}));
test('begin refuses local key/artifact drift before resubmission', () => fixture(async (f, workspace) => {
  await requestOwnershipAttempt({ command: 'begin', workspace, endpoint, binding, client: f.client });
  await assert.rejects(requestOwnershipAttempt({
    command: 'begin', workspace, endpoint, client: f.client,
    binding: { ...binding, artifactSha256: 'e'.repeat(64) },
  }), /Saved attempt differs/);
  assert.equal(f.posts(), 1);
}));
test('unsafe refs, predecessor IDs, approval windows and URLs fail before POST', () => fixture(async (f, workspace) => {
  for (const taskRef of ['../9', '0', '01', '-2', '9/../../escape']) {
    await assert.rejects(renew(f, workspace, { binding: { ...binding, taskRef } }), /positive decimal/);
  }
  for (const previousChallengeId of ['../escape', '', 'not-an-id']) {
    await assert.rejects(renew(f, workspace, { previousChallengeId }), /valid --challenge-id/);
  }
  for (const value of ['0', '31', '1.5', '-1', 'NaN', '9007199254740992']) assert.throws(() => approvalWindow(value));
  for (const url of ['file:///tmp', 'https://user:pass@host/', 'https://host/?q=x', 'https://host/#x', 'https://host/path']) {
    assert.throws(() => ownershipEndpoint(url));
  }
  assert.equal(ownershipEndpoint('https://EXAMPLE.COM:443/'), 'https://example.com');
  assert.equal(approvalWindow('1'), 60_000);
  assert.throws(() => validateTaskRef(''));
  assert.equal(f.posts(), 0);
}));
