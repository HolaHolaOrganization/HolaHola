import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCoordinationActor } from '../middleware/coordination-auth';
import {
  coordinationBootstrapTokenShapeIssue,
  coordinationClientActions,
  createCoordinationActorClient,
  type CoordinationClientActor,
  type CoordinationCredentialCache,
  type CoordinationCredentialCacheEntry,
} from '../services/coordination-actor-client';
import { generateCoordinationSecret } from '../services/coordination-credential-broker';
import { canCoordinationActorPerform } from '../services/coordination-ledger-service';
import { COORDINATION_ACTOR_IDS } from '@shared/schema';
import {
  assertExplicitCoordinationCommentIntent,
  coordinationCliDeliverySummary,
  SUPPORTED_COORDINATION_CLI_ACTORS,
  SUPPORTED_COORDINATION_CLI_RECIPIENTS,
  isSupportedCoordinationActor,
  SUPPORTED_COORDINATION_ACTORS,
  unsupportedCoordinationCliOptions,
} from './coordination-cli';

// A structurally valid bootstrap fixture: "cb_" + 43 base64url characters,
// matching the exact shape CoordinationActorClient.exchangeBootstrap() now
// checks locally before making any HTTP call. Using a real-shaped value here
// keeps the tests below exercising the actual request flow instead of
// tripping the new local shape guard.
const VALID_BOOTSTRAP_TOKEN = `cb_${'r'.repeat(43)}`;

const TOKENS = {
  'luca-replit': 'r'.repeat(40),
  'luca-claude-code': 'c'.repeat(40),
  'luca-gemini': 'g'.repeat(40),
  'luca-antigravity': 'v'.repeat(40),
  'luca-holahola': 'h'.repeat(40),
  'luca-cursor': 'u'.repeat(40),
  'luca-openai-agents': 'o'.repeat(40),
  'luca-codex': 'x'.repeat(40),
  alden: 'a'.repeat(40),
  daniela: 'd'.repeat(40),
  david: 'f'.repeat(40),
} as const satisfies Record<CoordinationClientActor, string>;

const ENVIRONMENT = {
  COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'],
  COORDINATION_LUCA_CLAUDE_CODE_TOKEN: TOKENS['luca-claude-code'],
  COORDINATION_LUCA_GEMINI_TOKEN: TOKENS['luca-gemini'],
  COORDINATION_LUCA_ANTIGRAVITY_TOKEN: TOKENS['luca-antigravity'],
  COORDINATION_LUCA_HOLAHOLA_TOKEN: TOKENS['luca-holahola'],
  COORDINATION_LUCA_CURSOR_TOKEN: TOKENS['luca-cursor'],
  COORDINATION_LUCA_OPENAI_AGENTS_TOKEN: TOKENS['luca-openai-agents'],
  COORDINATION_LUCA_CODEX_TOKEN: TOKENS['luca-codex'],
  COORDINATION_ALDEN_TOKEN: TOKENS.alden,
  COORDINATION_DANIELA_TOKEN: TOKENS.daniela,
  COORDINATION_DAVID_TOKEN: TOKENS.david,
  COORDINATION_API_TOKEN: 'shared-token-must-never-be-used'.repeat(2),
};

/**
 * In-memory stand-in for FileCoordinationCliCredentialCache, used to prove
 * CoordinationActorClient's cache integration (which actor/runtimeId it
 * queries and persists under, and when it trusts vs. discards a hit) without
 * touching the filesystem. The on-disk implementation's own round-trip and
 * identity-isolation behavior is covered separately in
 * server/services/coordination-cli-credential-cache.test.ts.
 */
class FakeCredentialCacheStore {
  private readonly entries = new Map<string, CoordinationCredentialCacheEntry>();
  readonly loadCalls: Array<{ actor: string; runtimeId: string }> = [];
  readonly saveCalls: CoordinationCredentialCacheEntry[] = [];

  private key(actor: string, runtimeId: string): string {
    return `${actor}\u0000${runtimeId}`;
  }

  seed(entry: CoordinationCredentialCacheEntry): void {
    this.entries.set(this.key(entry.actor, entry.runtimeId), entry);
  }

