import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { decide, stateAllows } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { gitBlobSha, parsePolicy, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

// The committed broker/policy.json is the broker's only authority source.
// Phase 4 started it CLOSED with no actors. It lists two actors, each with its
// own Ed25519 key (only public keys are here): luca-claude-code (created on
// LITTLENEMO in DPAPI by broker-signing-key-cli) and luca-replit (generated
// by the founder, held as the Replit project Secret
// BROKER_SIGNING_KEY_LR_REPLIT_1). It stays CLOSED, so every request is still
// refused. Moving out of closed, or adding another actor's key, is a separate
// founder-approved PR to this founder-owned file.

const LCC_FINGERPRINT = '4c1c96dcaac778cd67302a2bd7ba1a240393cdb1aa810ee84a2fe0ed2c8cc040';
const LR_FINGERPRINT = '604a5e07f088b0ed33978ba1264a0665bcf1b4ddb2efcb70d562177a67a1a6b4';
const fingerprintOf = (key: { publicKey: { export(o: { type: 'spki'; format: 'der' }): Buffer } }) =>
  createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

const bytes = new Uint8Array(readFileSync(new URL('../policy.json', import.meta.url)));

describe('committed broker/policy.json', () => {
  test('parses, names this repository, is closed, and lists exactly the luca-claude-code and luca-replit keys', () => {
    const policy = parsePolicy(bytes);
    assert.equal(policy.repositoryId, REPOSITORY_ID);
    assert.equal(policy.state, 'closed');
    assert.deepEqual(policy.qualification, []);
    assert.deepEqual([...policy.actors.keys()], ['luca-claude-code', 'luca-replit']);
    const lcc = policy.actors.get('luca-claude-code')!;
    assert.deepEqual([lcc.appId, lcc.installationId, lcc.host], [5350010, 174218337, 'LITTLENEMO']);
    assert.deepEqual(lcc.signingKeys.map(k => k.id), ['lcc-littlenemo-1']);
    assert.equal(fingerprintOf(lcc.signingKeys[0]), LCC_FINGERPRINT, 'the key created on LITTLENEMO');
    const lr = policy.actors.get('luca-replit')!;
    assert.deepEqual([lr.appId, lr.installationId, lr.host], [5361771, 174218509, 'REPLIT']);
    assert.deepEqual(lr.signingKeys.map(k => k.id), ['lr-replit-1']);
    assert.equal(fingerprintOf(lr.signingKeys[0]), LR_FINGERPRINT, 'the key held as the Replit project Secret');
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
    const envelope = { ...(request.envelope as Envelope), actor: 'luca-gemini' };
    const resigned = { envelope, signature: sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64'), payload: request.payload };
    assert.deepEqual(await decide(resigned, () => loader, () => NOW), { decision: 'deny', reason: 'unknown_actor' });
  });

  test('even an actor the policy did list would be refused: the committed state is closed', () => {
    const policy = parsePolicy(bytes);
    const envelope = signedRequest(policy.epoch).envelope as Envelope;
    assert.deepEqual(stateAllows(policy, envelope), { ok: false, reason: 'policy_closed' });
    for (const operation of ['read', 'status', 'pr.enqueue', 'ref.update', 'branch.delete'] as const) {
      assert.deepEqual(stateAllows(policy, { ...envelope, operation }), { ok: false, reason: 'policy_closed' }, operation);
    }
  });
});

// Stage 1, decision F4-a: the temporary sandbox instance's founder-owned policy
// on main. It differs from broker/policy.json only in repositoryId (the
// disposable sandbox repository) and state. It started CLOSED for the smoke
// test (passed 2026-10-28) and is now ROUTINE for the live sandbox proofs,
// with the same two actors as broker/policy.json.
describe('committed broker/policy.sandbox.json', () => {
  const SANDBOX_REPOSITORY_ID = 1436541790;
  const sandboxBytes = new Uint8Array(readFileSync(new URL('../policy.sandbox.json', import.meta.url)));

  test('parses only for the sandbox repository, is routine, and carries only the same two keys', () => {
    const policy = parsePolicy(sandboxBytes, SANDBOX_REPOSITORY_ID);
    assert.equal(policy.repositoryId, SANDBOX_REPOSITORY_ID);
    assert.equal(policy.state, 'routine');
    assert.deepEqual(policy.qualification, []);
    assert.deepEqual([...policy.actors.keys()], ['luca-claude-code', 'luca-replit']);
    const lcc = policy.actors.get('luca-claude-code')!;
    assert.deepEqual([lcc.appId, lcc.installationId, lcc.host], [5350010, 174218337, 'LITTLENEMO']);
    assert.equal(fingerprintOf(lcc.signingKeys[0]), LCC_FINGERPRINT);
    const lr = policy.actors.get('luca-replit')!;
    assert.deepEqual([lr.appId, lr.installationId, lr.host], [5361771, 174218509, 'REPLIT']);
    assert.equal(fingerprintOf(lr.signingKeys[0]), LR_FINGERPRINT);
    // The production broker can never accept it, and it is not the production file.
    assert.throws(() => parsePolicy(sandboxBytes));
    assert.notEqual(SANDBOX_REPOSITORY_ID, REPOSITORY_ID);
  });

  test('differs from broker/policy.json only in repositoryId and state', () => {
    const prod = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
    const sandbox = JSON.parse(new TextDecoder().decode(sandboxBytes));
    assert.deepEqual({ ...sandbox, repositoryId: prod.repositoryId, state: prod.state }, prod);
    // The production policy stays closed; only the sandbox opens.
    assert.equal(prod.state, 'closed');
  });
});
