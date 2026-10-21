/** A hat's broker signing key: custody, idempotence and policy compatibility (no real secure store). */
import assert from 'node:assert/strict';
import { createPublicKey, sign, verify } from 'node:crypto';
import { describe, test } from 'node:test';
import { BROKER_ENDPOINT, brokerKeyScope, initBrokerSigningKey, loadBrokerSigner, readBrokerPublicKey } from './broker-signing-key';
import type { RuntimeOnboardingPurpose, RuntimeOnboardingScope, RuntimeOnboardingStore } from './runtime-onboarding-store';
import { parsePolicy } from '../../broker/src/policy.ts';

function memoryStore() {
  const values = new Map<string, string>();
  const k = (scope: RuntimeOnboardingScope, purpose: RuntimeOnboardingPurpose) => JSON.stringify([scope, purpose]);
  const store: RuntimeOnboardingStore = {
    async get(scope, purpose) { return values.get(k(scope, purpose)) ?? null; },
    async set(scope, purpose, value) { values.set(k(scope, purpose), value); },
    async setIfAbsent(scope, purpose, value) {
      const key = k(scope, purpose);
      if (!values.has(key)) values.set(key, value);
      return values.get(key)!;
    },
    async delete(scope, purpose) { values.delete(k(scope, purpose)); },
  };
  return { store, values };
}

describe('broker signing key', () => {
  test('init creates one Ed25519 key in the store and returns only public material', async () => {
    const { store, values } = memoryStore();
    const key = await initBrokerSigningKey(store, 'luca-claude-code', 'lcc-littlenemo-1');
    assert.equal(key.created, true);
    assert.equal(values.size, 1);
    const [[storedKey, storedValue]] = [...values.entries()];
    assert.match(storedKey, /broker-signing-key/);
    assert.match(storedValue, /BEGIN PRIVATE KEY/);
    const visible = JSON.stringify(key);
    assert.doesNotMatch(visible, /PRIVATE/, 'no private material ever leaves the module');
    assert.equal(createPublicKey(key.publicKeyPem).asymmetricKeyType, 'ed25519');
    assert.match(key.fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(key.policyEntry, { id: 'lcc-littlenemo-1', publicKeyPem: key.publicKeyPem });
  });

  test('init is idempotent and never rotates; concurrent inits keep one key', async () => {
    const { store } = memoryStore();
    const [a, b] = await Promise.all([
      initBrokerSigningKey(store, 'luca-claude-code', 'k-1'),
      initBrokerSigningKey(store, 'luca-claude-code', 'k-1'),
    ]);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    const again = await initBrokerSigningKey(store, 'luca-claude-code', 'k-1');
    assert.equal(again.created, false);
    assert.equal(again.fingerprint, a.fingerprint);
    assert.equal((await readBrokerPublicKey(store, 'luca-claude-code', 'k-1')).fingerprint, a.fingerprint);
  });

  test('keys are scoped by actor and key id; a missing key is an explicit error', async () => {
    const { store } = memoryStore();
    const a = await initBrokerSigningKey(store, 'luca-claude-code', 'k-1');
    const b = await initBrokerSigningKey(store, 'luca-replit', 'k-1');
    assert.notEqual(a.fingerprint, b.fingerprint);
    await assert.rejects(readBrokerPublicKey(store, 'luca-claude-code', 'k-2'), /broker_key_missing/);
    assert.deepEqual(brokerKeyScope('luca-claude-code', 'k-1'), { endpoint: BROKER_ENDPOINT, actor: 'luca-claude-code', runtimeId: 'k-1' });
    assert.throws(() => brokerKeyScope('Bad Actor', 'k'), /invalid_actor/);
    assert.throws(() => brokerKeyScope('luca-claude-code', 'bad id!'), /invalid_key_id/);
  });

  test('the signer verifies against the published public key', async () => {
    const { store } = memoryStore();
    const key = await initBrokerSigningKey(store, 'luca-claude-code', 'k-1');
    const signer = await loadBrokerSigner(store, 'luca-claude-code', 'k-1');
    const message = Buffer.from('envelope bytes');
    assert.equal(verify(null, message, createPublicKey(key.publicKeyPem), sign(null, message, signer.privateKey)), true);
  });

  test("the policy entry is accepted by the broker's own policy parser", async () => {
    const { store } = memoryStore();
    const key = await initBrokerSigningKey(store, 'luca-claude-code', 'lcc-littlenemo-1');
    const policy = {
      version: 1, state: 'closed', repositoryId: 1170208766,
      actors: { 'luca-claude-code': { appId: 5350010, installationId: 172194780, host: 'LITTLENEMO', signingKeys: [key.policyEntry] } },
      qualification: [],
    };
    const parsed = parsePolicy(new TextEncoder().encode(JSON.stringify(policy, null, 2) + '\n'));
    assert.equal(parsed.actors.get('luca-claude-code')?.signingKeys[0].id, 'lcc-littlenemo-1');
  });
});
