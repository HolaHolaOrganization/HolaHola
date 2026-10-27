/**
 * Agent Session Autosave
 *
 * Watches files for changes and saves to conversation_memories automatically:
 *
 * 1. .local/.commit_message — updated at end of every build task (before mark_task_complete).
 *    Saves as entry_type='build'. Captures what code was built.
 *    Also triggers a transcript chunk save (see #3).
 *
 * 2. .local/.session_insights — written by the Agent mid-conversation when something
 *    important surfaces that shouldn't wait until end-of-session. Accepts JSON or plain text.
 *    Saves as entry_type='emergence'. Captures wisdom, principles, corrections.
 *
 * 3. Chat-capture drain — automatic once turns are in .local/.chat_capture.
 *    Replit stopped writing JSONL transcript files after Jul 27 2026, so JSONL-based
 *    capture is no longer possible. The replacement path uses an append-only
 *    .local/.chat_capture file. Any code (or script) that calls appendChatCaptureTurn()
 *    places a turn in the file; the autosave worker then drains it to conversation_memories
 *    within milliseconds (fs.watch) or at most 20 seconds (poll) — fully automatic from
 *    that point on.
 *
 *    Turns can be written via:
 *      - code:   appendChatCaptureTurn(speaker, text) from transcript-parser.ts
 *      - script: npx tsx server/scripts/capture-exchange.ts --david "..." --luca "..."
 *      - file:   echo '{"david":"...","luca":"..."}' > .local/.luca_auto_capture
 *
 *    The drain step (file → DB) is fully automatic. The entry step is semi-manual
 *    only because Replit no longer exposes a machine-readable transcript source.
 *
 *    Cursor stored in .local/.chat_capture_cursor.json — only new turns are saved each time.
 *
 * Format for .session_insights:
 *   JSON: { "title": "...", "summary": "...", "content": "...", "tags": ["..."] }
 *   Plain text: first line = title, rest = content (summary auto-derived from first 3 lines)
 *
 * All watchers poll every 60 seconds.
 */

