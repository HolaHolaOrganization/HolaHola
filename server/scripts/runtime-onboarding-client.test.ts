import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RuntimeOnboardingClient,
} from '../services/runtime-onboarding-client';
import { safeFailureCode, runRuntimeOnboardingCli } from './runtime-onboarding-cli';
import {
  HostedRuntimeOnboardingStore,
  LinuxSecretServiceRuntimeOnboardingStore,
  createNativeRuntimeOnboardingStore,
  type RuntimeOnboardingPurpose,
  type RuntimeOnboardingScope,
  type RuntimeOnboardingStore,
} from '../services/runtime-onboarding-store';
import {
  createRuntimeOpenAITransport,
  generateRuntimeMcpClientConfig,
  runRuntimeMcpStdioBridge,
  runRuntimeOnboardingListener,
} from '../services/runtime-onboarding-transports';

class MemoryStore implements RuntimeOnboardingStore {
  readonly entries = new Map<string, string>();

  private key(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): string {
    return JSON.stringify([scope.endpoint, scope.actor, scope.runtimeId, purpose]);
  }

  async get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    return this.entries.get(this.key(scope, purpose)) ?? null;
  }

  async set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    this.entries.set(this.key(scope, purpose), value);
  }

  async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    const key = this.key(scope, purpose);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    this.entries.set(key, value);
    return value;
  }

  async delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    this.entries.delete(this.key(scope, purpose));
  }
}

const endpoint = 'http://127.0.0.1:43129';
const actor = 'luca-cursor';
const runtimeId = 'cursor-local-test';
const invitationId = 'invite-test-reference';
const requestId = 'request-test-id';
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

function fingerprint(publicKey: string): string {
  return `SHA256:${createHash('sha256')
    .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
    .digest('base64').replace(/=+$/, '')}`;
}

