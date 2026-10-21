/**
 * save-transcript-now.ts
 *
 * Standalone script — forces an immediate save of the current Luca↔David
 * transcript to conversation_memories, tagged 'david-luca-chat'.
 *
 * Auto-detects whether the autosave worker (server) is running:
 *   - Server UP   → trigger mode: writes .flush_transcript; the server's
 *                   fs.watch() fires sub-second and its in-process mutex
 *                   handles serialisation, preventing cursor races.
 *   - Server DOWN → direct mode: writes directly to the DB using the same
 *                   buildDialogueChunk + extractTurns logic as the worker
 *                   (no concurrent worker to race against).
 *
 * Both modes share transcript-parser.ts, so pre-compression recovery and
 * record-safe chunking (memoryId-grouped boundaries) are identical.
 *
 * Usage:
 *   npx tsx server/scripts/save-transcript-now.ts
 *   npx tsx server/scripts/save-transcript-now.ts --trigger-only
 *   npx tsx server/scripts/save-transcript-now.ts --direct
 *   npx tsx server/scripts/save-transcript-now.ts --context "session end"
 *
 * Called by the holahola-session-end checklist Pre-step 0.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getSharedDb } from '../db';
import { sql } from 'drizzle-orm';
import {
  WORKSPACE,
  loadCursor,
  saveCursor,
  findTranscriptPath,
  extractTurns,
  buildDialogueChunk,
  CHAT_CAPTURE_PATH,
  loadChatCaptureCursor,
  saveChatCaptureCursor,
  parseChatCaptureFromOffset,
  acquireCursorLock,
  releaseCursorLock,
  type DialogueTurn,
} from '../services/transcript-parser';
import {
  attributionTags,
  attributionWritersEnabled,
  plainParticipants,
  plainRowTitle,
  plainTitleDate,
} from '../services/attribution-rendering';
import { buildCanonicalRowAttribution } from '../services/turn-attribution-writer';

// Row-level participants/title for a .chat_capture batch, mirroring
// capture-watchdog.ts's writeToDb model: derive both from actual per-turn
// `speaker` (not a source/format-only check), so a batch containing a
// genuine Claude Code turn is never mislabeled "Luca" in its title/
// participants while its body (buildDialogueChunk, via
// formatChatCaptureSpeakerLabel) correctly renders it as bare "Claude Code".
// `speaker` answers WHO authored a turn; `source` only ever picks the
// interface suffix for a Luca turn. This does NOT apply to the JSONL-
// transcript path below (extractTurns) — that legacy format predates
// Claude Code capture and its parser only ever emits DAVID/LUCA speakers.
// See formatChatCaptureSpeakerLabel in transcript-parser.ts for the full
// three-way model this mirrors.
type ChatCaptureAssistantKind = 'claude-code' | 'luca-claude-code' | 'luca';
function chatCaptureTurnKind(t: Pick<DialogueTurn, 'speaker' | 'source'>): ChatCaptureAssistantKind | 'david' {
  if (t.speaker === 'DAVID') return 'david';
  if (t.speaker === 'CLAUDE_CODE') return 'claude-code';
  return t.source === 'claude-code' ? 'luca-claude-code' : 'luca';
}
const CHAT_CAPTURE_ASSISTANT_TITLE: Record<ChatCaptureAssistantKind, string> = {
  'claude-code': 'Claude Code',
  'luca-claude-code': 'Luca [Claude Code]',
  luca: 'Luca',
};
function chatCaptureAssistantKinds(batchTurns: Array<Pick<DialogueTurn, 'speaker' | 'source'>>): ChatCaptureAssistantKind[] {
  return [...new Set(batchTurns.map(chatCaptureTurnKind).filter((k): k is ChatCaptureAssistantKind => k !== 'david'))];
}
function chatCaptureBatchTitle(batchTurns: Array<Pick<DialogueTurn, 'speaker' | 'source'>>, today: string, suffix: string): string {
  // Attribution design f5d77712 section 4, behind the shared writer switch.
  if (attributionWritersEnabled()) return plainRowTitle(batchTurns, plainTitleDate());
  const assistantKinds = chatCaptureAssistantKinds(batchTurns);
  const who = assistantKinds.length > 0
    ? `David ↔ ${assistantKinds.map(k => CHAT_CAPTURE_ASSISTANT_TITLE[k]).join(' + ')}`
    : 'David';
  return `${who} — ${today}: ${suffix}`;
}
/** Postgres array-literal string for a text[] parameter bound through drizzle's sql tag (matches agent-session-autosave.ts's participantsArray). */
function chatCaptureBatchParticipants(batchTurns: Array<Pick<DialogueTurn, 'speaker' | 'source'>>): string {
  const values = attributionWritersEnabled()
    ? plainParticipants(batchTurns)
    : ['david', ...chatCaptureAssistantKinds(batchTurns)];
  return pgTextArray(values);
}
/** Base tags plus, with the writer switch on, the design section 4 attribution tags. */
function chatCaptureBatchTags(base: string[], batchTurns: Array<Pick<DialogueTurn, 'source'>>, modelTags?: string[]): string {
  return pgTextArray(attributionWritersEnabled() ? [...base, ...attributionTags(batchTurns, modelTags)] : base);
}
/**
 * With the writer switch on, the row's content in design 3.3 framing plus
 * its per-turn attribution; otherwise (or if the chunk cap truncated authored
 * text, or a turn cannot be framed) the dialogue exactly as before.
 */
