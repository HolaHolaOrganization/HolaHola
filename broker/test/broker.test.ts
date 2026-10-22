import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { canonicalJson } from '../src/canonical.ts';
import { decide } from '../src/authorize.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL, verifySignedRequest } from '../src/envelope.ts';
import { gitBlobSha, parsePolicy, PolicyError, PolicyLoader, REPOSITORY_ID, type PolicySource } from '../src/policy.ts';
import { createBrokerServer } from '../src/server.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);

function keypair(type: 'ed25519' | 'ec' = 'ed25519'): { privateKey: KeyObject; publicPem: string } {
  const pair = type === 'ec'
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const lcc = keypair();
const lr = keypair();

function policyJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    state: 'closed',
    repositoryId: REPOSITORY_ID,
    actors: {
      'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: lcc.publicPem }] },
      'luca-replit': { appId: 5361771, installationId: 172514434, host: 'replit', signingKeys: [{ id: 'lr-1', publicKeyPem: lr.publicPem }] },
    },
    qualification: [],
    ...overrides,
  };
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
}

function loaderFor(value: unknown, now: () => number = () => NOW): PolicyLoader {
  const bytes = bytesOf(value);
  return new PolicyLoader({ fetch: async () => ({ bytes, blobSha: gitBlobSha(bytes) }) }, now);
}

function signedRequest(
  epoch: string,
  overrides: Partial<Envelope> = {},
  payload: unknown = { body: 'hello' },
  key: KeyObject = lcc.privateKey,
): Record<string, unknown> {
  const envelope: Envelope = {
    audience: AUDIENCE,
    protocol: PROTOCOL,
    repositoryId: REPOSITORY_ID,
    actor: 'luca-claude-code',
    keyId: 'lcc-1',
    operation: 'pr.comment',
    pr: 48,
    headSha: HEAD,
    payloadSha256: payloadDigest(payload),
    policyEpoch: epoch,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    operationId: 'op-0123456789abcdef',
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), key).toString('base64');
  return { envelope, signature, payload };
}

describe('canonical JSON', () => {
  test('sorts keys at every depth and drops whitespace', () => {
    assert.equal(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[2,{"c":null,"d":1}]}');
  });
  test('rejects floats, undefined, and non-plain objects', () => {
    assert.throws(() => canonicalJson({ a: 1.5 }));
    assert.throws(() => canonicalJson({ a: undefined }));
    assert.throws(() => canonicalJson(new Date(0)));
  });
});

