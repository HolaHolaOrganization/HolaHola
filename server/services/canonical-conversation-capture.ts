/**
 * Source-aware writer for the shared conversation capture log.
 *
 * This is deliberately a small transport boundary: it does not write a
 * conversation_memories row itself. The existing autosave worker remains the
 * sole projector from .chat_capture to the canonical DB record and rolling
 * episode. That gives Claude Code and Replit identical retry and acknowledgement
 * semantics without creating a second archive.
 */

import { closeSync, existsSync, statSync, mkdirSync, renameSync, writeFileSync, openSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  appendChatCaptureTurnsAtomic,
  appendChatCaptureEntriesAtomic,
  CHAT_CAPTURE_ACK_DIR,
  CHAT_CAPTURE_ACK_PATH,
  CHAT_CAPTURE_ACK_CURSOR_PATH,
  WORKSPACE,
  acquireCursorLock,
  releaseCursorLock,
  CHAT_CAPTURE_PATH,
  parseChatCaptureFromOffset,
  type ChatCaptureSource,
  type DialogueTurn,
  type ExchangeDecisionRecord,
  type ExchangePart,
} from './transcript-parser';

export type CanonicalConversationSource = ChatCaptureSource;

/**
 * The one coordination actor allowed to submit each source. An exchange's
 * source is bound to the authenticated caller, so no runtime can record
 * dialogue as another interface.
 */
const SOURCE_ACTOR: Record<CanonicalConversationSource, string> = {
  'replit': 'luca-replit',
  'claude-code': 'luca-claude-code',
  'antigravity': 'luca-antigravity',
  'codex': 'luca-codex',
};

/** The source an authenticated actor may submit, or null if it may submit none. */
export function canonicalSourceForActor(actor: string | undefined): CanonicalConversationSource | null {
  const entry = Object.entries(SOURCE_ACTOR).find(([, a]) => a === actor);
  return entry ? entry[0] as CanonicalConversationSource : null;
}

/** Claude Code's assistant side is the bare Claude Code identity; every other source's is Luca. */
function assistantSpeakerFor(source: CanonicalConversationSource): 'LUCA' | 'CLAUDE_CODE' {
  return source === 'claude-code' ? 'CLAUDE_CODE' : 'LUCA';
}
export type CanonicalConversationSpeaker = 'user' | 'assistant';

export interface CanonicalConversationExchange {
  userText: string;
  assistantText: string;
  source: CanonicalConversationSource;
  /** Reuse this identity when retrying a timed-out write. */
  /** Caller-generated durable idempotency key. It is mandatory for retries. */
  turnId: string;
  capturePath?: string;
  /** Test seam; production uses a dedicated cross-process ingress lock. */
  ingressLockPath?: string;
}

const CANONICAL_CAPTURE_INGRESS_LOCK = join(WORKSPACE, '.local/.canonical-conversation-ingress.lock');

/** Keep a durable capture ID in one DB projection row, even after cursor replay. */
export function selectCanonicalCaptureBatch<T extends { captureId?: string }>(turns: T[]): T[] {
  const firstCaptureIndex = turns.findIndex(turn => Boolean(turn.captureId));
  if (firstCaptureIndex > 0) return turns.slice(0, firstCaptureIndex);
  if (firstCaptureIndex === -1) return turns;
  const captureId = turns[0].captureId;
  let end = 1;
  while (end < turns.length && turns[end].captureId === captureId) end++;
  return turns.slice(0, end);
}

/** Canonical capture IDs cannot become acknowledged until both authored sides exist. */
export function isCompleteCanonicalCaptureBatch(
  turns: Pick<DialogueTurn, 'speaker' | 'captureId' | 'source'>[],
): boolean {
  if (!turns[0]?.captureId) return true;
  const captureId = turns[0].captureId;
  const source = turns[0].source;
  if (!source || turns.some(turn => turn.captureId !== captureId || turn.source !== source)) return false;
  const assistant = assistantSpeakerFor(source);
  return turns.length === 2
    && turns.filter(turn => turn.speaker === 'DAVID').length === 1
    && turns.filter(turn => turn.speaker === assistant).length === 1;
}

