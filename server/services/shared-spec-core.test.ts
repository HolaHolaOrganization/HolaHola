import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySharedSpecRepository,
  SharedSpecCore,
  SharedSpecDomainError,
  hashSharedSpecMarkdown,
  type SharedSpecDocument,
  type SharedSpecRepository,
  type SharedSpecRevision,
} from "./shared-spec-core";

const author = { actorId: "author" };
const reviewer = { actorId: "reviewer" };
const admin = { actorId: "admin", capabilities: ["policy_admin"] as const };

async function setup() {
  let id = 0;
  const core = new SharedSpecCore(new InMemorySharedSpecRepository(), {
    newId: () => `id-${++id}`,
    now: () => new Date("2026-09-06T00:00:00.000Z"),
  });
  await core.setReviewerPolicy(admin, {
    actorId: reviewer.actorId, capability: "reviewer", active: true, idempotencyKey: "reviewer-on",
  });
  const created = await core.createDocument(author, {
    title: "Portable core", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/portable.md", markdown: "# One\n",
    idempotencyKey: "create",
  });
  return { core, created };
}

test("compare-and-swap admits one concurrent append and leaves the loser non-mutating", async () => {
  const { core, created } = await setup();
  const results = await Promise.allSettled([
    core.appendRevision(author, { documentId: created.document.id, baseRevisionId: created.revision.id, markdown: "# Two\n", idempotencyKey: "first" }),
    core.appendRevision({ actorId: "other" }, { documentId: created.document.id, baseRevisionId: created.revision.id, markdown: "# Three\n", idempotencyKey: "second" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal((rejected!.reason as SharedSpecDomainError).code, "CONFLICT");
  assert.equal((await core.listRevisions(created.document.id)).length, 2);
});

// Task 1662: listReviewerQueue's open_eligible case (task 1658) made a fully
// open pending review discoverable by every eligible reviewer at once, so two
// reviewers racing to claim it is now a realistic scenario. claimReview reads
// the review, checks claimedReviewerActorId is unset, then writes it, inside
// one transaction; compareAndSetReviewClaim is the guard that stops two
// concurrent claims from both landing. InMemorySharedSpecRepository's
// transaction() fully serializes (see its class comment), so -- exactly like
// the compare-and-swap append test above, whose loser is actually rejected by
// appendRevision's own currentRevisionId pre-check rather than reaching
// compareAndSetCurrentRevision -- the loser here is rejected by claimReview's
// pre-check (INVALID_STATE) rather than by reaching the new CAS (CONFLICT).
// That still proves the domain-level contract (exactly one claim ever wins,
// the loser never mutates the row) using this file's established concurrency
// model; genuine cross-transaction interleaving against real PostgreSQL is
// proven separately by
// server/scripts/test-shared-spec-review-claim-race-postgres.test.ts, which
// reproducibly caught both actors winning before compareAndSetReviewClaim
// existed.
test("two concurrent claimReview calls against the same open review yield exactly one success and one clean rejection", async () => {
  const { core, created } = await setup();
  await core.setReviewerPolicy(admin, {
    actorId: "reviewer-two", capability: "reviewer", active: true, idempotencyKey: "reviewer-two-on",
  });
  const review = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready-claim-race",
  });
  const results = await Promise.allSettled([
    core.claimReview(reviewer, review.id, "claim-race-first"),
    core.claimReview({ actorId: "reviewer-two" }, review.id, "claim-race-second"),
  ]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof core.claimReview>>> => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(
    ["CONFLICT", "INVALID_STATE"].includes((rejected!.reason as SharedSpecDomainError).code),
    `expected a clean domain rejection, got ${rejected!.reason}`,
  );
  // The loser never mutated the row: the persisted claimant is exactly the winner's.
  const finalReview = await core.getReview(review.id);
  assert.equal(finalReview.claimedReviewerActorId, fulfilled[0].value.claimedReviewerActorId);
});

test("idempotency returns matching revision and rejects different request reuse", async () => {
  const { core, created } = await setup();
  const input = { documentId: created.document.id, baseRevisionId: created.revision.id, markdown: "# Two\n", idempotencyKey: "append" };
  const first = await core.appendRevision(author, input);
  assert.equal((await core.appendRevision(author, input)).id, first.id);
  await assert.rejects(
    () => core.appendRevision(author, { ...input, markdown: "# Different\n" }),
    (error: SharedSpecDomainError) => error.code === "IDEMPOTENCY_MISMATCH",
  );
});

test("authors cannot claim or approve their own revision", async () => {
  const { core, created } = await setup();
  const review = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready",
  });
  await assert.rejects(
    () => core.claimReview(author, review.id, "self-claim"),
    (error: SharedSpecDomainError) => error.code === "FORBIDDEN",
  );
});

test("ready review retains its requester and exact mutation digest", async () => {
  const { core, created } = await setup();
  const review = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready-requester",
  });
  assert.equal(review.requestedByActorId, author.actorId);
  assert.match(review.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(created.revision.requestDigest.length, 64);
});

