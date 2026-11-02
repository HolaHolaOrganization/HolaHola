/**
 * Codex recording adapter (native Codex onboarding design 4860f832, step 3).
 *
 * Parses a Codex session rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * into the same ParseResult the Antigravity journal shipper ships, so Codex
 * exchanges reach POST /api/internal/canonical-conversation-exchange as source
 * "codex" through the same checkpointed, fail-closed path.
 *
 * Chosen after inspecting the real runtime (Codex desktop 26.1027, CLI
 * 0.166.0-alpha.5.1, 2026-11-01), not assumed:
 *  - David's words are `response_item` messages with role "user" whose every
 *    content item has provenance "user". Injected context (provenance
 *    "harness", developer messages) is never dialogue.
 *  - Codex's reply is the assistant message with phase "final_answer";
 *    "commentary" progress notes are not the reply.
 *  - A turn is complete only when its `task_complete` event exists, and its
 *    final answer must equal `task_complete.last_agent_message`, or the turn
 *    is held as unresolved (fail closed, never guessed).
 *  - A turn with no task_complete is an open trailing turn when it is the last
 *    one, otherwise unresolved. Partial material is never shipped as complete.
 *
 * Model and provider are reported by the runtime (turn_context.model,
 * session_meta.model_provider) and kept in the parse result, but the intake
 * endpoint accepts no metadata yet, so they are not sent: unknown stays unknown.
 */
import type { AntigravityExchange, OpenTrailingTurn, ParseResult, UnresolvedTurn } from './antigravity-journal-shipper';

export const CODEX_TURN_ID_PREFIX = 'codex-';
const TURN_ID = /^[A-Za-z0-9-]+$/;

export interface CodexRuntimeFacts {
  sessionId: string;
  cliVersion?: string;
  originator?: string;
  modelProvider?: string;
  /** turn_context.model per turn, as the runtime reported it. */
  modelByTurn: Record<string, string>;
}

export interface CodexParseResult extends ParseResult {
  runtime: CodexRuntimeFacts;
  /** Turns with no user-provenance message (automated or tool-only); never dialogue. */
  skippedNonDialogueTurns: number;
}

interface TurnState {
  turnId: string;
  order: number;
  userParts: string[];
  userCreatedAt?: string;
  finalAnswers: string[];
  lastAgentMessage?: string | null;
  completed: boolean;
  aborted: boolean;
}

const textOf = (content: unknown, kind: 'input_text' | 'output_text'): string =>
  Array.isArray(content) ? content.filter((c: any) => c?.type === kind && typeof c.text === 'string').map((c: any) => c.text).join('') : '';

const isUserProvenance = (payload: any): boolean => {
  const items = payload?.internal_chat_message_metadata_passthrough?.content_item_metadata;
  return Array.isArray(items) && items.length > 0 && items.every((m: any) => m?.provenance?.type === 'user');
};

const isoFromEpochSeconds = (s: unknown): string | undefined =>
  typeof s === 'number' && Number.isFinite(s) ? new Date(Math.round(s * 1000)).toISOString() : undefined;

/** The canonical turn id for a Codex turn: stable across retries and restarts. */
export function canonicalCodexTurnId(codexTurnId: string): string {
  const id = `${CODEX_TURN_ID_PREFIX}${codexTurnId}`;
  if (!TURN_ID.test(id)) throw new Error(`Codex turn id is not usable as a canonical turn id: ${codexTurnId}`);
  return id;
}