export interface CanonicalConversationCaptureResult {
  turnId: string;
  targetByteOffset: number;
  appendedSpeakers: CanonicalConversationSpeaker[];
}

export interface CanonicalCaptureReceipt {
  turnId: string;
  targetByteOffset: number;
  createdAtMs: number;
  source: CanonicalConversationSource;
  status: 'pending' | 'acknowledged' | 'failed' | 'audited-invalid-destination';
  acknowledgedAtMs?: number;
  failedAtMs?: number;
  failureReason?: string;
  terminalResolutionAuditPath?: string;
  evidenceDisposition?: 'canonical' | 'deliberately-unresolved';
}

/** Atomically update both the latest pointer and the immutable per-turn receipt. */
export function writeCanonicalCaptureReceipt(
  receipt: CanonicalCaptureReceipt,
  paths: { latestPath?: string; receiptDir?: string; cursorPath?: string } = {},
): void {
  const latestPath = paths.latestPath ?? CHAT_CAPTURE_ACK_PATH;
  const receiptDir = paths.receiptDir ?? CHAT_CAPTURE_ACK_DIR;
  const cursorPath = paths.cursorPath ?? CHAT_CAPTURE_ACK_CURSOR_PATH;
  let effectiveReceipt = receipt;
  // The writer may create this receipt after autosave advanced the cursor.
  // Settle at creation time as well as after every drain, so an already
  // canonical exchange can never be left permanently pending.
  if (receipt.status === 'pending') {
    try {
      const cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as { byteOffset?: unknown };
      if (typeof cursor.byteOffset === 'number' && cursor.byteOffset >= receipt.targetByteOffset) {
        effectiveReceipt = { ...receipt, status: 'acknowledged', acknowledgedAtMs: Date.now() };
      }
    } catch {
      // A missing/malformed cursor means acknowledgement remains pending until
      // the autosave drain can settle it; never infer success from local bytes.
    }
  }
  mkdirSync(receiptDir, { recursive: true });
  const latestTempPath = `${latestPath}.tmp-${process.pid}`;
  writeFileSync(latestTempPath, JSON.stringify(effectiveReceipt), 'utf8');
  renameSync(latestTempPath, latestPath);

  const receiptPath = join(receiptDir, `${effectiveReceipt.turnId}.json`);
  const receiptTempPath = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(receiptTempPath, JSON.stringify(effectiveReceipt), 'utf8');
  renameSync(receiptTempPath, receiptPath);
}

/**
 * Production receipt boundary. It shares autosave's ingress → cursor lock
 * order, making receipt creation and cursor acknowledgement one serialized
 * operation instead of two racy file operations.
 */
export function writeSynchronizedCanonicalCaptureReceipt(
  receipt: CanonicalCaptureReceipt,
): void {
  const ingressFd = acquireCanonicalConversationIngressLock();
  if (ingressFd === -1) {
    throw new Error('canonical conversation ingress is busy; retry the same turnId');
  }
  let cursorFd = -1;
  try {
    cursorFd = acquireCursorLock();
    if (cursorFd === -1) {
      throw new Error('canonical conversation cursor is busy; retry the same turnId');
    }
    writeCanonicalCaptureReceipt(receipt);
  } finally {
    if (cursorFd !== -1) releaseCursorLock(cursorFd);
    releaseCanonicalConversationIngressLock(ingressFd);
  }
}