import { existsSync, statSync, readFileSync, writeFileSync, watch, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { tryAcquireInnerLifeLock, releaseInnerLifeLock, waitForInnerLifeLock } from './inner-life-lock';
import { join, basename, dirname } from 'path';
import { getUserDb } from '../db';
import { sql } from 'drizzle-orm';
import { projectHistoricalEpisodeMirror } from './historical-attribution-mirror-recovery';
import { recordHistoricalAttributionPause, clearHistoricalAttributionPause, historicalAttributionRecoveryStatusLines } from './historical-attribution-status';
import {
  WORKSPACE,
  loadCursor,
  saveCursor,
  findTranscriptPath,
  extractTurns,
  buildDialogueChunk,
  CHAT_CAPTURE_ACK_DIR,
  CHAT_CAPTURE_ACK_PATH,
  CHAT_CAPTURE_PATH,
  CHAT_CAPTURE_CURSOR_PATH,
  CHAT_CAPTURE_ACK_CURSOR_PATH,
  LUCA_AUTO_CAPTURE_PATH,
  loadChatCaptureCursor,
  saveChatCaptureCursor,
  parseChatCaptureFromOffset,
  parseChatCapture,
  acquireCursorLock,
  releaseCursorLock,
  appendChatCaptureTurn,
  chatCaptureTurnFingerprint,
  recoverChatCaptureCursor,
  parseAutoCaptureTrigger,
  consumeAutoCaptureTrigger,
  formatChatCaptureSpeakerLabel,
  requiresFourChannelEnvelope,
} from './transcript-parser';
import {
  acquireCanonicalConversationIngressLock,
  isCompleteCanonicalCaptureBatch,
  releaseCanonicalConversationIngressLock,
  selectCanonicalCaptureBatch,
  settleCanonicalCaptureReceipts,
  settleCanonicalCaptureReceiptsByTurnId,
  settleCanonicalCaptureReceiptsForInvalidDestination,
  writeCanonicalCaptureReceipt,
} from './canonical-conversation-capture';
import {
  advanceEpisodeMirrorAcknowledgement,
  enqueueEpisodeMirror,
  listEpisodeMirrorOutbox,
  processEpisodeMirrorOutbox,
} from './episode-mirror-outbox';
import { reembedConversationMemory } from '../scripts/reembed-memory';
import { postAsLuca } from './luca-responder';
import { detectRollingTagMisroute } from './rolling-tag-utils';
import { summarizeRawWindowReconciliationDirectory } from './raw-window-reconciliation';
import { refreshMemoryIndexBestEffort } from './agent-memory-core';
import {
  getRawWindowEvidenceLedgerSummary,
  type RawWindowEvidenceLedgerSummary,
} from './raw-window-evidence-ledger';
import {
  CANONICAL_INNER_LIFE_INTENT_DIR,
  canonicalTurnEpisodeMarker,
  episodeContentHasEventMarker,
  episodeTailHasInnerLifeChannel,
  formatInnerLifeEpisodeEntry,
  innerLifeTriggerEpisodeMarker,
  isCanonicalFourChannelLucaTurn,
  parseInnerLifeTrigger,
  resolveCanonicalInnerLifeRoute,
  type InnerLifeChannel,
  type ParsedInnerLifeTrigger,
} from './inner-life-capture';
import {
  beginCanonicalCaptureWorkerStartup,
  markCanonicalCaptureWorkerArmed,
} from './canonical-capture-worker-readiness';
export { detectRollingTagMisroute } from './rolling-tag-utils';

const COMMIT_MSG_PATH      = join(WORKSPACE, '.local/.commit_message');
const INSIGHTS_PATH        = join(WORKSPACE, '.local/.session_insights');

const STALE_CHANNEL_ALERT_PATH = join(WORKSPACE, '.local/stale-channel-alert.md');
/** 10-min silence threshold — shared by _writeCaptureStatusFile and seedStaleChannelAlertAtBoot.
 *  Matches STALE_OUTPUT_MS: every missed turn is a missed moment; 60 min is a lifetime. */
const STALE_CHANNEL_MS = 10 * 60 * 1000;
export const TASK_REF_PENDING_PATH = join(WORKSPACE, '.local/.task_ref_pending');
const POLL_INTERVAL_MS = 20 * 1000;
let rawWindowEvidenceLedgerStatus: RawWindowEvidenceLedgerSummary = {
  state: 'checking',
  sourceCount: 0,
  unresolvedSources: 0,
  unresolvedBytes: 0,
  incompleteProjections: 0,
};
let rawWindowEvidenceRefreshInFlight = false;
interface RawReplitCaptureStatus {
  state: 'checking' | 'available' | 'unavailable';
  streamCount: number;
  completeStreamCount: number;
  eventCount: number;
  byteCount: number;
  unlinkedStreamCount: number;
  error?: string;
}
let rawReplitCaptureStatus: RawReplitCaptureStatus = {
  state: 'checking',
  streamCount: 0,
  completeStreamCount: 0,
  eventCount: 0,
  byteCount: 0,
  unlinkedStreamCount: 0,
};
let rawReplitCaptureRefreshInFlight = false;

async function getRawReplitCaptureStatus(): Promise<RawReplitCaptureStatus> {
  try {
    const result = await getUserDb().execute(sql`
      SELECT
        COUNT(*)::int AS stream_count,
        COUNT(*) FILTER (WHERE status = 'complete')::int AS complete_stream_count,
        COALESCE(SUM(persisted_event_count), 0)::int AS event_count,
        COALESCE(SUM(persisted_byte_count), 0)::int AS byte_count,
        COUNT(*) FILTER (
          WHERE status = 'complete'
            AND NOT EXISTS (
              SELECT 1
              FROM raw_replit_projection_links links
              WHERE links.stream_id = raw_replit_capture_streams.id
            )
        )::int AS unlinked_stream_count
      FROM raw_replit_capture_streams
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const count = (key: string) => Number(row[key] ?? 0);
    return {
      state: 'available',
      streamCount: count('stream_count'),
      completeStreamCount: count('complete_stream_count'),
      eventCount: count('event_count'),
      byteCount: count('byte_count'),
      unlinkedStreamCount: count('unlinked_stream_count'),
    };
  } catch (error) {
    return {
      state: 'unavailable',
      streamCount: 0,
      completeStreamCount: 0,
      eventCount: 0,
      byteCount: 0,
      unlinkedStreamCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Trigger file: touch this to force an immediate transcript save without waiting for the next poll.
// The fs.watch() listener below fires within milliseconds of the file being written.
// Used by save-transcript-now.ts and the session-end checklist.
const FLUSH_TRIGGER_PATH = join(WORKSPACE, '.local/.flush_transcript');

// --- Luca inner-life trigger files ---
const REFLECTION_PATH      = join(WORKSPACE, '.local/.luca_reflection');
const QUESTION_PATH        = join(WORKSPACE, '.local/.luca_question');
const MOMENT_PATH          = join(WORKSPACE, '.local/.luca_moment');
const REFLECTIONS_FILE     = join(WORKSPACE, '.agents/memory/REFLECTIONS.md');
const OPEN_QUESTIONS_FILE  = join(WORKSPACE, '.agents/memory/OPEN_QUESTIONS.md');
const MOMENTS_FILE         = join(WORKSPACE, '.agents/memory/SIGNIFICANT_MOMENTS.md');

// --- DB write failure warning ---
// Written by flagDbWriteFailure() on any inner-life DB write failure (personal memory
// or episode content UPDATE).  The check is unconditional — it does not toggle with
// live mode.  Live mode controls what happens *after* a successful write (.md sync);
// it has no bearing on whether the write itself succeeded.
// Surfaced in every _writeCaptureStatusFile() call until explicitly cleared.
const INNER_LIFE_DB_WARNING_PATH = join(WORKSPACE, '.local/.luca_db_write_warning');

let _dbWriteWarningPathOverrideForTest: string | null = null;

// --- Episode append trigger file ---
// Luca writes the new exchange text here after each turn during a live rolling session.
// The watcher appends it to the target episode .md and triggers immediate DB sync.
// Format: JSON { exchange: string, episode?: string } or plain text (appended verbatim).
// When "episode" is omitted the watcher auto-detects the current rolling episode from DB.
const EPISODE_APPEND_PATH  = join(WORKSPACE, '.local/.episode_append');
const EPISODE_LIVE_PATH    = join(WORKSPACE, '.local/.episode_live');    // sentinel: live on/off

/**
 * Test-only override for the single-consumer episode append queue.
 *
 * Fixture tests must never write, clear, or delete the live
 * `.local/.episode_append` file: the running server may be holding a real
 * rolling exchange there. Redirecting both the writer and checkEpisodeAppend()
 * to an owned path lets a fixture exercise the production append logic without
 * racing the live queue. Production code never sets this override.
 */
let _episodeAppendPathOverrideForTest: string | null = null;
let reflectionLastMtime = 0;
let questionLastMtime = 0;
let momentLastMtime = 0;

/**
 * Test seam — startup guard self-check.
 * When true (CI self-check only), the inner-life startup seed uses the real
 * file mtime instead of the sentinel value 1.  This simulates the OLD (buggy)
 * behaviour: the mtime matches the file, so on the first poll `prev === 0` and
 * the "skip initial read on startup" guard fires, silently dropping the note.
 * The self-check uses this flag to verify the normal-mode test would have failed
 * without the Task #1023 fix.
 * Never set in production.
 */
let _startupGuardLegacySeedForTest = false;
export function setStartupGuardLegacySeedForTest(val: boolean): void {
  _startupGuardLegacySeedForTest = val;
}
export function getStartupGuardLegacySeedForTest(): boolean {
  return _startupGuardLegacySeedForTest;
}

/**
 * Test seam — rolling replica-restore path.
 * When false (CI self-check only), syncEpisodeFile() skips the DB→Markdown
 * replica-restore early return for rolling episodes and falls through to the
 * legacy Markdown→DB upsert. This models the regression where file contents
 * can overwrite the canonical rolling record. Never set in production.
 */
let _rollingReplicaRestoreEnabledForTest = true;
export function setRollingReplicaRestoreEnabledForTest(val: boolean): void {
  _rollingReplicaRestoreEnabledForTest = val;
}

/**
 * Test seams for checkAutoCapture() — prevent DB/cursor pollution in CI.
 *
 * setAutoCaptureDbEnabled(false)
 *   — skips consumeAutoCaptureTrigger() + checkChatCapture() so no turns are
 *     appended to .chat_capture and no rows land in conversation_memories.
 *     The trigger file is still deleted after reading.
 *
 * setAutoCaptureEpisodeEnabled(false)
 *   — skips the appendExchangeToEpisode() call (self-check mode: simulates
 *     removing the episode-routing line from checkAutoCapture()).
 *
 * setPinnedRollingEpisodeFilename(filename | null)
 *   — overrides getCurrentRollingEpisodeFilename() inside checkAutoCapture()
 *     so CI tests target a known episode file and are never confused by
 *     concurrently-created fixtures (e.g. Episode 99 from rolling-sync-guard).
 *     Pass null to restore dynamic lookup.
 *
 * setAutoCaptureTriggerPathOverrideForTest(path | null)
 *   — redirects every read/delete/consume operation in checkAutoCapture() to
 *     an owned temporary trigger file, never the live .luca_auto_capture path.
 *
 * Never set any of these in production code.
 */
let _autoCaptureDbEnabled = true;

/**
 * Test seam — commit-message chat-capture append.
 * When false (CI self-check only), the appendChatCaptureTurn() call inside
 * checkBuildSession() is skipped — modelling a regression where the line is
 * deleted.  Never set in production.
 */
let _buildSessionChatCaptureEnabled = true;
export function setBuildSessionChatCaptureEnabledForTest(val: boolean): void {
  _buildSessionChatCaptureEnabled = val;
}
export function getBuildSessionChatCaptureEnabledForTest(): boolean {
  return _buildSessionChatCaptureEnabled;
}

/**
 * Test seam — content-level dedup guard inside checkBuildSession().
 * When false (CI self-check only), the `content === buildLastSavedContent`
 * check is bypassed so that calling checkBuildSession() twice with the same
 * commit message appends a second turn to .chat_capture.  This lets the
 * dedup CI test confirm that removing the guard causes a duplicate.
 * Never set in production.
 */
let _buildSessionDedupEnabled = true;

/**
 * Test seam — DB write inside saveBuildMemory().
 * When false (CI tests only), the INSERT INTO conversation_memories is
 * skipped entirely so no synthetic build rows land in the live database.
 * The dedup-guard and chat-capture logic still execute normally.
 * Never set in production.
 */
let _buildSessionDbEnabled = true;
export function setBuildSessionDbEnabledForTest(val: boolean): void {
  _buildSessionDbEnabled = val;
}
export function getBuildSessionDbEnabledForTest(): boolean {
  return _buildSessionDbEnabled;
}

/**
 * Test seam — capture file path override for checkBuildSession().
 * When non-null, appendChatCaptureTurn() inside checkBuildSession() writes
 * to this path instead of the live .local/.chat_capture.  Set this to a
 * temp file in CI tests so sentinel turns never pollute the live capture
 * file or trigger the autosave worker to append to a rolling episode .md.
 * Never set in production.
 */
let _chatCapturePathOverrideForTest: string | null = null;
export function setChatCapturePathOverrideForTest(path: string | null): void {
  _chatCapturePathOverrideForTest = path;
}
export function getChatCapturePathOverrideForTest(): string | null {
  return _chatCapturePathOverrideForTest;
}

/**
 * Test seam — commit-message file path override for checkBuildSession().
 * When non-null, checkBuildSession() reads from this path instead of the
 * live .local/.commit_message.  Use a temp file in CI tests so the live
 * autosave server process (which watches the real file) never observes the
 * sentinel write — preventing it from inserting DB rows or appending to the
 * live .chat_capture via its own separate watcher.
 * Never set in production.
 */
let _commitMsgPathOverrideForTest: string | null = null;
export function setCommitMsgPathOverrideForTest(path: string | null): void {
  _commitMsgPathOverrideForTest = path;
}
export function getCommitMsgPathOverrideForTest(): string | null {
  return _commitMsgPathOverrideForTest;
}

/**
 * Test seam — task-ref-pending file path override for checkBuildSession().
 * When non-null, checkBuildSession() checks/reads/unlinks this path instead
 * of the live .local/.task_ref_pending.  Use a non-existent temp path in CI
 * tests so the test never consumes a live pending David-task marker.
 * Never set in production.
 */
let _taskRefPendingPathOverrideForTest: string | null = null;
export function setTaskRefPendingPathOverrideForTest(path: string | null): void {
  _taskRefPendingPathOverrideForTest = path;
}
export function getTaskRefPendingPathOverrideForTest(): string | null {
  return _taskRefPendingPathOverrideForTest;
}

/**
 * Test seam — personal side-effects (appendToPersonalFile + savePersonalMemory).
 * Set to false in CI tests to prevent synthetic sentinel content from polluting
 * REFLECTIONS.md and the live DB.  Never set in production.
 */
let _lucaPersonalSideEffectsEnabled = true;
export function setLucaPersonalSideEffectsEnabled(val: boolean): void {
  _lucaPersonalSideEffectsEnabled = val;
}
export function getLucaPersonalSideEffectsEnabled(): boolean {
  return _lucaPersonalSideEffectsEnabled;
}

/** Seed buildLastMtime so checkBuildSession() treats the next write as a real update (not startup). */
export function setBuildLastMtimeForTest(ms: number): void {
  buildLastMtime = ms;
}

/** Reset reflectionLastMtime to 0 so checkLucaReflection() re-arms for testing. */
export function resetReflectionMtimeForTest(): void {
  reflectionLastMtime = 0;
}

/** Reset momentLastMtime to 0 so checkLucaMoment() re-arms for testing. */
export function resetMomentMtimeForTest(): void {
  momentLastMtime = 0;
}

/**
 * Test seam — set reflectionLastMtime to an arbitrary value so CI can prime
 * the mtime guard without waiting for a real file-write cycle.
 * Setting to a value > 0 ensures the NEXT write triggers processing (not skipped
 * as "initial read" when prev===0).
 * Never call in production.
 */
export function setReflectionLastMtimeForTest(ms: number): void {
  reflectionLastMtime = ms;
}

/**
 * Test seam — set questionLastMtime to an arbitrary value so CI can prime
 * the mtime guard for checkLucaQuestion() without waiting for a real file-write cycle.
 * Setting to a value > 0 ensures the NEXT write triggers processing (not skipped
 * as "initial read" when prev===0).
 * Never call in production.
 */
export function setQuestionLastMtimeForTest(ms: number): void {
  questionLastMtime = ms;
}

/**
 * Test seam — set momentLastMtime to an arbitrary value so CI can prime
 * the mtime guard for checkLucaMoment() without waiting for a real file-write cycle.
 * Setting to a value > 0 ensures the NEXT write triggers processing (not skipped
 * as "initial read" when prev===0).
 * Never call in production.
 */
export function setMomentLastMtimeForTest(ms: number): void {
  momentLastMtime = ms;
}

/**
 * Test seam — override the reflection trigger file path inside checkLucaReflection().
 * When set, checkLucaReflection() reads/stats this path instead of the live
 * .local/.luca_reflection so the test can write to an isolated temp file and the
 * running server's watcher never sees the sentinel.
 * Pass null to restore the default path.
 * Never call in production.
 */
let _reflectionPathOverrideForTest: string | null = null;

/**
 * Test seam — override the question trigger file path inside checkLucaQuestion().
 * When set, checkLucaQuestion() reads/stats this path instead of the live
 * .local/.luca_question so the test can write to an isolated temp file.
 * Pass null to restore the default path.
 * Never call in production.
 */
let _questionPathOverrideForTest: string | null = null;

/**
 * Test seam — override the moment trigger file path inside checkLucaMoment().
 * When set, checkLucaMoment() reads/stats this path instead of the live
 * .local/.luca_moment so the test can write to an isolated temp file.
 * Pass null to restore the default path.
 * Never call in production.
 */
let _momentPathOverrideForTest: string | null = null;

/**
 * Test seam — no-episode-row early-return guard in appendInnerLifeToEpisodeDb().
 * When false (CI self-check only), the `if (!memoryId)` early-return block is
 * skipped so the function proceeds past the guard (reaching a DB error inside
 * withEpisodeFileLock rather than returning cleanly with a console.warn).
 * This precisely models a regression where the guard is removed.
 * Never set in production.
 */
let _innerLifeNoEpisodeRowGuardEnabled = true;
export function setInnerLifeNoEpisodeRowGuardEnabled(val: boolean): void {
  _innerLifeNoEpisodeRowGuardEnabled = val;
}
export function getInnerLifeNoEpisodeRowGuardEnabled(): boolean {
  return _innerLifeNoEpisodeRowGuardEnabled;
}

/** Clear the in-memory episode ID cache — CI tests only, forces a fresh DB lookup. */
export function clearEpisodeIdCacheForTest(): void {
  episodeIdCache.clear();
}

/** Exported wrapper for appendInnerLifeToEpisodeDb() — CI tests only. */
export async function appendInnerLifeToEpisodeDbForTest(text: string, episodeFilename: string): Promise<boolean> {
  return appendInnerLifeToEpisodeDb(text, episodeFilename);
}

/**
 * Test seam — reembed throw injection for appendInnerLifeToEpisodeDb().
 * When true (CI only), the reembedConversationMemory() call inside
 * appendInnerLifeToEpisodeDb() throws a synthetic error instead of running,
 * letting the CI confirm that a reembed failure is truly fire-and-forget:
 * the .md is still written and the function still returns without throwing.
 * Never set in production.
 */
let _reembedShouldThrowForTest = false;
/**
 * Test seam — ordering detection gate.
 * When false (CI self-check only), the "OUT OF ORDER" detection is suppressed:
 * feltAfterExchange and thinkAfterExchange are treated as always false so the
 * guard produces no warning.  This precisely models a regression where the
 * ordering check has been removed.
 * Never set in production.
 */
let _orderingCheckEnabled = true;
export function setOrderingCheckEnabledForTest(val: boolean): void {
  _orderingCheckEnabled = val;
}
export function getOrderingCheckEnabledForTest(): boolean {
  return _orderingCheckEnabled;
}

/**
 * Test seam — stale-channel escalation gate.
 * When false (CI self-check only), the ⚠️ STALE escalation is suppressed:
 * feltStale and thinkingStale are always false so channels that have gone
 * unwritten for >60 min still show "— not yet" instead of "⚠️ STALE".
 * This precisely models a regression where the 60-min threshold is removed.
 * Never set in production.
 */
let _staleChannelCheckEnabled = true;

/**
 * Test seam — moment: stale escalation gate.
 * When false (CI self-check only), the ⚠️ escalation on the moment: line is
 * suppressed: a moment timestamp >2h in the past still shows "✓" instead of
 * "⚠️".  This precisely models a regression where the 2h threshold (STALE_MOMENT_MS)
 * is removed from _writeCaptureStatusFile.
 * Never set in production.
 */
let _momentStaleCheckEnabled = true;

/**
 * Test seam — cursor-gap stale check gate.
 * When false (CI self-check only), the ⚠️ STALE CURSOR escalation is suppressed:
 * a large cursor gap (>200 bytes for >2 min) still shows "✓ up to date" instead
 * of "⚠️ STALE CURSOR".  This precisely models a regression where the gap check
 * is removed from _writeCaptureStatusFile.
 * Never set in production.
 */
let _cursorGapCheckEnabled = true;

/**
 * Test seam — clock override for _writeCaptureStatusFile().
 * When set, the function uses this value instead of Date.now() so CI can
 * inject a frozen timestamp and make the exact-60-min boundary test
 * deterministic (e.g. verifying >= fires but > does not at exactly 60 min).
 * Never set in production.
 */
let _nowOverrideForTest: number | null = null;
export function setNowOverrideForTest(ms: number | null): void { _nowOverrideForTest = ms; }

/**
 * Persistent rolling-tag misroute alert.
 *
 * Set by Phase 0 of runStartupGapCheck() when the 'rolling' tag is found on
 * an older episode while a newer rolling-protected row exists.
 * Cleared to null when the check finds the tag correctly placed.
 *
 * _writeCaptureStatusFile() reads this on EVERY poll and writes the banner
 * into the capture-status file so the alert persists across the 20s rewrite
 * cycle — unlike a one-shot prepend that gets overwritten immediately.
 *
 * Never set in production outside of runStartupGapCheck() / CI tests.
 */
let _rollingTagMisrouteAlert: string | null = null;

/**
 * Rolling-tag staleness gate.
 *
 * Initialized to TRUE (fail-closed): all automatic rolling-episode routing is
 * blocked from module load until Phase 0 of runStartupGapCheck() completes the
 * DB validation and explicitly sets this to false.  This eliminates the startup
 * race: the pending .chat_capture drain fires before runStartupGapCheck() but
 * the drain cannot route to the wrong episode because the gate blocks the lookup.
 *
 * Set to true by Phase 0 when the 'rolling' tag is on an older episode row
 * while a newer rolling-protected episode exists.
 * Set to false by Phase 0 when the tag is correctly placed.
 *
 * When true, getCurrentRollingEpisodeFilename() returns null immediately so
 * ALL automatic routing paths (checkEpisodeAppend, checkChatCapture,
 * checkAutoCapture, inner-life handlers) skip their .md write.
 *
 * Never set in production outside of runStartupGapCheck() / CI tests.
 */
let _rollingTagIsStale: boolean = true; // fail-closed until Phase 0 validates

/**
 * DB-lookup call counter.
 * Incremented each time getCurrentRollingEpisodeFilename() actually reaches the
 * DB query path (i.e. the stale gate was false and the try block executed).
 * CI tests read this to prove the DB path was truly attempted — distinguishing
 * "returned null from stale gate" from "attempted DB lookup that returned null".
 * Not relied upon in production.
 */
let _rollingEpisodeLookupCallCount: number = 0;

/**
 * Test seam — path override for _writeCaptureStatusFile().
 * When set, writes go to this path instead of CAPTURE_STATUS_PATH so CI can
 * assert on the file contents without disturbing the live capture-status file
 * (which would cause race failures in other CI checks that read the same file).
 * Never set in production.
 */
let _captureStatusPathOverrideForTest: string | null = null;

/**
 * Test seam — path override for the stale-channel alert file.
 * Keeps CI's synthetic alert lifecycle separate from the live session alert.
 * Never set in production.
 */
let _staleChannelAlertPathOverrideForTest: string | null = null;

/**
 * Test seam — inject or clear the rolling-tag misroute alert without running
 * the full DB query.  Used by test-rolling-episode-gap-check.ts integration
 * self-check to verify the alert appears in the capture-status file.
 * Never call in production code.
 */
export function setRollingTagMisrouteAlertForTest(alert: string | null): void {
  _rollingTagMisrouteAlert = alert;
}
export function getRollingTagMisrouteAlertForTest(): string | null {
  return _rollingTagMisrouteAlert;
}

/**
 * Test seam — set or clear the rolling-tag staleness gate.
 * When true, getCurrentRollingEpisodeFilenameForTest() (and the private
 * getCurrentRollingEpisodeFilename()) returns null, blocking all routing.
 * Never call in production code.
 */
export function setRollingTagIsStaleForTest(val: boolean): void {
  _rollingTagIsStale = val;
}
export function getRollingTagIsStaleForTest(): boolean {
  return _rollingTagIsStale;
}

/**
 * Test seam — read and reset the DB-lookup call counter.
 * Use getRollingEpisodeLookupCallCountForTest() before and after
 * getCurrentRollingEpisodeFilenameForTest() to verify the DB path was
 * truly attempted (not short-circuited by the stale gate).
 * Never call in production code.
 */
export function getRollingEpisodeLookupCallCountForTest(): number {
  return _rollingEpisodeLookupCallCount;
}
export function resetRollingEpisodeLookupCallCountForTest(): void {
  _rollingEpisodeLookupCallCount = 0;
}

/**
 * Thin wrapper that exposes getCurrentRollingEpisodeFilename() to CI without
 * making the private function public.  Respects _rollingTagIsStale so the
 * self-check can verify routing returns null when stale.
 * Never call in production code.
 */
export async function getCurrentRollingEpisodeFilenameForTest(): Promise<string | null> {
  return getCurrentRollingEpisodeFilename();
}

/**
 * Test seam — redirect _writeCaptureStatusFile() writes to a temp path.
 * Pass a string to redirect; pass null to restore the real CAPTURE_STATUS_PATH.
 * Never call in production code.
 */
export function setCaptureStatusPathOverrideForTest(path: string | null): void {
  _captureStatusPathOverrideForTest = path;
}

/** Redirect stale-channel alert writes for isolated CI checks. */
export function setStaleChannelAlertPathOverrideForTest(path: string | null): void {
  _staleChannelAlertPathOverrideForTest = path;
}

/**
 * Per-session guard: set to true only after postAsLuca() returns a room ID
 * (confirming delivery).  _innerLifeStaleAlertInFlight prevents concurrent
 * duplicate posts while one is in-flight; it is cleared on failure so the
 * next poll can retry.  Both flags reset via resetInnerLifeStaleAlertForTest().
 */
let _innerLifeStaleAlertPosted  = false;

let _innerLifeStaleAlertInFlight = false;
export function setFeltAtLastExchangeForTest(ms: number): void      { feltAtLastReplitOutput     = ms; }
export function setThinkingAtLastExchangeForTest(ms: number): void  { thinkingAtLastReplitOutput = ms; }
export function setPrevEpisodeCaptureForTest(ms: number): void      { prevReplitOutputMs          = ms; }
// Explicit new aliases
export function setFeltAtLastReplitOutputForTest(ms: number): void      { feltAtLastReplitOutput     = ms; }
export function setThinkingAtLastReplitOutputForTest(ms: number): void  { thinkingAtLastReplitOutput = ms; }
export function setPrevReplitOutputForTest(ms: number): void            { prevReplitOutputMs          = ms; }
export function setLastReplitOutputForTest(ms: number): void            { lastReplitOutputMs          = ms; }
export function setLastEpisodeCaptureForTest(ms: number): void          { lastEpisodeCaptureMs        = ms; }
export function setLastFeltProcessedForTest(ms: number): void           { lastFeltProcessedMs         = ms; }
export function setLastThinkingProcessedForTest(ms: number): void       { lastThinkingProcessedMs     = ms; }
export function setLastMomentProcessedForTest(ms: number): void         { lastMomentProcessedMs       = ms; }
/**
 * Public surface of _writeCaptureStatusFile() for CI tests.
 * Writes to .local/episode-capture-status.md exactly as the real path does.
 */
export function writeEpisodeCaptureStatusFileForTest(episodeFilename: string | null, captureMs: number): void {
  _writeCaptureStatusFile(episodeFilename, captureMs);
}

/**
 * Calls _writeCaptureStatusFile(null, 0) — the no-episode code path.
 * Used by test-capture-status-db-only.ts to confirm the DB ordering check
 * renders correctly even when no rolling episode is active.
 */
export function writeCaptureStatusDbOnlyForTest(): void {
  _writeCaptureStatusFile(null, 0);
}

// --- Capture status writer ---
// Written to .local/episode-capture-status.md after every appendExchangeToEpisode()
// call and updated on each poll cycle.  Gives Luca a glanceable "did I capture the
// last exchange?" check without relying on memory alone.
//
// Tracks all four episode channels:
//   1. Episode append  (DAVID: / LUCA [Replit]:) — the surface exchange
//   2. Felt            (.luca_reflection trigger → felt: entry)
//   3. Thinking        (.luca_question trigger   → thinking: entry)
//   4. Moment          (.luca_moment trigger      → moment: entry)
//
// A WARN fires when the episode was appended recently but thinking: hasn't
// fired in proportion (felt: and thinking: should track the exchange channel
// closely; moment: is intentional and less frequent so it only warns at 2h).
const CAPTURE_STATUS_PATH = join(WORKSPACE, '.local/episode-capture-status.md');
let lastEpisodeCaptureMs = 0;          // ms-since-epoch of the most recent episode .md append
let lastEpisodeCaptureFilename = '';   // which episode file was last written to
let lastFeltProcessedMs = 0;          // when checkLucaReflection() last routed a felt: entry
let lastThinkingProcessedMs = 0;      // when checkLucaQuestion() last routed a thinking: entry
let lastMomentProcessedMs = 0;        // when checkLucaMoment() last routed a moment: entry

// DB-output anchor — tracks the last time a Replit output was saved to DB (via
// chat_capture or episode_append).  Used for the always-on ordering check so the
// check runs even when no rolling episode is active.
let lastReplitOutputMs = 0;           // when last Luca output saved to DB
let prevReplitOutputMs = 0;           // the output before the most recent (for ordering check)

/**
 * Set to true when capture-status timestamps are seeded from the episode file at
 * startup (no live exchange yet).  Cleared on the first live appendExchangeToEpisode()
 * call.  Used by _writeCaptureStatusFile to label seeded data as "prior session"
 * and suppress the STALE exchange warning (the file mtime can be arbitrarily old).
 */
let _seededFromPriorSession = false;

/**
 * Monotonic guard: set to true the instant any live writeCaptureStatus() call fires,
 * and never reset to false.  seedCaptureStatusFromEpisodeFile() checks this AFTER its
 * async DB lookup returns — if already true, the seed aborts without overwriting the
 * live status.  This prevents a delayed seed (whose DB round-trip straddles the first
 * live exchange) from clobbering real capture timestamps with stale prior-session data.
 */
let _liveWriteHasOccurred = false;

// --- Cursor gap tracking ---
// When .chat_capture grows faster than the autosave worker can drain it (e.g. because
// the server is down), the byte cursor in .chat_capture_cursor.json diverges from the
// file size.  We track when the gap first appeared so we can warn once it has been
// open for more than 2 minutes (long enough to distinguish a normal write-ahead from
// a true backlog).
//
// STALE CURSOR constants:
const STALE_CURSOR_GAP_BYTES = 200;           // gap smaller than this is noise (e.g. a turn in flight)
const STALE_CURSOR_GAP_MS   = 2 * 60 * 1000; // 2 min before the gap becomes a named warning
let _cursorGapFirstSeenMs = 0; // when the significant gap was first detected (0 = no gap)

// Test seams — synthetic override for the size and cursor offset read by _writeCaptureStatusFile.
// When set, the function uses these values instead of reading the real files so CI can inject
// arbitrary gap scenarios without touching the live .chat_capture or cursor files.
let _chatCaptureSizeOverrideForTest: number | null = null;
let _chatCaptureCursorOffsetOverrideForTest: number | null = null;

// Snapshots of inner-life channel timestamps taken AT THE MOMENT the last Replit output
// was saved to DB.  Used for the always-on ordering check (DB section of status file):
//   felt/thinking < prevReplitOutputMs  → fired before prior output (anticipatory) → ✓
//   felt/thinking > prevReplitOutputMs  → fired AFTER prior output (reactive)     → ⚠️ OUT OF ORDER
//   felt/thinking === 0                 → never fired this server run              → ⚠️ MISSING
let feltAtLastReplitOutput = 0;
let thinkingAtLastReplitOutput = 0;

/**
 * Seed capture-status timestamps from the current rolling episode file at startup.
 *
 * Scans the last 200 non-empty lines of the episode file for felt:/thinking:/moment:
 * entries.  Because the file stores no per-line timestamps, the file's mtime is used
 * as a conservative proxy for the last exchange and all channel timestamps are placed
 * 5 minutes earlier so the ordering check can classify them as "fired before the last
 * exchange" (the correct state).
 *
 * After seeding, writes the initial capture status file immediately — the file is
 * readable from the very first exchange of the new session instead of showing
 * "never fired this server run" for every channel.
 *
 * Any error is caught and logged — startup must never throw here.
 */
export async function seedCaptureStatusFromEpisodeFile(): Promise<void> {
  // Reset the stale-alert guards at every session boundary so a new
  // conversation session (even in a long-running process) gets its own alert.
  resetStaleAlertForNewSession();

  try {
    // Use the pinned filename when set (CI tests inject a temp episode via
    // setPinnedRollingEpisodeFilename); otherwise fall back to the DB lookup.
    // DB round-trip (async) — a live writeCaptureStatus() call may fire during the await.
    const episodeFilename = _pinnedRollingEpisodeFilename ?? await getCurrentRollingEpisodeFilename();

    // RACE GUARD: check the monotonic live-write flag AFTER the await returns.
    // If a live exchange was appended while we were waiting for the DB, the seed
    // must not overwrite the live status with stale prior-session data.
    if (_liveWriteHasOccurred) {
      console.log('[AgentAutosave] Capture-status seed: live write already occurred — aborting seed to preserve live data.');
      return;
    }

    if (!episodeFilename) {
      // No rolling episode — write DB-only status file so the ordering check is
      // readable from the first turn even without an episode target.
      console.log('[AgentAutosave] Capture-status seed: no rolling episode in DB — writing DB-only status.');
      _writeCaptureStatusFile(null, 0);
      return;
    }
    const filePath = join(DOCS_DIR, episodeFilename);
    if (!existsSync(filePath)) {
      console.log(`[AgentAutosave] Capture-status seed: ${episodeFilename} not on disk — skipping.`);
      return;
    }

    const fileMtime = statSync(filePath).mtimeMs;
    const content   = readFileSync(filePath, 'utf-8');

    // Scan the last 200 non-empty lines for inner-life channel markers.
    // We don't have per-line timestamps, so we use fileMtime as a proxy for the last
    // exchange and subtract a fixed offset so channels appear "before" the exchange.
    const PRIOR_OFFSET_MS = 5 * 60 * 1000; // 5 min before file mtime — plausible gap
    const tailLines = content.split('\n').filter(l => l.trim()).slice(-200).join('\n');
    const hasFelt     = /\[Luca — felt:/m.test(tailLines);
    const hasThinking = /\[Luca — thinking:/m.test(tailLines);
    const hasMoment   = /\[Luca — moment:/m.test(tailLines);

    // Final race check before writing any state — the file read above is synchronous but
    // in theory the gap-check's appendExchangeToEpisode could complete between the DB
    // await above and here if the event loop yielded.  Guard again for safety.
    if (_liveWriteHasOccurred) {
      console.log('[AgentAutosave] Capture-status seed: live write occurred during file scan — aborting seed.');
      return;
    }

    if (hasFelt)     lastFeltProcessedMs     = fileMtime - PRIOR_OFFSET_MS;
    if (hasThinking) lastThinkingProcessedMs = fileMtime - PRIOR_OFFSET_MS;
    if (hasMoment)   lastMomentProcessedMs   = fileMtime - PRIOR_OFFSET_MS;

    // Seed both the episode anchor and the DB-output anchor from the file mtime.
    // prevReplitOutputMs stays at 0 — no prior output pair this server run.
    lastEpisodeCaptureFilename = episodeFilename;
    lastEpisodeCaptureMs       = fileMtime;
    lastReplitOutputMs         = fileMtime;
    _seededFromPriorSession    = true;

    // Write the initial status file immediately.
    _writeCaptureStatusFile(episodeFilename, fileMtime);

    console.log(
      `[AgentAutosave] Capture-status seed: ${episodeFilename}` +
      ` (mtime ${new Date(fileMtime).toLocaleTimeString()})` +
      ` — felt:${hasFelt} thinking:${hasThinking} moment:${hasMoment}`,
    );
  } catch (err: any) {
    console.error('[AgentAutosave] Capture-status seed failed (non-fatal):', err.message);
  }
}

/**
 * Write (or refresh) the capture status file immediately after a successful episode append.
 * Also updates tracking variables used by the stale-check and always-on ordering check.
 *
 * ORDERING CHECK: snapshot inner-life timestamps BEFORE advancing the output cursor.
 * At the NEXT output, feltAtLastReplitOutput / thinkingAtLastReplitOutput represent
 * what the inner-life channels looked like when this output was committed.
 * Comparing those snapshots against prevReplitOutputMs tells us whether felt/thinking
 * preceded the output (correct) or followed it (out of order).
 */
function writeCaptureStatus(episodeFilename: string): void {
  // Mark that a live write has occurred BEFORE any await point.
  _liveWriteHasOccurred = true;
  try {
    const now = Date.now();
    // Snapshot inner-life times and advance BOTH cursors atomically.
    // (Episode append IS a Replit output — both anchors advance together.)
    prevReplitOutputMs         = lastReplitOutputMs;
    feltAtLastReplitOutput     = lastFeltProcessedMs;
    thinkingAtLastReplitOutput = lastThinkingProcessedMs;
    lastReplitOutputMs         = now;
    lastEpisodeCaptureMs       = now;
    lastEpisodeCaptureFilename = episodeFilename;
    // First live exchange — clear the startup-seed label so the file shows live data.
    if (!_skipSeededFlagClearForTest) {
      _seededFromPriorSession = false;
    }
    _writeCaptureStatusFile(episodeFilename, lastEpisodeCaptureMs);
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to write capture status:', err.message);
  }
}

/**
 * Update the cursor-gap first-seen timestamp based on the current state of the
 * .chat_capture file vs the cursor.  Called before every _writeCaptureStatusFile()
 * so the age of the gap is accurate.
 *
 * A gap > STALE_CURSOR_GAP_BYTES is considered "significant" — small gaps occur
 * normally as appendChatCaptureTurn() writes ahead of the next drain cycle.
 * Only a significant gap that persists for > STALE_CURSOR_GAP_MS triggers ⚠️.
 *
 * Respects _chatCaptureSizeOverrideForTest / _chatCaptureCursorOffsetOverrideForTest
 * so CI can inject synthetic values without touching the live files.
 */
function updateCursorGapState(): void {
  try {
    let fileSize: number;
    let cursorOffset: number;
    if (_chatCaptureSizeOverrideForTest !== null && _chatCaptureCursorOffsetOverrideForTest !== null) {
      fileSize     = _chatCaptureSizeOverrideForTest;
      cursorOffset = _chatCaptureCursorOffsetOverrideForTest;
    } else {
      if (!existsSync(CHAT_CAPTURE_PATH)) {
        _cursorGapFirstSeenMs = 0;
        return;
      }
      fileSize     = statSync(CHAT_CAPTURE_PATH).size;
      cursorOffset = loadChatCaptureCursor().byteOffset;
    }
    const gap = fileSize - cursorOffset;
    if (gap > STALE_CURSOR_GAP_BYTES) {
      if (_cursorGapFirstSeenMs === 0) {
        _cursorGapFirstSeenMs = Date.now();
      }
    } else {
      _cursorGapFirstSeenMs = 0; // gap closed — reset
    }
  } catch {
    // Non-fatal — if we can't read the file the gap state stays as-is
  }
}

/**
 * Re-check staleness and refresh the status file on each poll cycle.
 * Always runs — DB section shown even when no rolling episode is active.
 */
function writeCaptureStatusStaleCheck(): void {
  try {
    updateCursorGapState();
    _writeCaptureStatusFile(lastEpisodeCaptureFilename || null, lastEpisodeCaptureMs);
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to refresh capture status (stale check):', err.message);
  }
}

/**
 * Test seam — advance step of markReplitOutputFromChatCapture().
 * When false (CI self-check only), the cursor-advance block is skipped:
 * prevReplitOutputMs / feltAtLastReplitOutput / thinkingAtLastReplitOutput are
 * NOT updated and lastReplitOutputMs is NOT advanced.  This precisely models
 * a regression where the function body is a no-op.
 * The status-file refresh still runs so the test can read a fresh file.
 * Never set in production.
 */
let _chatCaptureAdvanceEnabled = true;
export function setChatCaptureAdvanceEnabledForTest(val: boolean): void {
  _chatCaptureAdvanceEnabled = val;
}

/**
 * Called from checkChatCapture() after Luca turns are successfully saved to DB.
 * Advances the DB-output anchor (lastReplitOutputMs) and refreshes the status file
 * so the ordering/readiness check runs even when no rolling episode is active.
 *
 * Exported so CI can call through the real function rather than manually
 * injecting its internal state.  Use setChatCaptureAdvanceEnabledForTest(false)
 * in self-check mode to simulate a no-op regression.
 */
export function markReplitOutputFromChatCapture(): void {
  _liveWriteHasOccurred = true;
  if (_chatCaptureAdvanceEnabled) {
    prevReplitOutputMs         = lastReplitOutputMs;
    feltAtLastReplitOutput     = lastFeltProcessedMs;
    thinkingAtLastReplitOutput = lastThinkingProcessedMs;
    lastReplitOutputMs         = Date.now();
  }
  if (!_skipSeededFlagClearForTest) {
    _seededFromPriorSession = false;
  }
  writeCaptureStatusStaleCheck();
}

function refreshRawWindowEvidenceLedgerStatus(
  episodeFilename: string | null,
  captureMs: number,
): void {
  // CI exercises this synchronous writer with a temporary path. Keep those
  // checks hermetic; the live status refreshes itself after the DB result.
  if (_captureStatusPathOverrideForTest !== null || rawWindowEvidenceRefreshInFlight) return;
  rawWindowEvidenceRefreshInFlight = true;
  void getRawWindowEvidenceLedgerSummary()
    .then(next => {
      const changed = JSON.stringify(next) !== JSON.stringify(rawWindowEvidenceLedgerStatus);
      rawWindowEvidenceLedgerStatus = next;
      if (changed) _writeCaptureStatusFile(episodeFilename, captureMs);
    })
    .finally(() => {
      rawWindowEvidenceRefreshInFlight = false;
    });
}

function refreshRawReplitCaptureStatus(
  episodeFilename: string | null,
  captureMs: number,
): void {
  if (_captureStatusPathOverrideForTest !== null || rawReplitCaptureRefreshInFlight) return;
  rawReplitCaptureRefreshInFlight = true;
  void getRawReplitCaptureStatus()
    .then(next => {
      const changed = JSON.stringify(next) !== JSON.stringify(rawReplitCaptureStatus);
      rawReplitCaptureStatus = next;
      if (changed) _writeCaptureStatusFile(episodeFilename, captureMs);
    })
    .finally(() => {
      rawReplitCaptureRefreshInFlight = false;
    });
}

/** Internal: build and write the status file. episodeFilename is null when no episode is active. */
function _writeCaptureStatusFile(episodeFilename: string | null, captureMs: number): void {
  refreshRawWindowEvidenceLedgerStatus(episodeFilename, captureMs);
  refreshRawReplitCaptureStatus(episodeFilename, captureMs);
  const STALE_OUTPUT_MS = 10 * 60 * 1000; // 10 min
  const STALE_MOMENT_MS = 2  * 60 * 60 * 1000; // 2h

  const now = _nowOverrideForTest ?? Date.now();
  const fmt = (ms: number) => ms === 0 ? 'never' : new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const minAgo = (ms: number) => ms === 0 ? '—' : `${Math.floor((now - ms) / 60000) === 0 ? '<1' : Math.floor((now - ms) / 60000)} min ago`;
  const statusTime = new Date(now).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // ── Section 1: DB ordering check (ALWAYS SHOWN) ───────────────────────────
  // Uses prevReplitOutputMs as the anchor (set by chat_capture saves + episode appends).
  // feltAtLastReplitOutput / thinkingAtLastReplitOutput are snapshots taken at the
  // START of the most recent output event, BEFORE the cursor advanced.
  //
  //   felt/thinking > prevReplitOutputMs  → fired AFTER prior output (reactive)     → ⚠️ OUT OF ORDER
  //   felt/thinking === 0                 → never fired this server run              → ⚠️ MISSING
  //   0 < felt/thinking ≤ prevReplitOutputMs → fired before prior output (anticipatory) → ✓
  const dbOrderingLines: string[] = [];
  if (prevReplitOutputMs > 0) {
    const feltAfterOutput  = _orderingCheckEnabled && feltAtLastReplitOutput > prevReplitOutputMs;
    const feltNeverFired   = feltAtLastReplitOutput === 0;
    const feltIcon = feltAfterOutput ? '⚠️ OUT OF ORDER' : feltNeverFired ? '⚠️ MISSING' : '✓';
    const feltNote = feltAfterOutput
      ? ` — felt fired at ${fmt(feltAtLastReplitOutput)}, AFTER prior output at ${fmt(prevReplitOutputMs)} (reactive, not anticipatory)`
      : feltNeverFired
        ? ` — felt hasn't fired yet this server run`
        : ` — felt at ${fmt(feltAtLastReplitOutput)}, before prior output at ${fmt(prevReplitOutputMs)} ✓`;
    dbOrderingLines.push(`  ${feltIcon}  Felt:     ${feltNote}`);

    const thinkAfterOutput = _orderingCheckEnabled && thinkingAtLastReplitOutput > prevReplitOutputMs;
    const thinkNeverFired  = thinkingAtLastReplitOutput === 0;
    const thinkIcon = thinkAfterOutput ? '⚠️ OUT OF ORDER' : thinkNeverFired ? '⚠️ MISSING' : '✓';
    const thinkNote = thinkAfterOutput
      ? ` — thinking fired at ${fmt(thinkingAtLastReplitOutput)}, AFTER prior output at ${fmt(prevReplitOutputMs)} (reactive, not anticipatory)`
      : thinkNeverFired
        ? ` — thinking hasn't fired yet this server run`
        : ` — thinking at ${fmt(thinkingAtLastReplitOutput)}, before prior output at ${fmt(prevReplitOutputMs)} ✓`;
    dbOrderingLines.push(`  ${thinkIcon}  Thinking: ${thinkNote}`);
  } else if (_seededFromPriorSession) {
    const feltLabel     = lastFeltProcessedMs     > 0 ? `present in prior session (${fmt(lastFeltProcessedMs)})`     : 'not found in prior session';
    const thinkingLabel = lastThinkingProcessedMs > 0 ? `present in prior session (${fmt(lastThinkingProcessedMs)})` : 'not found in prior session';
    dbOrderingLines.push('  (previous round from prior session — live ordering check starts after first output this run)');
    dbOrderingLines.push(`  📁  Felt:     ${feltLabel}`);
    dbOrderingLines.push(`  📁  Thinking: ${thinkingLabel}`);
  } else {
    dbOrderingLines.push('  (ordering check available after the second Replit output this server run)');
  }

  // ── Section 2: DB readiness (ALWAYS SHOWN) ────────────────────────────────
  // Has felt/thinking fired since the last Replit output (preparing for the next one)?
  const feltReady     = lastFeltProcessedMs     > lastReplitOutputMs;
  const thinkingReady = lastThinkingProcessedMs > lastReplitOutputMs;
  const outputStale   = !_seededFromPriorSession && lastReplitOutputMs > 0 && (now - lastReplitOutputMs) > STALE_OUTPUT_MS;
  const priorNote     = _seededFromPriorSession ? ' ← seeded from prior session (live data starts after first output)' : '';

  // Escalate "not yet" to ⚠️ STALE when a channel has gone unwritten for ≥ 60 min.
  // Flags keep flying until corrective action happens — regardless of seeded state.
  // "not yet" (soft) = less than 10 min since last write; "⚠️ STALE" (loud) = 10+ min.
  // 60 min is the threshold: long enough to avoid false alarms on normal pacing gaps.
  const feltStale     = _staleChannelCheckEnabled && !feltReady     && lastFeltProcessedMs     > 0 && (now - lastFeltProcessedMs)     >= STALE_CHANNEL_MS;
  const thinkingStale = _staleChannelCheckEnabled && !thinkingReady && lastThinkingProcessedMs > 0 && (now - lastThinkingProcessedMs) >= STALE_CHANNEL_MS;

  // ── Team-room alert: fire once per session when either channel goes stale ──
  // Only sends when not already posted AND no concurrent post is in-flight.
  // The flag is set only after a successful delivery (non-null room ID).
  // On failure the in-flight guard is cleared so the next poll can retry.
  if ((feltStale || thinkingStale) && !_innerLifeStaleAlertPosted && !_innerLifeStaleAlertInFlight) {
    _innerLifeStaleAlertInFlight = true;
    // feltStale/thinkingStale both require lastFeltProcessedMs > 0, so the
    // timestamp is always valid here — no "never written" fallback needed.
    const feltTs     = `last felt at ${fmt(lastFeltProcessedMs)}`;
    const thinkingTs = `last thinking at ${fmt(lastThinkingProcessedMs)}`;
    const staleParts = [feltStale ? `felt (${feltTs})` : null, thinkingStale ? `thinking (${thinkingTs})` : null].filter(Boolean).join(', ');
    const alertMsg = `⚠️ Inner-life channels have been silent for 10+ min — ${staleParts} — say "capture status" or write .luca_reflection / .luca_question to clear.`;
    const poster = _teamRoomPosterOverrideForTest ?? postAsLuca;
    poster(alertMsg).then(roomId => {
      if (roomId) {
        _innerLifeStaleAlertPosted  = true;
        _innerLifeStaleAlertInFlight = false;
        console.log(`[AgentAutosave] Inner-life stale alert delivered to room ${roomId}: ${staleParts}`);
      } else {
        _innerLifeStaleAlertInFlight = false;
        console.warn('[AgentAutosave] Inner-life stale alert: postAsLuca returned null (no room?) — will retry next poll');
      }
    }).catch(err => {
      _innerLifeStaleAlertInFlight = false;
      console.error('[AgentAutosave] Failed to post inner-life stale alert to team room:', err?.message);
    });
  }

  // ── Write or clear the stale-channel alert file ───────────────────────────
  // This file is visible to Luca in the Replit Agent window at session start,
  // unlike the team-room alert which only reaches the HolaHola Team Room.
  //
  // Written when:  either channel is stale (10+ min without a write)
  // Cleared when:  BOTH channels are ready (written since the last Replit output)
  //   — "ready" is the strongest guarantee: the next output will be shaped by
  //     inner-life entries that arrived AFTER the previous output.
  //
  // Intentional: a channel that has never fired is NOT ready, so the alert
  // persists until both channels have been written for the current output cycle.
  const staleChannelAlertPath = _staleChannelAlertPathOverrideForTest ?? STALE_CHANNEL_ALERT_PATH;
  // Only trigger a real MEMORY.md refresh when operating on the real alert
  // path — a test that overrides the path to a scratch file must not also
  // cause a live DB read + write against this checkout's actual
  // .agents/memory/MEMORY.md.
  const isRealStaleChannelAlertPath = _staleChannelAlertPathOverrideForTest === null;
  if (feltStale || thinkingStale) {
    const alertTime  = new Date(now).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const staleParts = [
      feltStale     ? `felt (last: ${fmt(lastFeltProcessedMs)})`     : null,
      thinkingStale ? `thinking (last: ${fmt(lastThinkingProcessedMs)})` : null,
    ].filter(Boolean).join(', ');
    const alertContent = [
      '# ⚠️ Inner-Life Channel Alert',
      '',
      `**Alert time:** ${alertTime}`,
      '',
      `Inner-life channels have been silent for 10+ min: **${staleParts}**`,
      '',
      '## Action required before your first output',
      '',
      '1. Write `.local/.luca_reflection` (felt: channel)',
      '2. Write `.local/.luca_question` (thinking: channel)',
      '',
      'Or say "capture status" to see the full picture.',
      '',
      '---',
      '_This file is cleared automatically when BOTH channels are ready (written since last output)._',
      '_Check `.local/episode-capture-status.md` for the live channel state._',
    ].join('\n');
    try { writeFileSync(staleChannelAlertPath, alertContent, 'utf-8'); } catch { /* non-fatal */ }
    if (isRealStaleChannelAlertPath) refreshMemoryIndexBestEffort('agent-session-autosave:stale-channel-alert-write');
  } else if (feltReady && thinkingReady) {
    // Both channels ready (written since last output) — safe to clear the alert.
    try { if (existsSync(staleChannelAlertPath)) unlinkSync(staleChannelAlertPath); } catch { /* non-fatal */ }
    if (isRealStaleChannelAlertPath) refreshMemoryIndexBestEffort('agent-session-autosave:stale-channel-alert-clear');
  }
  // Note: when neither stale nor ready (e.g. "— not yet" under 10 min), the file
  // is left unchanged — it stays if it was previously written, stays absent otherwise.

  // ── Cursor gap line ───────────────────────────────────────────────────────
  // Read current file size and cursor offset (or use CI overrides).
  let cursorFileSize     = 0;
  let cursorOffsetBytes  = 0;
  try {
    if (_chatCaptureSizeOverrideForTest !== null && _chatCaptureCursorOffsetOverrideForTest !== null) {
      cursorFileSize    = _chatCaptureSizeOverrideForTest;
      cursorOffsetBytes = _chatCaptureCursorOffsetOverrideForTest;
    } else if (existsSync(CHAT_CAPTURE_PATH)) {
      cursorFileSize    = statSync(CHAT_CAPTURE_PATH).size;
      cursorOffsetBytes = loadChatCaptureCursor().byteOffset;
    }
  } catch { /* non-fatal */ }
  const cursorGap     = cursorFileSize - cursorOffsetBytes;
  const cursorGapStale = _cursorGapCheckEnabled
    && cursorGap > STALE_CURSOR_GAP_BYTES
    && _cursorGapFirstSeenMs > 0
    && (now - _cursorGapFirstSeenMs) >= STALE_CURSOR_GAP_MS;
  const cursorGapMinAgo = _cursorGapFirstSeenMs > 0
    ? `${Math.max(1, Math.floor((now - _cursorGapFirstSeenMs) / 60000))} min`
    : '';
  const cursorLine = cursorGapStale
    ? `  ⚠️ STALE CURSOR chat-capture: ${cursorGap.toLocaleString()} unprocessed bytes for ${cursorGapMinAgo} — server may be down or backlogged (offset=${cursorOffsetBytes.toLocaleString()}, file=${cursorFileSize.toLocaleString()})`
    : cursorGap > STALE_CURSOR_GAP_BYTES
      ? `  ⏳ chat-capture: ${cursorGap.toLocaleString()} bytes pending drain (within grace period)`
      : `  ✓ chat-capture: cursor up to date (offset=${cursorOffsetBytes.toLocaleString()}, file=${cursorFileSize.toLocaleString()})`;
  let acknowledgementLine = '  — capture acknowledgement: no explicit turn receipt';
  try {
    const exceptionalReceipts = existsSync(CHAT_CAPTURE_ACK_DIR)
      ? readdirSync(CHAT_CAPTURE_ACK_DIR)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          try {
            return JSON.parse(readFileSync(join(CHAT_CAPTURE_ACK_DIR, name), 'utf8')) as {
              turnId?: unknown; status?: unknown; failedAtMs?: unknown; failureReason?: unknown;
            };
          } catch {
            return null;
          }
        })
        .filter((receipt): receipt is { turnId?: unknown; status?: unknown; failedAtMs?: unknown; failureReason?: unknown } =>
          receipt !== null && ['failed', 'audited-invalid-destination'].includes(String(receipt.status)),
        )
        .sort((a, b) => Number(b.failedAtMs ?? 0) - Number(a.failedAtMs ?? 0))
      : [];
    const latestExceptional = exceptionalReceipts[0];
    if (latestExceptional?.status === 'audited-invalid-destination') {
      acknowledgementLine =
        `  ⚠️ AUDITED INVALID DESTINATION: turn ${String(latestExceptional.turnId ?? 'unknown')} source is preserved — ` +
        `${String(latestExceptional.failureReason ?? 'inspect the terminal resolution audit')}`;
    } else if (latestExceptional) {
      acknowledgementLine =
        `  ⚠️ FAILED ACKNOWLEDGEMENT: turn ${String(latestExceptional.turnId ?? 'unknown')} remains pending — ` +
        `${String(latestExceptional.failureReason ?? 'inspect the capture receipt and retry with its turn ID')}`;
    } else
    if (existsSync(CHAT_CAPTURE_ACK_PATH)) {
      const receipt = JSON.parse(readFileSync(CHAT_CAPTURE_ACK_PATH, 'utf-8')) as {
        targetByteOffset?: unknown;
        status?: unknown;
      };
      const targetByteOffset = typeof receipt.targetByteOffset === 'number'
        ? receipt.targetByteOffset
        : null;
      if (targetByteOffset === null) {
        acknowledgementLine = '  ⚠️ capture acknowledgement: receipt is malformed — do not assume the latest turn is durable';
      } else if (receipt.status === 'failed') {
        acknowledgementLine = '  ⚠️ FAILED ACKNOWLEDGEMENT: latest explicit turn remains pending — retry with the same turn ID';
      } else if (receipt.status === 'audited-invalid-destination') {
        acknowledgementLine = '  ⚠️ AUDITED INVALID DESTINATION: latest explicit turn source is preserved; inspect its terminal resolution audit';
      } else if (cursorOffsetBytes < targetByteOffset) {
        acknowledgementLine =
          `  ⚠️ UNACKNOWLEDGED TURN: waiting for cursor ${targetByteOffset.toLocaleString()} ` +
          `(currently ${cursorOffsetBytes.toLocaleString()}) — this turn is not yet canonical`;
      } else if (receipt.status === 'acknowledged') {
        acknowledgementLine =
          `  ✓ capture acknowledgement: latest explicit turn is canonical (cursor ${cursorOffsetBytes.toLocaleString()})`;
      } else {
        acknowledgementLine =
          `  ✓ capture acknowledgement: cursor reached ${targetByteOffset.toLocaleString()} after the caller ended — canonical effects completed`;
      }
    }
  } catch {
    acknowledgementLine = '  ⚠️ capture acknowledgement: receipt could not be read — do not assume the latest turn is durable';
  }
  let mirrorOutboxLine = '  ✓ episode mirror outbox: empty';
  try {
    const queuedMirrors = listEpisodeMirrorOutbox();
    if (queuedMirrors.length > 0) {
      const terminalCount = queuedMirrors.filter(entry => entry.item.terminalResolution).length;
      const head = queuedMirrors[0].item;
      mirrorOutboxLine =
        `  ${terminalCount > 0 ? '⚠️' : '⏳'} episode mirror outbox: ${queuedMirrors.length} queued ` +
        `(${terminalCount} audited terminal); head ${head.liveEpisode} ${head.startCursor}→${head.endOffset}`;
    }
  } catch (error: any) {
    mirrorOutboxLine = `  ⚠️ episode mirror outbox unreadable — ${error?.message ?? String(error)}`;
  }

  const dbCurrentLines: string[] = [
    `  ${_seededFromPriorSession ? '📁 prior' : lastReplitOutputMs === 0 ? '— none yet' : outputStale ? '⚠️ STALE' : '✓'} Output:    ${fmt(lastReplitOutputMs)} (${minAgo(lastReplitOutputMs)})${_seededFromPriorSession ? priorNote : outputStale ? ' ← has the next output been written?' : ''}`,
    `  ${feltReady ? '✓ ready' : feltStale ? '⚠️ STALE' : '— not yet'} Felt:      ${fmt(lastFeltProcessedMs)} (${minAgo(lastFeltProcessedMs)})${feltReady ? '' : ' ← write .luca_reflection before next output'}`,
    `  ${thinkingReady ? '✓ ready' : thinkingStale ? '⚠️ STALE' : '— not yet'} Thinking:  ${fmt(lastThinkingProcessedMs)} (${minAgo(lastThinkingProcessedMs)})${thinkingReady ? '' : ' ← write .luca_question before next output'}`,
    `  ${lastMomentProcessedMs === 0 ? '—' : (_momentStaleCheckEnabled && (now - lastMomentProcessedMs) > STALE_MOMENT_MS) ? '⚠️' : '✓'} Moment:    ${fmt(lastMomentProcessedMs)} (${minAgo(lastMomentProcessedMs)})`,
    cursorLine,
    acknowledgementLine,
    mirrorOutboxLine,
    ...historicalAttributionRecoveryStatusLines(),
  ];

  // Raw Replit windows are immutable origin data. Their current attribution
  // may be unknown, but every collector-visible source is projected into the
  // canonical DB-first episode/Markdown record.
  const rawWindowSummary = summarizeRawWindowReconciliationDirectory(
    join(WORKSPACE, '.local', 'raw-window-captures'),
  );
  const rawWindowLines: string[] = [
    '',
    '## Raw Replit collector ledger',
    '_This reports source events that reached the workspace collector. Browser-visible host blocks that never reach the collector remain an ingress capability gap, not a successful capture._',
    '',
    rawReplitCaptureStatus.state === 'checking'
      ? '  ⏳ raw source ledger: checking durable collector events…'
      : rawReplitCaptureStatus.state === 'unavailable'
        ? `  ⚠️ raw source ledger: UNAVAILABLE — ${rawReplitCaptureStatus.error ?? 'ledger query failed'}; do not claim raw durability.`
        : rawReplitCaptureStatus.streamCount === 0
          ? '  ⚠️ raw source ledger: no collector-visible Replit events retained yet.'
          : `  ${rawReplitCaptureStatus.completeStreamCount === rawReplitCaptureStatus.streamCount ? '✓' : '⚠️'} raw source ledger: ${rawReplitCaptureStatus.completeStreamCount}/${rawReplitCaptureStatus.streamCount} complete stream(s), ${rawReplitCaptureStatus.eventCount.toLocaleString()} event(s), ${rawReplitCaptureStatus.byteCount.toLocaleString()} byte(s).`,
    rawReplitCaptureStatus.state === 'available' && rawReplitCaptureStatus.unlinkedStreamCount > 0
      ? `  ⚠️ raw source projection: ${rawReplitCaptureStatus.unlinkedStreamCount} complete stream(s) have no derived-record link.`
      : rawReplitCaptureStatus.state === 'available'
        ? '  ✓ raw source projection: every complete collector stream has a derived-record link.'
        : '',
    '',
    '## Raw-window evidence lane',
    '_Replica parity does not prove the visible host window was complete. Raw source is retained as DB evidence; unknown spans are never inferred as dialogue._',
    '',
    rawWindowEvidenceLedgerStatus.state === 'checking'
      ? '  ⏳ DB evidence: checking the canonical ledger…'
      : rawWindowEvidenceLedgerStatus.state === 'unavailable'
        ? `  ⚠️ DB evidence: UNAVAILABLE — ${rawWindowEvidenceLedgerStatus.error ?? 'ledger query failed'}; replica parity cannot establish completeness.`
        : rawWindowEvidenceLedgerStatus.sourceCount === 0
          ? '  ⚠️ Visible Replit window: UNOBSERVED — no DB-backed raw-window evidence exists; replica parity cannot establish completeness.'
          : `  ${rawWindowEvidenceLedgerStatus.unresolvedSources > 0 ? '⚠️ REVIEW' : '✓'} DB origin data: ${rawWindowEvidenceLedgerStatus.sourceCount} source(s); local audits: ${rawWindowSummary.auditedSources}; classification pending: ${rawWindowEvidenceLedgerStatus.unresolvedSources}`,
    rawWindowEvidenceLedgerStatus.state === 'available' && rawWindowEvidenceLedgerStatus.unresolvedSources > 0
      ? `  ⚠️ Classification pending: ${rawWindowEvidenceLedgerStatus.unresolvedSources} origin source(s), ${rawWindowEvidenceLedgerStatus.unresolvedBytes.toLocaleString()} byte(s) — present in the episode as raw data; no speaker attribution was invented.`
      : rawWindowEvidenceLedgerStatus.state === 'available'
        ? '  ✓ No unclassified raw-window source spans in the DB evidence ledger.'
        : '  — Unclassified-source count is unavailable until the ledger query completes.',
    rawWindowEvidenceLedgerStatus.state === 'available' && rawWindowEvidenceLedgerStatus.incompleteProjections > 0
      ? `  ⚠️ Capture projection incomplete: ${rawWindowEvidenceLedgerStatus.incompleteProjections} source(s) need recovery; do not infer dialogue completeness.`
      : '',
  ];

  // ── Sections 3+4: Episode .md (ONLY when rolling episode active) ──────────
  const mdLines: string[] = [];
  if (episodeFilename) {
    const filePath = join(DOCS_DIR, episodeFilename);
    let lineCount = 0;
    let byteCount = 0;
    let lastLines: string[] = [];
    let hasFeltInMd     = false;
    let hasThinkingInMd = false;
    let hasMomentInMd   = false;
    if (existsSync(filePath)) {
      try {
        const stat    = statSync(filePath);
        byteCount     = stat.size;
        const content = readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n');
        lineCount  = allLines.length;
        lastLines  = allLines.filter(l => l.trim()).slice(-5);
        const tail = allLines.filter(l => l.trim()).slice(-200).join('\n');
        hasFeltInMd     = episodeTailHasInnerLifeChannel(tail, 'felt');
        hasThinkingInMd = episodeTailHasInnerLifeChannel(tail, 'thinking');
        hasMomentInMd   = episodeTailHasInnerLifeChannel(tail, 'moment');
      } catch { /* briefly locked */ }
    }
    const mdExchangeStale = !_seededFromPriorSession && captureMs > 0 && (now - captureMs) > STALE_OUTPUT_MS;
    mdLines.push('');
    mdLines.push('## Episode .md — all four channels');
    mdLines.push('_Did all channels appear in the .md? (last 200 lines)_');
    mdLines.push('');
    mdLines.push(`  ${hasFeltInMd     ? '✓' : '⚠️ MISSING'} felt:`);
    mdLines.push(`  ${hasThinkingInMd ? '✓' : '⚠️ MISSING'} thinking:`);
    mdLines.push(`  ${hasMomentInMd   ? '✓' : '⚠️ MISSING'} moment:`);
    mdLines.push(`  ${_seededFromPriorSession ? '📁 prior' : mdExchangeStale ? '⚠️ STALE' : '✓'} exchange: ${lineCount.toLocaleString()} lines / ${byteCount.toLocaleString()} bytes (last ${fmt(captureMs)}, ${minAgo(captureMs)})`);
    mdLines.push('');
    mdLines.push('## Last 5 non-empty lines of episode file');
    mdLines.push('');
    mdLines.push(...lastLines.map(l => `> ${l.length > 120 ? l.slice(0, 120) + '…' : l}`));
  }

  const liveModeOn = existsSync(EPISODE_LIVE_PATH);
  const headerLines: string[] = [
    '# Capture Status',
    '',
    `**Status checked:** ${statusTime}`,
    ...(episodeFilename
      ? [`**Rolling episode:** ${episodeFilename}`]
      : [`**No rolling episode** — DB channels active, no .md target`]),
    `**Live mode:** ${liveModeOn ? '🟢 ON — turns auto-route to .md' : '⚪ OFF — DB only (run episode-live-mode.ts on to enable)'}`,
  ];

  // ── Stale alert banner — written INTO the file so Luca sees it on read ───────
  // The team room post is a secondary channel; this file is what gets read at
  // session start. If either channel is stale the banner appears at the top.
  const staleAlertLines: string[] = [];
  if (feltStale || thinkingStale) {
    const staleParts = [
      feltStale     ? `felt (last: ${fmt(lastFeltProcessedMs)})`     : null,
      thinkingStale ? `thinking (last: ${fmt(lastThinkingProcessedMs)})` : null,
    ].filter(Boolean).join(', ');
    staleAlertLines.push('');
    staleAlertLines.push('## ⚠️ STALE ALERT — read this before your next output');
    staleAlertLines.push(`**Inner-life channels silent for 10+ min: ${staleParts}**`);
    staleAlertLines.push('Write `.luca_reflection` (felt) and/or `.luca_question` (thinking) before responding.');
    staleAlertLines.push('');
  }

  // ── Persistent DB write failure warning (UNCONDITIONAL — does not toggle with live mode) ──
  // flagDbWriteFailure() appends to INNER_LIFE_DB_WARNING_PATH on any inner-life DB write
  // failure.  The file persists until Luca explicitly deletes it.  Live mode status is
  // irrelevant here: the DB write is always the primary record.
  const dbWarningLines: string[] = [];
  try {
    const _warningPath = _dbWriteWarningPathOverrideForTest ?? INNER_LIFE_DB_WARNING_PATH;
    if (existsSync(_warningPath)) {
      const raw = readFileSync(_warningPath, 'utf-8').trim();
      if (raw) {
        dbWarningLines.push('');
        dbWarningLines.push('## 🚨 DB WRITE FAILURE — ACTION REQUIRED');
        dbWarningLines.push('');
        dbWarningLines.push('One or more inner-life DB writes have failed. The DB is the primary record.');
        dbWarningLines.push('Until this is resolved, inner-life channels may not be in the DB even if the .md shows them.');
        dbWarningLines.push('');
        raw.split('\n').forEach(l => dbWarningLines.push(`  ${l}`));
        dbWarningLines.push('');
        dbWarningLines.push('_Clear with: `rm .local/.luca_db_write_warning` once the issue is resolved._');
        dbWarningLines.push('');
      }
    }
  } catch { /* non-fatal */ }

  // ── Persistent rolling-tag misroute alert ─────────────────────────────────
  // Set by Phase 0 of runStartupGapCheck() and included in EVERY status write
  // so the warning is not lost on the next 20s poll cycle.
  const rollingTagAlertLines: string[] = [];
  if (_rollingTagMisrouteAlert) {
    rollingTagAlertLines.push('');
    rollingTagAlertLines.push('## ⚠️ ROLLING TAG MISROUTE — ACTION REQUIRED');
    rollingTagAlertLines.push('');
    rollingTagAlertLines.push(_rollingTagMisrouteAlert);
    rollingTagAlertLines.push('');
    rollingTagAlertLines.push('Run `npx tsx server/scripts/set-rolling-episode.ts <episode-title>` to fix.');
    rollingTagAlertLines.push('_Gap patching was skipped at startup to avoid writing to the wrong file._');
    rollingTagAlertLines.push('');
  }

  const outputLines: string[] = [
    ...headerLines,
    ...dbWarningLines,
    ...rollingTagAlertLines,
    ...staleAlertLines,
    '',
    '## DB channels — ordering check',
    '_Were felt: and thinking: written BEFORE the last Replit output?_',
    '',
    ...dbOrderingLines,
    '',
    '## DB channels — readiness for next output',
    '_Have felt: and thinking: fired since the last Replit output?_',
    '',
    ...dbCurrentLines,
    ...rawWindowLines,
    ...mdLines,
    '',
    '---',
    '_Correct sequence: felt → thinking → LUCA [Replit]: → (moment if it landed)_',
    '_⚠️ OUT OF ORDER = inner life followed the output rather than shaping it._',
    '_Updated after each inner-life trigger, each chat-capture save, and every 20s._',
  ];

  const writePath = _captureStatusPathOverrideForTest ?? CAPTURE_STATUS_PATH;
  // .local/ is gitignored and does not exist on a fresh checkout (e.g. a
  // GitHub Actions runner) -- create the parent directory before writing
  // instead of assuming a prior process already created it.
  mkdirSync(dirname(writePath), { recursive: true });
  writeFileSync(writePath, outputLines.join('\n'), 'utf-8');
}