function chatCaptureRow(batchTurns: DialogueTurn[], dialogue: string): { content: string; attribution: string | null; modelTags?: string[] } {
  const authoredChars = batchTurns.reduce((sum, turn) => sum + turn.text.length, 0);
  const built = attributionWritersEnabled() && dialogue.length >= authoredChars
    ? buildCanonicalRowAttribution(batchTurns, { bold: false })
    : null;
  return built
    ? { content: built.content, attribution: JSON.stringify(built.attribution), modelTags: built.modelTags }
    : { content: dialogue, attribution: null };
}
function pgTextArray(values: string[]): string {
  return `{${values.map(v => `"${v.replace(/"/g, '\\"')}"`).join(',')}}`;
}

const FLUSH_PATH        = join(WORKSPACE, '.local/.flush_transcript');
const HEALTH_URL        = 'http://localhost:5000/api/health';
const SERVER_DETECT_MS  = 1500;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const triggerOnly = args.includes('--trigger-only');
const directOnly  = args.includes('--direct');
const contextArg  = (() => {
  const idx = args.indexOf('--context');
  return idx !== -1 ? (args[idx + 1] ?? '') : '';
})();

// ---------------------------------------------------------------------------
// Server detection
// ---------------------------------------------------------------------------
async function isServerRunning(): Promise<boolean> {
  try {
    const resp = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(SERVER_DETECT_MS),
    });
    return resp.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Trigger-file mode (use when server is up — no cross-process cursor race)
// ---------------------------------------------------------------------------
function touchFlushTrigger(): void {
  writeFileSync(FLUSH_PATH, new Date().toISOString());
  console.log('[SaveTranscriptNow] Flush trigger written —',
    'autosave worker fs.watch() listener will fire sub-second.');
}