  asCache(): CoordinationCredentialCache {
    return {
      load: async (actor, runtimeId) => {
        this.loadCalls.push({ actor, runtimeId });
        return this.entries.get(this.key(actor, runtimeId)) ?? null;
      },
      save: async (entry) => {
        this.saveCalls.push(entry);
        this.entries.set(this.key(entry.actor, entry.runtimeId), entry);
      },
      clear: async (actor, runtimeId) => {
        this.entries.delete(this.key(actor, runtimeId));
      },
    };
  }
}

test('coordination CLI requires explicit ledger-only intent for plain comments', () => {
  assert.throws(
    () => assertExplicitCoordinationCommentIntent('comment', {}),
    /requires exactly one delivery intent/,
  );
  assert.throws(
    () => assertExplicitCoordinationCommentIntent('comment', { 'ledger-only': 'true' }),
    /requires exactly one delivery intent/,
  );
  assert.doesNotThrow(
    () => assertExplicitCoordinationCommentIntent('comment', { 'ledger-only': true }),
  );
  assert.doesNotThrow(
    () => assertExplicitCoordinationCommentIntent('comment', { recipient: 'luca-claude-code' }),
  );
  assert.throws(
    () => assertExplicitCoordinationCommentIntent('comment', {
      recipient: 'luca-claude-code',
      'ledger-only': true,
    }),
    /requires exactly one delivery intent/,
  );
  assert.doesNotThrow(
    () => assertExplicitCoordinationCommentIntent('reply-and-verify', {}),
  );
  assert.deepEqual(
    unsupportedCoordinationCliOptions('comment', { 'ledger-only': true }),
    [],
  );
});

test('coordination CLI makes delivery outcomes explicit', () => {
  assert.deepEqual(coordinationCliDeliverySummary('comment', { deliveryState: 'not_applicable' }), {
    state: 'not_requested',
    message: 'Ledger-only comment recorded; no recipient delivery was requested.',
  });
  assert.deepEqual(coordinationCliDeliverySummary('reply-and-verify', { deliveryState: 'delivered' }), {
    state: 'delivered',
    message: 'Recipient inbox delivery verified.',
  });
  assert.deepEqual(coordinationCliDeliverySummary('create', { deliveryState: 'pending' }), {
    state: 'queued',
    message: 'Recipient delivery is queued and has not been verified yet.',
  });
  assert.deepEqual(
    coordinationCliDeliverySummary('complete-with-linked-outcome', {
      linkedReply: { deliveryState: 'failed' },
    }),
    { state: 'failed', message: 'Recipient delivery failed.' },
  );
  assert.equal(coordinationCliDeliverySummary('show', { thread: {} }), null);
});

// Regression guard for Task #1640: coordination-cli.ts used to hand-maintain
// two separate array literals (one for COORDINATION_ACTOR, one for
// --recipient) that duplicated COORDINATION_ACTOR_IDS (shared/schema.ts)
// instead of deriving from it. Both silently fell out of sync with the
// canonical list -- 'luca-antigravity' was fully wired into coordination
// auth, capabilities, and the actor-client type/permission checks yet still
// rejected by the CLI with a generic "Unsupported" error (Task #1636), and
// 'luca-gemini' had independently drifted out of the same two arrays by the
// time that was fixed. coordination-cli.ts now derives both allowlists from
// a single exported SUPPORTED_COORDINATION_ACTORS constant, so this test
// exercises that exact constant -- not a re-implementation of the intended
// list -- to fail loudly the moment it and COORDINATION_ACTOR_IDS diverge
// again, regardless of why.
test('the CLI\'s supported-actor allowlist exactly matches every real coordination actor', () => {
  const canonicalInteractiveActors = COORDINATION_ACTOR_IDS.filter(
    (id) => id !== 'coordination-system',
  );
  assert.deepEqual(
    [...SUPPORTED_COORDINATION_ACTORS].sort(),
    [...canonicalInteractiveActors].sort(),
    'coordination-cli.ts\'s SUPPORTED_COORDINATION_ACTORS must contain exactly the actors in ' +
      'COORDINATION_ACTOR_IDS (shared/schema.ts) other than the internal coordination-system pseudo-actor -- ' +
      'otherwise a newly onboarded interactive hat (or one that already drifted, like luca-gemini) is silently ' +
      'rejected by both COORDINATION_ACTOR and --recipient with a generic "Unsupported" error.',
  );
  for (const actor of canonicalInteractiveActors) {
    assert.ok(
      isSupportedCoordinationActor(actor),
      `isSupportedCoordinationActor('${actor}') must be true for every actor in COORDINATION_ACTOR_IDS`,
    );
  }
  assert.equal(
    isSupportedCoordinationActor('coordination-system'),
    false,
    'coordination-system is an internal pseudo-actor -- it never runs the CLI and is never a message ' +
      'recipient, so it must stay excluded from the CLI allowlist',
  );
  assert.equal(
    isSupportedCoordinationActor('not-a-real-actor'),
    false,
    'an unrecognized string must never be reported as a supported coordination actor',
  );
});