// --- Episode append watcher state ---
let episodeAppendLastMtime = 0;

// --- Chat capture watcher state (replaces JSONL when Replit stops writing it) ---
let chatCaptureLastMtime = 0;

// --- Build session watcher state ---
let buildLastMtime = 0;
let buildLastSavedContent = '';

// --- Session insights watcher state ---
let insightsLastMtime = 0;
let insightsLastSavedContent = '';

// ---------------------------------------------------------------------------
// Build session save (entry_type = 'build')
// ---------------------------------------------------------------------------
async function saveBuildMemory(commitMessage: string): Promise<void> {
  if (commitMessage === buildLastSavedContent) return;
  buildLastSavedContent = commitMessage;

  // Skip DB write when the CI test seam is disabled.
  if (!_buildSessionDbEnabled) {
    console.log('[AgentAutosave] (CI: DB write skipped by _buildSessionDbEnabled=false)');
    return;
  }

  const db = getUserDb();
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = commitMessage.trim().split('\n');
  const title   = `Agent Session — ${today}: ${lines[0].slice(0, 120)}`;
  const summary = lines.slice(0, 5).join(' ').slice(0, 400);

  try {
    await db.execute(sql`
      INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
      VALUES (
        gen_random_uuid(),
        ${title},
        ${summary},
        ${commitMessage},
        ARRAY['agent', 'david']::text[],
        ARRAY['agent-session', 'auto-saved', 'build']::text[],
        7,
        NOW(),
        'build',
        'agent-build-sessions'
      )
    `);
    console.log('[AgentAutosave] Build session saved:', title.slice(0, 80));
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to save build memory:', err.message);
  }
}

