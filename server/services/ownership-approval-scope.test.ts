import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RegistryTask } from "./shared-task-registry-service";
import { enrichOwnershipApprovalScopes, projectOwnershipApprovalScope } from "./ownership-approval-scope";
import { TaskOwnershipScope } from "../../client/src/components/admin/TaskOwnershipScope";
import type { OwnershipScopeStatus } from "@shared/task-ownership-scope";

const bytes = Buffer.from("Synthetic immutable task artifact — not canonical dialogue.");
const sha = createHash("sha256").update(bytes).digest("hex");
const binding = { taskRef: "123", artifactSha256: sha };
const task = (): RegistryTask => ({
  task_ref: binding.taskRef,
  repository_identity: "github:fixture/project",
  starting_commit: "a".repeat(40),
  source_kind: "hat",
  creator_actor: "luca-replit",
  source_thread: "a0000000-0000-4000-8000-000000000001",
  artifact_sha256: sha,
  artifact_base64: bytes.toString("base64"),
  definition: {
    title: "Synthetic task title",
    purpose: "Read the explicit source.",
    scope: ["Inspect the selected document."],
    exclusions: ["No changes or releases."],
  },
  state: "proposed", version: 0, created_at: new Date(0),
  ownership: { status: "not_assessed", grantsAuthority: false },
});
const project = (row: RegistryTask) => projectOwnershipApprovalScope(binding, { kind: "found", task: row });

test("only exact registered bytes and complete provenance produce verified scope", () => {
  const result = project(task());
  assert.equal(result.status, "verified");
  assert.equal(result.artifactHashMatch, true);
  assert.equal(result.definition?.creatorActor, "luca-replit");
  assert.deepEqual(result.definition?.scope, ["Inspect the selected document."]);
  assert.equal("ownership" in result, false);
  assert.equal("artifact_base64" in result, false);
});

test("empty exclusions and scope remain recorded arrays, not generated text", () => {
  const row = task();
  row.definition = { ...(row.definition as object), exclusions: [], scope: [] };
  assert.equal(project(row).status, "verified");
});

test("ordinary missing records and real unregistered bootstrap reservations differ", () => {
  assert.equal(projectOwnershipApprovalScope(binding, { kind: "missing", bootstrapReserved: false }).status, "missing_registry");
  assert.equal(projectOwnershipApprovalScope(binding, { kind: "missing", bootstrapReserved: true }).status, "unregistered_bootstrap");
});

test("a registered bootstrap with full metadata is not mistaken for unregistered", () => {
  const row = task();
  row.source_kind = "bootstrap";
  assert.equal(project(row).status, "verified");
});

test("an unavailable registry never invents scope", () => {
  const result = projectOwnershipApprovalScope(binding, { kind: "unavailable" });
  assert.equal(result.status, "registry_unavailable");
  assert.equal(result.definition, undefined);
});

test("artifact mismatch retains both hashes but does not show canonical request scope", () => {
  const result = projectOwnershipApprovalScope({ ...binding, artifactSha256: "b".repeat(64) }, { kind: "found", task: task() });
  assert.equal(result.status, "hash_mismatch");
  assert.equal(result.artifactHashMatch, false);
  assert.equal(result.registeredArtifactSha256, sha);
  assert.equal(result.definition, undefined);
});

for (const [name, mutate] of [
  ["wrong reference", (row: RegistryTask) => { row.task_ref = "456"; }],
  ["altered bytes", (row: RegistryTask) => { row.artifact_base64 = Buffer.from("changed").toString("base64"); }],
  ["noncanonical base64", (row: RegistryTask) => { row.artifact_base64 += "\n"; }],
  ["invalid UTF8", (row: RegistryTask) => {
    const invalid = Buffer.from([0xff]);
    row.artifact_base64 = invalid.toString("base64");
    row.artifact_sha256 = createHash("sha256").update(invalid).digest("hex");
  }],
  ["malformed stored hash", (row: RegistryTask) => { row.artifact_sha256 = "not-a-hash"; }],
] as const) {
  test(`registry integrity fails closed for ${name}`, () => {
    const row = task(); mutate(row);
    const result = project(row);
    assert.equal(result.status, "registry_invalid");
    assert.equal(result.definition, undefined);
  });
}

