/**
 * Founder-approved backfill of canonical per-turn rows into an episode row
 * (2026-10-30). Pure rules only: scripts/data-ops/backfill-episode-turns.ts
 * applies them in one transaction, and
 * server/scripts/generate-episode-backfill-receipt.ts builds the receipt
 * read-only.
 *
 * The episode gap projection (#138) appends only turns newer than its process
 * floor; everything older is backlog that needs this explicit, reviewed list.
 * Each appended turn uses exactly the projection's marker and framing
 * (episodeTextForTurn), so a later projection pass sees it as present.
 *
 * A backfill may only fill an appendable tail: if any canonical turn newer
 * than the oldest missing one is already in the episode, appending would put
 * an older turn after a newer one, so the plan refuses (an interior gap needs
 * its own reviewed repair). Source identity is the row's content, capture id,
 * timestamp and canonical membership, all checked against the receipt.
 */
import { createHash } from 'node:crypto';
import { captureIdFromTags, episodeTextForTurn, turnPresentInEpisode, type CanonicalTurn } from './episode-gap-projection';

export const EPISODE_BACKFILL_RECEIPT_KIND = 'episode-gap-backfill';
/** The canonical per-turn conversation arc and tag. */
export const PER_TURN_ARC = 'david-luca-chat';
export const PER_TURN_TAG = 'per-turn';
/**
 * created_at is naive UTC. Both the generator and the executor render it with
 * this exact Postgres format (fixed width, microseconds), so identity compares
 * as text and order compares lexicographically without a Date conversion.
 */
export const CREATED_AT_SQL = `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.US')`;

export interface EpisodeBackfillEntry {
  rowId: string;
  captureId: string | null;
  /** created_at rendered with CREATED_AT_SQL (naive UTC). */
  createdAt: string;
  contentSha256: string;
}

export interface EpisodeBackfillReceipt {
  kind: string;
  episodeId: string;
  episodeTitle: string;
  /** Oldest first, in the order the turns must be appended. */
  entries: EpisodeBackfillEntry[];
  /** sha256 of JSON.stringify(entries): binds the approved list. */
  listSha256: string;
}

