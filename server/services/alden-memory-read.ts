import { createHash } from "node:crypto";
import { ALDEN_TOOL_RESULT_LIMIT, serializeAldenToolResult } from "./alden-tool-result";

// Bounded, verbatim delivery of conversation_memories to Alden.
//
// Every tool result reaches Alden through serializeAldenToolResult, which cuts
// anything over ALDEN_TOOL_RESULT_LIMIT. A long row (a rolling episode can be
// ~100K characters) therefore used to arrive as its first ~12K only, with no
// way to read the rest. Discovery now returns bounded metadata and a leading
// excerpt per row; the full text is read one exact chunk at a time with
// read_conversation_memory_content. Both results are built to fit the limit,
// so they are delivered complete instead of being cut.

/** Escaped-JSON budget for one content chunk (the envelope fits in the rest). */
export const MEMORY_CONTENT_CHUNK_BUDGET = 11_600;
const MAX_TEXT_BUDGET = 1_200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const READ_MEMORY_CONTENT_TOOL = "read_conversation_memory_content";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function surrogateBoundary(text: string, end: number): number {
  if (end > 0 && end < text.length
    && /[\uD800-\uDBFF]/.test(text[end - 1])
    && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}

/** Longest prefix whose escaped JSON fits the budget, never splitting a pair. */
function jsonPrefix(text: string, budget: number): string {
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(0, mid)).length <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, surrogateBoundary(text, low));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export interface MemoryRow {
  id: string;
  title?: unknown;
  summary?: unknown;
  content?: unknown;
  importance?: unknown;
  created_at?: unknown;
  tags?: unknown;
  entry_type?: unknown;
  arc_name?: unknown;
  extends_memory_id?: unknown;
}

function boundedTags(tags: unknown, budget: number): { tags: string[]; tagsComplete: boolean } {
  const all = Array.isArray(tags) ? tags.map(asText) : [];
  const kept: string[] = [];
  for (const tag of all) {
    if (JSON.stringify([...kept, tag]).length > budget) break;
    kept.push(tag);
  }
  return { tags: kept, tagsComplete: kept.length === all.length };
}

interface PreparedRow {
  row: MemoryRow;
  title: string;
  summary: string;
  content: string;
  contentSha256: string;
  arc: string | null;
  entryType: string | null;
  speakerExcerpt?: string;
}

/** Budgets: identification (title, arc) is protected; text (summary, excerpts, tags) shrinks first. */
interface Budgets { id: number; text: number }

const MAX_TITLE = 300;
const MAX_ARC = 80;
const MAX_ENTRY_TYPE = 40;

/**
 * Discovery entry for one row. Text fields are cut to their escaped-JSON
 * budget and say so. `content` appears only when the whole text fits;
 * otherwise `contentExcerpt` (the opening, never a summary) does.
 */
function memoryEntry(p: PreparedRow, b: Budgets) {
  const shownTitle = jsonPrefix(p.title, Math.min(b.id, MAX_TITLE));
  const shownArc = p.arc === null ? null : jsonPrefix(p.arc, Math.min(b.id, MAX_ARC));
  const shownEntryType = p.entryType === null ? null : jsonPrefix(p.entryType, MAX_ENTRY_TYPE);
  const shownSummary = jsonPrefix(p.summary, b.text);
  const shownContent = jsonPrefix(p.content, b.text);
  const contentComplete = shownContent.length === p.content.length;
  const { tags, tagsComplete } = boundedTags(p.row.tags, Math.min(b.text, 400));
  const shownSpeaker = p.speakerExcerpt === undefined ? undefined : jsonPrefix(p.speakerExcerpt, b.text);
  return {
    id: p.row.id,
    title: shownTitle,
    ...(shownTitle.length === p.title.length ? {} : { titleComplete: false }),
    importance: p.row.importance ?? null,
    entryType: shownEntryType,
    ...(shownEntryType === null || shownEntryType.length === p.entryType!.length ? {} : { entryTypeComplete: false }),
    tags,
    ...(tagsComplete ? {} : { tagsComplete: false }),
    arcName: shownArc,
    ...(shownArc === null || shownArc.length === p.arc!.length ? {} : { arcNameComplete: false }),
    extendsMemoryId: p.row.extends_memory_id ?? null,
    recordedAt: p.row.created_at ?? null,
    summary: shownSummary,
    ...(shownSummary.length === p.summary.length ? {} : { summaryComplete: false }),
    totalCharacters: p.content.length,
    contentSha256: p.contentSha256,
    contentComplete,
    ...(contentComplete ? { content: p.content } : { contentExcerpt: shownContent }),
    ...(shownSpeaker === undefined ? {} : {
      speakerExcerpt: shownSpeaker,
      ...(shownSpeaker.length === p.speakerExcerpt!.length ? {} : { speakerExcerptComplete: false }),
    }),
  };
}

