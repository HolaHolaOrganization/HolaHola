/**
 * Sent-vs-played ledger for the hats' observer (F1–F2, design note 135fe51b rev 2).
 * Memory only, bounded per conversation, reset when the dbSession changes so turns
 * of different sessions never mix. One summary row per finalized turn is persisted
 * by the caller; this module only keeps and judges.
 */
import {
  playbackVerdict,
  sanitizePlaybackSummary,
  type PlaybackTurnSummary,
  type PlaybackVerdict,
} from '@shared/playback-ledger';

const MAX_TURNS = 30;

interface TurnLedger {
  turnId: number;
  sentChunks: number;
  bargeIn: boolean;
  firstSentMs: number | null;
  lastSentMs: number | null;
  summaries: PlaybackTurnSummary[];
}

interface ConversationLedger {
  dbSessionId: string | null;
  turns: Map<number, TurnLedger>;
}

const ledgers = new Map<string, ConversationLedger>();

function ledgerFor(conversationId: string, dbSessionId: string | null): ConversationLedger {
  let ledger = ledgers.get(conversationId);
  if (!ledger || ledger.dbSessionId !== dbSessionId) {
    ledger = { dbSessionId, turns: new Map() };
    ledgers.set(conversationId, ledger);
  }
  return ledger;
}

function turnFor(ledger: ConversationLedger, turnId: number): TurnLedger {
  let turn = ledger.turns.get(turnId);
  if (!turn) {
    turn = { turnId, sentChunks: 0, bargeIn: false, firstSentMs: null, lastSentMs: null, summaries: [] };
    ledger.turns.set(turnId, turn);
    while (ledger.turns.size > MAX_TURNS) ledger.turns.delete(ledger.turns.keys().next().value!);
  }
  return turn;
}

/** Read-only tap on outbound messages: counts non-empty audio chunks per turn. Seal markers are not audio. */
export function observeAudioSent(conversationId: string | undefined, dbSessionId: string | null, message: any, now = Date.now()): void {
  if (!conversationId || message?.type !== 'audio_chunk') return;
  if (typeof message.audio !== 'string' || message.audio.length === 0) return;
  if (!Number.isSafeInteger(message.turnId)) return;
  const turn = turnFor(ledgerFor(conversationId, dbSessionId), message.turnId);
  turn.sentChunks++;
  turn.firstSentMs ??= now;
  turn.lastSentMs = now;
}

/** A student barge-in cut this turn short on purpose; short playback is expected, not a fault. */
export function observeBargeIn(conversationId: string | undefined, dbSessionId: string | null, turnId: number): void {
  if (!conversationId || !Number.isSafeInteger(turnId)) return;
  turnFor(ledgerFor(conversationId, dbSessionId), turnId).bargeIn = true;
}

export interface RecordedSummary { summary: PlaybackTurnSummary; verdict: PlaybackVerdict; dbSessionId: string | null; duplicate: boolean }

/**
 * Record one client summary. Idempotent by (turnId, instanceId): a retransmitted
 * summary is reported as a duplicate and never counted twice. Returns null for
 * malformed input or a conversation with no live ledger.
 */
export function observePlaybackSummary(conversationId: string | undefined, raw: unknown): RecordedSummary | null {
  const summary = sanitizePlaybackSummary(raw);
  if (!conversationId || !summary) return null;
  const ledger = ledgers.get(conversationId);
  if (!ledger) return null;
  const turn = turnFor(ledger, summary.turnId);
  const duplicate = turn.summaries.some(s => s.instanceId === summary.instanceId);
  if (!duplicate) turn.summaries.push(summary);
  return {
    summary,
    verdict: playbackVerdict({ chunks: turn.sentChunks, bargeIn: turn.bargeIn }, turn.summaries),
    dbSessionId: ledger.dbSessionId,
    duplicate,
  };
}

export interface PlaybackObservation {
  dbSessionId: string | null;
  thresholdVersion: string;
  turns: Array<{ turnId: number; sentChunks: number; bargeIn: boolean; summaries: number; verdict: PlaybackVerdict }>;
}

export function getPlaybackObservation(conversationId: string): PlaybackObservation | null {
  const ledger = ledgers.get(conversationId);
  if (!ledger) return null;
  const turns = [...ledger.turns.values()].map(turn => ({
    turnId: turn.turnId,
    sentChunks: turn.sentChunks,
    bargeIn: turn.bargeIn,
    summaries: turn.summaries.length,
    verdict: playbackVerdict(turn.sentChunks > 0 || turn.bargeIn ? { chunks: turn.sentChunks, bargeIn: turn.bargeIn } : null, turn.summaries),
  }));
  return { dbSessionId: ledger.dbSessionId, thresholdVersion: turns[0]?.verdict.thresholdVersion ?? 'pb-1-provisional', turns };
}

export function resetPlaybackObservationForTests(): void {
  ledgers.clear();
}
