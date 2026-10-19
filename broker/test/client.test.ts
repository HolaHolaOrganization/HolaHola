import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BrokerClient, Journal, signRequest, signStatus, VALIDITY_MS } from '../src/client.ts';
import { verifyOriginalSignature, verifySignedRequest } from '../src/envelope.ts';
import { gitBlobSha, parsePolicy, REPOSITORY_ID } from '../src/policy.ts';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const keys = generateKeyPairSync('ed25519');
const signer = { actor: 'luca-claude-code', keyId: 'lcc-1', privateKey: keys.privateKey };
const policyBytes = new TextEncoder().encode(JSON.stringify({
  version: 1, state: 'routine', repositoryId: REPOSITORY_ID, qualification: [],
  actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [{ id: 'lcc-1', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] } },
}));
const policy = parsePolicy(policyBytes);
const epoch = gitBlobSha(policyBytes);

async function tempJournal(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'broker-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, journal: new Journal(dir) };
}

describe('client signing', () => {
  test('a signed request verifies at the broker, with a <= 60 s window and a fresh operation id', () => {
    const request = signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: HEAD, payload: { body: 'hi' }, policyEpoch: epoch }, NOW);
    assert.equal(request.envelope.expiresAt - request.envelope.issuedAt, VALIDITY_MS);
    assert.match(request.envelope.operationId, /^op-[0-9a-f]{24}$/);
    assert.equal(verifySignedRequest(request, policy, NOW).ok, true);
    const other = signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: HEAD, payload: { body: 'hi' }, policyEpoch: epoch }, NOW);
    assert.notEqual(other.envelope.operationId, request.envelope.operationId);
  });

  test('refuses a non-Ed25519 key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.throws(() => signRequest({ ...signer, privateKey: rsa }, { operation: 'read', pr: 48, headSha: HEAD, payload: {}, policyEpoch: epoch }, NOW), TypeError);
  });

  test('a status request carries the original verbatim, so its digest still matches after the original expired', () => {
    const original = signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: HEAD, payload: { body: 'hi' }, policyEpoch: epoch }, NOW);
    const later = NOW + 10 * 60_000;
    const status = signStatus(signer, original, epoch, later);
    assert.equal(verifySignedRequest(status, policy, later).ok, true);
    assert.equal(verifySignedRequest(original, policy, later).ok, false, 'the original itself is expired');
    const carried = (status.payload as { original: unknown }).original;
    const a = verifyOriginalSignature(carried, policy), b = verifySignedRequest(original, policy, NOW);
    assert.ok(a.ok && b.ok && a.digest === b.digest);
  });
});

describe('client transport and journal', () => {
  function fakeBroker(onPost: () => Response) {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, state: 'routine', epoch }));
      return onPost();
    }) as typeof fetch;
    return { calls, impl };
  }

  test('a mutating request is journaled before it is sent, and a transport failure is not retried', async (t) => {
    const { dir, journal } = await tempJournal(t);
    const broker = fakeBroker(() => { throw new Error('connection reset'); });
    const client = new BrokerClient({ baseUrl: 'https://holahola-broker.onrender.com', signer, journal, fetchImpl: broker.impl, now: () => NOW });
    await assert.rejects(client.execute('pr.comment', 48, HEAD, { body: 'hi' }));
    assert.equal(broker.calls.filter((c) => c.url.endsWith('/v1/operations')).length, 1);
    const entries = await readdir(dir);
    assert.equal(entries.length, 1, 'the signed original survives the failure for a later status');
  });

  test('status loads the journaled original and sends only a status request', async (t) => {
    const { journal } = await tempJournal(t);
    const broker = fakeBroker(() => new Response(JSON.stringify({ decision: 'uncertain' }), { status: 202 }));
    const client = new BrokerClient({ baseUrl: 'https://holahola-broker.onrender.com', signer, journal, fetchImpl: broker.impl, now: () => NOW });
    const first = await client.execute('pr.comment', 48, HEAD, { body: 'hi' });
    await client.status(first.operationId);
    const posts = broker.calls.filter((c) => c.url.endsWith('/v1/operations')).map((c) => c.body as { envelope: { operation: string }; payload: { original?: { envelope: { operationId: string } } } });
    assert.deepEqual(posts.map((p) => p.envelope.operation), ['pr.comment', 'status']);
    assert.equal(posts[1].payload.original?.envelope.operationId, first.operationId);
  });

  test('reads are not journaled; the journal never overwrites an operation id', async (t) => {
    const { dir, journal } = await tempJournal(t);
    const broker = fakeBroker(() => new Response(JSON.stringify({ decision: 'read' }), { status: 200 }));
    const client = new BrokerClient({ baseUrl: 'https://holahola-broker.onrender.com', signer, journal, fetchImpl: broker.impl, now: () => NOW });
    await client.execute('read', 48, HEAD, {});
    assert.deepEqual(await readdir(dir).catch(() => []), []);
    const request = signRequest(signer, { operation: 'pr.comment', pr: 48, headSha: HEAD, payload: { body: 'x' }, policyEpoch: epoch }, NOW);
    await journal.record(request);
    await assert.rejects(journal.record(request));
  });

  test('only https broker URLs (or loopback for tests) are accepted', async (t) => {
    const { journal } = await tempJournal(t);
    assert.throws(() => new BrokerClient({ baseUrl: 'http://holahola-broker.onrender.com', signer, journal }), TypeError);
  });
});