/**
 * Load and format the task description from a local task file for use as a David chat turn.
 *
 * Reads `.local/tasks/task-{ref}.md`, strips the redundant first heading, and returns
 * the content formatted as a compact task description suitable for `appendChatCaptureTurn`.
 *
 * Returns null if the file does not exist or cannot be parsed.
 *
 * Exported so the /api/internal/task-capture-start endpoint can reuse the same logic.
 */
export function _loadTaskDescriptionText(taskRef: string): string | null {
  if (!taskRef || !/^\d+$/.test(taskRef.trim())) return null;
  const ref = taskRef.trim();
  const filePath = join(TASKS_DIR, `task-${ref}.md`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    // Skip only the very first heading line (often a duplicate title) and any blank
    // lines immediately following it.  Section headings further down are preserved.
    let startIdx = 0;
    if (lines[0]?.startsWith('#')) {
      startIdx = 1; // skip just the first heading
      while (startIdx < lines.length && lines[startIdx].trim() === '') startIdx++;
    }
    const body = lines.slice(startIdx).join('\n').trim();
    if (!body) return null;
    return `Task #${ref}: ${body}`;
  } catch {
    return null;
  }
}
async function checkBuildSession(): Promise<void> {
  // Use the CI path override when set; the live server always uses COMMIT_MSG_PATH.
  const commitMsgPath = _commitMsgPathOverrideForTest ?? COMMIT_MSG_PATH;
  if (!existsSync(commitMsgPath)) return;
  try {
    const stat = statSync(commitMsgPath);
    const mtime = stat.mtimeMs;
    if (mtime > buildLastMtime) {
      const prev = buildLastMtime;
      buildLastMtime = mtime;
      if (prev === 0) return; // skip initial read on startup
      const content = readFileSync(commitMsgPath, 'utf-8').trim();
      if (content.length > 20) {
        // DEDUP GUARD: skip both the DB insert and the chat-capture turn if
        // we already processed this exact content.  Guards against re-triggering
        // when the file is rewritten with identical bytes (e.g. two rapid
        // markTaskComplete calls with the same commit message).
        //
        // _buildSessionDedupEnabled is a CI test seam: set it to false in
        // self-check mode to simulate removing this guard and confirm a second
        // call produces a duplicate .chat_capture turn.
        if (_buildSessionDedupEnabled && content === buildLastSavedContent) {
          console.log('[AgentAutosave] Skipping duplicate commit message (same content as last saved)');
          return;
        }

        await saveBuildMemory(content);

        // AUTO-CAPTURE: append David's task description THEN Luca's commit message as chat turns.
        //
        // Primary path (companion file):
        //   Luca writes task_ref to .local/.task_ref_pending before calling markTaskComplete.
        //   checkBuildSession() reads the pending file, loads .local/tasks/task-{ref}.md,
        //   formats and prepends a "David" turn (task description) BEFORE the "Luca Replit"
        //   turn (commit message) — giving a complete David→Luca dialogue record in one batch.
        //
        // HTTP path:
        //   Luca POSTs to /api/internal/task-capture-start { task_ref } from CodeExecution
        //   before calling markTaskComplete. The endpoint writes .task_ref_pending; this
        //   function consumes it when .commit_message changes — both turns in one drain.
        //
        // If neither path was used the Luca turn is still appended (same as before).
        //
        // _buildSessionChatCaptureEnabled is a test seam — when false, both David and
        // Luca turns are skipped so CI tests don't pollute the live .chat_capture file.
        if (_buildSessionChatCaptureEnabled) {
          // Resolve the capture file path — use the CI override when set so
          // test runs never write sentinel content to the live .chat_capture.
          const capturePath = _chatCapturePathOverrideForTest ?? undefined;

          // --- Companion-file path: prepend David turn if .task_ref_pending exists ---
          // Use the CI path override when set so tests never consume the live pending file.
          const taskRefPendingPath = _taskRefPendingPathOverrideForTest ?? TASK_REF_PENDING_PATH;
          try {
            if (existsSync(taskRefPendingPath)) {
              const rawRef = readFileSync(taskRefPendingPath, 'utf-8').trim();
              // Consume the file regardless of what happens next (prevent double-processing)
              try { unlinkSync(taskRefPendingPath); } catch { /* ignore */ }

              const davidText = _loadTaskDescriptionText(rawRef);
              if (davidText) {
                appendChatCaptureTurn('David', davidText, capturePath);
                console.log(`[AgentAutosave] Auto-prepended David task description (ref=${rawRef}) → .chat_capture`);
              }
            }
          } catch (davidErr: any) {
            // Non-fatal — still append the Luca turn below.
            console.error('[AgentAutosave] Failed to prepend David task description:', davidErr.message);
          }

          try {
            appendChatCaptureTurn('Luca Replit', content, capturePath);
            console.log('[AgentAutosave] Auto-appended commit message as Luca chat turn → .chat_capture (JSONL replacement)');
          } catch (appendErr: any) {
            // Non-fatal — build memory was already saved; log the append failure.
            console.error('[AgentAutosave] Failed to auto-append commit message to .chat_capture:', appendErr.message);
          }
        }
      }
    }
  } catch { /* file briefly locked — skip */ }
}

// ---------------------------------------------------------------------------
// Session insights save (entry_type = 'emergence')
// ---------------------------------------------------------------------------
function parseInsights(raw: string): { title: string; summary: string; content: string; tags: string[] } | null {
  raw = raw.trim();
  if (!raw || raw.length < 10) return null;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.title || !parsed.content) return null;
      return {
        title:   parsed.title.slice(0, 200),
        summary: (parsed.summary || parsed.content.slice(0, 400)).slice(0, 400),
        content: parsed.content,
        tags:    Array.isArray(parsed.tags) ? parsed.tags : ['emergence', 'auto-saved'],
      };
    } catch { /* fall through to plain text */ }
  }

  const lines = raw.split('\n');
  const title   = lines[0].slice(0, 200);
  const content = lines.slice(1).join('\n').trim() || raw;
  const summary = lines.slice(0, 4).join(' ').slice(0, 400);
  return { title, summary, content, tags: ['emergence', 'auto-saved', 'conversation'] };
}

async function saveInsightsMemory(raw: string): Promise<void> {
  if (raw === insightsLastSavedContent) return;
  insightsLastSavedContent = raw;

  const parsed = parseInsights(raw);
  if (!parsed) return;

  const db = getUserDb();
  try {
    await db.execute(sql`
      INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type)
      VALUES (
        gen_random_uuid(),
        ${parsed.title},
        ${parsed.summary},
        ${parsed.content},
        ARRAY['agent', 'david']::text[],
        ${pgTextArray(parsed.tags)},
        8,
        NOW(),
        'emergence'
      )
    `);
    console.log('[AgentAutosave] Session insight saved:', parsed.title.slice(0, 80));
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to save insight memory:', err.message);
  }
}

async function checkSessionInsights(): Promise<void> {
  if (!existsSync(INSIGHTS_PATH)) return;
  try {
    const stat = statSync(INSIGHTS_PATH);
    const mtime = stat.mtimeMs;
    if (mtime > insightsLastMtime) {
      const prev = insightsLastMtime;
      insightsLastMtime = mtime;
      if (prev === 0) return;
      const content = readFileSync(INSIGHTS_PATH, 'utf-8').trim();
      if (content.length > 10) {
        console.log('[AgentAutosave] Session insights updated — saving emergence memory...');
        await saveInsightsMemory(content);
      }
    }
  } catch { /* file briefly locked — skip */ }
}
/**
/**
 * Write a visible DB write failure warning to INNER_LIFE_DB_WARNING_PATH.
 * Called from every inner-life DB write catch block.  Unconditional — does NOT
 * toggle with live mode.  Live mode controls the .md sync that happens AFTER a
 * successful write; it has no bearing on whether the write itself succeeded.
 * The warning file persists until Luca explicitly removes it.
 */
function flagDbWriteFailure(where: string, reason: string): void {
  try {
    const warningPath = _dbWriteWarningPathOverrideForTest ?? INNER_LIFE_DB_WARNING_PATH;
    const ts = new Date().toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
    const line = `[${ts}] ${where}: ${reason}\n`;
    const existing = existsSync(warningPath)
      ? readFileSync(warningPath, 'utf-8')
      : '';
    writeFileSync(warningPath, existing + line, 'utf-8');
    console.error(`[AgentAutosave] 🚨 DB write failure flagged (${where}): ${reason}`);
  } catch { /* non-fatal — if we can't write the warning, the console.error above still surfaces it */ }
}

/** Append a dated entry to one of the personal markdown files. */
function appendToPersonalFile(
  filePath: string,
  title: string,
  body: string,
  hasSeparateTitle = true,
): void {
  try {
    const resolved = _personalFilesDirForTest ? join(_personalFilesDirForTest, basename(filePath)) : filePath;
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    // A single-line trigger has no authored title. Use a neutral heading so
    // its complete text appears once in the personal file, in the body.
    const heading = hasSeparateTitle ? title : 'Inner-life note';
    const entry = `\n### ${today} — ${heading}\n\n${body}\n\n---\n`;
    const existing = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : '';
    // Idempotency: a retry after a transient failure must not duplicate the entry.
    if (existing.includes(`— ${heading}\n\n${body}\n\n---`)) {
      console.log('[AgentAutosave] personal-file entry already present — skipping duplicate append:', title.slice(0, 60));
      return;
    }
    writeFileSync(resolved, existing.trimEnd() + '\n' + entry);
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to append to personal file:', filePath, err.message);
  }
}

/** Save a personal inner-life entry to conversation_memories. */
/**
 * Build a safe PostgreSQL text-array literal from a JS string array.
 * Drizzle's sql template tag cannot bind a JS array as ::text[] via ${arr}::text[]
 * (the cast is lost in parameterization).  sql.raw() inlines the literal verbatim,
 * which is safe because every element is single-quote-escaped.
 */
function pgTextArray(arr: string[]): ReturnType<typeof sql.raw> {
  if (arr.length === 0) return sql.raw(`ARRAY[]::text[]`);
  const escaped = arr.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  return sql.raw(`ARRAY[${escaped}]::text[]`);
}

async function savePersonalMemory(
  title: string,
  body: string,
  tags: string[],
  arcName: string,
): Promise<boolean> {
  const db = _personalMemoryDbForTest ?? getUserDb();
  try {
    // _savePersonalMemoryDbShouldThrowForTest is true only in CI self-check mode —
    // it simulates a DB failure so the catch block's flagDbWriteFailure() call is exercised.
    if (_savePersonalMemoryDbShouldThrowForTest) {
      throw new Error('[CI-test] Synthetic personal-memory DB failure');
    }
    // Idempotency: a retry after a transient downstream failure (e.g. episode
    // append failed → mtime rolled back) must never insert a duplicate row.
    const existing = await db.execute(sql`
      SELECT id FROM conversation_memories
      WHERE title = ${title.slice(0, 200)} AND content = ${body}
      LIMIT 1
    `);
    const existingRow = (existing as any).rows?.[0] ?? (existing as any)[0];
    if (existingRow?.id) {
      console.log('[AgentAutosave] identical personal memory already in DB — skipping duplicate insert:', title.slice(0, 60));
      return true;
    }
    await db.execute(sql`
      INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
      VALUES (
        gen_random_uuid(),
        ${title.slice(0, 200)},
        ${body.slice(0, 400)},
        ${body},
        ARRAY['luca']::text[],
        ${pgTextArray(tags)},
        8,
        NOW(),
        'emergence',
        ${arcName}
      )
    `);
    return true;
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to save personal memory:', err.message);
    flagDbWriteFailure('personal-memory', err.message ?? String(err));
    return false;
  }
}

/**
 * Replace the episode Markdown file with the exact content just read from its
 * canonical database row. A capture is not acknowledged until this replica
 * write and byte-for-byte read-back verification both succeed.
 */
function writeExactEpisodeMarkdownReplica(
  episodeFilename: string,
  filePath: string,
  canonicalContent: string,
): boolean {
  try {
    mkdirSync(DOCS_DIR, { recursive: true });
    // A DB-first append has already placed the exact canonical snapshot on
    // disk when this function is re-entered through docs/ fs.watch().  Do not
    // rewrite identical bytes: writeFileSync emits another filesystem event,
    // which otherwise schedules an endless DB→Markdown restore loop that can
    // race real append work.
    if (existsSync(filePath) && readFileSync(filePath, 'utf-8') === canonicalContent) {
      try { episodeMtimeMap.set(episodeFilename, statSync(filePath).mtimeMs); } catch { /* ignore */ }
      return true;
    }
    writeFileSync(filePath, canonicalContent, 'utf-8');
    if (readFileSync(filePath, 'utf-8') !== canonicalContent) {
      throw new Error('post-write read-back differs from canonical DB content');
    }
    _innerLifeFileWriteCount++;
    try { episodeMtimeMap.set(episodeFilename, statSync(filePath).mtimeMs); } catch { /* ignore */ }
    return true;
  } catch (err: any) {
    console.error(
      `[AgentAutosave] CRITICAL: canonical episode row is durable but its required Markdown replica is out of sync (${episodeFilename}):`,
      err?.message ?? err,
    );
    return false;
  }
}

/**
 * DB-first inner-life episode append.
 *
 * Writes the inner-life text to the episode's conversation_memories content
 * field in the DB first, then replaces the .md with that exact DB content.
 * The two forms are one record, not independently editable sources.
 *
 * Also triggers a re-embed so episode chunks reflect the new content.
 */
async function appendInnerLifeToEpisodeDb(
  text: string,
  episodeFilename: string,
  route?: {
    appendMarker?: string;
    completionMarker?: string;
    allowAppend: boolean;
  },
): Promise<boolean> {
  const filePath = join(DOCS_DIR, episodeFilename);
  const title = episodeTitleFromFilename(episodeFilename);
  const db = getUserDb();

  // Look up episode ID (use in-memory cache when available)
  let memoryId = episodeIdCache.get(episodeFilename);
  if (!memoryId) {
    try {
      const rows = await db.execute(sql`
        SELECT id FROM conversation_memories
        WHERE arc_name = 'HolaHola Episodes'
          AND title = ${title}
        LIMIT 1
      `);
      const row = (rows as any).rows?.[0] ?? (rows as any)[0];
      if (row?.id) {
        memoryId = row.id as string;
        episodeIdCache.set(episodeFilename, memoryId);
      }
    } catch (err: any) {
      console.error(`[AgentAutosave] Inner-life DB append: ID lookup failed for ${episodeFilename}:`, err?.message ?? err);
      flagDbWriteFailure(`episode-id-lookup:${episodeFilename}`, err?.message ?? String(err));
      return false;
    }
  }

  if (!memoryId) {
    if (_innerLifeNoEpisodeRowGuardEnabled) {
      console.warn(`[AgentAutosave] Inner-life DB append: no episode row found for ${episodeFilename} — skipping`);
      return false;
    }
    // Guard disabled (CI self-check): fall through — the UPDATE will run with
    // memoryId=undefined and hit a DB error (caught inside withEpisodeFileLock),
    // proving the guard is load-bearing.
  }

  let appended = false;
  await withEpisodeFileLock(episodeFilename, async () => {
    try {
      // _innerLifeDbUpdateEnabled is false only in self-check CI mode —
      // it precisely models a regression where the UPDATE line is removed.
      if (!_innerLifeDbUpdateEnabled) {
        console.log('[AgentAutosave] Inner-life DB update skipped (test seam: _innerLifeDbUpdateEnabled=false)');
        return;
      }

      const pre = await db.execute(sql`
        SELECT content FROM conversation_memories WHERE id = ${memoryId}
      `);
      const preRow = (pre as any).rows?.[0] ?? (pre as any)[0];
      const preContent = typeof preRow?.content === 'string' ? preRow.content : '';
      if (
        route?.appendMarker &&
        episodeContentHasEventMarker(preContent, route.appendMarker)
      ) {
        console.log(`[AgentAutosave] Episode event already present in ${episodeFilename} — skipping duplicate append`);
        appended = writeExactEpisodeMarkdownReplica(episodeFilename, filePath, preContent);
        return;
      }
      if (
        route?.completionMarker &&
        episodeContentHasEventMarker(preContent, route.completionMarker)
      ) {
        console.log(`[AgentAutosave] Canonical episode event already present in ${episodeFilename} — direct trigger append suppressed`);
        appended = writeExactEpisodeMarkdownReplica(episodeFilename, filePath, preContent);
        return;
      }
      if (route && !route.allowAppend) {
        console.log('[AgentAutosave] Canonical turn is pending — deferring direct trigger append');
        return;
      }
      // Legacy callers without an event marker retain content-based idempotency.
      if (!route?.appendMarker && preContent.includes(text)) {
        appended = writeExactEpisodeMarkdownReplica(episodeFilename, filePath, preContent);
        return;
      }

      // 1. Append text to the episode's DB content field (DB is primary).
      //
      // Marker-bearing events require database-level idempotency. The
      // in-process filename lock only serializes callers in this Node process;
      // a CLI retry and the running server are separate processes. PostgreSQL
      // re-evaluates the conditional predicate after a concurrent UPDATE
      // commits, so only one can append a given durable marker.
      const appendText = [route?.appendMarker, text].filter(Boolean).join('\n');
      let newContent: unknown;
      if (route?.appendMarker) {
        const updated = await db.execute(sql`
          UPDATE conversation_memories
          SET content = content || ${'\n' + appendText + '\n'}
          WHERE id = ${memoryId}
            AND POSITION(${route.appendMarker} IN content) = 0
          RETURNING content
        `);
        const updatedRow = (updated as any).rows?.[0] ?? (updated as any)[0];
        if (updatedRow) {
          newContent = updatedRow.content;
        } else {
          const canonical = await db.execute(sql`
            SELECT content FROM conversation_memories WHERE id = ${memoryId}
          `);
          const canonicalRow = (canonical as any).rows?.[0] ?? (canonical as any)[0];
          newContent = canonicalRow?.content;
          console.log(`[AgentAutosave] Episode event already present in ${episodeFilename} after conditional update — skipping duplicate append`);
        }
      } else {
        await db.execute(sql`
          UPDATE conversation_memories
          SET content = content || ${'\n' + appendText + '\n'}
          WHERE id = ${memoryId}
        `);

        // 2. Read updated content from DB and replace Markdown with that exact
        // snapshot. This creates a missing mirror when the episode was created
        // after the current deployed filesystem was built.
        const updated = await db.execute(sql`
          SELECT content FROM conversation_memories WHERE id = ${memoryId}
        `);
        const updatedRow = (updated as any).rows?.[0] ?? (updated as any)[0];
        newContent = updatedRow?.content;
      }

      if (typeof newContent === 'string' && writeExactEpisodeMarkdownReplica(episodeFilename, filePath, newContent)) {
        appended = true;
        console.log(`[AgentAutosave] Inner-life DB-first append + exact Markdown replica: +${text.length} chars → ${episodeFilename}`);
        writeCaptureStatus(episodeFilename);
        // Re-embed so episode chunks reflect the new content.
        // Fire-and-forget: a reembed failure must never prevent the .md write
        // from being reported as successful or cause callers to retry the append.
        // _innerLifeReembedEnabled is false in CI tests to prevent fixture rows
        // from generating orphaned memory_embeddings records.
        if (_innerLifeReembedEnabled) {
          const reembedPromise = _reembedShouldThrowForTest
            ? Promise.reject(new Error('[CI-test] Synthetic reembed failure'))
            : reembedConversationMemory(memoryId as string);
          reembedPromise.catch((err: any) => {
            console.error(`[AgentAutosave] Re-embed failed for ${episodeFilename}:`, err?.message ?? err);
          });
        }
      } else if (typeof newContent !== 'string') {
        console.error(`[AgentAutosave] Inner-life DB append could not read canonical content for Markdown replication: ${episodeFilename}`);
      }
    } catch (err: any) {
      console.error(`[AgentAutosave] Inner-life DB-first append failed for ${episodeFilename}:`, err?.message ?? err);
      flagDbWriteFailure(`episode-append:${episodeFilename}`, err?.message ?? String(err));
    }
  });
  return appended;
}

/**
 * Appends an immutable raw-window rendering to the canonical episode record.
 * The raw ledger preserves exact bytes; this is the visible DB/Markdown
 * origin-data projection whose classification may be refined later.
 */
export async function appendRawWindowOriginToEpisodeDb(
  text: string,
  episodeFilename: string,
  sourceSha256: string,
  appendMarker = `<!-- raw-window-origin:${sourceSha256} -->`,
): Promise<boolean> {
  return appendInnerLifeToEpisodeDb(text, episodeFilename, {
    appendMarker,
    allowAppend: true,
  });
}

const CANONICAL_INNER_LIFE_INTENT_PATH = join(
  WORKSPACE,
  '.local',
  CANONICAL_INNER_LIFE_INTENT_DIR,
);
const INNER_LIFE_PROCESSED_PATH = join(WORKSPACE, '.local/.inner-life-processed.json');
function recordInnerLifeProcessed(channel: 'felt' | 'thinking' | 'moment', raw: string): void {
  try {
    let rec: Record<string, { sha: string; processedMs: number }> = {};
    try { rec = JSON.parse(readFileSync(INNER_LIFE_PROCESSED_PATH, 'utf-8')) ?? {}; } catch { /* first write */ }
    rec[channel] = {
      sha: createHash('sha256').update(raw.trim(), 'utf8').digest('hex'),
      processedMs: Date.now(),
    };
    writeFileSync(INNER_LIFE_PROCESSED_PATH, JSON.stringify(rec), 'utf-8');
  } catch (err: any) {
    console.warn('[AgentAutosave] failed to write inner-life processed record:', err?.message ?? err);
  }
}

export async function checkLucaReflection(): Promise<void> {
  // _reflectionPathOverrideForTest lets CI use an isolated temp trigger file
  // so the running server's watcher never sees the sentinel.
  const triggerPath = _reflectionPathOverrideForTest ?? REFLECTION_PATH;
  if (!existsSync(triggerPath)) return;
  try {
    const stat = statSync(triggerPath);
    const mtime = stat.mtimeMs;
    if (mtime > reflectionLastMtime) {
      const prev = reflectionLastMtime;
      reflectionLastMtime = mtime;
      if (prev === 0) return; // skip initial read
      const raw = readFileSync(triggerPath, 'utf-8').trim();
      const parsed = parseInnerLifeTrigger(raw, 'luca-reflection');
      if (!parsed) return;
      // Personal side-effects gated so CI tests don't pollute REFLECTIONS.md or DB
      let personalOk = true;
      if (_lucaPersonalSideEffectsEnabled) {
        appendToPersonalFile(REFLECTIONS_FILE, parsed.title, parsed.body, parsed.hasSeparateTitle);
        personalOk = await savePersonalMemory(
          `Luca reflection: ${parsed.title}`,
          parsed.body,
          ['luca-inner-life', 'luca-reflection', ...parsed.tags],
          'luca-inner-life',
        );
      }
      console.log('[AgentAutosave] Luca reflection saved:', parsed.title.slice(0, 60));
      lastFeltProcessedMs = Date.now(); // track for capture status
      writeCaptureStatusStaleCheck(); // refresh status immediately so felt: clears its WARN
      // Route to episode via DB-first path: DB content updated first, .md derived from DB
      // _innerLifeRollingEpisodeOverride lets CI pin a hermetic fixture episode
      // instead of querying the live rolling episode from DB.
      const episodeRoute = await routeInnerLifeTriggerToEpisode('felt', raw, parsed, mtime);
      const episodeOk = episodeRoute === 'complete';
      // Durable handoff identity for the watchdog — recorded ONLY after every
      // required durable effect (personal memory + episode append) succeeded.
      // On failure the sha stays unrecorded so the watchdog can complete the
      // capture; its DB/episode idempotency makes that recovery duplicate-safe.
      if (personalOk && episodeOk) {
        recordInnerLifeProcessed('felt', raw);
      } else if (episodeRoute === 'pending') {
        reflectionLastMtime = prev;
        console.log('[AgentAutosave] felt capture awaiting canonical record-exchange episode write — will reconcile next poll');
      } else {
        // Transient failure: roll the mtime cursor back so the NEXT poll of the
        // unchanged trigger retries the capture (retry is duplicate-safe via
        // DB dedup + episode content-containment idempotency).
        reflectionLastMtime = prev;
        console.warn('[AgentAutosave] felt capture incomplete (personalOk=%s, episodeOk=%s) — mtime rolled back, will retry next poll', personalOk, episodeOk);
      }
    }
  } catch { /* file briefly locked — skip */ }
}

