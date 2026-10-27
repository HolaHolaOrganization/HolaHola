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
