/**
 * broker-signing-key-cli.ts: create or show a hat's own broker signing key.
 *
 *   npx tsx server/scripts/broker-signing-key-cli.ts init   --actor <actor> --key-id <id>
 *   npx tsx server/scripts/broker-signing-key-cli.ts public --actor <actor> --key-id <id>
 *
 * Run it on the hat's OWN host, as that hat. The private key is created in
 * and stays in the host's native secure store; this prints only the public
 * key, its SHA-256 fingerprint and the broker/policy.json signingKeys entry,
 * for a founder-approved policy PR. `init` is idempotent: an existing key is
 * kept, never replaced.
 *
 * Exit codes: 0 ok; 2 usage; 3 no key (public); 1 anything else.
 */
import { initBrokerSigningKey, readBrokerPublicKey } from '../services/broker-signing-key';
import { createNativeRuntimeOnboardingStore } from '../services/runtime-onboarding-store';

const args = process.argv.slice(2);
const arg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const action = args[0];
const actor = arg('--actor');
const keyId = arg('--key-id');

if ((action !== 'init' && action !== 'public') || !actor || !keyId) {
  console.error('usage: broker-signing-key-cli.ts init|public --actor <actor> --key-id <id>');
  process.exit(2);
}

try {
  const store = createNativeRuntimeOnboardingStore();
  const key = action === 'init' ? await initBrokerSigningKey(store, actor, keyId) : await readBrokerPublicKey(store, actor, keyId);
  console.log(JSON.stringify({
    actor: key.actor,
    keyId: key.keyId,
    created: key.created,
    fingerprintSha256: key.fingerprint,
    policySigningKey: key.policyEntry,
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BrokerSigningKey] ${message}`);
  process.exit(message === 'broker_key_missing' ? 3 : 1);
}