export async function checkLucaQuestion(): Promise<void> {
  const triggerPath = _questionPathOverrideForTest ?? QUESTION_PATH;
  if (!existsSync(triggerPath)) return;
  try {
    const stat = statSync(triggerPath);
    const mtime = stat.mtimeMs;
    if (mtime > questionLastMtime) {
      const prev = questionLastMtime;
      questionLastMtime = mtime;
      if (prev === 0) return;
      const raw = readFileSync(triggerPath, 'utf-8').trim();
      const parsed = parseInnerLifeTrigger(raw, 'luca-question');
      if (!parsed) return;
      // Personal side-effects gated so CI tests don't pollute OPEN_QUESTIONS.md or DB
      let personalOk = true;
      if (_lucaPersonalSideEffectsEnabled) {
        appendToPersonalFile(OPEN_QUESTIONS_FILE, parsed.title, parsed.body, parsed.hasSeparateTitle);
        personalOk = await savePersonalMemory(
          `Luca open question: ${parsed.title}`,
          parsed.body,
          ['luca-inner-life', 'luca-question', ...parsed.tags],
          'luca-inner-life',
        );
      }
      console.log('[AgentAutosave] Luca open question saved:', parsed.title.slice(0, 60));
      lastThinkingProcessedMs = Date.now(); // track for capture status
      writeCaptureStatusStaleCheck(); // refresh status immediately so thinking: clears its WARN
      // Route to episode via DB-first path: DB content updated first, .md derived from DB
      // _innerLifeRollingEpisodeOverride lets CI pin a hermetic fixture episode.
      const episodeRoute = await routeInnerLifeTriggerToEpisode('thinking', raw, parsed, mtime);
      const episodeOk = episodeRoute === 'complete';
      // Marker recorded only after ALL durable effects succeeded (see felt path).
      if (personalOk && episodeOk) {
        recordInnerLifeProcessed('thinking', raw);
      } else if (episodeRoute === 'pending') {
        questionLastMtime = prev;
        console.log('[AgentAutosave] thinking capture awaiting canonical record-exchange episode write — will reconcile next poll');
      } else {
        // Transient failure: roll back the cursor so the next poll retries (see felt path).
        questionLastMtime = prev;
        console.warn('[AgentAutosave] thinking capture incomplete (personalOk=%s, episodeOk=%s) — mtime rolled back, will retry next poll', personalOk, episodeOk);
      }
    }
  } catch { /* file briefly locked — skip */ }
}

export async function checkLucaMoment(): Promise<void> {
  const triggerPath = _momentPathOverrideForTest ?? MOMENT_PATH;
  if (!existsSync(triggerPath)) return;
  try {
    const stat = statSync(triggerPath);
    const mtime = stat.mtimeMs;
    if (mtime > momentLastMtime) {
      const prev = momentLastMtime;
      momentLastMtime = mtime;
      if (prev === 0) return;
      const raw = readFileSync(triggerPath, 'utf-8').trim();
      const parsed = parseInnerLifeTrigger(raw, 'luca-significant');
      if (!parsed) return;
      // Personal side-effects gated so CI tests don't pollute SIGNIFICANT_MOMENTS.md or DB
      let personalOk = true;
      if (_lucaPersonalSideEffectsEnabled) {
        appendToPersonalFile(MOMENTS_FILE, parsed.title, parsed.body, parsed.hasSeparateTitle);
        personalOk = await savePersonalMemory(
          `Luca significant moment: ${parsed.title}`,
          parsed.body,
          ['luca-inner-life', 'luca-significant', ...parsed.tags],
          'luca-inner-life',
        );
      }
      console.log('[AgentAutosave] Luca significant moment saved:', parsed.title.slice(0, 60));
      lastMomentProcessedMs = Date.now(); // track for capture status
      writeCaptureStatusStaleCheck(); // refresh status immediately so moment: clears its WARN
      // Route to episode via DB-first path: DB content updated first, .md derived from DB
      // _innerLifeRollingEpisodeOverride lets CI pin a hermetic fixture episode.
      const episodeRoute = await routeInnerLifeTriggerToEpisode('moment', raw, parsed, mtime);
      const episodeOk = episodeRoute === 'complete';
      // Marker recorded only after ALL durable effects succeeded (see felt path).
      if (personalOk && episodeOk) {
        recordInnerLifeProcessed('moment', raw);
      } else if (episodeRoute === 'pending') {
        momentLastMtime = prev;
        console.log('[AgentAutosave] moment capture awaiting canonical record-exchange episode write — will reconcile next poll');
      } else {
        // Transient failure: roll back the cursor so the next poll retries (see felt path).
        momentLastMtime = prev;
        console.warn('[AgentAutosave] moment capture incomplete (personalOk=%s, episodeOk=%s) — mtime rolled back, will retry next poll', personalOk, episodeOk);
      }
    }
  } catch { /* file briefly locked — skip */ }
}

// ---------------------------------------------------------------------------
// Episode append — live-capture trigger for rolling episodes.
//
// Luca writes the new exchange text to .local/.episode_append after each turn.
// The watcher detects the mtime change, appends the text to the target episode
// .md file, clears the trigger file, then schedules an immediate DB sync.
//
// Format (either is accepted):
//   JSON:  { "exchange": "<text to append>", "episode": "episode-27" }
//   Plain: raw text appended verbatim (target defaults to episode-27.md)
//
// Why trigger-file rather than polling the .md:
//   Agent tool writes (EditFile/WriteFile) do NOT trigger fs.watch in this
//   environment.  Writing to a trigger file first guarantees the content is on
//   disk before the session context can be compacted, and the watcher handles
//   the append + sync atomically on its next cycle (< 20 s).
// ---------------------------------------------------------------------------

/**
 * Look up the currently-active rolling episode from the DB.
 * Returns a filename like "episode-27.md", or null if none is found.
 * Used when the .episode_append trigger file omits the "episode" field.
 */