test('remaining actors resolve only from their dedicated credentials', () => {
  for (const [actor, token] of Object.entries(TOKENS)) {
    assert.deepEqual(resolveCoordinationActor(token, undefined, ENVIRONMENT), {
      ok: true,
      actor,
    });
  }

  assert.equal(
    resolveCoordinationActor(ENVIRONMENT.COORDINATION_API_TOKEN, undefined, ENVIRONMENT).ok,
    false,
  );
  assert.equal(
    resolveCoordinationActor(undefined, ENVIRONMENT.COORDINATION_API_TOKEN, ENVIRONMENT).ok,
    false,
  );
});

test('actor clients send only the selected actor dedicated credential', async () => {
  const observed: Array<{ url: string; token: string | null }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    observed.push({
      url: String(input),
      token: headers.get('x-coordination-token'),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  for (const actor of Object.keys(TOKENS) as CoordinationClientActor[]) {
    const client = createCoordinationActorClient(actor, {
      apiUrl: 'https://coordination.example',
      environment: ENVIRONMENT,
      fetchImpl,
    });
    await client.listFeed({ cursor: 4, limit: 10 });
  }

  assert.deepEqual(observed.map((request) => request.token), [
    TOKENS['luca-replit'],
    TOKENS['luca-claude-code'],
    TOKENS['luca-gemini'],
    TOKENS['luca-antigravity'],
    TOKENS['luca-holahola'],
    TOKENS['luca-cursor'],
    TOKENS['luca-openai-agents'],
    TOKENS['luca-codex'],
    TOKENS.alden,
    TOKENS.daniela,
    TOKENS.david,
  ]);
  assert.equal(observed.every((request) => request.url.includes('cursor=4&limit=10')), true);
});

test('actor clients exchange only their own runtime bootstrap and use the short-lived token', async () => {
  const observed: Array<{ url: string; bootstrap: string | null; token: string | null; body: string | null }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    observed.push({
      url,
      bootstrap: headers.get('x-coordination-bootstrap'),
      token: headers.get('x-coordination-token'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      return new Response(JSON.stringify({
        accessToken: 'ct_short-lived-token',
        actor: 'luca-replit',
        runtimeId: 'luca-replit-primary',
        capabilities: ['coordination:read'],
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'luca-replit-primary',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl,
  });

  await client.listFeed();

  assert.deepEqual(observed, [
    {
      url: 'https://coordination.example/api/coordination/credentials/exchange',
      bootstrap: VALID_BOOTSTRAP_TOKEN,
      token: null,
      body: JSON.stringify({ runtimeId: 'luca-replit-primary' }),
    },
    {
      url: 'https://coordination.example/api/coordination/threads',
      bootstrap: null,
      token: 'ct_short-lived-token',
      body: null,
    },
  ]);
});

test('actor clients reject a broker response attributed to another actor', async () => {
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'luca-replit-primary',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      accessToken: 'ct_wrong-actor-token',
      actor: 'luca-claude-code',
      runtimeId: 'luca-replit-primary',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }), { status: 201 }),
  });

  await assert.rejects(() => client.listFeed(), /cross-actor credential/);
});

test('coordinationBootstrapTokenShapeIssue accepts every token generateCoordinationSecret(\'cb\') actually produces', () => {
  for (let i = 0; i < 50; i += 1) {
    const token = generateCoordinationSecret('cb');
    assert.equal(
      coordinationBootstrapTokenShapeIssue(token),
      undefined,
      `a real broker-minted bootstrap must pass the client's local shape check, got an issue for: ${token}`,
    );
  }
});

test('coordinationBootstrapTokenShapeIssue names a wrong prefix, a truncated token, a padded token, and bad characters', () => {
  const real = generateCoordinationSecret('cb');
  assert.match(
    coordinationBootstrapTokenShapeIssue(`ct_${real.slice(3)}`) ?? '',
    /must start with "cb_"/,
    'an access-token prefix on what should be a bootstrap must be flagged',
  );
  assert.match(
    coordinationBootstrapTokenShapeIssue(real.slice(0, -4)) ?? '',
    /must be exactly 46 characters/,
    'a truncated bootstrap (a dropped tail from a bad copy/paste) must be flagged',
  );
  assert.match(
    coordinationBootstrapTokenShapeIssue(`${real}x`) ?? '',
    /must be exactly 46 characters/,
    'a bootstrap with a stray trailing character must be flagged',
  );
  assert.match(
    coordinationBootstrapTokenShapeIssue(`cb_${'='.repeat(43)}`) ?? '',
    /must contain only letters, digits/,
    'a correctly-sized token with invalid characters must be flagged distinctly from a length problem',
  );
  assert.equal(coordinationBootstrapTokenShapeIssue(real), undefined, 'sanity check: the unmodified real token must still pass');
});

test('actor clients reject a locally malformed bootstrap token before making any HTTP call', async () => {
  const malformedTokens: Array<{ label: string; value: string; expected: RegExp }> = [
    { label: 'wrong prefix', value: `ct_${'r'.repeat(43)}`, expected: /must start with "cb_"/ },
    { label: 'truncated', value: 'cb_tooShort', expected: /must be exactly 46 characters/ },
    { label: 'padded with a stray trailing character', value: `${VALID_BOOTSTRAP_TOKEN}x`, expected: /must be exactly 46 characters/ },
  ];
  for (const { label, value, expected } of malformedTokens) {
    let fetchCalls = 0;
    const client = createCoordinationActorClient('luca-replit', {
      apiUrl: 'https://coordination.example',
      environment: {
        COORDINATION_RUNTIME_ID: 'luca-replit-primary',
        COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: value,
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('must not reach the network for a locally malformed bootstrap token');
      },
    });

    await assert.rejects(() => client.listFeed(), expected, `expected a clear local error for: ${label}`);
    assert.equal(fetchCalls, 0, `must not make any HTTP call for a locally malformed bootstrap token (${label})`);
  }
});

test('actor clients coalesce concurrent near-expiry renewal into one request', async () => {
  let renewalCount = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      return new Response(JSON.stringify({
        accessToken: 'ct_near-expiry',
        actor: 'luca-replit',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }), { status: 201 });
    }
    if (url.endsWith('/api/coordination/credentials/renew')) {
      renewalCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        accessToken: 'ct_renewed-once',
        actor: 'luca-replit',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'luca-replit-primary',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl,
  });

  await client.listFeed();
  await Promise.all([client.listFeed(), client.listFeed(), client.listFeed()]);

  assert.equal(renewalCount, 1);
});