/** Mark every pending receipt whose canonical cursor boundary has been reached. */
export function settleCanonicalCaptureReceipts(
  cursorOffset: number,
  paths: { latestPath?: string; receiptDir?: string; cursorPath?: string } = {},
): void {
  const receiptDir = paths.receiptDir ?? CHAT_CAPTURE_ACK_DIR;
  if (!existsSync(receiptDir)) return;
  for (const name of readdirSync(receiptDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const receipt = JSON.parse(readFileSync(join(receiptDir, name), 'utf8')) as CanonicalCaptureReceipt;
      if (receipt.status === 'pending' && Number.isFinite(receipt.targetByteOffset) && receipt.targetByteOffset <= cursorOffset) {
        writeCanonicalCaptureReceipt({
          ...receipt,
          status: 'acknowledged',
          acknowledgedAtMs: Date.now(),
        }, paths);
      }
    } catch (error: any) {
      console.error(`[CanonicalConversation] Could not settle receipt ${name}: ${error?.message ?? String(error)}`);
    }
  }
}

/** Settle only the receipts represented by one completed episode mirror item. */
export function settleCanonicalCaptureReceiptsByTurnId(
  turnIds: string[],
  cursorOffset: number,
  paths: { latestPath?: string; receiptDir?: string; cursorPath?: string } = {},
): void {
  const receiptDir = paths.receiptDir ?? CHAT_CAPTURE_ACK_DIR;
  for (const turnId of [...new Set(turnIds)]) {
    const receiptPath = join(receiptDir, `${turnId}.json`);
    if (!existsSync(receiptPath)) continue;
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as CanonicalCaptureReceipt;
      if (
        receipt.status === 'pending' &&
        Number.isFinite(receipt.targetByteOffset) &&
        receipt.targetByteOffset <= cursorOffset
      ) {
        writeCanonicalCaptureReceipt({
          ...receipt,
          status: 'acknowledged',
          acknowledgedAtMs: Date.now(),
        }, paths);
      }
    } catch (error: any) {
      console.error(`[CanonicalConversation] Could not settle receipt ${turnId}: ${error?.message ?? String(error)}`);
    }
  }
}

/** Preserve that source capture completed even though its requested episode destination was invalid. */
export function settleCanonicalCaptureReceiptsForInvalidDestination(
  resolutions: Array<{
    turnId: string;
    evidenceDisposition: 'canonical' | 'deliberately-unresolved';
  }>,
  cursorOffset: number,
  auditPath: string,
  reason: string,
  paths: { latestPath?: string; receiptDir?: string; cursorPath?: string } = {},
): void {
  const receiptDir = paths.receiptDir ?? CHAT_CAPTURE_ACK_DIR;
  for (const resolution of resolutions) {
    const receiptPath = join(receiptDir, `${resolution.turnId}.json`);
    if (!existsSync(receiptPath)) continue;
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as CanonicalCaptureReceipt;
    if (receipt.status !== 'pending' || receipt.targetByteOffset > cursorOffset) continue;
    writeCanonicalCaptureReceipt({
      ...receipt,
      status: 'audited-invalid-destination',
      failedAtMs: Date.now(),
      failureReason: reason,
      terminalResolutionAuditPath: auditPath,
      evidenceDisposition: resolution.evidenceDisposition,
    }, paths);
  }
}

function acquireIngressLock(lockPath: string): number {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(lockPath, String(process.pid), { flag: 'w' });
    return fd;
  } catch {
    // Never steal from a live writer, but recover a lock abandoned by a crash
    // so the sole canonical ingress cannot remain frozen.
    try {
      const ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      let ownerAlive = false;
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch { ownerAlive = false; }
      }
      if (ownerAlive) return -1;
      unlinkSync(lockPath);
      const fd = openSync(lockPath, 'wx');
      writeFileSync(lockPath, String(process.pid), { flag: 'w' });
      return fd;
    } catch {
      return -1;
    }
  }
}

