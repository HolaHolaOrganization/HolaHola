/**
 * Ordered merge of missing canonical turns into an episode row (design
 * 4994db25, approved at revision 1edd750c, founder-authorized 2026-11-01).
 * Pure rules only: scripts/data-ops/rebuild-episode-ordered.ts applies them in
 * one transaction, and server/scripts/generate-episode-rebuild-receipt.ts
 * builds the receipt read-only.
 *
 * The append-only backfill (episode-backfill.ts) refuses an interior gap. This
 * merge fills one without changing a byte that is already there: the episode
 * is an opening (everything before the first turn marker) followed by existing
 * blocks (each from its marker to the next marker or the end), and each
 * missing turn is inserted at a block boundary, before the first existing
 * block that is later, or at the end. The inserted text is exactly what the
 * projection appends ('\n' + episodeTextForTurn + '\n'), so later projection
 * passes see every inserted turn as present.
 *
 * Markers are found by structure, not by a free search: a marker counts only
 * as a whole line, and a marker string anywhere else refuses the merge. Every
 * marker must resolve to exactly one canonical row, and the number of markers
 * must equal the number of rows they resolve to.
 *
 * Order is created_at rendered as fixed-width naive-UTC text (CREATED_AT_SQL),
 * then row id in code-unit order: the same order as the receipt validator and
 * the backfill planner. No Date conversion is used for order or identity.
 */
import { captureIdFromTags, episodeTextForTurn, isCiSentinelExchange, turnEpisodeMarker } from './episode-gap-projection';
import { PER_TURN_ARC, PER_TURN_TAG, sha256, sourceDrift, type EpisodeBackfillEntry, type SourceRow } from './episode-backfill';

export const ORDERED_MERGE_RECEIPT_KIND = 'episode-ordered-merge';
export const ORDERED_MERGE_SNAPSHOT_REASON = 'episode-ordered-merge';

/** A marker as the projection and the live chat-capture route write it. */
const MARKER_RE = /<!-- (?:chat-capture|canonical-row):[^\s>]+ -->/g;
const CREATED_AT_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface OrderedMergeEntry extends EpisodeBackfillEntry {
  /** Index of the existing block this turn goes before, or null for the end. */
  insertBefore: number | null;
}

/** An existing block, identified by its marker and the canonical row it resolves to. */
export interface ExistingBlockRef {
  marker: string;
  rowId: string;
  createdAt: string;
}

export interface OrderedMergeReceipt {
  kind: string;
  episodeId: string;
  episodeTitle: string;
  /** The episode row's created_at (CREATED_AT_SQL): the start of its turn window. */
  episodeCreatedAt: string;
  /** Inclusive upper bound (CREATED_AT_SQL). Later turns are left to the projection. */
  until: string;
  oldContentSha256: string;
  oldContentLength: number;
  existing: ExistingBlockRef[];
  /** Oldest first. */
  entries: OrderedMergeEntry[];
  /** sha256 of JSON.stringify(entries). */
  listSha256: string;
  /** The exact bytes the merge produces: approved, not just the list. */
  newContentSha256: string;
  newContentLength: number;
}

export type MergeResult =
  | { status: 'merge'; newContent: string; existing: ExistingBlockRef[]; entries: OrderedMergeEntry[] }
  | { status: 'complete'; existing: ExistingBlockRef[] }
  | { status: 'refused'; reason: string; rowId?: string };

const before = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
const isPerTurn = (row: Pick<SourceRow, 'arcName' | 'tags'>) => row.arcName === PER_TURN_ARC && (row.tags ?? []).includes(PER_TURN_TAG);
/** The turn as the projection builds it: trimmed content, capture id from tags. */
const turnOf = (row: SourceRow) => ({ id: row.id, captureId: captureIdFromTags(row.tags), content: row.content.trim(), createdAtMs: 0 });
const markerOf = (row: SourceRow) => turnEpisodeMarker({ id: row.id, captureId: captureIdFromTags(row.tags) });
/** Exactly what the projection appends for one turn. */
export const insertedTextFor = (row: SourceRow) => '\n' + episodeTextForTurn(turnOf(row)) + '\n';

/**
 * Split an episode into its opening and blocks by structure. Every marker
 * occurrence must be a whole line (at the start of the text or after '\n', and
 * followed by '\n' or the end); any other occurrence refuses.
 */
