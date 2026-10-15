import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { promotionContextDigest, type PromotionCandidate } from "./promotion-candidate";
import { checkedPromotionDescriptor, loadPromotionApprovalContexts, projectPromotionApprovalContext, requireVerifiedPromotionContext, type StoredPromotionContext } from "./promotion-approval-context";
import { PromotionApprovalContext } from "../../client/src/components/admin/PromotionApprovalContext";
import { ownershipProofPayload } from "./task-ownership-proof-payload";

const descriptor: PromotionCandidate = { purpose: "cross-tool-promote", repository: "github:davidwmcintosh/holahola", branch: "fixture/review", candidateCommit: "a".repeat(40) };
const digest = promotionContextDigest(descriptor);
const binding = { id: "fixture-challenge", contextDigest: digest };
const stored = (): StoredPromotionContext => ({ challenge_id: binding.id, context_digest: digest, parent_context_digest: digest, descriptor: { ...descriptor } });

test("only null/absent contexts are context-free", () => {
  assert.equal(projectPromotionApprovalContext({ id: "free" }, false).status, "context_free");
  assert.equal(projectPromotionApprovalContext(binding, false).status, "storage_unavailable");
  assert.equal(projectPromotionApprovalContext(binding, true).status, "descriptor_missing");
});
test("four-field descriptor verifies exact existing canonical digest", () => {
  const result = projectPromotionApprovalContext(binding, true, stored());
  assert.equal(result.status, "verified");
  assert.equal(result.computedDigest, digest);
  assert.deepEqual(result.descriptor, descriptor);
});
for (const field of ["purpose", "repository", "branch", "candidateCommit"] as const) {
  test(`changed ${field} cannot verify`, () => {
    const row = stored();
    (row.descriptor as any)[field] = field === "candidateCommit" ? "b".repeat(40) : "changed";
    assert.notEqual(projectPromotionApprovalContext(binding, true, row).status, "verified");
  });
}
test("cross-challenge and parent/receipt digest mismatches fail closed", () => {
  for (const field of ["challenge_id", "context_digest", "parent_context_digest"] as const) {
    const row = stored(); row[field] = "changed";
    assert.equal(projectPromotionApprovalContext(binding, true, row).status, "hash_mismatch");
  }
});
test("no extra descriptor fields or digest-only requests are accepted", () => {
  assert.throws(() => checkedPromotionDescriptor({ ...descriptor, taskStartingCommit: descriptor.candidateCommit }, digest));
  assert.throws(() => checkedPromotionDescriptor(undefined, digest));
  assert.throws(() => checkedPromotionDescriptor(descriptor, "b".repeat(64)));
});
test("catalog absence differs from missing descriptor, and context-free avoids all storage I/O", async () => {
  let calls = 0;
  const absent = { execute: async () => { calls++; return [{ relation: null }]; } };
  assert.equal((await loadPromotionApprovalContexts([binding], absent)).get(binding.id)?.status, "storage_unavailable");
  assert.equal(calls, 1);
  calls = 0;
  const present = { execute: async () => ++calls === 1 ? [{ relation: "table" }] : [] };
  assert.equal((await loadPromotionApprovalContexts([binding], present)).get(binding.id)?.status, "descriptor_missing");
  const noRead = { execute: async () => { throw new Error("must not read"); } };
  await requireVerifiedPromotionContext({ id: "free" }, noRead);
  await assert.rejects(requireVerifiedPromotionContext(binding, absent), /PROMOTION_CONTEXT_UNAVAILABLE/);
});
test("verified context permits the check; a storage exception is not mistaken for a missing row", async () => {
  let calls = 0;
  await requireVerifiedPromotionContext(binding, { execute: async () => ++calls === 1 ? [{ relation: "table" }] : [stored()] });
  const failed = await loadPromotionApprovalContexts([binding], { execute: async () => { throw new Error("private diagnostics"); } });
  assert.equal(failed.get(binding.id)?.status, "storage_unavailable");
  assert.doesNotMatch(JSON.stringify([...failed]), /private diagnostics/);
});
test("context-free signed payload remains unchanged", () => {
  const receipt = { id: "receipt", challengeId: "challenge", taskRef: "123", intendedActor: "luca-replit", publicKey: "fixture-public-key", payloadDigest: "d".repeat(64), expiresAt: new Date(0), artifactSha256: "f".repeat(64), keyFingerprint: "e".repeat(64) };
  const nonce = { id: "nonce", nonce: "fixture", expiresAt: new Date(0) };
  assert.deepEqual(ownershipProofPayload(receipt as any, nonce as any), ownershipProofPayload({ ...receipt, contextDigest: null } as any, nonce as any));
  assert.equal("contextDigest" in ownershipProofPayload(receipt as any, nonce as any), false);
});
test("candidate UI distinguishes task starting commit and shows every exact field", () => {
  const context = projectPromotionApprovalContext(binding, true, stored());
  const html = renderToStaticMarkup(React.createElement(PromotionApprovalContext, { context, contextDigest: digest, purpose: "source_promotion" }));
  assert.match(html, /Exact promotion candidate/);
  assert.match(html, /fixture\/review/);
  assert.match(html, /Candidate commit/);
  assert.match(html, /not the task starting commit/);
  assert.match(html, /independently recheck/);
  const unknown = renderToStaticMarkup(React.createElement(PromotionApprovalContext, { contextDigest: digest }));
  assert.match(unknown, /Approval is unavailable/);
});