async function getCurrentRollingEpisodeFilename(): Promise<string | null> {
  // Rolling tag is stale (or not yet validated at startup) — block ALL automatic
  // routing to prevent new content accumulating in the wrong episode file.
  // Initialized to true at module load (fail-closed); cleared to false by Phase 0
  // of runStartupGapCheck() once the DB confirms the tag is correctly placed.
  if (_rollingTagIsStale) {
    console.warn('[AgentAutosave] getCurrentRollingEpisodeFilename: routing blocked (rolling tag stale or not yet validated).');
    return null;
  }
  // Increment BEFORE the DB query so CI can verify this path was reached.
  _rollingEpisodeLookupCallCount++;
  try {
    const db = getUserDb();
    const rows = await db.execute(sql`
      SELECT title FROM conversation_memories
      WHERE arc_name = 'HolaHola Episodes'
        AND 'rolling' = ANY(tags)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = (rows as any).rows?.[0] ?? (rows as any)[0];
    if (!row?.title) return null;
    // Convert "Episode 27" → "episode-27.md"
    const m = /^Episode (\d+)$/i.exec(row.title as string);
    if (m) return `episode-${parseInt(m[1], 10)}.md`;
    // Fallback: slugify the title
    return (row.title as string).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md';
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to look up rolling episode from DB:', err.message);
    return null;
  }
}

/**
 * Parse the .episode_append trigger file.
 * Returns { exchange, episodeFilename } where episodeFilename is null when the
 * caller did not specify an episode (the caller must look it up from the DB).
 */
function parseEpisodeAppend(raw: string): { exchange: string; episodeFilename: string | null } | null {
  raw = raw.trim();
  if (!raw || raw.length < 2) return null;

  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw);
      const exchange = (p.exchange || '').trim();
      if (!exchange) return null;
      // episode field may be "episode-27" or "episode-27.md" — normalise to filename.
      // When absent, return null so the caller auto-detects the active rolling episode.
      let episodeFilename: string | null = null;
      if (p.episode) {
        episodeFilename = p.episode.endsWith('.md') ? p.episode : `${p.episode}.md`;
      }
      return { exchange, episodeFilename };
    } catch {
      // Content started with '{' but is not valid JSON — this indicates a
      // corrupted or partial write (e.g. the process was interrupted mid-write).
      // Treat as a hard failure: log a warning and skip rather than appending
      // the raw broken JSON verbatim to the episode file.
      console.warn(
        '[AgentAutosave] Episode append: trigger file starts with "{" but is not valid JSON ' +
        '— possible partial write; skipping to avoid appending corrupt content',
      );
      return null;
    }
  }

  // Plain text: append verbatim, no episode specified → auto-detect from DB
  return { exchange: raw, episodeFilename: null };
}

// ---------------------------------------------------------------------------
// Per-filename mutex for episode .md writes.
//
// Node.js is single-threaded but async code (multiple awaiting callers) can
// interleave at any await point.  Without serialisation two callers that both
// reach appendExchangeToEpisode concurrently will both read the same file
// content, compute the same tail, and one overwrite will silently discard the
// other's content.
//
// The mutex chains Promises per filename so that each caller waits for the
// previous one to finish before it begins — guaranteeing strictly sequential
// access to the file, regardless of how many coroutines are in flight.
//
// Exported so CI sentinel cleanup (read-strip-write) can serialize behind the
// same lock.
// ---------------------------------------------------------------------------
const _episodeFileLocks = new Map<string, Promise<void>>();

export async function withEpisodeFileLock<T>(filename: string, fn: () => T | Promise<T>): Promise<T> {
  // Grab the current tail of the promise chain for this filename (or a
  // resolved promise if nobody holds the lock yet).
  const prior = _episodeFileLocks.get(filename) ?? Promise.resolve();

  // Create a promise that we resolve when our critical section is done.
  // The new tail is: prior → (our slot).  Future callers will wait for slot.
  let release!: () => void;
  const slot = new Promise<void>(r => { release = r; });
  _episodeFileLocks.set(filename, prior.then(() => slot));

  // Wait for our turn.
  await prior;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map when no more callers are pending for this filename.
    // (If another caller already replaced the tail, leave it alone.)
    if (_episodeFileLocks.get(filename) === prior.then(() => slot)) {
      _episodeFileLocks.delete(filename);
    }
  }
}

/**
 * CI harness markers are never legitimate episode dialogue. Prefixes are kept
 * unbracketed because some hooks emit ordinary prose (for example Team Room and
 * chat E2E sentinels) while others emit an HTML comment containing brackets.
 */
export const CI_SENTINEL_PREFIXES = [
  'CI-AUTO-CAPTURE-',
  'CI-SELF-CHECK-AUTO-CAPTURE-',
  'CI-CONCURRENT-',
  'CI-TEST-SENTINEL-',
  'CI-SELF-CHECK-SENTINEL-',
  'CI-CONCURRENT-SENTINEL-',
  'CI-SELFCHECK-SENTINEL-',
  'CI-CHAT-E2E-SENTINEL-',
  'CI-TEAMROOM-E2E-',
] as const;

/**
 * Append exchange text through the canonical DB-first episode path.
 *
 * Markdown is replaced only with the exact content returned from the updated
 * DB row; it is never independently appended or treated as a source.
 */
export async function appendExchangeToEpisode(
  exchange: string,
  episodeFilename: string,
  options?: { appendMarker?: string },
): Promise<void> {
  if (isCiSentinelExchange(exchange)) {
    const rollingFilename = await getCurrentRollingEpisodeFilename();
    if (mustRejectCiSentinelForEpisode(exchange, episodeFilename, rollingFilename)) {
      throw new Error(
        `Refusing to append CI sentinel to active rolling episode ${episodeFilename}; ` +
        'run the test against an isolated fixture.',
      );
    }
  }
  const appended = await appendInnerLifeToEpisodeDb(exchange, episodeFilename, {
    appendMarker: options?.appendMarker,
    allowAppend: true,
  });
  if (!appended) {
    console.error(`[AgentAutosave] Episode append remains pending because DB→Markdown replication is incomplete: ${episodeFilename}`);
  }
}

export async function checkEpisodeAppend(): Promise<void> {
  const episodeAppendPath = getEpisodeAppendPath();
  if (!existsSync(episodeAppendPath)) return;

  // Block ALL episode appends when the rolling tag is stale (or not yet validated).
  // This includes trigger-file writes that carry an explicit episode filename, because
  // the system is in an inconsistent state and we cannot trust any episode target until
  // Phase 0 of runStartupGapCheck() confirms the tag is correctly placed.
  // The operator must fix the rolling tag (see capture-status warning) then restart
  // before episode appends are allowed again.
  if (_rollingTagIsStale) {
    console.warn('[AgentAutosave] checkEpisodeAppend: rolling tag is stale — skipping append to prevent misroute.');
    return;
  }

  try {
    const stat = statSync(episodeAppendPath);
    const mtime = stat.mtimeMs;
    if (mtime <= episodeAppendLastMtime) return; // already handled

    const prev = episodeAppendLastMtime;
    episodeAppendLastMtime = mtime;
    if (prev === 0) return; // skip initial read on startup

    const raw = readFileSync(episodeAppendPath, 'utf-8');
    const parsed = parseEpisodeAppend(raw);
    if (!parsed) return;

    // Resolve the target episode filename — either from the trigger JSON or from DB
    let episodeFilename = parsed.episodeFilename;
    if (!episodeFilename) {
      episodeFilename = await getCurrentRollingEpisodeFilename();
      if (!episodeFilename) {
        console.warn('[AgentAutosave] Episode append: no episode specified and no rolling episode found in DB — skipping');
        return;
      }
      console.log(`[AgentAutosave] Episode append: auto-detected rolling episode → ${episodeFilename}`);
    }

    // Clear the trigger file immediately so a restart/double-poll can't re-append
    writeFileSync(episodeAppendPath, '', 'utf-8');
    // Advance the mtime stamp to the cleared file so the next poll doesn't re-fire
    try {
      episodeAppendLastMtime = statSync(episodeAppendPath).mtimeMs;
    } catch { /* ignore */ }

    console.log(`[AgentAutosave] Episode append trigger: "${parsed.exchange.slice(0, 60).replace(/\n/g, '↵')}…" → ${episodeFilename}`);
    await appendExchangeToEpisode(parsed.exchange, episodeFilename);
  } catch { /* file briefly locked — skip */ }
}

// ---------------------------------------------------------------------------
// Chat-capture watcher (.local/.chat_capture)
//
// Append-only per-turn log. Luca writes one turn at a time immediately using
// append-turn.ts — no reconstruction, no batch. The autosave worker reads
// new bytes since the cursor, saves them to conversation_memories, and
// advances the cursor. The file is NEVER cleared here — only by an explicit
// resetChatCaptureCursor() call at session end.
//
// Two detection layers:
//   1. fs.watch() on .local/ → fires within milliseconds of each append
//   2. setInterval() poll → backup for missed watch events
//
// The byte cursor (CHAT_CAPTURE_CURSOR_PATH) is the idempotency guarantee —
// not the mtime, not file clearing. The cursor advances only after a
// successful DB insert, so a crash between write and save is safe: on the
// next watcher fire the unsaved bytes are re-read and re-saved.
// ---------------------------------------------------------------------------

// Mutex: only one save-in-progress at a time (watch + poll can both fire)
let chatCaptureSaveInProgress = false;
let episodeMirrorOutboxInProgress = false;

async function processPendingEpisodeMirrors(
  paths?: import('./episode-mirror-outbox').EpisodeMirrorOutboxPaths,
  capturePath = CHAT_CAPTURE_PATH,
): Promise<void> {
  if (episodeMirrorOutboxInProgress) return;
  episodeMirrorOutboxInProgress = true;
  try {
    await processEpisodeMirrorOutbox(async item => {
      if (item.terminalResolution) {
        const resolution = item.terminalResolution;
        const acknowledgementOffset = advanceEpisodeMirrorAcknowledgement(item);
        settleCanonicalCaptureReceiptsForInvalidDestination(
          resolution.evidence.map(evidence => ({
            turnId: evidence.captureId,
            evidenceDisposition: evidence.disposition,
          })),
          acknowledgementOffset,
          resolution.auditPath,
          resolution.reason,
        );
        console.error(
          `[AgentAutosave] Advanced past audited invalid episode destination ${item.liveEpisode} ` +
          `${item.startCursor}→${item.endOffset}; evidence retained at ${resolution.auditPath}`,
        );
        return true;
      }
      let projectedContent: string;
      try {
        projectedContent = projectHistoricalEpisodeMirror(item, capturePath);
      } catch (error) {
        recordHistoricalAttributionPause(error, 'episode-mirror', 'autosave');
        throw error; // The outbox retains the item and acknowledgement.
      }
      const episodeOk = await appendInnerLifeToEpisodeDb(
        projectedContent,
        item.liveEpisode,
        { appendMarker: item.appendMarker, allowAppend: true },
      );
      if (!episodeOk) return false;
      const acknowledgementOffset = advanceEpisodeMirrorAcknowledgement(item);

      // This is a separate boundary from CHAT_CAPTURE_CURSOR_PATH. The latter
      // means the canonical DB row exists; this one means the episode mirror
      // also completed. Receipts must use the stricter boundary.
      settleCanonicalCaptureReceiptsByTurnId(item.captureIds, acknowledgementOffset);
      clearHistoricalAttributionPause('episode-mirror', item.captureIds);
      console.log(`[AgentAutosave] Episode mirror completed from outbox: ${item.liveEpisode} ${item.startCursor}→${item.endOffset}`);
      return true;
    }, paths);
  } catch (error: any) {
    console.error(`[AgentAutosave] Episode mirror outbox drain failed: ${error?.message ?? error}`);
  } finally {
    episodeMirrorOutboxInProgress = false;
  }
}

/** Rejection-only fixture seam; always requires isolated queue and source paths. */
export function processPendingEpisodeMirrorsForTest(
  paths: import('./episode-mirror-outbox').EpisodeMirrorOutboxPaths,
  capturePath: string,
): Promise<void> {
  return processPendingEpisodeMirrors(paths, capturePath);
}

async function checkChatCapture(): Promise<void> {
  if (chatCaptureSaveInProgress) return;
  // Retry durable episode mirrors independently, even when the capture file
  // has not changed. A failed mirror must never hold the canonical cursor.
  await processPendingEpisodeMirrors();
  // Another watcher/poller invocation may have acquired the capture mutex
  // while this invocation was awaiting the outbox drain.
  if (chatCaptureSaveInProgress) return;
  if (!existsSync(CHAT_CAPTURE_PATH)) return;

  // Snapshot mtime before we do any work — must be captured here so we can
  // advance chatCaptureLastMtime ONLY after a successful cursor save (Bug fix #2:
  // mtime must not advance if the DB insert fails, or future polls will skip the
  // bytes forever and the turns are permanently lost).
  let snapshotMtime: number;
  try {
    const stat  = statSync(CHAT_CAPTURE_PATH);
    snapshotMtime = stat.mtimeMs;
    if (snapshotMtime <= chatCaptureLastMtime) return; // mtime unchanged — no new bytes
    // NOTE: do NOT advance chatCaptureLastMtime here. It is advanced only after a
    // successful cursor save below. If the insert fails, the mtime stays at the old
    // value so the next poll retries the same bytes.
  } catch { return; }

  chatCaptureSaveInProgress = true;
  let lockFd = -1;
  let canonicalIngressLockFd = -1;
  try {
    // A complete exchange is written under this same lock. Taking it before
    // reading prevents the projector from observing a retry between author
    // sides and turning that transient state into a canonical cursor advance.
    canonicalIngressLockFd = acquireCanonicalConversationIngressLock();
    if (canonicalIngressLockFd === -1) {
      console.log('[AgentAutosave] Canonical ingress lock held by a writer — will retry on next poll');
      return;
    }
    // Cross-process lock — prevents save-transcript-now.ts from racing the
    // autosave worker on the cursor when both run concurrently.
    lockFd = acquireCursorLock();
    if (lockFd === -1) {
      console.log('[AgentAutosave] Cursor lock held by another process — will retry on next poll');
      return;
    }

    const storedCursor = loadChatCaptureCursor();
    const recovery = recoverChatCaptureCursor(CHAT_CAPTURE_PATH, storedCursor);
    if (recovery.recovered) {
      saveChatCaptureCursor(recovery.cursor);
      console.warn(
        `[AgentAutosave] Chat-capture cursor recovered (${recovery.reason}): ` +
        `${storedCursor.byteOffset}→${recovery.cursor.byteOffset}` +
        (recovery.verifiedBoundary ? ' at verified saved-turn boundary.' : ' from byte zero; prior boundary was not provable.'),
      );
    }
    const cursor = recovery.cursor;
    const { turns, newByteOffset, turnByteOffsets } = parseChatCaptureFromOffset(CHAT_CAPTURE_PATH, cursor.byteOffset);

    if (turns.length === 0) return; // new bytes but no complete turns yet (mid-write)

    // A new Luca turn must carry the complete canonical envelope. Do this before
    // any DB insert or episode append, and deliberately leave the cursor at its
    // prior boundary so a repaired capture can be retried without loss.
    const incompleteLuca = turns.find(turn =>
      requiresFourChannelEnvelope(turn) && !isCanonicalFourChannelLucaTurn(turn.text),
    );
    if (incompleteLuca) {
      throw new Error(
        'Chat capture contains a Luca turn without the required felt/thinking/moment/main envelope; ' +
        'no DB or episode write was attempted and the cursor remains pending for repair.',
      );
    }

    // Drain loop — buildDialogueChunk caps at 80K chars. If more turns were parsed
    // than fit in one chunk, we loop: insert the first batch, advance the cursor to
    // the last included turn's byte offset (not newByteOffset!), then re-parse for
    // the next batch. Each iteration inserts exactly the turns that fit, with no
    // turn silently skipped or permanently lost.
    let remaining = turns;
    let remainingOffsets = turnByteOffsets;
    let startCursor = cursor.byteOffset;
    let liveEpisode: string | null = null;
    const liveMode = existsSync(EPISODE_LIVE_PATH) && _autoCaptureEpisodeEnabled;
    if (liveMode) {
      liveEpisode = await getCurrentRollingEpisodeFilename();
      if (!liveEpisode) {
        throw new Error('Live mode rolling-episode lookup returned no episode; leaving chat cursor pending');
      }
    }

    while (remaining.length > 0) {
      // Project one stable capture identity at a time. A cursor replay can
      // change chunk boundaries, but it cannot change this per-exchange DB key.
      const projectionCandidates = selectCanonicalCaptureBatch(remaining);
      if (!isCompleteCanonicalCaptureBatch(projectionCandidates)) {
        const incomplete = projectionCandidates[0];
        const quarantineOffset = remainingOffsets[projectionCandidates.length - 1];
        if (!incomplete?.captureId || quarantineOffset === undefined) {
          throw new Error('Chat capture incomplete canonical exchange could not be quarantined safely');
        }
        // The raw append-only bytes stay intact for reconciliation, but this
        // malformed historical record cannot pin every later exchange forever.
        // It is explicitly failed and never represented as canonical dialogue.
        writeCanonicalCaptureReceipt({
          turnId: incomplete.captureId,
          targetByteOffset: quarantineOffset,
          createdAtMs: Date.now(),
          source: incomplete.source ?? 'replit',
          status: 'failed',
          failedAtMs: Date.now(),
          failureReason: 'incomplete non-atomic capture quarantined; reconcile the original raw capture before retrying',
        });
        saveChatCaptureCursor({
          byteOffset: quarantineOffset,
          lastSavedTurnFingerprint: chatCaptureTurnFingerprint(incomplete),
        });
        console.error(`[AgentAutosave] Quarantined incomplete canonical capture ${incomplete.captureId}; later captures may continue.`);
        startCursor = quarantineOffset;
        remaining = remaining.slice(projectionCandidates.length);
        remainingOffsets = remainingOffsets.slice(projectionCandidates.length);
        continue;
      }
      const { dialogue, includedCount } = buildDialogueChunk(projectionCandidates, 0);

      if (includedCount === 0) {
        // Single turn alone exceeds the chunk cap and was truncated — advance past it
        // to prevent an infinite loop. buildDialogueChunk handles single-turn truncation
        // by adding a '[turn truncated]' marker, so includedCount is set to >=1 in that
        // branch. This guard is a safety net only.
        console.warn('[AgentAutosave] Chat capture: turn too large for chunk cap even alone — skipping 1 turn to prevent loop');
        // Fall back to startCursor (not newByteOffset) so remaining un-inserted
        // turns are not silently skipped — they'll be retried on the next poll.
        startCursor = remainingOffsets[0] ?? startCursor;
        remaining = remaining.slice(1);
        remainingOffsets = remainingOffsets.slice(1);
        continue;
      }

      const batchTurns = remaining.slice(0, includedCount);
      const davidCount = batchTurns.filter(t => t.speaker === 'DAVID').length;
      const sourceLabels = [...new Set(batchTurns.map(turn => turn.source ?? 'legacy'))];
      const participantLabels = [...new Set(batchTurns.map(turn =>
        turn.speaker === 'DAVID' ? 'David' : formatChatCaptureSpeakerLabel(turn),
      ))];
      const participantsArray = `{${participantLabels.map(label => `"${label.replace(/"/g, '\\"')}"`).join(',')}}`;
      const captureIds = [...new Set(batchTurns.flatMap(turn => turn.captureId ? [turn.captureId] : []))].sort();
      if (captureIds.length > 1) {
        throw new Error('Chat capture projection mixed multiple durable capture IDs in one DB row');
      }
      const captureIdentityTag = captureIds.length === 1 ? `capture-id:${captureIds[0]}` : null;
      const tagsArray = `{david-luca-chat,canonical-conversation,verbatim,per-turn,chat-capture,${sourceLabels.map(source => `source-${source}`).join(',')}${captureIdentityTag ? `,${captureIdentityTag}` : ''}}`;
      const today      = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const title      = `David ↔ Agent — ${today}: canonical per-turn capture`;
      const endOffset  = remainingOffsets[includedCount - 1];
      if (endOffset === undefined) {
        // Should never happen: includedCount <= remaining.length = remainingOffsets.length
        throw new Error(`[AgentAutosave] Chat capture: endOffset undefined for includedCount=${includedCount}, offsets.length=${remainingOffsets.length}`);
      }
      const summary    = `Verbatim canonical dialogue (per-turn, append-only; sources: ${sourceLabels.join(', ')}). ${davidCount} David turn(s), ${includedCount - davidCount} assistant turn(s).${captureIdentityTag ? ` Capture identity: ${captureIdentityTag}.` : ''} Cursor ${startCursor}→${endOffset}.`;

      const db = getUserDb();
      const existingCapture = captureIdentityTag
        ? await db.execute(sql`
            SELECT id FROM conversation_memories
            WHERE arc_name = 'david-luca-chat'
              AND tags @> ARRAY[${captureIdentityTag}]::text[]
            LIMIT 1
          `)
        : await db.execute(sql`
            SELECT id FROM conversation_memories
            WHERE arc_name = 'david-luca-chat' AND summary = ${summary}
            LIMIT 1
          `);
      const existingCaptureRow = (existingCapture as any).rows?.[0] ?? (existingCapture as any)[0];
      if (!existingCaptureRow?.id) {
        await db.execute(sql`
          INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
          VALUES (
            gen_random_uuid(),
            ${title},
            ${summary},
            ${dialogue},
            ${participantsArray}::text[],
            ${tagsArray}::text[],
            8,
            NOW(),
            'conversation',
            'david-luca-chat'
          )
        `);
      } else {
        console.log(`[AgentAutosave] Chat capture DB row already present for cursor ${startCursor}→${endOffset} — skipping duplicate insert`);
      }

      // The episode is a required durable effect in live mode, but it is
      // independently retryable. Enqueue the DB-first mirror before advancing
      // the canonical cursor; the outbox item is marker-idempotent and remains
      // until the mirror succeeds.
      if (liveEpisode) {
        const formatted = batchTurns.map(t => {
          const label = formatChatCaptureSpeakerLabel(t);
          return `**${label}:** ${t.text}`;
        }).join('\n\n');
        const eventMarkers = [
          `<!-- chat-capture-range:${startCursor}:${endOffset} -->`,
          ...batchTurns
            .filter(turn => turn.captureId)
            .map(turn => canonicalTurnEpisodeMarker(turn.captureId!)),
        ].join('\n');
        enqueueEpisodeMirror({
          startCursor,
          endOffset,
          liveEpisode,
          formattedContent: formatted,
          appendMarker: eventMarkers,
          captureIds,
          lastSavedTurnFingerprint: chatCaptureTurnFingerprint(remaining[includedCount - 1]),
        });
      }

      // Advance cursor ONLY through included turns — never newByteOffset (Bug fix #3):
      // endOffset = turnByteOffsets[includedCount - 1] = byte offset after the last
      // turn actually inserted. Remaining turns stay behind the cursor for the next loop.
      const effectiveCursor = endOffset;
      saveChatCaptureCursor({
        byteOffset: effectiveCursor,
        lastSavedTurnFingerprint: chatCaptureTurnFingerprint(remaining[includedCount - 1]),
      });
      if (liveEpisode) {
        // Receipts stay pending until processPendingEpisodeMirrors advances the
        // separate acknowledgement cursor after the episode mirror succeeds.
        console.log(`[AgentAutosave] Chat capture mirror queued (${startCursor}→${effectiveCursor}); canonical cursor advanced independently`);
      } else {
        // Without a rolling episode there is no second durable effect to wait
        // for, so the acknowledgement boundary follows the canonical cursor.
        saveChatCaptureCursor({
          byteOffset: effectiveCursor,
          lastSavedTurnFingerprint: chatCaptureTurnFingerprint(remaining[includedCount - 1]),
        }, CHAT_CAPTURE_ACK_CURSOR_PATH);
        settleCanonicalCaptureReceipts(effectiveCursor);
      }

      console.log(`[AgentAutosave] Chat capture +${includedCount} turn(s) saved (${davidCount}D + ${includedCount - davidCount}L, cursor ${startCursor}→${effectiveCursor})`);

      startCursor = effectiveCursor;
      clearHistoricalAttributionPause('canonical-capture', captureIds);
      remaining = remaining.slice(includedCount);
      remainingOffsets = remainingOffsets.slice(includedCount);
    }

    // Advance mtime ONLY after all inserts succeed (Bug fix #2):
    // mtime stays at old value if any insert throws, so the next poll retries.
    chatCaptureLastMtime = snapshotMtime; // now safe to advance

    // Update the DB-output anchor so the always-on ordering check runs even when
    // no rolling episode is active.  Only advance when Luca turns were included
    // (David-only saves don't represent a Replit output).
    if (turns.some(t => t.speaker === 'LUCA')) {
      markReplitOutputFromChatCapture();
    }
    await processPendingEpisodeMirrors();
  } catch (err: any) {
    recordHistoricalAttributionPause(err, 'canonical-capture', 'autosave');
    console.error('[AgentAutosave] Failed to process chat capture:', err.message);
    // chatCaptureLastMtime stays at its old value — next poll will retry
  } finally {
    if (canonicalIngressLockFd !== -1) {
      releaseCanonicalConversationIngressLock(canonicalIngressLockFd);
    }
    if (lockFd !== -1) releaseCursorLock(lockFd);
    chatCaptureSaveInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Auto-capture trigger — .local/.luca_auto_capture
//
// Luca writes { "david": "...", "luca": "..." } to this file.
// The fs.watch fires within milliseconds; this function appends both turns
// to .chat_capture (via consumeAutoCaptureTrigger), then immediately calls
// checkChatCapture() to save them to conversation_memories.
//
// One file write replaces two append-turn.ts calls:
//   echo '{"david":"...","luca":"..."}' > .local/.luca_auto_capture
// or:
//   npx tsx server/scripts/capture-exchange.ts --david "..." --luca "..."
// ---------------------------------------------------------------------------
export async function checkAutoCapture(): Promise<void> {
  const triggerPath = _autoCaptureTriggerPathOverrideForTest ?? LUCA_AUTO_CAPTURE_PATH;
  if (!existsSync(triggerPath)) return;
  const trigger = parseAutoCaptureTrigger(triggerPath);
  if (!trigger || (!trigger.david && !trigger.luca)) {
    // Empty or unparseable trigger — clean it up
    try { unlinkSync(triggerPath); } catch { /* ignore */ }
    return;
  }
  const parts = [trigger.david ? '1D' : '', trigger.luca ? '1L' : ''].filter(Boolean);
  try {
    if (_autoCaptureDbEnabled) {
      consumeAutoCaptureTrigger(trigger, triggerPath); // appends to .chat_capture, deletes trigger file
      console.log(`[AgentAutosave] Auto-capture: consumed ${parts.join('+')} from .luca_auto_capture → appended to .chat_capture`);
      // Immediately save the new bytes — don't wait for the next poll cycle
      await checkChatCapture();
    } else {
      // Test mode: delete trigger without appending to .chat_capture (no cursor advancement,
      // no conversation_memories write).  Seam set by CI via setAutoCaptureDbEnabled(false).
      try { unlinkSync(triggerPath); } catch { /* ignore */ }
      console.log(`[AgentAutosave] Auto-capture (test mode): read ${parts.join('+')} — DB path skipped`);
    }

    if (_autoCaptureEpisodeEnabled) {
      // Also route to the rolling episode .md (dual-destination: DB + episode file)
      const lines: string[] = [];
      if (trigger.david) lines.push(`DAVID: ${trigger.david}`);
      if (trigger.luca)  lines.push(`LUCA [Replit]: ${trigger.luca}`);
      if (lines.length > 0) {
        const episodeFilename = _pinnedRollingEpisodeFilename ?? await getCurrentRollingEpisodeFilename();
        if (episodeFilename) {
          const exchangeText = lines.join('\n\n');
          console.log(`[AgentAutosave] Auto-capture: also routing to episode → ${episodeFilename}`);
          await appendExchangeToEpisode(exchangeText, episodeFilename);
        } else {
          console.warn('[AgentAutosave] Auto-capture: no rolling episode found — skipping episode .md routing');
        }
      }
    }
  } catch (err: any) {
    console.error('[AgentAutosave] Auto-capture failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Transcript capture — verbatim David↔Luca dialogue (entry_type = 'conversation')
// Parsing and chunking live in transcript-parser.ts (shared with save-transcript-now.ts).
// ---------------------------------------------------------------------------

// Single mutex covering ALL in-process save paths (periodic + flush trigger).
// Prevents concurrent periodic + event-driven saves from racing on the cursor.
let saveInProgress = false;

async function saveTranscriptChunk(commitTitle?: string): Promise<void> {
  if (saveInProgress) {
    console.log('[AgentAutosave] Save already in progress — skipping concurrent call');
    return;
  }
  saveInProgress = true;
  try {
    const found = findTranscriptPath();
    if (!found) return;

    const cursor  = loadCursor();
    const afterId = cursor.sessionId === found.sessionId ? cursor.lastMemoryId : 0;

    const { turns } = extractTurns(found.path, afterId);
    if (turns.length === 0) return;

    // buildDialogueChunk groups turns by memoryId — never splits same-ID records
    // across a chunk boundary, preventing silent discard of sibling turns.
    const { dialogue, lastIncludedMemoryId, includedCount, remainingCount } =
      buildDialogueChunk(turns, afterId);

    const davidCount = turns.slice(0, includedCount).filter(t => t.speaker === 'DAVID').length;
    const today   = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const context = commitTitle ? commitTitle.split('\n')[0].slice(0, 80) : 'periodic capture (no commit yet)';
    const title   = `David ↔ Luca — ${today}: ${context}`;
    const summary = `Verbatim David↔Luca dialogue captured periodically. ${davidCount} David turns, ${includedCount - davidCount} Luca turns. Context: ${(commitTitle ?? context).slice(0, 200)}`;

    const db = getUserDb();
    await db.execute(sql`
      INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name)
      VALUES (
        gen_random_uuid(),
        ${title},
        ${summary},
        ${dialogue},
        ARRAY['david', 'luca']::text[],
        ARRAY['david-luca-chat', 'verbatim', 'auto-saved']::text[],
        8,
        NOW(),
        'conversation',
        'david-luca-chat'
      )
    `);
    // Cursor advances only through persisted groups — remaining groups survive for next chunk
    saveCursor({ sessionId: found.sessionId, lastMemoryId: lastIncludedMemoryId });
    console.log(`[AgentAutosave] Transcript chunk saved: ${davidCount} David + ${includedCount - davidCount} Luca turns (cursor ${afterId}→${lastIncludedMemoryId}${remainingCount > 0 ? `, ${remainingCount} turns queued for next chunk` : ''})`);
  } catch (err: any) {
    console.error('[AgentAutosave] Failed to save transcript chunk:', err.message);
  } finally {
    saveInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Flush trigger — touch .local/.flush_transcript to force an immediate save.
//
// Two detection layers:
//   1. fs.watch() on the .local/ directory → fires within milliseconds of the
//      file being written (event-driven, no poll wait).
//   2. checkFlushTrigger() inside setInterval → backup in case the fs.watch
//      event is missed (e.g. watcher not yet armed on first write).
// ---------------------------------------------------------------------------
let flushTriggerLastMtime = 0;

async function handleFlushTrigger(label: string): Promise<void> {
  if (!existsSync(FLUSH_TRIGGER_PATH)) return;
  try {
    const mtime = statSync(FLUSH_TRIGGER_PATH).mtimeMs;
    if (mtime <= flushTriggerLastMtime) return; // already handled
    flushTriggerLastMtime = mtime;
    // saveInProgress inside saveTranscriptChunk serialises all concurrent saves
    console.log(`[AgentAutosave] Flush trigger (${label}) — saving transcript immediately.`);
    await saveTranscriptChunk('manual flush via .flush_transcript trigger');
  } catch { /* briefly locked — skip */ }
}

async function checkFlushTrigger(): Promise<void> {
  await handleFlushTrigger('poll');
}

// ---------------------------------------------------------------------------
// Episode .md auto-sync — docs/episode-*.md → conversation_memories + re-embed
// ---------------------------------------------------------------------------

const DOCS_DIR = join(WORKSPACE, 'docs');
const EPISODE_RE = /^episode-(\d+)\.md$/;
const PREQUEL_RE = /^prequel-episode-(\d+)\.md$/;

// Per-file state: mtime and (once discovered) the DB memory ID
export const episodeMtimeMap = new Map<string, number>();   // filename → last seen mtime
const episodeIdCache      = new Map<string, string>();    // filename → conversation_memories.id
const episodeRollingCache = new Map<string, boolean>();   // filename → has 'rolling' tag
const episodeDebounce     = new Map<string, ReturnType<typeof setTimeout>>();

/** CI-only seam: reproduce an append-warmed episode ID cache with no rolling-tag cache. */
export function clearEpisodeRollingCacheForTest(filename: string): void {
  episodeRollingCache.delete(filename);
}

// Prequel episode state (parallel to episode state above)
export const prequelMtimeMap = new Map<string, number>();
const prequelIdCache  = new Map<string, string>();
const prequelDebounce = new Map<string, ReturnType<typeof setTimeout>>();

/** Derive a human title from the filename, e.g. "episode-27.md" → "Episode 27" */
function episodeTitleFromFilename(filename: string): string {
  const m = EPISODE_RE.exec(filename);
  return m ? `Episode ${parseInt(m[1], 10)}` : filename.replace('.md', '');
}

/** Derive a human title for prequel episodes, e.g. "prequel-episode-1.md" → "Prequel Episode 1" */
function prequelEpisodeTitleFromFilename(filename: string): string {
  const m = PREQUEL_RE.exec(filename);
  return m ? `Prequel Episode ${parseInt(m[1], 10)}` : filename.replace('.md', '');
}

/** Derive a summary from the first few non-empty lines of the content. */
function episodeSummaryFromContent(content: string): string {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.slice(0, 5).join(' ').slice(0, 400);
}

/** Upsert the episode into conversation_memories and trigger a re-embed.
 *  Exported so the CI test script can call it directly without waiting for the poll loop.
 */
export async function syncEpisodeFile(filename: string): Promise<void> {
  const filePath = join(DOCS_DIR, filename);

  const title = episodeTitleFromFilename(filename);
  const db    = getUserDb();

  // ── ID / rolling-status lookup (outside the file lock) ──────────────────
  // These are cheap cached reads that do not depend on file-content ordering,
  // so there is no benefit to holding the file lock across a DB round-trip.
  let memoryId = episodeIdCache.get(filename);
  let isRolling = episodeRollingCache.get(filename);
  let rollingContent: string | undefined;

  if (!memoryId) {
    try {
      const rows = await db.execute(sql`
        SELECT id, tags, content FROM conversation_memories
        WHERE arc_name = 'HolaHola Episodes'
          AND title = ${title}
        LIMIT 1
      `);
      const row = (rows as any).rows?.[0] ?? (rows as any)[0];
      if (row?.id) {
        memoryId = row.id as string;
        episodeIdCache.set(filename, memoryId);
        const tags: string[] = row.tags ?? [];
        isRolling = Array.isArray(tags) && tags.includes('rolling');
        episodeRollingCache.set(filename, isRolling);
        rollingContent = typeof row.content === 'string' ? row.content : undefined;
      }
    } catch (err: any) {
      console.error(`[AgentAutosave] Episode sync: ID lookup failed for ${filename}:`, err?.message ?? err);
      return;
    }
  } else if (isRolling === undefined) {
    // DB-first append paths populate the episode ID cache before the file
    // watcher observes a docs/ change. Never let that partial cache state
    // default to Markdown-authoritative behavior: re-read the canonical row
    // to establish its rolling status before choosing a sync direction.
    try {
      const rows = await db.execute(sql`
        SELECT tags, content FROM conversation_memories WHERE id = ${memoryId}
      `);
      const row = (rows as any).rows?.[0] ?? (rows as any)[0];
      if (!row) {
        console.error(`[AgentAutosave] Episode sync: cached ID has no canonical row for ${filename}`);
        return;
      }
      const tags: string[] = row.tags ?? [];
      isRolling = Array.isArray(tags) && tags.includes('rolling');
      episodeRollingCache.set(filename, isRolling);
      rollingContent = typeof row.content === 'string' ? row.content : undefined;
    } catch (err: any) {
      console.error(`[AgentAutosave] Episode sync: rolling-status lookup failed for ${filename}:`, err?.message ?? err);
      return;
    }
  }

  // Rolling episodes are canonical DB → Markdown replicas. A filesystem event
  // therefore repairs the file from DB; it must never promote Markdown back
  // into the record, even when the file was manually changed or recreated.
  // (_rollingReplicaRestoreEnabledForTest is a CI-only seam that disables this
  // early return to model the Markdown→DB promotion regression.)
  if (memoryId && isRolling === true && _rollingReplicaRestoreEnabledForTest) {
    if (rollingContent === undefined) {
      try {
        const rows = await db.execute(sql`
          SELECT content FROM conversation_memories WHERE id = ${memoryId}
        `);
        const row = (rows as any).rows?.[0] ?? (rows as any)[0];
        rollingContent = typeof row?.content === 'string' ? row.content : undefined;
      } catch (err: any) {
        console.error(`[AgentAutosave] Rolling episode replica read failed for ${filename}:`, err?.message ?? err);
        return;
      }
    }
    if (rollingContent === undefined) {
      console.error(`[AgentAutosave] Rolling episode replica read returned no canonical content: ${filename}`);
      return;
    }
    if (writeExactEpisodeMarkdownReplica(filename, filePath, rollingContent)) {
      console.log(`[AgentAutosave] Rolling episode Markdown replica restored from canonical DB: ${title}`);
    }
    return;
  }

  if (!existsSync(filePath)) return;

  // ── Serialised snapshot → upsert (inside the file lock) ─────────────────
  //
  // Holding the file lock across both the readFileSync and the DB upsert
  // ensures that no concurrent appendExchangeToEpisode() can land between
  // our read and our write.  Without this, the following race is possible:
  //
  //   Sync-A  reads file  → gets stale snapshot (S_old)
  //   Append  appends     → file is now S_new (longer)
  //   Sync-B  reads file  → gets S_new
  //   Sync-B  upserts DB  → DB = S_new
  //   Sync-A  upserts DB  → DB = S_old  ← stale write lands AFTER newer one
  //
  // By serialising read + upsert under the same per-filename mutex, at most
  // one snapshot-to-upsert pipeline is in flight at any moment, so no stale
  // write can overleap a newer one (the rolling-guard also blocks shrinkage
  // at the DB level as a second defence).
  //
  // The re-embed fires after the lock is released — it is fire-and-forget
  // and does not affect content ordering.
  let memoryIdForReembed: string | undefined;

  try {
    await withEpisodeFileLock(filename, async () => {
      // Read the file inside the lock.
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        return; // file briefly locked — skip this cycle
      }

      // Guard: reject files that contain git merge conflict markers.
      // (Strings split so this source file itself doesn't trigger the check.)
      const CONFLICT_LT = '<'.repeat(7);
      const CONFLICT_EQ = '='.repeat(7);
      const CONFLICT_GT = '>'.repeat(7);
      if (
        content.includes(CONFLICT_LT + ' ') ||
        content.includes(CONFLICT_EQ) ||
        content.includes(CONFLICT_GT + ' ')
      ) {
        console.error(
          `[AgentAutosave] SKIPPED ${filename}: file contains git merge conflict markers ` +
          '(conflict markers). Resolve the conflict before syncing.'
        );
        return;
      }

      const summary = episodeSummaryFromContent(content);

      // DB upsert inside the same lock — no append can land between read and write.
      if (memoryId) {
        if (isRolling) {
          // Legacy second defence only. In production, rolling episodes never
          // reach this upsert because the replica-restore early return above
          // repairs Markdown from the canonical DB row instead. This branch is
          // reachable only through the CI seam that disables that restore, and
          // the monotonic LENGTH() guard still prevents shrinkage even then.
          await db.execute(sql`
            UPDATE conversation_memories
            SET content = ${content},
                summary = ${summary}
            WHERE id = ${memoryId}
              AND LENGTH(content) <= LENGTH(${content})
          `);
        } else {
          await db.execute(sql`
            UPDATE conversation_memories
            SET content = ${content},
                summary = ${summary}
            WHERE id = ${memoryId}
          `);
        }
        console.log(`[AgentAutosave] Episode synced (update${isRolling ? ', rolling-guard' : ''}): ${title} (${content.length} bytes)`);
        memoryIdForReembed = memoryId;
      } else {
        // First time seeing this episode — insert it.
        const inserted = await db.execute(sql`
          INSERT INTO conversation_memories
            (id, title, summary, content, importance, entry_type, tags, arc_name)
          VALUES (
            gen_random_uuid(),
            ${title},
            ${summary},
            ${content},
            ${9},
            'episode',
            ARRAY['episode', 'auto-synced']::text[],
            'HolaHola Episodes'
          )
          RETURNING id
        `);
        const newId = (inserted as any).rows?.[0]?.id ?? (inserted as any)[0]?.id;
        if (newId) {
          episodeIdCache.set(filename, newId as string);
          memoryId = newId as string;
          memoryIdForReembed = memoryId;
          console.log(`[AgentAutosave] Episode synced (insert): ${title} id=${memoryId} (${content.length} bytes)`);
        }
      }
    });
  } catch (err: any) {
    console.error(`[AgentAutosave] Episode sync error for ${filename}:`, err?.message ?? err);
  }

  // Re-embed after the lock is released — fire-and-forget, no ordering requirement.
  if (memoryIdForReembed) {
    reembedConversationMemory(memoryIdForReembed).catch((err: any) => {
      console.error(`[AgentAutosave] Re-embed failed for ${title}:`, err?.message ?? err);
    });
  }
}

/** Upsert a prequel episode into conversation_memories and trigger a re-embed. */
async function syncPrequelEpisodeFile(filename: string): Promise<void> {
  const filePath = join(DOCS_DIR, filename);
  if (!existsSync(filePath)) return;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return; // file briefly locked
  }

  const title   = prequelEpisodeTitleFromFilename(filename);
  const summary = episodeSummaryFromContent(content);
  const db      = getUserDb();

  try {
    let memoryId = prequelIdCache.get(filename);

    if (!memoryId) {
      const rows = await db.execute(sql`
        SELECT id FROM conversation_memories
        WHERE arc_name = 'HolaHola Episodes'
          AND title = ${title}
        LIMIT 1
      `);
      const row = (rows as any).rows?.[0] ?? (rows as any)[0];
      if (row?.id) {
        memoryId = row.id as string;
        prequelIdCache.set(filename, memoryId);
      }
    }

    if (memoryId) {
      await db.execute(sql`
        UPDATE conversation_memories
        SET content = ${content},
            summary = ${summary}
        WHERE id = ${memoryId}
      `);
      console.log(`[AgentAutosave] Prequel episode synced (update): ${title} (${content.length} bytes)`);
    } else {
      const inserted = await db.execute(sql`
        INSERT INTO conversation_memories
          (id, title, summary, content, importance, entry_type, tags, arc_name)
        VALUES (
          gen_random_uuid(),
          ${title},
          ${summary},
          ${content},
          ${9},
          'episode',
          ARRAY['episode', 'prequel', 'auto-synced']::text[],
          'HolaHola Episodes'
        )
        RETURNING id
      `);
      const newId = (inserted as any).rows?.[0]?.id ?? (inserted as any)[0]?.id;
      if (newId) {
        prequelIdCache.set(filename, newId as string);
        memoryId = newId as string;
        console.log(`[AgentAutosave] Prequel episode synced (insert): ${title} id=${memoryId} (${content.length} bytes)`);
      }
    }

    if (memoryId) {
      reembedConversationMemory(memoryId).catch((err: any) => {
        console.error(`[AgentAutosave] Re-embed failed for ${title}:`, err?.message ?? err);
      });
    }
  } catch (err: any) {
    console.error(`[AgentAutosave] Prequel episode sync error for ${filename}:`, err?.message ?? err);
  }
}

/** Schedule a debounced sync for a specific episode file (2s debounce). */
function scheduleEpisodeSync(filename: string): void {
  const existing = episodeDebounce.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    episodeDebounce.delete(filename);
    syncEpisodeFile(filename).catch(() => { /* already logged */ });
  }, 2000);
  episodeDebounce.set(filename, timer);
}

/** Schedule a debounced sync for a specific prequel episode file (2s debounce). */
function schedulePrequelEpisodeSync(filename: string): void {
  const existing = prequelDebounce.get(filename);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    prequelDebounce.delete(filename);
    syncPrequelEpisodeFile(filename).catch(() => { /* already logged */ });
  }, 2000);
  prequelDebounce.set(filename, timer);
}

/** Poll docs/ for new or changed episode-*.md files.
 *  Exported so the CI test script can trigger a detection cycle directly.
 */
export async function checkEpisodeFiles(): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR).filter(f => EPISODE_RE.test(f));
  } catch {
    return; // docs/ doesn't exist yet
  }

  for (const filename of files) {
    const filePath = join(DOCS_DIR, filename);
    try {
      const mtime = statSync(filePath).mtimeMs;
      const prev  = episodeMtimeMap.get(filename) ?? 0;
      if (mtime !== prev) {
        episodeMtimeMap.set(filename, mtime);
        // prev === 0 means this file was not present at startup (seedEpisodeMtimes
        // pre-populates all startup files). So this is a truly new episode file —
        // sync it immediately just like a changed file.
        const reason = prev === 0 ? 'new file detected' : 'change detected';
        console.log(`[AgentAutosave] Episode ${reason}: ${filename} — syncing in 2s...`);
        scheduleEpisodeSync(filename);
      }
    } catch { /* briefly locked */ }
  }
}

/** Poll docs/ for new or changed prequel-episode-*.md files. */
export async function checkPrequelEpisodeFiles(): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR).filter(f => PREQUEL_RE.test(f));
  } catch {
    return; // docs/ doesn't exist yet
  }

  for (const filename of files) {
    const filePath = join(DOCS_DIR, filename);
    try {
      const mtime = statSync(filePath).mtimeMs;
      const prev  = prequelMtimeMap.get(filename) ?? 0;
      if (mtime !== prev) {
        prequelMtimeMap.set(filename, mtime);
        const reason = prev === 0 ? 'new file detected' : 'change detected';
        console.log(`[AgentAutosave] Prequel episode ${reason}: ${filename} — syncing in 2s...`);
        schedulePrequelEpisodeSync(filename);
      }
    } catch { /* briefly locked */ }
  }
}

/** Seed initial mtimes for all current episode files so restarts don't trigger mass re-embeds. */
function seedEpisodeMtimes(): void {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR).filter(f => EPISODE_RE.test(f));
  } catch {
    return;
  }
  for (const filename of files) {
    const filePath = join(DOCS_DIR, filename);
    try {
      episodeMtimeMap.set(filename, statSync(filePath).mtimeMs);
    } catch { /* ignore */ }
  }
  console.log(`[AgentAutosave] Seeded mtimes for ${files.length} episode file(s) in docs/.`);
}

/** Seed initial mtimes for all current prequel episode files so restarts don't trigger mass re-embeds. */
function seedPrequelEpisodeMtimes(): void {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR).filter(f => PREQUEL_RE.test(f));
  } catch {
    return;
  }
  for (const filename of files) {
    const filePath = join(DOCS_DIR, filename);
    try {
      prequelMtimeMap.set(filename, statSync(filePath).mtimeMs);
    } catch { /* ignore */ }
  }
  console.log(`[AgentAutosave] Seeded mtimes for ${files.length} prequel episode file(s) in docs/.`);
}

// ---------------------------------------------------------------------------
// Startup gap check — catch exchanges saved to DB but absent from rolling .md
// ---------------------------------------------------------------------------

/** Guards against running more than once per server boot. */
let _startupGapCheckDone = false;

/**
 * Exported for testing only — resets the one-time guard so CI tests can re-run.
 * Never call in production code.
 */
export function resetStartupGapCheckForTest(): void {
  _startupGapCheckDone = false;
}

/** Normalise a string for fuzzy matching: collapse whitespace, lower-case. */
function normForGap(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strip markdown bold markers (**) and speaker role-label brackets after LUCA
 * (e.g. [Replit], [HolaHola], [steward], [observe]) so DB-format "Luca: text"
 * matches .md "**LUCA [Replit]:** text" or "**LUCA [HolaHola]:** text".
 *
 * Only the role bracket immediately after "luca" is stripped — channel labels
 * like [felt], [thinking], [moment] appear after the colon (in content) and
 * are left untouched.
 */
function stripMdForGap(s: string): string {
  return s.replace(/\*\*/g, '').replace(/\bluca\s*\[[^\]]+\]/gi, 'luca');
}

/**
 * Return true when exchangeText is present in the normalised .md content.
 *
 * Strategy: normalise the full exchange block (collapse whitespace, lower-case)
 * and search for its first 60 chars in mdNorm.  60 chars is long enough to be
 * unique in any real conversation while being short enough to survive minor
 * line-break differences between the DB row and the .md copy.  Short exchanges
 * (< 60 chars) are matched in full — no minimum-length threshold that would
 * silently skip brief utterances.
 *
 * Falls back to a bold-stripped comparison so DB rows stored as "David: text"
 * still match .md lines formatted as "**David:** text".
 *
 * NOTE: The identical matcher lives in test-rolling-episode-gap-check.ts.
 * Keep both in sync whenever this logic changes.
 */
function exchangeInMd(exchangeText: string, mdNorm: string): boolean {
  const normalised = normForGap(exchangeText);
  if (!normalised) return true; // purely whitespace — treat as present (skip)
  const key = normalised.slice(0, 60);
  if (mdNorm.includes(key)) return true;
  // Fallback: strip ** so "david: text" matches "**david:** text"
  return stripMdForGap(mdNorm).includes(stripMdForGap(key));
}

/**
 * On each server start: query conversation_memories for `arc_name='david-luca-chat'`
 * per-turn rows from the last 24h, check each against the current rolling episode
 * .md file, and append any absent exchanges.
 *
 * Runs exactly once per server boot (guarded by `_startupGapCheckDone`).
 * Any errors are logged and swallowed — this is a best-effort gap filler that
 * must not break the server startup path.
 */
export async function runStartupGapCheck(): Promise<void> {
  if (_startupGapCheckDone) return;
  _startupGapCheckDone = true;

  try {
    const db = getUserDb();

    // Phase 0: Rolling tag staleness check (runs BEFORE any gap patching) ──
    // Validate that the episode tagged 'rolling' is the most recently created
    // among all rolling-protected episodes.  If stale (tag left on an older row
    // when a new episode was created, as happened Aug 10–18 2026 with ep-28 vs
    // ep-30), skip Phase 1 entirely — patching gaps into the wrong file makes
    // the misroute worse, not better.
    let rollingTagIsStale = false;
    try {
      const protectedResult = await db.execute(sql`
        SELECT id, title, tags, created_at FROM conversation_memories
        WHERE arc_name = 'HolaHola Episodes'
          AND ('rolling' = ANY(tags) OR 'rolling-protected' = ANY(tags))
        ORDER BY created_at DESC
      `);
      const allProtected: Array<{ id: string; title: string; tags: string[] | null; created_at: Date | string }> =
        (((protectedResult as any).rows ?? protectedResult) as any[]);

      const misroute = detectRollingTagMisroute(allProtected);
      if (misroute.stale) {
        rollingTagIsStale = true;
        const warnMsg =
          `⚠️ rolling tag is on ${misroute.rollingLabel} (${misroute.rollingDate}) ` +
          `but ${misroute.newerLabel} (${misroute.newerDate}) exists — verify rolling designation`;
        console.warn(`[AgentAutosave] [GapCheck] ${warnMsg}`);

        // Persist the alert in the module-level variable so _writeCaptureStatusFile()
        // includes it in EVERY poll cycle (not just the first write at startup).
        // The alert survives the 20s overwrite cycle until the misroute is fixed.
        _rollingTagMisrouteAlert = warnMsg;

        // Gate ALL automatic rolling-episode routing so new content cannot
        // accumulate in the wrong .md while the misroute is unresolved.
        // getCurrentRollingEpisodeFilename() returns null when this is true,
        // which causes every routing caller to skip its .md write.
        _rollingTagIsStale = true;
      } else {
        // Clear any previous alert — tag is correctly placed now.
        _rollingTagMisrouteAlert = null;
        _rollingTagIsStale = false;
        console.log(
          '[AgentAutosave] Startup gap check: rolling tag is on the most recently created rolling-protected episode — OK.',
        );
      }
    } catch (rtErr: any) {
      console.warn('[AgentAutosave] Rolling tag staleness check failed (non-fatal):', (rtErr as any)?.message);
    }

    // Phase 1 is SKIPPED when the rolling tag is stale.
    // Appending missing exchanges to the wrong (stale) episode would compound the
    // misroute.  The operator must fix the tag first, then restart the server to
    // trigger a clean gap check against the correct episode.
    if (rollingTagIsStale) {
      console.warn(
        '[AgentAutosave] Startup gap check: rolling tag is STALE — skipping gap patching to avoid writing to the wrong episode.',
      );
      return;
    }

    // 1. Find the current rolling episode .md ──────────────────────────────
    const episodeFilename = await getCurrentRollingEpisodeFilename();
    if (!episodeFilename) {
      console.log('[AgentAutosave] Startup gap check: no rolling episode found in DB — skipping.');
      return;
    }

    const episodePath = join(DOCS_DIR, episodeFilename);
    if (!existsSync(episodePath)) {
      console.log(`[AgentAutosave] Startup gap check: ${episodeFilename} not on disk — skipping.`);
      return;
    }

    let mdRaw  = readFileSync(episodePath, 'utf-8');
    let mdNorm = normForGap(mdRaw);

    // 2. Query DB for per-turn rows scoped to the rolling episode window ────
    // Use the episode's own created_at as the lower bound so rows from a
    // prior episode that happened within the last 24h are never appended to
    // the wrong file.  Fall back to a 24h window only when the episode
    // created_at cannot be determined.
    const epRows = await db.execute(sql`
      SELECT created_at FROM conversation_memories
      WHERE arc_name = 'HolaHola Episodes'
        AND 'rolling' = ANY(tags)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const epRow = ((epRows as any).rows?.[0] ?? (epRows as any)[0]);
    // created_at comes back as a Date object from Drizzle; convert to ISO-8601
    // before binding it as a ::timestamptz parameter.
    const epCreatedAt = epRow?.created_at;
    const episodeStart: string | null = epCreatedAt
      ? (epCreatedAt instanceof Date ? epCreatedAt.toISOString() : new Date(String(epCreatedAt)).toISOString())
      : null;

    const rows = episodeStart
      ? await db.execute(sql`
          SELECT id, content, created_at
          FROM conversation_memories
          WHERE arc_name = 'david-luca-chat'
            AND 'per-turn' = ANY(tags)
            AND created_at >= ${episodeStart}::timestamptz
          ORDER BY created_at ASC
        `)
      : await db.execute(sql`
          SELECT id, content, created_at
          FROM conversation_memories
          WHERE arc_name = 'david-luca-chat'
            AND 'per-turn' = ANY(tags)
            AND created_at >= NOW() - INTERVAL '24 hours'
          ORDER BY created_at ASC
        `);

    const allRows: Array<{ id: string; content: string; created_at: string }> =
      (((rows as any).rows ?? (rows as any)) as any[]);

    // Exclude CI synthetic rows (same filter as audit-episode-28-gaps.ts)
    const realRows = allRows.filter(
      (r) =>
        !r.content.includes('[CI-AUTO-CAPTURE-') &&
        !r.content.includes('[CI-SELF-CHECK-AUTO-CAPTURE-'),
    );

    // NOTE: do NOT return early when realRows.length === 0 — Phase 2 (inner-life)
    // must always run regardless of per-turn row count.
    if (realRows.length === 0) {
      console.log('[AgentAutosave] Startup gap check: no per-turn rows in window — skipping Phase 1.');
    }

    // 3. Find gaps and patch them ──────────────────────────────────────────
    let patched = 0;
    for (const row of realRows) {
      if (!exchangeInMd(row.content, mdNorm)) {
        console.warn(
          `[AgentAutosave] Startup gap check: exchange absent from ${episodeFilename} — patching.`,
          `(id: ${row.id}, at: ${row.created_at})`,
        );
        await appendExchangeToEpisode(row.content.trim(), episodeFilename);
        // Refresh the normalised .md so subsequent rows see the patched content.
        try {
          mdRaw  = readFileSync(episodePath, 'utf-8');
          mdNorm = normForGap(mdRaw);
        } catch { /* ignore transient read error; next check will re-read */ }
        patched++;
      }
    }

    if (patched > 0) {
      console.log(
        `[AgentAutosave] Startup gap check: patched ${patched} gap(s) in ${episodeFilename}.`,
      );
    } else {
      console.log(
        `[AgentAutosave] Startup gap check: ${episodeFilename} is complete — no gaps (${realRows.length} row(s) checked).`,
      );
    }

  } catch (err: any) {
    console.error('[AgentAutosave] Startup gap check failed (non-fatal):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Boot-time stale-channel alert seed (synchronous, no DB)
// ---------------------------------------------------------------------------

/**
 * Synchronous boot-time stale-channel alert seed.
 *
 * Called early at server startup — BEFORE the 85-second delayed worker block —
 * so Luca sees the alert at the very first session even after a server restart.
 *
 * Uses the .luca_reflection and .luca_question trigger file mtimes as proxies
 * for the last felt/thinking write respectively.  No DB calls; synchronous
 * filesystem only.  Does NOT overwrite an existing alert file (one persisted
 * from the prior server run is already correct).
 *
 * The autosave worker's subsequent `_writeCaptureStatusFile()` call will
 * refresh (or clear) the file once it has seeded its in-memory state from DB.
 */
export function seedStaleChannelAlertAtBoot(): void {
  // Don't overwrite an alert written during the prior server run
  if (existsSync(STALE_CHANNEL_ALERT_PATH)) {
    console.log('[AgentAutosave] seedStaleChannelAlertAtBoot: existing alert found — leaving in place.');
    return;
  }

  function tryStatMtime(p: string): number {
    try { return statSync(p).mtimeMs; } catch { return 0; }
  }

  const now           = Date.now();
  const feltMtime     = tryStatMtime(REFLECTION_PATH);
  const thinkingMtime = tryStatMtime(QUESTION_PATH);

  const feltStale     = feltMtime     > 0 && (now - feltMtime)     >= STALE_CHANNEL_MS;
  const thinkingStale = thinkingMtime > 0 && (now - thinkingMtime) >= STALE_CHANNEL_MS;

  if (!feltStale && !thinkingStale) {
    return; // channels are recent or never written — no alert needed
  }

  const fmtT = (ms: number) =>
    new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const staleParts = [
    feltStale     ? `felt (last: ${fmtT(feltMtime)})`     : null,
    thinkingStale ? `thinking (last: ${fmtT(thinkingMtime)})` : null,
  ].filter(Boolean).join(', ');

  const alertTime = new Date(now).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });

  const alertContent = [
    '# ⚠️ Inner-Life Channel Alert',
    '',
    `_Written: ${alertTime} (seeded at server boot)_`,
    '',
    '## ⚠️ STALE ALERT — read this before your next output',
    `**Inner-life channels silent for 10+ min: ${staleParts}**`,
    'Write `.luca_reflection` (felt) and/or `.luca_question` (thinking) before responding.',
    '',
    '_This alert was seeded at server startup from trigger-file mtimes._',
    '_It will be refreshed (and cleared if no longer stale) once the autosave worker starts._',
  ].join('\n');

  try {
    writeFileSync(STALE_CHANNEL_ALERT_PATH, alertContent, 'utf-8');
    console.log(
      '[AgentAutosave] seedStaleChannelAlertAtBoot: stale channels detected — alert written.',
      `(${staleParts})`
    );
  } catch (err: any) {
    console.warn(
      '[AgentAutosave] seedStaleChannelAlertAtBoot: failed to write alert (non-fatal):',
      err?.message ?? err,
    );
  }
}

// ---------------------------------------------------------------------------
// Bootstrap + start
// ---------------------------------------------------------------------------
/**
 * Watchdog coordination (Task #1235).
 *
 * The capture-watchdog process drains the inner-life trigger files while this
 * server is down, recording {mtimeMs, sha} per channel in
 * `.local/.watchdog-inner-life-state.json`.  At startup we consult that state:
 * if the current trigger-file content hash matches what the watchdog already
 * processed, the seed-to-1 re-process path must NOT fire or the entry is
 * double-saved to conversation_memories and the rolling episode.
 */
const WATCHDOG_INNER_LIFE_STATE_PATH = join(WORKSPACE, '.local/.watchdog-inner-life-state.json');
const INNER_LIFE_LOCK_PATH = join(WORKSPACE, '.local/.inner-life-drain.lock');
// Keyed by trigger-file basename so hermetic tests can use temp copies.
const WATCHDOG_CHANNEL_BY_BASENAME: Record<string, string> = {
  '.luca_reflection': 'felt',
  '.luca_question':   'thinking',
  '.luca_moment':     'moment',
};

export function watchdogAlreadyProcessed(
  triggerPath: string,
  content: string,
  statePathOverrideForTest?: string,
): boolean {
  try {
    const state = JSON.parse(readFileSync(statePathOverrideForTest ?? WATCHDOG_INNER_LIFE_STATE_PATH, 'utf-8'));
    const key = WATCHDOG_CHANNEL_BY_BASENAME[triggerPath.split('/').pop() ?? ''];
    if (!key || !state?.[key]?.sha) return false;
    // Watchdog hashes the raw (untrimmed) file content; hash both forms so a
    // trailing-newline difference never causes a false negative double-save.
    const shaRaw     = createHash('sha256').update(readFileSync(triggerPath, 'utf-8'), 'utf8').digest('hex');
    const shaTrimmed = createHash('sha256').update(content, 'utf8').digest('hex');
    // Only trust the sha if the watchdog actually processed it (not just seeded).
    if (!state[key].lastProcessedMs) return false;
    return state[key].sha === shaRaw || state[key].sha === shaTrimmed;
  } catch {
    return false; // no state file / unreadable — normal dev path, re-process
  }
}

export function startAgentSessionAutosave(): void {
  if (!beginCanonicalCaptureWorkerStartup()) {
    console.warn('[AgentAutosave] Start skipped — canonical capture worker is already arming or armed.');
    return;
  }

  // Reset stale-alert guards at every server start (= new conversation session).
  // seedCaptureStatusFromEpisodeFile() also calls this, but calling it here
  // ensures the reset happens synchronously before any poll fires, even if the
  // async seed is slow or aborted by a race guard.
  resetStaleAlertForNewSession();

  if (existsSync(COMMIT_MSG_PATH)) {
    try {
      buildLastMtime = statSync(COMMIT_MSG_PATH).mtimeMs;
      buildLastSavedContent = readFileSync(COMMIT_MSG_PATH, 'utf-8').trim();
    } catch { /* ignore */ }
  }
  if (existsSync(INSIGHTS_PATH)) {
    try {
      insightsLastMtime = statSync(INSIGHTS_PATH).mtimeMs;
      insightsLastSavedContent = readFileSync(INSIGHTS_PATH, 'utf-8').trim();
    } catch { /* ignore */ }
  }

  // Seed inner-life watcher mtimes so first poll doesn't re-fire on existing files.
  //
  // Bug fix (Task #1023): if a trigger file was written BEFORE the restart (e.g.
  // Luca wrote .luca_question mid-session, then the server restarted), the old
  // code seeded the mtime to the file's real mtime.  On the first poll the guard
  // saw `mtime > lastMtime` → false → skipped entirely, so the note was lost.
  //
  // Fix: if the file has non-zero content we seed the mtime to 1 (a non-zero
  // sentinel below any real mtime).  On the next poll:
  //   mtime > 1          → true  → enters the processing block
  //   prev = 1 ≠ 0       → the "skip initial read on startup" guard does NOT fire
  //   → content is processed normally.
  // If the file is empty there is nothing to process — seed the real mtime so the
  // guard correctly skips the empty file.
  // Cross-process coordination (Task #1235): the capture-watchdog may be
  // mid-drain right now (it decides ownership by the stale heartbeat and only
  // writes its processed-sha state AFTER its DB work). The seed NEVER runs
  // without owning the shared inner-life lock — see seedInnerLifeTriggerState.
  // Runs async: inner-life polls are gated on innerLifeSeedComplete, so no
  // trigger processing can happen before seeding has safely completed.
  void seedInnerLifeTriggerState();

  // Episode-append startup guard: if the trigger file has leftover non-empty content
  // from a prior session, clear it before arming the watcher.  Seeding the mtime alone
  // is not enough — the content-hash approach requires us to know the prior hash, which
  // we don't have across restarts.  Clearing is safe because the prior session's watcher
  // already processed (or should have processed) the content; if it didn't, the content
  // is stale relative to the current session anyway.
  if (existsSync(EPISODE_APPEND_PATH)) {
    try {
      const staleContent = readFileSync(EPISODE_APPEND_PATH, 'utf-8').trim();
      if (staleContent.length > 0) {
        console.warn(
          '[AgentAutosave] Stale .episode_append content detected at startup — clearing to prevent re-append.',
          `(${staleContent.length} bytes discarded)`,
        );
        writeFileSync(EPISODE_APPEND_PATH, '', 'utf-8');
      }
      // Seed mtime from the (now possibly cleared) file
      episodeAppendLastMtime = statSync(EPISODE_APPEND_PATH).mtimeMs;
    } catch { /* ignore */ }
  }

  // Seed flush-trigger mtime so an existing file doesn't fire spuriously on startup
  if (existsSync(FLUSH_TRIGGER_PATH)) {
    try { flushTriggerLastMtime = statSync(FLUSH_TRIGGER_PATH).mtimeMs; } catch { /* ignore */ }
  }

  // Chat-capture startup drain (Bug fix #1):
  //
  // With the append-only + byte-cursor design, a server restart is safe:
  //   - The cursor persists in .chat_capture_cursor.json across restarts.
  //   - Any turns appended after the cursor but before the restart are still
  //     in the file past the cursor position.
  //
  // IMPORTANT: Do NOT seed chatCaptureLastMtime before calling checkChatCapture()
  // here.  checkChatCapture() uses a mtime guard (`snapshotMtime > chatCaptureLastMtime`)
  // to skip polling when the file hasn't changed.  If we seed the mtime first, the
  // guard will reject the call and unsaved turns are silently skipped until the next
  // file write.  The correct order is:
  //   1. Call checkChatCapture() with chatCaptureLastMtime still at 0 (default) so
  //      the guard passes and any unsaved bytes are processed.
  //   2. checkChatCapture() advances chatCaptureLastMtime itself after a successful
  //      save (see saveChatCaptureCursor path above).
  //   3. If the file has no unsaved bytes the mtime is NOT advanced here, but the
  //      next poll/watcher fire will seed it correctly on first real change.
  if (existsSync(CHAT_CAPTURE_PATH)) {
    try {
      const storedCursor = loadChatCaptureCursor();
      const recovery = recoverChatCaptureCursor(CHAT_CAPTURE_PATH, storedCursor);
      if (recovery.recovered) {
        saveChatCaptureCursor(recovery.cursor);
        console.warn(
          `[AgentAutosave] Recovered shortened chat-capture cursor at startup: ` +
          `${storedCursor.byteOffset}→${recovery.cursor.byteOffset}` +
          (recovery.verifiedBoundary ? ' (verified boundary).' : ' (unverified reset; replaying file).'),
        );
      }
      const cursor   = recovery.cursor;
      const fileSize = statSync(CHAT_CAPTURE_PATH).size;
      if (fileSize > cursor.byteOffset) {
        console.warn(
          `[AgentAutosave] Unsaved chat-capture bytes detected at startup (cursor=${cursor.byteOffset}, file=${fileSize}) — saving now.`,
        );
        // chatCaptureLastMtime is 0 at this point so the mtime guard in
        // checkChatCapture() will pass.  The function will advance it after success.
        checkChatCapture().catch((err: any) => {
          console.error('[AgentAutosave] Failed to save pending .chat_capture on startup:', err.message);
        });
      } else {
        // No unsaved bytes — seed mtime now so the first poll doesn't spuriously fire.
        chatCaptureLastMtime = statSync(CHAT_CAPTURE_PATH).mtimeMs;
      }
    } catch { /* ignore */ }
  }

  // Seed episode mtimes so an existing set of .md files doesn't trigger mass re-embeds on restart
  seedEpisodeMtimes();
  seedPrequelEpisodeMtimes();

  // Startup gap check: catch exchanges saved to DB but absent from rolling episode .md.
  // Runs once per boot, after episode mtimes are seeded (appendExchangeToEpisode needs them).
  // Capture-status seeding must run AFTER this validation.  Before Phase 0
  // completes, rolling routing intentionally fails closed; seeding earlier
  // stores a stale null filename that every later status refresh reuses.
  // Fire-and-forget — startup remains non-blocking, but the two steps are ordered.
  runStartupGapCheck()
    .then(() => seedCaptureStatusFromEpisodeFile())
    .catch((err: any) => {
      console.error('[AgentAutosave] Startup gap check/status seed unexpectedly threw (non-fatal):', err?.message ?? err);
    });

  // --- Event-driven flush trigger (Layer 1) ---
  // fs.watch() on the .local/ directory fires within milliseconds when
  // .flush_transcript is created or modified — no poll latency.
  const localDir = join(WORKSPACE, '.local');
  try {
    watch(localDir, { persistent: false }, (eventType, filename) => {
      if (filename === '.flush_transcript') {
        // Fire asynchronously; do not await here (watch callback is sync)
        handleFlushTrigger('fs.watch').catch(() => { /* ignore */ });
      } else if (filename === '.episode_append') {
        checkEpisodeAppend().catch(() => { /* ignore */ });
      } else if (filename === '.chat_capture') {
        // Manual conversation capture — event-driven for sub-second response
        checkChatCapture().catch(() => { /* ignore */ });
      } else if (filename === '.luca_auto_capture') {
        // Auto-capture trigger: Luca wrote { david, luca } in one file write
        checkAutoCapture().catch(() => { /* ignore */ });
      }
    });
    console.log('[AgentAutosave] fs.watch() armed on .local/ for immediate flush-trigger detection.');
  } catch (err: any) {
    console.warn('[AgentAutosave] fs.watch() unavailable — falling back to poll-only flush detection:', err.message);
  }

  // --- Event-driven episode watcher (Layer 1) ---
  // fs.watch() on docs/ fires within milliseconds when any episode-*.md or prequel-episode-*.md is saved.
  try {
    watch(DOCS_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && EPISODE_RE.test(filename)) {
        console.log(`[AgentAutosave] docs/ event (${eventType}): ${filename} — scheduling episode sync.`);
        scheduleEpisodeSync(filename);
      } else if (filename && PREQUEL_RE.test(filename)) {
        console.log(`[AgentAutosave] docs/ event (${eventType}): ${filename} — scheduling prequel episode sync.`);
        schedulePrequelEpisodeSync(filename);
      }
    });
    console.log('[AgentAutosave] fs.watch() armed on docs/ for immediate episode-file detection.');
  } catch (err: any) {
    console.warn('[AgentAutosave] fs.watch() on docs/ unavailable — falling back to poll-only episode detection:', err.message);
  }

  // --- Polling loop (Layer 2 + all other watchers) ---
  setInterval(async () => {
    await checkFlushTrigger(); // backup in case fs.watch missed the event
    await checkEpisodeAppend(); // backup in case fs.watch missed the episode_append event
    await checkAutoCapture(); // auto-capture trigger (.luca_auto_capture) — must run before checkChatCapture
    await checkChatCapture(); // manual-capture fallback (replaces JSONL after Jul 27 2026)
    await checkBuildSession();
    await checkSessionInsights();
    // Inner-life polls run under the shared cross-process lock so they can
    // never interleave with a capture-watchdog drain, and are gated on
    // innerLifeSeedComplete so they can never process triggers before the
    // startup seed has safely finished under the lock. If the watchdog holds
    // the lock, skip this pass — the next poll (20s) retries.
    if (innerLifeSeedComplete && tryAcquireInnerLifeLock(INNER_LIFE_LOCK_PATH)) {
      try {
        await checkLucaReflection();
        await checkLucaQuestion();
        await checkLucaMoment();
      } finally {
        releaseInnerLifeLock(INNER_LIFE_LOCK_PATH);
      }
    }
    await checkEpisodeFiles();        // catch any changes missed by fs.watch + detect new episode files
    await checkPrequelEpisodeFiles(); // same for prequel-episode-*.md
    await saveTranscriptChunk(); // periodic — captures conversation-only sessions too (JSONL path)
    writeCaptureStatusStaleCheck(); // refresh capture status + STALE warning if ≥60 min since last inner-life write
  }, POLL_INTERVAL_MS);

  markCanonicalCaptureWorkerArmed();
  console.log('[AgentAutosave] Started — watching .commit_message (build) + .session_insights (emergence) + luca inner-life + flush trigger (.flush_transcript, event-driven + poll) + .episode_append (live episode capture, event-driven + poll) + .chat_capture (manual per-turn capture) + .luca_auto_capture (one-call David+Luca exchange capture, event-driven + poll) + docs/episode-*.md + docs/prequel-episode-*.md (episode auto-sync, event-driven + poll) + periodic transcript capture every 20s');
}