test("listReviewsForReviewer surfaces only this actor's pending queue: assigned-but-unclaimed and claimed, never someone else's or a decided review", async () => {
  const { core, created } = await setup();
  await core.setReviewerPolicy(admin, {
    actorId: "alden", capability: "reviewer", active: true, idempotencyKey: "alden-reviewer-on",
  });

  // Assigned to alden, not yet claimed -- must appear.
  const assigned = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id,
    requestedReviewerActorId: "alden", idempotencyKey: "ready-assigned",
  });

  // Open (unassigned) review claimed by a different actor -- must never appear for alden.
  const otherDoc = await core.createDocument(author, {
    title: "Other doc", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/other.md", markdown: "# Other\n", idempotencyKey: "create-other",
  });
  const claimedByOther = await core.markRevisionReady(author, {
    documentId: otherDoc.document.id, revisionId: otherDoc.revision.id, idempotencyKey: "ready-open",
  });
  await core.claimReview(reviewer, claimedByOther.id, "claim-open");

  // Open review alden claims himself -- must appear even though never explicitly requestedReviewerActorId.
  const claimableDoc = await core.createDocument(author, {
    title: "Claimable doc", kind: "architecture", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/claimable.md", markdown: "# Claimable\n", idempotencyKey: "create-claimable",
  });
  const claimable = await core.markRevisionReady(author, {
    documentId: claimableDoc.document.id, revisionId: claimableDoc.revision.id, idempotencyKey: "ready-claimable",
  });
  await core.claimReview({ actorId: "alden" }, claimable.id, "claim-by-alden");

  // Assigned to and decided by alden -- must drop out once no longer pending.
  const decidedDoc = await core.createDocument(author, {
    title: "Decided doc", kind: "architecture", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/decided.md", markdown: "# Decided\n", idempotencyKey: "create-decided",
  });
  const decided = await core.markRevisionReady(author, {
    documentId: decidedDoc.document.id, revisionId: decidedDoc.revision.id,
    requestedReviewerActorId: "alden", idempotencyKey: "ready-decided",
  });
  await core.claimReview({ actorId: "alden" }, decided.id, "claim-decided");
  await core.approveReview({ actorId: "alden" }, { reviewId: decided.id, idempotencyKey: "approve-decided" });

  const queue = await core.listReviewsForReviewer("alden");
  assert.deepEqual(queue.map(review => review.id).sort(), [assigned.id, claimable.id].sort());
  assert.ok(queue.every(review => review.state === "pending"));
  assert.equal((await core.listReviewsForReviewer("nobody-registered")).length, 0);
});

