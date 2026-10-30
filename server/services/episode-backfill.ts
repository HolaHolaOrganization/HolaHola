/**
 * Founder-approved backfill of canonical per-turn rows into an episode row
 * (2026-10-30). Pure rules only: scripts/data-ops/backfill-episode-turns.ts
 * applies them under a row lock, and server/scripts/generate-episode-backfill-receipt.ts
 * builds the receipt read-only.
 *
 * The episode gap projection (#138) appends only turns newer than its process
 * floor; everything older is backlog that needs this explicit, reviewed list.
 * Each appended turn uses exactly the projection's marker and framing
 * (episodeTextForTurn), so a later projection pass sees it as present.
 */
import { createHash } from 'node:crypto';
import { episodeTextForTurn, turnPresentInEpisode, type CanonicalTurn } from './episode-gap-projection';

export const EPISODE_BACKFILL_RECEIPT_KIND = 'episode-gap-backfill';

export interface EpisodeBackfillEntry {
  rowId: string;
  captureId: string | null;
  /** created_at of the per-turn row, UTC ISO. */
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

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

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
    if (!Number.isFinite(Date.parse(e.createdAt))) return `entry ${i} has no valid time`;
    if (i > 0) {
      const p = receipt.entries[i - 1];
      const order = Date.parse(p.createdAt) - Date.parse(e.createdAt) || p.rowId.localeCompare(e.rowId);
      if (order > 0) return `entry ${i} is out of order`;
    }
  }
  return null;
}

export type EntryOutcome =
  | { status: 'append'; text: string }
  | { status: 'present' }
  | { status: 'missing-row' }
  | { status: 'drifted' };

/**
 * Decide one entry against the locked episode content and the current row.
 * A turn already in the episode (by marker, or by whole text for an unmarked
 * one) is never appended twice. A row that is gone or whose bytes no longer
 * match the approved hash is never appended.
 */
export function decideEntry(entry: EpisodeBackfillEntry, row: { content: string } | null, episodeContent: string): EntryOutcome {
  if (!row || typeof row.content !== 'string') return { status: 'missing-row' };
  if (sha256(row.content) !== entry.contentSha256) return { status: 'drifted' };
  const turn: CanonicalTurn = {
    id: entry.rowId,
    captureId: entry.captureId ?? undefined,
    content: row.content,
    createdAtMs: Date.parse(entry.createdAt),
  };
  if (turnPresentInEpisode(turn, episodeContent)) return { status: 'present' };
  return { status: 'append', text: '\n' + episodeTextForTurn(turn) + '\n' };
}
