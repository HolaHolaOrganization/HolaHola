import { createHash } from "node:crypto";
import type { AldenReviewSnapshot } from "./alden-shared-spec-review";
import { ALDEN_TOOL_RESULT_LIMIT } from "./alden-tool-result";

export interface AldenReviewSourceReference {
  reviewId: string;
  revisionId: string;
  contentSha256: string;
}

export interface AldenReviewSourcePage {
  review: { id: string; revisionId: string; state: string };
  document: { id: string; title: string; kind: string; gitPath: string; liveInstructionDocument: boolean };
  source: AldenReviewSourceReference & {
    offset: number;
    nextOffset: number | null;
    totalCharacters: number;
    pageSha256: string;
    complete: boolean;
  };
  markdown: string;
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_REFERENCES = 3;

// Whitelist, rather than spread, the only fields allowed in durable context.
export function safeAldenReviewReferences(input: unknown): AldenReviewSourceReference[] {
  if (!Array.isArray(input)) return [];
  const refs: AldenReviewSourceReference[] = [];
  for (const value of input) {
    if (!value || !UUID.test(value.reviewId) || !UUID.test(value.revisionId) || !HASH.test(value.contentSha256)) continue;
    if (refs.some(r => r.reviewId === value.reviewId)) continue;
    refs.push({ reviewId: value.reviewId, revisionId: value.revisionId, contentSha256: value.contentSha256 });
    if (refs.length === MAX_REFERENCES) break;
  }
  return refs;
}

export function serializeAldenReviewContext(engine: "anthropic" | "gemini", references: unknown): string {
  return JSON.stringify({ schema: "alden.review.sources.v1", engine, references: safeAldenReviewReferences(references) });
}

export function parseAldenReviewContext(context: unknown, engine: "anthropic" | "gemini"): AldenReviewSourceReference[] {
  if (typeof context !== "string") return [];
  try {
    const value = JSON.parse(context);
    return value?.schema === "alden.review.sources.v1" && value.engine === engine
      ? safeAldenReviewReferences(value.references) : [];
  } catch { return []; } // Legacy free-text context is not a source reference.
}

export function aldenReviewSourceIdentity(snapshot: AldenReviewSnapshot): AldenReviewSourceReference {
  const { review, revision, document } = snapshot;
  if (review.revisionId !== revision.id || review.documentId !== document.id || revision.documentId !== document.id
    || review.revisionContentHash !== revision.contentHash) {
    throw new Error("review_source_identity_mismatch");
  }
  if (digest(revision.markdown) !== revision.contentHash) throw new Error("review_source_hash_mismatch");
  return { reviewId: review.id, revisionId: revision.id, contentSha256: revision.contentHash };
}

function splitsPair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}

export function buildAldenReviewSourcePage(snapshot: AldenReviewSnapshot, offset: unknown = 0): AldenReviewSourcePage {
  const identity = aldenReviewSourceIdentity(snapshot);
  const text = snapshot.revision.markdown;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > text.length || splitsPair(text, offset as number)) {
    throw new Error("review_source_invalid_offset");
  }
  const start = offset as number;
  const page = (end: number): AldenReviewSourcePage => {
    const markdown = text.slice(start, end);
    return {
      review: { id: snapshot.review.id, revisionId: identity.revisionId, state: snapshot.review.state },
      document: {
        id: snapshot.document.id, title: snapshot.document.title.slice(0, 180),
        kind: snapshot.document.kind, gitPath: snapshot.document.gitPath.slice(0, 300),
        liveInstructionDocument: snapshot.document.liveInstructionDocument,
      },
      source: {
        ...identity, offset: start, nextOffset: end === text.length ? null : end,
        totalCharacters: text.length, pageSha256: digest(markdown), complete: start === 0 && end === text.length,
      },
      markdown,
    };
  };
  // Budget the entire JSON envelope, including escaping and metadata.
  let low = start, high = Math.min(text.length, start + ALDEN_TOOL_RESULT_LIMIT);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(page(mid)).length <= ALDEN_TOOL_RESULT_LIMIT) low = mid;
    else high = mid - 1;
  }
  if (splitsPair(text, low)) low--;
  const result = page(low);
  if (JSON.stringify(result).length > ALDEN_TOOL_RESULT_LIMIT || (low === start && start < text.length)) {
    throw new Error("review_source_page_budget_exceeded");
  }
  return result;
}