describe('policy', () => {
  test('parses a valid policy and sets epoch to the git blob sha', () => {
    const bytes = bytesOf(policyJson());
    const policy = parsePolicy(bytes);
    assert.equal(policy.state, 'closed');
    assert.equal(policy.actors.size, 2);
    assert.equal(policy.epoch, gitBlobSha(bytes));
  });

  test('git blob sha matches git hash-object for a known input', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    assert.equal(gitBlobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['unknown root field', { extra: true }],
    ['unknown state', { state: 'open' }],
    ['wrong repository', { repositoryId: 1 }],
    ['wrong version', { version: 2 }],
    ['actors not an object', { actors: [] }],
    ['qualification entries outside qualification', { qualification: [{ pr: 1, headSha: HEAD }] }],
    ['non-Ed25519 key', { actors: { 'luca-claude-code': { appId: 1, installationId: 2, host: 'h', signingKeys: [{ id: 'k', publicKeyPem: keypair('ec').publicPem }] } } }],
    ['empty signing keys', { actors: { 'luca-claude-code': { appId: 1, installationId: 2, host: 'h', signingKeys: [] } } }],
    ['shared installation id', { actors: {
      a1: { appId: 1, installationId: 2, host: 'h', signingKeys: [{ id: 'k', publicKeyPem: lcc.publicPem }] },
      a2: { appId: 3, installationId: 2, host: 'h', signingKeys: [{ id: 'k', publicKeyPem: lr.publicPem }] },
    } }],
    ['unknown actor field', { actors: { 'luca-claude-code': { appId: 1, installationId: 2, host: 'h', role: 'admin', signingKeys: [{ id: 'k', publicKeyPem: lcc.publicPem }] } } }],
  ];
  for (const [name, overrides] of invalid) {
    test(`rejects: ${name}`, () => {
      assert.throws(() => parsePolicy(bytesOf(policyJson(overrides))), PolicyError);
    });
  }

  test('rejects non-JSON and invalid UTF-8', () => {
    assert.throws(() => parsePolicy(new TextEncoder().encode('not json')), PolicyError);
    assert.throws(() => parsePolicy(new Uint8Array([0x7b, 0xff, 0x7d])), PolicyError);
  });
});

describe('policy loader (fail closed, TTL <= 60 s)', () => {
  test('refuses a TTL above 60 s', () => {
    assert.throws(() => new PolicyLoader({ fetch: async () => { throw new Error(); } }, Date.now, 60_001));
  });

  test('caches within the TTL and refetches after it', async () => {
    let clock = NOW;
    let fetches = 0;
    const bytes = bytesOf(policyJson());
    const source: PolicySource = { fetch: async () => { fetches += 1; return { bytes, blobSha: gitBlobSha(bytes) }; } };
    const loader = new PolicyLoader(source, () => clock);
    await loader.current();
    clock += 59_999;
    await loader.current();
    assert.equal(fetches, 1);
    clock += 1;
    await loader.current();
    assert.equal(fetches, 2);
  });

  test('has no stale fallback: a failed refetch after expiry yields no policy', async () => {
    let clock = NOW;
    let broken = false;
    const bytes = bytesOf(policyJson());
    const loader = new PolicyLoader({ fetch: async () => { if (broken) throw new Error('down'); return { bytes, blobSha: gitBlobSha(bytes) }; } }, () => clock);
    assert.ok(await loader.current());
    broken = true;
    clock += 60_000;
    assert.equal(await loader.current(), null);
  });

  test('rejects bytes whose blob sha does not match the claimed one', async () => {
    const bytes = bytesOf(policyJson());
    const loader = new PolicyLoader({ fetch: async () => ({ bytes, blobSha: 'b'.repeat(40) }) }, () => NOW);
    assert.equal(await loader.current(), null);
  });

  test('an invalid file yields no policy', async () => {
    assert.equal(await loaderFor(policyJson({ state: 'open' })).current(), null);
  });

  test('logs a secret-free reason once per change, naming a refused redirect', async () => {
    let clock = NOW;
    let mode: 'redirect' | 'status' | 'ok' = 'redirect';
    const bytes = bytesOf(policyJson());
    const lines: string[] = [];
    const loader = new PolicyLoader({
      fetch: async () => {
        if (mode === 'redirect') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
        if (mode === 'status') throw Object.assign(new Error('x'), { status: 404, path: '/repos/o/r/contents/broker/policy.json' });
        return { bytes, blobSha: gitBlobSha(bytes) };
      },
    }, () => clock, 60_000, (line) => lines.push(line));
    assert.equal(await loader.current(), null);
    clock += 60_000;
    assert.equal(await loader.current(), null);
    assert.equal(lines.length, 1, 'the same reason is logged once');
    assert.match(lines[0], /redirect.*BROKER_MAIN_REPO_OWNER/);
    mode = 'status';
    clock += 60_000;
    await loader.current();
    assert.match(lines[1], /returned 404$/);
    mode = 'ok';
    clock += 60_000;
    assert.ok(await loader.current());
    assert.equal(lines[2], 'broker: policy available again');
    assert.ok(lines.every((l) => !/Bearer|token/i.test(l)));
  });
});

describe('policy loader races (luca-replit review 5566308774)', () => {
  type Snapshot = { bytes: Uint8Array; blobSha: string };
  function deferred(): { resolve: (value: Snapshot) => void; promise: Promise<Snapshot> } {
    let resolve!: (value: Snapshot) => void;
    const promise = new Promise<Snapshot>((r) => { resolve = r; });
    return { resolve, promise };
  }
  function snapshot(value: unknown): Snapshot {
    const bytes = bytesOf(value);
    return { bytes, blobSha: gitBlobSha(bytes) };
  }

  test('a fetch that resolves after the TTL is discarded, never returned as current', async () => {
    let clock = NOW;
    const pending = deferred();
    const loader = new PolicyLoader({ fetch: () => pending.promise }, () => clock);
    const result = loader.current();
    clock += 120_000;
    pending.resolve(snapshot(policyJson({ state: 'routine' })));
    assert.equal(await result, null);
  });

  test('concurrent callers share one in-flight fetch', async () => {
    let fetches = 0;
    const pending = deferred();
    const loader = new PolicyLoader({ fetch: () => { fetches += 1; return pending.promise; } }, () => NOW);
    const both = Promise.all([loader.current(), loader.current()]);
    pending.resolve(snapshot(policyJson()));
    const [one, two] = await both;
    assert.equal(fetches, 1);
    assert.equal(one?.state, 'closed');
    assert.equal(two?.state, 'closed');
  });

  test('a late older result can never overwrite a newer one', async () => {
    let clock = NOW;
    const older = deferred();
    const newer = deferred();
    const queue = [older, newer];
    const loader = new PolicyLoader({ fetch: () => queue.shift()!.promise }, () => clock);
    const first = loader.current();
    clock += 60_000; // the first fetch is now past the bound, so the next call supersedes it
    const second = loader.current();
    newer.resolve(snapshot(policyJson({ state: 'closed' })));
    assert.equal((await second)?.state, 'closed');
    older.resolve(snapshot(policyJson({ state: 'routine' })));
    assert.equal(await first, null);
    assert.equal((await loader.current())?.state, 'closed');
  });

  test('a superseded fetch resolving late does not clear the newer in-flight fetch', async () => {
    let clock = NOW;
    let fetches = 0;
    const older = deferred();
    const newer = deferred();
    const queue = [older, newer];
    const loader = new PolicyLoader({ fetch: () => { fetches += 1; return queue.shift()!.promise; } }, () => clock);
    const first = loader.current();
    clock += 60_000;
    const second = loader.current();
    older.resolve(snapshot(policyJson({ state: 'routine' })));
    assert.equal(await first, null);
    const third = loader.current(); // must join the newer fetch, not start another
    assert.equal(fetches, 2);
    newer.resolve(snapshot(policyJson({ state: 'closed' })));
    assert.equal((await second)?.state, 'closed');
    assert.equal((await third)?.state, 'closed');
  });

  test('cache age counts from fetch start, so a slow in-bound fetch does not extend freshness', async () => {
    let clock = NOW;
    let fetches = 0;
    const loader = new PolicyLoader({ fetch: async () => { fetches += 1; clock += 40_000; return snapshot(policyJson()); } }, () => clock);
    assert.ok(await loader.current()); // started at NOW, resolved at NOW + 40 s
    clock = NOW + 60_000;
    await loader.current();
    assert.equal(fetches, 2, 'the cached entry expires 60 s after its fetch started');
  });

  test('decide reads the clock after the policy load, so a request that expires during it is denied', async () => {
    let clock = NOW;
    const bytes = bytesOf(policyJson());
    const loader = new PolicyLoader({ fetch: async () => { clock += 31_000; return { bytes, blobSha: gitBlobSha(bytes) }; } }, () => clock);
    const result = await decide(signedRequest(gitBlobSha(bytes)), () => loader, () => clock);
    assert.deepEqual(result, { decision: 'deny', reason: 'expired' });
  });
});

describe('envelope verification', () => {
  const policy = parsePolicy(bytesOf(policyJson()));
  const epoch = policy.epoch;

  test('accepts a correctly signed request and returns the canonical envelope digest', () => {
    const result = verifySignedRequest(signedRequest(epoch), policy, NOW);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.digest, /^[0-9a-f]{64}$/);
  });

  const cases: Array<[string, () => Record<string, unknown>, string]> = [
    ['wrong audience', () => signedRequest(epoch, { audience: 'other/v1' }), 'wrong_audience'],
    ['wrong protocol', () => signedRequest(epoch, { protocol: 2 }), 'wrong_protocol'],
    ['wrong repository', () => signedRequest(epoch, { repositoryId: 1 }), 'wrong_repository'],
    ['unknown actor', () => signedRequest(epoch, { actor: 'mallory' }), 'unknown_actor'],
    ['unknown key id', () => signedRequest(epoch, { keyId: 'lcc-2' }), 'unknown_key'],
    // A caller-asserted actor: LR's name, LCC's key.
    ['actor claimed with another hat\'s key', () => signedRequest(epoch, { actor: 'luca-replit', keyId: 'lr-1' }), 'bad_signature'],
    ['expired', () => signedRequest(epoch, { issuedAt: NOW - 40_000, expiresAt: NOW }), 'expired'],
    ['not yet valid', () => signedRequest(epoch, { issuedAt: NOW + 6_000, expiresAt: NOW + 20_000 }), 'not_yet_valid'],
    ['validity window over 60 s', () => signedRequest(epoch, { issuedAt: NOW - 1_000, expiresAt: NOW + 60_000 }), 'validity_too_long'],
    ['stale policy epoch', () => signedRequest('c'.repeat(40)), 'stale_policy_epoch'],
    ['unknown operation', () => signedRequest(epoch, { operation: 'exec' as Envelope['operation'] }), 'malformed'],
  ];
  for (const [name, build, reason] of cases) {
    test(`rejects: ${name}`, () => {
      const result = verifySignedRequest(build(), policy, NOW);
      assert.deepEqual(result, { ok: false, reason });
    });
  }

  test('rejects a tampered envelope field after signing', () => {
    const request = signedRequest(epoch) as { envelope: Envelope };
    request.envelope.pr = 49;
    assert.deepEqual(verifySignedRequest(request, policy, NOW), { ok: false, reason: 'bad_signature' });
  });

  test('rejects a tampered head sha after signing', () => {
    const request = signedRequest(epoch) as { envelope: Envelope };
    request.envelope.headSha = 'f'.repeat(40);
    assert.deepEqual(verifySignedRequest(request, policy, NOW), { ok: false, reason: 'bad_signature' });
  });

  test('rejects a payload swapped after signing', () => {
    const request = signedRequest(epoch) as { payload: unknown };
    request.payload = { body: 'something else' };
    assert.deepEqual(verifySignedRequest(request, policy, NOW), { ok: false, reason: 'payload_mismatch' });
  });

  test('rejects extra or missing envelope fields and extra top-level fields', () => {
    const extra = signedRequest(epoch) as { envelope: Record<string, unknown> };
    extra.envelope.role = 'founder';
    assert.deepEqual(verifySignedRequest(extra, policy, NOW), { ok: false, reason: 'malformed' });
    const missing = signedRequest(epoch) as { envelope: Record<string, unknown> };
    delete missing.envelope.operationId;
    assert.deepEqual(verifySignedRequest(missing, policy, NOW), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifySignedRequest({ ...signedRequest(epoch), actor: 'x' }, policy, NOW), { ok: false, reason: 'malformed' });
  });

  test('a policy change invalidates outstanding signed requests', () => {
    const request = signedRequest(epoch);
    const changed = parsePolicy(bytesOf(policyJson({ state: 'routine' })));
    assert.notEqual(changed.epoch, epoch);
    assert.deepEqual(verifySignedRequest(request, changed, NOW), { ok: false, reason: 'stale_policy_epoch' });
  });
});

