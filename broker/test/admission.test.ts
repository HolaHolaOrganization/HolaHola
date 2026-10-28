// Stage-1 design section 8: signed large-body admission for blob.put, run
// through the real HTTP server with real streaming. The gateway is a
// recording stub: admission is only ever a gate in front of full
// authorization, never a substitute for it.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { type AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import {
  ADMISSION_DOMAIN, ADMISSION_HEADER, type AdmissionConfig, type AdmissionManifest, AdmissionSlots, encodedLength,
  MAX_ADMISSION_HEADER_CHARS, parseAdmissionHeader, signAdmission, STANDARD_BODY_LIMIT, verifyAdmission,
} from '../src/admission.ts';
import { BrokerClient, Journal, signRequest, type Signer } from '../src/client.ts';
import { type Gateway } from '../src/gateway.ts';
import { ConfigError, loadConfig } from '../src/main.ts';
import { gitBlobSha, parsePolicy, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';
import { createBrokerServer } from '../src/server.ts';

const lcc = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const signer: Signer = { actor: 'luca-claude-code', keyId: 'lcc-1', privateKey: lcc.privateKey };

function policyBytes(state = 'routine'): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1, state, repositoryId: REPOSITORY_ID, qualification: [],
    actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: lcc.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
  }));
}
const BYTES = policyBytes();
const EPOCH = gitBlobSha(BYTES);
const POLICY = parsePolicy(BYTES);

const CONFIG: AdmissionConfig = { maxRawBytes: 200_000, globalSlots: 1, actorSlots: 1, bodyDeadlineMs: 10_000, minBytesPerSecond: 1 };

/** A signed blob.put for `raw` bytes, its exact wire body, and a matching admission header. */
function blobRequest(raw: number, fill = 'x', overrides: Partial<AdmissionManifest> = {}) {
  const bytes = Buffer.alloc(raw, fill);
  const payload = { blobSha: gitBlobSha(bytes), rawSize: raw, contentBase64: bytes.toString('base64') };
  const signed = signRequest(signer, { operation: 'blob.put', pr: null, headSha: null, payload, policyEpoch: EPOCH }, Date.now());
  const body = JSON.stringify(signed);
  const manifest: AdmissionManifest = {
    domain: ADMISSION_DOMAIN, actor: 'luca-claude-code', keyId: 'lcc-1', operation: 'blob.put', repositoryId: REPOSITORY_ID,
    rawSize: raw, encodedSize: encodedLength(raw), bodySize: Buffer.byteLength(body), payloadDigest: signed.envelope.payloadSha256,
    admissionId: `adm-${Math.random().toString(16).slice(2).padEnd(16, '0')}`, issuedAt: Date.now(), expiresAt: Date.now() + 30_000, ...overrides,
  };
  return { body, manifest, header: signAdmission(lcc.privateKey, manifest) };
}

type Reply = { status: number; body: Record<string, unknown> } | { reset: true };

async function withServer(admission: AdmissionConfig | undefined, use: (port: number, calls: unknown[]) => Promise<void>) {
  const calls: unknown[] = [];
  const loader = new PolicyLoader({ fetch: async () => ({ bytes: BYTES, blobSha: EPOCH }) }, Date.now, 60_000, () => {});
  const gateway = { execute: async (_body: unknown, envelope: { operation: string }, _d: string, payload: { rawSize?: number }) => {
    calls.push({ operation: envelope.operation, rawSize: payload.rawSize });
    return { status: 200, body: { decision: 'executed' } };
  } } as unknown as Gateway;
  const server = createBrokerServer({ loaderFor: (a) => (a === 'luca-claude-code' ? loader : undefined), healthLoader: loader, gateway, admission });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await use((server.address() as AddressInfo).port, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Posts `body` in two halves. `pause` resolves before the second half is
 * written, so a test can interleave; `abort` destroys the socket instead.
 */
function post(port: number, body: string, headers: Record<string, string> = {}, control: { pause?: Promise<void>; abort?: boolean; stallMs?: number } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const bytes = Buffer.from(body, 'utf8');
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/operations', headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      res.on('error', () => resolve({ reset: true }));
    });
    req.on('error', () => resolve({ reset: true }));
    const half = Math.floor(bytes.length / 2);
    req.write(bytes.subarray(0, half));
    void (async () => {
      if (control.pause) await control.pause;
      if (control.stallMs) await new Promise((r) => setTimeout(r, control.stallMs));
      if (control.abort) { req.destroy(); resolve({ reset: true }); return; }
      if (!req.destroyed) req.end(bytes.subarray(half));
    })();
  });
}