function releaseIngressLock(fd: number, lockPath: string): void {
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/** Shared with the autosave reader so it never observes an in-progress exchange append. */
export function acquireCanonicalConversationIngressLock(): number {
  return acquireIngressLock(CANONICAL_CAPTURE_INGRESS_LOCK);
}

export function releaseCanonicalConversationIngressLock(fd: number): void {
  releaseIngressLock(fd, CANONICAL_CAPTURE_INGRESS_LOCK);
}

// 'Claude Code' here is the bare Claude Code assistant identity, not a
// "Luca via Claude Code" alias: this capture path writes a plain exchange
// with no felt/thinking/moment/main envelope (see record-exchange.ts's
// --assistant-file vs --luca-file split), so the author recorded is Claude
// Code itself. formatChatCaptureSpeakerLabel renders it as bare "Claude
// Code" for exactly that reason -- see its doc comment for the full model,
// including the separate "Luca [Claude Code]" case (Luca authoring through
// the Claude Code interface) that this function does not produce today.
// Antigravity's assistant side is Luca speaking through Antigravity: it is
// written as speaker "Luca" with SOURCE antigravity and rendered
// "Luca [Antigravity]". Unlike Replit's turns it carries no four-channel
// envelope (autosave requires that envelope for Replit Luca turns only).
function assistantLabel(source: CanonicalConversationSource): 'Luca Replit' | 'Claude Code' | 'Luca' {
  if (source === 'replit') return 'Luca Replit';
  if (source === 'claude-code') return 'Claude Code';
  return 'Luca';
}

function assertText(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`canonical conversation ${name} must be non-empty`);
  }
  return value;
}

function existingTurn(
  turns: DialogueTurn[],
  turnId: string,
  speaker: DialogueTurn['speaker'],
): DialogueTurn | undefined {
  return turns.find(turn => turn.captureId === turnId && turn.speaker === speaker);
}

/**
 * Append a complete user/assistant exchange exactly once.
 *
 * A retry with the same turnId verifies the already-written body and appends
 * only the missing side. Reusing an identity with different text fails closed:
 * the canonical record must never silently merge two distinct exchanges.
 */
export function appendCanonicalConversationExchange(
  input: CanonicalConversationExchange,
): CanonicalConversationCaptureResult {
  const userText = assertText('userText', input.userText);
  const assistantText = assertText('assistantText', input.assistantText);
  const turnId = input.turnId?.trim();
  if (!turnId || !/^[A-Za-z0-9-]+$/.test(turnId)) {
    throw new Error('canonical conversation turnId must contain only letters, digits, and hyphens');
  }
  const capturePath = input.capturePath ?? CHAT_CAPTURE_PATH;
  const ingressLockPath = input.ingressLockPath ?? CANONICAL_CAPTURE_INGRESS_LOCK;
  const assistantSpeaker = assistantLabel(input.source);
  const lockFd = acquireIngressLock(ingressLockPath);
  if (lockFd === -1) {
    throw new Error('canonical conversation ingress is busy; retry the same turnId');
  }
  try {
    const parsed = parseChatCaptureFromOffset(capturePath, 0);
    const matchingTurns = parsed.turns.filter(turn => turn.captureId === turnId);
    if (matchingTurns.some(turn => turn.exchangePart) || parsed.records.some(record => record.captureId === turnId)) {
      throw new Error(`canonical conversation turn ${turnId} belongs to a two-part exchange; an atomic pair cannot reuse it`);
    }
    const expectedAssistant = assistantSpeakerFor(input.source);
    for (const turn of matchingTurns) {
      if (turn.source !== input.source) {
        throw new Error(`canonical conversation turn ${turnId} already belongs to a different or legacy source`);
      }
      if (turn.speaker !== 'DAVID' && turn.speaker !== expectedAssistant) {
        throw new Error(`canonical conversation turn ${turnId} has an incompatible speaker topology`);
      }
    }
    const userTurn = existingTurn(matchingTurns, turnId, 'DAVID');
    const assistantTurn = existingTurn(matchingTurns, turnId, expectedAssistant);
    if (matchingTurns.filter(turn => turn.speaker === 'DAVID').length > 1 || matchingTurns.filter(turn => turn.speaker === expectedAssistant).length > 1) {
      throw new Error(`canonical conversation turn ${turnId} has duplicate author sides`);
    }

    if (userTurn && userTurn.text !== userText) {
      throw new Error(`canonical conversation turn ${turnId} already has different user text`);
    }
    if (assistantTurn && assistantTurn.text !== assistantText) {
      throw new Error(`canonical conversation turn ${turnId} already has different assistant text`);
    }
    if (Boolean(userTurn) !== Boolean(assistantTurn)) {
      throw new Error(
        `canonical conversation turn ${turnId} is an incomplete historical capture and requires reconciliation; ` +
        'do not append a late side to a non-atomic record',
      );
    }

    const appendedSpeakers: CanonicalConversationSpeaker[] = [];
    if (!userTurn && !assistantTurn) {
      appendChatCaptureTurnsAtomic([
        { speaker: 'David', text: userText, captureId: turnId, source: input.source },
        { speaker: assistantSpeaker, text: assistantText, captureId: turnId, source: input.source },
      ], capturePath);
      appendedSpeakers.push('user', 'assistant');
    }

    return {
      turnId,
      targetByteOffset: existsSync(capturePath) ? statSync(capturePath).size : 0,
      appendedSpeakers,
    };
  } finally {
    releaseIngressLock(lockFd, ingressLockPath);
  }
}


