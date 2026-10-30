import assert from 'node:assert/strict';
import test from 'node:test';

import { createBranch, deleteBranch, deleteBranchByNameOrId, listBranches, requireTaskRef } from './neon-branch.ts';
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

test('branch listing refuses a pagination cursor before inferring absence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    branches: [], pagination: { next: 'synthetic-next-page' },
  }), { status: 200 });
  try {
    await withEnv({ NEON_API_KEY: 'synthetic', NEON_PROJECT_ID: 'synthetic' }, async () => {
      await assert.rejects(listBranches(), /Incomplete Neon branch listing/);
    });
  } finally { globalThis.fetch = originalFetch; }
});
test('creation records branch identity before a failing readiness poll', async () => {
  const originalFetch = globalThis.fetch;
  let captured = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({
      branch: { id: 'br-synthetic', name: 'synthetic', parent_id: 'br-parent', default: false, protected: false },
    }), { status: 200 });
    if (String(url).endsWith('/branches')) return new Response(JSON.stringify({
      branches: [{ id: 'br-parent', name: 'production', default: true }],
    }), { status: 200 });
    assert.equal(captured, true, 'readiness must not precede durable bookkeeping');
    throw new Error('synthetic readiness failure');
  };
  try {
    await withEnv({ NEON_API_KEY: 'synthetic', NEON_PROJECT_ID: 'synthetic' }, async () => {
      await assert.rejects(createBranch({
        name: 'synthetic', parent: 'production', schemaOnly: true, taskRef: '1470',
        probeOwnership: async () => ownershipResult('main_session'),
        onCreated: async branch => { assert.equal(branch.id, 'br-synthetic'); captured = true; },
      }), /synthetic readiness failure/);
      assert.equal(captured, true);
    });
  } finally { globalThis.fetch = originalFetch; }
});

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(originals)) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('requireTaskRef throws when --task-ref is missing', () => {
  assert.throws(() => requireTaskRef({}), /Missing --task-ref/);
});

test('requireTaskRef returns the flag value when present', () => {
  assert.equal(requireTaskRef({ 'task-ref': '1470' }), '1470');
});