test("listReviewerQueue adds fully-open reviews alden is eligible to claim, correctly labelled and excluding every ineligible case", async () => {
  const { core, created } = await setup();
  // Deliberately alden's only policy, restricted to "design" -- exercises the
  // kind-mismatch exclusion below without a second, later policy version
  // that would otherwise shadow it for every kind (see getActivePolicy).
  await core.setReviewerPolicy(admin, {
    actorId: "alden", capability: "reviewer", active: true, documentKind: "design", idempotencyKey: "alden-reviewer-design-only",
  });

  // Assigned to alden, not yet claimed -- "assigned".
  const assigned = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id,
    requestedReviewerActorId: "alden", idempotencyKey: "ready-assigned",
  });

  // Fully open, right kind, alden not the author -- "open_eligible".
  const openEligibleDoc = await core.createDocument(author, {
    title: "Open eligible", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/open-eligible.md", markdown: "# Open eligible\n", idempotencyKey: "create-open-eligible",
  });
  const openEligible = await core.markRevisionReady(author, {
    documentId: openEligibleDoc.document.id, revisionId: openEligibleDoc.revision.id, idempotencyKey: "ready-open-eligible",
  });

  // Fully open, but alden claims it himself -- must show as "claimed", not "open_eligible".
  const claimableDoc = await core.createDocument(author, {
    title: "Claimed by alden", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/claimed-by-alden.md", markdown: "# Claimed by alden\n", idempotencyKey: "create-claimed-by-alden",
  });
  const claimedByAlden = await core.markRevisionReady(author, {
    documentId: claimableDoc.document.id, revisionId: claimableDoc.revision.id, idempotencyKey: "ready-claimed-by-alden",
  });
  await core.claimReview({ actorId: "alden" }, claimedByAlden.id, "claim-by-alden");

  // Fully open, but a different actor already claimed it -- never shown to alden.
  const claimedByOtherDoc = await core.createDocument(author, {
    title: "Claimed by reviewer", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/claimed-by-reviewer.md", markdown: "# Claimed by reviewer\n", idempotencyKey: "create-claimed-by-other",
  });
  const claimedByOther = await core.markRevisionReady(author, {
    documentId: claimedByOtherDoc.document.id, revisionId: claimedByOtherDoc.revision.id, idempotencyKey: "ready-claimed-by-other",
  });
  await core.claimReview(reviewer, claimedByOther.id, "claim-by-reviewer");

  // Assigned to a different, specific actor -- not open, so excluded even though alden is otherwise eligible.
  const assignedToOtherDoc = await core.createDocument(author, {
    title: "Assigned to reviewer", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/assigned-to-reviewer.md", markdown: "# Assigned to reviewer\n", idempotencyKey: "create-assigned-to-other",
  });
  await core.markRevisionReady(author, {
    documentId: assignedToOtherDoc.document.id, revisionId: assignedToOtherDoc.revision.id,
    requestedReviewerActorId: reviewer.actorId, idempotencyKey: "ready-assigned-to-other",
  });

  // Fully open, right kind, but alden authored it himself -- excluded (no self-review).
  const selfAuthoredDoc = await core.createDocument({ actorId: "alden" }, {
    title: "Alden's own design doc", kind: "design", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/alden-authored.md", markdown: "# Alden's own\n", idempotencyKey: "create-alden-authored",
  });
  await core.markRevisionReady({ actorId: "alden" }, {
    documentId: selfAuthoredDoc.document.id, revisionId: selfAuthoredDoc.revision.id, idempotencyKey: "ready-alden-authored",
  });

  // Fully open, but of a kind alden's policy does not cover -- excluded.
  const wrongKindDoc = await core.createDocument(author, {
    title: "Wrong kind", kind: "architecture", repository: "hola/hola",
    gitPath: "docs/superpowers/specs/wrong-kind.md", markdown: "# Wrong kind\n", idempotencyKey: "create-wrong-kind",
  });
  await core.markRevisionReady(author, {
    documentId: wrongKindDoc.document.id, revisionId: wrongKindDoc.revision.id, idempotencyKey: "ready-wrong-kind",
  });

  const queue = await core.listReviewerQueue("alden");
  const relationshipById = Object.fromEntries(queue.map(entry => [entry.review.id, entry.relationship]));
  assert.deepEqual(relationshipById, {
    [assigned.id]: "assigned",
    [openEligible.id]: "open_eligible",
    [claimedByAlden.id]: "claimed",
  });
  assert.equal(queue.length, 3, `unexpected extra/missing entries: ${JSON.stringify(relationshipById)}`);
  assert.equal((await core.listReviewerQueue("nobody-registered")).length, 0);
});

