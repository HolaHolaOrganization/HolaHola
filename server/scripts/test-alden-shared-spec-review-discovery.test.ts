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
// disposable-target contract, supporting both the dedicated
// SHARED_SPEC_TEST_DATABASE_* vars and GitHub Actions' verified job-local
// CI_DATABASE_URL. The verified target is bound BEFORE database/tool imports;
// validating a URL alone cannot redirect an already-imported singleton.
// This file is spliced into
// scripts/run-ci-test-steps.mjs and server/scripts/run-validation-suite.sh --
// scripts/neon-branch.ts's cmdGate() already sets the generic
// SHARED_SPEC_TEST_DATABASE_* env vars for any file using this pattern.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bindReviewDiscoveryDatabase } from "./alden-review-discovery-test-database";
import { SharedSpecCore, type ActorContext } from "../services/shared-spec-core";
import { PostgresSharedSpecRepository } from "../services/shared-spec-postgres-repository";

// Cheap import-order guard. The companion isolation suite exercises the
// actual gate failures and fixture/tool writes against two disposable DBs.
const OWN_SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");
test("this file hard-fails under the gate instead of silently skipping DB coverage", () => {
  assert.ok(OWN_SOURCE.includes("bindReviewDiscoveryDatabase()"));
  assert.doesNotMatch(OWN_SOURCE, /^import .*from ["']\.\.\/(?:db|services\/alden-functions)["'];/m);
  assert.ok(OWN_SOURCE.includes("context.skip("));
});

const runId = randomUUID();
const ADMIN: ActorContext = { actorId: `review-discovery-admin-${runId}`, capabilities: ["policy_admin"] };
const AUTHOR: ActorContext = { actorId: `review-discovery-author-${runId}` };
const OTHER_REVIEWER: ActorContext = { actorId: `review-discovery-other-${runId}` };
const REPOSITORY = "hola/hola";

test("list_shared_spec_reviews, called through Alden's real dispatch path, finds reviews assigned to or claimed by alden and excludes reviews assigned to/claimed by someone else or already decided", async (context) => {
  const url = bindReviewDiscoveryDatabase();
  if (!url) {
    context.skip("set SHARED_SPEC_TEST_DATABASE_URL and SHARED_SPEC_TEST_DATABASE_DISPOSABLE=1");
    return;
  }

  const { getSharedDb, closeDbConnections } = await import("../db");
  context.after(closeDbConnections);
  const db = getSharedDb();
  // Verify the actual pool, not merely the environment. Fail before the first
  // fixture write if an earlier/transitive import ever captured another URL.
  assert.ok(db.$client.options.connectionString === url, "repository pool must use the verified disposable target");
  const { executeAldenTool } = await import("../services/alden-functions");
  const core = new SharedSpecCore(new PostgresSharedSpecRepository(db));

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
});