test('a second CLI-style client instance reuses a cached credential instead of exchanging the bootstrap again', async () => {
  const store = new FakeCredentialCacheStore();
  let exchangeCalls = 0;
  let listCalls = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      exchangeCalls += 1;
      return new Response(JSON.stringify({
        accessToken: 'ct_first-invocation-token',
        actor: 'luca-claude-code',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 201 });
    }
    listCalls += 1;
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const environment = {
    COORDINATION_RUNTIME_ID: 'luca-claude-code-session',
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
  };

  // First "invocation": nothing cached yet, so it must exchange the bootstrap.
  const first = createCoordinationActorClient('luca-claude-code', {
    apiUrl: 'https://coordination.example',
    environment,
    fetchImpl,
    credentialCache: store.asCache(),
  });
  await first.listFeed();
  assert.equal(exchangeCalls, 1);
  assert.equal(listCalls, 1);
  assert.equal(store.saveCalls.length, 1);
  assert.equal(store.saveCalls[0]?.accessToken, 'ct_first-invocation-token');

  // Second "invocation": a brand-new client instance -- standing in for a
  // fresh CLI process -- sharing only the persisted cache, never the first
  // instance's in-memory state.
  const second = createCoordinationActorClient('luca-claude-code', {
    apiUrl: 'https://coordination.example',
    environment,
    fetchImpl,
    credentialCache: store.asCache(),
  });
  await second.listFeed();

  // The whole point of the cache: no second bootstrap exchange.
  assert.equal(exchangeCalls, 1);
  assert.equal(listCalls, 2);
});