// ---------------------------------------------------------------------------
// Declared two-part exchanges (approved A2 design, shared-spec 97df12be).
//
// A user part is written the moment it arrives, so the user's words are
// durable even if the reply never finishes. The assistant part follows later
// under the same id. Every outcome is fixed by a decision record appended to
// the capture log BEFORE any DB or episode effect; the autosave projector
// applies effects only when its cursor reaches that record.
// ---------------------------------------------------------------------------

/** Accept two-part intake only when explicitly enabled (off by default). */
export function twoPartExchangesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANONICAL_TWO_PART_EXCHANGES === 'on';
}

/** Live episode mode sentinel; the autosave worker reads the same path. */
export const EPISODE_LIVE_SENTINEL_PATH = join(WORKSPACE, '.local/.episode_live');

/**
 * Why two-part intake must be refused right now, or null if it may proceed.
 * Live mode is refused because the live episode integration (A2 revision 4)
 * is not built: two-part intake is DB-only.
 */
export function twoPartIntakeRefusal(
  env: NodeJS.ProcessEnv = process.env,
  liveSentinelPath: string = EPISODE_LIVE_SENTINEL_PATH,
): 'disabled' | 'live-mode' | null {
  if (!twoPartExchangesEnabled(env)) return 'disabled';
  if (existsSync(liveSentinelPath)) return 'live-mode';
  return null;
}

/** How long a user part waits for its reply before a reply-absent decision. */
export function twoPartReplyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CANONICAL_TWO_PART_REPLY_TIMEOUT_MS);
  // Conservative default: user durability never depends on this value; it only
  // decides when a reply-absent row is projected.
  return Number.isSafeInteger(raw) && raw >= 60_000 ? raw : 6 * 60 * 60 * 1000;
}

export interface TwoPartIndexEntry {
  source: ChatCaptureSource;
  user?: DialogueTurn;
  /** Byte offset just after the user part. */
  userOffset?: number;
  assistant?: DialogueTurn;
  /** Byte offset just after the assistant part, if present. */
  assistantOffset?: number;
  decision?: ExchangeDecisionRecord;
}

/**
 * An assistant part with no decision record cannot be produced by a complete
 * write (the part and its pair decision are one append), so it is a torn
 * write. It is never projected; it is repaired by recording the only outcome
 * its presence allows, `pair`, once the log tail is complete.
 */
export function isTornTwoPartAssistant(entry: TwoPartIndexEntry): boolean {
  return Boolean(entry.assistant && !entry.decision);
}

