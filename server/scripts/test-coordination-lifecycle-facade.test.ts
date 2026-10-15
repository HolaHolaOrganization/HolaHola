import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoordinationTaskMetadataError,
  resolveCoordinationTaskMetadata,
  FixedRootCoordinationTaskMetadataRegistry,
} from '../services/coordination-task-metadata-service';
import {
  launchOrResumeCoordinationLifecycle,
  reserveCoordinationLifecyclePreparation,
  CoordinationLifecycleFacadeError,
  applyCoordinationProviderFailure,
} from '../services/coordination-lifecycle-facade-service';
import { mapProviderFailure } from '../services/coordination-provider-failure';
import { normalizeCoordinationRepositoryIdentity } from '../services/coordination-repository-identity';

const metadata = {
  taskRef: '9001',
  taskArtifactSha256: 'a'.repeat(64),
  repositoryIdentity: 'github:repo/example',
  startingCommit: 'b'.repeat(40),
};

test('repository identity canonicalizer accepts only equivalent GitHub remotes', () => {
  for (const value of [
    'github:owner/repo', 'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo',
    'github:Owner/Repo', 'https://github.com/Owner/Repo.GIT',
    'git@github.com:OWNER/repo.git', 'ssh://git@github.com/Owner/Repo.git',
  ]) assert.equal(normalizeCoordinationRepositoryIdentity(value), 'github:owner/repo');
  for (const value of [
    'https://evil.example/owner/repo', 'https://git@github.com/owner/repo',
    'ssh://root@github.com/owner/repo', 'https://github.com/owner/../repo',
    'https://github.com/owner/repo?x=1', '/tmp/repo',
  ]) assert.throws(() => normalizeCoordinationRepositoryIdentity(value));
});
const policy = {
  providerOrder: ['fake'],
  totalAttemptBudget: 3,
  providerAttemptBudgets: { fake: 3 },
};
const descriptor = { provider: 'fake', model: 'fake-model', adapterVersion: '1',
  supportedOperations: ['generate'], limits: {
    maxRequestBytes: 1, maxResponseBytes: 1, maxIntents: 1,
    maxArgumentBytes: 1, maxInputTokens: 1, maxOutputTokens: 1,
  } };
const nextDescriptor = { ...descriptor, provider: 'next', model: 'next-model' };
const registry = {
  descriptorsForProvider: () => [descriptor],
  resolve: () => descriptor,
} as any;

test('task metadata resolver is generic and rejects unsupported tasks', async () => {
  const registryImpl = {
    resolve: (taskRef: string) => taskRef === '9001' ? metadata : undefined,
  };
  assert.deepEqual(await resolveCoordinationTaskMetadata('9001', { registry: registryImpl }), metadata);
  await assert.rejects(
    () => resolveCoordinationTaskMetadata('9002', { registry: registryImpl }),
    (error: unknown) => error instanceof CoordinationTaskMetadataError && error.code === 'TASK_METADATA_UNSUPPORTED',
  );
});

test('fixed-root production registry hashes only the numeric task file and requires clean provenance', async () => {
  const files = new Map<string, Uint8Array>([['/srv/coordinator/.local/tasks/task-9001.md', new TextEncoder().encode('approved task')]]);
  const readers = {
    lstat: async (path: string) => ({
      isFile: () => files.has(path),
      isSymbolicLink: () => false,
    }),
    readFile: async (path: string) => files.get(path) ?? new Uint8Array(),
    git: async () => ({ repositoryIdentity: 'https://github.com/example/repo.git',
      startingCommit: 'b'.repeat(40), clean: true }),
  };
  const registry = new FixedRootCoordinationTaskMetadataRegistry('/srv/coordinator', readers);
  const resolved = await registry.resolve('9001');
  assert.equal(resolved?.taskRef, '9001');
  assert.equal(resolved?.taskArtifactSha256.length, 64);
  await assert.rejects(() => registry.resolve('../9001'), /TASK_METADATA_INVALID_REQUEST/);
  await assert.rejects(() => registry.resolve('9002'), /TASK_METADATA_UNSUPPORTED/);
  const dirty = new FixedRootCoordinationTaskMetadataRegistry('/srv/coordinator', {
    ...readers, git: async () => ({ ...await readers.git(), clean: false }),
  });
  await assert.rejects(() => dirty.resolve('9001'), /TASK_METADATA_UNSUPPORTED/);
  const symlink = new FixedRootCoordinationTaskMetadataRegistry('/srv/coordinator', {
    ...readers, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
  });
  await assert.rejects(() => symlink.resolve('9001'), /TASK_METADATA_UNSUPPORTED/);
  const unapproved = new FixedRootCoordinationTaskMetadataRegistry('/srv/coordinator', {
    ...readers, git: async () => ({ ...await readers.git(), repositoryIdentity: '/tmp/not-a-remote' }),
  });
  await assert.rejects(() => unapproved.resolve('9001'), /TASK_METADATA_UNSUPPORTED/);
});

