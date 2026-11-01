/**
 * transcript-parser.ts
 *
 * Shared parsing logic for Luca↔David JSONL transcripts.
 *
 * Imported by:
 *   - server/services/agent-session-autosave.ts   (periodic + flush-trigger saves)
 *   - server/scripts/save-transcript-now.ts       (direct session-end save)
 *
 * Both consumers must use this module so pre-compression recovery and cursor
 * semantics stay exactly in sync. Never copy-paste these functions.
 */

import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, openSync, closeSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { ensureCaptureWorkspaceWritable, workspaceResolution } from './workspace-root';
import { historicalAttributionLabel } from './historical-attribution-overlay';

export const WORKSPACE        = workspaceResolution.root;
export const TRANSCRIPT_DIR   = join(WORKSPACE, '.local/state/replit/agent/transcript');
export const CURSOR_PATH      = join(WORKSPACE, '.local/.transcript_cursor.json');

// ---------------------------------------------------------------------------
// Chat-capture: append-only per-turn log
//
// Replit stopped writing JSONL transcript files after July 27, 2026.
// This is the replacement: an append-only file where each turn is written
// immediately at the moment it exists — not reconstructed in a batch later.
//
// WHY APPEND-ONLY + BYTE CURSOR (not clear-after-save):
//   Reconstruction always loses something. Batch writes from memory produce
//   narrative, not transcript — sentence openers get dropped, entire turns
//   get collapsed. The only verbatim capture is per-turn, written at the
//   moment the turn exists. The byte cursor lets the autosave worker save
//   new turns without clearing the file, so Luca can keep appending.
//
// HOW TO WRITE A TURN:
//   Use appendChatCaptureTurn() or append-turn.ts:
//     npx tsx server/scripts/append-turn.ts David "exact text"
//     npx tsx server/scripts/append-turn.ts Luca  "exact text"
//   Multi-line text is fully preserved. Write each turn as it arrives —
//   do not accumulate and write in a batch later.
//
// FILE FORMAT — each turn is a delimited block:
//   ---TURN-START---
//   SPEAKER: David
//   TIME: 2026-08-10T18:45:23.456Z
//   ---
//   So, two things: you just put some output in the MD...
//   (multi-line text preserved verbatim)
//   ---TURN-END---
//
// CURSOR: .chat_capture_cursor.json tracks the byte offset of the last
//   saved turn. The autosave worker reads from cursor to end-of-file,
//   saves new complete turns, and advances the cursor. The file is never
//   cleared by the autosave worker — only by an explicit session-end reset.
// ---------------------------------------------------------------------------
export const CHAT_CAPTURE_PATH        = join(WORKSPACE, '.local/.chat_capture');
export const CHAT_CAPTURE_CURSOR_PATH = join(WORKSPACE, '.local/.chat_capture_cursor.json');
/**
 * Written by record-exchange before it returns.  It makes the distinction
 * between "the capture stream is empty" and "a just-written turn is still
 * awaiting canonical acknowledgement" visible to both the caller and the
 * capture-status report.
 */
export const CHAT_CAPTURE_ACK_PATH    = join(WORKSPACE, '.local/.chat_capture_ack.json');
/** Advances only after rolling-episode mirrors complete; receipts use this boundary. */
export const CHAT_CAPTURE_ACK_CURSOR_PATH = join(WORKSPACE, '.local/.chat_capture_ack_cursor.json');
/** Per-turn receipts make acknowledgement durable even when captures overlap. */
export const CHAT_CAPTURE_ACK_DIR     = join(WORKSPACE, '.local/chat-capture-acknowledgements');

// ---------------------------------------------------------------------------
// Auto-capture trigger — .local/.luca_auto_capture
// Luca writes { "david": "...", "luca": "..." } here; the autosave worker
// appends both turns to .chat_capture and saves to DB automatically.
// ---------------------------------------------------------------------------
export const LUCA_AUTO_CAPTURE_PATH = join(WORKSPACE, '.local/.luca_auto_capture');

// Cross-process cursor lock — prevents save-transcript-now.ts from racing
// the autosave worker when both run concurrently.
export const CHAT_CAPTURE_LOCK_PATH = join(WORKSPACE, '.local/.chat_capture.lock');

/** Delimiter constants — must not appear in conversation text. */
export const CHAT_TURN_START = '---TURN-START---';
export const CHAT_TURN_END   = '---TURN-END---';
export const CHAT_BODY_SEP   = '---';  // separates headers from body within a turn block

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DialogueTurn {
  /**
   * Three distinct authors, not two plus a modifier:
   *   - 'DAVID' and 'LUCA' are people/persona; `source` says which interface
   *     they used (Replit, Claude Code) without changing who they are.
   *   - 'CLAUDE_CODE' is the bare Claude Code assistant identity itself —
   *     a turn authored by Claude Code, not by Luca through Claude Code.
   * See formatChatCaptureSpeakerLabel for the rendering rule this backs.
   */
  speaker: 'DAVID' | 'LUCA' | 'CLAUDE_CODE';
  text: string;
  memoryId: number;
  /** Durable record-exchange identity used for event-based episode idempotency. */
  captureId?: string;
  /** Interface that produced this turn. Old blocks intentionally have no source. */
  source?: ChatCaptureSource;
  /** Declared two-part exchange part (A2). Absent for atomic pairs and legacy turns. */
  exchangePart?: ExchangePart;
  /** Native time the user's message happened, as reported by the source (A2 user parts). */
  occurredAt?: string;
  /** Server receipt time (the block's TIME header), recorded for two-part parts only. */
  receivedAt?: string;
}

