import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import express from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  RuntimeOnboardingClient,
  validObserverConversationId,
  type RuntimeOnboardingFetch,
} from '../services/runtime-onboarding-client';
import { runRuntimeOnboardingCli, safeFailureCode } from './runtime-onboarding-cli';
import type {
  RuntimeOnboardingPurpose,
  RuntimeOnboardingScope,
  RuntimeOnboardingStore,
} from '../services/runtime-onboarding-store';
import { registerLucaObserverRoute } from '../routes/luca-observer-route';
import { requireFounderOrCoordinationCapability } from '../middleware/coordination-auth';
import { observeSessionEnd, observeSessionStart } from '../services/session-observation-store';

class CountingStore implements RuntimeOnboardingStore {
  readonly entries = new Map<string, string>();
  reads = 0;

  private key(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): string {
    return JSON.stringify([scope.endpoint, scope.actor, scope.runtimeId, purpose]);
  }

  async get(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<string | null> {
    this.reads += 1;
    return this.entries.get(this.key(scope, purpose)) ?? null;
  }

  async set(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<void> {
    this.entries.set(this.key(scope, purpose), value);
  }

  async setIfAbsent(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose, value: string): Promise<string> {
    const existing = this.entries.get(this.key(scope, purpose));
    if (existing !== undefined) return existing;
    this.entries.set(this.key(scope, purpose), value);
    return value;
  }

  async delete(scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose): Promise<void> {
    this.entries.delete(this.key(scope, purpose));
  }
}

const endpoint = 'http://127.0.0.1:43130';
const actor = 'luca-antigravity';
const runtimeId = 'antigravity-local-test';
const selected = '0f1e2d3c-4b5a-4968-8778-a69584736251';
const other = '11111111-2222-4333-8444-555555555555';
const future = (ms = 10 * 60_000) => new Date(Date.now() + ms).toISOString();
const observeCapabilities = ['coordination:read', 'coordination:write', 'observation:read'];

async function storeWithCredential(options: {
  token?: string;
  expiresAt?: string;
  capabilities?: string[];
  credentialEndpoint?: string;
} = {}): Promise<CountingStore> {
  const store = new CountingStore();
  await store.set({ endpoint: options.credentialEndpoint ?? endpoint, actor, runtimeId }, 'access-credential', JSON.stringify({
    endpoint: options.credentialEndpoint ?? endpoint,
    actor,
    runtimeId,
    accessToken: options.token ?? 'observer-fake-token',
    expiresAt: options.expiresAt ?? future(),
    capabilities: options.capabilities ?? observeCapabilities,
  }));
  store.reads = 0;
  return store;
}

function client(
  store: RuntimeOnboardingStore,
  fetchImpl: RuntimeOnboardingFetch,
  at = endpoint,
  observationTimeoutMs?: number,
) {
  return new RuntimeOnboardingClient({
    endpoint: at, actor, runtimeId, store, fetchImpl, allowInsecureHttpForTests: true,
    ...(observationTimeoutMs === undefined ? {} : { observationTimeoutMs }),
  });
}

/** A body streamed in chunks; records how much was pulled and whether it was cancelled. */
function streamedBody(chunk: string, count: number) {
  const bytes = new TextEncoder().encode(chunk);
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(bytes);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('observe sends one fixed GET with the stored token header and returns the selected conversation', async () => {
  const store = await storeWithCredential();
  const seen: Request[] = [];
  const observer = client(store, async (input) => {
    assert.ok(input instanceof Request);
    seen.push(input);
    return json({ status: 'active', conversationId: selected, recentMessages: [{ role: 'assistant', content: 'Hola' }] });
  });
  const result = await observer.readObservation(selected.toUpperCase());
  assert.equal(result.status, 'active');
  assert.equal(result.conversationId, selected);
  assert.deepEqual(result.observation.recentMessages, [{ role: 'assistant', content: 'Hola' }]);
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, `${endpoint}/api/admin/luca/observe?conversationId=${selected}`);
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('x-coordination-token'), 'observer-fake-token');
  assert.equal(request.headers.has('authorization'), false);
  assert.equal(request.headers.has('cookie'), false);
  assert.equal(request.body, null);
});

test('db_only and no_active_session results are returned only for the selected conversation', async () => {
  const store = await storeWithCredential();
  let reply: unknown = { status: 'db_only', session: { conversationId: selected, exchangeCount: 3 } };
  const observer = client(store, async () => json(reply));
  assert.equal((await observer.readObservation(selected)).status, 'db_only');
  reply = { status: 'no_active_session', message: 'No active GL session found.' };
  assert.equal((await observer.readObservation(selected)).status, 'no_active_session');
});

test('a response for any other conversation is refused rather than returned as the selection', async () => {
  const store = await storeWithCredential();
  for (const reply of [
    { status: 'active', conversationId: other },
    { status: 'active' },
    { status: 'active', conversationId: selected, session: { conversationId: other } },
    { status: 'db_only', session: { conversationId: other } },
    { status: 'db_only', session: null },
    { status: 'db_only', session: [selected] },
    { status: 'db_only' },
    { status: 'db_only', conversationId: other, session: { conversationId: selected } },
    { status: 'no_active_session', conversationId: other },
    { status: 'no_active_session', conversationId: null },
    { status: 'no_active_session', session: { conversationId: other, exchangeCount: 9 } },
    { status: 'no_active_session', session: { conversationId: selected } },
  ]) {
    await assert.rejects(
      client(store, async () => json(reply)).readObservation(selected),
      /^Error: onboarding_observe_conversation_mismatch$/,
    );
  }
});

test('missing, empty, latest-style or injected conversation IDs fail before secure-store or network access', async () => {
  for (const value of [
    '', 'latest', ' ', `${selected} `, `${selected}&conversationId=${other}`, `${selected}#x`,
    `../${selected}`, `${selected}/`, '0f1e2d3c4b5a49688778a69584736251', undefined, null, 7, [selected],
  ]) {
    const store = await storeWithCredential();
    let fetches = 0;
    const observer = client(store, async () => {
      fetches += 1;
      return json({ status: 'no_active_session' });
    });
    await assert.rejects(
      observer.readObservation(value as string),
      /^Error: onboarding_observe_conversation_id_invalid$/,
      String(value),
    );
    assert.equal(store.reads, 0, `no secure-store read for ${String(value)}`);
    assert.equal(fetches, 0, `no network for ${String(value)}`);
  }
  assert.throws(() => validObserverConversationId(''), /onboarding_observe_conversation_id_invalid/);
});

test('a credential without observation:read never sends its token', async () => {
  const store = await storeWithCredential({ capabilities: ['coordination:read', 'coordination:write'] });
  let fetches = 0;
  await assert.rejects(
    client(store, async () => { fetches += 1; return json({}); }).readObservation(selected),
    /^Error: onboarding_observe_capability_missing$/,
  );
  assert.equal(fetches, 0);
});

test('no stored credential and no enrollment attempt fails closed without a request', async () => {
  const store = new CountingStore();
  let fetches = 0;
  await assert.rejects(
    client(store, async () => { fetches += 1; return json({}); }).readObservation(selected),
    /^Error: onboarding_credential_unavailable_run_setup$/,
  );
  assert.equal(fetches, 0);
});

test('a credential stored for another endpoint scope is not used for this endpoint', async () => {
  const store = await storeWithCredential({ credentialEndpoint: 'http://127.0.0.1:49999' });
  let fetches = 0;
  await assert.rejects(
    client(store, async () => { fetches += 1; return json({}); }).readObservation(selected),
    /^Error: onboarding_credential_unavailable_run_setup$/,
  );
  assert.equal(fetches, 0);
});

test('near-expiry credential renews through the broker before observing with the renewed token', async () => {
  const store = await storeWithCredential({
    token: 'old-fake-token',
    expiresAt: future(5_000),
    capabilities: [...observeCapabilities, 'coordination:credential:renew'],
  });
  const paths: string[] = [];
  const observer = client(store, async (input, init) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname === '/api/coordination/credentials/renew') {
      assert.equal(request.headers.get('x-coordination-token'), 'old-fake-token');
      return json({ accessToken: 'renewed-fake-token', actor, runtimeId, capabilities: observeCapabilities, expiresAt: future() });
    }
    assert.equal(request.headers.get('x-coordination-token'), 'renewed-fake-token');
    return json({ status: 'no_active_session' });
  });
  await observer.readObservation(selected);
  assert.deepEqual(paths, ['/api/coordination/credentials/renew', '/api/admin/luca/observe']);
});