/** A source row as read inside the apply transaction. */
export interface SourceRow {
  id: string;
  content: string;
  createdAt: string;
  arcName: string | null;
  tags: string[] | null;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const CREATED_AT_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const isPerTurn = (row: Pick<SourceRow, 'arcName' | 'tags'>) => row.arcName === PER_TURN_ARC && (row.tags ?? []).includes(PER_TURN_TAG);
const turnOf = (row: SourceRow): CanonicalTurn =>
  ({ id: row.id, captureId: captureIdFromTags(row.tags), content: row.content, createdAtMs: Date.parse(row.createdAt.replace(' ', 'T') + 'Z') });

/** Why a receipt cannot be applied, or null if it is well formed. */
export function episodeBackfillReceiptProblem(receipt: EpisodeBackfillReceipt): string | null {
  if (receipt.kind !== EPISODE_BACKFILL_RECEIPT_KIND) return `receipt kind is not ${EPISODE_BACKFILL_RECEIPT_KIND}`;
  if (!receipt.episodeId || !receipt.episodeTitle) return 'receipt names no episode';
  if (!Array.isArray(receipt.entries) || receipt.entries.length === 0) return 'receipt has no entries';
  if (sha256(JSON.stringify(receipt.entries)) !== receipt.listSha256) return 'receipt list hash does not match its entries';
  const seen = new Set<string>();
  for (let i = 0; i < receipt.entries.length; i++) {
    const e = receipt.entries[i];
    if (!e.rowId || seen.has(e.rowId)) return `entry ${i} has a missing or repeated row id`;
    seen.add(e.rowId);
    if (!/^[0-9a-f]{64}$/.test(e.contentSha256)) return `entry ${i} has no content hash`;
    if (!CREATED_AT_TEXT.test(e.createdAt)) return `entry ${i} has no valid time`;
    if (i > 0) {
      const p = receipt.entries[i - 1];
      if (p.createdAt > e.createdAt || (p.createdAt === e.createdAt && p.rowId > e.rowId)) return `entry ${i} is out of order`;
    }
  }
  return null;
}

/** Why a source row no longer matches its approved entry, or null. */
export function sourceDrift(entry: EpisodeBackfillEntry, row: SourceRow | undefined): string | null {
  if (!row || typeof row.content !== 'string') return 'source row missing';
  if (!isPerTurn(row)) return 'source row is no longer a canonical per-turn row';
  if (row.createdAt !== entry.createdAt) return 'source row time changed';
  if ((captureIdFromTags(row.tags) ?? null) !== entry.captureId) return 'source row capture id changed';
  if (sha256(row.content) !== entry.contentSha256) return 'source row content changed';
  return null;
}

export type BackfillPlan =
  | { status: 'append'; text: string; appending: number; alreadyPresent: number }
  | { status: 'complete'; alreadyPresent: number }
  | { status: 'refused'; reason: string; rowId?: string };

/**
 * Decide the whole backfill against the locked episode. Writes nothing.
 *  - every receipt source must match its entry exactly (sourceDrift);
 *  - present entries must be a prefix of the receipt (a later entry present
 *    while an earlier one is absent is an interior gap);
 *  - no canonical turn outside the receipt and newer than the oldest absent
 *    entry may already be in the episode (it would end up before older text).
 * `newer` are canonical per-turn rows created after the oldest absent entry.
 */
export function planBackfill(
  receipt: EpisodeBackfillReceipt,
  sources: Map<string, SourceRow>,
  newer: SourceRow[],
  episodeContent: string,
): BackfillPlan {
  const present: boolean[] = [];
  for (const entry of receipt.entries) {
    const row = sources.get(entry.rowId);
    const drift = sourceDrift(entry, row);
    if (drift) return { status: 'refused', reason: drift, rowId: entry.rowId };
    present.push(turnPresentInEpisode(turnOf(row!), episodeContent));
  }
  const firstAbsent = present.indexOf(false);
  if (firstAbsent < 0) return { status: 'complete', alreadyPresent: present.length };
  const laterPresent = present.indexOf(true, firstAbsent);
  if (laterPresent >= 0) {
    return { status: 'refused', reason: 'interior gap: a later receipt turn is present while an earlier one is not', rowId: receipt.entries[laterPresent].rowId };
  }
  const listed = new Set(receipt.entries.map((e) => e.rowId));
  const oldestAbsent = receipt.entries[firstAbsent].createdAt;
  for (const row of newer) {
    if (listed.has(row.id) || !isPerTurn(row) || row.createdAt <= oldestAbsent) continue;
    if (turnPresentInEpisode(turnOf(row), episodeContent)) {
      return { status: 'refused', reason: 'interior gap: a newer canonical turn is already in the episode', rowId: row.id };
    }
  }
  const text = receipt.entries.slice(firstAbsent)
    .map((entry) => '\n' + episodeTextForTurn(turnOf(sources.get(entry.rowId)!)) + '\n')
    .join('');
  return { status: 'append', text, appending: receipt.entries.length - firstAbsent, alreadyPresent: firstAbsent };
}

/** One embedding the episode should have: (memory_type, memory_id) and the hash of its source text. */
export interface ExpectedArm { memoryType: string; memoryId: string; contentHash: string }
export interface StoredArm { memoryType: string; memoryId: string; contentHash: string }

/**
 * Compare the embeddings an episode should have with what is stored. Current
 * means every expected arm exists with the expected content hash and no chunk
 * arm beyond the expected count remains for this memory.
 */
export function embeddingCoverage(expected: ExpectedArm[], stored: StoredArm[], chunkPrefix: string): { current: boolean; missing: number; stale: number; extra: number } {
  const byKey = new Map(stored.map((s) => [`${s.memoryType}|${s.memoryId}`, s.contentHash]));
  let missing = 0, stale = 0;
  for (const e of expected) {
    const got = byKey.get(`${e.memoryType}|${e.memoryId}`);
    if (got === undefined) missing++;
    else if (got !== e.contentHash) stale++;
  }
  const expectedIds = new Set(expected.map((e) => e.memoryId));
  const extra = stored.filter((s) => s.memoryType === 'conversation_chunk' && s.memoryId.startsWith(chunkPrefix) && !expectedIds.has(s.memoryId)).length;
  return { current: missing === 0 && stale === 0 && extra === 0, missing, stale, extra };
}
