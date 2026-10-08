import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AldenReviewReadSession, buildAldenReviewSourcePage, parseAldenReviewContext,
  safeAldenReviewReferences, serializeAldenReviewContext,
} from "../services/alden-review-source";
import { ALDEN_TOOL_RESULT_LIMIT, aldenCoordinationReadReceipt, serializeAldenToolResult } from "../services/alden-tool-result";
import type { AldenReviewSnapshot } from "../services/alden-shared-spec-review";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function snapshot(markdown: string): AldenReviewSnapshot {
  const now = new Date(0), contentHash = hash(markdown);
  return {
    document: { id: id(1), title: "Synthetic review", kind: "design", repository: "test/test",
      gitPath: "docs/test.md", liveInstructionDocument: false, currentRevisionId: id(2),
      state: "ready_for_review", creatorActorId: "author", createdAt: now, updatedAt: now },
    revision: { id: id(2), documentId: id(1), markdown, contentHash, authorActorId: "author",
      idempotencyKey: "synthetic", requestDigest: hash("synthetic"), createdAt: now },
    review: { id: id(3), documentId: id(1), revisionId: id(2), revisionContentHash: contentHash,
      requestedByActorId: "author", requestedReviewerActorId: "alden", state: "pending",
      idempotencyKey: "synthetic-review", requestDigest: hash("review"), createdAt: now },
  };
}
function pages(s: AldenReviewSnapshot) {
  const output: ReturnType<typeof buildAldenReviewSourcePage>[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = buildAldenReviewSourcePage(s, offset);
    output.push(page);
    assert.ok(output.length < 1000);
    offset = page.source.nextOffset;
  }
  return output;
}
function deliver(session: AldenReviewReadSession, page: ReturnType<typeof buildAldenReviewSourcePage>) {
  const serialized = serializeAldenToolResult("read_shared_spec_review", page);
  session.stageDelivery("read_shared_spec_review", serialized);
  session.acknowledgeDelivery();
}
function decide(session: AldenReviewReadSession, s: AldenReviewSnapshot) {
  session.assertComplete(s, s.revision.id, s.revision.contentHash);
}

for (const length of [20_830, 30_764]) {
  test(`all ${length} source characters reach both transport envelopes as valid JSON`, () => {
    const suffix = "\nSECURITY\nVERIFICATION\nAUTHORIZATION\nLIMITATIONS";
    const s = snapshot("x".repeat(length - suffix.length) + suffix), chunks = pages(s);
    assert.ok(chunks.length > 1);
    for (const p of chunks) {
      const encoded = serializeAldenToolResult("read_shared_spec_review", p);
      assert.ok(encoded.length <= ALDEN_TOOL_RESULT_LIMIT);
      const anthropic = { type: "tool_result", content: encoded };
      const gemini = { functionResponse: { name: "read_shared_spec_review", response: { result: encoded } } };
      assert.deepEqual(JSON.parse(anthropic.content), p);
      assert.deepEqual(JSON.parse(gemini.functionResponse.response.result), p);
      assert.equal(p.source.contentSha256, s.revision.contentHash);
      assert.equal(p.source.totalCharacters, length);
    }
    assert.equal(chunks.map(p => p.markdown).join(""), s.revision.markdown);
    const session = new AldenReviewReadSession();
    for (const p of chunks) deliver(session, p);
    assert.doesNotThrow(() => decide(session, s));
  });
}

test("JSON escaping and surrogate pairs preserve exact source with bounded envelopes", () => {
  const s = snapshot(('😀"\\\n\t\u0000' + "a".repeat(17)).repeat(1500));
  const chunks = pages(s);
  for (const p of chunks) {
    assert.ok(JSON.stringify(p).length <= ALDEN_TOOL_RESULT_LIMIT);
    assert.ok(!/[\uD800-\uDBFF]$/.test(p.markdown));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p.markdown));
  }
  assert.equal(chunks.map(p => p.markdown).join(""), s.revision.markdown);
});