/** Chunked transfer encoding: no Content-Length, so only the streamed byte count can be enforced. */
function postChunked(port: number, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/operations', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      res.on('error', () => resolve({ reset: true }));
    });
    req.on('error', () => resolve({ reset: true }));
    const bytes = Buffer.from(body, 'utf8');
    for (let i = 0; i < bytes.length; i += 16_384) req.write(bytes.subarray(i, i + 16_384));
    req.end();
  });
}

/** Sends headers only (with the given Content-Length) and withholds the body until `release`. */
function postHeadersOnly(port: number, contentLength: number, headers: Record<string, string>, release: Promise<void>): Promise<Reply> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/operations', headers: { 'content-type': 'application/json', 'content-length': String(contentLength), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      res.on('error', () => resolve({ reset: true }));
    });
    req.on('error', () => resolve({ reset: true }));
    req.flushHeaders();
    void release.then(() => req.destroy());
  });
}

const status = (reply: Reply) => ('reset' in reply ? 'reset' : reply.status);
const reason = (reply: Reply) => ('reset' in reply ? 'reset' : reply.body.reason ?? reply.body.error);
const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };

describe('admission configuration (F5: no limits in code)', () => {
  const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const base = {
    BROKER_ACTORS: JSON.stringify([{ actor: 'luca-claude-code', appId: 5350010, installationId: 172194780, botLogin: 'holahola-luca-claude-code[bot]' }]),
    BROKER_APP_PRIVATE_KEY_5350010: rsa(), BROKER_AUDIT_REPO: 'davidwmcintosh/holahola-broker-audit', BROKER_AUDIT_REPO_ID: '42',
    BROKER_AUDIT_APP_ID: '777', BROKER_AUDIT_INSTALLATION_ID: '888', BROKER_AUDIT_APP_PRIVATE_KEY: rsa(),
  };
  const caps = {
    BROKER_ADMISSION_MAX_RAW_BYTES: '2883584', BROKER_ADMISSION_GLOBAL_SLOTS: '2', BROKER_ADMISSION_ACTOR_SLOTS: '1',
    BROKER_ADMISSION_BODY_DEADLINE_MS: '30000', BROKER_ADMISSION_MIN_BYTES_PER_SECOND: '65536',
  };

  test('with no caps configured, large-body admission is disabled', () => {
    assert.equal(loadConfig(base).admission, undefined);
  });

  test('all five caps configure it exactly', () => {
    assert.deepEqual(loadConfig({ ...base, ...caps }).admission, { maxRawBytes: 2_883_584, globalSlots: 2, actorSlots: 1, bodyDeadlineMs: 30_000, minBytesPerSecond: 65_536 });
  });

  test('a partial set, or any non-positive or non-integer cap, is refused', () => {
    for (const name of Object.keys(caps)) {
      const partial: Record<string, string | undefined> = { ...base, ...caps, [name]: undefined };
      assert.throws(() => loadConfig(partial), (e: unknown) => e instanceof ConfigError && e.message === 'invalid BROKER_ADMISSION (set all five caps or none)', `missing ${name}`);
      for (const bad of ['0', '-1', '1.5', 'Infinity', 'abc', '']) {
        assert.throws(() => loadConfig({ ...base, ...caps, [name]: bad }), ConfigError, `${name}=${bad}`);
      }
    }
    assert.throws(() => loadConfig({ ...base, ...caps, BROKER_ADMISSION_ACTOR_SLOTS: '3' }), (e: unknown) => e instanceof ConfigError && e.message === 'invalid BROKER_ADMISSION_ACTOR_SLOTS');
  });
});

