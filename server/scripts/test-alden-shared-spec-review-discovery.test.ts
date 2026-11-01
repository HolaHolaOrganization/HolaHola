// End-to-end proof that Alden's review-discovery tool actually finds real
// waiting work through his real dispatch path -- executeAldenTool ->
// listAldenSharedSpecReviews -> PostgresSharedSpecRepository -> a live
// PostgreSQL database -- not just the in-memory domain coverage already in
// shared-spec-core.test.ts (SharedSpecCore.listReviewsForReviewer against
// InMemorySharedSpecRepository). The original three Alden shared-spec tools
// (read/claim/decide) were "verified live" via an actual priority-task
// tool-call trace (see .agents/memory/alden-tool-whitelist.md); this file is
// the equivalent proof for the fourth (discovery) tool, run automatically on
// every CI pass instead of by hand.
//
// Requires a disposable Postgres database (SHARED_SPEC_TEST_* below) with the
// shared_spec_* migration already applied. Mirrors
// test-shared-spec-live-instruction-document-postgres.test.ts's
// disposableTarget() gate exactly, including why getVerifiedCiDatabaseUrl()
// is checked before the dedicated SHARED_SPEC_TEST_DATABASE_* vars: it gives
// this file real-database coverage on every ordinary CI run (GitHub Actions'
// job-local CI_DATABASE_URL) as well as scripts/neon-branch.ts's migration
// gate, with no extra gate wiring beyond splicing this file into
// scripts/run-ci-test-steps.mjs and server/scripts/run-validation-suite.sh --
// scripts/neon-branch.ts's cmdGate() already sets the generic
// SHARED_SPEC_TEST_DATABASE_* env vars for any file using this pattern.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getVerifiedCiDatabaseUrl } from "../ci-database";
import { getSharedDb } from "../db";
import { executeAldenTool } from "../services/alden-functions";
import { SharedSpecCore, type ActorContext } from "../services/shared-spec-core";
import { PostgresSharedSpecRepository } from "../services/shared-spec-postgres-repository";

function disposableTarget(): string | undefined {
  const ci = getVerifiedCiDatabaseUrl();
  if (ci) return ci;
  const url = process.env.SHARED_SPEC_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.SHARED_SPEC_REQUIRE_DATABASE_TESTS === "1") {
      throw new Error("SHARED_SPEC_TEST_DATABASE_URL is required by the migration gate");
    }
    return undefined;
  }
  if (process.env.SHARED_SPEC_TEST_DATABASE_DISPOSABLE !== "1") {
    throw new Error("SHARED_SPEC_TEST_DATABASE_DISPOSABLE=1 is required");
  }
  if (url === process.env.SHARED_SPEC_FORBIDDEN_SHARED_URL) {
    throw new Error("shared-spec review-discovery test refuses the shared Neon database");
  }
  return url;
}

// Mirrors the identical self-check in
// test-shared-spec-live-instruction-document-postgres.test.ts -- without
// this, a quietly-deleted gate branch would make every test below skip
// silently forever, defeating the whole point of proving this tool against a
// real database.
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");
test("this file hard-fails under the gate instead of silently skipping DB coverage", () => {
  assert.ok(OWN_SOURCE.includes('SHARED_SPEC_REQUIRE_DATABASE_TESTS === "1"'));
  assert.ok(OWN_SOURCE.includes("SHARED_SPEC_FORBIDDEN_SHARED_URL"));
  assert.ok(OWN_SOURCE.includes("context.skip("));
});

const runId = randomUUID();
const ADMIN: ActorContext = { actorId: `review-discovery-admin-${runId}`, capabilities: ["policy_admin"] };
const AUTHOR: ActorContext = { actorId: `review-discovery-author-${runId}` };
const OTHER_REVIEWER: ActorContext = { actorId: `review-discovery-other-${runId}` };
const REPOSITORY = "hola/hola";