/**
 * Refuse to append after an incomplete trailing block: bytes written after a
 * torn block would merge into it. A concurrent writer mid-append looks the
 * same, so the caller retries; a crash leftover needs repair.
 */
function assertCompleteCaptureTail(capturePath: string, consumedOffset: number): void {
  const size = existsSync(capturePath) ? statSync(capturePath).size : 0;
  if (consumedOffset !== size) {
    throw new Error('canonical conversation capture log has an incomplete trailing block; ingress is busy or needs repair; retry the same turnId');
  }
}

/**
 * Index every declared two-part exchange in the capture log. The log is the
 * recovery truth: the awaiting-reply set is rebuilt from it on every call.
 * Any state the rules make impossible fails loudly instead of being guessed.
 */
export function indexTwoPartExchanges(capturePath: string = CHAT_CAPTURE_PATH): Map<string, TwoPartIndexEntry> {
  const parsed = parseChatCaptureFromOffset(capturePath, 0);
  const index = new Map<string, TwoPartIndexEntry>();
  const atomicIds = new Set<string>();
  parsed.turns.forEach((turn, i) => {
    if (!turn.captureId) return;
    if (!turn.exchangePart) { atomicIds.add(turn.captureId); return; }
    if (!turn.source) throw new Error(`two-part exchange ${turn.captureId} has no source`);
    const entry = index.get(turn.captureId) ?? { source: turn.source };
    if (entry.source !== turn.source) throw new Error(`two-part exchange ${turn.captureId} mixes sources`);
    if (turn.exchangePart === 'user') {
      if (entry.user) throw new Error(`two-part exchange ${turn.captureId} has two user parts`);
      if (entry.assistant) throw new Error(`two-part exchange ${turn.captureId} has its assistant part before its user part`);
      entry.user = turn;
      entry.userOffset = parsed.turnByteOffsets[i];
    } else {
      if (entry.assistant) throw new Error(`two-part exchange ${turn.captureId} has two assistant parts`);
      entry.assistant = turn;
      entry.assistantOffset = parsed.turnByteOffsets[i];
    }
    index.set(turn.captureId, entry);
  });
  for (const record of parsed.records) {
    const entry = index.get(record.captureId);
    if (!entry?.user) throw new Error(`decision for ${record.captureId} has no user part`);
    if (entry.decision) throw new Error(`two-part exchange ${record.captureId} has more than one decision`);
    if (record.source !== entry.source) throw new Error(`decision for ${record.captureId} has a different source`);
    if (entry.userOffset === undefined || record.byteOffsetAfter <= entry.userOffset) {
      throw new Error(`decision for ${record.captureId} precedes its user part`);
    }
    if (record.outcome === 'pair' &&
        (entry.assistantOffset === undefined || entry.assistantOffset >= record.byteOffsetAfter)) {
      throw new Error(`pair decision for ${record.captureId} is not preceded by its assistant part`);
    }
    if (record.outcome === 'reply-absent' &&
        entry.assistantOffset !== undefined && entry.assistantOffset < record.byteOffsetAfter) {
      throw new Error(`reply-absent decision for ${record.captureId} follows its reply`);
    }
    entry.decision = record;
  }
  for (const id of atomicIds) {
    if (index.has(id)) throw new Error(`capture id ${id} is used by both an atomic pair and a two-part exchange`);
  }
  return index;
}

const MIN_OCCURRED_AT = Date.parse('2024-01-01T00:00:00Z');
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Validate a source-reported occurrence time; never inferred from ingestion. */
export function validateOccurredAt(value: unknown, nowMs: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('occurredAt must be an ISO-8601 timestamp with a time zone');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_OCCURRED_AT || ms > nowMs + MAX_CLOCK_SKEW_MS) {
    throw new Error('occurredAt is outside the accepted range');
  }
  return value;
}