export function parseCodexRollout(rolloutText: string): CodexParseResult {
  const lines = rolloutText.split('\n');
  // A rollout is appended while Codex runs: an unterminated last line may be partial.
  const incompleteTrailingLine = rolloutText.length > 0 && !rolloutText.endsWith('\n') ? lines.pop() : undefined;
  const runtime: CodexRuntimeFacts = { sessionId: '', modelByTurn: {} };
  const turns = new Map<string, TurnState>();
  const turn = (turnId: string): TurnState => {
    let t = turns.get(turnId);
    if (!t) {
      t = { turnId, order: turns.size, userParts: [], finalAnswers: [], completed: false, aborted: false };
      turns.set(turnId, t);
    }
    return t;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { throw new Error('Codex rollout has a malformed complete line'); }
    const p = entry?.payload;
    if (entry?.type === 'session_meta') {
      runtime.sessionId = String(p?.id ?? p?.session_id ?? '');
      runtime.cliVersion = p?.cli_version;
      runtime.originator = p?.originator;
      runtime.modelProvider = p?.model_provider;
    } else if (entry?.type === 'turn_context' && typeof p?.turn_id === 'string') {
      turn(p.turn_id);
      if (typeof p.model === 'string') runtime.modelByTurn[p.turn_id] = p.model;
    } else if (entry?.type === 'event_msg' && p?.type === 'task_started' && typeof p.turn_id === 'string') {
      turn(p.turn_id);
    } else if (entry?.type === 'event_msg' && p?.type === 'task_complete' && typeof p.turn_id === 'string') {
      const t = turn(p.turn_id);
      t.completed = true;
      t.lastAgentMessage = typeof p.last_agent_message === 'string' ? p.last_agent_message : null;
    } else if (entry?.type === 'event_msg' && p?.type === 'turn_aborted' && typeof p.turn_id === 'string') {
      turn(p.turn_id).aborted = true;
    } else if (entry?.type === 'response_item' && p?.type === 'message') {
      const turnId = p?.internal_chat_message_metadata_passthrough?.turn_id;
      if (typeof turnId !== 'string') continue;
      if (p.role === 'user' && isUserProvenance(p)) {
        const t = turn(turnId);
        const text = textOf(p.content, 'input_text');
        if (text) t.userParts.push(text);
        t.userCreatedAt ??= isoFromEpochSeconds(p.internal_chat_message_metadata_passthrough?.create_time) ?? entry.timestamp;
      } else if (p.role === 'assistant' && p.phase === 'final_answer') {
        const text = textOf(p.content, 'output_text');
        if (text) turn(turnId).finalAnswers.push(text);
      }
    }
  }
  if (!runtime.sessionId) throw new Error('Codex rollout has no session_meta id');

  const ordered = [...turns.values()].sort((a, b) => a.order - b.order);
  const dialogue = ordered.filter((t) => t.userParts.length > 0);
  const result: CodexParseResult = {
    exchanges: [], unpairedUserInputs: [], unresolvedTurns: [], lastProcessedStepIndex: -1,
    runtime, skippedNonDialogueTurns: ordered.length - dialogue.length,
    ...(incompleteTrailingLine ? { incompleteTrailingLine } : {}),
  };
  dialogue.forEach((t, stepIndex) => {
    const base = { conversationId: runtime.sessionId, stepIndex, turnId: canonicalCodexTurnId(t.turnId), createdAt: t.userCreatedAt ?? 'unknown' };
    const userText = t.userParts.join('\n\n');
    const answer = t.finalAnswers.at(-1);
    result.lastProcessedStepIndex = stepIndex;
    if (t.completed && answer && answer === t.lastAgentMessage) {
      result.exchanges.push({ ...base, userText, assistantText: answer } satisfies AntigravityExchange);
    } else if (t.completed || t.aborted) {
      const reason = t.aborted ? 'turn aborted before a final answer'
        : !answer ? 'turn completed with no final answer'
        : 'final answer differs from task_complete.last_agent_message';
      result.unresolvedTurns.push({ ...base, rawContent: userText, reason } satisfies UnresolvedTurn);
    } else if (stepIndex === dialogue.length - 1) {
      result.openTrailingTurn = { ...base, userText, assistantTextSoFar: answer ?? '' } satisfies OpenTrailingTurn;
    } else {
      result.unresolvedTurns.push({ ...base, rawContent: userText, reason: 'turn never completed' } satisfies UnresolvedTurn);
    }
  });
  return result;
}