test("list_shared_spec_reviews, called through Alden's real dispatch path, finds reviews assigned to or claimed by alden and excludes reviews assigned to/claimed by someone else or already decided", async (context) => {
  const url = disposableTarget();
  if (!url) {
    context.skip("set SHARED_SPEC_TEST_DATABASE_URL and SHARED_SPEC_TEST_DATABASE_DISPOSABLE=1");
    return;
  }

  // getSharedDb() resolves NEON_SHARED_DATABASE_URL, which the gate above has
  // already arranged to equal `url`. This is the same singleton
  // listAldenSharedSpecReviews's own lazy getCore() constructs its
  // PostgresSharedSpecRepository from (see alden-shared-spec-review.ts), so
  // the setup below and the real tool dispatch afterward transparently share
  // one live database -- exactly what makes this an end-to-end proof rather
  // than another in-memory unit test.
  const core = new SharedSpecCore(new PostgresSharedSpecRepository(getSharedDb()));

  await core.setReviewerPolicy(ADMIN, {
    actorId: "alden", capability: "reviewer", active: true, idempotencyKey: `alden-policy-${runId}`,
  });
  await core.setReviewerPolicy(ADMIN, {
    actorId: OTHER_REVIEWER.actorId, capability: "reviewer", active: true, idempotencyKey: `other-policy-${runId}`,
  });

  async function readyDocument(label: string, requestedReviewerActorId?: string) {
    const { document, revision } = await core.createDocument(AUTHOR, {
      title: `Review discovery ${label} ${runId}`, kind: "design", repository: REPOSITORY,
      gitPath: `docs/superpowers/specs/review-discovery-${label}-${runId}.md`,
      markdown: `# ${label}\n`, idempotencyKey: `create-${label}-${runId}`,
    });
    const review = await core.markRevisionReady(AUTHOR, {
      documentId: document.id, revisionId: revision.id, requestedReviewerActorId,
      idempotencyKey: `ready-${label}-${runId}`,
    });
    return { document, revision, review };
  }

  // (a) Assigned to alden, still unclaimed -- must be found.
  const assigned = await readyDocument("assigned", "alden");

  // (b) Never assigned to anyone, but alden claims it himself -- must be
  //     found: the whole point of this tool is finding work even when nobody
  //     handed alden the reviewId first.
  const claimable = await readyDocument("claimable");
  await core.claimReview({ actorId: "alden" }, claimable.review.id, `claim-alden-${runId}`);

  // (c) Assigned to a different actor -- must never appear for alden.
  const otherAssigned = await readyDocument("other-assigned", OTHER_REVIEWER.actorId);

  // (d) Never assigned, but claimed by a different actor -- must never
  //     appear for alden.
  const otherClaimed = await readyDocument("other-claimed");
  await core.claimReview(OTHER_REVIEWER, otherClaimed.review.id, `claim-other-${runId}`);

  // (e) Assigned to alden, claimed by him, and already decided -- must drop
  //     out once no longer pending.
  const decided = await readyDocument("decided", "alden");
  await core.claimReview({ actorId: "alden" }, decided.review.id, `claim-decided-${runId}`);
  await core.approveReview({ actorId: "alden" }, {
    reviewId: decided.review.id, rationale: "looks good", idempotencyKey: `approve-decided-${runId}`,
  });

  // (f) Assigned to alden and claimed by him, then superseded by a newer
  //     revision -- must auto-close to state = "cancelled" with cancelledAt
  //     in PostgreSQL and drop out of both list_shared_spec_reviews and
  //     listReviewsForReviewer.
  const superseded = await readyDocument("superseded", "alden");
  await core.claimReview({ actorId: "alden" }, superseded.review.id, `claim-superseded-${runId}`);
  await core.appendRevision(AUTHOR, {
    documentId: superseded.document.id,
    baseRevisionId: superseded.revision.id,
    markdown: "# superseded v2\n",
    idempotencyKey: `append-superseded-v2-${runId}`,
  });
  const supersededPersisted = await core.getReview(superseded.review.id);
  assert.equal(supersededPersisted.state, "cancelled", "superseded pending review must auto-close to state = 'cancelled' in PostgreSQL");
  assert.ok(supersededPersisted.cancelledAt instanceof Date, "superseded review must record cancelledAt in PostgreSQL");

  // The real tool dispatch path: executeAldenTool -> listAldenSharedSpecReviews
  // -> the tool's own PostgresSharedSpecRepository -> the same live database.
  const result = await executeAldenTool("list_shared_spec_reviews", {});
  assert.equal(result.data.error, undefined, `list_shared_spec_reviews reported an error: ${result.data.error}`);
  assert.ok(Array.isArray(result.data.reviews));
  const byReviewId = new Map<string, any>(result.data.reviews.map((entry: any) => [entry.review.id, entry]));

  const assignedEntry = byReviewId.get(assigned.review.id);
  assert.ok(assignedEntry, "a review assigned to alden and not yet claimed must be found");
  assert.equal(assignedEntry.review.state, "pending");
  assert.equal(assignedEntry.document.id, assigned.document.id);
  assert.equal(assignedEntry.document.title, assigned.document.title);
  assert.equal(assignedEntry.document.kind, "design");
  assert.equal(assignedEntry.document.gitPath, assigned.document.gitPath);

  const claimableEntry = byReviewId.get(claimable.review.id);
  assert.ok(claimableEntry, "a review alden claimed himself, with no prior assignment, must be found");
  assert.equal(claimableEntry.review.state, "pending");
  assert.equal(claimableEntry.document.title, claimable.document.title);

  assert.ok(!byReviewId.has(otherAssigned.review.id), "a review assigned to a different actor must never appear for alden");
  assert.ok(!byReviewId.has(otherClaimed.review.id), "a review claimed by a different actor must never appear for alden");
  assert.ok(!byReviewId.has(decided.review.id), "a review alden already decided must drop out once no longer pending");
  assert.ok(!byReviewId.has(superseded.review.id), "a review superseded by a newer revision must auto-close and never appear for alden");
});