test('an expired cached credential is discarded, never presented to the API, and triggers a fresh bootstrap exchange', async () => {
  const store = new FakeCredentialCacheStore();
  store.seed({
    actor: 'luca-claude-code',
    runtimeId: 'luca-claude-code-session',
    accessToken: 'ct_stale-token-must-never-be-sent',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const observedTokens: Array<string | null> = [];
  let exchangeCalls = 0;
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      exchangeCalls += 1;
      return new Response(JSON.stringify({
        accessToken: 'ct_fresh-token',
        actor: 'luca-claude-code',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 201 });
    }
    observedTokens.push(new Headers(init?.headers).get('x-coordination-token'));
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-claude-code', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'luca-claude-code-session',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl,
    credentialCache: store.asCache(),
  });

  await client.listFeed();

  assert.equal(exchangeCalls, 1);
  assert.deepEqual(observedTokens, ['ct_fresh-token']);
});

test('a credential cache never hands one runtime ID cached credential to a client configured for a different runtime ID', async () => {
  const store = new FakeCredentialCacheStore();
  store.seed({
    actor: 'luca-claude-code',
    runtimeId: 'luca-claude-code-runtime-a',
    accessToken: 'ct_runtime-a-token',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  let exchangeCalls = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      exchangeCalls += 1;
      return new Response(JSON.stringify({
        accessToken: 'ct_runtime-b-token',
        actor: 'luca-claude-code',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-claude-code', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'luca-claude-code-runtime-b',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl,
    credentialCache: store.asCache(),
  });

  await client.listFeed();

  // Runtime B must never receive runtime A's cached token, even though both
  // share the same actor and the same cache backing store.
  assert.equal(exchangeCalls, 1);
  assert.deepEqual(store.loadCalls, [{ actor: 'luca-claude-code', runtimeId: 'luca-claude-code-runtime-b' }]);
});

test('a credential cache never hands one actor cached credential to a client configured for a different actor', async () => {
  const store = new FakeCredentialCacheStore();
  store.seed({
    actor: 'luca-replit',
    runtimeId: 'shared-runtime-id',
    accessToken: 'ct_luca-replit-token',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  let exchangeCalls = 0;
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/coordination/credentials/exchange')) {
      exchangeCalls += 1;
      return new Response(JSON.stringify({
        accessToken: 'ct_luca-claude-code-token',
        actor: 'luca-claude-code',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ threads: [] }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-claude-code', {
    apiUrl: 'https://coordination.example',
    environment: {
      COORDINATION_RUNTIME_ID: 'shared-runtime-id',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    },
    fetchImpl,
    credentialCache: store.asCache(),
  });

  await client.listFeed();

  // luca-claude-code must never receive luca-replit's cached token, even
  // though both share the same runtime ID and the same cache backing store.
  assert.equal(exchangeCalls, 1);
  assert.deepEqual(store.loadCalls, [{ actor: 'luca-claude-code', runtimeId: 'shared-runtime-id' }]);
});

test('actor clients acknowledge feed progress through the non-lifecycle cursor endpoint', async () => {
  const observed: Array<{ url: string; method: string | undefined; body: string | null }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    observed.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response(JSON.stringify({
      actor: 'alden',
      acknowledgedGlobalSequence: 42,
    }), { status: 200 });
  };
  const client = createCoordinationActorClient('alden', {
    apiUrl: 'https://coordination.example',
    environment: ENVIRONMENT,
    fetchImpl,
  });

  await client.acknowledgeFeed(42);

  assert.deepEqual(observed, [{
    url: 'https://coordination.example/api/coordination/threads/ack',
    method: 'POST',
    body: JSON.stringify({ globalSequence: 42 }),
  }]);
  assert.equal(coordinationClientActions('alden').has('acknowledge-feed'), true);
  assert.throws(
    () => client.acknowledgeFeed(-1),
    /must be a non-negative integer/,
  );
});

test('Luca clients preserve causal links and use the combined linked-outcome endpoint', async () => {
  const observed: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    observed.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      key: headers.get('idempotency-key'),
    });
    return new Response(JSON.stringify({ achievedState: 'completed' }), { status: 200 });
  };
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://coordination.example',
    environment: ENVIRONMENT,
    fetchImpl,
  });

  await client.progress('thread-1', {
    content: 'Progress with a causal parent.',
    expectedSequence: 3,
    idempotencyKey: 'test-progress-causal',
    causalParentEventId: 'event-2',
  });
  await client.completeWithLinkedOutcome('thread-1', {
    content: 'Completed with a direct reply.',
    expectedSequence: 4,
    idempotencyKey: 'test-linked-completion',
    causalParentEventId: 'event-3',
    reply: { body: 'Outcome delivered.' },
  });

  assert.equal(observed[0].body.causalParentEventId, 'event-2');
  assert.equal(
    observed[1].url,
    'https://coordination.example/api/coordination/threads/thread-1/complete-with-linked-outcome',
  );
  assert.equal(observed[1].key, 'test-linked-completion');
  assert.deepEqual(observed[1].body, {
    content: 'Completed with a direct reply.',
    expectedSequence: 4,
    causalParentEventId: 'event-3',
    reply: { body: 'Outcome delivered.' },
  });
});

