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
export const MEMORY_CONTENT_CHUNK_BUDGET = 9_000;
const DISCOVERY_START_BUDGET = 1_200;
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

/**
 * Discovery entry for one row. Text fields are cut to `budget` escaped-JSON
 * characters and say so; `content` appears only when the whole text fits,
 * otherwise `contentExcerpt` (a leading excerpt, never a summary) does.
 */
function memoryEntry(row: MemoryRow, budget: number, speakerExcerpt?: string) {
  const title = asText(row.title);
  const summary = asText(row.summary);
  const content = asText(row.content);
  const shownTitle = jsonPrefix(title, Math.min(budget, 300));
  const shownSummary = jsonPrefix(summary, budget);
  const shownContent = jsonPrefix(content, budget);
  const contentComplete = shownContent.length === content.length;
  const { tags, tagsComplete } = boundedTags(row.tags, Math.min(budget, 400));
  const shownArc = row.arc_name == null ? null : jsonPrefix(asText(row.arc_name), Math.min(budget, 80));
  return {
    id: row.id,
    title: shownTitle,
    ...(shownTitle.length === title.length ? {} : { titleComplete: false }),
    importance: row.importance ?? null,
    entryType: row.entry_type == null ? null : jsonPrefix(asText(row.entry_type), 40),
    tags,
    ...(tagsComplete ? {} : { tagsComplete: false }),
    arcName: shownArc,
    ...(shownArc === null || shownArc.length === asText(row.arc_name).length ? {} : { arcNameComplete: false }),
    extendsMemoryId: row.extends_memory_id ?? null,
    recordedAt: row.created_at ?? null,
    summary: shownSummary,
    ...(shownSummary.length === summary.length ? {} : { summaryComplete: false }),
    totalCharacters: content.length,
    contentSha256: sha256(content),
    contentComplete,
    ...(contentComplete ? { content } : { contentExcerpt: shownContent }),
    ...(speakerExcerpt !== undefined ? { speakerExcerpt: jsonPrefix(speakerExcerpt, budget) } : {}),
  };
}

const READ_NOTE =
  "Entries with contentComplete=false show only a leading excerpt. Read the full text with "
  + `${READ_MEMORY_CONTENT_TOOL}(id, offset=0), then pass nextOffset and expected_content_sha256 `
  + "until complete=true, joining chunks in offset order.";

/**
 * Shape any discovery result so that it fits the serializer limit, shrinking
 * the per-row text budget until it does. `rows` maps a group name (memories,
 * ancestors, descendants, anchor) to its rows, in order.
 */
export function buildMemoryDiscovery(
  groups: Record<string, MemoryRow[] | MemoryRow>,
  extras: Record<string, unknown>,
  speakerExcerpt?: (row: MemoryRow) => string,
) {
  const rowCount = Object.values(groups).reduce((n, g) => n + (Array.isArray(g) ? g.length : 1), 0);
  const build = (budget: number) => {
    const data: Record<string, unknown> = { ...extras };
    for (const [name, group] of Object.entries(groups)) {
      const entry = (row: MemoryRow) => memoryEntry(row, budget, speakerExcerpt?.(row));
      data[name] = Array.isArray(group) ? group.map(entry) : entry(group);
    }
    data.readNote = READ_NOTE;
    return data;
  };
  let budget = DISCOVERY_START_BUDGET;
  let data = build(budget);
  while (JSON.stringify(data).length > ALDEN_TOOL_RESULT_LIMIT && rowCount > 0 && budget > 2) {
    const excess = JSON.stringify(data).length - ALDEN_TOOL_RESULT_LIMIT;
    budget = Math.max(2, budget - Math.max(1, Math.ceil(excess / rowCount)));
    data = build(budget);
  }
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

export function assertMemoryId(id: unknown): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new Error("invalid_request: id must be a conversation memory UUID");
  }
  return id;
}