test("invalid offsets, including a surrogate-pair midpoint, refuse reading", () => {
  const s = snapshot("a😀bc");
  for (const offset of [-1, 1.5, "0", NaN, Infinity, 6, 2]) {
    assert.throws(() => buildAldenReviewSourcePage(s, offset), /invalid_offset/);
  }
});

test("DB hash and review/revision/document identity must agree", () => {
  const s = snapshot("small");
  assert.throws(() => buildAldenReviewSourcePage({ ...s, revision: { ...s.revision, markdown: "changed" } }), /hash_mismatch/);
  assert.throws(() => buildAldenReviewSourcePage({ ...s, review: { ...s.review, revisionContentHash: hash("different") } }), /identity_mismatch/);
  assert.throws(() => buildAldenReviewSourcePage({ ...s, document: { ...s.document, id: id(8) } }), /identity_mismatch/);
});

test("oversized metadata or raw unpaged sources fail closed, never truncated JSON", () => {
  const s = snapshot("small");
  assert.throws(() => buildAldenReviewSourcePage({ ...s, document: { ...s.document, id: "x".repeat(13000) },
    review: { ...s.review, documentId: "x".repeat(13000) },
    revision: { ...s.revision, documentId: "x".repeat(13000) } }), /budget_exceeded/);
  assert.throws(() => serializeAldenToolResult("read_shared_spec_review", { markdown: "x".repeat(13000) }), /too_large/);
});

test("read+decide in one tool batch cannot claim model delivery", () => {
  const s = snapshot("all source"), session = new AldenReviewReadSession();
  session.stageDelivery("read_shared_spec_review", serializeAldenToolResult("read_shared_spec_review", pages(s)[0]));
  assert.throws(() => decide(session, s), /not_fully_delivered/);
  // Only a successful provider response to that batch grants coverage.
  session.acknowledgeDelivery();
  assert.doesNotThrow(() => decide(session, s));
});

test("failed provider sends leave prepared pages without decision authority", () => {
  const s = snapshot("all source"), session = new AldenReviewReadSession();
  session.stageDelivery("read_shared_spec_review", JSON.stringify(pages(s)[0]));
  // No acknowledgement, as when a send fails.
  assert.throws(() => decide(session, s), /not_fully_delivered/);
  assert.deepEqual(session.sourceReferences, []);
});

test("gaps and duplicated pages cannot imply complete delivery", () => {
  const s = snapshot("x".repeat(40000)), chunks = pages(s), session = new AldenReviewReadSession();
  deliver(session, chunks[0]);
  deliver(session, chunks[0]);
  for (const p of chunks.slice(2)) deliver(session, p);
  assert.throws(() => decide(session, s), /contiguous coverage/);
  deliver(session, chunks[1]);
  assert.doesNotThrow(() => decide(session, s));
});

test("coverage is review-specific, exact-hash bound and never restored across phases", () => {
  const s = snapshot("original"), session = new AldenReviewReadSession();
  deliver(session, pages(s)[0]);
  const freshPhase = new AldenReviewReadSession(session.sourceReferences);
  assert.throws(() => decide(freshPhase, s), /not_fully_delivered/);
  assert.ok(freshPhase.rereadContext.includes(s.revision.contentHash));
  assert.ok(freshPhase.rereadContext.includes("not source text"));
  const other = { ...s, review: { ...s.review, id: id(9) } };
  assert.throws(() => decide(session, other), /not_fully_delivered/);
  assert.throws(() => session.assertComplete(s, s.revision.id, hash("wrong")), /source_mismatch/);
  const changed = snapshot("new source");
  assert.throws(() => decide(session, changed), /not_fully_delivered/);
});

test("new revision delivery replaces old coverage rather than combining them", () => {
  const old = snapshot("x".repeat(20000)), session = new AldenReviewReadSession();
  deliver(session, pages(old)[0]);
  const next = snapshot("y".repeat(20000));
  deliver(session, pages(next)[1]);
  assert.throws(() => decide(session, next), /contiguous coverage/);
  deliver(session, pages(next)[0]);
  assert.doesNotThrow(() => decide(session, next));
});