test('facade closes operator input and returns cleanup-safe status only', async () => {
  await assert.rejects(
    () => launchOrResumeCoordinationLifecycle(
      { taskRef: '9001', taskArtifactSha256: metadata.taskArtifactSha256 } as any,
      { actorId: 'operator', requestKey: 'request-1' },
      {},
    ),
    (error: unknown) => error instanceof CoordinationLifecycleFacadeError && error.code === 'LIFECYCLE_INVALID_REQUEST',
  );
  const session = (state: string) => ({
    id: 'internal-session', state, created: true,
  }) as any;
  const attempts: Array<Record<string, unknown>> = [];
  const leases: Array<Record<string, unknown>> = [];
  const services = {
    createOrResumeSession: async () => session('preparing'),
    transitionCoordinationSession: async () => session('ready'),
    createFreshAttempt: async (value: Record<string, unknown>) => {
      attempts.push(value);
      return { id: 'internal-attempt', created: true };
    },
    acquireCoordinationTransportLease: async (value: Record<string, unknown>) => {
      leases.push(value);
      return { id: 'internal-lease' };
    },
  } as any;
  const result = await launchOrResumeCoordinationLifecycle(
    { taskRef: '9001' },
    { actorId: 'operator', requestKey: 'request-1' },
    {
      resolveTaskMetadata: async () => metadata,
      resolvePolicy: async () => ({ policyVersionId: 'internal-policy', operatorGrantId: 'internal-grant', policy }),
      resolveHost: async () => ({ enrolledHostId: 'internal-host' }),
      providerRegistry: registry,
      preparationAcknowledged: async () => true,
      readDurableSessionState: async () => 'running',
      services,
    },
  );
  assert.deepEqual(result, { state: 'running', cleanupPending: false });
  const replay = await launchOrResumeCoordinationLifecycle(
    { taskRef: '9001' },
    { actorId: 'operator', requestKey: 'request-1' },
    {
      resolveTaskMetadata: async () => metadata,
      resolvePolicy: async () => ({ policyVersionId: 'internal-policy', operatorGrantId: 'internal-grant', policy }),
      resolveHost: async () => ({ enrolledHostId: 'internal-host' }),
      providerRegistry: registry,
      preparationAcknowledged: async () => true,
      readDurableSessionState: async () => 'running',
      services,
    },
  );
  assert.deepEqual(replay, result);
  assert.equal(attempts[0].attemptGeneration, attempts[1].attemptGeneration);
  assert.equal(leases[0].holderInstanceId, leases[1].holderInstanceId);
  assert.equal(Object.keys(result).some((key) => /id|digest|receipt|lease/i.test(key)), false);
});

test('reserveCoordinationLifecyclePreparation honors an explicit taskMetadataRegistry override instead of silently using the default', async () => {
  await assert.rejects(
    () => reserveCoordinationLifecyclePreparation(
      { taskRef: '9001' },
      { actorId: 'operator', requestKey: 'request-registry-override' },
      {
        taskMetadataRegistry: { resolve: async () => { throw new Error('registry-override-invoked'); } },
        resolvePolicy: async () => ({ policyIdentityId: 'i', policyVersionId: 'p', operatorGrantId: 'g', policy }),
        resolveHost: async () => ({ enrolledHostId: 'h' }),
      },
    ),
    /registry-override-invoked/,
  );
});