test('direct clients and server enforce the same least-privilege lifecycle profiles', async () => {
  const noRequest = async (): Promise<Response> => {
    assert.fail('disallowed client action must fail before making a request');
  };

  const hola = createCoordinationActorClient('luca-holahola', {
    apiUrl: 'https://coordination.example',
    environment: ENVIRONMENT,
    fetchImpl: noRequest,
  });
  await assert.rejects(
    hola.complete('thread-1', {
      expectedSequence: 2,
      idempotencyKey: 'test-hola-complete',
    }),
    /cannot perform complete/,
  );

  const alden = createCoordinationActorClient('alden', {
    apiUrl: 'https://coordination.example',
    environment: ENVIRONMENT,
    fetchImpl: noRequest,
  });
  // Alden originates threads directly (task 1450 — he must be able to reach Luca
  // without waiting to be addressed first), so `create` is no longer a forbidden
  // action for him. `reopen` remains outside his lifecycle profile and stands in
  // as the still-restricted action this test exercises.
  await assert.rejects(
    alden.reopen('thread-1', {
      expectedSequence: 2,
      idempotencyKey: 'test-alden-reopen',
    }),
    /cannot perform reopen/,
  );

  const daniela = createCoordinationActorClient('daniela', {
    apiUrl: 'https://coordination.example',
    environment: ENVIRONMENT,
    fetchImpl: noRequest,
  });
  await assert.rejects(
    daniela.reassign('thread-1', {
      expectedSequence: 2,
      idempotencyKey: 'test-daniela-reassign',
      recipientActor: 'alden',
    }),
    /cannot perform reassign/,
  );

  assert.equal(coordinationClientActions('luca-holahola').has('create'), true);
  assert.equal(coordinationClientActions('luca-holahola').has('complete'), false);
  assert.equal(coordinationClientActions('alden').has('create'), true);
  assert.equal(coordinationClientActions('alden').has('reopen'), false);
  assert.equal(coordinationClientActions('daniela').has('create'), false);
  assert.equal(canCoordinationActorPerform('luca-holahola', 'reassigned'), true);
  assert.equal(canCoordinationActorPerform('luca-holahola', 'completed'), false);
  assert.equal(canCoordinationActorPerform('alden', 'reassigned'), true);
  assert.equal(canCoordinationActorPerform('daniela', 'reassigned'), false);
});

