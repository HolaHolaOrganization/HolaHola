/**
 * A hat's own Ed25519 signing key for the isolated broker (costed plan
 * ff04f70e; broker/src/client.ts: "each hat signs with its OWN Ed25519 key,
 * held in its own host store").
 *
 * The private key is generated and kept ONLY in the host's native secure
 * store (the same adapters runtime onboarding uses: Windows DPAPI, macOS
 * Keychain, Linux Secret Service), under its own purpose
 * 'broker-signing-key'. It is never printed, logged, returned to a caller
 * or written to a file. What leaves this module is the public key, its
 * fingerprint, and the exact policy.json signing-key entry a founder-approved
 * policy PR can carry.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { RuntimeOnboardingScope, RuntimeOnboardingStore } from './runtime-onboarding-store';

/** The broker's pinned public origin (plan P3): the scope's endpoint. */
export const BROKER_ENDPOINT = 'https://holahola-broker.onrender.com';
const ACTOR_ID = /^[a-z][a-z0-9-]{1,62}$/; // broker/src/policy.ts ACTOR_ID
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/; // broker/src/policy.ts KEY_ID

export function brokerKeyScope(actor: string, keyId: string): RuntimeOnboardingScope {
  if (!ACTOR_ID.test(actor)) throw new Error('broker_key_invalid_actor');
  if (!KEY_ID.test(keyId)) throw new Error('broker_key_invalid_key_id');
  return { endpoint: BROKER_ENDPOINT, actor, runtimeId: keyId };
}

export interface BrokerPublicKey {
  actor: string;
  keyId: string;
  publicKeyPem: string;
  /** SHA-256 of the SubjectPublicKeyInfo DER, hex: what a reviewer compares. */
  fingerprint: string;
  /** Exactly the broker/policy.json signingKeys entry. */
  policyEntry: { id: string; publicKeyPem: string };
  /** true when this call created the key; false when it already existed. */
  created: boolean;
}

function describe(actor: string, keyId: string, privateKey: KeyObject, created: boolean): BrokerPublicKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('broker_key_stored_key_not_ed25519');
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { actor, keyId, publicKeyPem, fingerprint, policyEntry: { id: keyId, publicKeyPem }, created };
}

/**
 * Create the key if absent (atomic setIfAbsent: two concurrent inits keep
 * ONE key), otherwise keep the existing one. Idempotent; never rotates.
 */
export async function initBrokerSigningKey(store: RuntimeOnboardingStore, actor: string, keyId: string): Promise<BrokerPublicKey> {
  const scope = brokerKeyScope(actor, keyId);
  const candidate = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const stored = await store.setIfAbsent(scope, 'broker-signing-key', candidate);
  return describe(actor, keyId, createPrivateKey(stored), stored === candidate);
}

/** The public half of an existing key; fails when there is none. */
export async function readBrokerPublicKey(store: RuntimeOnboardingStore, actor: string, keyId: string): Promise<BrokerPublicKey> {
  const stored = await store.get(brokerKeyScope(actor, keyId), 'broker-signing-key');
  if (!stored) throw new Error('broker_key_missing');
  return describe(actor, keyId, createPrivateKey(stored), false);
}

/** The signer for broker/src/client.ts. The key object stays in this process. */
export async function loadBrokerSigner(store: RuntimeOnboardingStore, actor: string, keyId: string): Promise<{ actor: string; keyId: string; privateKey: KeyObject }> {
  const stored = await store.get(brokerKeyScope(actor, keyId), 'broker-signing-key');
  if (!stored) throw new Error('broker_key_missing');
  const privateKey = createPrivateKey(stored);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('broker_key_stored_key_not_ed25519');
  return { actor, keyId, privateKey };
}
