import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  describeProjectSecretBrokerKey, loadProjectSecretBrokerSigner, ReplitProjectSecretBrokerStore,
  REPLIT_BROKER_KEY_ENDPOINT, REPLIT_BROKER_SECRET_NAME,
} from "../services/broker-project-secret";

const selection = { store: "replit-project-secret", actor: "luca-replit", keyId: "lr-replit-1" };
const scope = { endpoint: REPLIT_BROKER_KEY_ENDPOINT, actor: selection.actor, runtimeId: selection.keyId };
const pair = generateKeyPairSync("ed25519");
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const environment = () => ({ [REPLIT_BROKER_SECRET_NAME]: pem });

test("explicit store and actor/key binding are checked before environment access", async () => {
  let reads = 0;
  const env = () => { reads++; return environment(); };
  for (const options of [{ ...selection, store: "" }, { ...selection, store: "native" },
    { ...selection, actor: "luca-claude-code" }, { ...selection, keyId: "other" }]) {
    await assert.rejects(loadProjectSecretBrokerSigner(options, env), /broker_project_secret_/);
  }
  assert.equal(reads, 0);
});

test("scope and purpose mismatches are refused before reading the Secret", async () => {
  let reads = 0;
  const store = new ReplitProjectSecretBrokerStore(selection, () => { reads++; return environment(); });
  for (const other of [{ ...scope, endpoint: "https://other.invalid" }, { ...scope, actor: "alden" },
    { ...scope, runtimeId: "other" }]) await assert.rejects(store.get(other, "broker-signing-key"), /scope_mismatch/);
  await assert.rejects(store.get(scope, "access-credential"), /scope_mismatch/);
  assert.equal(reads, 0);
});

test("all store writes fail without reading environment or generating a key", async () => {
  let reads = 0;
  const store = new ReplitProjectSecretBrokerStore(selection, () => { reads++; return environment(); });
  await assert.rejects(store.set(), /owner_provision_required/);
  await assert.rejects(store.setIfAbsent(), /owner_provision_required/);
  await assert.rejects(store.delete(), /owner_provision_required/);
  assert.equal(reads, 0);
});

test("missing/malformed/oversize/non-Ed25519 values have fixed non-secret errors", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  for (const value of [undefined, "", "private-sentinel-invalid", "x".repeat(4097), rsa,
    pem + pem, pem.replace("PRIVATE KEY", "ENCRYPTED PRIVATE KEY")]) {
    await assert.rejects(describeProjectSecretBrokerKey(selection, () => ({ [REPLIT_BROKER_SECRET_NAME]: value })),
      (e: Error) => /^broker_project_secret_(missing|invalid)$/.test(e.message));
  }
});

test("public description has only public material, stable fingerprint and honest custody", async () => {
  const result = await describeProjectSecretBrokerKey(selection, environment);
  assert.equal(result.created, false);
  assert.equal(result.policySigningKey.publicKeyPem, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.match(result.fingerprintSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await describeProjectSecretBrokerKey(selection, environment), result);
  assert.match(result.custody, /not native OS storage or a runtime-restricted/);
  assert.ok(!JSON.stringify(result).includes(pem));
  assert.deepEqual(Object.keys(result).sort(), ["actor", "keyId", "created", "fingerprintSha256", "policySigningKey", "custody"].sort());
});

test("canonical one-line base64 PEM produces the same public key and fingerprint", async () => {
  const encoded = Buffer.from(pem).toString("base64");
  const encodedEnvironment = () => ({ [REPLIT_BROKER_SECRET_NAME]: encoded });
  assert.deepEqual(await describeProjectSecretBrokerKey(selection, encodedEnvironment),
    await describeProjectSecretBrokerKey(selection, environment));
  const signer = await loadProjectSecretBrokerSigner(selection, encodedEnvironment);
  const message = Buffer.from("synthetic base64 signing challenge");
  assert.equal(verify(null, message, pair.publicKey, sign(null, message, signer.privateKey)), true);
});

test("encoded malformed, noncanonical, RSA and encrypted private material is refused with fixed errors", async () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const encoded = Buffer.from(pem).toString("base64");
  const encrypted = pem.replaceAll("PRIVATE KEY", "ENCRYPTED PRIVATE KEY");
  for (const value of ["not!base64", encoded + "=", encoded + "\n", "A",
    Buffer.from(rsa).toString("base64"), Buffer.from(encrypted).toString("base64"),
    Buffer.from([0xff, 0xfe]).toString("base64"), Buffer.from("private-sentinel").toString("base64"),
    Buffer.from(Buffer.from(pem).toString("base64")).toString("base64")]) {
    await assert.rejects(describeProjectSecretBrokerKey(selection, () => ({ [REPLIT_BROKER_SECRET_NAME]: value })),
      (e: Error) => e.message === "broker_project_secret_invalid");
  }
});

test("signer is broker-compatible and signs only as the bound actor/key", async () => {
  const signer = await loadProjectSecretBrokerSigner(selection, environment);
  assert.equal(signer.actor, selection.actor);
  assert.equal(signer.keyId, selection.keyId);
  const message = Buffer.from("synthetic broker challenge");
  assert.equal(verify(null, message, pair.publicKey, sign(null, message, signer.privateKey)), true);
});

const cli = fileURLToPath(new URL("./broker-project-secret-cli.ts", import.meta.url));
function run(args: string[], value?: string) {
  // No ambient app credentials or real environment values enter child fixtures.
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...(value ? { [REPLIT_BROKER_SECRET_NAME]: value } : {}) },
  });
}
const flags = ["--store", selection.store, "--actor", selection.actor, "--key-id", selection.keyId];
test("CLI init refuses with an existing or missing Secret; no private output", () => {
  for (const value of [undefined, pem]) {
    const result = run(["init", ...flags], value);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "broker_project_secret_owner_provision_required");
  }
});
test("CLI public requires opt-in, rejects duplicate/unknown args, and sanitizes errors", () => {
  for (const args of [["public"], ["public", ...flags, "--store", selection.store],
    ["public", ...flags, "--secret", "private-sentinel"]]) {
    const result = run(args, pem);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("private-sentinel"));
  }
  const invalid = run(["public", ...flags], "private-sentinel-invalid");
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.trim(), "broker_project_secret_invalid");
});
test("CLI public emits valid public-only JSON for a synthetic provisioned Secret", () => {
  for (const value of [pem, Buffer.from(pem).toString("base64")]) {
    const result = run(["public", ...flags], value);
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).policySigningKey.id, selection.keyId);
    assert.ok(!result.stdout.includes(value));
    assert.ok(!result.stdout.includes(pem));
  }
});