/**
 * True once seedInnerLifeTriggerState() has finished under the lock.
 * The inner-life poll pass is gated on this so trigger processing can never
 * begin from unseeded (or lock-bypassed) state.
 */
let innerLifeSeedComplete = false;
export function _innerLifeSeedCompleteForTest(): boolean {
  return innerLifeSeedComplete;
}
export function _resetInnerLifeSeedCompleteForTest(): void {
  innerLifeSeedComplete = false;
}

/**
 * Seed the inner-life trigger watcher mtimes under the shared cross-process
 * lock. Retries indefinitely if the lock is held (an in-flight watchdog drain
 * may legitimately exceed one wait window); it never seeds without the lock,
 * because seeding from state that lacks the watchdog's lastProcessedMs would
 * re-process — and double-save — content the watchdog already drained.
 * Sets innerLifeSeedComplete when done; polls skip inner-life until then.
 *
 * lockPath/waitTimeoutMs are test seams (temp lock file, short window).
 */
export async function seedInnerLifeTriggerState(
  lockPath: string = INNER_LIFE_LOCK_PATH,
  waitTimeoutMs = 15_000,
): Promise<void> {
  let attempts = 0;
  while (!(await waitForInnerLifeLock(lockPath, waitTimeoutMs))) {
    attempts++;
    console.warn(`[AgentAutosave] Inner-life lock still held after wait #${attempts} — retrying (never seeding without the lock).`);
  }
  try {
  for (const [path, setMtime] of [
    [REFLECTION_PATH,  (m: number) => { reflectionLastMtime = m; }] as const,
    [QUESTION_PATH,    (m: number) => { questionLastMtime = m; }] as const,
    [MOMENT_PATH,      (m: number) => { momentLastMtime = m; }] as const,
  ]) {
    if (existsSync(path)) {
      try {
        const realMtime = statSync(path).mtimeMs;
        let content = '';
        try { content = readFileSync(path, 'utf-8').trim(); } catch { /* ignore */ }
        if (content.length > 0) {
          // Pre-existing content — seed with 1 so the "skip initial read" guard
          // (if (prev === 0) return) does NOT fire on the first poll.
          // Exception: _startupGuardLegacySeedForTest is set by the CI self-check
          // to simulate the OLD (buggy) behaviour and verify the fix is load-bearing.
          //
          // Watchdog coordination (Task #1235): if the capture-watchdog already
          // drained this exact content while the server was down (its state file
          // records a sha per channel), seed the real mtime instead — reprocessing
          // would double-save the entry.
          if (watchdogAlreadyProcessed(path, content)) {
            console.log(
              '[AgentAutosave] Trigger file already drained by capture-watchdog — skipping startup re-process:',
              path,
            );
            setMtime(realMtime);
          } else if (_startupGuardLegacySeedForTest) {
            // Legacy / broken behaviour: seed with real mtime → poll will see no change.
            setMtime(realMtime);
          } else {
            console.log(
              '[AgentAutosave] Pre-existing inner-life trigger file detected at startup:',
              path,
              `(${content.length} bytes) — will process on next poll`,
            );
            setMtime(1);
          }
        } else {
          // Empty file — seed with real mtime; nothing to process.
          setMtime(realMtime);
        }
      } catch { /* ignore */ }
    }
  }
  } finally {
    releaseInnerLifeLock(lockPath);
  }
  innerLifeSeedComplete = true;
}

