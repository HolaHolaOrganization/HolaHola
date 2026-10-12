import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchCrossToolPromote, requireTaskRef } from './cross-tool-promote.ts';
import { InfraMutationBlockedError } from '../server/services/infra-mutation-guard';
import type { TaskOwnershipResult } from '../server/services/task-ownership-service';

function ownershipResult(state: TaskOwnershipResult['state']): TaskOwnershipResult {
  return {
    ok: state !== 'unknown_stop',
    state,
    taskRef: '1470',
    evidence: {
      taskRef: '1470',
      taskArtifact: { path: '/dev/null', exists: false, regularFile: false },
      checkout: { kind: 'primary_worktree', gitMetadataPath: '/dev/null' },
      verifiedActiveMainReceipt: state === 'main_session',
    },
    contradictions: [],
    explanation: `stub:${state}`,
  };
}

test('requireTaskRef throws when --task-ref is missing', () => {
  assert.throws(() => requireTaskRef({}), /Missing --task-ref/);
});

test('requireTaskRef returns the flag value when present', () => {
  assert.equal(requireTaskRef({ 'task-ref': '1470' }), '1470');
});

test('dispatchCrossToolPromote never calls the GitHub API when ownership is unknown_stop', async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when ownership is unknown_stop');
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => dispatchCrossToolPromote('feature-branch', '1470', 'job-1', {
      probeOwnership: async () => ownershipResult('unknown_stop'),
      fetchImpl,
    }),
    (error: unknown) => error instanceof InfraMutationBlockedError
      && error.state === 'unknown_stop'
      && error.action === 'github:cross_tool_promote_push:feature-branch',
  );
  assert.equal(fetchCalls, 0, 'the gate must refuse before any GitHub Actions dispatch is attempted');
});

test('dispatchCrossToolPromote calls the GitHub Actions dispatch endpoint exactly once when ownership is proven', async () => {
  const originalToken = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  process.env.GITHUB_ACTIONS_DISPATCH_TOKEN = 'test-token';
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
  try {
    await dispatchCrossToolPromote('feature-branch', '1470', 'job-1', {
      probeOwnership: async () => ownershipResult('main_session'),
      expectedSha: 'a'.repeat(40),
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/actions\/workflows\/cross-tool-promote\.yml\/dispatches$/);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      ref: 'main',
      inputs: { branch: 'feature-branch', jobId: 'job-1', expectedSha: 'a'.repeat(40) },
    });
  } finally {
    if (originalToken === undefined) delete process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
    else process.env.GITHUB_ACTIONS_DISPATCH_TOKEN = originalToken;
  }
});

// The reference Cloudflare DNS implementation's tests only ever exercise an
// injected probeOwnership stub, never the real default (new
// TaskOwnershipService().probe(taskRef), no overrides) -- a task #1470
// review finding was that this leaves the actual production code path
// unverified. This test omits probeOwnership entirely, so it goes through
// the real default. There is no .local/tasks/task-999999999.md in this
// checkout and no verified receipt/proof callback is wired in, so the
// honest, correct answer is unknown_stop -- proving the real default fails
// closed rather than merely proving an injected stub does.
test('dispatchCrossToolPromote fails closed through the *real* default ownership probe for a task with no local artifact', async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when the real default probe resolves to unknown_stop');
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => dispatchCrossToolPromote('feature-branch', '999999999', 'job-3', { fetchImpl }),
    (error: unknown) => error instanceof InfraMutationBlockedError && error.state === 'unknown_stop',
  );
  assert.equal(fetchCalls, 0);
});

test('dispatchCrossToolPromote proceeds for isolated_agent ownership too', async () => {
  const originalToken = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  process.env.GITHUB_ACTIONS_DISPATCH_TOKEN = 'test-token';
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;
  try {
    await dispatchCrossToolPromote('feature-branch', '1470', 'job-2', {
      probeOwnership: async () => ownershipResult('isolated_agent'),
      expectedSha: 'a'.repeat(40),
      fetchImpl,
    });
    assert.equal(fetchCalls, 1);
  } finally {
    if (originalToken === undefined) delete process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
    else process.env.GITHUB_ACTIONS_DISPATCH_TOKEN = originalToken;
  }
});