/** One instance per generation, never global or restored from persisted receipts. */
export class AldenReviewReadSession {
  private references: AldenReviewSourceReference[];
  private readonly coverage = new Map<string, { identity: AldenReviewSourceReference; total: number; ranges: [number, number][] }>();
  private pending: string[] = [];

  constructor(references: unknown = []) {
    this.references = safeAldenReviewReferences(references);
  }

  get sourceReferences(): AldenReviewSourceReference[] {
    return this.references.map(r => ({ ...r }));
  }

  get rereadContext(): string {
    if (!this.references.length) return "";
    return "[EXACT REVIEW SOURCE REFERENCES — pointers, not source text or proof of understanding]\n"
      + JSON.stringify(this.references)
      + "\nRe-read these exact sources with read_shared_spec_review when continuing their review. Start at offset 0 and follow nextOffset until null. "
      + "Prior generated summaries are not the source. This turn starts with no delivered-source coverage.";
  }

  /** Serialization prepares a delivery; it cannot authorize another call in the same batch. */
  stageDelivery(name: string, serialized: string): void {
    if (name !== "read_shared_spec_review") return;
    if (serialized.length > ALDEN_TOOL_RESULT_LIMIT) throw new Error("review_source_invalid_delivery");
    this.pending.push(serialized);
  }

  /** Invoke only after a provider successfully responds to the batch containing these pages. */
  acknowledgeDelivery(): void {
    const batch = this.pending;
    this.pending = [];
    for (const serialized of batch) this.recordDelivered(serialized);
  }

  private recordDelivered(serialized: string): void {
    const page = JSON.parse(serialized) as AldenReviewSourcePage;
    if ((page as any).error) return;
    const s = page.source;
    if (!s || !safeAldenReviewReferences([s]).length || page.review.id !== s.reviewId
      || page.review.revisionId !== s.revisionId || !Number.isSafeInteger(s.offset)
      || !Number.isSafeInteger(s.totalCharacters) || s.offset < 0 || s.totalCharacters < 0
      || s.offset > s.totalCharacters || typeof page.markdown !== "string"
      || digest(page.markdown) !== s.pageSha256) throw new Error("review_source_invalid_delivery");
    const end = s.offset + page.markdown.length;
    if (end > s.totalCharacters || (s.nextOffset !== null && s.nextOffset !== end)
      || (s.nextOffset === null) !== (end === s.totalCharacters)
      || (end === s.offset && s.totalCharacters > 0)) throw new Error("review_source_invalid_delivery");
    const identity = { reviewId: s.reviewId, revisionId: s.revisionId, contentSha256: s.contentSha256 };
    const prior = this.coverage.get(s.reviewId);
    const current = prior && prior.identity.revisionId === s.revisionId
      && prior.identity.contentSha256 === s.contentSha256 && prior.total === s.totalCharacters
      ? prior : { identity, total: s.totalCharacters, ranges: [] };
    current.ranges.push([s.offset, end]);
    this.coverage.set(s.reviewId, current);
    this.references = safeAldenReviewReferences([identity, ...this.references]);
  }

  assertComplete(snapshot: AldenReviewSnapshot, revisionId: unknown, contentSha256: unknown): void {
    const identity = aldenReviewSourceIdentity(snapshot);
    if (revisionId !== identity.revisionId || contentSha256 !== identity.contentSha256) {
      throw new Error("review_decision_source_mismatch: use the exact revision_id and content_sha256 from the source pages");
    }
    const entry = this.coverage.get(identity.reviewId);
    if (!entry || entry.identity.revisionId !== identity.revisionId
      || entry.identity.contentSha256 !== identity.contentSha256 || entry.total !== snapshot.revision.markdown.length) {
      throw new Error("review_source_not_fully_delivered: re-read all source pages in this turn");
    }
    let through = 0;
    for (const [start, end] of [...entry.ranges].sort((a, b) => a[0] - b[0])) {
      if (start > through) break;
      through = Math.max(through, end);
    }
    if (through !== entry.total) throw new Error(`review_source_not_fully_delivered: contiguous coverage ends at offset ${through}`);
  }
}