// DRAFT tool text: pending the Alden -> Gemini rephrase loop (replit.md). Not approved.
const READ_NOTE =
  "Where contentComplete is false, contentExcerpt is only the opening of the record. To read the full original text, call read_conversation_memory_content with the record's id at offset 0, then pass nextOffset and expected_content_sha256 until complete is true, and join the chunks in offset order. speakerExcerpt is a derived sample, not exact words.";

/** Largest integer in [low, high] for which `fits` holds, or null if none does. */
function largestFitting(low: number, high: number, fits: (n: number) => boolean): number | null {
  if (!fits(low)) return null;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Shape any discovery result so that it fits the serializer limit. `groups`
 * maps a group name (memories, ancestors, descendants, anchor) to its rows.
 * The text budget is the largest that fits with full identification (title,
 * arc); only if even the smallest text budget does not fit does
 * identification shrink too.
 */
export function buildMemoryDiscovery(
  groups: Record<string, MemoryRow[] | MemoryRow>,
  extras: Record<string, unknown>,
  speakerExcerpt?: (row: MemoryRow) => string,
) {
  // Computed once: the budget search rebuilds the result many times.
  const prepare = (row: MemoryRow): PreparedRow => {
    const content = asText(row.content);
    return {
      row,
      title: asText(row.title),
      summary: asText(row.summary),
      content,
      contentSha256: sha256(content),
      arc: row.arc_name == null ? null : asText(row.arc_name),
      entryType: row.entry_type == null ? null : asText(row.entry_type),
      ...(speakerExcerpt ? { speakerExcerpt: speakerExcerpt(row) } : {}),
    };
  };
  const prepared = Object.entries(groups).map(([name, group]) =>
    [name, Array.isArray(group) ? group.map(prepare) : prepare(group)] as const);
  const build = (b: Budgets) => {
    const data: Record<string, unknown> = { ...extras };
    for (const [name, group] of prepared) {
      data[name] = Array.isArray(group) ? group.map(p => memoryEntry(p, b)) : memoryEntry(group as PreparedRow, b);
    }
    data.readNote = READ_NOTE;
    return data;
  };
  const fits = (b: Budgets) => JSON.stringify(build(b)).length <= ALDEN_TOOL_RESULT_LIMIT;
  const text = largestFitting(2, MAX_TEXT_BUDGET, t => fits({ id: MAX_TITLE, text: t }));
  const budgets: Budgets = text !== null
    ? { id: MAX_TITLE, text }
    : { id: largestFitting(2, MAX_TITLE, i => fits({ id: i, text: 2 })) ?? 2, text: 2 };
  const data = build(budgets);
  // Throws rather than deliver a cut result if the bound could not be met.
  serializeAldenToolResult("read_conversation_memories", data);
  return data;
}

/** One exact chunk of one row's content, bound to the content snapshot. */
export function readMemoryContentChunk(
  row: { id: string; content?: unknown } | null,
  args: Record<string, unknown>,
) {
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("invalid_request: offset must be a non-negative safe integer");
  }
  const expected = args.expected_content_sha256;
  if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) {
    throw new Error("invalid_request: expected_content_sha256 must be a 64-character lowercase hex digest");
  }
  if (offset > 0 && expected === undefined) {
    throw new Error("invalid_request: a continuation read (offset > 0) must pass expected_content_sha256 from the first chunk");
  }
  if (!row) throw new Error("memory_not_found: no conversation memory has this id");
  const source = asText(row.content);
  const contentSha256 = sha256(source);
  if (expected !== undefined && expected !== contentSha256) {
    throw new Error(
      `snapshot_changed: this memory's content changed since the first chunk (now ${source.length} characters, `
      + `contentSha256 ${contentSha256}); discard the chunks read so far and restart at offset 0`,
    );
  }
  if (offset > source.length || surrogateBoundary(source, offset) !== offset) {
    throw new Error("invalid_request: offset is outside the content or splits a surrogate pair");
  }
  // Any single character escapes to far less than the budget, so a chunk is
  // never empty before the end and the reader always progresses.
  const chunk = jsonPrefix(source.slice(offset), MEMORY_CONTENT_CHUNK_BUDGET);
  const end = offset + chunk.length;
  const complete = end === source.length;
  const data = {
    id: row.id,
    content: chunk,
    offset,
    nextOffset: complete ? null : end,
    totalCharacters: source.length,
    contentSha256,
    complete,
  };
  serializeAldenToolResult(READ_MEMORY_CONTENT_TOOL, data);
  return data;
}

/** A request value echoed back in a result, bounded so the echo cannot overflow it. */
export function boundEcho(value: unknown, max: number): unknown {
  return typeof value === "string" ? jsonPrefix(value, max) : value ?? null;
}

/** `limit` for query/arc/speaker searches: a positive whole number, default 5, at most 15. */
export function memorySearchLimit(value: unknown): number {
  if (value === undefined) return 5;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid_request: limit must be a positive whole number");
  }
  return Math.min(value, 15);
}

export function assertMemoryId(id: unknown): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error("invalid_request: id must be a conversation memory UUID");
  }
  return id;
}