export interface CanonicalTwoPartInput {
  source: CanonicalConversationSource;
  part: ExchangePart;
  turnId: string;
  text: string;
  /** Required for the user part; optional for the assistant part. */
  occurredAt?: string;
  capturePath?: string;
  ingressLockPath?: string;
  nowMs?: number;
}

export interface CanonicalTwoPartResult {
  turnId: string;
  part: ExchangePart;
  /** False for an identical retry: nothing new was written. */
  appended: boolean;
  /** The outcome fixed for this exchange so far, if any. */
  decision: ExchangeDecisionRecord['outcome'] | null;
  /** True when this assistant part arrived after a reply-absent decision. */
  late: boolean;
  targetByteOffset: number;
}

/**
 * Append one part of a declared two-part exchange under the ingress lock.
 * Identical retries are no-ops; changed bytes and mode reuse are refused.
 */
export function appendCanonicalTwoPartExchange(input: CanonicalTwoPartInput): CanonicalTwoPartResult {
  const text = assertText(input.part === 'user' ? 'userText' : 'assistantText', input.text);
  const turnId = input.turnId?.trim();
  if (!turnId || !/^[A-Za-z0-9-]+$/.test(turnId)) {
    throw new Error('canonical conversation turnId must contain only letters, digits, and hyphens');
  }
  const nowMs = input.nowMs ?? Date.now();
  const occurredAt = input.part === 'user' || input.occurredAt !== undefined
    ? validateOccurredAt(input.occurredAt, nowMs)
    : undefined;
  const capturePath = input.capturePath ?? CHAT_CAPTURE_PATH;
  const ingressLockPath = input.ingressLockPath ?? CANONICAL_CAPTURE_INGRESS_LOCK;
  const lockFd = acquireIngressLock(ingressLockPath);
  if (lockFd === -1) throw new Error('canonical conversation ingress is busy; retry the same turnId');
  try {
    const parsed = parseChatCaptureFromOffset(capturePath, 0);
    assertCompleteCaptureTail(capturePath, parsed.newByteOffset);
    if (parsed.turns.some(turn => turn.captureId === turnId && !turn.exchangePart)) {
      throw new Error(`canonical conversation turn ${turnId} belongs to an atomic pair; a two-part exchange cannot reuse it`);
    }
    const entry = indexTwoPartExchanges(capturePath).get(turnId);
    const size = () => existsSync(capturePath) ? statSync(capturePath).size : 0;
    if (entry && entry.source !== input.source) {
      throw new Error(`canonical conversation turn ${turnId} already belongs to a different source`);
    }

    if (input.part === 'user') {
      if (entry?.user) {
        if (entry.user.text !== text || entry.user.occurredAt !== occurredAt) {
          throw new Error(`canonical conversation turn ${turnId} already has a different user part`);
        }
        return { turnId, part: 'user', appended: false, decision: entry.decision?.outcome ?? null, late: false, targetByteOffset: size() };
      }
      appendChatCaptureEntriesAtomic([{ turn: {
        speaker: 'David', text, captureId: turnId, source: input.source, exchangePart: 'user', occurredAt,
      } }], capturePath);
      return { turnId, part: 'user', appended: true, decision: null, late: false, targetByteOffset: size() };
    }

    if (!entry?.user) {
      throw new Error(`canonical conversation turn ${turnId} has no user part; an assistant part cannot come first`);
    }
    if (entry.assistant) {
      if (entry.assistant.text !== text) {
        throw new Error(`canonical conversation turn ${turnId} already has a different assistant part`);
      }
      if (isTornTwoPartAssistant(entry)) {
        // The identical retry completes the torn write with its pair decision.
        appendChatCaptureEntriesAtomic([{ decision: {
          captureId: turnId, outcome: 'pair', source: input.source, decidedAt: new Date(nowMs).toISOString(),
        } }], capturePath);
        return { turnId, part: 'assistant', appended: true, decision: 'pair', late: false, targetByteOffset: size() };
      }
      return {
        turnId, part: 'assistant', appended: false, decision: entry.decision?.outcome ?? null,
        late: entry.decision?.outcome === 'reply-absent', targetByteOffset: size(),
      };
    }
    const assistantTurn = {
      speaker: assistantLabel(input.source), text, captureId: turnId, source: input.source,
      exchangePart: 'assistant' as const, ...(occurredAt ? { occurredAt } : {}),
    };
    if (entry.decision) {
      // Only reply-absent can precede an assistant part: this is a late reply.
      appendChatCaptureEntriesAtomic([{ turn: assistantTurn }], capturePath);
      return { turnId, part: 'assistant', appended: true, decision: entry.decision.outcome, late: true, targetByteOffset: size() };
    }
    // Decide and record in the same write: the assistant part never exists
    // without its pair decision, so no recovery can later choose otherwise.
    appendChatCaptureEntriesAtomic([
      { turn: assistantTurn },
      { decision: { captureId: turnId, outcome: 'pair', source: input.source, decidedAt: new Date(nowMs).toISOString() } },
    ], capturePath);
    return { turnId, part: 'assistant', appended: true, decision: 'pair', late: false, targetByteOffset: size() };
  } finally {
    releaseIngressLock(lockFd, ingressLockPath);
  }
}