describe('decision', () => {
  test('no policy denies everything', async () => {
    const loader = new PolicyLoader({ fetch: async () => { throw new Error('down'); } }, () => NOW);
    assert.deepEqual(await decide(signedRequest('c'.repeat(40)), () => loader, () => NOW), { decision: 'deny', reason: 'no_policy' });
  });

  test('a malformed body or an actor with no configured loader is denied before any policy read', async () => {
    let reads = 0;
    const loader = new PolicyLoader({ fetch: async () => { reads += 1; throw new Error('unused'); } }, () => NOW);
    assert.deepEqual(await decide({}, () => loader, () => NOW), { decision: 'deny', reason: 'malformed' });
    assert.deepEqual(await decide(signedRequest('c'.repeat(40)), () => undefined, () => NOW), { decision: 'deny', reason: 'unknown_actor' });
    assert.equal(reads, 0);
  });

  test('closed denies a valid signed request', async () => {
    const loader = loaderFor(policyJson());
    const epoch = (await loader.current())!.epoch;
    assert.deepEqual(await decide(signedRequest(epoch), () => loader, () => NOW), { decision: 'deny', reason: 'policy_closed', operationId: 'op-0123456789abcdef' });
  });

  test('routine allows a verified request and returns the verified envelope', async () => {
    const loader = loaderFor(policyJson({ state: 'routine' }));
    const epoch = (await loader.current())!.epoch;
    const result = await decide(signedRequest(epoch), () => loader, () => NOW);
    assert.equal(result.decision, 'allow');
    assert.equal(result.decision === 'allow' && result.authorized.envelope.pr, 48);
  });

  test('qualification allows only the exact listed (PR, head), never unlisted or PR-less operations', async () => {
    const listed = loaderFor(policyJson({ state: 'qualification', qualification: [{ pr: 48, headSha: HEAD }] }));
    const epoch = (await listed.current())!.epoch;
    assert.equal((await decide(signedRequest(epoch), () => listed, () => NOW)).decision, 'allow');
    for (const overrides of [{ pr: 49 }, { headSha: 'b'.repeat(40) }, { pr: null, operation: 'pr.open' as const }]) {
      const result = await decide(signedRequest(epoch, overrides), () => listed, () => NOW);
      assert.deepEqual(result, { decision: 'deny', reason: 'not_qualified', operationId: 'op-0123456789abcdef' });
    }
  });

  test('branch.delete is denied in every state (no compare-and-delete exists)', async () => {
    const loader = loaderFor(policyJson({ state: 'routine' }));
    const epoch = (await loader.current())!.epoch;
    const result = await decide(signedRequest(epoch, { operation: 'branch.delete' }), () => loader, () => NOW);
    assert.deepEqual(result, { decision: 'deny', reason: 'not_implemented', operationId: 'op-0123456789abcdef' });
  });
});