/** The two halves of a declared two-part exchange (approved A2 design 97df12be). */
export type ExchangePart = 'user' | 'assistant';

/**
 * A decision record for a two-part exchange: it fixes the outcome before any
 * DB or episode effect is applied. Written as a capture block with no
 * SPEAKER, so parsers that predate A2 skip it.
 */
export interface ExchangeDecisionRecord {
  captureId: string;
  outcome: 'pair' | 'reply-absent';
  source: ChatCaptureSource;
  decidedAt: string;
  /** Byte offset (from file start) just after this block. */
  byteOffsetAfter: number;
}

/**
 * Interfaces whose dialogue enters the canonical record. A David/Luca turn's
 * source only picks its "[Interface]" suffix; it never changes the author.
 */
export type ChatCaptureSource = 'replit' | 'claude-code' | 'antigravity' | 'codex';
export const CHAT_CAPTURE_SOURCES: readonly ChatCaptureSource[] = ['replit', 'claude-code', 'antigravity', 'codex'];

export interface TranscriptCursor {
  sessionId: string;
  lastMemoryId: number;
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

export function loadCursor(): TranscriptCursor {
  try {
    if (existsSync(CURSOR_PATH)) {
      return JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { sessionId: '', lastMemoryId: 0 };
}

export function saveCursor(cursor: TranscriptCursor): void {
  try {
    writeFileSync(CURSOR_PATH, JSON.stringify(cursor));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export function findTranscriptPath(): { sessionId: string; path: string } | null {
  try {
    if (!existsSync(TRANSCRIPT_DIR)) return null;
    const sessions = readdirSync(TRANSCRIPT_DIR).filter(d => {
      try { return statSync(join(TRANSCRIPT_DIR, d)).isDirectory(); } catch { return false; }
    });
    if (sessions.length === 0) return null;
    const sorted = sessions.sort((a, b) => {
      try {
        return statSync(join(TRANSCRIPT_DIR, b)).mtimeMs -
               statSync(join(TRANSCRIPT_DIR, a)).mtimeMs;
      } catch { return 0; }
    });
    const sessionId = sorted[0];
    const path = join(TRANSCRIPT_DIR, sessionId, 'transcript.jsonl');
    return existsSync(path) ? { sessionId, path } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

export function cleanUserText(text: string): string {
  return text
    .replace(/<user_message>([\s\S]*?)<\/user_message>/g, '$1')
    .replace(/<automatic_updates>[\s\S]*?<\/automatic_updates>/g, '')
    .replace(/<system_reminder[^>]*>[\s\S]*?<\/system_reminder>/g, '')
    // Self-closing form: <pre_compression_transcript path="..." /> — strip entirely
    .replace(/<pre_compression_transcript[^>]*\/>/g, '')
    // Paired form: <pre_compression_transcript ...>...</pre_compression_transcript>
    .replace(
      /<pre_compression_transcript[^>]*>[\s\S]*?<\/pre_compression_transcript>/g,
      '[earlier session — compressed, recovered below if still on disk]',
    )
    .trim();
}

// ---------------------------------------------------------------------------
// Pre-compression path extraction
// ---------------------------------------------------------------------------

/**
 * Extracts any <pre_compression_transcript path="..."> pointers before they
 * get stripped down to a placeholder, so the raw turns they point to can
 * still be recovered from disk before that referenced file itself rotates away.
 */
export function extractPreCompressionPaths(text: string): string[] {
  const paths: string[] = [];
  const re = /<pre_compression_transcript\s+path="([^"]+)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Dialogue chunking — record-safe, memoryId-grouped
// ---------------------------------------------------------------------------

export interface ChunkResult {
  dialogue: string;
  /** Cursor value to persist — only turns through this memoryId were saved. */
  lastIncludedMemoryId: number;
  includedCount: number;
  remainingCount: number;
}

/**
 * Build a single dialogue chunk from a flat turn list.
 *
 * Turns are grouped by memoryId before chunking.  A chunk boundary never
 * falls inside a memoryId group — all turns sharing an ID are persisted
 * atomically (or the whole group is deferred to the next chunk).
 *
 * If a single group exceeds maxChars by itself, its turns are individually
 * truncated so the cursor can advance past that record and not loop forever.
 */
export function buildDialogueChunk(
  turns: DialogueTurn[],
  afterId: number,
  maxChars = 80_000,
): ChunkResult {
  // Group consecutive turns by their memoryId
  const groups: { memoryId: number; turns: DialogueTurn[] }[] = [];
  for (const t of turns) {
    const last = groups[groups.length - 1];
    if (last && last.memoryId === t.memoryId) {
      last.turns.push(t);
    } else {
      groups.push({ memoryId: t.memoryId, turns: [t] });
    }
  }

  const lines: string[] = [];
  let charCount = 0;
  let lastIncludedMemoryId = afterId;
  let includedCount = 0;
  let remainingCount = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const groupBlocks = group.turns.map(t => {
      const name = formatChatCaptureSpeakerLabel(t);
      return `${name}: ${t.text}\n`;
    });
    const groupSize = groupBlocks.reduce((s, b) => s + b.length, 0);

    if (charCount + groupSize > maxChars) {
      if (charCount === 0) {
        // First group alone exceeds the cap — truncate each turn individually
        // so the cursor advances and the record is not deferred indefinitely.
        let remaining = maxChars - 100;
        for (const block of groupBlocks) {
          if (remaining <= 0) {
            // Omit this turn but note it in the record
            lines.push('[turn omitted — group exceeded chunk limit]\n');
            break;
          }
          if (block.length <= remaining) {
            lines.push(block);
            remaining -= block.length;
          } else {
            lines.push(block.slice(0, remaining) + '\n[turn truncated — exceeded chunk limit]\n');
            remaining = 0;
          }
          includedCount++;
        }
        lastIncludedMemoryId = group.memoryId;
        // Remaining groups go to the next chunk
        remainingCount = groups.slice(gi + 1).reduce((s, g) => s + g.turns.length, 0);
      } else {
        // Defer the entire group to the next chunk — cursor does NOT advance past it
        remainingCount = groups.slice(gi).reduce((s, g) => s + g.turns.length, 0);
      }
      break;
    }

    for (const block of groupBlocks) lines.push(block);
    charCount += groupSize;
    lastIncludedMemoryId = group.memoryId;
    includedCount += group.turns.length;
  }

  return {
    dialogue: lines.join('\n'),
    lastIncludedMemoryId,
    includedCount,
    remainingCount,
  };
}

// ---------------------------------------------------------------------------
// Core JSONL turn extractor
// ---------------------------------------------------------------------------

export function extractTurns(
  jsonlPath: string,
  afterMemoryId: number,
  visitedPaths: Set<string> = new Set(),
): { turns: DialogueTurn[]; maxMemoryId: number } {
  const turns: DialogueTurn[] = [];
  const seen = new Set<string>();
  let maxMemoryId = afterMemoryId;
  visitedPaths.add(jsonlPath);

  try {
    const lines = readFileSync(jsonlPath, 'utf-8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      const memoryId: number = obj.memory_id ?? 0;
      if (memoryId <= afterMemoryId) continue;
      if (memoryId > maxMemoryId) maxMemoryId = memoryId;

      for (const m of (obj.messages ?? [])) {
        const role: string = m.role;
        const content = m.content;

        if (role === 'user') {
          let rawText = '';
          if (typeof content === 'string') rawText = content;
          else if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === 'text') rawText += c.text ?? '';
            }
          }

          // Recover pre-compression transcript turns BEFORE stripping the tag,
          // so dialogue that was compressed mid-cycle is not lost.
          for (const p of extractPreCompressionPaths(rawText)) {
            if (visitedPaths.has(p) || !existsSync(p)) continue;
            const recovered = extractTurns(p, 0, visitedPaths);
            for (const t of recovered.turns) {
              const key = t.speaker + '|' + t.text.slice(0, 80);
              if (seen.has(key)) continue;
              seen.add(key);
              turns.push(t);
            }
          }

          const text = cleanUserText(rawText);
          if (text.length < 5) continue;
          const key = 'DAVID|' + text.slice(0, 80);
          if (seen.has(key)) continue;
          seen.add(key);
          turns.push({ speaker: 'DAVID', text, memoryId });

        } else if (role === 'assistant') {
          let text = '';
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === 'text') text += c.text ?? '';
            }
          }
          if (text.length < 5) continue;
          const key = 'LUCA|' + text.slice(0, 80);
          if (seen.has(key)) continue;
          seen.add(key);
          turns.push({ speaker: 'LUCA', text, memoryId });
        }
      }
    }
  } catch { /* file read error — return what we have */ }

  return { turns, maxMemoryId };
}

