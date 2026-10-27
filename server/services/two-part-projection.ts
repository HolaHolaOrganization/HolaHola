/**
 * Projection of declared two-part exchanges (approved A2 design 97df12be,
 * revision 4) from the capture log into conversation_memories, DB-only.
 *
 * Decide → record → act: a part block never has an effect at its own
 * position. The effect of an exchange is applied only when the projector's
 * cursor reaches its decision record (pair or reply-absent). An assistant
 * part that arrives after a reply-absent decision is a late reply and gets
 * its own row at its own position. Every effect is idempotent by a capture
 * identity tag, so replay after a crash never duplicates a row.
 *
 * Pure planning lives here so it can be tested without a database; the
 * autosave worker supplies the DB through TwoPartEffectStore.
 */

import {
  buildDialogueChunk,
  formatChatCaptureSpeakerLabel,
  type DialogueTurn,
  type ExchangeDecisionRecord,
} from './transcript-parser';
import type { TwoPartIndexEntry } from './canonical-conversation-capture';

export type TwoPartOutcome = 'pair' | 'reply-absent' | 'late-reply';

export interface TwoPartEffect {
  outcome: TwoPartOutcome;
  captureId: string;
  /** DB identity: the exchange id, or `<id>-late` for a late reply. */
  identity: string;
  turns: DialogueTurn[];
  /** Byte offset just after the block that triggers this effect. */
  offset: number;
}

export type TwoPartStep =
  /** The next `count` turns are atomic/legacy: the existing batch path handles them. */
  | { kind: 'legacy'; count: number }
  /** A part block with no effect at its own position. */
  | { kind: 'part'; offset: number; turn: DialogueTurn }
  | { kind: 'effect'; effect: TwoPartEffect };

/**
 * Decide what the head of the unprocessed range is. `turns`/`offsets` and
 * `records` are the remaining parsed items in file order; `index` covers the
 * whole log (from indexTwoPartExchanges). Impossible states throw.
 */
export function planNextTwoPartStep(
  turns: DialogueTurn[],
  offsets: number[],
  records: ExchangeDecisionRecord[],
  index: Map<string, TwoPartIndexEntry> | null,
): TwoPartStep | null {
  const nextRecordOffset = records[0]?.byteOffsetAfter ?? Infinity;
  const nextTurnOffset = offsets[0] ?? Infinity;
  if (nextRecordOffset === Infinity && nextTurnOffset === Infinity) return null;

  if (nextRecordOffset < nextTurnOffset) {
    const record = records[0];
    const entry = requireEntry(index, record.captureId);
    if (!entry.user) throw new Error(`two-part decision ${record.captureId} has no user part`);
    if (record.outcome === 'pair') {
      if (!entry.assistant || entry.assistantOffset === undefined || entry.assistantOffset > record.byteOffsetAfter) {
        throw new Error(`two-part pair decision ${record.captureId} is not preceded by its assistant part`);
      }
      return { kind: 'effect', effect: {
        outcome: 'pair', captureId: record.captureId, identity: record.captureId,
        turns: [entry.user, entry.assistant], offset: record.byteOffsetAfter,
      } };
    }
    return { kind: 'effect', effect: {
      outcome: 'reply-absent', captureId: record.captureId, identity: record.captureId,
      turns: [entry.user], offset: record.byteOffsetAfter,
    } };
  }

  const head = turns[0];
  if (head.exchangePart) {
    if (!head.captureId) throw new Error('two-part exchange part has no capture id');
    const entry = requireEntry(index, head.captureId);
    const decision = entry.decision;
    if (head.exchangePart === 'assistant' && decision?.outcome === 'reply-absent' &&
        decision.byteOffsetAfter < offsets[0]) {
      return { kind: 'effect', effect: {
        outcome: 'late-reply', captureId: head.captureId, identity: `${head.captureId}-late`,
        turns: [head], offset: offsets[0],
      } };
    }
    return { kind: 'part', offset: offsets[0], turn: head };
  }

  let count = 0;
  while (count < turns.length && !turns[count].exchangePart && offsets[count] < nextRecordOffset) count++;
  return { kind: 'legacy', count };
}

function requireEntry(index: Map<string, TwoPartIndexEntry> | null, captureId: string): TwoPartIndexEntry {
  const entry = index?.get(captureId);
  if (!entry) throw new Error(`two-part exchange ${captureId} is missing from the capture index`);
  return entry;
}

export interface TwoPartRow {
  identityTag: string;
  title: string;
  summary: string;
  content: string;
  participants: string[];
  tags: string[];
}

/** Build the conversation_memories row for an effect. Never truncates. */
export function buildTwoPartRow(effect: TwoPartEffect, now: Date = new Date()): TwoPartRow {
  const source = effect.turns[0].source ?? 'legacy';
  const identityTag = `capture-id:${effect.identity}`;
  const tags = [
    'david-luca-chat', 'canonical-conversation', 'verbatim', 'per-turn', 'chat-capture',
    `source-${source}`, identityTag, 'two-part-exchange',
    ...(effect.outcome === 'reply-absent' ? ['reply-absent'] : []),
    ...(effect.outcome === 'late-reply' ? ['late-reply', `reply-to:${effect.captureId}`] : []),
  ];
  const participants = [...new Set(effect.turns.map(turn =>
    turn.speaker === 'DAVID' ? 'David' : formatChatCaptureSpeakerLabel(turn),
  ))];
  // The verbatim text is never shortened, whatever its length.
  const { dialogue } = buildDialogueChunk(effect.turns, 0, Number.MAX_SAFE_INTEGER);
  const user = effect.turns.find(turn => turn.exchangePart === 'user');
  const timing = user?.occurredAt
    ? ` User message occurred at ${user.occurredAt} (source-reported); received ${user.receivedAt ?? 'unknown'}.`
    : '';
  const outcomeText = effect.outcome === 'pair'
    ? 'Two-part exchange: user part and reply.'
    : effect.outcome === 'reply-absent'
      ? 'Two-part exchange: the user part was recorded and no reply arrived within the timeout.'
      : `Two-part exchange: late reply to ${effect.captureId}, which was already recorded as reply-absent.`;
  const today = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return {
    identityTag,
    title: `David ↔ Agent — ${today}: canonical per-turn capture`,
    summary: `Verbatim canonical dialogue (per-turn, append-only; sources: ${source}). ${outcomeText}${timing} Capture identity: ${identityTag}.`,
    content: dialogue,
    participants,
    tags,
  };
}

export interface TwoPartEffectStore {
  hasRow(identityTag: string): Promise<boolean>;
  insertRow(row: TwoPartRow): Promise<void>;
}

/** Apply one effect idempotently. Returns true if a row was inserted. */
export async function applyTwoPartEffect(effect: TwoPartEffect, store: TwoPartEffectStore): Promise<boolean> {
  const row = buildTwoPartRow(effect);
  if (await store.hasRow(row.identityTag)) return false;
  await store.insertRow(row);
  return true;
}
