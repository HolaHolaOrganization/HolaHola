import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { decide, stateAllows } from '../src/authorize.ts';
import { canonicalJson } from '../src/canonical.ts';
import { AUDIENCE, type Envelope, payloadDigest, PROTOCOL } from '../src/envelope.ts';
import { gitBlobSha, parsePolicy, PolicyLoader, REPOSITORY_ID } from '../src/policy.ts';

// The committed broker/policy.json is the broker's only authority source.
// Phase 4 starts it CLOSED with no actors: the deployed broker can then be
// observed against real GitHub while refusing every request. Moving out of
// closed, or adding an actor's signing key, is a separate founder-approved PR
// to this founder-owned file.

const bytes = new Uint8Array(readFileSync(new URL('../policy.json', import.meta.url)));

describe('committed broker/policy.json', () => {
  test('parses, names this repository, and is closed with no actors or qualification entries', () => {
    const policy = parsePolicy(bytes);
    assert.equal(policy.repositoryId, REPOSITORY_ID);
    assert.equal(policy.state, 'closed');
    assert.equal(policy.actors.size, 0);
    assert.deepEqual(policy.qualification, []);
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
    // With no actors listed, an authentically signed request is refused for its actor.
    assert.deepEqual(decision, { decision: 'deny', reason: 'unknown_actor' });
  });

  test('even an actor the policy did list would be refused: the committed state is closed', () => {
    const policy = parsePolicy(bytes);
    const envelope = signedRequest(policy.epoch).envelope as Envelope;
    assert.deepEqual(stateAllows(policy, envelope), { ok: false, reason: 'policy_closed' });
    for (const operation of ['read', 'status', 'pr.merge', 'commit.write', 'branch.delete'] as const) {
      assert.deepEqual(stateAllows(policy, { ...envelope, operation }), { ok: false, reason: 'policy_closed' }, operation);
    }
  });
});