test('error, redirected, oversized and malformed responses are refused with safe codes', async () => {
  const store = await storeWithCredential();
  const cases: { reply: () => Response; code: RegExp }[] = [
    { reply: () => json({ error: 'Credential lacks required capability: observation:read' }, 403), code: /^Error: onboarding_observe_failed:403$/ },
    { reply: () => new Response('not json', { status: 200 }), code: /^Error: onboarding_observe_response_invalid$/ },
    { reply: () => json([selected]), code: /^Error: onboarding_observe_response_invalid$/ },
    { reply: () => json({ status: 'something_else', conversationId: selected }), code: /^Error: onboarding_observe_response_invalid$/ },
    { reply: () => new Response(`{"status":"active","pad":"${'x'.repeat(1024 * 1024)}"}`), code: /^Error: onboarding_observe_response_too_large$/ },
    { reply: () => new Response(new Uint8Array([0x7b, 0xff, 0x7d])), code: /^Error: onboarding_observe_response_invalid$/ },
    {
      reply: () => {
        const redirected = json({ status: 'active', conversationId: selected });
        Object.defineProperty(redirected, 'redirected', { value: true });
        return redirected;
      },
      code: /^Error: onboarding_observe_response_invalid$/,
    },
    {
      reply: () => {
        const elsewhere = json({ status: 'active', conversationId: selected });
        Object.defineProperty(elsewhere, 'url', { value: 'https://elsewhere.example/api/admin/luca/observe' });
        return elsewhere;
      },
      code: /^Error: onboarding_observe_response_invalid$/,
    },
  ];
  for (const { reply, code } of cases) {
    await assert.rejects(client(store, async () => reply()).readObservation(selected), code);
  }
  assert.equal(safeFailureCode(new Error('onboarding_observe_failed:403')), 'onboarding_observe_failed');
  assert.equal(safeFailureCode(new Error('onboarding_observe_conversation_mismatch')), 'onboarding_observe_conversation_mismatch');
  assert.equal(safeFailureCode(new Error('onboarding_observe_capability_missing')), 'onboarding_observe_capability_missing');
});