test('unacknowledged preparation remains preparing without lifecycle mutation', async () => {
  let transitions = 0;
  let attempts = 0;
  let leases = 0;
  const services = {
    createOrResumeSession: async () => ({ id: 's', state: 'preparing' }) as any,
    transitionCoordinationSession: async () => { transitions += 1; return { id: 's', state: 'ready' } as any; },
    createFreshAttempt: async () => { attempts += 1; return {}; },
    acquireCoordinationTransportLease: async () => { leases += 1; return {}; },
  } as any;
  const deps = {
    resolveTaskMetadata: async () => metadata,
    resolvePolicy: async () => ({ policyVersionId: 'p', operatorGrantId: 'g', policy }),
    resolveHost: async () => ({ enrolledHostId: 'h' }),
    preparationAcknowledged: async () => false,
    services,
  };
  const result = await launchOrResumeCoordinationLifecycle(
    { taskRef: '9001' }, { actorId: 'operator', requestKey: 'request-prep' }, deps,
  );
  assert.deepEqual(result, { state: 'preparing', cleanupPending: false });
  assert.deepEqual([transitions, attempts, leases], [0, 0, 0]);
});

test('provider mapping separates transport, logical retry, fallback, and terminal outcomes', () => {
  const transport = mapProviderFailure({ provider: 'fake', model: 'm', adapterVersion: '1',
    failure: { kind: 'transport_interrupted' } });
  const logical = mapProviderFailure({ provider: 'fake', model: 'm', adapterVersion: '1',
    failure: { kind: 'provider_outage' } });
  const terminal = mapProviderFailure({ provider: 'fake', model: 'm', adapterVersion: '1',
    failure: { kind: 'safety_blocked' } }, policy);
  const fallback = mapProviderFailure({ provider: 'fake', model: 'm', adapterVersion: '1',
    failure: { kind: 'safety_blocked' } }, { ...policy, fallbackEligibleFailureClasses: ['safety_blocked'] });
  assert.equal(transport.classification, 'resume_transport');
  assert.equal(logical.classification, 'fresh_attempt_same_provider');
  assert.equal(terminal.classification, 'terminal_failure');
  assert.equal(fallback.classification, 'fresh_attempt_next_provider');
});

test('provider transport recovery reuses the same attempt', async () => {
  let resumed = 0;
  await applyCoordinationProviderFailure(
    { failure: { kind: 'transport_interrupted' }, sessionId: 's', attemptId: 'a',
      actorId: 'operator', requestKey: 'request-2' },
    { resolveProviderFailureAuthority: async () => ({
      sessionId: 's', attemptId: 'a', policy, currentProvider: descriptor,
    }), services: { resumeSameCoordinationAttempt: async () => { resumed += 1; } } as any },
  );
  assert.equal(resumed, 1);
});

test('provider failure rejects caller-supplied authority and mismatched attempts before mutation', async () => {
  let mutated = false;
  const services = {
    transitionCoordinationAttempt: async () => { mutated = true; },
    transitionCoordinationSession: async () => { mutated = true; },
  } as any;
  await assert.rejects(
    () => applyCoordinationProviderFailure({
      failure: { kind: 'provider_outage' }, sessionId: 's', attemptId: 'a',
      actorId: 'operator', requestKey: 'request-authority',
      policy, provider: 'fake', nextProvider: nextDescriptor,
    } as any, {
      resolveProviderFailureAuthority: async () => {
        throw new CoordinationLifecycleFacadeError('LIFECYCLE_TRANSITION_REJECTED');
      },
      services,
    }),
    (error: unknown) => error instanceof CoordinationLifecycleFacadeError
      && error.code === 'LIFECYCLE_INVALID_REQUEST',
  );
  await assert.rejects(
    () => applyCoordinationProviderFailure({
      failure: { kind: 'provider_outage' }, sessionId: 'session-a', attemptId: 'attempt-from-other-session',
      actorId: 'operator', requestKey: 'request-mismatch',
    }, {
      resolveProviderFailureAuthority: async (sessionId, attemptId) => {
        assert.equal(sessionId, 'session-a');
        assert.equal(attemptId, 'attempt-from-other-session');
        throw new CoordinationLifecycleFacadeError('LIFECYCLE_TRANSITION_REJECTED');
      },
      services,
    }),
    (error: unknown) => error instanceof CoordinationLifecycleFacadeError
      && error.code === 'LIFECYCLE_TRANSITION_REJECTED',
  );
  assert.equal(mutated, false);
});