export function parseEpisodeBlocks(content: string): { openingEnd: number; markers: { marker: string; start: number }[] } | { problem: string } {
  const markers: { marker: string; start: number }[] = [];
  for (const m of content.matchAll(MARKER_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const lineStart = start === 0 || content[start - 1] === '\n';
    const lineEnd = end === content.length || content[end] === '\n';
    if (!lineStart || !lineEnd) return { problem: `a turn marker appears inside a line at character ${start}` };
    markers.push({ marker: m[0], start });
  }
  return { openingEnd: markers.length ? markers[0].start : content.length, markers };
}

/**
 * The canonical turns of an episode window, in order: per-turn rows created at
 * or after the episode, CI sentinel rows excluded (the projection never
 * projects them).
 */
export function windowTurns(rows: readonly SourceRow[], episodeCreatedAt: string): SourceRow[] {
  return rows
    .filter((r) => isPerTurn(r) && typeof r.content === 'string' && r.createdAt >= episodeCreatedAt && !isCiSentinelExchange(r.content))
    .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}

/** Map each existing marker to its canonical row; refuse unknown, shared or repeated markers. */
function resolveBlocks(markers: { marker: string; start: number }[], turns: SourceRow[]):
  { blocks: (ExistingBlockRef & { start: number; row: SourceRow })[] } | { problem: string; rowId?: string } {
  const byMarker = new Map<string, SourceRow>();
  for (const row of turns) {
    const marker = markerOf(row);
    if (byMarker.has(marker)) return { problem: 'two canonical rows share one marker', rowId: row.id };
    byMarker.set(marker, row);
  }
  const seen = new Set<string>();
  const blocks: (ExistingBlockRef & { start: number; row: SourceRow })[] = [];
  for (const { marker, start } of markers) {
    const row = byMarker.get(marker);
    if (!row) return { problem: `marker ${marker} resolves to no canonical turn in this episode's window` };
    if (seen.has(row.id)) return { problem: 'a turn marker appears more than once', rowId: row.id };
    seen.add(row.id);
    blocks.push({ marker, rowId: row.id, createdAt: row.createdAt, start, row });
  }
  // The number of markers equals the number of distinct rows they resolve to.
  if (seen.size !== markers.length) return { problem: 'marker count does not match the rows the markers resolve to' };
  for (let i = 1; i < blocks.length; i++) {
    if (!before(blocks[i - 1].row, blocks[i].row)) return { problem: 'existing turns are not in time order; this merge does not reorder them', rowId: blocks[i].rowId };
  }
  return { blocks };
}

/**
 * Compute the merge for an episode's current content, read-only. `turns` are
 * every canonical per-turn row the caller read (any order, any time); only the
 * episode window up to and including `until` is merged.
 */
export function computeOrderedMerge(content: string, rows: readonly SourceRow[], episodeCreatedAt: string, until: string): MergeResult {
  if (!CREATED_AT_TEXT.test(episodeCreatedAt) || !CREATED_AT_TEXT.test(until)) return { status: 'refused', reason: 'episode start and until must be CREATED_AT_SQL text' };
  if (until < episodeCreatedAt) return { status: 'refused', reason: 'until is before the episode began' };
  const parsed = parseEpisodeBlocks(content);
  if ('problem' in parsed) return { status: 'refused', reason: parsed.problem };
  const turns = windowTurns(rows, episodeCreatedAt);
  const resolved = resolveBlocks(parsed.markers, turns);
  if ('problem' in resolved) return { status: 'refused', reason: resolved.problem, rowId: resolved.rowId };
  const { blocks } = resolved;
  const existing = blocks.map(({ marker, rowId, createdAt }) => ({ marker, rowId, createdAt }));
  const late = blocks.find((b) => b.createdAt > until);
  if (late) return { status: 'refused', reason: 'the episode already holds a turn newer than until; generate a new receipt', rowId: late.rowId };

  const present = new Set(blocks.map((b) => b.rowId));
  const missing = turns.filter((t) => t.createdAt <= until && !present.has(t.id));
  if (missing.length === 0) return { status: 'complete', existing };

  const entries: OrderedMergeEntry[] = missing.map((row) => {
    const next = blocks.findIndex((b) => before(row, b.row));
    return {
      rowId: row.id, captureId: captureIdFromTags(row.tags) ?? null, createdAt: row.createdAt,
      contentSha256: sha256(row.content), insertBefore: next < 0 ? null : next,
    };
  });
  const rowById = new Map(missing.map((r) => [r.id, r]));
  const textOf = (e: OrderedMergeEntry) => insertedTextFor(rowById.get(e.rowId)!);

  // Pieces in order; `kept` pieces are the old content, unchanged.
  const pieces: { text: string; kept: boolean }[] = [{ text: content.slice(0, parsed.openingEnd), kept: true }];
  blocks.forEach((b, i) => {
    for (const e of entries) if (e.insertBefore === i) pieces.push({ text: textOf(e), kept: false });
    pieces.push({ text: content.slice(b.start, i + 1 < blocks.length ? blocks[i + 1].start : content.length), kept: true });
  });
  for (const e of entries) if (e.insertBefore === null) pieces.push({ text: textOf(e), kept: false });
  const newContent = pieces.map((p) => p.text).join('');

  // Check 1: removing exactly the inserted spans gives back the old content.
  if (pieces.filter((p) => p.kept).map((p) => p.text).join('') !== content) return { status: 'refused', reason: 'removing the inserted turns does not give back the old content' };
  // Check 2: the opening is unchanged.
  if (!newContent.startsWith(content.slice(0, parsed.openingEnd))) return { status: 'refused', reason: 'the opening would change' };
  // Checks 3 and 4: the new content parses by structure to every window turn up
  // to until, each exactly once, in strict time order.
  const reparsed = parseEpisodeBlocks(newContent);
  if ('problem' in reparsed) return { status: 'refused', reason: `merged content: ${reparsed.problem}` };
  const reresolved = resolveBlocks(reparsed.markers, turns);
  if ('problem' in reresolved) return { status: 'refused', reason: `merged content: ${reresolved.problem}`, rowId: reresolved.rowId };
  const expected = turns.filter((t) => t.createdAt <= until).map((t) => t.id);
  const got = reresolved.blocks.map((b) => b.rowId);
  if (got.length !== expected.length || got.some((id, i) => id !== expected[i])) return { status: 'refused', reason: 'merged content does not hold every turn up to until exactly once in order' };
  return { status: 'merge', newContent, existing, entries };
}

/** Why a receipt cannot be applied, or null if it is well formed. */
export function orderedMergeReceiptProblem(r: OrderedMergeReceipt): string | null {
  if (r.kind !== ORDERED_MERGE_RECEIPT_KIND) return `receipt kind is not ${ORDERED_MERGE_RECEIPT_KIND}`;
  if (!r.episodeId || !r.episodeTitle) return 'receipt names no episode';
  if (!CREATED_AT_TEXT.test(r.episodeCreatedAt ?? '') || !CREATED_AT_TEXT.test(r.until ?? '')) return 'receipt times are not CREATED_AT_SQL text';
  for (const h of [r.oldContentSha256, r.newContentSha256, r.listSha256]) if (!SHA256_HEX.test(h ?? '')) return 'receipt is missing a content or list hash';
  if (!Array.isArray(r.entries) || r.entries.length === 0) return 'receipt has no entries';
  if (!Array.isArray(r.existing)) return 'receipt lists no existing blocks';
  if (sha256(JSON.stringify(r.entries)) !== r.listSha256) return 'receipt list hash does not match its entries';
  for (let i = 0; i < r.entries.length; i++) {
    const e = r.entries[i];
    if (!e.rowId || !SHA256_HEX.test(e.contentSha256) || !CREATED_AT_TEXT.test(e.createdAt)) return `entry ${i} is incomplete`;
    if (e.createdAt > r.until) return `entry ${i} is after until`;
    if (i > 0 && !before({ createdAt: r.entries[i - 1].createdAt, id: r.entries[i - 1].rowId }, { createdAt: e.createdAt, id: e.rowId })) return `entry ${i} is out of order`;
  }
  return null;
}

/**
 * Decide the apply against the locked episode content and the canonical rows
 * read in the same transaction. Writes nothing. A re-run after success finds
 * the approved new content and reports complete.
 */
export function planOrderedMergeApply(receipt: OrderedMergeReceipt, lockedContent: string, rows: readonly SourceRow[]): MergeResult {
  const problem = orderedMergeReceiptProblem(receipt);
  if (problem) return { status: 'refused', reason: problem };
  const lockedSha = sha256(lockedContent);
  if (lockedSha === receipt.newContentSha256) return { status: 'complete', existing: receipt.existing };
  if (lockedSha !== receipt.oldContentSha256) return { status: 'refused', reason: 'the episode changed since the receipt was generated; generate a new receipt' };
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const entry of receipt.entries) {
    const drift = sourceDrift(entry, byId.get(entry.rowId));
    if (drift) return { status: 'refused', reason: drift, rowId: entry.rowId };
  }
  const merge = computeOrderedMerge(lockedContent, rows, receipt.episodeCreatedAt, receipt.until);
  if (merge.status !== 'merge') return merge.status === 'complete' ? { status: 'refused', reason: 'nothing is missing, but the episode is not the approved content' } : merge;
  // A turn at or before until that the receipt does not list (for example a
  // late commit carrying an old timestamp) refuses rather than being skipped.
  if (JSON.stringify(merge.entries) !== JSON.stringify(receipt.entries)) return { status: 'refused', reason: 'the turns to insert differ from the receipt; generate a new receipt' };
  if (JSON.stringify(merge.existing) !== JSON.stringify(receipt.existing)) return { status: 'refused', reason: 'the existing turns differ from the receipt' };
  if (sha256(merge.newContent) !== receipt.newContentSha256) return { status: 'refused', reason: 'the merged content differs from the approved content' };
  return merge;
}

/** Build the receipt for a computed merge (read-only generator). */
export function orderedMergeReceipt(
  episode: { id: string; title: string; createdAt: string; content: string },
  until: string,
  merge: Extract<MergeResult, { status: 'merge' }>,
): OrderedMergeReceipt {
  return {
    kind: ORDERED_MERGE_RECEIPT_KIND,
    episodeId: episode.id,
    episodeTitle: episode.title,
    episodeCreatedAt: episode.createdAt,
    until,
    oldContentSha256: sha256(episode.content),
    oldContentLength: episode.content.length,
    existing: merge.existing,
    entries: merge.entries,
    listSha256: sha256(JSON.stringify(merge.entries)),
    newContentSha256: sha256(merge.newContent),
    newContentLength: merge.newContent.length,
  };
}