test("approval purposes are explicit and legacy digests never become provisioning", async () => {
  const { checkedOwnershipPurpose, requireOwnershipContext } = await import("./ownership-context-purpose");
  assert.equal(checkedOwnershipPurpose("ownership", null), "ownership");
  assert.equal(checkedOwnershipPurpose(null, null), "ownership");
  assert.equal(checkedOwnershipPurpose("runtime_provisioning", digest), "runtime_provisioning");
  assert.equal(checkedOwnershipPurpose("source_promotion", digest), "source_promotion");
  for (const [purpose, context] of [[null, digest], ["ownership", digest], ["runtime_provisioning", null], ["source_promotion", null]]) {
    assert.throws(() => checkedOwnershipPurpose(purpose, context), /OWNERSHIP_PURPOSE_INVALID/);
  }
  let reads = 0;
  const runtime = { execute: async () => {
    reads++;
    return [{ purpose: "runtime_provisioning", context_digest: digest }];
  } };
  assert.equal(await requireOwnershipContext(binding, runtime), "runtime_provisioning");
  assert.equal(reads, 1, "provisioning must not infer its purpose from promotion storage");
  await assert.rejects(requireOwnershipContext(binding, runtime, "source_promotion"), /OWNERSHIP_PURPOSE_MISMATCH/);
  const promotion = { execute: async () => [{ purpose: "source_promotion", context_digest: digest }] };
  await assert.rejects(requireOwnershipContext(binding, promotion, "runtime_provisioning"), /OWNERSHIP_PURPOSE_MISMATCH/);
  await assert.rejects(requireOwnershipContext(binding, { execute: async () => [{ purpose: null, context_digest: digest }] }), /OWNERSHIP_PURPOSE_INVALID/);
  await assert.rejects(requireOwnershipContext(binding, { execute: async () => [{ purpose: "runtime_provisioning", context_digest: "0".repeat(64) }] }), /OWNERSHIP_CONTEXT_MISMATCH/);
});

test("the founder UI separates provisioning bundles from promotion and blocks legacy intent", () => {
  const html = renderToStaticMarkup(React.createElement(PromotionApprovalContext, {
    purpose: "runtime_provisioning", contextDigest: digest,
  }));
  assert.match(html, /Runtime provisioning approval/);
  assert.match(html, /does not approve publishing/);
  assert.doesNotMatch(html, /Exact promotion candidate|descriptor_missing/);
  const legacy = renderToStaticMarkup(React.createElement(PromotionApprovalContext, { contextDigest: digest }));
  assert.match(legacy, /purpose is unclassified/);
  assert.match(legacy, /Approval is unavailable/);
});