test('logical retry creates a fresh attempt and terminal failure does not fallback', async () => {
  const calls: string[] = [];
  let retryInput: {
    attemptGeneration?: string; previousAttemptId?: string;
    provider?: string; model?: string; adapterVersion?: string;
  } | undefined;
  const services = {
    transitionCoordinationAttempt: async () => { calls.push('fail'); },
    createFreshAttempt: async (input: {
      classification?: string; attemptGeneration?: string; previousAttemptId?: string;
      provider?: string; model?: string; adapterVersion?: string;
    }) => {
      retryInput = input;
      calls.push(`attempt:${input.classification}`);
    },
    transitionCoordinationSession: async () => { calls.push('terminal'); },
  } as any;
  const authority = {
    sessionId: 's', attemptId: 'a', policy, currentProvider: descriptor,
  };
  await applyCoordinationProviderFailure(
    { failure: { kind: 'provider_outage' }, sessionId: 's', attemptId: 'a',
      actorId: 'operator', requestKey: 'request-3' },
    { resolveProviderFailureAuthority: async () => authority, services },
  );
  assert.deepEqual(calls, ['fail', 'attempt:fresh_attempt_same_provider']);
  assert.match(retryInput?.attemptGeneration ?? '', /^[0-9a-f]{64}$/);
  assert.equal(retryInput?.previousAttemptId, 'a');
  assert.deepEqual(
    { provider: retryInput?.provider, model: retryInput?.model, adapterVersion: retryInput?.adapterVersion },
    { provider: 'fake', model: 'fake-model', adapterVersion: '1' },
  );
  calls.length = 0;
  await applyCoordinationProviderFailure(
    { failure: { kind: 'safety_blocked' }, sessionId: 's', attemptId: 'a',
      actorId: 'operator', requestKey: 'request-3-terminal' },
    { resolveProviderFailureAuthority: async () => authority, services },
  );
  assert.deepEqual(calls, ['fail', 'terminal']);
});

test('policy-approved fallback creates the next provider with provenance', async () => {
  const calls: string[] = [];
  const services = {
    transitionCoordinationAttempt: async () => { calls.push('fail'); },
    createFreshAttempt: async (input: { classification?: string; provider?: string }) => {
      calls.push(`${input.classification}:${input.provider}`);
    },
  } as any;
  await applyCoordinationProviderFailure(
    { failure: { kind: 'malformed_response' }, sessionId: 's', attemptId: 'a',
      actorId: 'operator', requestKey: 'request-4' },
    { resolveProviderFailureAuthority: async () => ({
      sessionId: 's', attemptId: 'a',
      policy: { ...policy, providerOrder: ['fake', 'next'],
        fallbackEligibleFailureClasses: ['malformed_response'] },
      currentProvider: descriptor, nextProvider: nextDescriptor,
    }), services },
  );
  assert.deepEqual(calls, ['fail', 'fresh_attempt_next_provider:next']);
});

test('succeeded status remains cleanup-pending until every obligation is acknowledged', async () => {
  const succeeded = { id: 'internal-session', state: 'succeeded', created: false } as any;
  const result = await launchOrResumeCoordinationLifecycle(
    { taskRef: '9001' }, { actorId: 'operator', requestKey: 'request-5' },
    {
      resolveTaskMetadata: async () => metadata,
      resolvePolicy: async () => ({ policyVersionId: 'p', operatorGrantId: 'g', policy }),
      resolveHost: async () => ({ enrolledHostId: 'h' }),
      cleanupPending: async () => true,
      services: { createOrResumeSession: async () => succeeded } as any,
    },
  );
  assert.deepEqual(result, { state: 'cleanup_pending', cleanupPending: true });
});