test("listReviewerQueue omits a pending review whose revision was superseded by a newer revision", async () => {
  const { core, created: doc } = await setup();
  const stale = await core.markRevisionReady(author, {
    documentId: doc.document.id, revisionId: doc.revision.id,
    requestedReviewerActorId: reviewer.actorId, idempotencyKey: "ready-superseded-v1",
  });
  assert.deepEqual((await core.listReviewerQueue(reviewer.actorId)).map(e => e.review.id), [stale.id]);

  const v2 = await core.appendRevision(author, {
    documentId: doc.document.id, baseRevisionId: doc.revision.id, markdown: "# v2\n", idempotencyKey: "revise-superseded-v2",
  });
  assert.equal((await core.listReviewerQueue(reviewer.actorId)).length, 0, "the v1 request can no longer be decided, so it is not queue work");
  assert.equal((await core.listReviewsForReviewer(reviewer.actorId)).length, 0, "the v1 request is auto-closed, so listReviewsForReviewer also omits it");
  const cancelledStale = await core.getReview(stale.id);
  assert.equal(cancelledStale.state, "cancelled", "superseded pending review transitions to state = 'cancelled'");
  assert.ok(cancelledStale.cancelledAt instanceof Date, "cancelledAt timestamp is recorded when auto-closed");

  const fresh = await core.markRevisionReady(author, {
    documentId: doc.document.id, revisionId: v2.id,
    requestedReviewerActorId: reviewer.actorId, idempotencyKey: "ready-superseded-v2",
  });
  assert.deepEqual((await core.listReviewerQueue(reviewer.actorId)).map(e => e.review.id), [fresh.id]);
});

test("appendRevision and shareDocument auto-close superseded pending reviews while preserving already-decided reviews", async () => {
  const { core, created: doc } = await setup();
  // First revision is approved -> state = "approved"
  const approvedReview = await core.markRevisionReady(author, {
    documentId: doc.document.id, revisionId: doc.revision.id,
    requestedReviewerActorId: reviewer.actorId, idempotencyKey: "ready-v1-approve",
  });
  await core.claimReview(reviewer, approvedReview.id, "claim-v1-approve");
  await core.approveReview(reviewer, { reviewId: approvedReview.id, idempotencyKey: "approve-v1" });

  // Second revision is marked ready (unassigned open review) then superseded by v3 before anyone decides it
  const v2 = await core.appendRevision(author, {
    documentId: doc.document.id, baseRevisionId: doc.revision.id, markdown: "# v2\n", idempotencyKey: "append-v2",
  });
  const openPendingV2 = await core.markRevisionReady(author, {
    documentId: doc.document.id, revisionId: v2.id, idempotencyKey: "ready-v2-open",
  });
  assert.equal((await core.getReview(openPendingV2.id)).state, "pending");

  const v3 = await core.appendRevision(author, {
    documentId: doc.document.id, baseRevisionId: v2.id, markdown: "# v3\n", idempotencyKey: "append-v3",
  });
  const afterV3 = await core.getReview(openPendingV2.id);
  assert.equal(afterV3.state, "cancelled");
  assert.ok(afterV3.cancelledAt instanceof Date);

  // The earlier approved review on v1 must remain "approved" with no cancelledAt
  const preservedApproved = await core.getReview(approvedReview.id);
  assert.equal(preservedApproved.state, "approved");
  assert.equal(preservedApproved.cancelledAt, undefined);

  // Claiming, assigning, or deciding the auto-closed v2 review fails cleanly
  await assert.rejects(
    () => core.claimReview(reviewer, openPendingV2.id, "claim-cancelled-v2"),
    (error: SharedSpecDomainError) => error.code === "INVALID_STATE",
  );
  await assert.rejects(
    () => core.assignReview(admin, openPendingV2.id, reviewer.actorId, "assign-cancelled-v2"),
    (error: SharedSpecDomainError) => error.code === "INVALID_STATE",
  );
  assert.equal(v3.parentRevisionId, v2.id);

  // Fast-share note revise path also auto-closes a pending review on the note's prior revision
  const note = await core.shareDocument(author, {
    repository: "hola/hola", gitPath: "notes/superseded-note.md", markdown: "# Note v1\n", idempotencyKey: "share-note-v1",
  });
  const noteReview = await core.markRevisionReady(author, {
    documentId: note.document.id, revisionId: note.revision.id,
    requestedReviewerActorId: reviewer.actorId, idempotencyKey: "ready-note-v1",
  });
  await core.shareDocument(author, {
    repository: "hola/hola", gitPath: "notes/superseded-note.md", markdown: "# Note v2\n",
    baseRevisionId: note.revision.id, idempotencyKey: "share-note-v2",
  });
  const closedNoteReview = await core.getReview(noteReview.id);
  assert.equal(closedNoteReview.state, "cancelled");
  assert.ok(closedNoteReview.cancelledAt instanceof Date);
});