// ---------------------------------------------------------------------------
// Direct mode (use when server is down — no concurrent worker)
//
// Primary path: JSONL transcript (Replit wrote these through Jul 27 2026).
// Fallback path: .chat_capture trigger file (manual capture, used when Replit
//   no longer writes JSONL files for the current session).
// ---------------------------------------------------------------------------
async function saveNow(context: string): Promise<void> {
  const today        = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const contextLabel = context || 'session-end flush';

  // --- Primary: JSONL transcript ---
  const found = findTranscriptPath();
  if (found) {
    const cursor  = loadCursor();
    const afterId = cursor.sessionId === found.sessionId ? cursor.lastMemoryId : 0;

    // extractTurns uses shared logic including full pre-compression recovery
    const { turns } = extractTurns(found.path, afterId);
    if (turns.length > 0) {
      // buildDialogueChunk groups by memoryId — never splits same-ID records
      const { dialogue, lastIncludedMemoryId, includedCount, remainingCount } =
        buildDialogueChunk(turns, afterId);

      const davidCount = turns.slice(0, includedCount).filter(t => t.speaker === 'DAVID').length;
      const title      = `David ↔ Luca — ${today}: ${contextLabel}`;
      const summary    = `Verbatim David↔Luca dialogue captured at session end. ${davidCount} David turns, ${includedCount - davidCount} Luca turns. Context: ${contextLabel.slice(0, 200)}`;

      const db = getSharedDb();
      const result = await db.execute(sql`
        INSERT INTO conversation_memories
          (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
        VALUES (
          gen_random_uuid(),
          ${title},
          ${summary},
          ${dialogue},
          ARRAY['david', 'luca']::text[],
          ARRAY['david-luca-chat', 'verbatim', 'session-end-flush']::text[],
          8,
          NOW(),
          'conversation',
          'david-luca-chat'
        )
        RETURNING id
      `);

      const savedId = (result.rows as any[])[0]?.id ?? '?';

      // Advance cursor only through persisted groups — remaining survive for next flush
      saveCursor({ sessionId: found.sessionId, lastMemoryId: lastIncludedMemoryId });
      console.log(`[SaveTranscriptNow] ✓ Saved (JSONL path): "${title}"`);
      console.log(`[SaveTranscriptNow]   id=${savedId}`);
      console.log(`[SaveTranscriptNow]   ${davidCount} David + ${includedCount - davidCount} Luca turns (cursor ${afterId}→${lastIncludedMemoryId}${remainingCount > 0 ? `, ${remainingCount} turns queued for next flush` : ''})`);

      // Also touch the flush trigger so the autosave worker's mtime stays in sync
      // if/when it starts — prevents a redundant save on next poll.
      if (existsSync(join(WORKSPACE, '.local'))) {
        try { touchFlushTrigger(); } catch { /* ignore — .local may be read-only */ }
      }
      return;
    }
    console.log(`[SaveTranscriptNow] No new JSONL turns since last save (cursor: ${afterId})`);
  } else {
    console.log('[SaveTranscriptNow] No JSONL transcript file found — Replit may have stopped writing transcripts (after Jul 27 2026).');
  }

  // --- Fallback: .chat_capture append-only log (per-turn cursor path) ---
  // Uses the same drain loop as saveChatCaptureWithLock so that turns beyond the
  // 80K chunk cap are never silently skipped in direct/server-down mode.
  if (existsSync(CHAT_CAPTURE_PATH)) {
    const cursor = loadChatCaptureCursor();
    const { turns, newByteOffset, turnByteOffsets } = parseChatCaptureFromOffset(CHAT_CAPTURE_PATH, cursor.byteOffset);

    if (turns.length > 0) {
      let remaining        = turns;
      let remainingOffsets = turnByteOffsets;
      let startCursor      = cursor.byteOffset;
      let totalInserted    = 0;

      while (remaining.length > 0) {
        const { dialogue, includedCount } = buildDialogueChunk(remaining, 0);

        if (includedCount === 0) {
          // Single turn exceeds chunk cap even alone — skip to prevent infinite loop
          console.warn('[SaveTranscriptNow] (saveNow) Skipping 1 turn that exceeds chunk cap even alone');
          startCursor = remainingOffsets[0] ?? startCursor;
          remaining = remaining.slice(1);
          remainingOffsets = remainingOffsets.slice(1);
          continue;
        }

        const endOffset = remainingOffsets[includedCount - 1];
        if (endOffset === undefined) {
          throw new Error(`[SaveTranscriptNow] (saveNow) endOffset undefined for includedCount=${includedCount}`);
        }

        const batchTurns = remaining.slice(0, includedCount);
        const davidCount = batchTurns.filter(t => t.speaker === 'DAVID').length;
        const title   = chatCaptureBatchTitle(batchTurns, today, contextLabel);
        const row     = chatCaptureRow(batchTurns, dialogue);
        const summary = `Verbatim David↔Luca dialogue (per-turn append, session-end flush). ${davidCount} David turn(s), ${includedCount - davidCount} assistant turn(s). Cursor ${startCursor}→${endOffset}.`;

        const db = getSharedDb();
        const result = await db.execute(sql`
          INSERT INTO conversation_memories
            (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name, attribution)
          VALUES (
            gen_random_uuid(),
            ${title},
            ${summary},
            ${row.content},
            ${chatCaptureBatchParticipants(batchTurns)}::text[],
            ${chatCaptureBatchTags(['david-luca-chat', 'verbatim', 'per-turn', 'chat-capture', 'session-end-flush'], batchTurns, row.modelTags)}::text[],
            8,
            NOW(),
            'conversation',
            'david-luca-chat',
            ${row.attribution}::jsonb
          )
          RETURNING id
        `);

        const savedId = (result.rows as any[])[0]?.id ?? '?';
        // Advance cursor only through included turns — never use newByteOffset
        saveChatCaptureCursor({ byteOffset: endOffset });
        console.log(`[SaveTranscriptNow] ✓ Saved (chat_capture path): "${title}"`);
        console.log(`[SaveTranscriptNow]   id=${savedId}`);
        console.log(`[SaveTranscriptNow]   ${davidCount} David + ${includedCount - davidCount} Luca turn(s), cursor ${startCursor}→${endOffset}`);

        totalInserted += includedCount;
        startCursor = endOffset;
        remaining = remaining.slice(includedCount);
        remainingOffsets = remainingOffsets.slice(includedCount);
      }

      if (totalInserted > 0) return;
    }
    const fileSize = statSync(CHAT_CAPTURE_PATH).size;
    console.log(`[SaveTranscriptNow] .chat_capture has ${fileSize} bytes total, cursor at ${loadChatCaptureCursor().byteOffset} — no new complete turns to save.`);
  }

  console.log('[SaveTranscriptNow] No conversation data to save.');
  console.log('[SaveTranscriptNow] Write turns immediately as they happen using:');
  console.log('[SaveTranscriptNow]   npx tsx server/scripts/append-turn.ts David "exact text"');
  console.log('[SaveTranscriptNow]   npx tsx server/scripts/append-turn.ts Luca  "exact text"');
}