describe('http server', () => {
  async function withServer(loader: PolicyLoader, run: (base: string) => Promise<void>): Promise<void> {
    const server = createBrokerServer({ loaderFor: () => loader, healthLoader: loader, now: () => NOW });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('healthz reports state and epoch, or 503 without a policy', async () => {
    const loader = loaderFor(policyJson());
    const epoch = (await loader.current())!.epoch;
    await withServer(loader, async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, state: 'closed', epoch });
    });
    await withServer(new PolicyLoader({ fetch: async () => { throw new Error(); } }, () => NOW), async (base) => {
      assert.equal((await fetch(`${base}/healthz`)).status, 503);
    });
  });

  test('operations: closed policy returns 403 deny', async () => {
    const loader = loaderFor(policyJson());
    const epoch = (await loader.current())!.epoch;
    await withServer(loader, async (base) => {
      const res = await fetch(`${base}/v1/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedRequest(epoch)) });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { decision: 'deny', reason: 'policy_closed', operationId: 'op-0123456789abcdef' });
    });
  });

  test('rejects wrong method, media type, oversized and non-JSON bodies, and unknown routes', async () => {
    await withServer(loaderFor(policyJson()), async (base) => {
      assert.equal((await fetch(`${base}/v1/operations`)).status, 405);
      assert.equal((await fetch(`${base}/v1/operations`, { method: 'POST', body: '{}' , headers: { 'content-type': 'text/plain' } })).status, 415);
      assert.equal((await fetch(`${base}/v1/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(64 * 1024 + 1) })).status, 413);
      assert.equal((await fetch(`${base}/v1/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
      assert.equal((await fetch(`${base}/admin`)).status, 404);
    });
  });
});

describe('isolation from the web app', () => {
  test('broker source imports only node: builtins and sibling broker modules', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../src/', import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
    assert.ok(files.length >= 5);
    for (const name of files) {
      const source = readFileSync(new URL(name, dir), 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? match[2];
        assert.ok(specifier.startsWith('node:') || /^\.\/[a-z-]+\.ts$/.test(specifier), `${name} imports ${specifier}`);
      }
      // Erasable syntax only, so the source can run under Node type stripping:
      // no enums, namespaces or constructor parameter properties.
      assert.doesNotMatch(source, /\benum\s|\bnamespace\s|constructor\s*\([^)]*\b(private|public|protected|readonly)\s/,
        `${name} uses non-erasable TypeScript syntax`);
    }
  });
});