for (const [name, mutate] of [
  ["legacy provenance", (row: RegistryTask) => { row.source_kind = "legacy"; }],
  ["missing creator", (row: RegistryTask) => { row.creator_actor = null; }],
  ["missing source thread", (row: RegistryTask) => { row.source_thread = null; }],
  ["invalid source thread", (row: RegistryTask) => { row.source_thread = "not-a-thread"; }],
  ["unknown source kind", (row: RegistryTask) => { row.source_kind = "invented"; }],
  ["missing purpose", (row: RegistryTask) => { (row.definition as any).purpose = null; }],
  ["unstructured scope", (row: RegistryTask) => { (row.definition as any).scope = "guess"; }],
  ["null exclusions", (row: RegistryTask) => { (row.definition as any).exclusions = null; }],
] as const) {
  test(`unavailable metadata is explicit for ${name}`, () => {
    const row = task(); mutate(row);
    const result = project(row);
    assert.equal(result.status, "metadata_unavailable");
    assert.equal(result.artifactHashMatch, true);
    assert.equal(result.definition, undefined);
  });
}

test("all challenge/receipt lifecycle states survive metadata enrichment unchanged", async () => {
  const input = ["pending", "approved", "rejected", "expired", "revoked"].map(status => ({
    ...binding, status, intendedActor: "luca-replit", keyFingerprint: "fixture",
    expiresAt: "2000-01-01T00:00:00.000Z", receipt: { status },
  }));
  let reads = 0;
  const output = await enrichOwnershipApprovalScopes(input, async () => { reads++; return { kind: "found", task: task() }; });
  assert.equal(reads, 1);
  for (let i = 0; i < input.length; i++) {
    const { scopeContext, ...unchanged } = output[i];
    assert.deepEqual(unchanged, input[i]);
    assert.equal(scopeContext.status, "verified");
  }
});

test("lookup exceptions are isolated and parallel registry reads are bounded", async () => {
  let active = 0; let peak = 0;
  const input = Array.from({ length: 11 }, (_, i) => ({ taskRef: String(i + 1), artifactSha256: sha }));
  const output = await enrichOwnershipApprovalScopes(input, async ref => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (ref === "1") throw new Error("private diagnostic should not leak");
    return { kind: "missing", bootstrapReserved: false };
  });
  assert.ok(peak <= 4);
  assert.equal(output[0].scopeContext.status, "registry_unavailable");
  assert.ok(output.slice(1).every(row => row.scopeContext.status === "missing_registry"));
  assert.doesNotMatch(JSON.stringify(output), /private diagnostic/);
});

test("verified UI renders actual scope/provenance and escapes registry text", () => {
  const row = task();
  (row.definition as any).title = "<script>alert('unsafe')</script>";
  const html = renderToStaticMarkup(React.createElement(TaskOwnershipScope, { context: project(row) }));
  assert.match(html, /Included scope/);
  assert.match(html, /No changes or releases/);
  assert.match(html, /Authenticated registry creator/);
  assert.match(html, /Source thread/);
  assert.match(html, /Exact artifact hash matches/);
  assert.match(html, /does not grant approval/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /Verified Candidate|Promotion Context/);
});

test("every nonverified state renders its warning without canonical scope", () => {
  const statuses: OwnershipScopeStatus[] = ["missing_registry", "unregistered_bootstrap", "metadata_unavailable", "hash_mismatch", "registry_unavailable", "registry_invalid"];
  for (const status of statuses) {
    const html = renderToStaticMarkup(React.createElement(TaskOwnershipScope, { context: { ...binding, submittedArtifactSha256: sha, status, artifactHashMatch: null } }));
    assert.match(html, new RegExp(`task-scope-${status}`));
    assert.doesNotMatch(html, /Included scope|Exact artifact hash matches/);
  }
  assert.match(renderToStaticMarkup(React.createElement(TaskOwnershipScope)), /Scope metadata unavailable/);
});
