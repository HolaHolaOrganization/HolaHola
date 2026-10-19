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
    assert.deepEqual(await decide({}, loader, NOW), { decision: 'deny', reason: 'no_policy' });
  });

  test('closed denies a valid signed request', async () => {
    const loader = loaderFor(policyJson());
    const epoch = (await loader.current())!.epoch;
    assert.deepEqual(await decide(signedRequest(epoch), loader, NOW), { decision: 'deny', reason: 'policy_closed', operationId: 'op-0123456789abcdef' });
  });

  test('no state allows anything in phase 1', async () => {
    for (const state of ['qualification', 'routine']) {
      const loader = loaderFor(policyJson({ state }));
      const epoch = (await loader.current())!.epoch;
      const result = await decide(signedRequest(epoch), loader, NOW);
      assert.equal(result.decision, 'deny');
    }
  });
});

describe('http server', () => {
  async function withServer(loader: PolicyLoader, run: (base: string) => Promise<void>): Promise<void> {
    const server = createBrokerServer(loader, () => NOW);
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
    }
  });
});