test('declared oversize Content-Length is refused before the body is read', async () => {
  const store = await storeWithCredential();
  const { stream, state } = streamedBody('x', 10);
  await assert.rejects(
    client(store, async () => new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
    })).readObservation(selected),
    /^Error: onboarding_observe_response_too_large$/,
  );
  assert.equal(state.pulled <= 1, true, `pulled ${state.pulled}`);
  assert.equal(state.cancelled, true);
});

test('over-limit bodies with missing or understated Content-Length stop reading at the limit', async () => {
  const chunk = 'x'.repeat(64 * 1024);
  for (const contentLength of [undefined, '100', 'not-a-number']) {
    const store = await storeWithCredential();
    // 64 chunks of 64 KiB = 4 MiB offered; the limit is 1 MiB.
    const { stream, state } = streamedBody(chunk, 64);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (contentLength !== undefined) headers['content-length'] = contentLength;
    await assert.rejects(
      client(store, async () => new Response(stream, { headers })).readObservation(selected),
      /^Error: onboarding_observe_response_too_large$/,
      String(contentLength),
    );
    assert.equal(state.cancelled, true, `cancelled for ${String(contentLength)}`);
    assert.ok(state.pulled <= 18, `stopped near the limit for ${String(contentLength)}: pulled ${state.pulled}`);
  }
});

