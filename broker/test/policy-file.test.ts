import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { decide, stateAllows } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { gitBlobSha, parsePolicy, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

// The committed broker/policy.json is the broker's only authority source.
// Phase 4 started it CLOSED with no actors. This revision adds ONE actor,
// luca-claude-code, with its own Ed25519 key (created on LITTLENEMO in DPAPI
// by broker-signing-key-cli; only the public key is here) and stays CLOSED,
// so every request is still refused. Moving out of closed, or adding another
// actor's key, is a separate founder-approved PR to this founder-owned file.

const bytes = new Uint8Array(readFileSync(new URL('../policy.json', import.meta.url)));

describe('committed broker/policy.json', () => {
  test('parses, names this repository, is closed, and lists exactly the luca-claude-code key', () => {
    const policy = parsePolicy(bytes);
    assert.equal(policy.repositoryId, REPOSITORY_ID);
    assert.equal(policy.state, 'closed');
    assert.deepEqual(policy.qualification, []);
    assert.deepEqual([...policy.actors.keys()], ['luca-claude-code']);
    const lcc = policy.actors.get('luca-claude-code')!;
    assert.deepEqual([lcc.appId, lcc.installationId, lcc.host], [5350010, 174218337, 'LITTLENEMO']);
    assert.deepEqual(lcc.signingKeys.map(k => k.id), ['lcc-littlenemo-1']);
    const fingerprint = createHash('sha256').update(lcc.signingKeys[0].publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    assert.equal(fingerprint, '4c1c96dcaac778cd67302a2bd7ba1a240393cdb1aa810ee84a2fe0ed2c8cc040', 'the key created on LITTLENEMO');
  });

  test('its epoch is the git blob sha of the committed bytes', () => {
    assert.match(parsePolicy(bytes).epoch, /^[0-9a-f]{40}$/);
    assert.equal(parsePolicy(bytes).epoch, gitBlobSha(bytes));
  });

  // luca-replit review of PR59: a malformed request is rejected before the
  // policy is ever read, so it proves nothing about the committed file. These
  // tests use a well-formed, correctly signed, epoch-bound request that
  // reaches the policy source.
  const signer = generateKeyPairSync('ed25519');
  const NOW = 1_800_000_000_000;
  function signedRequest(epoch: string): Record<string, unknown> {
    const payload = { body: 'hello' };
    const envelope: Envelope = {
      audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID, actor: 'luca-claude-code', keyId: 'lcc-1',
      operation: 'pr.comment', pr: 48, headSha: 'a'.repeat(40), payloadSha256: payloadDigest(payload),
      policyEpoch: epoch, issuedAt: NOW - 1_000, expiresAt: NOW + 30_000, operationId: 'op-policy-file-000001',
    };
    return { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload };
  }

  test('a valid, epoch-bound request reaches the committed policy and is refused', async () => {
    let policyReads = 0;
    const loader = new PolicyLoader({ fetch: async () => { policyReads += 1; return { bytes, blobSha: gitBlobSha(bytes) }; } }, () => NOW);
    const decision = await decide(signedRequest(gitBlobSha(bytes)), () => loader, () => NOW);
    assert.ok(policyReads > 0, 'the committed policy must actually be read');
    // The test's key is not the listed one, so the request is refused for its key.
    assert.deepEqual(decision, { decision: 'deny', reason: 'unknown_key' });
  });

  test('an actor the policy does not list is refused', async () => {
    const loader = new PolicyLoader({ fetch: async () => ({ bytes, blobSha: gitBlobSha(bytes) }) }, () => NOW);
    const request = signedRequest(gitBlobSha(bytes));
    const envelope = { ...(request.envelope as Envelope), actor: 'luca-replit' };
    const resigned = { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload: request.payload };
    assert.deepEqual(await decide(resigned, () => loader, () => NOW), { decision: 'deny', reason: 'unknown_actor' });
  });

  test('even an actor the policy did list would be refused: the committed state is closed', () => {
    const policy = parsePolicy(bytes);
    const envelope = signedRequest(policy.epoch).envelope as Envelope;
    assert.deepEqual(stateAllows(policy, envelope), { ok: false, reason: 'policy_closed' });
    for (const operation of ['read', 'status', 'pr.merge', 'ref.update', 'branch.delete'] as const) {
      assert.deepEqual(stateAllows(policy, { ...envelope, operation }), { ok: false, reason: 'policy_closed' }, operation);
    }
  });
});

// Stage 1, decision F4-a: the temporary sandbox instance's founder-owned policy
// on main. It differs from broker/policy.json only in repositoryId (the
// disposable sandbox repository) and starts CLOSED: the first deploy is a
// smoke test only. Opening it for the sandbox proofs is a separate PR.
describe('committed broker/policy.sandbox.json', () => {
  const SANDBOX_REPOSITORY_ID = 1436541790;
  const sandboxBytes = new Uint8Array(readFileSync(new URL('../policy.sandbox.json', import.meta.url)));

  test('parses only for the sandbox repository, is closed, and carries the same luca-claude-code key', () => {
    const policy = parsePolicy(sandboxBytes, SANDBOX_REPOSITORY_ID);
    assert.equal(policy.repositoryId, SANDBOX_REPOSITORY_ID);
    assert.equal(policy.state, 'closed');
    assert.deepEqual(policy.qualification, []);
    assert.deepEqual([...policy.actors.keys()], ['luca-claude-code']);
    const lcc = policy.actors.get('luca-claude-code')!;
    assert.deepEqual([lcc.appId, lcc.installationId, lcc.host], [5350010, 174218337, 'LITTLENEMO']);
    const fingerprint = createHash('sha256').update(lcc.signingKeys[0].publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    assert.equal(fingerprint, '4c1c96dcaac778cd67302a2bd7ba1a240393cdb1aa810ee84a2fe0ed2c8cc040');
    // The production broker can never accept it, and it is not the production file.
    assert.throws(() => parsePolicy(sandboxBytes));
    assert.notEqual(SANDBOX_REPOSITORY_ID, REPOSITORY_ID);
  });

  test('differs from broker/policy.json only in repositoryId', () => {
    const prod = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
    const sandbox = JSON.parse(new TextDecoder().decode(sandboxBytes));
    assert.deepEqual({ ...sandbox, repositoryId: prod.repositoryId }, prod);
  });
});
