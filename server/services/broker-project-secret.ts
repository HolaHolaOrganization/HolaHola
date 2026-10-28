/**
 * Explicit founder-accepted project-Secret custody for the Replit broker key.
 * This is environment access, NOT native OS storage or a runtime-restricted
 * signing service. Any workspace code/platform with Secret access can read it.
 * Provisioning is owner-controlled; this module never creates or persists keys.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { RuntimeOnboardingScope, RuntimeOnboardingStore } from "./runtime-onboarding-store";

export const REPLIT_BROKER_ACTOR = "luca-replit";
export const REPLIT_BROKER_KEY_ID = "lr-replit-1";
export const REPLIT_BROKER_SECRET_NAME = "BROKER_SIGNING_KEY_LR_REPLIT_1";
export const REPLIT_BROKER_KEY_ENDPOINT = "https://holahola-broker.onrender.com";
export const REPLIT_PROJECT_SECRET_STORE = "replit-project-secret";
export const PROJECT_SECRET_CUSTODY =
  "Replit project Secret; encrypted at rest and injected as an environment variable. " +
  "Readable by workspace code and the platform; not native OS storage or a runtime-restricted signing service.";

type Environment = Readonly<Record<string, string | undefined>>;
export type ProjectSecretSelection = { store: string; actor: string; keyId: string };

function requireSelection(selection: ProjectSecretSelection): void {
  if (selection.store !== REPLIT_PROJECT_SECRET_STORE) throw new Error("broker_project_secret_explicit_selection_required");
  if (selection.actor !== REPLIT_BROKER_ACTOR || selection.keyId !== REPLIT_BROKER_KEY_ID) {
    throw new Error("broker_project_secret_binding_mismatch");
  }
}

/** Read-only, one-key adapter. Never pass this off as HostedRuntimeOnboardingStore. */
export class ReplitProjectSecretBrokerStore implements RuntimeOnboardingStore {
  constructor(selection: ProjectSecretSelection, private readonly environment: () => Environment = () => process.env) {
    requireSelection(selection);
  }

  async get(scope: RuntimeOnboardingScope, purpose: string): Promise<string> {
    if (scope.endpoint !== REPLIT_BROKER_KEY_ENDPOINT || scope.actor !== REPLIT_BROKER_ACTOR ||
      scope.runtimeId !== REPLIT_BROKER_KEY_ID || purpose !== "broker-signing-key") {
      throw new Error("broker_project_secret_scope_mismatch");
    }
    const raw = this.environment()[REPLIT_BROKER_SECRET_NAME];
    if (!raw) throw new Error("broker_project_secret_missing");
    if (raw.length > 4096) throw new Error("broker_project_secret_invalid");
    // Owner imports PKCS#8 PEM, optionally canonical one-line base64 of that
    // PEM. Decode once; never treat another encoding as a fallback store.
    let value = raw;
    if (!raw.startsWith("-----BEGIN")) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("broker_project_secret_invalid");
      const decoded = Buffer.from(raw, "base64");
      if (decoded.toString("base64") !== raw) throw new Error("broker_project_secret_invalid");
      value = decoded.toString("utf8");
      if (!Buffer.from(value, "utf8").equals(decoded)) throw new Error("broker_project_secret_invalid");
    }
    if (!/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PRIVATE KEY-----\r?\n?$/.test(value)) {
      throw new Error("broker_project_secret_invalid");
    }
    try {
      if (createPrivateKey(value).asymmetricKeyType !== "ed25519") throw new Error("wrong type");
    } catch {
      throw new Error("broker_project_secret_invalid");
    }
    return value;
  }

  async set(): Promise<never> { throw new Error("broker_project_secret_owner_provision_required"); }
  async setIfAbsent(): Promise<never> { throw new Error("broker_project_secret_owner_provision_required"); }
  async delete(): Promise<never> { throw new Error("broker_project_secret_owner_provision_required"); }
}

export async function loadProjectSecretBrokerSigner(
  selection: ProjectSecretSelection, environment?: () => Environment,
): Promise<{ actor: string; keyId: string; privateKey: KeyObject }> {
  const store = new ReplitProjectSecretBrokerStore(selection, environment);
  const pem = await store.get({
    endpoint: REPLIT_BROKER_KEY_ENDPOINT, actor: selection.actor, runtimeId: selection.keyId,
  }, "broker-signing-key");
  return { actor: REPLIT_BROKER_ACTOR, keyId: REPLIT_BROKER_KEY_ID, privateKey: createPrivateKey(pem) };
}

export async function describeProjectSecretBrokerKey(selection: ProjectSecretSelection, environment?: () => Environment) {
  const signer = await loadProjectSecretBrokerSigner(selection, environment);
  const publicKey = createPublicKey(signer.privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    actor: signer.actor, keyId: signer.keyId, created: false,
    fingerprintSha256: createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"),
    policySigningKey: { id: signer.keyId, publicKeyPem },
    custody: PROJECT_SECRET_CUSTODY,
  };
}