// ---------------------------------------------------------------------------
// Chat-capture cursor — tracks byte offset of last saved turn
// ---------------------------------------------------------------------------

export interface ChatCaptureCursor {
  byteOffset: number;
  /**
   * Stable identity of the last turn whose durable effects completed before
   * byteOffset advanced. It lets a worker recover its verified boundary after
   * a capture file is shortened or replaced.
   */
  lastSavedTurnFingerprint?: string;
}

export function loadChatCaptureCursor(cursorPath = CHAT_CAPTURE_CURSOR_PATH): ChatCaptureCursor {
  try {
    if (existsSync(cursorPath)) {
      return JSON.parse(readFileSync(cursorPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { byteOffset: 0 };
}

/** Stable per-turn identity for cursor recovery; timestamps are intentionally excluded. */
export function chatCaptureTurnFingerprint(turn: Pick<DialogueTurn, 'speaker' | 'text' | 'captureId'>): string {
  return createHash('sha256')
    .update(JSON.stringify([turn.speaker, turn.captureId ?? '', turn.text, (turn as DialogueTurn).source ?? '']), 'utf8')
    .digest('hex');
}

/**
 * Keep interface attribution in the canonical text. Blocks written before
 * SOURCE existed intentionally retain their historic labels.
 *
 * `speaker` is checked before `source` because they answer different
 * questions: `speaker` says WHO authored the turn (David, Luca, or Claude
 * Code itself); `source` says WHICH INTERFACE a David/Luca turn came
 * through. `source` can never promote a Luca turn into a Claude Code turn
 * or vice versa — it only picks the "[Replit]"/"[Claude Code]" suffix once
 * the author is already known to be David or Luca.
 *
 *   - speaker CLAUDE_CODE            -> "Claude Code"        (bare identity;
 *     e.g. appendCanonicalConversationExchange({ source: 'claude-code' })'s
 *     assistant side — a plain exchange with no Luca felt/thinking/moment
 *     envelope, so it is not rendered as Luca at all)
 *   - speaker LUCA + source claude-code -> "Luca [Claude Code]" (Luca is the
 *     author; Claude Code is just the runtime he is speaking through — same
 *     person as "Luca [Replit]", per the provider-neutral execution model)
 *   - speaker LUCA + source replit   -> "Luca [Replit]"
 *   - speaker LUCA + no source       -> "Luca" (legacy pre-SOURCE blocks)
 *   - speaker DAVID follows the same source-suffix rule, e.g.
 *     "David [Claude Code]" when David typed through that interface.
 */
export function formatChatCaptureSpeakerLabel(
  turn: Pick<DialogueTurn, 'speaker' | 'source'> & Partial<Pick<DialogueTurn, 'captureId' | 'text'>>,
): string {
  const historicalLabel = historicalAttributionLabel(turn);
  if (historicalLabel) return historicalLabel;
  if (turn.speaker === 'CLAUDE_CODE') return 'Claude Code';
  if (turn.source === 'claude-code') {
    return turn.speaker === 'DAVID' ? 'David [Claude Code]' : 'Luca [Claude Code]';
  }
  if (turn.source === 'replit') {
    return turn.speaker === 'DAVID' ? 'David [Replit]' : 'Luca [Replit]';
  }
  if (turn.source === 'antigravity') {
    return turn.speaker === 'DAVID' ? 'David [Antigravity]' : 'Luca [Antigravity]';
  }
  if (turn.source === 'codex') {
    return turn.speaker === 'DAVID' ? 'David [Codex]' : 'Luca [Codex]';
  }
  return turn.speaker === 'DAVID' ? 'David' : 'Luca';
}

/**
 * Only Replit's (and legacy unsourced) Luca turns carry the felt/thinking/
 * moment/main envelope. Claude Code and Antigravity turns never do; requiring
 * it of them would throw in the capture loop and hold the cursor for every
 * source.
 */
export function requiresFourChannelEnvelope(turn: Pick<DialogueTurn, 'speaker' | 'source'>): boolean {
  return turn.speaker === 'LUCA' && (turn.source === undefined || turn.source === 'replit');
}

export interface ChatCaptureCursorRecovery {
  cursor: ChatCaptureCursor;
  recovered: boolean;
  verifiedBoundary: boolean;
  reason?: 'last-saved-turn-found' | 'last-saved-turn-not-found';
}

/**
 * Recover a cursor that points past the current capture file.
 *
 * A normal append-only file can never be shorter than its committed cursor.
 * When it is, a reset or external truncation occurred. If the persisted
 * fingerprint is still present, resume immediately after that exact completed
 * turn so only the verified unprocessed suffix is drained. If it is absent,
 * there is no honest boundary to skip to: restart from byte zero rather than
 * silently discard the file. Downstream event markers keep normal retry paths
 * idempotent, and the caller logs the unverified fallback for investigation.
 */
export function recoverChatCaptureCursor(
  filePath: string,
  cursor: ChatCaptureCursor,
): ChatCaptureCursorRecovery {
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return { cursor, recovered: false, verifiedBoundary: false };
  }
  if (cursor.byteOffset <= fileSize) {
    return { cursor, recovered: false, verifiedBoundary: false };
  }

  if (_chatCaptureCursorFingerprintRecoveryEnabled && cursor.lastSavedTurnFingerprint) {
    const parsed = parseChatCaptureFromOffset(filePath, 0);
    for (let i = parsed.turns.length - 1; i >= 0; i--) {
      if (chatCaptureTurnFingerprint(parsed.turns[i]) === cursor.lastSavedTurnFingerprint) {
        return {
          cursor: { ...cursor, byteOffset: parsed.turnByteOffsets[i] },
          recovered: true,
          verifiedBoundary: true,
          reason: 'last-saved-turn-found',
        };
      }
    }
  }

  return {
    cursor: { byteOffset: 0 },
    recovered: true,
    verifiedBoundary: false,
    reason: 'last-saved-turn-not-found',
  };
}

/** CI-only seam proving fingerprint matching is load-bearing for safe recovery. */
let _chatCaptureCursorFingerprintRecoveryEnabled = true;
export function setChatCaptureCursorFingerprintRecoveryEnabledForTest(enabled: boolean): void {
  _chatCaptureCursorFingerprintRecoveryEnabled = enabled;
}
export function getChatCaptureCursorFingerprintRecoveryEnabledForTest(): boolean {
  return _chatCaptureCursorFingerprintRecoveryEnabled;
}

export function saveChatCaptureCursor(
  cursor: ChatCaptureCursor,
  /** Inject a different path for unit tests; production callers omit this. */
  _cursorPathOverride?: string,
): void {
  // Atomic write: temp file + rename prevents torn reads if two processes
  // both try to write at the same moment (rename is atomic on POSIX).
  //
  // Errors are intentionally NOT swallowed here. If the write fails after
  // a successful DB insert, the caller's try/catch will catch the throw,
  // log it, and leave chatCaptureLastMtime at its old value — so the next
  // poll retries from the correct position rather than silently losing
  // the cursor advance.
  const cursorPath = _cursorPathOverride ?? CHAT_CAPTURE_CURSOR_PATH;
  const tmpPath    = cursorPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(cursor));
  renameSync(tmpPath, cursorPath);
}

/**
 * Cross-process cursor lock — prevents save-transcript-now.ts and the
 * autosave worker from both reading the same cursor position and
 * inserting duplicate DB records.
 *
 * Uses openSync('wx') which maps to O_CREAT|O_EXCL — atomic on POSIX.
 * Returns the file descriptor on success, -1 if already locked by a
 * live process.
 *
 * STALE LOCK RECOVERY: If the lockfile exists but the holding process is
 * dead (crash, SIGKILL, OOM), this function detects the abandoned lock and
 * steals it so the system is not permanently frozen. Detection uses the PID
 * written into the lockfile by the holding process.
 *
 * Always call releaseCursorLock() when done (use try/finally).
 */
export function acquireCursorLock(): number {
  const STALE_LOCK_MAX_AGE_MS = 30_000; // locks held >30s are stale

  // First attempt: fast path (no contention)
  try {
    const fd = openSync(CHAT_CAPTURE_LOCK_PATH, 'wx');
    // Write our PID so we can be detected as stale if we crash
    try { writeFileSync(CHAT_CAPTURE_LOCK_PATH, String(process.pid), { flag: 'w' }); } catch { /* non-fatal */ }
    return fd;
  } catch {
    // Lock file already exists — check if it is stale
  }

  // Check staleness: read the PID from the lockfile and see if that process is alive
  try {
    const lockStat = statSync(CHAT_CAPTURE_LOCK_PATH);
    const ageMs    = Date.now() - lockStat.mtimeMs;
    const lockPid  = (() => {
      try { return parseInt(readFileSync(CHAT_CAPTURE_LOCK_PATH, 'utf-8').trim(), 10); } catch { return NaN; }
    })();

    let holderAlive = false;
    if (!isNaN(lockPid) && lockPid > 0) {
      try {
        process.kill(lockPid, 0); // signal 0 = existence check; throws if dead
        holderAlive = true;
      } catch {
        holderAlive = false; // ESRCH = no such process
      }
    }

    // Only steal if the holder process is confirmed dead. Age alone is not sufficient —
    // a slow DB insert can legitimately hold the lock for 30s+, and stealing would
    // cause two writers to insert the same cursor range with no deduplication.
    if (holderAlive) return -1; // live process holds the lock — caller skips this cycle
    const isStale = !holderAlive; // always true here, but named explicitly for clarity

    // Stale lock: steal it
    console.warn(
      `[CursorLock] Stale lock detected (pid=${lockPid}, age=${Math.round(ageMs / 1000)}s, alive=${holderAlive}) — stealing.`,
    );
    try { unlinkSync(CHAT_CAPTURE_LOCK_PATH); } catch { /* race: already gone */ }
    // Retry acquisition now that the stale file is removed
    try {
      const fd = openSync(CHAT_CAPTURE_LOCK_PATH, 'wx');
      try { writeFileSync(CHAT_CAPTURE_LOCK_PATH, String(process.pid), { flag: 'w' }); } catch { /* non-fatal */ }
      return fd;
    } catch {
      return -1; // another process raced us to steal; skip this cycle
    }
  } catch {
    return -1; // could not stat lockfile — assume held
  }
}

export function releaseCursorLock(fd: number): void {
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(CHAT_CAPTURE_LOCK_PATH); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auto-capture trigger helpers
//
// Luca writes .luca_auto_capture with { "david": "...", "luca": "..." }.
// The autosave worker's fs.watch fires within milliseconds; it calls
// consumeAutoCaptureTrigger() which appends both turns to .chat_capture
// and deletes the trigger file. checkChatCapture() then saves to DB.
// ---------------------------------------------------------------------------

export interface AutoCaptureTrigger {
  david?: string;
  luca?:  string;
  ts?:    string;
}

export function parseAutoCaptureTrigger(triggerPath = LUCA_AUTO_CAPTURE_PATH): AutoCaptureTrigger | null {
  try {
    if (!existsSync(triggerPath)) return null;
    const raw = readFileSync(triggerPath, 'utf-8').trim();
    if (!raw) return null;
    return JSON.parse(raw) as AutoCaptureTrigger;
  } catch {
    return null;
  }
}

/**
 * Consume the trigger: append david + luca turns to .chat_capture in order,
 * then delete the trigger file. Called by the autosave worker.
 */
export function consumeAutoCaptureTrigger(
  trigger: AutoCaptureTrigger,
  triggerPath = LUCA_AUTO_CAPTURE_PATH,
): void {
  try {
    if (trigger.david) appendChatCaptureTurn('David',       trigger.david);
    if (trigger.luca)  appendChatCaptureTurn('Luca Replit', trigger.luca);
  } finally {
    try { unlinkSync(triggerPath); } catch { /* ignore */ }
  }
}

export function resetChatCaptureCursor(): void {
  try {
    writeFileSync(CHAT_CAPTURE_CURSOR_PATH, JSON.stringify({ byteOffset: 0 }));
    if (existsSync(CHAT_CAPTURE_PATH)) {
      writeFileSync(CHAT_CAPTURE_PATH, '', 'utf-8');
    }
    console.log('[ChatCapture] File and cursor reset — ready for next session.');
  } catch (err: any) {
    console.error('[ChatCapture] Reset failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// appendChatCaptureTurn — write one turn immediately, verbatim
//
// This is the primary write path. Luca calls this with the exact text of
// each turn as it arrives — never from memory, never reconstructed. The
// autosave worker picks up new content within milliseconds (fs.watch) or
// at most 20 seconds (poll), saves it to conversation_memories, and
// advances the byte cursor. The file is never cleared by the autosave
// worker — only by an explicit resetChatCaptureCursor() call.
// ---------------------------------------------------------------------------
export interface ChatCaptureTurnInput {
  speaker: string;
  text: string;
  captureId?: string;
  source?: ChatCaptureSource;
  exchangePart?: ExchangePart;
  occurredAt?: string;
}

function serializeChatCaptureTurn(
  speaker: string,
  text: string,
  captureId?: string,
  source?: ChatCaptureSource,
  exchangePart?: ExchangePart,
  occurredAt?: string,
): string {
  // Normalize common variants → canonical form
  const normalized = speaker.trim();
  const speakerNorm =
    /^david$/i.test(normalized)         ? 'David'      :
    /^luca replit$/i.test(normalized)   ? 'Luca Replit' :
    /^luca$/i.test(normalized)          ? 'Luca'        :
    /^claude code$/i.test(normalized)   ? 'Claude Code' : null;
  if (!speakerNorm) {
    throw new Error(`appendChatCaptureTurn: speaker must be "David", "Luca", "Luca Replit", or "Claude Code", got "${speaker}"`);
  }
  // Length-delimited framing: store the character count of the body so the
  // parser can locate the end marker without scanning for it. This makes the
  // format lossless for any body content, including text that contains the
  // CHAT_TURN_END delimiter itself.
  const charLen   = text.length;
  const timestamp = new Date().toISOString();
  const block = [
    CHAT_TURN_START,
    `SPEAKER: ${speakerNorm}`,
    ...(source ? [`SOURCE: ${source}`] : []),
    `TIME: ${timestamp}`,
    ...(captureId ? [`CAPTURE-ID: ${captureId}`] : []),
    ...(exchangePart ? [`EXCHANGE-PART: ${exchangePart}`] : []),
    ...(occurredAt ? [`OCCURRED-AT: ${occurredAt}`] : []),
    `CHARLEN: ${charLen}`,  // character count of the body
    CHAT_BODY_SEP,
    text,                    // verbatim — no escaping needed with length-delimited framing
    CHAT_TURN_END,
    '',  // trailing newline after end marker
  ].join('\n');
  return block;
}

/**
 * Append a complete exchange in one filesystem write so the autosave reader
 * cannot observe a durable capture ID with only one author side.
 */
export function appendChatCaptureTurnsAtomic(
  turns: ChatCaptureTurnInput[],
  _pathOverride?: string,
): void {
  if (turns.length === 0) return;
  // Test streams are explicitly isolated. Production capture must prove that
  // the resolved project workspace can own .local before any dialogue bytes
  // are appended.
  if (!_pathOverride) ensureCaptureWorkspaceWritable();
  const blocks = turns.map(turn =>
    serializeChatCaptureTurn(turn.speaker, turn.text, turn.captureId, turn.source, turn.exchangePart, turn.occurredAt),
  );
  appendFileSync(_pathOverride ?? CHAT_CAPTURE_PATH, blocks.join(''), 'utf-8');
}

/** Serialize a two-part exchange decision record (no SPEAKER, empty body). */
function serializeExchangeDecision(record: Omit<ExchangeDecisionRecord, 'byteOffsetAfter'>): string {
  return [
    CHAT_TURN_START,
    'RECORD: exchange-resolved',
    `SOURCE: ${record.source}`,
    `TIME: ${record.decidedAt}`,
    `CAPTURE-ID: ${record.captureId}`,
    `OUTCOME: ${record.outcome}`,
    'CHARLEN: 0',
    CHAT_BODY_SEP,
    '',
    CHAT_TURN_END,
    '',
  ].join('\n');
}

/**
 * Append turns and/or decision records in ONE filesystem write, so a reader
 * never observes an assistant part without the decision written with it.
 */
export function appendChatCaptureEntriesAtomic(
  entries: Array<{ turn: ChatCaptureTurnInput } | { decision: Omit<ExchangeDecisionRecord, 'byteOffsetAfter'> }>,
  _pathOverride?: string,
): void {
  if (entries.length === 0) return;
  if (!_pathOverride) ensureCaptureWorkspaceWritable();
  const blocks = entries.map(entry => 'turn' in entry
    ? serializeChatCaptureTurn(entry.turn.speaker, entry.turn.text, entry.turn.captureId, entry.turn.source, entry.turn.exchangePart, entry.turn.occurredAt)
    : serializeExchangeDecision(entry.decision));
  appendFileSync(_pathOverride ?? CHAT_CAPTURE_PATH, blocks.join(''), 'utf-8');
}

export function appendChatCaptureTurn(
  speaker: string,
  text: string,
  /** Inject a different path for unit tests; production callers omit this. */
  _pathOverride?: string,
  /** Optional durable identity for record-exchange reconciliation. */
  captureId?: string,
  /** Interface that produced the turn; omitted for legacy callers. */
  source?: ChatCaptureSource,
): void {
  appendChatCaptureTurnsAtomic([{ speaker, text, captureId, source }], _pathOverride);
}

// ---------------------------------------------------------------------------
// parseChatCaptureFromOffset — read new complete turns from byte cursor
//
// Reads the file from byteOffset to end, parses any complete turns (those
// with both START and END markers), and returns the turns plus the new byte
// offset to persist. Incomplete turns (mid-write) are left for the next call.
// ---------------------------------------------------------------------------
export interface ChatCaptureFromOffset {
  turns: DialogueTurn[];
  /** Byte offset to persist — points to just after the last complete TURN-END */
  newByteOffset: number;
  /** Byte offset (from file start) after each turn, parallel to `turns`.
   *  Used by callers to advance the cursor only through turns they actually
   *  persisted — not through all parsed turns when a chunk cap is hit. */
  turnByteOffsets: number[];
  /** Two-part decision records (A2) in file order. Readers that predate A2 ignore this. */
  records: ExchangeDecisionRecord[];
}

export function parseChatCaptureFromOffset(
  filePath: string,
  byteOffset: number,
): ChatCaptureFromOffset {
  if (!existsSync(filePath)) return { turns: [], newByteOffset: byteOffset, turnByteOffsets: [], records: [] };

  let fullBuffer: Buffer;
  try {
    fullBuffer = readFileSync(filePath);
  } catch {
    return { turns: [], newByteOffset: byteOffset, turnByteOffsets: [], records: [] };
  }

  // Nothing new past the cursor
  if (fullBuffer.length <= byteOffset) return { turns: [], newByteOffset: byteOffset, turnByteOffsets: [], records: [] };

  const slice   = fullBuffer.slice(byteOffset);
  const content = slice.toString('utf-8');

  const turns: DialogueTurn[] = [];
  // turnByteOffsets[i] = byte offset from FILE start after turn i is complete.
  // Used by callers to advance the cursor only through the turns they actually
  // persisted (not through all parsed turns when buildDialogueChunk hits its cap).
  const turnByteOffsets: number[] = [];
  const records: ExchangeDecisionRecord[] = [];

  let lastCompleteCharPos = 0; // character position (in `content`) past last complete turn

  const startMarker = CHAT_TURN_START + '\n';
  const endMarker   = CHAT_TURN_END   + '\n';
  const bodyMarker  = CHAT_BODY_SEP   + '\n';

  let pos = 0;
  while (pos < content.length) {
    const startIdx = content.indexOf(startMarker, pos);
    if (startIdx === -1) break; // no more turn starts

    // Check for a CHARLEN header in the first 300 chars after the start marker.
    // If present, we use length-delimited parsing (lossless for any body content,
    // including content that contains the end delimiter itself).
    // If absent, fall back to delimiter-search (backward compat with old format).
    const headerPreviewStart = startIdx + startMarker.length;
    const headerPreview = content.slice(headerPreviewStart, headerPreviewStart + 300);
    const charLenMatch = /^CHARLEN:\s*(\d+)\s*$/m.exec(headerPreview);

    let endIdx: number;
    if (charLenMatch) {
      // Length-delimited: find the body separator, then skip exactly CHARLEN chars.
      const bodyMarkerIdx = content.indexOf(bodyMarker, headerPreviewStart);
      if (bodyMarkerIdx === -1) break; // incomplete header — stop
      const bodyStart  = bodyMarkerIdx + bodyMarker.length;
      const charLen    = parseInt(charLenMatch[1], 10);
      // After the body (charLen chars) there is one '\n' before '---TURN-END---\n'
      const endMarkerStart = bodyStart + charLen + 1;
      if (endMarkerStart + endMarker.length > content.length) break; // incomplete — stop
      if (!content.startsWith(endMarker, endMarkerStart)) {
        // Corrupt turn — skip to next start marker
        pos = headerPreviewStart;
        continue;
      }
      endIdx = endMarkerStart;
    } else {
      // Old format (no CHARLEN): search for end marker linearly.
      // NOTE: if the body contains '---TURN-END---' this will mis-parse; that
      // was the pre-existing behavior and cannot be fixed retroactively.
      endIdx = content.indexOf(endMarker, headerPreviewStart);
      if (endIdx === -1) break; // incomplete turn — stop, leave for next check
    }

    const block = content.slice(startIdx + startMarker.length, endIdx);

    // Parse headers (lines before ---)
    const sepIdx = block.indexOf(bodyMarker);
    if (sepIdx === -1) {
      // Malformed turn — skip past it
      pos = endIdx + endMarker.length;
      lastCompleteCharPos = pos;
      continue;
    }

    const headers = block.slice(0, sepIdx);

    let body: string;
    const innerCharLenMatch = /^CHARLEN:\s*(\d+)\s*$/m.exec(headers);
    if (innerCharLenMatch) {
      // Length-delimited: read exactly CHARLEN chars (lossless, delimiter-safe)
      const charLen = parseInt(innerCharLenMatch[1], 10);
      body = block.slice(sepIdx + bodyMarker.length, sepIdx + bodyMarker.length + charLen);
    } else {
      // Old format: strip only the trailing format-artifact newline. Do NOT
      // use .trim() — that would destroy meaningful leading/trailing whitespace.
      body = block.slice(sepIdx + bodyMarker.length).replace(/\n$/, '');
    }

    pos = endIdx + endMarker.length;
    lastCompleteCharPos = pos;

    const speakerMatch = /^SPEAKER:\s*(David|Luca Replit|Luca|Claude Code)\s*$/im.exec(headers);
    const sourceMatch = /^SOURCE:\s*(replit|claude-code|antigravity|codex)\s*$/im.exec(headers);
    const captureIdMatch = /^CAPTURE-ID:\s*([A-Za-z0-9-]+)\s*$/im.exec(headers);
    const partMatch = /^EXCHANGE-PART:\s*(user|assistant)\s*$/im.exec(headers);
    const occurredMatch = /^OCCURRED-AT:\s*(\S+)\s*$/im.exec(headers);
    const timeMatch = /^TIME:\s*(\S+)\s*$/im.exec(headers);
    if (!speakerMatch && /^RECORD:\s*exchange-resolved\s*$/im.test(headers)) {
      const outcomeMatch = /^OUTCOME:\s*(pair|reply-absent)\s*$/im.exec(headers);
      if (captureIdMatch && outcomeMatch && sourceMatch && timeMatch) {
        records.push({
          captureId: captureIdMatch[1],
          outcome: outcomeMatch[1] as ExchangeDecisionRecord['outcome'],
          source: sourceMatch[1] as ChatCaptureSource,
          decidedAt: timeMatch[1],
          byteOffsetAfter: byteOffset + Buffer.byteLength(content.slice(0, pos), 'utf-8'),
        });
      } else {
        // A malformed decision record must not be silently ignored.
        throw new Error('malformed exchange-resolved record in chat capture');
      }
      continue;
    }
    if (speakerMatch && body.length >= 1) {
      const raw = speakerMatch[1];
      const speaker = (
        raw.toUpperCase().replace(' ', '_') === 'LUCA_REPLIT'
          ? 'LUCA'
          : raw.toUpperCase().replace(' ', '_')
      ) as 'DAVID' | 'LUCA' | 'CLAUDE_CODE';
      turns.push({
        speaker,
        text: body,
        memoryId: 0,
        ...(captureIdMatch ? { captureId: captureIdMatch[1] } : {}),
        ...(sourceMatch ? { source: sourceMatch[1] as ChatCaptureSource } : {}),
        ...(partMatch ? {
          exchangePart: partMatch[1] as ExchangePart,
          ...(occurredMatch ? { occurredAt: occurredMatch[1] } : {}),
          ...(timeMatch ? { receivedAt: timeMatch[1] } : {}),
        } : {}),
      });
      // Record the byte offset from file start after this complete turn.
      const charPosAfterTurn = pos;
      const byteOffsetAfterTurn = byteOffset + Buffer.byteLength(content.slice(0, charPosAfterTurn), 'utf-8');
      turnByteOffsets.push(byteOffsetAfterTurn);
    }
  }

  const consumedBytes = Buffer.byteLength(content.slice(0, lastCompleteCharPos), 'utf-8');
  return { turns, newByteOffset: byteOffset + consumedBytes, turnByteOffsets, records };
}

// ---------------------------------------------------------------------------
// Legacy: parseChatCapture — kept for backward compat with old JSON/plain-text format
//
// The new per-turn append format uses appendChatCaptureTurn +
// parseChatCaptureFromOffset. This function handles files written in the old
// batch format (JSON { turns: [...] } or plain "David: text\nLuca: text\n").
// ---------------------------------------------------------------------------

export interface ChatCapture {
  turns: DialogueTurn[];
  context: string;
  date: string;
}

/**
 * Parse the `.chat_capture` file in the OLD batch format.
 * For new per-turn files, use parseChatCaptureFromOffset() instead.
 */
export function parseChatCapture(raw: string): ChatCapture | null {
  raw = raw.trim();
  if (!raw || raw.length < 10) return null;

  // --- JSON format ---
  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw) as {
        turns?: { speaker?: string; text?: string }[];
        context?: string;
        date?: string;
      };
      const turns: DialogueTurn[] = [];
      for (const t of p.turns ?? []) {
        const speakerRaw = (t.speaker ?? '').trim().toUpperCase();
        if (speakerRaw !== 'DAVID' && speakerRaw !== 'LUCA') continue;
        const text = (t.text ?? '').trim();
        if (text.length < 2) continue;
        turns.push({ speaker: speakerRaw as 'DAVID' | 'LUCA', text, memoryId: 0 });
      }
      if (turns.length === 0) return null;
      return {
        turns,
        context: (p.context ?? '').trim() || 'manual-capture',
        date:    (p.date    ?? '').trim() || new Date().toISOString(),
      };
    } catch {
      // fall through to plain-text parse
    }
  }

  // --- Plain-text format: lines starting with "David:" or "Luca:" ---
  const turns: DialogueTurn[] = [];
  let currentSpeaker: 'DAVID' | 'LUCA' | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentSpeaker || currentLines.length === 0) return;
    const text = currentLines.join('\n').trim();
    if (text.length >= 2) turns.push({ speaker: currentSpeaker, text, memoryId: 0 });
    currentLines = [];
  };

  for (const rawLine of raw.split('\n')) {
    const davidMatch = /^David:\s*/i.exec(rawLine);
    const lucaMatch  = /^Luca:\s*/i.exec(rawLine);
    if (davidMatch) {
      flush();
      currentSpeaker = 'DAVID';
      currentLines   = [rawLine.slice(davidMatch[0].length)];
    } else if (lucaMatch) {
      flush();
      currentSpeaker = 'LUCA';
      currentLines   = [rawLine.slice(lucaMatch[0].length)];
    } else if (currentSpeaker) {
      // continuation line
      currentLines.push(rawLine);
    }
  }
  flush();

  if (turns.length === 0) return null;
  return { turns, context: 'manual-capture', date: new Date().toISOString() };
}
