/**
 * Public-only inspection of the explicitly selected, owner-provisioned Secret.
 * Never creates a key, writes a Secret, or falls back to native/file storage.
 */
import { describeProjectSecretBrokerKey } from "../services/broker-project-secret";

const args = process.argv.slice(2);
const action = args.shift();
const options: Record<string, string> = {};
let malformed = false;
while (args.length) {
  const flag = args.shift()!, value = args.shift();
  if (!["--store", "--actor", "--key-id"].includes(flag) || !value || value.startsWith("--") || flag in options) {
    malformed = true; break;
  }
  options[flag] = value;
}
if (malformed || !["init", "public"].includes(action ?? "") ||
  !options["--store"] || !options["--actor"] || !options["--key-id"]) {
  console.error("usage: broker-project-secret-cli.ts public|init --store replit-project-secret --actor luca-replit --key-id lr-replit-1");
  process.exitCode = 2;
} else if (action === "init") {
  // Before any key read, generation or store access, even if a Secret exists.
  console.error("broker_project_secret_owner_provision_required");
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await describeProjectSecretBrokerKey({
      store: options["--store"], actor: options["--actor"], keyId: options["--key-id"],
    }), null, 2));
  } catch (error) {
    const allowed = new Set([
      "broker_project_secret_explicit_selection_required", "broker_project_secret_binding_mismatch",
      "broker_project_secret_scope_mismatch", "broker_project_secret_missing", "broker_project_secret_invalid",
    ]);
    const code = error instanceof Error && allowed.has(error.message) ? error.message : "broker_project_secret_failed";
    console.error(code);
    process.exitCode = 1;
  }
}