test("malformed, nonadvancing, tampered and error pages never grant coverage", () => {
  const s = snapshot("small"), page = pages(s)[0];
  const tampered = { ...page, markdown: "false" };
  const session = new AldenReviewReadSession();
  session.stageDelivery("read_shared_spec_review", JSON.stringify(tampered));
  assert.throws(() => session.acknowledgeDelivery(), /invalid_delivery/);
  session.stageDelivery("read_shared_spec_review", JSON.stringify({ error: "read failed" }));
  session.acknowledgeDelivery();
  assert.throws(() => decide(session, s), /not_fully_delivered/);
  assert.throws(() => session.stageDelivery("read_shared_spec_review", "x".repeat(12001)), /invalid_delivery/);
});

test("safe durable text context retains only bounded exact-source refs, scoped to engine", () => {
  const s = snapshot("private source text"), session = new AldenReviewReadSession();
  deliver(session, pages(s)[0]);
  const ref = { ...session.sourceReferences[0], credential: "DO_NOT_PERSIST", markdown: s.revision.markdown };
  const serialized = serializeAldenReviewContext("anthropic", [ref]);
  assert.ok(!serialized.includes("DO_NOT_PERSIST"));
  assert.ok(!serialized.includes(s.revision.markdown));
  assert.deepEqual(parseAldenReviewContext(serialized, "anthropic"), session.sourceReferences);
  assert.deepEqual(parseAldenReviewContext(serialized, "gemini"), []);
  assert.deepEqual(parseAldenReviewContext("legacy free text", "anthropic"), []);
  assert.deepEqual(safeAldenReviewReferences([{ reviewId: "bad" }]), []);
  const many = Array.from({ length: 8 }, (_, n) => ({ ...ref, reviewId: id(n + 20) }));
  assert.equal(safeAldenReviewReferences(many).length, 3);
  assert.equal(aldenCoordinationReadReceipt("read_shared_spec_review", pageForReceipt()), null);
  function pageForReceipt() { return pages(s)[0]; }
});

test("empty sources still require an actual acknowledged read", () => {
  const s = snapshot(""), session = new AldenReviewReadSession();
  assert.throws(() => decide(session, s), /not_fully_delivered/);
  deliver(session, pages(s)[0]);
  assert.doesNotThrow(() => decide(session, s));
});

test("dispatch, both providers and both routes wire the gate and safe continuity", () => {
  const root = new URL("../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const tools = read("server/services/alden-functions.ts");
  const gate = tools.slice(tools.indexOf('case "decide_shared_spec_review":'), tools.indexOf("default:", tools.indexOf('case "decide_shared_spec_review":')));
  assert.ok(gate.indexOf("assertComplete(") > gate.indexOf("readAldenSharedSpecReview("));
  assert.ok(gate.indexOf("assertComplete(") < gate.indexOf("decideAldenSharedSpecReview("));
  assert.ok(gate.includes('throw new Error("review_read_context_required")'));
  const providers = read("server/services/alden-persona-service.ts");
  assert.equal((providers.match(/reviewReadSession\.stageDelivery\(/g) ?? []).length, 2);
  assert.equal((providers.match(/engine: '(anthropic|gemini)', reviewReadSession/g) ?? []).length, 2);
  assert.ok(providers.includes('loadAldenReviewSourceReferences("anthropic"'));
  assert.ok(providers.includes('loadAldenReviewSourceReferences("gemini"'));
  assert.equal((providers.match(/reviewReadSession\.rereadContext, userMessage/g) ?? []).length, 2);
  const routes = read("server/routes.ts");
  assert.ok(routes.includes("serializeAldenReviewContext(p.reviewSourceEngine"));
  assert.ok(routes.includes("serializeAldenReviewContext(r.engine"));
  assert.ok(routes.includes("reviewSourceReferences = result.reviewSourceReferences"));
});