test('Cursor, OpenAI Agents, and Codex use independent credentials and the generic Luca lifecycle client', async () => {
  const seen: Array<{ token: string | null; url: string }> = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    seen.push({
      token: new Headers(init?.headers).get('x-coordination-token'),
      url: String(input),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  for (const actor of ['luca-cursor', 'luca-openai-agents', 'luca-codex'] as const) {
    const client = createCoordinationActorClient(actor, {
      apiUrl: 'https://coordination.example',
      environment: ENVIRONMENT,
      fetchImpl,
    });
    await client.listFeed();
    await client.complete('thread-1', { expectedSequence: 1, idempotencyKey: `${actor}:complete` });
  }

  assert.deepEqual(seen.map((request) => request.token), [
    TOKENS['luca-cursor'], TOKENS['luca-cursor'],
    TOKENS['luca-openai-agents'], TOKENS['luca-openai-agents'],
    TOKENS['luca-codex'], TOKENS['luca-codex'],
  ]);
  assert.equal(seen[0].url, 'https://coordination.example/api/coordination/threads');
  assert.equal(seen[1].url, 'https://coordination.example/api/coordination/threads/thread-1/events');
  assert.equal(seen[2].url, 'https://coordination.example/api/coordination/threads');
  assert.equal(seen[3].url, 'https://coordination.example/api/coordination/threads/thread-1/events');
  assert.equal(seen[4].url, 'https://coordination.example/api/coordination/threads');
  assert.equal(seen[5].url, 'https://coordination.example/api/coordination/threads/thread-1/events');
});

test('coordination CLI exposes every non-system actor as both a caller and recipient', () => {
  assert.deepEqual([...SUPPORTED_COORDINATION_CLI_ACTORS].sort(), Object.keys(TOKENS).sort());
  assert.deepEqual([...SUPPORTED_COORDINATION_CLI_RECIPIENTS].sort(), Object.keys(TOKENS).sort());
});

test('CLI rejects obsolete or irrelevant options instead of silently dropping them', () => {
  assert.deepEqual(
    unsupportedCoordinationCliOptions('list', { cursor: '0', limit: '20' }),
    [],
  );
  assert.deepEqual(
    unsupportedCoordinationCliOptions('list', { owner: 'alden', state: 'accepted' }),
    ['owner', 'state'],
  );
  assert.deepEqual(
    unsupportedCoordinationCliOptions('show', { id: 'thread-1', 'after-sequence': '3' }),
    [],
  );
  assert.deepEqual(
    unsupportedCoordinationCliOptions('complete', {
      id: 'thread-1',
      'expected-sequence': '3',
      'idempotency-key': 'complete-key',
      'causal-parent-event-id': 'event-2',
    }),
    [],
  );
  assert.deepEqual(
    unsupportedCoordinationCliOptions('accept', {
      id: 'thread-1',
      recipient: 'daniela',
    }),
    ['recipient'],
  );
});

async function withTokenCacheDir(
  run: (cachePath: string) => Promise<void>,
): Promise<void> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'coordination-token-cache-'));
  try {
    await run(join(cacheDir, 'token.json'));
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

test('a client persists a broker-issued token to disk so a restarted process recovers it without re-exchanging the bootstrap', async () => {
  await withTokenCacheDir(async (cachePath) => {
    const exchangeCalls: string[] = [];
    const environment = {
      COORDINATION_RUNTIME_ID: 'luca-replit-primary',
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
    };
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/coordination/credentials/exchange')) {
        exchangeCalls.push(url);
        return new Response(JSON.stringify({
          accessToken: 'ct_persisted-token',
          actor: 'luca-replit',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    };

    const firstProcess = createCoordinationActorClient('luca-replit', {
      apiUrl: 'https://coordination.example',
      environment,
      fetchImpl,
      tokenCachePath: cachePath,
    });
    await firstProcess.listFeed();
    assert.equal(exchangeCalls.length, 1, 'the first process must exchange its bootstrap exactly once');

    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
    assert.equal(cached.broker, true);
    assert.equal(cached.actor, 'luca-replit');
    assert.equal(cached.runtimeId, 'luca-replit-primary');
    assert.equal(cached.token, 'ct_persisted-token');

    // Simulate a restart: a brand new client instance (fresh in-memory state)
    // pointed at the same cache file.
    const restartedProcess = createCoordinationActorClient('luca-replit', {
      apiUrl: 'https://coordination.example',
      environment,
      fetchImpl,
      tokenCachePath: cachePath,
    });
    await restartedProcess.listFeed();
    assert.equal(
      exchangeCalls.length,
      1,
      'a restarted client must recover the cached token instead of re-exchanging the already-consumed bootstrap',
    );
  });
});

test('a client ignores a cache entry that does not match this runtime, actor, or is expired or unparsable', async () => {
  const environment = {
    COORDINATION_RUNTIME_ID: 'luca-replit-primary',
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
  };
  const validCachedEntry = {
    runtimeId: 'luca-replit-primary',
    actor: 'luca-replit',
    token: 'ct_should-be-ignored',
    expiresAt: null,
    broker: true,
  };
  const invalidCacheVariants: Array<{ label: string; contents: string }> = [
    { label: 'wrong runtimeId', contents: JSON.stringify({ ...validCachedEntry, runtimeId: 'some-other-runtime' }) },
    { label: 'wrong actor', contents: JSON.stringify({ ...validCachedEntry, actor: 'luca-claude-code' }) },
    { label: 'already expired', contents: JSON.stringify({ ...validCachedEntry, expiresAt: Date.now() - 1_000 }) },
    { label: 'legacy static token (broker: false)', contents: JSON.stringify({ ...validCachedEntry, broker: false }) },
    { label: 'not JSON', contents: 'not valid json {{{' },
    { label: 'empty token', contents: JSON.stringify({ ...validCachedEntry, token: '' }) },
  ];

  for (const variant of invalidCacheVariants) {
    await withTokenCacheDir(async (cachePath) => {
      await writeFile(cachePath, variant.contents, 'utf8');
      const exchangeCalls: string[] = [];
      const fetchImpl = async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/api/coordination/credentials/exchange')) {
          exchangeCalls.push(url);
          return new Response(JSON.stringify({
            accessToken: 'ct_freshly-exchanged',
            actor: 'luca-replit',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          }), { status: 201 });
        }
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      };
      const client = createCoordinationActorClient('luca-replit', {
        apiUrl: 'https://coordination.example',
        environment,
        fetchImpl,
        tokenCachePath: cachePath,
      });

      await client.listFeed();
      assert.equal(
        exchangeCalls.length,
        1,
        `client must fall back to exchanging a fresh bootstrap when the cache entry is invalid (${variant.label})`,
      );
    });
  }
});

test('a client without a configured cache path behaves exactly as before (in-memory only, no file written)', async () => {
  await withTokenCacheDir(async (cachePath) => {
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/coordination/credentials/exchange')) {
        return new Response(JSON.stringify({
          accessToken: 'ct_never-persisted',
          actor: 'luca-replit',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    };
    const client = createCoordinationActorClient('luca-replit', {
      apiUrl: 'https://coordination.example',
      environment: {
        COORDINATION_RUNTIME_ID: 'luca-replit-primary',
        COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
      },
      fetchImpl,
      // tokenCachePath intentionally omitted, and COORDINATION_RUNTIME_TOKEN_CACHE_PATH is
      // not part of this environment object, so the client falls back to process.env for it.
      // Passing a plain environment object without that key keeps caching opted out.
    });

    await client.listFeed();
    await assert.rejects(readFile(cachePath, 'utf8'), /ENOENT/, 'no cache file must be written when tokenCachePath is not configured');
  });
});

test('renewing a credential updates the on-disk cache, not just the in-memory copy', async () => {
  await withTokenCacheDir(async (cachePath) => {
    let renewalCount = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/coordination/credentials/exchange')) {
        return new Response(JSON.stringify({
          accessToken: 'ct_near-expiry',
          actor: 'luca-replit',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }), { status: 201 });
      }
      if (url.endsWith('/api/coordination/credentials/renew')) {
        renewalCount += 1;
        return new Response(JSON.stringify({
          accessToken: 'ct_renewed-and-persisted',
          actor: 'luca-replit',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    };
    const client = createCoordinationActorClient('luca-replit', {
      apiUrl: 'https://coordination.example',
      environment: {
        COORDINATION_RUNTIME_ID: 'luca-replit-primary',
        COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: VALID_BOOTSTRAP_TOKEN,
      },
      fetchImpl,
      tokenCachePath: cachePath,
    });

    await client.listFeed();
    assert.equal((JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>).token, 'ct_near-expiry');

    // The cached credential expires in 30s, under the 60s renewal threshold,
    // so this second call triggers renewal before making its request.
    await client.listFeed();
    assert.equal(renewalCount, 1);
    assert.equal(
      (JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>).token,
      'ct_renewed-and-persisted',
      'the cache file must reflect the renewed token so a later restart never recovers a token already rotated away',
    );
  });
});