test("creation only accepts canonical repository and safe spec namespace", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  const input = { title: "x", kind: "design" as const, repository: "owner/repo", gitPath: "docs/superpowers/specs/safe.md", markdown: "# x", idempotencyKey: "x" };
  await assert.rejects(() => core.createDocument(author, { ...input, repository: "owner/repo/extra" }), (error: SharedSpecDomainError) => error.code === "VALIDATION");
  await assert.rejects(() => core.createDocument(author, { ...input, gitPath: "docs/superpowers/specs/../unsafe.md" }), (error: SharedSpecDomainError) => error.code === "VALIDATION");
});

test("default identifiers remain unique across independent core instances", async () => {
  const first = new SharedSpecCore(new InMemorySharedSpecRepository());
  const second = new SharedSpecCore(new InMemorySharedSpecRepository());
  const input = {
    title: "Restart-safe identifiers",
    summary: "Confirms independent application processes cannot reuse document IDs.",
    kind: "architecture" as const,
    repository: "hola-hola/app",
    gitPath: "docs/superpowers/specs/restart-safe-identifiers.md",
    markdown: "# Restart-safe identifiers\n",
    idempotencyKey: "create",
  };
  const [left, right] = await Promise.all([
    first.createDocument(author, input),
    second.createDocument(author, input),
  ]);
  assert.notEqual(left.document.id, right.document.id);
  assert.match(left.document.id, /^[0-9a-f-]{36}$/);
  assert.match(right.document.id, /^[0-9a-f-]{36}$/);
});

test("approval changes only the current ready document and rejection restores draft", async () => {
  const { core, created } = await setup();
  const review = await core.markRevisionReady(author, { documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready-state" });
  await core.claimReview(reviewer, review.id, "claim-state");
  await core.rejectReview(reviewer, { reviewId: review.id, idempotencyKey: "reject-state" });
  assert.equal((await core.showDocument(created.document.id)).document.state, "draft");
  await assert.rejects(() => core.markRevisionReady(author, { documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "duplicate" }), (error: SharedSpecDomainError) => error.code === "CONFLICT");
  const revision = await core.appendRevision(author, { documentId: created.document.id, baseRevisionId: created.revision.id, markdown: "# revised", idempotencyKey: "revised" });
  const second = await core.markRevisionReady(author, { documentId: created.document.id, revisionId: revision.id, idempotencyKey: "ready-second" });
  await core.claimReview(reviewer, second.id, "claim-second");
  await core.approveReview(reviewer, { reviewId: second.id, idempotencyKey: "approve-state" });
  assert.equal((await core.showDocument(created.document.id)).document.state, "approved");
  await assert.rejects(() => core.markRevisionReady(author, { documentId: created.document.id, revisionId: revision.id, idempotencyKey: "after-approval" }), (error: SharedSpecDomainError) => error.code === "INVALID_STATE");
});

test("policy administration is separately authorized and approvals bind policy version", async () => {
  const { core, created } = await setup();
  await assert.rejects(
    () => core.setReviewerPolicy(author, { actorId: "new-reviewer", capability: "reviewer", active: true, idempotencyKey: "forbidden" }),
    (error: SharedSpecDomainError) => error.code === "FORBIDDEN",
  );
  const review = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready",
  });
  await core.claimReview(reviewer, review.id, "claim");
  const approved = await core.approveReview(reviewer, { reviewId: review.id, rationale: "looks good", idempotencyKey: "approve" });
  assert.equal(approved.decisionPolicyVersion, 1);
  await core.setReviewerPolicy(admin, {
    actorId: reviewer.actorId, capability: "reviewer", active: false, idempotencyKey: "reviewer-off",
  });
  assert.equal(approved.decisionPolicyVersion, 1);
  assert.ok(approved.decisionPolicyVersionId);
});

test("historical approval and exact approved byte export survive later edits and policy removal", async () => {
  const { core, created } = await setup();
  const review = await core.markRevisionReady(author, {
    documentId: created.document.id, revisionId: created.revision.id, idempotencyKey: "ready",
  });
  await core.claimReview(reviewer, review.id, "claim");
  await core.approveReview(reviewer, { reviewId: review.id, idempotencyKey: "approve" });
  await core.appendRevision(author, {
    documentId: created.document.id, baseRevisionId: created.revision.id, markdown: "# Changed\n", idempotencyKey: "edit",
  });
  await core.setReviewerPolicy(admin, {
    actorId: reviewer.actorId, capability: "reviewer", active: false, idempotencyKey: "reviewer-off",
  });
  const exported = await core.exportApprovedBytes(created.document.id, created.revision.id);
  assert.deepEqual(exported.bytes, Buffer.from("# One\n", "utf8"));
  assert.equal(exported.revision.contentHash, hashSharedSpecMarkdown(exported.bytes.toString("utf8")));
});