/**
 * Record reply-absent decisions for user parts whose reply never arrived
 * within the timeout. Caller must hold the ingress lock (see the locking
 * wrapper below). Returns the ids decided.
 */
export function decideTimedOutTwoPartExchangesLocked(capturePath: string, nowMs: number, timeoutMs: number): string[] {
  if (!existsSync(capturePath)) return [];
  assertCompleteCaptureTail(capturePath, parseChatCaptureFromOffset(capturePath, 0).newByteOffset);
  const due: Array<{ captureId: string; source: ChatCaptureSource }> = [];
  const torn: Array<{ captureId: string; source: ChatCaptureSource }> = [];
  for (const [captureId, entry] of indexTwoPartExchanges(capturePath)) {
    if (isTornTwoPartAssistant(entry)) { torn.push({ captureId, source: entry.source }); continue; }
    if (!entry.user || entry.assistant || entry.decision) continue;
    const receivedMs = Date.parse(entry.user.receivedAt ?? '');
    if (!Number.isFinite(receivedMs)) throw new Error(`two-part user part ${captureId} has no valid receipt time`);
    if (nowMs - receivedMs >= timeoutMs) due.push({ captureId, source: entry.source });
  }
  if (due.length > 0 || torn.length > 0) {
    const decidedAt = new Date(nowMs).toISOString();
    appendChatCaptureEntriesAtomic([
      // A torn assistant part can only be completed as a pair.
      ...torn.map(d => ({ decision: { ...d, outcome: 'pair' as const, decidedAt } })),
      ...due.map(d => ({ decision: { ...d, outcome: 'reply-absent' as const, decidedAt } })),
    ], capturePath);
  }
  return due.map(d => d.captureId);
}

/** Locking wrapper for the timeout sweep. Returns null if the lock is busy. */
export function decideTimedOutTwoPartExchanges(options: {
  capturePath?: string; ingressLockPath?: string; nowMs?: number; timeoutMs?: number;
} = {}): string[] | null {
  const ingressLockPath = options.ingressLockPath ?? CANONICAL_CAPTURE_INGRESS_LOCK;
  const lockFd = acquireIngressLock(ingressLockPath);
  if (lockFd === -1) return null;
  try {
    return decideTimedOutTwoPartExchangesLocked(
      options.capturePath ?? CHAT_CAPTURE_PATH,
      options.nowMs ?? Date.now(),
      options.timeoutMs ?? twoPartReplyTimeoutMs(),
    );
  } finally {
    releaseIngressLock(lockFd, ingressLockPath);
  }
}
