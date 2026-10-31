/**
 * The Alden inbox wake's pure rules (design eb2ed6bf r10/r11): the loop
 * breaker's comparison and evidence test, and which outcomes owe David a
 * notice. No database access, so they are unit-tested directly.
 */
import { createHash } from 'node:crypto';

export type WakeItemKind = 'addressed' | 'observe';
export const LOOP_LENGTH = 3;
const FOUNDER_ACTOR = 'david';

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The loop breaker's comparison form: whitespace collapsed and case folded,
 * with ISO-8601 timestamps masked because they differ on every message
 * without changing what it says. Numbers, PR numbers, commit shas and event
 * ids are deliberately kept, so messages that differ only in the record they
 * name never count as a repeat (LR's r11 caution).
 */
export function normalizeForLoop(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
export const loopHash = (text: string) => sha256(normalizeForLoop(text));

/** Which outcomes leave a notice obligation for David. */
export function noticeOwed(kind: WakeItemKind, state: string): boolean {
  if (kind === 'observe') return ['failed', 'uncertain', 'conflict'].includes(state);
  return ['replied', 'declined', 'needs_david', 'failed', 'uncertain', 'conflict'].includes(state);
}

export interface ThreadReplyPair { replyEventId: string; replySequence: number; replyHash: string; triggerActor: string; triggerHash: string }

/**
 * True only for a repeating exchange: the last three wake replies share one
 * normalized hash, each answered the same single counterpart, those three
 * messages share one normalized hash, and none of them is David's. Volume,
 * frequency and thread length never count.
 */
export function isRepeatingExchange(pairs: ThreadReplyPair[]): boolean {
  if (pairs.length < LOOP_LENGTH) return false;
  const [first] = pairs;
  return pairs.every((pair) =>
    pair.replyHash === first.replyHash
    && pair.triggerHash === first.triggerHash
    && pair.triggerActor === first.triggerActor
    && pair.triggerActor !== FOUNDER_ACTOR);
}