test("share creates a note on first call, revises it on a matching base, and rejects a stale or missing base", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  const created = await core.shareDocument(author, {
    repository: "hola/hola", gitPath: "notes/finding.md", markdown: "# First\n", idempotencyKey: "share-1",
  });
  assert.equal(created.created, true);
  assert.equal(created.document.kind, "note");
  assert.equal(created.document.state, "draft");
  assert.equal(created.revision.parentRevisionId, undefined);

  const revised = await core.shareDocument({ actorId: "other-hat" }, {
    repository: "hola/hola", gitPath: "notes/finding.md", markdown: "# Second\n",
    baseRevisionId: created.revision.id, idempotencyKey: "share-2",
  });
  assert.equal(revised.created, false);
  assert.equal(revised.revision.parentRevisionId, created.revision.id);
  assert.equal((await core.findByDestination("hola/hola", "notes/finding.md"))?.currentRevision.id, revised.revision.id);

  await assert.rejects(
    () => core.shareDocument(author, { repository: "hola/hola", gitPath: "notes/finding.md", markdown: "# Stale\n", baseRevisionId: created.revision.id, idempotencyKey: "share-3" }),
    (error: SharedSpecDomainError) => error.code === "CONFLICT",
  );
  await assert.rejects(
    () => core.shareDocument(author, { repository: "hola/hola", gitPath: "notes/finding.md", markdown: "# Missing base\n", idempotencyKey: "share-4" }),
    (error: SharedSpecDomainError) => error.code === "CONFLICT",
  );
});

test("sharing without a title derives one from the path, and idempotent replay returns the exact same revision", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  const input = { repository: "hola/hola", gitPath: "notes/gate3-verifier-coprovisioning-gap.md", markdown: "# Finding\n", idempotencyKey: "share-once" };
  const first = await core.shareDocument(author, input);
  assert.equal(first.document.title, "gate3-verifier-coprovisioning-gap");
  const replay = await core.shareDocument(author, input);
  assert.equal(replay.revision.id, first.revision.id);
  assert.equal(replay.created, true);
  await assert.rejects(
    () => core.shareDocument(author, { ...input, markdown: "# Different\n" }),
    (error: SharedSpecDomainError) => error.code === "IDEMPOTENCY_MISMATCH",
  );
});

test("share only accepts the notes/ namespace, never the reviewed specs namespace", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  await assert.rejects(
    () => core.shareDocument(author, { repository: "hola/hola", gitPath: "docs/superpowers/specs/not-a-note.md", markdown: "# x\n", idempotencyKey: "bad-path" }),
    (error: SharedSpecDomainError) => error.code === "VALIDATION",
  );
});