describe('admission manifest verification', () => {
  const now = Date.now();
  const good = () => blobRequest(100_000);
  const check = (header: string, config = CONFIG, at = now) => {
    const parsed = parseAdmissionHeader(header);
    return parsed ? verifyAdmission(parsed, POLICY, config, at) : { ok: false as const, reason: 'unparsed' as const };
  };

  test('a correctly signed manifest within every cap verifies', () => {
    assert.equal(check(good().header).ok, true);
  });

  test('signature, key, domain, operation, repository and policy state are all bound', () => {
    const { manifest } = good();
    assert.equal(check(signAdmission(other.privateKey, manifest)).ok, false, 'another key');
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, keyId: 'lcc-2' })).ok, false, 'unknown key id');
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, actor: 'luca-replit' })).ok, false, 'unknown actor');
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, repositoryId: 2_000_000_001 })).ok, false, 'other repository');
    assert.equal(parseAdmissionHeader(signAdmission(lcc.privateKey, { ...manifest, domain: 'holahola-broker/v1' as never })), null, 'other domain');
    assert.equal(parseAdmissionHeader(signAdmission(lcc.privateKey, { ...manifest, operation: 'pr.comment' as never })), null, 'other operation');
    const parsed = parseAdmissionHeader(good().header)!;
    assert.equal(verifyAdmission(parsed, parsePolicy(policyBytes('closed')), CONFIG, now).ok, false, 'closed policy');
    // Tampering with any field after signing breaks the signature.
    const tampered = { manifest: { ...parsed.manifest, rawSize: 1 }, signature: parsed.signature };
    assert.equal(verifyAdmission(tampered, POLICY, CONFIG, now).ok, false);
  });

  test('freshness: at most 60 s of validity, not before issue (5 s skew), not after expiry', () => {
    const { manifest, header } = good();
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, expiresAt: manifest.issuedAt + 60_001 })).ok, false);
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, expiresAt: manifest.issuedAt })).ok, false);
    assert.equal(check(header, CONFIG, manifest.expiresAt - 1).ok, true, 'last valid millisecond');
    assert.equal(check(header, CONFIG, manifest.expiresAt).ok, false, 'expired');
    assert.equal(check(header, CONFIG, manifest.issuedAt - 5_000).ok, true, 'within skew');
    assert.equal(check(header, CONFIG, manifest.issuedAt - 5_001).ok, false, 'not yet valid');
  });

  test('exact size arithmetic: raw cap, encoded = 4*ceil(raw/3), body within encoded + 64 KiB', () => {
    const { manifest } = good();
    assert.deepEqual(check(good().header, { ...CONFIG, maxRawBytes: 99_999 }), { ok: false, reason: 'too_large' });
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, encodedSize: manifest.encodedSize + 4 })).ok, false);
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, bodySize: manifest.encodedSize - 1 })).ok, false);
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, bodySize: manifest.encodedSize + 65_537 })).ok, false);
    assert.equal(check(signAdmission(lcc.privateKey, { ...manifest, bodySize: manifest.encodedSize + 65_536 })).ok, true);
    assert.deepEqual([0, 1, 2, 3, 4, 2_883_584].map(encodedLength), [0, 4, 4, 4, 8, 3_844_780]);
  });

  test('the header is bounded and strictly shaped', () => {
    assert.equal(parseAdmissionHeader('x'.repeat(MAX_ADMISSION_HEADER_CHARS + 1)), null);
    // A genuinely valid, signed manifest padded with JSON whitespace past the bound is still refused.
    const { manifest } = good();
    const valid = parseAdmissionHeader(signAdmission(lcc.privateKey, manifest))!;
    const padded = Buffer.from(JSON.stringify(valid).replace('{', `{${' '.repeat(2_000)}`)).toString('base64url');
    assert.notEqual(JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')), null, 'still valid JSON');
    assert.ok(padded.length > MAX_ADMISSION_HEADER_CHARS);
    assert.equal(parseAdmissionHeader(padded), null);
    assert.equal(parseAdmissionHeader('not base64url!'), null);
    assert.equal(parseAdmissionHeader(Buffer.from(JSON.stringify({ manifest: good().manifest, signature: 'a', extra: 1 })).toString('base64url')), null);
    assert.equal(parseAdmissionHeader(Buffer.from(JSON.stringify({ manifest: { ...good().manifest, extra: 1 }, signature: 'a' })).toString('base64url')), null);
  });

  test('slots: global and per-actor bounds, unique in-flight ids, idempotent release', () => {
    const slots = new AdmissionSlots({ ...CONFIG, globalSlots: 2, actorSlots: 1 });
    const a = slots.reserve('luca-claude-code', 'adm-0000000000000001');
    assert.equal(a.ok, true);
    assert.deepEqual(slots.reserve('luca-claude-code', 'adm-0000000000000002'), { ok: false, reason: 'busy' }, 'per actor');
    assert.deepEqual(slots.reserve('luca-replit', 'adm-0000000000000001'), { ok: false, reason: 'admission_invalid' }, 'id in flight');
    const b = slots.reserve('luca-replit', 'adm-0000000000000003');
    assert.equal(b.ok, true);
    assert.deepEqual(slots.reserve('luca-antigravity', 'adm-0000000000000004'), { ok: false, reason: 'busy' }, 'global');
    if (a.ok) { a.release(); a.release(); }
    assert.deepEqual(slots.inUse(), { total: 1, actors: 1 });
    assert.equal(slots.reserve('luca-claude-code', 'adm-0000000000000001').ok, true, 'id reusable once released');
  });
});