test('a chunked body under the limit is reassembled exactly', async () => {
  const store = await storeWithCredential();
  const body = JSON.stringify({ status: 'active', conversationId: selected, note: 'ñ'.repeat(3000) });
  const encoded = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.length) return controller.close();
      // Odd chunk size splits multi-byte characters across chunks.
      controller.enqueue(encoded.subarray(offset, offset + 777));
      offset += 777;
    },
  });
  const result = await client(store, async () => new Response(stream)).readObservation(selected);
  assert.equal(result.observation.note, 'ñ'.repeat(3000));
});

test('a stalled response or body is aborted by the bounded observation timeout', async () => {
  const store = await storeWithCredential();
  let headerSignal: AbortSignal | undefined;
  const stalledHeaders = client(store, (input) => {
    headerSignal = (input as Request).signal;
    return new Promise<Response>((_resolve, reject) => {
      headerSignal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }, endpoint, 50);
  await assert.rejects(stalledHeaders.readObservation(selected), /^Error: onboarding_observe_timeout$/);
  assert.equal(headerSignal?.aborted, true);

  const stalledBody = client(store, async (input) => {
    const signal = (input as Request).signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
        signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream);
  }, endpoint, 50);
  await assert.rejects(stalledBody.readObservation(selected), /^Error: onboarding_observe_timeout$/);

  for (const invalid of [0, -1, 1.5, 120_001, Number.NaN]) {
    assert.throws(() => client(store, async () => json({}), endpoint, invalid), /onboarding_observe_timeout_invalid/);
  }
  assert.equal(safeFailureCode(new Error('onboarding_observe_timeout')), 'onboarding_observe_timeout');
});

test('generic authenticatedFetch still refuses the observer route and other non-coordination targets', async () => {
  const store = await storeWithCredential();
  let fetches = 0;
  const observer = client(store, async () => { fetches += 1; return json({}); });
  for (const target of [
    `${endpoint}/api/admin/luca/observe?conversationId=${selected}`,
    `${endpoint}/api/admin/luca/observe`,
    `${endpoint}/api/coordination/../admin/luca/observe`,
    `${endpoint}/api/coordination/credentials/renew`,
  ]) {
    await assert.rejects(observer.authenticatedFetch(target), /onboarding_auth_header_target_not_allowed/, target);
  }
  assert.equal(fetches, 0);
});

test('CLI observe requires exactly one valid conversation ID and rejects it on other actions, before store access', async () => {
  const base = ['--endpoint', 'https://example.invalid', '--actor', actor, '--runtime-id', runtimeId];
  await assert.rejects(runRuntimeOnboardingCli(['observe', ...base]), /^Error: usage$/);
  await assert.rejects(
    runRuntimeOnboardingCli(['observe', ...base, '--conversation-id', selected, '--conversation-id', selected]),
    /^Error: usage$/,
  );
  await assert.rejects(runRuntimeOnboardingCli(['observe', ...base, '--conversation-id', '--actor']), /^Error: usage$/);
  await assert.rejects(runRuntimeOnboardingCli(['sdk', ...base, '--conversation-id', selected]), /^Error: usage$/);
  await assert.rejects(runRuntimeOnboardingCli(['observe', ...base, '--conversation-id', 'latest']),
    /^Error: onboarding_observe_conversation_id_invalid$/);
  const originalLog = console.log;
  let help = '';
  console.log = (message?: unknown) => { help += String(message ?? ''); };
  try {
    await runRuntimeOnboardingCli(['--help']);
  } finally {
    console.log = originalLog;
  }
  assert.match(help, /observe .*--conversation-id <uuid>/);
  assert.match(help, /no latest-session default/);
});

// Real route + real coordination auth over HTTP. The database is a stub that
// records statements and returns no rows, so no shared data is read or written.
const routeToken = 'observer-client-route-antigravity-token-'.repeat(2);
const otherActorToken = 'observer-client-route-alden-token-'.repeat(2);
const dialect = new PgDialect();
const statements: { sql: string; params: unknown[] }[] = [];
let server: Server;
let routeEndpoint = '';
let founderFallbackCalls = 0;
const savedEnv = {
  antigravity: process.env.COORDINATION_LUCA_ANTIGRAVITY_TOKEN,
  alden: process.env.COORDINATION_ALDEN_TOKEN,
};

before(async () => {
  process.env.COORDINATION_LUCA_ANTIGRAVITY_TOKEN = routeToken;
  process.env.COORDINATION_ALDEN_TOKEN = otherActorToken;
  const stubDb = {
    execute: async (statement: any) => {
      statements.push(dialect.sqlToQuery(statement));
      return { rows: [] };
    },
  };
  const app = express();
  registerLucaObserverRoute({
    app,
    storage: {},
    getSharedDb: (() => stubDb) as any,
    loadAuthenticatedUser: () => (_req: any, _res: any, next: any) => next(),
    requireFounderOrCoordinationCapability,
    requireFounder: (_req: any, res: any) => {
      founderFallbackCalls += 1;
      res.status(401).json({ error: 'founder session required' });
    },
  });
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, '127.0.0.1', () => resolve());
  });
  routeEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  observeSessionEnd(selected);
  observeSessionEnd(other);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (savedEnv.antigravity === undefined) delete process.env.COORDINATION_LUCA_ANTIGRAVITY_TOKEN;
  else process.env.COORDINATION_LUCA_ANTIGRAVITY_TOKEN = savedEnv.antigravity;
  if (savedEnv.alden === undefined) delete process.env.COORDINATION_ALDEN_TOKEN;
  else process.env.COORDINATION_ALDEN_TOKEN = savedEnv.alden;
});