// ---------------------------------------------------------------------------
// .chat_capture flush — save any turns past the cursor (byte-cursor approach)
//
// Safe to call even when the server is up: both this process and the autosave
// worker use a mutex (chatCaptureSaveInProgress in the worker). The cursor is
// the idempotency guarantee — not file clearing. Worst case: two processes
// read the same bytes, but only one advances the cursor (last-write-wins on the
// cursor file). To eliminate the race entirely this function loads the cursor,
// does the insert, then writes the new cursor atomically.
// ---------------------------------------------------------------------------
async function saveChatCaptureNow(_context: string): Promise<boolean> {
  if (!existsSync(CHAT_CAPTURE_PATH)) return false;

  // Cross-process lock — prevents racing the autosave worker on the cursor.
  const lockFd = acquireCursorLock();
  if (lockFd === -1) {
    console.log('[SaveTranscriptNow] Cursor lock held by autosave worker — waiting 2s and retrying...');
    await new Promise(r => setTimeout(r, 2000));
    const lockFd2 = acquireCursorLock();
    if (lockFd2 === -1) {
      console.log('[SaveTranscriptNow] Still locked — skipping to avoid duplicate record');
      return false;
    }
    // use lockFd2 — fall through with lock held
    return saveChatCaptureWithLock(lockFd2, _context);
  }
  return saveChatCaptureWithLock(lockFd, _context);
}