describe('through the HTTP server', () => {
  test('disabled: an admission header is refused unread, and large bodies keep the standard cap', async () => {
    await withServer(undefined, async (port, calls) => {
      const big = blobRequest(100_000);
      assert.equal(reason(await post(port, big.body, { [ADMISSION_HEADER]: big.header })), 'large_body_disabled');
      assert.equal(reason(await post(port, big.body)), 'body_too_large');
      const small = blobRequest(10_000);
      assert.equal(status(await post(port, small.body)), 200, 'small requests are unaffected');
      assert.deepEqual(calls, [{ operation: 'blob.put', rawSize: 10_000 }]);
    });
  });

  test('enabled: an admitted large blob.put reaches full authorization and the gateway exactly once', async () => {
    await withServer(CONFIG, async (port, calls) => {
      const big = blobRequest(150_000);
      assert.ok(Buffer.byteLength(big.body) > STANDARD_BODY_LIMIT);
      const reply = await post(port, big.body, { [ADMISSION_HEADER]: big.header });
      assert.equal(status(reply), 200, JSON.stringify(reply));
      assert.deepEqual(calls, [{ operation: 'blob.put', rawSize: 150_000 }]);
      // The slot was released: a second admission succeeds with one slot.
      const again = blobRequest(150_000, 'y');
      assert.equal(status(await post(port, again.body, { [ADMISSION_HEADER]: again.header })), 200);
      // Without a header, the same size still hits the standard cap.
      assert.equal(reason(await post(port, blobRequest(150_000, 'z').body)), 'body_too_large');
    });
  });

  test('admission is never authority: an admitted request with a forged signature is refused by full authorization', async () => {
    await withServer(CONFIG, async (port, calls) => {
      const base = blobRequest(100_000, 'f');
      const forged = JSON.parse(base.body) as { signature: string };
      forged.signature = Buffer.from(Buffer.alloc(64, 7)).toString('base64');
      const body = JSON.stringify(forged);
      const header = signAdmission(lcc.privateKey, { ...base.manifest, bodySize: Buffer.byteLength(body) });
      const reply = await post(port, body, { [ADMISSION_HEADER]: header });
      assert.equal(status(reply), 403);
      assert.equal(reason(reply), 'bad_signature');
      assert.deepEqual(calls, []);
    });
  });

  test('the body must be exactly the announced request', async () => {
    await withServer({ ...CONFIG, globalSlots: 4, actorSlots: 4 }, async (port, calls) => {
      const a = blobRequest(100_000, 'a');
      const b = blobRequest(100_000, 'b');
      assert.equal(reason(await post(port, b.body, { [ADMISSION_HEADER]: a.header })), 'admission_invalid', 'another request of the same size');
      const shorter = blobRequest(100_000, 'c', {});
      const forShort = signAdmission(lcc.privateKey, { ...shorter.manifest, bodySize: shorter.manifest.bodySize + 10 });
      assert.equal(reason(await post(port, shorter.body, { [ADMISSION_HEADER]: forShort })), 'admission_invalid', 'content-length differs from the manifest');
      assert.equal(reason(await post(port, a.body, { [ADMISSION_HEADER]: 'garbage' })), 'admission_invalid');
      const unsigned = Buffer.from(JSON.stringify({ manifest: a.manifest, signature: 'AAAA' })).toString('base64url');
      assert.equal(reason(await post(port, a.body, { [ADMISSION_HEADER]: unsigned })), 'admission_invalid');
      assert.equal(reason(await post(port, a.body, { [ADMISSION_HEADER]: signAdmission(lcc.privateKey, { ...a.manifest, rawSize: 300_000, encodedSize: encodedLength(300_000), bodySize: encodedLength(300_000) + 500 }) })), 'too_large');
      assert.deepEqual(calls, []);
    });
  });

  test('streamed length is enforced without Content-Length: short and over-long chunked bodies are refused', async () => {
    await withServer({ ...CONFIG, globalSlots: 4, actorSlots: 4 }, async (port, calls) => {
      const short = blobRequest(100_000, 's');
      const longer = signAdmission(lcc.privateKey, { ...short.manifest, bodySize: short.manifest.bodySize + 10 });
      const shortReply = await postChunked(port, short.body, { [ADMISSION_HEADER]: longer });
      assert.deepEqual([status(shortReply), reason(shortReply)], [400, 'admission_invalid'], 'body shorter than announced');
      const over = blobRequest(100_000, 'o');
      const smaller = signAdmission(lcc.privateKey, { ...over.manifest, bodySize: over.manifest.bodySize - 10 });
      const overReply = await postChunked(port, over.body, { [ADMISSION_HEADER]: smaller });
      // 413: the read stops at the announced size; it never buffers past it.
      assert.deepEqual([status(overReply), reason(overReply)], [413, 'admission_invalid'], 'body longer than announced');
      assert.deepEqual(calls, []);
    });
  });

  test('a Content-Length that contradicts the manifest is refused before any body byte is sent', async () => {
    await withServer(CONFIG, async (port, calls) => {
      const a = blobRequest(100_000, 'a');
      const lying = signAdmission(lcc.privateKey, { ...a.manifest, bodySize: a.manifest.bodySize + 10 });
      const never = gate();
      const reply = await Promise.race([
        postHeadersOnly(port, Buffer.byteLength(a.body), { [ADMISSION_HEADER]: lying }, never.promise),
        new Promise<'no early answer'>((r) => setTimeout(() => r('no early answer'), 1_000)),
      ]);
      never.open();
      assert.notEqual(reply, 'no early answer');
      assert.equal(reason(reply as Reply), 'admission_invalid');
      assert.deepEqual(calls, []);
    });
  });

  test('busy: slots are bounded while a body is in flight, and released when it completes', async () => {
    await withServer(CONFIG, async (port, calls) => {
      const first = blobRequest(100_000, 'a');
      const hold = gate();
      const inFlight = post(port, first.body, { [ADMISSION_HEADER]: first.header }, { pause: hold.promise });
      await new Promise((r) => setTimeout(r, 150));
      const second = blobRequest(100_000, 'b');
      assert.equal(reason(await post(port, second.body, { [ADMISSION_HEADER]: second.header })), 'busy');
      hold.open();
      assert.equal(status(await inFlight), 200);
      const third = blobRequest(100_000, 'c');
      assert.equal(status(await post(port, third.body, { [ADMISSION_HEADER]: third.header })), 200);
      assert.equal(calls.length, 2);
    });
  });

  test('an in-flight admission id cannot be reused', async () => {
    await withServer({ ...CONFIG, globalSlots: 2, actorSlots: 2 }, async (port) => {
      const first = blobRequest(100_000, 'a', { admissionId: 'adm-reused-00000001' });
      const hold = gate();
      const inFlight = post(port, first.body, { [ADMISSION_HEADER]: first.header }, { pause: hold.promise });
      await new Promise((r) => setTimeout(r, 150));
      const second = blobRequest(100_000, 'b', { admissionId: 'adm-reused-00000001' });
      assert.equal(reason(await post(port, second.body, { [ADMISSION_HEADER]: second.header })), 'admission_invalid');
      hold.open();
      assert.equal(status(await inFlight), 200);
    });
  });

  test('a client abort releases its slot', async () => {
    await withServer(CONFIG, async (port, calls) => {
      const first = blobRequest(100_000, 'a');
      assert.deepEqual(await post(port, first.body, { [ADMISSION_HEADER]: first.header }, { abort: true }), { reset: true });
      await new Promise((r) => setTimeout(r, 150));
      const next = blobRequest(100_000, 'b');
      assert.equal(status(await post(port, next.body, { [ADMISSION_HEADER]: next.header })), 200);
      assert.equal(calls.length, 1);
    });
  });

  test('a body past its deadline is cut off and its slot released', async () => {
    await withServer({ ...CONFIG, bodyDeadlineMs: 300 }, async (port, calls) => {
      const slow = blobRequest(100_000, 'a');
      assert.deepEqual(await post(port, slow.body, { [ADMISSION_HEADER]: slow.header }, { stallMs: 700 }), { reset: true });
      const next = blobRequest(100_000, 'b');
      assert.equal(status(await post(port, next.body, { [ADMISSION_HEADER]: next.header })), 200);
      assert.equal(calls.length, 1);
    });
  });

  test('a body below the minimum average rate after its first second is cut off', async () => {
    await withServer({ ...CONFIG, minBytesPerSecond: 1_000_000_000 }, async (port, calls) => {
      const slow = blobRequest(100_000, 'a');
      assert.deepEqual(await post(port, slow.body, { [ADMISSION_HEADER]: slow.header }, { stallMs: 1_400 }), { reset: true });
      assert.deepEqual(calls, []);
    });
  });
});

