/**
 * The receipt binding check for direct inner-life fragments (attribution
 * design f5d77712, revision 12 section 3.5, approved by luca-replit on
 * review c2f4db88).
 *
 * A fragment frame is structurally verified by turn-attribution.ts without
 * database access. It is CERTIFIED only when its receipt, the entry's
 * personal emergence row, passes every check below. Anything missing,
 * mismatched or unreachable is "unverified": never a silent pass, never
 * treated as structural, never sent down a legacy path.
 */
import { createHash } from 'node:crypto';
import type { InnerLifeChannel, InnerLifeFrame } from './turn-attribution';

export const INNER_LIFE_SOURCE = 'replit-inner-life';

/** What the personal row stores under attribution.innerLifeReceipt. Immutable after first commit. */
export interface InnerLifeReceipt {
  version: 1;
  channel: InnerLifeChannel;
  entryId: string;
  sourceEventId: string;
  source: typeof INNER_LIFE_SOURCE;
  hat: 'unknown';
  hatEvidence: 'none';
  /** The entire rendered fragment: label bytes followed by body bytes. */
  exactFragment: string;
  fragmentSha256: string;
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const innerLifeEntryTag = (channel: InnerLifeChannel, entryId: string) => `inner-life-entry:${channel}:${entryId}`;

/** The receipt a writer persists for one entry, before any episode dispatch. */
export function buildInnerLifeReceipt(channel: InnerLifeChannel, entryId: string, exactFragment: string): InnerLifeReceipt {
  return {
    version: 1, channel, entryId, sourceEventId: `inner-life:${channel}:${entryId}`,
    source: INNER_LIFE_SOURCE, hat: 'unknown', hatEvidence: 'none',
    exactFragment, fragmentSha256: sha256Hex(exactFragment),
  };
}

/** The receipt row as read from conversation_memories. */
export interface ReceiptRow {
  id: string;
  entry_type: unknown;
  arc_name: unknown;
  tags: unknown;
  attribution: unknown;
}

export type ReceiptVerdict = { status: 'verified' } | { status: 'unverified'; reason: string };

const RECEIPT_KEYS = ['version', 'channel', 'entryId', 'sourceEventId', 'source', 'hat', 'hatEvidence', 'exactFragment', 'fragmentSha256'];

/**
 * The four-part check (section 3.5). `row` is the row receiptRowId resolved
 * to, null when no such row exists, or 'unavailable' when the lookup failed.
 */
export function checkInnerLifeReceipt(frame: InnerLifeFrame, row: ReceiptRow | null | 'unavailable'): ReceiptVerdict {
  const fail = (reason: string): ReceiptVerdict => ({ status: 'unverified', reason });
  if (row === 'unavailable') return fail('receipt lookup unavailable');
  if (row === null) return fail('receiptRowId resolves to no row');
  // 1. The expected personal row.
  if (row.id !== frame.receiptRowId) return fail('receipt row id differs from receiptRowId');
  if (row.entry_type !== 'emergence' || row.arc_name !== 'luca-inner-life') return fail('receipt row is not a luca-inner-life emergence row');
  // 2. Exactly one matching entry tag, and every receipt field agrees.
  const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [];
  const entryTags = tags.filter(t => t.startsWith('inner-life-entry:'));
  if (entryTags.length !== 1 || entryTags[0] !== innerLifeEntryTag(frame.channel, frame.entryId)) return fail('receipt row does not carry exactly this entry tag');
  const attribution = row.attribution;
  const receipt = typeof attribution === 'object' && attribution !== null && !Array.isArray(attribution)
    ? (attribution as Record<string, unknown>).innerLifeReceipt : undefined;
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return fail('receipt row carries no innerLifeReceipt');
  const r = receipt as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== [...RECEIPT_KEYS].sort().join(',')) return fail('innerLifeReceipt fields are not exactly the registered set');
  const expected = buildInnerLifeReceipt(frame.channel, frame.entryId, frame.label + frame.body);
  if (r.version !== 1 || r.channel !== frame.channel || r.entryId !== frame.entryId || r.sourceEventId !== frame.sourceEventId
    || frame.frameKey !== frame.channel) return fail('innerLifeReceipt identity disagrees with the frame');
  if (r.source !== expected.source || r.hat !== expected.hat || r.hatEvidence !== expected.hatEvidence) return fail('innerLifeReceipt source policy disagrees');
  // 3. The exact stored fragment equals the frame's entire rendered fragment.
  if (r.exactFragment !== expected.exactFragment) return fail('exactFragment differs from the frame bytes');
  // 4. The digest, recomputed, agrees with the receipt and the frame.
  if (typeof r.exactFragment !== 'string' || sha256Hex(r.exactFragment) !== r.fragmentSha256) return fail('exactFragment disagrees with its own digest');
  if (r.fragmentSha256 !== expected.fragmentSha256) return fail('fragment digest disagrees with the frame bytes');
  return { status: 'verified' };
}