test('createBranch never calls the Neon API when ownership is unknown_stop', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when ownership is unknown_stop');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => createBranch({
        name: 'test-branch',
        parent: 'production',
        schemaOnly: false,
        taskRef: '1470',
        probeOwnership: async () => ownershipResult('unknown_stop'),
      }),
      (error: unknown) => error instanceof InfraMutationBlockedError
        && error.state === 'unknown_stop'
        && error.action === 'neon:create_branch:test-branch',
    );
    assert.equal(fetchCalls, 0, 'the gate must refuse before any Neon API call is attempted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createBranch attempts a real Neon API call once ownership is proven', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('STOP-AFTER-GATE');
  }) as typeof fetch;
  try {
    await withEnv({ NEON_PROJECT_ID: 'test-project', NEON_API_KEY: 'test-key' }, () => assert.rejects(
      () => createBranch({
        name: 'test-branch',
        parent: 'production',
        schemaOnly: false,
        taskRef: '1470',
        probeOwnership: async () => ownershipResult('main_session'),
      }),
      /STOP-AFTER-GATE/,
    ));
    assert.ok(fetchCalls > 0, 'the gate must allow a real Neon API call to be attempted once ownership is proven');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteBranch never calls the Neon API when ownership is unknown_stop', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when ownership is unknown_stop');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => deleteBranch('branch-123', false, '1470', async () => ownershipResult('unknown_stop')),
      (error: unknown) => error instanceof InfraMutationBlockedError
        && error.state === 'unknown_stop'
        && error.action === 'neon:delete_branch:branch-123',
    );
    assert.equal(fetchCalls, 0, 'the gate must refuse before any Neon API call is attempted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteBranch calls the Neon API exactly once when ownership is proven', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    await withEnv({ NEON_PROJECT_ID: 'test-project', NEON_API_KEY: 'test-key' }, () =>
      deleteBranch('branch-123', false, '1470', async () => ownershipResult('main_session')));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/projects\/test-project\/branches\/branch-123$/);
    assert.equal(calls[0].method, 'DELETE');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteBranch proceeds for isolated_agent ownership too', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    await withEnv({ NEON_PROJECT_ID: 'test-project', NEON_API_KEY: 'test-key' }, () =>
      deleteBranch('branch-123', false, '1470', async () => ownershipResult('isolated_agent')));
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Regression coverage for a task #1470 review finding: cmdDelete used to
// resolve a branch name to an ID (a Neon list/GET call) *before* calling
// deleteBranch, so the ownership gate inside deleteBranch never protected
// that lookup. deleteBranchByNameOrId is the fix -- it must refuse before
// even the resolve GET, not just before the final DELETE.
test('deleteBranchByNameOrId never calls the Neon API -- not even to resolve the name -- when ownership is unknown_stop', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when ownership is unknown_stop');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => deleteBranchByNameOrId('my-branch', false, '1470', async () => ownershipResult('unknown_stop')),
      (error: unknown) => error instanceof InfraMutationBlockedError
        && error.state === 'unknown_stop'
        && error.action === 'neon:delete_branch:my-branch',
    );
    assert.equal(fetchCalls, 0, 'the gate must refuse before even resolving the branch name to an id');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteBranchByNameOrId resolves the name and deletes it once ownership is proven', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    if (!init?.method) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          branches: [{ id: 'branch-123', name: 'my-branch', default: false, protected: false, current_state: 'ready' }],
        }),
        text: async () => '',
      } as Response;
    }
    return {
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
      text: async () => '',
    } as Response;
  }) as typeof fetch;
  try {
    const branch = await withEnv({ NEON_PROJECT_ID: 'test-project', NEON_API_KEY: 'test-key' }, () =>
      deleteBranchByNameOrId('my-branch', false, '1470', async () => ownershipResult('main_session')));
    assert.equal(branch.id, 'branch-123');
    assert.equal(calls.length, 2, 'expected exactly one resolve GET and one DELETE');
    assert.equal(calls[0].method, undefined, 'the first call must be the unauthenticated-method (GET) resolve lookup');
    assert.match(calls[0].url, /\/projects\/test-project\/branches$/);
    assert.equal(calls[1].method, 'DELETE');
    assert.match(calls[1].url, /\/projects\/test-project\/branches\/branch-123$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteBranchByNameOrId still refuses to delete the default branch, after ownership is proven', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      branches: [{ id: 'branch-main', name: 'production', default: true, protected: false, current_state: 'ready' }],
    }),
    text: async () => '',
  })) as typeof fetch;
  try {
    await withEnv({ NEON_PROJECT_ID: 'test-project', NEON_API_KEY: 'test-key' }, () => assert.rejects(
      () => deleteBranchByNameOrId('production', false, '1470', async () => ownershipResult('main_session')),
      /it is the project's default branch/,
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The reference Cloudflare DNS implementation's tests only ever exercise an
// injected probeOwnership stub, never the real default (new
// TaskOwnershipService().probe(taskRef), no overrides) -- a task #1470
// review finding was that this leaves the actual production code path
// unverified. This is the one test in this file that omits probeOwnership
// entirely, so it goes through the real default. In this checkout there is
// no .local/tasks/task-1470.md-shaped artifact matching a literal
// nonexistent task ref, and no verified receipt/proof callback is wired in,
// so the honest, correct answer is unknown_stop -- proving the real default
// fails closed rather than merely proving an injected stub does.
test('deleteBranch fails closed through the *real* default ownership probe for a task with no local artifact', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('fetch must not be called when the real default probe resolves to unknown_stop');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => deleteBranch('branch-123', false, '999999999'),
      (error: unknown) => error instanceof InfraMutationBlockedError && error.state === 'unknown_stop',
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