describe('client', () => {
  test('attaches a verifiable admission only to a blob.put above the standard cap', async () => {
    const sent: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, epoch: EPOCH }));
      sent.push({ headers: init?.headers as Record<string, string>, body: init?.body as string });
      return new Response(JSON.stringify({ decision: 'executed' }));
    }) as typeof fetch;
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const client = new BrokerClient({ baseUrl: 'https://broker.example.onrender.com', signer, journal: new Journal(await mkdtemp(join(tmpdir(), 'adm-'))), fetchImpl });
    const blob = (raw: number) => { const b = Buffer.alloc(raw, 'q'); return { blobSha: gitBlobSha(b), rawSize: raw, contentBase64: b.toString('base64') }; };
    await client.execute('blob.put', null, null, blob(1_000));
    await client.execute('blob.put', null, null, blob(120_000));
    assert.equal(sent[0].headers[ADMISSION_HEADER], undefined, 'small: no header');
    const header = sent[1].headers[ADMISSION_HEADER];
    const parsed = parseAdmissionHeader(header);
    assert.ok(parsed);
    assert.equal(verifyAdmission(parsed, POLICY, CONFIG, Date.now()).ok, true);
    assert.equal(parsed.manifest.bodySize, Buffer.byteLength(sent[1].body));
    assert.equal(parsed.manifest.payloadDigest, JSON.parse(sent[1].body).envelope.payloadSha256);
  });
});