async function routeClient(token: string) {
  const store = new CountingStore();
  await store.set({ endpoint: routeEndpoint, actor, runtimeId }, 'access-credential', JSON.stringify({
    endpoint: routeEndpoint, actor, runtimeId, accessToken: token, expiresAt: future(), capabilities: observeCapabilities,
  }));
  return client(store, fetch, routeEndpoint);
}

test('real route: the selected conversation is queried by ID, never by latest-session lookup', async () => {
  statements.length = 0;
  const result = await (await routeClient(routeToken)).readObservation(selected);
  assert.equal(result.status, 'no_active_session');
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /conversation_id = \$1/);
  assert.deepEqual(statements[0].params, [selected]);
  assert.equal(founderFallbackCalls, 0);
});

test('real route: an in-memory session for the selected conversation is returned, another session is not', async () => {
  observeSessionStart({
    conversationId: other, userId: 'synthetic-user', language: 'Spanish', actflLevel: null,
  });
  observeSessionStart({
    conversationId: selected, userId: 'synthetic-user', language: 'French', actflLevel: null,
  });
  observeSessionStart({
    conversationId: other, transientSessionId: 'newer', userId: 'synthetic-user', language: 'Spanish', actflLevel: null,
  });
  const result = await (await routeClient(routeToken)).readObservation(selected);
  assert.equal(result.status, 'active');
  assert.equal(result.observation.conversationId, selected);
  assert.equal(result.observation.language, 'French');
});

test('real route: another actor\'s token is refused by the route allowlist', async () => {
  await assert.rejects(
    (await routeClient(otherActorToken)).readObservation(selected),
    /^Error: onboarding_observe_failed:403$/,
  );
  // An unregistered token would fall through to the broker lookup, which reads
  // the configured database, so it is deliberately not exercised here.
  assert.equal(founderFallbackCalls, 0);
});