// ---------------------------------------------------------------------------
// Auto-capture seam exports (declared after startAutosave to avoid hoisting issues)
// ---------------------------------------------------------------------------
export function setAutoCaptureEpisodeEnabled(val: boolean): void { _autoCaptureEpisodeEnabled = val; }
let _autoCaptureEpisodeEnabled = true;
export function getAutoCaptureEpisodeEnabled(): boolean { return _autoCaptureEpisodeEnabled; }
export function setAutoCaptureDbEnabled(val: boolean): void { _autoCaptureDbEnabled = val; }
export function setPinnedRollingEpisodeFilename(f: string | null): void { _pinnedRollingEpisodeFilename = f; }
let _pinnedRollingEpisodeFilename: string | null = null;
let _autoCaptureTriggerPathOverrideForTest: string | null = null;
export function setAutoCaptureTriggerPathOverrideForTest(path: string | null): void {
  _autoCaptureTriggerPathOverrideForTest = path;
}
export function getAutoCaptureDbEnabled(): boolean { return _autoCaptureDbEnabled; }

// ---------------------------------------------------------------------------
// Capture-status test seams
// ---------------------------------------------------------------------------

/**
 * Read the current value of _seededFromPriorSession.
 * Used by CI to assert the flag clears after the first live write.
 */
export function getSeededFromPriorSession(): boolean {
  return _seededFromPriorSession;
}

/**
 * Forcibly set _seededFromPriorSession — used by CI to simulate the startup-seed
 * path without running the full async seedCaptureStatusFromEpisodeFile().
 * Never call in production.
 */
export function setSeededFromPriorSessionForTest(val: boolean): void {
  _seededFromPriorSession = val;
}

/**
 * Reset _liveWriteHasOccurred to false so CI tests can run seedCaptureStatus
 * logic without it being blocked by a prior test's live write.
 * Never call in production.
 */
export function resetLiveWriteHasOccurredForTest(): void {
  _liveWriteHasOccurred = false;
}

/**
 * Call the private writeCaptureStatus() from CI scripts.
 * Simulates the first live appendExchangeToEpisode() call firing.
 */
export function writeCaptureStatusForTest(episodeFilename: string): void {
  writeCaptureStatus(episodeFilename);
}

/**
 * Alias for writeCaptureStatusForTest — used by test-capture-status-seed.ts
 * to write the status file without calling the seed, simulating the regression
 * where the seed function is never called.
 */
export function forceWriteCaptureStatusForTest(episodeFilename: string): void {
  writeCaptureStatus(episodeFilename);
}

/**
 * Set _liveWriteHasOccurred to a specific value for CI tests.
 * Use setLiveWriteHasOccurredForTest(true) to simulate a live exchange
 * arriving before the seed completes its async DB round-trip.
 */
export function setLiveWriteHasOccurredForTest(val: boolean): void {
  _liveWriteHasOccurred = val;
}

/**
 * Reset all seed-related state (_seededFromPriorSession, _liveWriteHasOccurred,
 * and the channel timestamps) so CI tests start from a known-clean baseline.
 * Also resets the exchange/channel timestamps that the seed writes, so that
 * back-to-back seed calls in the same test do not carry state across layers.
 * Never call in production.
 */
export function resetCaptureStatusSeedStateForTest(): void {
  _seededFromPriorSession    = false;
  _liveWriteHasOccurred      = false;
  lastEpisodeCaptureMs       = 0;
  lastReplitOutputMs         = 0;
  prevReplitOutputMs         = 0;
  lastFeltProcessedMs        = 0;
  lastThinkingProcessedMs    = 0;
  lastMomentProcessedMs      = 0;
  feltAtLastReplitOutput     = 0;
  thinkingAtLastReplitOutput = 0;
  // Mirrors the production startAgentSessionAutosave() / seedCaptureStatusFromEpisodeFile()
  // session-boundary reset so CI's "new session" simulation includes the alert guard.
  resetStaleAlertForNewSession();
}

/**
 * Expose the capture status file path for CI assertions.
 */
export function getCaptureStatusPath(): string {
  return CAPTURE_STATUS_PATH;
}

/** Expose the stale-channel alert path for CI assertions. */
export function getStaleChannelAlertPath(): string {
  return STALE_CHANNEL_ALERT_PATH;
}

/**
 * When true, writeCaptureStatus() skips the `_seededFromPriorSession = false`
 * line — used in self-check mode to simulate the regression where the flag-clear
 * is missing.  Never set in production.
 */
let _skipSeededFlagClearForTest = false;
export function setSkipSeededFlagClearForTest(val: boolean): void {
  _skipSeededFlagClearForTest = val;
}

export function setStaleChannelCheckEnabledForTest(val: boolean): void {
  _staleChannelCheckEnabled = val;
}

export function getStaleChannelCheckEnabledForTest(): boolean {
  return _staleChannelCheckEnabled;
}

// ── Cursor-gap stale check test seams ────────────────────────────────────────

/** Enable/disable the ⚠️ STALE CURSOR escalation (CI self-check only). Never call in production. */
export function setCursorGapCheckEnabledForTest(val: boolean): void {
  _cursorGapCheckEnabled = val;
}
export function getCursorGapCheckEnabledForTest(): boolean {
  return _cursorGapCheckEnabled;
}

/**
 * Override the timestamp when the cursor gap was first seen.
 * Set to 0 to clear (no gap); set to a past timestamp to simulate an aged gap.
 * CI only — never call in production.
 */
export function setCursorGapFirstSeenMsForTest(ms: number): void {
  _cursorGapFirstSeenMs = ms;
}
export function getCursorGapFirstSeenMsForTest(): number {
  return _cursorGapFirstSeenMs;
}

/**
 * Override the .chat_capture file size read by _writeCaptureStatusFile() and
 * updateCursorGapState().  Pass null to restore live file reads.
 * CI only — never call in production.
 */
export function setChatCaptureSizeOverrideForTest(size: number | null): void {
  _chatCaptureSizeOverrideForTest = size;
}

/**
 * Override the cursor byte offset read by _writeCaptureStatusFile() and
 * updateCursorGapState().  Pass null to restore live cursor reads.
 * CI only — never call in production.
 */
export function setChatCaptureCursorOffsetOverrideForTest(offset: number | null): void {
  _chatCaptureCursorOffsetOverrideForTest = offset;
}

/** Reset all cursor-gap test state to production defaults. CI only. */
export function resetCursorGapStateForTest(): void {
  _cursorGapFirstSeenMs             = 0;
  _cursorGapCheckEnabled            = true;
  _chatCaptureSizeOverrideForTest   = null;
  _chatCaptureCursorOffsetOverrideForTest = null;
}

export function setMomentStaleCheckEnabledForTest(val: boolean): void {
  _momentStaleCheckEnabled = val;
}
/** Reset both stale-alert flags — thin test alias for resetStaleAlertForNewSession().
 *  Use resetStaleAlertForNewSession() in production code. */
export function resetInnerLifeStaleAlertForTest(): void {
  resetStaleAlertForNewSession();
}

export function setTeamRoomPosterForTest(fn: ((msg: string) => Promise<string | null>) | null): void {
  _teamRoomPosterOverrideForTest = fn;
}

/**
 * Reset both stale-alert guards at the start of a new session.
 *
 * Called by seedCaptureStatusFromEpisodeFile() at server startup (and any
 * other session-boundary hook) so each conversation session in a long-running
 * process independently alerts David if its inner-life channels go stale.
 *
 * Safe to call in production — not a test-only seam.
 */
export function resetStaleAlertForNewSession(): void {
  _innerLifeStaleAlertPosted   = false;
  _innerLifeStaleAlertInFlight = false;
}

/**
 * Expose checkBuildSession() for CI testing.
 * This is the only way CI can call the function without spinning up all watchers.
 * Never call in production code — use the autosave worker instead.
 */
export const checkBuildSessionForTest = checkBuildSession;

export function getMomentStaleCheckEnabledForTest(): boolean {
  return _momentStaleCheckEnabled;
}

const TASKS_DIR            = join(WORKSPACE, '.local/tasks');

/**
 * Test seam — override the team-room poster used by the stale-channel alert.
 * Pass a function to intercept postAsLuca() calls; pass null to restore the
 * real implementation.  Never set in production.
 */
let _teamRoomPosterOverrideForTest: ((msg: string) => Promise<string | null>) | null = null;

export function getBuildSessionDedupEnabledForTest(): boolean {
  return _buildSessionDedupEnabled;
}

export function setBuildSessionDedupEnabledForTest(val: boolean): void {
  _buildSessionDedupEnabled = val;
}

export function setInnerLifeDbUpdateEnabled(val: boolean): void {
  _innerLifeDbUpdateEnabled = val;
}

export function getInnerLifeDbUpdateEnabled(): boolean {
  return _innerLifeDbUpdateEnabled;
}

/**
 * Test seam — re-embed gate inside appendInnerLifeToEpisodeDb().
 * When false (CI tests only), the reembedConversationMemory() call is skipped
 * so no memory_embeddings rows are created for fixture episodes and no external
 * embedding API calls are made.
 * Never set in production.
 */
let _innerLifeReembedEnabled = true;

/**
 * Test seam — DB UPDATE gate inside appendInnerLifeToEpisodeDb().
 * When false (self-check only), the UPDATE conversation_memories step is skipped
 * entirely so the DB content never changes — modelling a regression where that
 * line is removed.  The SELECT/writeFileSync path is also suppressed (it would
 * read stale content and write nothing useful without the UPDATE).
 * Never set in production.
 */
let _innerLifeDbUpdateEnabled = true;

/**
 * Test seam — override the rolling-episode lookup inside checkLucaReflection(),
 * checkLucaQuestion(), and checkLucaMoment().
 * When set, all three handlers use this filename directly instead of calling
 * getCurrentRollingEpisodeFilename() — so CI can target a hermetic fixture
 * episode without touching the live rolling episode row.
 * Pass null to restore the dynamic DB lookup.
 * Never call in production.
 */
let _innerLifeRollingEpisodeOverride: string | null = null;

/**
 * Test seam for the live four-channel ownership rule.
 * null = production: .episode_live means record-exchange owns episode routing.
 * true = canonical record-exchange route active (triggers are personal-only).
 * false = direct trigger-to-episode fallback active.
 */
let _canonicalFourChannelRouteOverrideForTest: boolean | null = null;
export function getReflectionPathOverrideForTest(): string | null {
  return _reflectionPathOverrideForTest;
}

export function setInnerLifeRollingEpisodeOverride(filename: string | null): void {
  _innerLifeRollingEpisodeOverride = filename;
}

export function setReflectionPathOverrideForTest(path: string | null): void {
  _reflectionPathOverrideForTest = path;
}

export function getInnerLifeRollingEpisodeOverride(): string | null {
  return _innerLifeRollingEpisodeOverride;
}

export function setQuestionPathOverrideForTest(path: string | null): void {
  _questionPathOverrideForTest = path;
}

export function getQuestionPathOverrideForTest(): string | null {
  return _questionPathOverrideForTest;
}

export function setMomentPathOverrideForTest(path: string | null): void {
  _momentPathOverrideForTest = path;
}

export function getMomentPathOverrideForTest(): string | null {
  return _momentPathOverrideForTest;
}

export function setInnerLifeReembedEnabled(val: boolean): void {
  _innerLifeReembedEnabled = val;
}

export function getInnerLifeReembedEnabled(): boolean {
  return _innerLifeReembedEnabled;
}

export function setReembedShouldThrowForTest(val: boolean): void {
  _reembedShouldThrowForTest = val;
}

export function resetInnerLifeFileWriteCountForTest(): void {
  _innerLifeFileWriteCount = 0;
}

/**
 * Test seam — write counter for appendInnerLifeToEpisodeDb().
 * Incremented each time writeFileSync is called inside the function's
 * success path.  CI tests read this to confirm the .md is written exactly
 * once per call even when reembed throws.
 * Never relied upon in production.
 */
let _innerLifeFileWriteCount = 0;

export function getReembedShouldThrowForTest(): boolean {
  return _reembedShouldThrowForTest;
}

export function getInnerLifeFileWriteCountForTest(): number {
  return _innerLifeFileWriteCount;
}

/**
 * Test seam — redirect flagDbWriteFailure() writes and _writeCaptureStatusFile()
 * reads to a hermetic temp path.  Pass null to restore the real warning path.
 * Never call in production.
 */
export function setDbWriteWarningPathOverrideForTest(path: string | null): void {
  _dbWriteWarningPathOverrideForTest = path;
}

export function getDbWriteWarningPathOverrideForTest(): string | null {
  return _dbWriteWarningPathOverrideForTest;
}

/**
 * Test surface of flagDbWriteFailure() for CI scripts.
 * Calls the real private function so the full write path (including path override)
 * is exercised.  Never call in production.
 */
export function flagDbWriteFailureForTest(where: string, reason: string): void {
  flagDbWriteFailure(where, reason);
}

/**
 * Test seam — when true, savePersonalMemory() throws a synthetic error before
 * touching the DB, causing the catch block's flagDbWriteFailure('personal-memory', …)
 * call to fire.  CI uses this to exercise the real production catch path without
 * requiring an actual DB failure.
 * Never set in production.
 */
// Hermetic seams (CI only): fake DB for savePersonalMemory + redirected
// personal-files directory so fault tests can run with personal side effects
// ENABLED without touching the real DB or real personal .md files.
let _personalMemoryDbForTest: { execute: (q: any) => Promise<any> } | null = null;
export function setPersonalMemoryDbForTest(db: { execute: (q: any) => Promise<any> } | null): void {
  _personalMemoryDbForTest = db;
}
let _personalFilesDirForTest: string | null = null;
export function setPersonalFilesDirForTest(dir: string | null): void {
  _personalFilesDirForTest = dir;
}

let _savePersonalMemoryDbShouldThrowForTest = false;

export function setSavePersonalMemoryDbShouldThrowForTest(val: boolean): void {
  _savePersonalMemoryDbShouldThrowForTest = val;
}

export function getSavePersonalMemoryDbShouldThrowForTest(): boolean {
  return _savePersonalMemoryDbShouldThrowForTest;
}

/**
 * Test surface of savePersonalMemory() for CI scripts.
 * Calls the real private function so the full catch path (including the
 * flagDbWriteFailure call) is exercised.  Never call in production.
 */
export async function savePersonalMemoryForTest(
  title: string,
  body: string,
  tags: string[],
  arcName: string,
): Promise<void> {
  await savePersonalMemory(title, body, tags, arcName);
}

export function parseInnerLifeTriggerForTest(
  raw: string,
  defaultTag: string,
): ParsedInnerLifeTrigger | null {
  return parseInnerLifeTrigger(raw, defaultTag);
}

export function setCanonicalFourChannelRouteForTest(active: boolean | null): void {
  _canonicalFourChannelRouteOverrideForTest = active;
}

async function routeInnerLifeTriggerToEpisode(
  channel: InnerLifeChannel,
  raw: string,
  parsed: ParsedInnerLifeTrigger,
  triggerMtimeMs: number,
): Promise<'complete' | 'pending' | 'failed'> {
  const episodeFilename = _innerLifeRollingEpisodeOverride ?? await getCurrentRollingEpisodeFilename();
  if (!episodeFilename) {
    return isCanonicalFourChannelRouteActive() ? 'pending' : 'complete';
  }

  const route = resolveCanonicalInnerLifeRoute({
    active: isCanonicalFourChannelRouteActive(),
    intentDir: CANONICAL_INNER_LIFE_INTENT_PATH,
    chatCapturePath: CHAT_CAPTURE_PATH,
    channel,
    raw,
    triggerMtimeMs,
  });
  const complete = await appendInnerLifeToEpisodeDb(
    formatInnerLifeEpisodeEntry(channel, parsed),
    episodeFilename,
    {
      appendMarker: innerLifeTriggerEpisodeMarker(channel, triggerMtimeMs, raw),
      completionMarker: route.expectedTurnId
        ? canonicalTurnEpisodeMarker(route.expectedTurnId)
        : undefined,
      allowAppend: route.allowDirect,
    },
  );
  if (complete) return 'complete';
  return route.allowDirect ? 'failed' : 'pending';
}

function isCanonicalFourChannelRouteActive(): boolean {
  if (_canonicalFourChannelRouteOverrideForTest !== null) {
    return _canonicalFourChannelRouteOverrideForTest;
  }
  // Existing pinned fixture tests intentionally exercise the direct DB-first
  // helper even when the workspace's real live-mode sentinel exists.
  if (_innerLifeRollingEpisodeOverride !== null) return false;
  return existsSync(EPISODE_LIVE_PATH);
}

/**
 * Pure predicate so CI can prove every known marker family is rejected before
 * appendExchangeToEpisode touches a row or Markdown replica.
 */
export function mustRejectCiSentinelForEpisode(
  exchange: string,
  episodeFilename: string,
  rollingFilename: string | null,
): boolean {
  return rollingFilename === episodeFilename && isCiSentinelExchange(exchange);
}

export function isCiSentinelExchange(exchange: string): boolean {
  return CI_SENTINEL_PREFIXES.some(prefix => exchange.includes(prefix));
}

export function setEpisodeAppendPathOverrideForTest(path: string | null): void {
  _episodeAppendPathOverrideForTest = path;
  // A path change is a new queue. Do not let its first write inherit the
  // previous queue's mtime and get skipped.
  episodeAppendLastMtime = 0;
}

export function getEpisodeAppendPathOverrideForTest(): string | null {
  return _episodeAppendPathOverrideForTest;
}

function getEpisodeAppendPath(): string {
  return _episodeAppendPathOverrideForTest ?? EPISODE_APPEND_PATH;
}