function response(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

test('setup persists one proof-key and stable attempt before request and resumes the same request', async () => {
  const store = new MemoryStore();
  let requestCount = 0;
  let state = 'requested';
  let fingerprintValue = '';
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname.endsWith('/requests') && url.pathname === '/api/coordination/onboarding/requests') {
      requestCount += 1;
      assert.ok(await store.get({ endpoint, actor, runtimeId }, 'proof-key'), 'proof key is durable before POST');
      assert.ok(await store.get({ endpoint, actor, runtimeId }, 'attempt-state'), 'stable attempt is durable before POST');
      fingerprintValue = fingerprint(String(body.publicKey));
      assert.equal(body.invitationId, invitationId);
      return response({
        requestId, actor, runtimeId, verificationCode: 'ABCD-1234',
        fingerprint: fingerprintValue, approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/status`)) {
      return response({
        requestId, actor, runtimeId, fingerprint: fingerprintValue,
        verificationCode: 'ABCD-1234',
        approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    throw new Error(`unexpected_fake_request:${url.pathname}`);
  };
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  const first = await client.setup();
  assert.equal(first.state, 'requested');
  const originalAttempt = await store.get(client.scope, 'attempt-state');
  assert.ok(await store.get(client.scope, 'proof-key'));
  assert.equal(await store.get({ ...client.scope, actor: 'luca-openai-agents' }, 'proof-key'), null);
  assert.equal(await store.get({ ...client.scope, endpoint: 'https://other.example' }, 'proof-key'), null);
  assert.equal(await store.get({ ...client.scope, runtimeId: 'other-runtime' }, 'proof-key'), null);
  state = 'requested';
  const second = await client.setup();
  assert.equal(second.requestId, requestId);
  assert.equal(requestCount, 1);
  assert.equal(await store.get(client.scope, 'attempt-state'), originalAttempt);
});

test('an orphaned proof key is never overwritten or sent as a new request', async () => {
  const store = new MemoryStore();
  await store.set({ endpoint, actor, runtimeId }, 'proof-key', 'existing-protected-key');
  let networkCalls = 0;
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, allowInsecureHttpForTests: true,
    fetchImpl: async () => {
      networkCalls += 1;
      return response({});
    },
  });
  await assert.rejects(client.setup(), /orphaned_proof_key/);
  assert.equal(await store.get(client.scope, 'proof-key'), 'existing-protected-key');
  assert.equal(networkCalls, 0);
});

test('concurrent setup interleaving keeps and uses the atomically winning protected key', async () => {
  let releaseFirstClaim!: () => void;
  let signalFirstClaim!: () => void;
  const firstClaimReached = new Promise<void>((resolvePromise) => { signalFirstClaim = resolvePromise; });
  const claimGate = new Promise<void>((resolvePromise) => { releaseFirstClaim = resolvePromise; });
  class InterleavingStore extends MemoryStore {
    private pauseNextAttemptClaim = true;

    override async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
      const winner = await super.setIfAbsent(scope, purpose, value);
      if (purpose === 'attempt-state' && this.pauseNextAttemptClaim) {
        this.pauseNextAttemptClaim = false;
        signalFirstClaim();
        await claimGate;
      }
      return winner;
    }
  }
  const store = new InterleavingStore();
  let serverCreateCount = 0;
  const serverRequest = new Map<string, Record<string, unknown>>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    assert.equal(url.pathname, '/api/coordination/onboarding/requests');
    const publicKey = String(body.publicKey);
    const pubFingerprint = fingerprint(publicKey);
    const existing = serverRequest.get(String(body.invitationId));
    const request = existing ?? {
      requestId,
      actor,
      runtimeId,
      verificationCode: 'ABCD-1234',
      fingerprint: pubFingerprint,
      approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
      state: 'requested',
      expiresAt: future(),
      capabilities: ['coordination:read'],
    };
    if (!existing) {
      serverCreateCount += 1;
      serverRequest.set(String(body.invitationId), request);
    } else {
      assert.equal(pubFingerprint, existing.fingerprint);
    }
    return response(request);
  };
  const createClient = () => new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  const firstClient = createClient();
  const firstSetup = firstClient.setup();
  await firstClaimReached;
  const secondSetup = createClient().setup();
  const secondRequest = await secondSetup;
  releaseFirstClaim();
  const firstRequest = await firstSetup;
  assert.equal(firstRequest.requestId, secondRequest.requestId);
  assert.equal(serverCreateCount, 1);
  const attempt = JSON.parse(String(await store.get(firstClient.scope, 'attempt-state')));
  const protectedPrivateKey = await store.get(firstClient.scope, 'proof-key');
  assert.equal(attempt.privateKey, undefined);
  assert.ok(protectedPrivateKey);
  assert.equal(fingerprint(String(attempt.publicKey)), attempt.fingerprint);
  assert.equal(createPublicKey(String(protectedPrivateKey)).export({ type: 'spki', format: 'pem' }).toString().trim(),
    String(attempt.publicKey).trim());
});

test('lost initial HTTP response replays the exact invitation/public-key pair against idempotent request contract', async () => {
  const store = new MemoryStore();
  let firstResponseLost = false;
  let postCount = 0;
  let createCount = 0;
  let winningFingerprint = '';
  const serviceByInvitation = new Map<string, Record<string, unknown>>();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    assert.equal(url.pathname, '/api/coordination/onboarding/requests');
    postCount += 1;
    const publicKey = String(body.publicKey);
    const fingerprintValue = fingerprint(publicKey);
    const existing = serviceByInvitation.get(String(body.invitationId));
    if (existing) {
      assert.equal(fingerprintValue, winningFingerprint);
      return response(existing);
    }
    createCount += 1;
    winningFingerprint = fingerprintValue;
    const created = {
      requestId,
      actor,
      runtimeId,
      verificationCode: 'WXYZ-9876',
      fingerprint: fingerprintValue,
      approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
      state: 'requested',
      expiresAt: future(),
      capabilities: ['coordination:read'],
    };
    serviceByInvitation.set(String(body.invitationId), created);
    if (!firstResponseLost) {
      firstResponseLost = true;
      throw new Error('fake network dropped the first response after commit');
    }
    return response(created);
  };
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  await assert.rejects(client.setup(), /fake network dropped/);
  const durableAttempt = JSON.parse(String(await store.get(client.scope, 'attempt-state')));
  assert.equal(durableAttempt.requestId, null);
  const resumed = await client.setup();
  assert.equal(resumed.requestId, requestId);
  assert.equal(postCount, 2);
  assert.equal(createCount, 1);
  assert.equal(durableAttempt.fingerprint, winningFingerprint);
});

test('enrolled recovery after invitation expiry reuses the durable proof key and original request', async () => {
  const store = new MemoryStore();
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyFingerprint = fingerprint(pair.publicKey);
  const recoveryRequestId = 'request-expired-invitation';
  await store.set({ endpoint, actor, runtimeId }, 'proof-key', pair.privateKey);
  await store.set({ endpoint, actor, runtimeId }, 'attempt-state', JSON.stringify({
    version: 1,
    invitationId,
    requestId: recoveryRequestId,
    fingerprint: keyFingerprint,
    publicKey: pair.publicKey,
    proofPending: false,
  }));
  let invitationExpired = true;
  let requestCreationCalls = 0;
  let recoveryProofCalls = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === `/api/coordination/onboarding/requests/${recoveryRequestId}/status`) {
      assert.equal(invitationExpired, true);
      return response({
        requestId: recoveryRequestId, actor, runtimeId, fingerprint: keyFingerprint,
        verificationCode: 'RECOVER-1',
        approvalPath: `/admin/runtime-onboarding?request=${recoveryRequestId}`,
        state: 'enrolled', expiresAt: new Date(Date.now() - 60_000).toISOString(),
        capabilities: ['coordination:read'],
      });
    }
    if (url.pathname === `/api/coordination/onboarding/requests/${recoveryRequestId}/challenge`) {
      assert.equal(body.purpose, 'recover');
      assert.equal(invitationExpired, true);
      const nonce = 'recover-after-expiry';
      return response({
        challengeId: 'challenge-after-invitation-expiry',
        nonce,
        expiresAt: future(),
        payload: JSON.stringify({
          version: 1, domain: 'holahola-coordination-runtime-onboarding',
          endpoint, actor, runtimeId, requestId: recoveryRequestId, invitationId,
          fingerprint: keyFingerprint, nonce, purpose: 'recover',
        }),
      });
    }
    if (url.pathname === `/api/coordination/onboarding/requests/${recoveryRequestId}/prove`) {
      recoveryProofCalls += 1;
      const signedPayload = JSON.stringify({
        version: 1, domain: 'holahola-coordination-runtime-onboarding',
        endpoint, actor, runtimeId, requestId: recoveryRequestId, invitationId,
        fingerprint: keyFingerprint, nonce: 'recover-after-expiry', purpose: 'recover',
      });
      assert.equal(verify('RSA-SHA256', Buffer.from(signedPayload), pair.publicKey, Buffer.from(String(body.signature), 'base64')), true);
      assert.equal(await store.get({ endpoint, actor, runtimeId }, 'proof-key'), pair.privateKey);
      return response({
        accessToken: 'recovered-fake-token',
        credentialId: 'recovered-credential',
        actor, runtimeId, capabilities: ['coordination:read'], expiresAt: future(),
      });
    }
    if (url.pathname === '/api/coordination/threads') {
      requestCreationCalls += 1;
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      assert.equal(request.headers.get('x-coordination-token'), 'recovered-fake-token');
      assert.equal(request.headers.get('authorization'), null);
      return response({ actor, items: [], cursor: 0 });
    }
    throw new Error(`unexpected_fake_recovery_request:${url.pathname}`);
  };
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  const responseFromLedger = await client.authenticatedFetch(
    `${endpoint}/api/coordination/threads?limit=1`,
    { method: 'GET' },
  );
  assert.equal(responseFromLedger.status, 200);
  assert.equal(invitationExpired, true);
  assert.equal(recoveryProofCalls, 1);
  assert.equal(requestCreationCalls, 1);
  assert.equal(await client.hasCredential(), true);
  assert.equal(await store.get(client.scope, 'proof-key'), pair.privateKey);
});

test('Linux Secret Service serializes first-write across IDE and headless processes with mixed XDG environments', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-onboarding-secret-service-'));
  const fakeBin = join(root, 'bin');
  const runtimeDirectory = join(root, 'runtime');
  const statePath = join(root, 'keyring.json');
  const fakeSecretTool = join(fakeBin, 'secret-tool');
  mkdirSync(fakeBin, { mode: 0o700 });
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  chmodSync(fakeBin, 0o700);
  chmodSync(runtimeDirectory, 0o700);
  writeFileSync(statePath, '{}', { mode: 0o600 });
  writeFileSync(fakeSecretTool, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const operation = args[0];
const scopeIndex = args.indexOf('scope');
const key = args[args.indexOf('service') + 1] + ':' + args[scopeIndex + 1];
const statePath = process.env.FAKE_SECRET_TOOL_STATE;
if (process.env.FAKE_SECRET_TOOL_MODE === 'unavailable') process.exit(1);
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
if (operation === 'lookup') {
  if (!Object.prototype.hasOwnProperty.call(state, key)) process.exit(1);
  process.stdout.write(state[key] + '\\n');
} else if (operation === 'store') {
  state[key] = fs.readFileSync(0, 'utf8');
    if (process.env.FAKE_SECRET_TOOL_DELAY_STORE === '1') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (operation === 'clear') {
  delete state[key];
  fs.writeFileSync(statePath, JSON.stringify(state));
} else {
  process.exit(2);
}
`, { mode: 0o700 });
  chmodSync(fakeSecretTool, 0o700);
  const previousPath = process.env.PATH;
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const previousState = process.env.FAKE_SECRET_TOOL_STATE;
  const previousMode = process.env.FAKE_SECRET_TOOL_MODE;
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
  process.env.XDG_RUNTIME_DIR = runtimeDirectory;
  process.env.FAKE_SECRET_TOOL_STATE = statePath;
  process.env.FAKE_SECRET_TOOL_MODE = 'healthy';
  try {
    const store = new LinuxSecretServiceRuntimeOnboardingStore();
    const emptyScope = { endpoint, actor, runtimeId: 'linux-empty-scope' };
    assert.equal(await store.get(emptyScope, 'proof-key'), null);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {}, 'health probe item is cleared');

    process.env.FAKE_SECRET_TOOL_MODE = 'unavailable';
    await assert.rejects(store.get({ ...emptyScope, runtimeId: 'linux-unavailable-scope' }, 'proof-key'),
      /secret_service_unavailable_or_lookup_failed/);
    process.env.FAKE_SECRET_TOOL_MODE = 'healthy';

    const workerPath = join(root, 'atomic-store-worker.ts');
    const storeModule = new URL('../services/runtime-onboarding-store.ts', import.meta.url).href;
    writeFileSync(workerPath, `
import { LinuxSecretServiceRuntimeOnboardingStore } from ${JSON.stringify(storeModule)};
void (async () => {
  const store = new LinuxSecretServiceRuntimeOnboardingStore();
  const winner = await store.setIfAbsent(
    { endpoint: ${JSON.stringify(endpoint)}, actor: 'luca-cursor', runtimeId: 'linux-cross-process-race' },
    'proof-key',
    process.argv[process.argv.length - 1],
  );
  process.stdout.write(winner);
})();
`);
    const tsxCli = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/tsx/dist/cli.mjs');
    const runWorker = (candidate: string, hasXdg: boolean): Promise<string> => new Promise((resolvePromise, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, FAKE_SECRET_TOOL_DELAY_STORE: '1' };
      if (!hasXdg) delete env.XDG_RUNTIME_DIR;
      const child = spawn(process.execPath, [tsxCli, workerPath, candidate], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolvePromise(stdout);
        else reject(new Error(`atomic_worker_failed:${code}:${stderr.slice(0, 100)}`));
      });
    });
    const winners = await Promise.all([
      runWorker('candidate-key-one', true),
      runWorker('candidate-key-two', false),
    ]);
    assert.equal(winners[0], winners[1]);
    assert.ok(['candidate-key-one', 'candidate-key-two'].includes(winners[0]));
    assert.equal(await store.get({
      endpoint, actor, runtimeId: 'linux-cross-process-race',
    }, 'proof-key'), winners[0]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    if (previousState === undefined) delete process.env.FAKE_SECRET_TOOL_STATE;
    else process.env.FAKE_SECRET_TOOL_STATE = previousState;
    if (previousMode === undefined) delete process.env.FAKE_SECRET_TOOL_MODE;
    else process.env.FAKE_SECRET_TOOL_MODE = previousMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test('approved setup signs exact bound challenge and persists token without exposing it in safe result', async () => {
  const store = new MemoryStore();
  let state = 'requested';
  let publicKey = '';
  let pubFingerprint = '';
  let proveCount = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === '/api/coordination/onboarding/requests') {
      publicKey = String(body.publicKey);
      pubFingerprint = fingerprint(publicKey);
      return response({
        requestId, actor, runtimeId, verificationCode: 'WXYZ-9876',
        fingerprint: pubFingerprint, approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/status`)) {
      return response({
        requestId, actor, runtimeId, fingerprint: pubFingerprint,
        verificationCode: 'WXYZ-9876',
        approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/challenge`)) {
      assert.equal(body.purpose, 'enroll');
      const nonce = 'nonce-test';
      return response({
        challengeId: 'challenge-test',
        nonce,
        expiresAt: future(),
        payload: JSON.stringify({
          version: 1, domain: 'holahola-coordination-runtime-onboarding',
          endpoint, actor, runtimeId, requestId, invitationId,
          fingerprint: pubFingerprint, nonce, purpose: 'enroll',
        }),
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/prove`)) {
      proveCount += 1;
      const storedAttempt = JSON.parse(String(await store.get({ endpoint, actor, runtimeId }, 'attempt-state')));
      const privateKey = await store.get({ endpoint, actor, runtimeId }, 'proof-key');
      assert.ok(privateKey);
      const challengePayload = JSON.stringify({
        version: 1, domain: 'holahola-coordination-runtime-onboarding',
        endpoint, actor, runtimeId, requestId, invitationId,
        fingerprint: pubFingerprint, nonce: 'nonce-test', purpose: 'enroll',
      });
      assert.equal(typeof body.signature, 'string');
      assert.equal(
        verify('RSA-SHA256', Buffer.from(challengePayload), publicKey, Buffer.from(String(body.signature), 'base64')),
        true,
      );
      assert.equal(storedAttempt.proofPending, true);
      state = 'enrolled';
      return response({
        accessToken: 'fake-broker-token-never-print',
        credentialId: 'credential-test',
        actor, runtimeId, capabilities: ['coordination:read'], expiresAt: future(),
      });
    }
    throw new Error(`unexpected_fake_request:${url.pathname}`);
  };
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  assert.equal((await client.setup()).state, 'requested');
  state = 'approved';
  const safe = await client.setup();
  assert.equal(safe.state, 'enrolled');
  assert.equal(proveCount, 1);
  assert.equal(await client.hasCredential(), true);
  assert.equal(JSON.stringify(safe).includes('fake-broker-token'), false);
});

test('challenge bound to another actor or endpoint is rejected before proof', async () => {
  const store = new MemoryStore();
  let state = 'requested';
  let pubFingerprint = '';
  let proofCalls = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (url.pathname === '/api/coordination/onboarding/requests') {
      pubFingerprint = fingerprint(String(body.publicKey));
      return response({
        requestId, actor, runtimeId, fingerprint: pubFingerprint,
        verificationCode: 'WXYZ-9876',
        approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/status`)) {
      return response({
        requestId, actor, runtimeId, fingerprint: pubFingerprint,
        verificationCode: 'WXYZ-9876',
        approvalPath: `/admin/runtime-onboarding?request=${requestId}`,
        state, expiresAt: future(), capabilities: ['coordination:read'],
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/challenge`)) {
      return response({
        challengeId: 'challenge-test', nonce: 'nonce-test', expiresAt: future(),
        payload: JSON.stringify({
          version: 1, domain: 'holahola-coordination-runtime-onboarding',
          endpoint, actor: 'luca-antigravity', runtimeId, requestId, invitationId,
          fingerprint: pubFingerprint, nonce: 'nonce-test', purpose: 'enroll',
        }),
      });
    }
    if (url.pathname.endsWith(`/requests/${requestId}/prove`)) proofCalls += 1;
    throw new Error(`unexpected_fake_request:${url.pathname}`);
  };
  const client = new RuntimeOnboardingClient({
    endpoint, actor, runtimeId, invitationId, store, fetchImpl, allowInsecureHttpForTests: true,
  });
  await client.setup();
  state = 'approved';
  await assert.rejects(client.setup(), /cross_scope_or_invalid_binding/);
  assert.equal(proofCalls, 0);
});

test('OpenAI-compatible SDK transport authenticates MCP internally, renews by broker API, and uses no user API key', async () => {
  const store = new MemoryStore();
  const scope = { endpoint, actor, runtimeId };
  await store.set(scope, 'access-credential', JSON.stringify({
    endpoint, actor, runtimeId, accessToken: 'expired-soon-fake-token',
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    capabilities: ['coordination:read', 'coordination:credential:renew'],
  }));
  let renewalCount = 0;
  let mcpCount = 0;
  let ledgerReadCount = 0;
  const transport = createRuntimeOpenAITransport({
    ...scope,
    store,
    allowInsecureHttpForTests: true,
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const requestBody = input instanceof Request ? await input.clone().text() : String(init?.body ?? '');
      if (url.pathname === '/api/coordination/credentials/renew') {
        renewalCount += 1;
        assert.equal(headers.get('x-coordination-token'), 'expired-soon-fake-token');
        assert.equal(JSON.parse(requestBody).constructor, Object);
        return response({
          accessToken: 'renewed-fake-token', actor, runtimeId,
          capabilities: ['coordination:read'], expiresAt: future(),
        });
      }
      if (url.pathname === '/api/coordination/threads') {
        assert.equal(input instanceof Request ? input.method : init?.method, 'GET');
        assert.equal(headers.get('x-coordination-token'), 'renewed-fake-token');
        assert.equal(headers.has('authorization'), false);
        ledgerReadCount += 1;
        return response({ actor, items: [], cursor: 0 });
      }
      assert.equal(url.pathname, '/api/mcp/coordination');
      assert.equal(headers.get('authorization'), 'Bearer renewed-fake-token');
      assert.equal(headers.has('openai-api-key'), false);
      assert.equal(headers.has('x-coordination-token'), false);
      mcpCount += 1;
      assert.equal(headers.get('x-coordination-token'), null);
      const method = JSON.parse(requestBody).method;
      const result = method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } }
        : method === 'tools/list'
          ? { tools: [{ name: 'list_coordination_inbox' }] }
          : { content: [{ type: 'text', text: JSON.stringify({ items: [], window: {} }) }] };
      return response({
        jsonrpc: '2.0',
        id: JSON.parse(requestBody).id,
        result,
      });
    },
  });
  const result = await transport.client.sdkCheck();
  assert.deepEqual(result, {
    connected: true, actor, runtimeId, ledgerRead: true, mcpReadTool: 'list_coordination_inbox',
  });
  assert.equal(renewalCount, 1);
  assert.equal(ledgerReadCount, 1);
  assert.equal(mcpCount, 3);
});

test('generated MCP config contains only executable and scoped non-secret arguments', () => {
  const secureEndpoint = 'https://coordination.example';
  const config = generateRuntimeMcpClientConfig({
    executable: '/trusted/node',
    cliEntryPath: '/reviewed/runtime-onboarding-cli.mjs',
    endpoint: secureEndpoint, actor, runtimeId,
  });
  const serialized = JSON.stringify(config);
  assert.match(serialized, /runtime-onboarding-cli\.mjs/);
  assert.match(serialized, /luca-cursor/);
  assert.match(serialized, /cursor-local-test/);
  assert.doesNotMatch(serialized, /bearer|token|private.?key|secret/i);
  assert.deepEqual((config as any).mcpServers['holahola-coordination'].args, [
    '/reviewed/runtime-onboarding-cli.mjs', 'mcp',
    '--endpoint', secureEndpoint, '--actor', actor, '--runtime-id', runtimeId,
  ]);
});

test('stdio bridge forwards protocol JSON and keeps diagnostics on stderr', async () => {
  const store = new MemoryStore();
  const scope = { endpoint, actor, runtimeId };
  await store.set(scope, 'access-credential', JSON.stringify({
    endpoint, actor, runtimeId, accessToken: 'bridge-fake-token',
    expiresAt: future(), capabilities: ['coordination:read'],
  }));
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let outputText = '';
  let errorText = '';
  output.on('data', (chunk) => { outputText += chunk.toString(); });
  diagnostics.on('data', (chunk) => { errorText += chunk.toString(); });
  const run = runRuntimeMcpStdioBridge({
    ...scope,
    store,
    input,
    output,
    diagnostics,
    allowInsecureHttpForTests: true,
    fetchImpl: async (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer bridge-fake-token');
      return response({ jsonrpc: '2.0', id: 'mcp-1', result: { ok: true } });
    },
  });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 'mcp-1', method: 'initialize', params: {} })}\n`);
  await run;
  assert.equal(JSON.parse(outputText).result.ok, true);
  assert.equal(errorText, '');
  assert.doesNotMatch(outputText, /bridge-fake-token/);
});

test('hosted store must explicitly assert runtime restriction; unsupported platform has no plaintext fallback', () => {
  assert.throws(() => new HostedRuntimeOnboardingStore({
    runtimeRestricted: false as true,
    get: async () => null,
    set: async () => undefined,
    setIfAbsent: async (_scope, _purpose, value) => value,
    delete: async () => undefined,
  }), /runtime_restricted/);
  assert.throws(() => createNativeRuntimeOnboardingStore('freebsd'), /secure_store_unsupported_platform/);
  assert.ok(createNativeRuntimeOnboardingStore('linux'));
  assert.equal(typeof endpoint, 'string');
});

test('CLI help succeeds before any secure-store access and raw exception text is never emitted as a code', async () => {
  const originalLog = console.log;
  let help = '';
  console.log = (message?: unknown) => { help += String(message ?? ''); };
  try {
    await runRuntimeOnboardingCli(['--help']);
  } finally {
    console.log = originalLog;
  }
  assert.match(help, /setup/);
  assert.match(help, /--wait/);
  assert.match(help, /listen/);
  assert.match(help, /--parent-pid/);
  assert.equal(safeFailureCode(new Error('accessToken=private-secret')), 'runtime_onboarding_operation_failed');
  assert.equal(safeFailureCode(new Error('onboarding_endpoint_invalid')), 'onboarding_endpoint_invalid');
});

test('runRuntimeOnboardingListener requires stored credentials and fails closed if setup was not run', async () => {
  const store = new MemoryStore();
  const scope = { endpoint, actor, runtimeId };
  await assert.rejects(
    runRuntimeOnboardingListener({
      ...scope,
      store,
      allowInsecureHttpForTests: true,
    }),
    /onboarding_credential_unavailable_run_setup/,
  );
});

test('runRuntimeOnboardingListener executes in once mode using authenticatedFetch and saves receipts', async () => {
  const store = new MemoryStore();
  const scope = { endpoint, actor, runtimeId };
  await store.set(scope, 'access-credential', JSON.stringify({
    endpoint, actor, runtimeId, accessToken: 'listener-fake-token',
    expiresAt: future(), capabilities: ['coordination:read'],
  }));
  const stateDir = mkdtempSync(join(tmpdir(), 'listener-test-state-'));
  const lines: string[] = [];
  try {
    const exitCode = await runRuntimeOnboardingListener({
      ...scope,
      store,
      stateDir,
      mode: 'once',
      initialAfter: 0,
      resume: false,
      allowInsecureHttpForTests: true,
      emit: (line) => { lines.push(line); },
      fetchImpl: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.pathname, '/api/coordination/inbox');
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        assert.equal(headers.get('x-coordination-token'), 'listener-fake-token');
        return response({
          actor,
          items: [
            {
              inboxItem: {
                id: '11111111-1111-4111-8111-111111111111',
                recipientActor: actor,
                coordinationEventId: '22222222-2222-4222-8222-222222222222',
                coordinationThreadId: '33333333-3333-4333-8333-333333333333',
                eventGlobalSequence: 1,
                senderActor: 'luca-replit',
              },
              event: { id: '22222222-2222-4222-8222-222222222222' },
              thread: { id: '33333333-3333-4333-8333-333333333333' },
            },
          ],
          window: { through: 1, complete: true, nextToken: null },
        });
      },
    });
    assert.equal(exitCode, 0);
    assert.ok(lines.some((l) => l.startsWith('LUCAMSG_READY')));
    assert.ok(lines.some((l) => l.startsWith('LUCAMSG_ALERT')));
    assert.ok(lines.some((l) => l.startsWith('LUCAMSG_STOP')));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('usableCredential respects minRemainingMs and auto-renews when below threshold', async () => {
  const store = new MemoryStore();
  const scope = { endpoint, actor, runtimeId };
  // Expiring in 2 minutes (120,000 ms)
  const expiringSoon = new Date(Date.now() + 120_000).toISOString();
  await store.set(scope, 'access-credential', JSON.stringify({
    endpoint, actor, runtimeId, accessToken: 'old-token',
    expiresAt: expiringSoon, capabilities: ['coordination:read', 'coordination:credential:renew'],
  }));
  let renewed = false;
  const client = new RuntimeOnboardingClient({
    ...scope,
    store,
    allowInsecureHttpForTests: true,
    fetchImpl: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/coordination/credentials/renew') {
        renewed = true;
        return response({
          endpoint, actor, runtimeId, accessToken: 'renewed-token',
          expiresAt: future(), capabilities: ['coordination:read'],
        });
      }
      throw new Error(`unexpected_url:${url.pathname}`);
    },
  });

  // Default skew is 60s: 120s remaining > 60s, so it should NOT renew yet
  const cred1 = await client.usableCredential();
  assert.equal(cred1.accessToken, 'old-token');
  assert.equal(renewed, false);

  // Proactive threshold of 3 minutes (180,000 ms): 120s remaining < 180s, so it SHOULD renew
  const cred2 = await client.usableCredential(180_000);
  assert.equal(cred2.accessToken, 'renewed-token');
  assert.equal(renewed, true);
});