test("a lost create race against a brand-new note path surfaces the same clean conflict as a lost revise race, never a raw database error", async () => {
  // The in-memory repository serializes transactions one at a time, so two
  // genuinely concurrent shareDocument calls can never both observe "nothing
  // here yet" the way two real database transactions can under read-committed
  // isolation. This repository shim forces that exact interleaving
  // deterministically: the first destination lookup inside shareDocument's
  // own transaction reports "not found" (as a real racing reader would), but
  // insertDocument then fails with the same low-level shape a real unique-
  // index violation carries, because a "winner" row already committed to the
  // underlying store first.
  const winner: SharedSpecDocument = {
    id: "winner-doc", title: "race", kind: "note", repository: "hola/hola", gitPath: "notes/race.md",
    currentRevisionId: "winner-rev", state: "draft", creatorActorId: "other-hat",
    createdAt: new Date("2026-09-06T00:00:00.000Z"), updatedAt: new Date("2026-09-06T00:00:00.000Z"),
  };
  const winnerRevision: SharedSpecRevision = {
    id: "winner-rev", documentId: "winner-doc", markdown: "# Winner\n", contentHash: hashSharedSpecMarkdown("# Winner\n"),
    authorActorId: "other-hat", idempotencyKey: "winner-key", requestDigest: "winner-digest",
    createdAt: new Date("2026-09-06T00:00:00.000Z"),
  };
  const inner = new InMemorySharedSpecRepository();
  await inner.transaction(async tx => { await tx.insertDocument(winner); await tx.insertRevision(winnerRevision); });
  let destinationLookups = 0;
  const racing: SharedSpecRepository = {
    transaction: work => inner.transaction(tx => work({
      ...tx,
      getDocumentByDestination: async (repository, gitPath) => {
        destinationLookups += 1;
        // Only the call made from inside shareDocument's own transaction (the
        // very first lookup) simulates the lost race; findByDestination's
        // later, separate re-read must see the real, already-committed row.
        return destinationLookups === 1 ? undefined : tx.getDocumentByDestination(repository, gitPath);
      },
      insertDocument: async () => {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "uq_shared_spec_documents_active_destination"'),
          { code: "23505", constraint: "uq_shared_spec_documents_active_destination" },
        );
      },
    })),
  };
  const core = new SharedSpecCore(racing);
  await assert.rejects(
    () => core.shareDocument(author, { repository: "hola/hola", gitPath: "notes/race.md", markdown: "# Loser\n", idempotencyKey: "loser-key" }),
    (error: SharedSpecDomainError) => error.code === "CONFLICT"
      && error.details.documentId === "winner-doc" && error.details.currentRevisionId === "winner-rev",
  );
  assert.equal((await core.findByDestination("hola/hola", "notes/race.md"))?.document.id, "winner-doc");
});

test("an unrelated database failure during share is never mistaken for a destination race", async () => {
  const racing: SharedSpecRepository = {
    transaction: work => new InMemorySharedSpecRepository().transaction(tx => work({
      ...tx,
      insertDocument: async () => { throw Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" }); },
    })),
  };
  const core = new SharedSpecCore(racing);
  await assert.rejects(
    () => core.shareDocument(author, { repository: "hola/hola", gitPath: "notes/unrelated-failure.md", markdown: "# x\n", idempotencyKey: "unrelated-1" }),
    (error: unknown) => !(error instanceof SharedSpecDomainError) && (error as { code?: string }).code === "57P01",
  );
});

test("findByDestination returns undefined for an unknown destination", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  assert.equal(await core.findByDestination("hola/hola", "notes/unknown.md"), undefined);
});

test("createDocument itself validates the gitPath pattern against the document's own kind", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  await core.createDocument(author, { title: "A note via createDocument", kind: "note", repository: "hola/hola", gitPath: "notes/direct-create.md", markdown: "# x\n", idempotencyKey: "direct-create" });
  await assert.rejects(
    () => core.createDocument(author, { title: "x", kind: "note", repository: "hola/hola", gitPath: "docs/superpowers/specs/wrong-namespace.md", markdown: "# x\n", idempotencyKey: "direct-create-bad" }),
    (error: SharedSpecDomainError) => error.code === "VALIDATION",
  );
});

test("liveInstructionDocument may use its fixed path outside the specs/ namespace", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  const created = await core.createDocument(author, {
    title: "Shared Agent Instructions", kind: "architecture", repository: "hola/hola",
    gitPath: "docs/shared-agent-instructions.md", markdown: "# Shared Agent Instructions\n",
    liveInstructionDocument: true, idempotencyKey: "live-instructions",
  });
  assert.equal(created.document.gitPath, "docs/shared-agent-instructions.md");
  assert.equal(created.document.liveInstructionDocument, true);
});

test("the live-instruction-document path exemption is exact, not a docs/** wildcard", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  await assert.rejects(
    () => core.createDocument(author, {
      title: "x", kind: "architecture", repository: "hola/hola",
      gitPath: "docs/some-other-file.md", markdown: "# x\n",
      liveInstructionDocument: true, idempotencyKey: "wrong-path",
    }),
    (error: SharedSpecDomainError) => error.code === "VALIDATION",
  );
});

test("the live-instruction-document path exemption requires the flag itself, not just the path", async () => {
  const core = new SharedSpecCore(new InMemorySharedSpecRepository());
  await assert.rejects(
    () => core.createDocument(author, {
      title: "x", kind: "architecture", repository: "hola/hola",
      gitPath: "docs/coordination-clients.md", markdown: "# x\n",
      idempotencyKey: "unflagged",
    }),
    (error: SharedSpecDomainError) => error.code === "VALIDATION",
  );
});