async function saveChatCaptureWithLock(lockFd: number, _context: string): Promise<boolean> {
  try {
    const cursor = loadChatCaptureCursor();
    const { turns, newByteOffset, turnByteOffsets } = parseChatCaptureFromOffset(CHAT_CAPTURE_PATH, cursor.byteOffset);

    if (turns.length === 0) {
      const fileSize = existsSync(CHAT_CAPTURE_PATH) ? statSync(CHAT_CAPTURE_PATH).size : 0;
      console.log(`[SaveTranscriptNow] No new chat_capture turns (file=${fileSize}B, cursor=${cursor.byteOffset}B)`);
      return false;
    }

    // Drain loop — advance cursor only through turns actually inserted in each batch.
    let remaining = turns;
    let remainingOffsets = turnByteOffsets;
    let startCursor = cursor.byteOffset;
    let totalInserted = 0;
    let lastSavedId = '?';

    while (remaining.length > 0) {
      const today      = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const { dialogue, includedCount } = buildDialogueChunk(remaining, 0);

      if (includedCount === 0) {
        // Safety net: skip one uninsertable turn to avoid an infinite loop.
        // Fall back to startCursor (not newByteOffset!) so remaining un-inserted
        // turns are not silently skipped.
        console.warn('[SaveTranscriptNow] Skipping 1 turn that exceeds chunk cap even alone');
        startCursor = remainingOffsets[0] ?? startCursor;
        remaining = remaining.slice(1);
        remainingOffsets = remainingOffsets.slice(1);
        continue;
      }

      const endOffset = remainingOffsets[includedCount - 1];
      if (endOffset === undefined) {
        // Should never happen: includedCount <= remaining.length = remainingOffsets.length
        throw new Error(`[SaveTranscriptNow] endOffset undefined for includedCount=${includedCount}, offsets.length=${remainingOffsets.length}`);
      }

      const batchTurns = remaining.slice(0, includedCount);
      const davidCount = batchTurns.filter(t => t.speaker === 'DAVID').length;
      const title      = chatCaptureBatchTitle(batchTurns, today, 'per-turn capture');
      const row        = chatCaptureRow(batchTurns, dialogue);
      const summary    = `Verbatim David↔Luca per-turn capture. ${davidCount}D + ${includedCount - davidCount} assistant turns. Cursor ${startCursor}→${endOffset}.`;

      const db = getSharedDb();
      const result = await db.execute(sql`
        INSERT INTO conversation_memories
          (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name, attribution)
        VALUES (
          gen_random_uuid(),
          ${title},
          ${summary},
          ${row.content},
          ${chatCaptureBatchParticipants(batchTurns)}::text[],
          ${chatCaptureBatchTags(['david-luca-chat', 'verbatim', 'per-turn', 'chat-capture'], batchTurns, row.modelTags)}::text[],
          8,
          NOW(),
          'conversation',
          'david-luca-chat',
          ${row.attribution}::jsonb
        )
        RETURNING id
      `);

      lastSavedId = (result.rows as any[])[0]?.id ?? '?';
      // Advance cursor ONLY through included turns — never use newByteOffset as fallback:
      // that would silently skip any remaining un-inserted turns.
      const effectiveCursor = endOffset;
      saveChatCaptureCursor({ byteOffset: effectiveCursor });

      console.log(`[SaveTranscriptNow] ✓ Saved (chat_capture): "${title}" id=${lastSavedId}`);
      console.log(`[SaveTranscriptNow]   ${davidCount}D + ${includedCount - davidCount}L turns, cursor ${startCursor}→${effectiveCursor}`);

      totalInserted += includedCount;
      startCursor = effectiveCursor;
      remaining = remaining.slice(includedCount);
      remainingOffsets = remainingOffsets.slice(includedCount);
    }

    return totalInserted > 0;
  } finally {
    releaseCursorLock(lockFd);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  if (triggerOnly) {
    touchFlushTrigger();
    process.exit(0);
  }

  if (!directOnly) {
    const serverUp = await isServerRunning();
    if (serverUp) {
      console.log('[SaveTranscriptNow] Server is running — using trigger mode for JSONL (avoids cross-process cursor race).');
      // JSONL path: delegate to the server's flush handler (handles cursor serialisation)
      touchFlushTrigger();
      // .chat_capture path: always save directly — no cursor, no race.
      // The autosave worker will see an empty file on its next poll and skip.
      try {
        const chatSaved = await saveChatCaptureNow(contextArg);
        if (!chatSaved) {
          console.log('[SaveTranscriptNow] No .chat_capture content to save alongside JSONL flush.');
        }
      } catch (err: any) {
        console.error('[SaveTranscriptNow] .chat_capture save error (non-fatal):', err.message);
      }
      process.exit(0);
    }
    console.log('[SaveTranscriptNow] Server not detected — using direct save mode.');
  }

  try {
    await saveNow(contextArg);
  } catch (err: any) {
    console.error('[SaveTranscriptNow] ERROR:', err.message);
    process.exit(1);
  }

  process.exit(0);
})();
