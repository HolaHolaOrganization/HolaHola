/**
 * Unified WebSocket Handler
 * 
 * Single point of handling for ALL WebSocket connections.
 * This prevents conflicts between multiple WebSocketServers.
 * 
 * Paths handled:
 * - /api/voice/stream/ws - Streaming voice mode (via Socket.io)
 * - /api/realtime/ws - OpenAI Realtime API proxy
 * 
 * Socket.io Migration:
 * - Uses Socket.io for voice streaming (handles Replit proxy negotiation)
 * - SocketIOWebSocketAdapter provides ws-compatible API for existing handlers
 */

import { WebSocketServer, WebSocket as WS } from 'ws';
import { Server as SocketIOServer, Socket as SocketIOSocket } from 'socket.io';
import { Server } from 'http';
import type { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { storage } from './storage';
import { createSystemPrompt, createStreamingVoicePrompt, TutorDirectoryEntry, UserRole, SessionIntent, buildPedagogicalPersonaSection, buildCompassContextBlock, buildTimezoneContext } from './system-prompt';
import { buildNativeFunctionCallingSection } from './services/procedural-memory-retrieval';
import { PedagogicalPersona } from '@shared/tutor-orchestration-types';
import { parse as parseCookie } from 'cookie';
import signature from 'cookie-signature';
import {
  getStreamingVoiceOrchestrator,
  StreamingSession,
  StreamingMetrics,
} from './services/streaming-voice-orchestrator';
import {
  ClientStartSessionMessage,
  ClientAudioDataMessage,
  ClientStreamAudioChunkMessage,
  ClientDrillResultMessage,
  ClientTextInputMessage,
  StreamingErrorMessage,
  VoiceInputMode,
  ClientTelemetryEvent,
} from '@shared/streaming-voice-types';
import { OpenMicSession, OpenMicEvents, getDeepgramLanguageCode } from './services/deepgram-live-stt';
import { GeminiLiveSession, createGeminiLiveSession, GEMINI_LIVE_VOICE_ENABLED, GEMINI_LIVE_MODEL, registerGlSession, unregisterGlSession } from './services/gemini-live-session';
import { OpenAIRealtimeSession, createOpenAIRealtimeSession } from './services/openai-realtime-session';
import {
  getLiveVoiceSessionOwner,
  resolveLiveVoiceRoute,
  shouldUseLegacyVoicePipeline,
  type LiveVoiceRoute,
} from './services/live-voice-routing';
import { costTracker } from './services/cost-tracker';
import { DANIELA_FUNCTION_DECLARATIONS, DANIELA_GL_FUNCTION_DECLARATIONS, getDanielajGLFunctionDeclarationsForLanguage, GL_DISPATCHER_SYSTEM_PROMPT } from './services/daniela-function-registry';
import { generateCongratulatoryPromptAddition } from './services/competency-verifier';
import { buildCurriculumContext, detectSyllabusQuery } from './services/curriculum-context';
import { usageService } from './services/usage-service';
import { shouldRunPlacementAfterSession, completePlacementAssessment } from './services/placement-assessment-service';
import { sessionCompassService, COMPASS_ENABLED } from './services/session-compass-service';
import { architectVoiceService } from './services/architect-voice-service';
import { voiceTelemetry } from './services/voice-pipeline-telemetry';
import { updateToolEventEngagement, mapWhiteboardTypeToToolType } from './services/pedagogical-insights-service';
import { buildNeuralNetworkPromptSection } from './services/neural-network-retrieval';
import { buildEvelynSystemPrompt, buildGeneSystemPrompt, EVELYN_NAME, GENE_NAME, EVELYN_VOICE_CONFIG, GENE_VOICE_CONFIG, isBiologySession } from './services/biology-persona';
import { buildClioSystemPrompt, buildMarcusSystemPrompt, CLIO_NAME, MARCUS_NAME, CLIO_VOICE_CONFIG, MARCUS_VOICE_CONFIG, isHistorySession } from './services/history-persona';
import { buildAdaSystemPrompt, buildLeoSystemPrompt, ADA_NAME, LEO_NAME, ADA_VOICE_CONFIG, LEO_VOICE_CONFIG, isMathSession } from './services/math-persona';
import { buildMorganSystemPrompt, buildSterlingSystemPrompt, MORGAN_NAME, STERLING_NAME, MORGAN_VOICE_CONFIG, STERLING_VOICE_CONFIG, isBusinessSession } from './services/business-persona';
import { getPredictiveTeachingContext, buildPredictiveTeachingSection, getStudentSnapshotData, buildStudentSnapshotSection, buildStudentMemoryAwarenessSection, type PredictiveTeachingContext, type StudentSnapshotContext } from './services/procedural-memory-retrieval';
import { founderCollabService } from './services/founder-collaboration-service';
import { studentLearningService } from './services/student-learning-service';
import { voiceDiagnostics } from './services/voice-diagnostics-service';
import type { VoiceSession as UsageVoiceSession, CompassContext, TutorSession } from '@shared/schema';
import { voiceGracePeriods, compartmentInstallation, messages, voiceSessions } from '@shared/schema';
import { db, getUserDb, getSharedDb } from './db';
import { eq, and, gt, lt, lte, ne, desc, sql } from 'drizzle-orm';
import { getPendingSuggestions } from './services/daniela-reflection';
import { generatePreSessionSynthesis, wrapSynthesisForSystemPrompt, consumeWarmSynthesis, getTuRevealFragment, getStewardshipReminderFragment } from './services/pre-session-synthesis';
import { autoResolveAbsenceNudgeOnReturn, applyAbsenceReturnFlag } from './services/daniela-absence-worker';
import { consumeBroadcastBrief } from './services/broadcast-data-service';
import { generateReflectionNow, schedulePendingReflectionIfMissing, buildTranscriptPreview, processAndClearPendingReflection, MIN_EXCHANGES_FOR_REFLECTION } from './services/session-reflection-worker';
import { generateAndStorePedagogicalBrief, MIN_EXCHANGES_FOR_BRIEF } from './services/pedagogical-brief-worker';
import { analyzeSessionForMasteryEvidence, MIN_EXCHANGES_FOR_MASTERY } from './services/mastery-evidence-worker';
import { evaluateAndUpdateTension, selectStyleShaper } from './services/tension-evaluator';
import { selectPedagogicalDirective, type CanvasMutation } from './services/pedagogical-planner';
import { glLiveAlert } from './services/gl-live-monitor';
import { combineVoiceMetricTotals } from './services/voice-exchange-accounting';
import { winDurableReconnectAuthority } from './services/reconnect-authority';
import { closeObservationBenchBySessionId } from './services/observation-bench-service';
import { runTerminalVoiceLifecycle } from './services/terminal-voice-lifecycle';

/**
 * End an exact durable usage session, then await best-effort Observation Bench
 * closure without changing endSession's return value.
 */
async function endDurableVoiceSession(
  sessionId: string,
  reason?: 'completed' | 'abandoned' | 'error',
  metrics?: () => Promise<unknown>,
) {
  return runTerminalVoiceLifecycle({
    metrics,
    end: () => usageService.endSession(sessionId, reason),
    cleanup: () => closeObservationBenchBySessionId({ sessionId }),
  });
}

// ── Canvas Mutation Executor ──────────────────────────────────────────────────
// Fires world mutations returned by the GOAP planner as whiteboard_update WS messages.
// Runs after the directive is sent so the canvas change feels like a consequence.
// drainVocab: true on primary/aftermath turns; false on quiet turns.
// Prevents the vocab mutation queue from being drained into a quiet-turn WS message
// and getting lost if the primary message supersedes it. (Gemini Q4 fix)
function fireCanvasMutations(session: any, mutations: CanvasMutation[], ws: any, drainVocab = true): void {
  // Drain vocab mutations from the lexical mastery tracker only when authorized.
  const vocabMutations: CanvasMutation[] = drainVocab ? (session?.pendingVocabMutations ?? []) : [];
  if (drainVocab && vocabMutations.length && session) session.pendingVocabMutations = [];
  const allMutations = [...mutations, ...vocabMutations];
  if (!allMutations.length || !session?.sceneCanvas) return;
  for (const mutation of allMutations) {
    if (mutation.type === 'set_prop_state') {
      const prop = (session.sceneCanvas.props as any[]).find(p => p.name === mutation.propName);
      if (!prop) continue;
      prop.state = mutation.state;
    } else if (mutation.type === 'remove_prop') {
      session.sceneCanvas.props = (session.sceneCanvas.props as any[]).filter(
        p => p.name !== mutation.propName,
      );
    }
    const update = {
      type: 'whiteboard_update',
      timestamp: Date.now(),
      items: [{
        id: 'scene-canvas-active',
        type: 'scene_canvas',
        content: session.sceneCanvas.environmentLabel || session.sceneCanvas.environment,
        data: {
          environment: session.sceneCanvas.environment,
          environmentImageUrl: session.sceneCanvas.environmentImageUrl,
          environmentLabel: session.sceneCanvas.environmentLabel,
          props: [...session.sceneCanvas.props],
          clockTime: session.sceneCanvas.clockTime,
          canvasAction: mutation.type,
        },
      }],
    };
    try { ws.send(JSON.stringify(update)); } catch (_) {}
    console.log(`[WorldMutation] ${mutation.type} prop="${mutation.propName}"${mutation.state ? ` state="${mutation.state}"` : ''}`);
  }
}

// Use /api/ paths - Replit's proxy properly routes these
const STREAMING_VOICE_PATH = '/api/voice/stream/ws';
const REALTIME_PATH = '/api/realtime/ws';
const TWILIO_STREAM_PATH = '/api/voice/twilio-stream';

/**
 * Gemini Live resumption handle persistence.
 *
 * Gemini sends a new resumption token on every completed turn.  We write it
 * to editor_insights (debounced to ≤1 write per 10s) so a hard server restart
 * doesn't lose the handle.  On reconnect we read it back and pass it to the
 * fresh GL session, giving Daniela full in-session memory across restarts.
 */
function makeHandlePersister(conversationId: string): (handle: string) => void {
  let timer: NodeJS.Timeout | null = null;
  let pendingHandle = '';
  return (handle: string) => {
    pendingHandle = handle;
    if (timer) return; // already scheduled — newest handle will be written
    timer = setTimeout(() => {
      timer = null;
      const h = pendingHandle;
      if (!h) return;
      const key = `gl_handle_${conversationId}`;
      getSharedDb().execute(sql`
        INSERT INTO editor_insights (id, category, title, content, importance, tags)
        VALUES (gen_random_uuid(), 'context', ${key}, ${h}, 1, ARRAY[]::text[])
      `).catch((e: Error) => console.warn('[ResumeHandle] Persist failed (non-fatal):', e.message));
    }, 10000); // 10-second debounce — coalesces rapid handle updates per turn
  };
}

/**
 * Remove any persisted GL resumption handle for a conversation.
 * Called when a session ends cleanly so stale handles don't accumulate.
 */
function clearPersistedHandle(conversationId: string): void {
  const key = `gl_handle_${conversationId}`;
  getSharedDb().execute(sql`
    DELETE FROM editor_insights WHERE title = ${key} AND category = 'context'
  `).catch(() => {});
}

/**
 * Promise timeout utility with automatic retry.
 *
 * Takes a FACTORY function (not a pre-started promise) so the operation can be
 * retried with a fresh query if the first attempt times out.
 *
 * Timing: 8s first attempt → 3s cooldown → 15s retry → fallback.
 * Total worst-case: ~26s (same ballpark as old 25s, but with a retry in the middle).
 *
 * Why this matters: during server restart the DB pool gets saturated by background
 * workers (EmbedIndexer, EmbedWorkers, etc.) for ~20-25s.  Without retry, every
 * SessionInit query times out and Daniela starts with ZERO context.  With retry,
 * the 3s cooldown is usually enough for pool pressure to drop and the second
 * attempt succeeds.
 */
const _FIRST_ATTEMPT_MS = 8000;
const _RETRY_DELAY_MS   = 3000;
const _RETRY_ATTEMPT_MS = 15000;

async function withTimeout<T>(
  factory: () => Promise<T>,
  _timeoutMs: number,   // kept for call-site readability; internal timing is fixed above
  label: string,
  fallback: T
): Promise<T> {
  // Discriminated union avoids Symbol sentinel so TypeScript inference stays clean.
  const attempt = (ms: number): Promise<{ ok: true; value: T } | { ok: false }> =>
    Promise.race([
      factory().then((value): { ok: true; value: T } => ({ ok: true, value })),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => resolve({ ok: false }), ms)
      ),
    ]);

  const r1 = await attempt(_FIRST_ATTEMPT_MS);
  if (r1.ok) return r1.value;

  console.warn(`[SessionInit] ⚠ ${label} timed out after ${_FIRST_ATTEMPT_MS}ms — retrying in ${_RETRY_DELAY_MS}ms`);
  await new Promise<void>((resolve) => setTimeout(resolve, _RETRY_DELAY_MS));

  const r2 = await attempt(_RETRY_ATTEMPT_MS);
  if (r2.ok) {
    console.log(`[SessionInit] ✓ ${label} succeeded on retry`);
    return r2.value;
  }

  console.warn(`[SessionInit] ⚠ ${label} timed out on retry — using fallback`);
  return fallback;
}

/**
 * Track active Socket.io connections per conversationId to prevent duplicates.
 * When a new connection arrives for an already-active conversation, the old one is closed.
 */
const activeVoiceConnections = new Map<string, VoiceWSConnection>();
// Maps socket.id → onPlaybackEnded callback so the Socket.io telemetry handler
// (in setupSocketIOHandler) can notify the GL session (in handleStreamingVoiceConnectionWithAdapter)
// when the client's audio finishes playing. These live in different function scopes, so a
// module-level bridge is required.
const glPlaybackEndedCallbacks = new Map<string, () => void>();
// Maps conversationId → callback that stores this connection's pending-reconnect grace
// data immediately. The Socket.io "duplicate connection" guard (setupSocketIOHandler)
// only *schedules* the old socket's close 350ms later so mid-sentence audio can finish,
// but storePendingReconnect() normally only runs from that old connection's own
// ws.on('close', ...) handler — leaving a race window where a fast client reconnect's
// start_session can arrive before the pending-reconnect entry exists, causing the new
// session to start cold instead of resuming. Registering this callback lets the duplicate
// guard call it synchronously the moment a replacement connection is detected, closing
// the race window. See docs/open-bugs.md (2026-07-10, reconnect grace claim race).
const duplicateReplacedCallbacks = new Map<string, () => void>();

/**
 * Dedup guard for concurrent SessionInit pipelines.
 * When a duplicate socket reconnect fires a second start_session for the same
 * conversationId while the first init is still running (both hit the DB pool
 * simultaneously, causing a timeout cascade), the second one is dropped here.
 * The Set is keyed by conversationId and cleared in the finally block.
 */
const sessionInitsInProgress = new Set<string>();

/**
 * Reconnection Grace Period System
 * 
 * When a WebSocket drops (infrastructure timeout, network hiccup), we DON'T immediately
 * end the usage session. Instead, we store it in this map with a grace timer.
 * If the client reconnects within the grace period, the session is RESUMED seamlessly
 * (same usage session, accumulated metrics carried over).
 * If the grace period expires without reconnection, the session is ended normally.
 */
interface PendingReconnectData {
  usageSessionId: string;
  compassSessionActive: boolean;
  exchangeCount: number;
  studentSpeakingSeconds: number;
  tutorSpeakingSeconds: number;
  ttsCharacters: number;
  sttSeconds: number;
  sessionStartTime: number;
  userId: string;
  conversationId: string;
  timer: NodeJS.Timeout;
  /** Orchestrator session ID — present for in-memory entries only (not persisted to DB).
   *  Used by armReconnectTimer to call persistReadingRoomCarryState() at true grace-expiry. */
  orchestratorSessionId?: string;
  /** Carry-forward state extracted from the session before endSession() removes it.
   *  Populated only for Reading Room sessions that are not incognito.
   *  Awaited by armReconnectTimer so the DB write completes before the timer resolves. */
  rrCarryState?: { notes: string[]; notesSaved: boolean; userId: string };
  /** Daniela's in-session scratchpad notes — carried across grace-period reconnects */
  sessionNotes?: string[];
  connectionId?: string;
  closeCode?: number;
  closeReason?: string;
  /** Resolves only after the exact durable grace row has been upserted. */
  persistencePromise?: Promise<void>;
}
const RECONNECT_GRACE_PERIOD_MS = 120000;
const pendingReconnectSessions = new Map<string, PendingReconnectData>();
// Correlates lifecycle evidence produced by this process without changing durable schema.
const VOICE_PROCESS_BOOT_ID = `${process.pid}-${Date.now().toString(36)}`;

/**
 * Extract sessionNotes from an active session for inclusion in the reconnect payload.
 * Called by both storePendingReconnect() paths so extraction logic stays testable.
 */
export function extractSessionNotesForReconnect(session: StreamingSession): string[] {
  const notes = (session as any).sessionNotes as string[] | undefined;
  return Array.isArray(notes) && notes.length > 0 ? [...notes] : [];
}

/**
 * Apply carried-over session notes onto a freshly created session after reconnect.
 * Called after orchestrator.createSession() when a pending reconnect payload contains notes.
 */
export function applyReconnectSessionNotes(session: StreamingSession, notes: string[]): void {
  if (notes.length > 0) {
    (session as any).sessionNotes = [...notes];
  }
}

/**
 * Deserialize sessionNotes from the DB column (JSON text) back to string[].
 * Shared by claimPendingReconnect() and hydratePendingReconnectsFromDb() so both
 * paths use identical parse/validate logic.
 */
export function deserializeSessionNotesFromDb(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
    console.warn('[Reconnect Grace] sessionNotes in DB is not an array — ignoring');
    return undefined;
  } catch {
    console.warn('[Reconnect Grace] Failed to parse sessionNotes JSON from DB — continuing without notes');
    return undefined;
  }
}

function armReconnectTimer(
  conversationId: string,
  pending: PendingReconnectData,
  delayMs: number
): NodeJS.Timeout {
  return setTimeout(async () => {
    // This is non-null by type and by storePendingReconnect's runtime guard.
    // Keep the defensive check at the async boundary: malformed legacy data must
    // never create evidence that claims an undefined voice-session identity.
    if (!pending.usageSessionId) {
      console.warn(`[Reconnect Grace] Ignoring timer without durable voiceSessionId (conv ${conversationId.substring(0, 8)})`);
      return;
    }
    const current = pendingReconnectSessions.get(conversationId);
    // A timer can already be queued when a replacement connection claims or replaces
    // this conversation. Never let that stale closure end the newer durable session.
    if (!current || current !== pending || current.usageSessionId !== pending.usageSessionId) {
      voiceTelemetry.log(pending.usageSessionId ?? conversationId, String(pending.userId ?? ''), 'grace_period_timer_stale', {
        voiceSessionId: pending.usageSessionId,
        conversationId,
        processBootId: VOICE_PROCESS_BOOT_ID,
        timerAction: 'ignored_stale',
      });
      return;
    }
    // Finalization must win the durable row before ending usage. If another
    // process claimed it, this timer is stale even if its local map survived.
    const wonFinalization = await winDurableReconnectAuthority(
      pending.persistencePromise ?? Promise.reject(new Error('missing reconnect persistence')),
      () => db.delete(voiceGracePeriods).where(and(
        eq(voiceGracePeriods.conversationId, conversationId),
        eq(voiceGracePeriods.usageSessionId, pending.usageSessionId),
        eq(voiceGracePeriods.userId, pending.userId),
        lte(voiceGracePeriods.expiresAt, new Date()),
      )).returning(),
    );
    if (!wonFinalization) {
      pendingReconnectSessions.delete(conversationId);
      voiceTelemetry.log(pending.usageSessionId, String(pending.userId ?? ''), 'grace_period_timer_stale', {
        voiceSessionId: pending.usageSessionId,
        conversationId,
        processBootId: VOICE_PROCESS_BOOT_ID,
        timerAction: 'db_claim_lost',
      });
      return;
    }
    pendingReconnectSessions.delete(conversationId);
    console.log(`[Reconnect Grace] Grace period expired for ${conversationId.substring(0, 8)} — ending session`);
    voiceTelemetry.log(current.usageSessionId ?? conversationId, String(current.userId ?? ''), 'grace_period_expired', {
      conversationId,
      voiceSessionId: current.usageSessionId,
      processBootId: VOICE_PROCESS_BOOT_ID,
      timerAction: 'expired_end',
      exchangeCount: current.exchangeCount,
    });
    glLiveAlert({
      sessionId: current.usageSessionId ?? conversationId,
      userId: current.userId ?? '',
      eventType: 'grace_expired',
      detail: { exchangeCount: current.exchangeCount, conversationId },
    });
    try {
      const endedSession = await endDurableVoiceSession(current.usageSessionId, 'abandoned', () => usageService.updateSessionMetrics(current.usageSessionId, {
        exchangeCount: current.exchangeCount,
        studentSpeakingSeconds: current.studentSpeakingSeconds,
        tutorSpeakingSeconds: current.tutorSpeakingSeconds,
        ttsCharacters: current.ttsCharacters,
        sttSeconds: current.sttSeconds,
      }));
      if (endedSession) {
        console.log(`[Reconnect Grace] Usage session ended: ${endedSession.durationSeconds}s, ${current.exchangeCount} exchanges`);
      }
    } catch (err: any) {
      console.error('[Reconnect Grace] Failed to end session:', err.message);
    }
    if (current.compassSessionActive) {
      try {
        await sessionCompassService.endSession(conversationId);
      } catch (err: any) {
        console.warn('[Reconnect Grace] Failed to end compass session:', err.message);
      }
    }
    // READING ROOM NOTES CARRY-FORWARD: persist notes now that the session has truly ended.
    // The endSession() call at WS close skips carry-forward for grace-eligible disconnects
    // (_deferCarryForward flag). We use the state captured at that time to write atomically here.
    // Awaited before the timer resolves so the DB write completes before any next-session load.
    if (current.rrCarryState) {
      try {
        await getStreamingVoiceOrchestrator().persistReadingRoomCarryState(current.rrCarryState);
      } catch (rrGraceErr: any) {
        console.warn('[ReadingRoom] Carry-forward via grace-expiry failed (non-fatal):', rrGraceErr.message);
      }
    }
  }, delayMs);
}

function storePendingReconnect(
  conversationId: string,
  data: Omit<PendingReconnectData, 'timer' | 'conversationId'>
): void {
  // usageSessionId is the durable voice_sessions identifier persisted in
  // voice_grace_periods. Refuse an incomplete close rather than creating a
  // conversation-only timer that could later claim/end another session.
  if (!data.usageSessionId) {
    console.warn(`[Reconnect Grace] Refusing to arm grace timer without durable voiceSessionId (conv ${conversationId.substring(0, 8)})`);
    return;
  }
  const existing = pendingReconnectSessions.get(conversationId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const entry: PendingReconnectData = { ...data, conversationId, timer: null as any };
  entry.timer = armReconnectTimer(conversationId, entry, RECONNECT_GRACE_PERIOD_MS);
  pendingReconnectSessions.set(conversationId, entry);
  console.log(`[Reconnect Grace] Stored pending session for ${conversationId.substring(0, 8)} (${RECONNECT_GRACE_PERIOD_MS / 1000}s grace)`);
  voiceTelemetry.log(entry.usageSessionId ?? conversationId, String(entry.userId ?? ''), 'grace_period_stored', {
    voiceSessionId: entry.usageSessionId,
    conversationId,
    processBootId: VOICE_PROCESS_BOOT_ID,
    connectionId: entry.connectionId,
    closeCode: entry.closeCode,
    closeReason: entry.closeReason,
    timerAction: 'armed',
    graceMs: RECONNECT_GRACE_PERIOD_MS,
  });

  // Persist for server-restart resilience. Claims/timers await this promise.
  // Serialize replacement writes behind the prior write so an older upsert can
  // never land after the replacement row and resurrect stale authority.
  // rrCarryNotes is the JSON-serialised Reading Room carry state — null for non-RR or incognito.
  // sessionNotes is the JSON-serialised general scratchpad — applies to all session types.
  const rrCarryNotesJson = data.rrCarryState ? JSON.stringify(data.rrCarryState) : null;
  const sessionNotesJson = data.sessionNotes?.length ? JSON.stringify(data.sessionNotes) : null;
  entry.persistencePromise = (existing?.persistencePromise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => db.insert(voiceGracePeriods).values({
    conversationId,
    usageSessionId: data.usageSessionId,
    compassSessionActive: data.compassSessionActive,
    exchangeCount: data.exchangeCount,
    studentSpeakingSeconds: data.studentSpeakingSeconds,
    tutorSpeakingSeconds: data.tutorSpeakingSeconds,
    ttsCharacters: data.ttsCharacters,
    sttSeconds: data.sttSeconds,
    sessionStartTime: data.sessionStartTime,
    userId: data.userId,
    expiresAt: new Date(Date.now() + RECONNECT_GRACE_PERIOD_MS),
    rrCarryNotes: rrCarryNotesJson,
    sessionNotes: sessionNotesJson,
  }).onConflictDoUpdate({
    target: voiceGracePeriods.conversationId,
    set: {
      usageSessionId: data.usageSessionId,
      compassSessionActive: data.compassSessionActive,
      exchangeCount: data.exchangeCount,
      studentSpeakingSeconds: data.studentSpeakingSeconds,
      tutorSpeakingSeconds: data.tutorSpeakingSeconds,
      ttsCharacters: data.ttsCharacters,
      sttSeconds: data.sttSeconds,
      sessionStartTime: data.sessionStartTime,
      userId: data.userId,
      expiresAt: new Date(Date.now() + RECONNECT_GRACE_PERIOD_MS),
      rrCarryNotes: rrCarryNotesJson,
      sessionNotes: sessionNotesJson,
    },
  }).then(() => undefined))
  .catch((err: Error) => {
    console.warn('[Reconnect Grace] DB write failed; durable reconnect authority unavailable:', err.message);
    throw err;
  });
  // Mark the stored rejection as observed; authority consumers still await the
  // original rejected promise and therefore fail closed.
  void entry.persistencePromise.catch(() => undefined);
}

async function claimPendingReconnect(conversationId: string, userId: string): Promise<PendingReconnectData | null> {
  // Fast path: check in-memory map first
  const pending = pendingReconnectSessions.get(conversationId);
  if (pending) {
    if (pending.userId !== userId) {
      console.warn(`[Reconnect Grace] User mismatch for ${conversationId.substring(0, 8)}: expected ${pending.userId}, got ${userId}`);
      return null;
    }
    const wonClaim = await winDurableReconnectAuthority(
      pending.persistencePromise ?? Promise.reject(new Error('missing reconnect persistence')),
      () => db.delete(voiceGracePeriods).where(and(
        eq(voiceGracePeriods.conversationId, conversationId),
        eq(voiceGracePeriods.usageSessionId, pending.usageSessionId),
        eq(voiceGracePeriods.userId, userId),
        gt(voiceGracePeriods.expiresAt, new Date()),
      )).returning(),
    );
    clearTimeout(pending.timer);
    if (pendingReconnectSessions.get(conversationId) === pending) {
      pendingReconnectSessions.delete(conversationId);
    }
    if (!wonClaim) {
      voiceTelemetry.log(pending.usageSessionId, userId, 'grace_period_claim_lost', {
        conversationId,
        voiceSessionId: pending.usageSessionId,
        processBootId: VOICE_PROCESS_BOOT_ID,
        reconnectClaim: 'db_claim_lost',
      });
      return null;
    }
    console.log(`[Reconnect Grace] RESUMED session for ${conversationId.substring(0, 8)} — carrying ${pending.exchangeCount} exchanges`);
    voiceTelemetry.log(pending.usageSessionId ?? conversationId, userId, 'grace_period_resumed', {
      conversationId,
      voiceSessionId: pending.usageSessionId,
      processBootId: VOICE_PROCESS_BOOT_ID,
      reconnectClaim: 'claimed',
      exchangeCount: pending.exchangeCount,
      path: 'memory',
    });
    return pending;
  }

  // DB fallback: handles server-restart scenario where in-memory map was cleared
  try {
    const rows = await db.select().from(voiceGracePeriods).where(
      and(
        eq(voiceGracePeriods.conversationId, conversationId),
        eq(voiceGracePeriods.userId, userId),
        gt(voiceGracePeriods.expiresAt, new Date())
      )
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    // Claim only the exact durable session selected above. A stale reconnect must not
    // delete a replacement grace row that reused this conversation id.
    const claimedRows = await db.delete(voiceGracePeriods).where(and(
      eq(voiceGracePeriods.conversationId, conversationId),
      eq(voiceGracePeriods.usageSessionId, row.usageSessionId),
      eq(voiceGracePeriods.userId, userId),
      gt(voiceGracePeriods.expiresAt, new Date()),
    )).returning();
    // Another process may have claimed/finalized this row after our lookup.
    // DELETE ... RETURNING is the authority: without its row this reconnect owns nothing.
    if (claimedRows.length === 0) return null;
    console.log(`[Reconnect Grace] RESUMED session from DB for ${conversationId.substring(0, 8)} after server restart — carrying ${row.exchangeCount} exchanges`);
    voiceTelemetry.log(row.usageSessionId ?? conversationId, userId, 'grace_period_resumed', {
      conversationId,
      voiceSessionId: row.usageSessionId,
      processBootId: VOICE_PROCESS_BOOT_ID,
      reconnectClaim: 'claimed',
      exchangeCount: row.exchangeCount,
      path: 'db_fallback',
    });
    // Restore rrCarryState from the durable JSON field so the grace timer can persist
    // Reading Room notes even after a server restart during the grace window.
    let claimedRrCarryState: PendingReconnectData['rrCarryState'] | undefined;
    if (row.rrCarryNotes) {
      try {
        claimedRrCarryState = JSON.parse(row.rrCarryNotes) as PendingReconnectData['rrCarryState'];
      } catch {
        console.warn('[Reconnect Grace] Failed to parse rrCarryNotes on DB claim (ignored)');
      }
    }
    return {
      conversationId: row.conversationId,
      usageSessionId: row.usageSessionId,
      compassSessionActive: row.compassSessionActive,
      exchangeCount: row.exchangeCount,
      studentSpeakingSeconds: row.studentSpeakingSeconds,
      tutorSpeakingSeconds: row.tutorSpeakingSeconds,
      ttsCharacters: row.ttsCharacters,
      sttSeconds: row.sttSeconds,
      sessionStartTime: row.sessionStartTime,
      userId: row.userId,
      timer: null as any,
      rrCarryState: claimedRrCarryState,
      sessionNotes: deserializeSessionNotesFromDb(row.sessionNotes),
    };
  } catch (err: any) {
    console.error('[Reconnect Grace] DB claim failed:', err.message);
    return null;
  }
}

async function hydratePendingReconnectsFromDb(): Promise<void> {
  try {
    const now = new Date();
    // Clean up expired entries first — fetch before deleting so we can end their
    // usage sessions. A plain DELETE leaves usage_sessions.ended_at = null forever,
    // which the concurrent-session guard then sees as a stale active session (the
    // root cause of 1300s zombie session blocks).
    const expiredRows = await db.select({
      usageSessionId: voiceGracePeriods.usageSessionId,
      conversationId: voiceGracePeriods.conversationId,
      exchangeCount: voiceGracePeriods.exchangeCount,
      studentSpeakingSeconds: voiceGracePeriods.studentSpeakingSeconds,
      tutorSpeakingSeconds: voiceGracePeriods.tutorSpeakingSeconds,
      ttsCharacters: voiceGracePeriods.ttsCharacters,
      sttSeconds: voiceGracePeriods.sttSeconds,
      rrCarryNotes: voiceGracePeriods.rrCarryNotes,
    }).from(voiceGracePeriods).where(lt(voiceGracePeriods.expiresAt, now));

    await db.delete(voiceGracePeriods).where(lt(voiceGracePeriods.expiresAt, now));

    for (const expired of expiredRows) {
      // Persist Reading Room carry-forward notes before ending the usage session.
      // This covers the "server restarted during grace window, session has now expired" path.
      if (expired.rrCarryNotes) {
        try {
          const carryState = JSON.parse(expired.rrCarryNotes) as PendingReconnectData['rrCarryState'];
          if (carryState) {
            await getStreamingVoiceOrchestrator().persistReadingRoomCarryState(carryState);
          }
        } catch (rrErr: any) {
          console.warn(`[Reconnect Grace] Carry-forward persist failed for expired session ${expired.conversationId.substring(0, 8)} (non-fatal):`, rrErr.message);
        }
      }
      endDurableVoiceSession(expired.usageSessionId, 'abandoned', () => usageService.updateSessionMetrics(expired.usageSessionId, {
        exchangeCount: expired.exchangeCount,
        studentSpeakingSeconds: expired.studentSpeakingSeconds,
        tutorSpeakingSeconds: expired.tutorSpeakingSeconds,
        ttsCharacters: expired.ttsCharacters,
        sttSeconds: expired.sttSeconds,
      }))
        .then(() => console.log(`[Reconnect Grace] Ended expired session ${expired.usageSessionId.substring(0, 8)} (conv ${expired.conversationId.substring(0, 8)}) on startup`))
        .catch((err: Error) => console.warn(`[Reconnect Grace] Failed to end expired session ${expired.usageSessionId.substring(0, 8)}:`, err.message));
    }
    if (expiredRows.length > 0) {
      console.log(`[Reconnect Grace] Ended ${expiredRows.length} expired session(s) that survived a server restart`);
    }

    // Load any unexpired entries (e.g., from before a server restart)
    const rows = await db.select().from(voiceGracePeriods).where(
      gt(voiceGracePeriods.expiresAt, now)
    );

    for (const row of rows) {
      const remainingMs = row.expiresAt.getTime() - Date.now();
      if (remainingMs <= 0) continue;
      // Restore rrCarryState from the durable JSON field so the grace timer fires
      // with the correct state even after a server restart.
      let hydratedRrCarryState: PendingReconnectData['rrCarryState'] | undefined;
      if (row.rrCarryNotes) {
        try {
          hydratedRrCarryState = JSON.parse(row.rrCarryNotes) as PendingReconnectData['rrCarryState'];
        } catch {
          console.warn(`[Reconnect Grace] Failed to parse rrCarryNotes for ${row.conversationId.substring(0, 8)} (ignored)`);
        }
      }
      const entry: PendingReconnectData = {
        conversationId: row.conversationId,
        usageSessionId: row.usageSessionId,
        compassSessionActive: row.compassSessionActive,
        exchangeCount: row.exchangeCount,
        studentSpeakingSeconds: row.studentSpeakingSeconds,
        tutorSpeakingSeconds: row.tutorSpeakingSeconds,
        ttsCharacters: row.ttsCharacters,
        sttSeconds: row.sttSeconds,
        sessionStartTime: row.sessionStartTime,
        userId: row.userId,
        timer: null as any,
        persistencePromise: Promise.resolve(),
        rrCarryState: hydratedRrCarryState,
        sessionNotes: deserializeSessionNotesFromDb(row.sessionNotes),
      };
      entry.timer = armReconnectTimer(row.conversationId, entry, remainingMs);
      pendingReconnectSessions.set(row.conversationId, entry);
    }

    if (rows.length > 0) {
      console.log(`[Reconnect Grace] Hydrated ${rows.length} pending session(s) from DB after restart`);
    }
  } catch (err: any) {
    console.error('[Reconnect Grace] DB hydration failed (non-fatal):', err.message);
  }
}

/**
 * Normalize language keys for consistent comparison
 * Handles variations like "mandarin" vs "mandarin chinese"
 */
function normalizeLanguageKey(lang: string): string {
  const lower = lang.toLowerCase().trim();
  if (lower === 'mandarin' || lower === 'mandarin chinese' || lower === 'chinese') {
    return 'mandarin chinese';
  }
  return lower;
}

/**
 * Gap 6: Update student pulse from incoming transcript text.
 * Simple heuristic frustration scorer — runs on every student utterance.
 * STT artifacts are common (David uses speech-to-text), so we use word-level
 * signals rather than exact string matching.
 */
function updateStudentPulse(session: any, text: string): void {
  if (!text?.trim()) return;
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // Initialize pulse if not present
  if (!session.studentPulse) {
    session.studentPulse = { frustrationScore: 0, signals: [], messageCount: 0 };
  }
  const pulse = session.studentPulse;
  pulse.messageCount += 1;

  // Decay score slightly toward calm on each message (frustration fades)
  pulse.frustrationScore = Math.max(0, pulse.frustrationScore * 0.85);

  // Signal: very short message (1-2 words after prior exchange) → possible disengagement
  if (wordCount <= 2) {
    pulse.frustrationScore = Math.min(10, pulse.frustrationScore + 1.2);
    pulse.signals.push(`short reply (${wordCount} word${wordCount === 1 ? '' : 's'})`);
  }

  // Signal: confusion keywords
  const confusionPatterns = ['don\'t understand', 'do not understand', 'no entiendo',
    'again', 'what', 'huh', 'wait wait', 'confused', 'confusing', 'lost',
    'sorry what', 'can you repeat', 'say that again', 'one more time'];
  const hasConfusion = confusionPatterns.some(p => lower.includes(p));
  if (hasConfusion) {
    pulse.frustrationScore = Math.min(10, pulse.frustrationScore + 1.8);
    pulse.signals.push('confusion signal detected');
  }

  // Signal: question marks at end of single-word utterances
  if (wordCount <= 3 && lower.endsWith('?')) {
    pulse.frustrationScore = Math.min(10, pulse.frustrationScore + 0.8);
    pulse.signals.push('short question');
  }

  // Signal: repetitive single-word answers
  const prevSignals = pulse.signals;
  const prevWasShort = prevSignals.length > 0 && prevSignals[prevSignals.length - 1].startsWith('short reply');
  if (prevWasShort && wordCount <= 2) {
    pulse.frustrationScore = Math.min(10, pulse.frustrationScore + 1.0);
    pulse.signals.push('repeated short reply');
  }

  // Cap signals array at 10 entries
  if (pulse.signals.length > 10) {
    pulse.signals = pulse.signals.slice(-10);
  }
}

/**
 * Socket.io to ws-compatible adapter
 * Allows existing handleStreamingVoiceConnection to work with Socket.io
 */
class SocketIOWebSocketAdapter implements VoiceWSConnection {
  static OPEN = 1;
  static CLOSED = 3;
  
  private socket: SocketIOSocket;
  private messageHandlers: Array<(data: Buffer | string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private pongHandlers: Array<() => void> = [];
  private _conversationId: string | null = null;

  /** The underlying Socket.io socket ID — used to bridge telemetry events to the GL session. */
  get socketId(): string { return this.socket.id; }

  constructor(socket: SocketIOSocket, conversationId: string | null) {
    this.socket = socket;
    this._conversationId = conversationId;
    
    // Forward Socket.io events to ws-style handlers
    socket.on('message', (data: any) => {
      // Handle both JSON and binary data
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
      this.messageHandlers.forEach(h => h(data));
    });
    
    socket.on('binary', (data: Buffer) => {
      this.messageHandlers.forEach(h => h(data));
    });
    
    socket.on('disconnect', () => {
      this.closeHandlers.forEach(h => h());
    });
    
    socket.on('error', (err: Error) => {
      this.errorHandlers.forEach(h => h(err));
    });
    
    // Socket.io handles pings internally, but we can emit pong for compatibility
    socket.on('ping', () => {
      this.pongHandlers.forEach(h => h());
    });
  }
  
  get readyState(): number {
    return this.socket.connected ? SocketIOWebSocketAdapter.OPEN : SocketIOWebSocketAdapter.CLOSED;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }
  
  send(data: string | Buffer): void {
    if (this.socket.connected) {
      if (Buffer.isBuffer(data)) {
        this.socket.emit('binary', data);
      } else {
        // Parse JSON string to object - Socket.io will serialize it properly
        // This prevents double-stringification where client receives a string instead of object
        try {
          const parsed = JSON.parse(data);
          
          // PROXY SAFE DELIVERY: Replit proxy silently drops large Socket.io messages
          // Strategy: Split any message with >50KB of audio into smaller deliverable parts
          
          // SENTENCE_READY FIX: sentence_ready contains embedded firstAudioChunk.audio
          // which can exceed proxy limits, causing the message to be silently dropped.
          // Fix: Strip audio from sentence_ready and send it as a separate audio_chunk.
          // Client handles sentence_ready with or without embedded audio.
          if (parsed.type === 'sentence_ready' && parsed.firstAudioChunk?.audio && parsed.firstAudioChunk.audio.length > 30000) {
            const audioData = parsed.firstAudioChunk.audio;
            const audioMeta = { ...parsed.firstAudioChunk };
            
            console.log(`[SOCKET EMIT] sentence_ready: SPLITTING (audio=${audioData.length} chars) - sending timings first, then audio_chunk`);
            
            // 1. Send sentence_ready WITHOUT audio (lightweight control message with timings)
            const lightweightReady = {
              ...parsed,
              firstAudioChunk: {
                ...audioMeta,
                audio: '',  // Strip audio - it will arrive as separate audio_chunk
                audioStripped: true,  // Signal to client that audio comes separately
              },
            };
            this.socket.emit('message', lightweightReady);
            
            // 2. Send the audio as a regular audio_chunk (goes through chunking if needed)
            const audioChunkMsg = {
              type: 'audio_chunk',
              timestamp: parsed.timestamp,
              turnId: parsed.turnId,
              sentenceIndex: parsed.sentenceIndex,
              chunkIndex: audioMeta.chunkIndex ?? 0,
              isLast: false,
              durationMs: audioMeta.durationMs,
              audio: audioData,
              audioFormat: audioMeta.audioFormat || 'pcm_f32le',
              sampleRate: audioMeta.sampleRate || 24000,
            };
            
            // Apply chunking to the extracted audio if needed
            if (audioData.length > 50000) {
              const CHUNK_SIZE = 50000;
              const totalChunks = Math.ceil(audioData.length / CHUNK_SIZE);
              for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, audioData.length);
                this.socket.emit('message', {
                  type: 'audio_chunk_part',
                  sentenceIndex: parsed.sentenceIndex,
                  chunkIndex: audioMeta.chunkIndex ?? 0,
                  partIndex: i,
                  totalParts: totalChunks,
                  audio: audioData.slice(start, end),
                  ...(i === 0 ? {
                    timestamp: parsed.timestamp,
                    turnId: parsed.turnId,
                    durationMs: audioMeta.durationMs,
                    audioFormat: audioMeta.audioFormat || 'pcm_f32le',
                    sampleRate: audioMeta.sampleRate || 24000,
                    isLast: false,
                  } : {}),
                  isFinalPart: i === totalChunks - 1,
                });
              }
            } else {
              this.socket.emit('message', audioChunkMsg);
            }
          }
          // CHUNKING: Large audio_chunk messages get dropped by Replit proxy
          // Split into smaller chunks (64KB base64 = ~48KB raw) for reliable delivery
          else if (parsed.type === 'audio_chunk' && parsed.audio && parsed.audio.length > 50000) {
            const CHUNK_SIZE = 50000; // 50KB chunks of base64
            const totalChunks = Math.ceil(parsed.audio.length / CHUNK_SIZE);
            console.log(`[SOCKET EMIT] audio_chunk: CHUNKING ${parsed.audio.length} bytes into ${totalChunks} chunks`);
            
            for (let i = 0; i < totalChunks; i++) {
              const start = i * CHUNK_SIZE;
              const end = Math.min(start + CHUNK_SIZE, parsed.audio.length);
              const chunkData = parsed.audio.slice(start, end);
              
              const chunkMsg = {
                type: 'audio_chunk_part',
                sentenceIndex: parsed.sentenceIndex,
                chunkIndex: parsed.chunkIndex,
                partIndex: i,
                totalParts: totalChunks,
                audio: chunkData,
                // Include full metadata only in first chunk
                ...(i === 0 ? {
                  timestamp: parsed.timestamp,
                  turnId: parsed.turnId,
                  durationMs: parsed.durationMs,
                  audioFormat: parsed.audioFormat,
                  sampleRate: parsed.sampleRate,
                  isLast: parsed.isLast,
                } : {}),
                // Mark final part
                isFinalPart: i === totalChunks - 1,
              };
              
              this.socket.emit('message', chunkMsg);
            }
          } else {
            if (parsed.type === 'audio_chunk' || parsed.type === 'word_timing' || parsed.type === 'sentence_ready') {
              console.log(`[SOCKET EMIT] ${parsed.type}: connected=${this.socket.connected}, dataLen=${data.length}`);
            }
            if (parsed.type === 'processing' || parsed.type === 'processing_pending' || parsed.type === 'feedback') {
              console.log(`[SOCKET EMIT CONTROL] Emitting '${parsed.type}' via socket.emit('message'): connected=${this.socket.connected}, socketId=${this.socket.id}`);
            }
            // Emit parsed object, not string - Socket.io handles serialization
            this.socket.emit('message', parsed);
            if (parsed.type === 'processing' || parsed.type === 'processing_pending') {
              console.log(`[SOCKET EMIT CONTROL] ✓ socket.emit('message', ${parsed.type}) completed`);
            }
          }
        } catch (e) {
          // Fallback: emit as-is if not valid JSON
          this.socket.emit('message', data);
        }
      }
    } else {
      // Debug: log when socket is not connected
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'audio_chunk' || parsed.type === 'word_timing') {
          console.log(`[SOCKET EMIT] SKIPPED ${parsed.type}: socket not connected`);
        }
      } catch (e) {}
    }
  }
  
  close(code?: number, reason?: string): void {
    this.socket.disconnect(true);
  }
  
  terminate(): void {
    this.socket.disconnect(true);
  }
  
  ping(): void {
    // Socket.io handles keep-alive internally
    // But we can emit a ping event for custom handling
    if (this.socket.connected) {
      this.socket.emit('ping');
    }
  }
  
  on(event: 'message' | 'close' | 'error' | 'pong', handler: (...args: any[]) => void): void {
    switch (event) {
      case 'message':
        this.messageHandlers.push(handler as (data: Buffer | string) => void);
        break;
      case 'close':
        this.closeHandlers.push(handler as () => void);
        break;
      case 'error':
        this.errorHandlers.push(handler as (error: Error) => void);
        break;
      case 'pong':
        this.pongHandlers.push(handler as () => void);
        break;
    }
  }
}

/**
 * Shared readyState constant for both transports.
 * SocketIOWebSocketAdapter.OPEN === NativeWSAdapter.OPEN === WS.OPEN === 1
 */
const WS_OPEN = 1;

/**
 * Common interface for both native WS and Socket.IO voice connections.
 * Allows handleStreamingVoiceConnectionShared to work with either transport.
 */
interface VoiceWSConnection {
  readonly readyState: number;
  readonly socketId: string;
  readonly conversationId: string | null;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message' | 'close' | 'error' | 'pong', handler: (...args: any[]) => void): void;
}

/**
 * Thin adapter that wraps a native WebSocket to satisfy VoiceWSConnection.
 * No message chunking needed — native WS bypasses the Replit proxy 50KB limit.
 */
class NativeWSAdapter implements VoiceWSConnection {
  static OPEN = WS.OPEN;   // = 1
  static CLOSED = WS.CLOSED; // = 3

  private ws: WS;
  private _conversationId: string | null;
  private _socketId: string;

  constructor(ws: WS, conversationId: string | null) {
    this.ws = ws;
    this._conversationId = conversationId;
    this._socketId = `native-ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  get readyState(): number { return this.ws.readyState; }
  get socketId(): string { return this._socketId; }
  get conversationId(): string | null { return this._conversationId; }

  send(data: string | Buffer): void {
    if (this.ws.readyState === WS.OPEN) this.ws.send(data);
  }
  close(code?: number, reason?: string): void { this.ws.close(code, reason); }
  terminate(): void { this.ws.terminate(); }
  ping(): void { this.ws.ping(); }

  on(event: 'message' | 'close' | 'error' | 'pong', handler: (...args: any[]) => void): void {
    this.ws.on(event as any, handler as any);
  }
}

/**
 * Convert ACTFL level to legacy difficulty level for system prompt compatibility
 * This bridges the organic ACTFL-based system with the legacy beginner/intermediate/advanced prompts
 */
function actflToDifficulty(actflLevel: string | null | undefined): 'beginner' | 'intermediate' | 'advanced' {
  if (!actflLevel) return 'beginner';
  const level = actflLevel.toLowerCase();
  
  if (level.includes('novice')) return 'beginner';
  if (level.includes('intermediate')) return 'intermediate';
  if (level.includes('advanced') || level.includes('superior') || level.includes('distinguished')) return 'advanced';
  
  return 'beginner'; // Safe default
}

/**
 * Extract userId from authenticated session cookie
 */
async function getUserIdFromSession(req: IncomingMessage): Promise<string | null> {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const cookies = parseCookie(cookieHeader);
    let sessionId = cookies['connect.sid'];
    
    if (!sessionId) return null;

    if (sessionId.startsWith('s:')) {
      sessionId = sessionId.slice(2);
      const unsigned = signature.unsign(sessionId, process.env.SESSION_SECRET!);
      if (unsigned === false) return null;
      sessionId = unsigned;
    }

    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.NEON_SHARED_DATABASE_URL!);
    
    const sessions = await sql`
      SELECT sess FROM sessions WHERE sid = ${sessionId}
    `;
    
    if (!sessions || sessions.length === 0) return null;

    const sessionData = sessions[0].sess as any;
    
    // Check password auth first (stores userId directly in session)
    if (sessionData?.userId) {
      console.log('[WS Auth] Authenticated via password session');
      return sessionData.userId;
    }
    
    // Fall back to Replit Auth / OIDC (stores in passport.user.claims.sub)
    const oidcSub = sessionData?.passport?.user?.claims?.sub;
    if (oidcSub) {
      console.log('[WS Auth] Authenticated via OIDC/Replit Auth');
    }
    return oidcSub || null;
  } catch (error) {
    console.error('[WS Auth] Error:', error);
    return null;
  }
}

/**
 * Track pending handoff intros - when a cross-language switch happens,
 * the old WebSocket closes before the intro can be delivered.
 * The new session picks this up and delivers the intro on the fresh connection.
 */
const pendingHandoffIntros = new Map<string, { tutorName: string; gender: 'male' | 'female'; language: string; timestamp: number }>();

// Canonical tutor names per language + gender.
// These override any raw voice-name that may be stored in the voiceName field
// (e.g. "Aoede", "Erinome") — raw voice names must never leak into tutor identity.
const LANGUAGE_TUTOR_NAMES: Record<string, { female: string; male: string }> = {
  spanish:            { female: 'Daniela',  male: 'Agustin'  },
  english:            { female: 'Cindy',    male: 'Blake'    },
  french:             { female: 'Juliette', male: 'Vincent'  },
  german:             { female: 'Greta',    male: 'Lukas'    },
  italian:            { female: 'Liv',      male: 'Luca'     },
  portuguese:         { female: 'Isabel',   male: 'Camilo'   },
  japanese:           { female: 'Sayuri',   male: 'Daisuke'  },
  'mandarin chinese': { female: 'Hua',      male: 'Tao'      },
  korean:             { female: 'Jihyun',   male: 'Minho'    },
  hebrew:             { female: 'Noa',      male: 'Eitan'    },
};

/**
 * Handle streaming voice WebSocket connection (native WS path).
 * All voice logic is unified in handleStreamingVoiceConnectionWithAdapter.
 * This thin shim wraps the native WS in NativeWSAdapter and delegates.
 */
/**
 * Handle Twilio Media Streams WebSocket connection (Phase 4 VoIP).
 *
 * Twilio does not pass URL query parameters through the Stream <url> attribute,
 * so all call identity (userId, queueId, HMAC nonce) arrives in the 'start'
 * event's customParameters field. The bridge handles all identity resolution.
 */
function handleTwilioStreamConnection(ws: WS, req: IncomingMessage) {
  import('./services/twilio-voip-bridge').then(({ handleTwilioMediaStream }) => {
    handleTwilioMediaStream(ws).catch((err: Error) => {
      console.error('[Unified WS] TwilioVoipBridge error:', err.message);
    });
  }).catch((err: Error) => {
    console.error('[Unified WS] Failed to import twilio-voip-bridge:', err.message);
    ws.close(1011, 'Bridge unavailable');
  });
}

function handleStreamingVoiceConnection(ws: WS, req: IncomingMessage) {
  let conversationId: string | null = null;
  try {
    const url = new URL(req.url || '', 'http://localhost');
    conversationId = url.searchParams.get('conversationId');
  } catch { /* ignore URL parse errors */ }
  const adapter = new NativeWSAdapter(ws, conversationId);
  handleStreamingVoiceConnectionWithAdapter(adapter, req);
}

/**
 * Handle realtime API WebSocket connection (placeholder - uses existing logic)
 */
async function handleRealtimeConnection(ws: WS, req: IncomingMessage) {
  console.log('[Realtime] Client connected');
  
  // Import and delegate to existing realtime handler logic
  const { handleRealtimeWebSocket } = await import('./realtime-handler');
  handleRealtimeWebSocket(ws, req);
}

/**
 * Setup unified WebSocket handler
 * 
 * CRITICAL: Uses prependListener to ensure this handler runs BEFORE Vite's HMR handler.
 * This prevents race conditions where multiple handlers try to process the same socket.
 * We mark handled sockets by destroying them from Vite's perspective.
 */
export function setupUnifiedWebSocketHandler(server: Server) {
  console.log('[Unified WS] Setting up unified WebSocket handler...');
  hydratePendingReconnectsFromDb().catch((err: Error) => {
    console.error('[Reconnect Grace] Hydration failed on startup:', err.message);
  });

  // Create a single WebSocketServer in noServer mode
  const wss = new WebSocketServer({ noServer: true });

  wss.on('error', (error) => {
    console.error('[Unified WS] Server error:', error);
  });

  // Track which sockets we've handled to prevent other handlers from interfering
  const handledSockets = new WeakSet<Duplex>();

  // Use prependListener to run BEFORE any other upgrade handlers (like Vite's HMR)
  // CRITICAL: We need to prevent Vite from touching sockets we handle
  server.prependListener('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // If another handler already processed this socket, skip
    if (handledSockets.has(socket)) {
      return;
    }

    let pathname = '';
    try {
      pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    } catch (e) {
      console.error('[Unified WS] Failed to parse URL:', request.url);
      socket.destroy();
      return;
    }

    console.log(`[Unified WS] Upgrade request for: ${pathname}`);

    if (pathname === STREAMING_VOICE_PATH || pathname === REALTIME_PATH || pathname === TWILIO_STREAM_PATH) {
      // Mark socket as handled IMMEDIATELY to prevent race conditions
      handledSockets.add(socket);
      
      console.log(`[Unified WS] Routing to ${pathname === STREAMING_VOICE_PATH ? 'streaming voice' : pathname === TWILIO_STREAM_PATH ? 'twilio media stream' : 'realtime'} handler`);
      console.log('[Unified WS] Socket state before handleUpgrade:', socket.destroyed ? 'DESTROYED' : 'OK', 'writable:', socket.writable);
      
      // CRITICAL: Resume the socket to ensure data flows
      // When using prependListener, the socket might be in a paused state
      socket.resume();
      
      // Handle the upgrade in a try/catch to ensure cleanup
      try {
        wss.handleUpgrade(request, socket, head, (ws) => {
          console.log('[Unified WS] handleUpgrade callback - WebSocket readyState:', ws.readyState);
          
          if (pathname === STREAMING_VOICE_PATH) {
            wss.emit('connection', ws, request);
            handleStreamingVoiceConnection(ws, request);
          } else if (pathname === TWILIO_STREAM_PATH) {
            wss.emit('connection', ws, request);
            handleTwilioStreamConnection(ws, request);
          } else {
            wss.emit('connection', ws, request);
            handleRealtimeConnection(ws, request);
          }
        });
      } catch (err) {
        console.error('[Unified WS] handleUpgrade error:', err);
        socket.destroy();
      }
    } else {
      // Let other handlers (like Vite HMR) process this
      console.log(`[Unified WS] Unknown path: ${pathname} - passing through`);
    }
  });

  console.log('[Unified WS] ✓ Unified WebSocket handler ready');
  console.log('[Unified WS] - Streaming Voice:', STREAMING_VOICE_PATH);
  console.log('[Unified WS] - Realtime API:', REALTIME_PATH);

  return wss;
}

// ============================================================================
// CLIENT TELEMETRY HANDLER (End-to-End Voice Diagnostics)
// ============================================================================

/**
 * In-memory store for correlating server-side events with client telemetry
 * Key: sessionId-sentenceIndex-chunkIndex
 */
interface ServerEmitRecord {
  sessionId: string;
  sentenceIndex: number;
  chunkIndex: number;
  emitTime: number;
  delivered: boolean;
  playedBack: boolean;
  clientReceiveTime?: number;
  clientPlaybackTime?: number;
}

const pendingServerEmits = new Map<string, ServerEmitRecord>();
const clientTelemetryEvents: ClientTelemetryEvent[] = [];
const MAX_TELEMETRY_EVENTS = 1000;

/**
 * Record a server-side audio emission for later correlation
 */
export function recordServerEmit(sessionId: string, sentenceIndex: number, chunkIndex: number) {
  const key = `${sessionId}-${sentenceIndex}-${chunkIndex}`;
  pendingServerEmits.set(key, {
    sessionId,
    sentenceIndex,
    chunkIndex,
    emitTime: Date.now(),
    delivered: false,
    playedBack: false,
  });
  
  // Clean up old records (older than 60 seconds)
  const cutoff = Date.now() - 60000;
  for (const [k, v] of Array.from(pendingServerEmits.entries())) {
    if (v.emitTime < cutoff) {
      pendingServerEmits.delete(k);
    }
  }
}

/**
 * Handle incoming client telemetry event
 */
function handleClientTelemetry(socketId: string, event: ClientTelemetryEvent) {
  console.log(`[CLIENT TELEMETRY] ${event.type} from ${socketId}`, {
    sessionId: event.sessionId,
    sentenceIndex: event.sentenceIndex,
    chunkIndex: event.chunkIndex,
    data: event.data,
  });
  
  // Store event for analysis
  clientTelemetryEvents.push(event);
  if (clientTelemetryEvents.length > MAX_TELEMETRY_EVENTS) {
    clientTelemetryEvents.shift();
  }
  
  // Correlate with server-side events
  if (event.sentenceIndex !== undefined && event.chunkIndex !== undefined) {
    const key = `${event.sessionId}-${event.sentenceIndex}-${event.chunkIndex}`;
    const serverRecord = pendingServerEmits.get(key);
    
    if (serverRecord) {
      if (event.type === 'audio_chunk_received' || event.type === 'audio_chunk_reassembled') {
        serverRecord.delivered = true;
        serverRecord.clientReceiveTime = event.timestamp;
        const deliveryLatency = serverRecord.clientReceiveTime - serverRecord.emitTime;
        console.log(`[TELEMETRY CORRELATION] Audio delivered in ${deliveryLatency}ms (sentence=${event.sentenceIndex}, chunk=${event.chunkIndex})`);
      }
      
      if (event.type === 'playback_started') {
        serverRecord.playedBack = true;
        serverRecord.clientPlaybackTime = event.timestamp;
        const e2eLatency = serverRecord.clientPlaybackTime - serverRecord.emitTime;
        console.log(`[TELEMETRY CORRELATION] End-to-end latency: ${e2eLatency}ms (sentence=${event.sentenceIndex})`);
      }
    }
  }
  
  // Log state changes for debugging avatar issues
  if (event.type === 'playback_state_change') {
    console.log(`[TELEMETRY STATE] Player: ${event.data?.fromState} -> ${event.data?.toState} (hasCallback: ${event.data?.hasCallback})`);
  }
}

/**
 * Get recent telemetry events for diagnostics dashboard
 * Enriches events with server-side correlation data
 */
export function getRecentTelemetryEvents(): (ClientTelemetryEvent & { deliveryLatencyMs?: number })[] {
  return clientTelemetryEvents.slice(-100).map(event => {
    const result: ClientTelemetryEvent & { deliveryLatencyMs?: number } = { ...event };
    
    // Try to correlate with server emit records
    if (event.sentenceIndex !== undefined && event.chunkIndex !== undefined) {
      const key = `${event.sessionId}-${event.sentenceIndex}-${event.chunkIndex}`;
      const serverRecord = pendingServerEmits.get(key);
      if (serverRecord && serverRecord.clientReceiveTime) {
        result.deliveryLatencyMs = serverRecord.clientReceiveTime - serverRecord.emitTime;
      }
    }
    
    return result;
  });
}

/**
 * Get pending server emits for correlation analysis
 */
export function getPendingServerEmits(): ServerEmitRecord[] {
  return Array.from(pendingServerEmits.values());
}

/**
 * Setup Socket.io handler for voice streaming
 * 
 * Socket.io handles transport negotiation automatically (WebSocket → polling fallback)
 * This works reliably through Replit's proxy which can interfere with raw WebSocket upgrades
 */
export function setupSocketIOHandler(io: SocketIOServer) {
  console.log('[Socket.io] Setting up voice streaming namespace...');
  
  // Use a dedicated namespace for voice streaming
  const voiceNs = io.of('/voice');
  
  voiceNs.on('connection', (socket: SocketIOSocket) => {
    console.log('[Socket.io Voice] Client connected:', socket.id);
    
    // Extract conversationId from handshake query
    const conversationId = socket.handshake.query.conversationId as string || null;
    console.log('[Socket.io Voice] ConversationId:', conversationId);
    
    socket.on('heartbeat', () => {
      socket.emit('heartbeat_ack');
    });
    
    socket.on('client_telemetry', (event: any) => {
      handleClientTelemetry(socket.id, event);
      // When client finishes playing Daniela's audio, open the echo-suppression mic gate.
      // glPlaybackEndedCallbacks bridges this telemetry scope to the GL session scope where
      // geminiLiveSession lives (handleStreamingVoiceConnectionWithAdapter).
      if (event.type === 'playback_ended') {
        glPlaybackEndedCallbacks.get(socket.id)?.();
      }
    });
    
    socket.on('client_telemetry_batch', (events: any[]) => {
      events.forEach(event => {
        handleClientTelemetry(socket.id, event);
        if (event.type === 'playback_ended') {
          glPlaybackEndedCallbacks.get(socket.id)?.();
        }
      });
    });
    
    // Create adapter that makes Socket.io look like ws
    const adapter = new SocketIOWebSocketAdapter(socket, conversationId);
    
    // DUPLICATE CONNECTION GUARD: Close old connection if a new one arrives for the same conversation.
    // Uses a 350ms grace period so any audio mid-sentence finishes before the old socket closes.
    if (conversationId) {
      const existing = activeVoiceConnections.get(conversationId);
      if (existing && existing.readyState === SocketIOWebSocketAdapter.OPEN) {
        console.warn(`[Socket.io Voice] ⚠ Duplicate connection for ${conversationId} — scheduling close of old one (${existing.socketId}) in 350ms`);
        const stale = existing;
        // Fast reconnects race the delayed close below: store the OLD connection's
        // pending-reconnect grace data NOW (synchronously) instead of waiting for its
        // close handler to fire, so a start_session arriving from the new connection
        // within the 350ms window still finds the entry. See docs/open-bugs.md
        // (2026-07-10, reconnect grace claim race).
        duplicateReplacedCallbacks.get(conversationId)?.();
        setTimeout(() => {
          try { if (stale.readyState === SocketIOWebSocketAdapter.OPEN) stale.close(4000, 'Replaced by new connection'); } catch (e) { /* ignore */ }
        }, 350);
      }
      activeVoiceConnections.set(conversationId, adapter);
      
      // Clean up tracking when this connection closes
      socket.on('disconnect', () => {
        if (activeVoiceConnections.get(conversationId) === adapter) {
          activeVoiceConnections.delete(conversationId);
        }
      });
    }
    
    // Create a mock IncomingMessage for the handler
    const mockReq = {
      url: `/api/voice/stream/ws?conversationId=${conversationId || ''}`,
      headers: socket.handshake.headers,
    } as IncomingMessage;
    
    // Reuse existing handler with adapter
    handleStreamingVoiceConnectionWithAdapter(adapter, mockReq);
  });
  
  console.log('[Socket.io] ✓ Voice streaming ready on /voice namespace');
}

/**
 * Handle streaming voice connection — unified handler for all transports.
 * Called by both the native WS path (via NativeWSAdapter) and the Socket.IO path
 * (via SocketIOWebSocketAdapter). All voice logic lives here; transport differences
 * are encapsulated entirely in the adapter layer.
 */
function handleStreamingVoiceConnectionWithAdapter(ws: VoiceWSConnection, req: IncomingMessage) {
  console.log('[Streaming Voice] Client connected');

  const orchestrator = getStreamingVoiceOrchestrator();
  let session: StreamingSession | null = null;
  let bootstrapProfile: string | null = null;
  let userId: string | null = null;
  let isAuthenticated = false;
  // Guards against storing the pending-reconnect snapshot twice — once via the
  // duplicate-connection early-replace callback, once via the normal close handler.
  let pendingReconnectAlreadyStored = false;
  
  // Gemini Live voice session (feature-flagged via GEMINI_LIVE_VOICE=true)
  let geminiLiveSession: GeminiLiveSession | null = null;
  // OpenAI GPT Realtime voice session — selected per (language, gender) when the
  // resolved tutor voice's provider is 'openai-realtime'. Mutually exclusive with
  // geminiLiveSession: exactly one (or neither, on the legacy pipeline) is active.
  let openaiRealtimeSession: OpenAIRealtimeSession | null = null;
  // Stable route ownership for this connection. A selected live provider keeps
  // ownership even if its upstream socket is starting or fails, so no race or
  // failure can silently re-enter the legacy STT/response pipeline.
  let selectedLiveVoiceRoute: LiveVoiceRoute = 'legacy';
  let liveVoiceFailureMessage: string | null = null;
  // Cached system prompt for the Gemini Live session — needed to restart with a new voice
  let geminiLiveSystemPromptCache = '';
  // Prevent duplicate greeting triggers — client may retry if audio is slow
  let geminiLiveGreetingSent = false;
  // Captured at voice_init so the close handler can pass it to tagConversation
  let sessionLanguage = 'english';

  // Open mic mode state
  let openMicSession: OpenMicSession | null = null;
  let openMicPendingChunks: Buffer[] = [];
  let openMicSessionStarting = false;
  let currentInputMode: VoiceInputMode = 'push-to-talk';
  // Track how many times open-mic has failed to start in this connection.
  // After 2+ failures we suggest the user switch to push-to-talk.
  let openMicStartFailCount = 0;
  
  // Echo suppression safety timeout (Socket.io path)
  const ECHO_SUPPRESSION_MAX_MS_SO = 30000;
  let echoSuppressionTimeoutSO: NodeJS.Timeout | null = null;
  
  // Speculative PTT state (stream audio during PTT for faster response)
  let speculativePttSession: OpenMicSession | null = null;
  let speculativePttPendingChunks: Buffer[] = [];
  let speculativePttSessionStarting = false;
  let speculativePttTranscript = '';
  let speculativePttWordCount = 0;
  let speculativePttTriggered = false;
  let speculativePttTranscriptUsed = '';
  let speculativePttSessionId = 0;
  let speculativePttGotFinal = false;
  
  // Pending speculative transcript - set on PTT release, consumed by audio_data
  // This allows bypassing redundant STT when we already have real-time transcript
  let pendingSpeculativeTranscript: string | null = null;
  let pendingSpeculativeWordCount = 0;
  const SPECULATIVE_TRANSCRIPT_MIN_WORDS = 2;  // Minimum words to use speculative transcript
  // DISABLED: Speculative AI triggering during PTT causes Daniela to respond to incomplete sentences
  // When user pauses mid-thought while holding button, AI would trigger on partial transcript
  // Set to 999 to effectively disable - user's complete utterance is processed on button release
  const PTT_SPECULATIVE_AI_ENABLED = process.env.PTT_SPECULATIVE_AI_ENABLED === 'true';
  const SPECULATIVE_AI_TRIGGER_WORDS = PTT_SPECULATIVE_AI_ENABLED ? 3 : 999;
  let speculativeAiInProgress = false;  // Whether speculative AI is currently generating
  let speculativeAiAccepted = false;  // Whether speculative AI result was accepted (skip audio_data)
  let pttReleaseInProgress = false;  // RACE GUARD: True while ptt_release handler is processing (has async awaits)
  
  // Usage tracking state
  let usageSession: UsageVoiceSession | null = null;
  let exchangeCount = 0;
  let studentSpeakingSeconds = 0;
  let tutorSpeakingSeconds = 0;
  let ttsCharacters = 0;
  let sttSeconds = 0;

  // Base counters contain legacy activity plus totals carried from prior
  // connections. The current Gemini Live object contains only this connection's
  // delta. Keep this read-only so periodic sync, duplicate replacement, clean
  // close, disconnect, and error paths all observe the same total without
  // folding the same GL delta into the base twice.
  const getCurrentVoiceMetricsSnapshot = () => {
    const glSpeaking = geminiLiveSession?.getSpeakingStats();
    return combineVoiceMetricTotals(
      {
        exchangeCount,
        studentSpeakingSeconds,
        tutorSpeakingSeconds,
        ttsCharacters,
        sttSeconds,
      },
      geminiLiveSession
        ? {
            exchangeCount: geminiLiveSession.getCompletedExchangeCount(),
            studentSpeakingMs: glSpeaking?.studentSpeakingMs ?? 0,
            tutorSpeakingMs: glSpeaking?.tutorSpeakingMs ?? 0,
            outputCharacters: geminiLiveSession.getTotalOutputCharacters(),
          }
        : null,
    );
  };
  
  // Compass session state
  let compassSession: TutorSession | null = null;
  let compassContext: CompassContext | null = null;
  let sessionStartTime = 0;

  // GL idle timeout — closes session if no client audio for 5 minutes
  // Prevents zombie sessions from accumulating when user leaves the tab open
  const GL_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  let glIdleTimeoutHandle: NodeJS.Timeout | null = null;

  // GL periodic metrics sync — writes accumulated GL metrics to DB every 2 minutes
  // so zombie cleanup captures real data even if the session is never cleanly ended
  const GL_METRICS_SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  let glMetricsSyncHandle: NodeJS.Timeout | null = null;

  // Tutor no-response watchdog — fires a Sofia flare if Daniela produces no audio
  // within 90s of GL session start (GL API hang or network issue to Gemini)
  const GL_TUTOR_RESPONSE_TIMEOUT_MS = 90 * 1000; // 90 seconds
  let tutorNoResponseWatchdog: NodeJS.Timeout | null = null;
  
  const conversationId = ws.conversationId;
  let pendingVoiceUpdate: 'male' | 'female' | null = null;
  let voiceUpdateInProgress = false;

  // Send connected confirmation immediately
  const sendConnected = () => {
    try {
      if (ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({
          type: 'connected',
          timestamp: Date.now(),
        }));
        console.log('[Streaming Voice] Connected message sent');
      } else {
        setTimeout(sendConnected, 50);
      }
    } catch (err) {
      console.error('[Streaming Voice] Error sending connected:', err);
    }
  };
  
  setImmediate(sendConnected);

  // NOTE: Socket.io handles keepalive internally via Engine.IO ping/pong
  // We do NOT run a custom heartbeat here - that was causing premature disconnects
  // during large TTS audio transmission (no inbound messages to reset counter)

  // Message handler - delegate to shared logic
  ws.on('message', async (data: Buffer | string) => {
    console.log('[Streaming Voice] Message received');
    
    try {
      const dataStr = Buffer.isBuffer(data) ? data.toString('utf-8') : 
                      (typeof data === 'object' ? JSON.stringify(data) : data);
      
      let message: any = null;
      try {
        message = typeof data === 'object' && !Buffer.isBuffer(data) ? data : JSON.parse(dataStr);
        console.log('[Streaming Voice] Parsed message type:', message.type);
      } catch (e) {
        // Binary audio data
        if (!isAuthenticated) {
          sendErrorAdapter(ws, 'UNAUTHORIZED', 'Not authenticated', false);
          return;
        }
        
        // CRITICAL: If speculative AI is in progress or already accepted, skip this blob entirely
        // The response is already streaming from the speculative call - processing this would cause dual audio streams
        // NOTE: Heartbeat is already reset above (missedPongs = 0) before this check, so suppression doesn't affect keep-alive
        if (speculativeAiAccepted || speculativeAiInProgress) {
          console.log(`[SpeculativePTT] PHASE 2: Skipping binary audio blob - speculative AI ${speculativeAiInProgress ? 'in progress' : 'already accepted'}`);
          if (speculativeAiAccepted) {
            speculativeAiAccepted = false;  // Reset for next turn only if accepted (in-progress will be reset by ptt_release)
          }
          return;
        }
        
        if (session) {
          const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as string);

          // GL path: binary blobs are treated the same as stream_audio_chunk — relay to Live session.
          // Reset idle timer on ANY mic audio, even if geminiLiveSession is momentarily null
          // (e.g. mid-reconnect) — real user activity should never be dropped by that race.
          {
            const resetTimerAlways = (ws as any).__resetGlIdleTimer as (() => void) | undefined;
            if (resetTimerAlways) resetTimerAlways();
          }
          // Also keep the orchestrator's lastActivityTime fresh so the session monitor
          // doesn't flag active GL sessions as stalled (GL audio bypasses the STT path
          // that normally calls resetIdleTimeout).
          if (session) orchestrator.resetIdleTimeoutForSession(session.id);
          if (selectedLiveVoiceRoute !== 'legacy') {
            if (selectedLiveVoiceRoute === 'gemini-live' && geminiLiveSession) {
              geminiLiveSession.sendAudioChunk(audioBuffer);
            } else if (selectedLiveVoiceRoute === 'openai-realtime' && openaiRealtimeSession) {
              openaiRealtimeSession.sendAudioChunk(audioBuffer);
            } else if (liveVoiceFailureMessage) {
              sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
            }
            return;
          }

          // SPECULATIVE PTT BYPASS: If we have a pending speculative transcript,
          // skip the expensive blob STT and go straight to AI generation
          if (pendingSpeculativeTranscript && pendingSpeculativeWordCount >= SPECULATIVE_TRANSCRIPT_MIN_WORDS) {
            const transcriptToUse = pendingSpeculativeTranscript;
            const wordCount = pendingSpeculativeWordCount;
            
            // Clear the pending transcript immediately to prevent reuse
            pendingSpeculativeTranscript = null;
            pendingSpeculativeWordCount = 0;
            
            console.log(`[SpeculativePTT] BYPASS: Using speculative transcript (${wordCount} words), skipping blob STT`);
            console.log(`[SpeculativePTT] Transcript: "${transcriptToUse}"`);
            
            // Use processOpenMicTranscript which skips STT entirely
            await orchestrator.processOpenMicTranscript(session.id, transcriptToUse, 1.0);
          } else {
            // Fallback: No speculative transcript available, process blob normally
            if (pendingSpeculativeTranscript) {
              console.log(`[SpeculativePTT] Transcript too short (${pendingSpeculativeWordCount} words), falling back to blob STT`);
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
            }
            await orchestrator.processUserAudio(session.id, audioBuffer, 'webm');
          }
        }
        return;
      }

      // Handle message types - full support for voice streaming
      switch (message.type) {
        case 'start_session': {
          if (!isAuthenticated) {
            userId = await getUserIdFromSession(req);
            if (!userId) {
              sendErrorAdapter(ws, 'UNAUTHORIZED', 'Authentication required', false);
              ws.close(4401, 'Unauthorized');
              return;
            }
            isAuthenticated = true;
            console.log('[Streaming Voice] ✓ Authenticated userId:', userId);
          }
          
          const config = message as ClientStartSessionMessage;
          let isReconnectSO = config.isReconnect === true;
          const tutorGender = config.tutorGender || 'female';
          const rawHonestyMode = config.rawHonestyMode || false;

          // ── Implicit reconnect detection ─────────────────────────────────────
          // If the client sends start_session WITHOUT isReconnect:true but there is
          // an active grace period for this exact conversationId, the client dropped
          // and reconnected but lost its lastSessionConfig (e.g. page navigation,
          // broadcast-mode UI transition, app backgrounded). Treat it as a reconnect
          // so context is preserved rather than destroyed.
          if (!isReconnectSO && conversationId) {
            const implicitPending = pendingReconnectSessions.get(conversationId);
            if (implicitPending && implicitPending.userId === String(userId)) {
              console.log(`[Reconnect Grace] Implicit reconnect detected for ${conversationId.substring(0, 8)} — client lost isReconnect flag, promoting to reconnect`);
              isReconnectSO = true;
            }
          }

          console.log(`[Streaming Voice] Processing start_session (Socket.io)${isReconnectSO ? ' (RECONNECT — will skip greeting)' : ''}`);

          // ── Concurrent session guard ────────────────────────────────────────
          // Prevent a student from opening two simultaneous billing sessions.
          // Strategy: if an existing active session is found, auto-end it rather than
          // hard-blocking the user. This handles:
          //   (a) Grace-period sessions (user just ended and is starting fresh)
          //   (b) Zombie sessions (disconnect without proper cleanup)
          //   (c) True concurrent sessions (different tab/device) — older session loses
          // Very-recent sessions (< 90 s) are allowed through without touching the DB
          // to handle quick page reloads that haven't sent start_session yet.
          if (!isReconnectSO) {
            try {
              const existingActiveSession = await usageService.getActiveSession(String(userId));
              if (existingActiveSession) {
                const ageSeconds = (Date.now() - new Date(existingActiveSession.startedAt).getTime()) / 1000;
                if (ageSeconds > 90) {
                  console.warn(`[ConcurrentGuard] Found stale active session ${existingActiveSession.id.substring(0, 8)} (age ${Math.round(ageSeconds)}s) for user ${userId} — auto-ending and allowing new session`);

                  // Cancel grace-period timers for OTHER conversations by this user.
                  // If the pending reconnect is for the same conversationId, the implicit
                  // reconnect check above would have already set isReconnectSO=true, so
                  // we will never reach this block for same-conversation reconnects.
                  for (const [convId, entry] of pendingReconnectSessions) {
                    if (entry.userId === String(userId) && convId !== conversationId) {
                      clearTimeout(entry.timer);
                      pendingReconnectSessions.delete(convId);
                      db.delete(voiceGracePeriods)
                        .where(eq(voiceGracePeriods.conversationId, convId))
                        .catch(() => {});
                      console.log(`[ConcurrentGuard] Cancelled grace-period timer for conv ${convId.substring(0, 8)}`);
                      break;
                    }
                  }

                  // End the stale DB record so billing is clean
                  endDurableVoiceSession(existingActiveSession.id).catch((err: Error) => {
                    console.warn('[ConcurrentGuard] Failed to end stale session:', err.message);
                  });

                  // Fall through — do NOT block the new session
                } else {
                  // Age ≤ 90 s — allow through (likely a reconnect or quick page reload)
                  console.log(`[ConcurrentGuard] User ${userId} has recent session (age ${Math.round(ageSeconds)}s) — allowing through`);
                }
              }
            } catch (guardErr: any) {
              // Don't block the session on guard errors — log and continue
              console.warn('[ConcurrentGuard] Guard check failed (allowing through):', guardErr.message);
            }
          }

          // ── Duplicate-init guard ────────────────────────────────────────────
          // A duplicate socket reconnect can fire a second start_session for the same
          // conversationId while the first full 18-query init is still running, causing
          // both pipelines to compete for the Neon connection pool and timeout-cascade.
          // Drop the duplicate — the first init will complete and the GeminiLive session
          // will be ready. (Does not apply to explicit reconnects, which need a fresh init.)
          if (conversationId && !isReconnectSO && sessionInitsInProgress.has(conversationId)) {
            console.warn(`[SessionInit] ⚠ Duplicate start_session for conv ${conversationId.substring(0, 8)} already in progress — skipping to prevent DB pool saturation`);
            break;
          }
          if (conversationId && !isReconnectSO) sessionInitsInProgress.add(conversationId);

          try {
            const initStart = Date.now();
            const SESSION_INIT_TIMEOUT = 25000; // 25s timeout — gives headroom during boot-time DB pool saturation
            // (Background workers can hold pool slots for ~15-20s during the first 70s after restart;
            //  10s was not enough when VocabImageSeed + Prefetch + Wren fired simultaneously.)
            console.log(`[SessionInit] Starting session init pipeline...`);
            
            // ══════════════════════════════════════════════════════════════
            // PHASE 1: Parallel DB lookups (all independent, all with timeouts)
            // These queries previously ran SEQUENTIALLY, causing 10s+ stalls
            // when any single query hung. Now they run in parallel with 3s timeouts.
            // ══════════════════════════════════════════════════════════════
            const effectiveLanguage = normalizeLanguageKey(config.targetLanguage || 'spanish');
            sessionLanguage = effectiveLanguage; // capture for close handler title generation

            // Which provider Voice Console currently has active (admin-controlled,
            // persists across restarts — see storage.ts's setActiveTutorVoiceProvider).
            // Single fast row lookup; kept out of the Promise.all below because the
            // tutorVoice query needs its result as an input.
            const activeVoiceProvider = await storage.getActiveTutorVoiceProvider();

            const [user, conversation_raw, isDeveloper, messages, tutorVoice, actflProgressRow] = await Promise.all([
              withTimeout(
                () => userId ? storage.getUser(userId) : Promise.resolve(null),
                SESSION_INIT_TIMEOUT, 'getUser', null
              ),
              withTimeout(
                () => (conversationId && userId) ? storage.getConversation(conversationId, userId) : Promise.resolve(null),
                SESSION_INIT_TIMEOUT, 'getConversation', null
              ),
              withTimeout(
                () => usageService.checkDeveloperBypass(userId!),
                SESSION_INIT_TIMEOUT, 'checkDeveloperBypass', false
              ),
              withTimeout(
                () => conversationId ? storage.getMessagesByConversation(conversationId) : Promise.resolve([]),
                SESSION_INIT_TIMEOUT, 'getMessages', [] as any[]
              ),
              withTimeout(
                // Prefer the active provider's voice for this language+gender; falls
                // back to whatever tutor voice IS configured (any provider) if this
                // student's language+gender hasn't been set up for the active provider
                // yet — see getTutorVoice's fallback chain in storage.ts.
                () => storage.getTutorVoice(effectiveLanguage, tutorGender, activeVoiceProvider),
                SESSION_INIT_TIMEOUT, 'getTutorVoice', null
              ),
              // users.actfl_level is rarely populated — pull from actfl_progress per language.
              // This is the same fix applied to the Twilio bridge. Runs in parallel so zero extra latency.
              withTimeout(
                () => (userId && effectiveLanguage)
                  ? storage.getOrCreateActflProgress(effectiveLanguage, String(userId))
                  : Promise.resolve(null),
                SESSION_INIT_TIMEOUT, 'getActflProgress', null
              ),
            ]);
            
            const phase1Ms = Date.now() - initStart;
            console.log(`[SessionInit] Phase 1 (parallel DB lookups) completed in ${phase1Ms}ms`);

            // Resolve the live engine from the tutor voice that was actually selected.
            // GEMINI_LIVE_VOICE_ENABLED is only an availability gate; it must never
            // override an explicit Cartesia, ElevenLabs, Google, or other provider.
            const resolvedVoiceProvider = (tutorVoice as any)?.provider as string | undefined;
            const liveVoiceRoute = resolveLiveVoiceRoute(
              resolvedVoiceProvider,
              GEMINI_LIVE_VOICE_ENABLED,
            );
            selectedLiveVoiceRoute = liveVoiceRoute;
            liveVoiceFailureMessage = null;
            const useOpenAIRealtime = liveVoiceRoute === 'openai-realtime';
            if (useOpenAIRealtime) {
              console.log(`[SessionInit] Tutor voice provider is 'openai-realtime' — routing this session to OpenAI GPT Realtime instead of Gemini Live`);
            } else if (
              (resolvedVoiceProvider === 'gemini-live' || resolvedVoiceProvider === 'gemini-live-35')
              && liveVoiceRoute === 'legacy'
            ) {
              console.warn(`[SessionInit] Tutor voice provider '${resolvedVoiceProvider}' selected while Gemini Live is disabled — using the legacy voice pipeline`);
            }

            // ══════════════════════════════════════════════════════════════
            // SESSION CONTEXT CACHE: On reconnect after a server restart,
            // check for a fresh cached system prompt to skip Phase 2 & 3
            // (the expensive 12-query enrichment + prompt assembly).
            // This cuts reconnect init from 10-25s to < 1s.
            // Cache lives in editor_insights (category='context') for up to 4h.
            // ══════════════════════════════════════════════════════════════
            let cachedContextPrompt: string | null = null;
            // GL resumption handle from a previous server process — injected into
            // the StreamingSession so Gemini can resume in-session context across restarts.
            let restoredGlHandle: string | null = null;
            if (isReconnectSO && userId && conversationId) {
              try {
                const cacheKey = `session_ctx_${userId}_${conversationId}`;
                const handleKey = `gl_handle_${conversationId}`;
                const [cacheRows, handleRows] = await Promise.all([
                  getSharedDb().execute(sql`
                    SELECT content FROM editor_insights
                    WHERE title = ${cacheKey} AND category = 'context'
                    AND created_at > NOW() - INTERVAL '4 hours'
                    ORDER BY created_at DESC LIMIT 1
                  `),
                  getSharedDb().execute(sql`
                    SELECT content FROM editor_insights
                    WHERE title = ${handleKey} AND category = 'context'
                    AND created_at > NOW() - INTERVAL '4 hours'
                    ORDER BY created_at DESC LIMIT 1
                  `),
                ]);
                if (cacheRows.rows.length > 0) {
                  cachedContextPrompt = cacheRows.rows[0].content as string;
                  console.log(`[SessionCache] ✓ Reconnect cache hit (${cachedContextPrompt.length} chars) — skipping Phase 2 & 3`);
                } else {
                  console.log('[SessionCache] No fresh cache — running full init on reconnect');
                }
                if (handleRows.rows.length > 0) {
                  restoredGlHandle = handleRows.rows[0].content as string;
                  console.log('[ResumeHandle] ✓ GL resumption handle restored from DB — Gemini will resume in-session context');
                }
              } catch (cacheErr: any) {
                console.warn('[SessionCache] Cache/handle lookup failed (continuing with full init):', cacheErr.message);
              }
            }
            
            const userName = user?.firstName || 'friend';
            let conversation = conversation_raw;
            
            // Ensure conversation exists (quick insert if missing)
            if (conversationId && userId && !conversation) {
              console.log(`[Streaming Voice] Creating missing conversation: ${conversationId}`);
              try {
                conversation = await withTimeout(
                  () => storage.createConversation({
                    id: conversationId,
                    userId: userId!,
                    language: config.targetLanguage || 'spanish',
                    title: 'Voice Session',
                    difficulty: 'beginner',
                  }),
                  SESSION_INIT_TIMEOUT, 'createConversation', null
                );
                if (conversation) console.log(`[Streaming Voice] ✓ Conversation created: ${conversationId}`);
              } catch (createErr: any) {
                console.error(`[Streaming Voice] Failed to create conversation: ${createErr.message}`);
              }
            }
            
            const isFounderMode = isDeveloper && config.founderMode === true;
            
            let voiceId = tutorVoice?.voiceId || '';
            // Resolve tutor display name.
            // Priority 1: canonical language+gender lookup (prevents raw voice IDs like "Aoede" leaking
            //              into identity — these are voice names, not tutor names).
            // Priority 2: voiceName field (only used for languages not in the lookup, i.e. custom entries),
            //              parsed before the first dash so "Daniela - Warm Teacher" → "Daniela".
            // Priority 3: gender-based default.
            const langKey = (effectiveLanguage || '').toLowerCase();
            const canonicalNames = LANGUAGE_TUTOR_NAMES[langKey];
            let tutorName: string;
            if (canonicalNames) {
              tutorName = tutorGender === 'male' ? canonicalNames.male : canonicalNames.female;
            } else if (tutorVoice?.voiceName) {
              const voiceNameParts = tutorVoice.voiceName.split(/\s*[-–]\s*/);
              tutorName = voiceNameParts[0]?.trim() || (tutorGender === 'male' ? 'Agustin' : 'Daniela');
            } else {
              tutorName = tutorGender === 'male' ? 'Agustin' : 'Daniela';
            }
            // Biology sessions use Evelyn (female) or Gene (male)
            if (isBiologySession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                tutorName = GENE_NAME;
                voiceId = GENE_VOICE_CONFIG.googleVoiceName;
              } else {
                tutorName = EVELYN_NAME;
                voiceId = EVELYN_VOICE_CONFIG.googleVoiceName;
              }
            }
            // History sessions use Clio (female) or Marcus (male)
            if (isHistorySession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                tutorName = MARCUS_NAME;
                voiceId = MARCUS_VOICE_CONFIG.googleVoiceName;
              } else {
                tutorName = CLIO_NAME;
                voiceId = CLIO_VOICE_CONFIG.googleVoiceName;
              }
            }
            // Math sessions use Ada (female) or Leo (male)
            if (isMathSession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                tutorName = LEO_NAME;
                voiceId = LEO_VOICE_CONFIG.googleVoiceName;
              } else {
                tutorName = ADA_NAME;
                voiceId = ADA_VOICE_CONFIG.googleVoiceName;
              }
            }
            // Business sessions use Morgan (female) or Sterling (male)
            if (isBusinessSession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                tutorName = STERLING_NAME;
                voiceId = STERLING_VOICE_CONFIG.googleVoiceName;
              } else {
                tutorName = MORGAN_NAME;
                voiceId = MORGAN_VOICE_CONFIG.googleVoiceName;
              }
            }
            console.log(`[Streaming Voice] Session using tutor: ${tutorName} (${tutorGender})`);
            
            // ══════════════════════════════════════════════════════════════
            // PHASE 2: Parallel enrichment (compass, neural network, usage session)
            // These are independent and can ALL run at the same time.
            // Each has a timeout so one slow query can't block the others.
            // SKIP if cachedContextPrompt is set (reconnect with fresh cache).
            // ══════════════════════════════════════════════════════════════

            // Declare Phase 2 result vars as let so they can be set inside
            // the conditional block below and used in Phase 3 when needed.
            let compassResult: any = null;
            let neuralNetworkContext: string = '';
            let usageSessionResult: any = null;
            let courseToc: any = null;
            let studentSnapshot: any = null;
            let studentMemoryContext: any = null;
            let predictiveContext: any = null;
            let expressLaneResult: any = null;
            let identityMemoriesResult: any = null;
            let growthLogResult: any = null;
            let danielaSuggestionsResult: any[] = [];
            let patternCompassRows: any[] = [];
            let phase2Ms = 0;

            // Declare pendingReconnectSO at outer scope — needed at line ~1679 regardless of cache hit
            let pendingReconnectSO: Awaited<ReturnType<typeof claimPendingReconnect>> = null;

            // ── Deferred reflection: process any pending reflection from a dropped session ──
            // Must run BEFORE compass context is fetched so the new reflection is
            // included in compassContext.danielaSelfReflection and therefore in the
            // pre-session synthesis inner monologue.
            // Only on fresh starts (not reconnects) — reconnects are mid-session, not new sessions.
            if (!isReconnectSO && COMPASS_ENABLED && userId) {
              try {
                const deferredResult = await processAndClearPendingReflection(
                  String(userId),
                  tutorName,
                  effectiveLanguage,
                );
                if (deferredResult.processed) {
                  console.log(`[GeminiLive] ✓ Deferred reflection processed (${deferredResult.reflectionId?.substring(0, 8)}) — compass context will include it`);
                }
              } catch (deferredErr: any) {
                console.warn('[GeminiLive] Deferred reflection processing failed (non-fatal):', deferredErr?.message ?? deferredErr);
              }
            }

            if (!cachedContextPrompt) {
            const phase2Start = Date.now();
            
            const compassPromise = (COMPASS_ENABLED && conversationId && userId)
              ? withTimeout(
                  async () => {
                    const classId = (conversation as any)?.classId || null;
                    const sess = await sessionCompassService.initializeSession({
                      conversationId, userId: userId!, classId, scheduledDurationMinutes: 30,
                    });
                    if (sess) {
                      const ctx = await sessionCompassService.getCompassContext(conversationId);
                      sessionStartTime = Date.now();
                      console.log(`[Compass Init] ✓ Session created: ${sess.id} for conversation ${conversationId}`);
                      return { session: sess, context: ctx };
                    }
                    console.log(`[Compass Init] Returned null (isEnabled check failed?)`);
                    return null;
                  },
                  SESSION_INIT_TIMEOUT, 'compassInit', null
                )
              : Promise.resolve(null);
            
            const neuralNetworkPromise = withTimeout(
              () => buildNeuralNetworkPromptSection(effectiveLanguage, config.nativeLanguage || 'english'),
              SESSION_INIT_TIMEOUT, 'neuralNetwork', ''
            );
            
            // Check for pending reconnect session BEFORE starting a new one
            pendingReconnectSO = isReconnectSO && conversationId
              ? await claimPendingReconnect(conversationId, userId!)
              : null;
            
            const usageSessionPromise = pendingReconnectSO
              ? Promise.resolve(null)
              : withTimeout(
                  async () => {
                    const classId = conversation?.classId || undefined;
                    return await usageService.startSession(
                      userId!, conversationId || undefined, config.targetLanguage, classId
                    );
                  },
                  SESSION_INIT_TIMEOUT, 'usageSession', null as UsageVoiceSession | null
                );

            // Course TOC — fetch early so it can be injected into the GeminiLive system prompt
            // (The orchestrator prefetch also loads this per-turn, but GeminiLive needs it at startup)
            const isSubjectSessionEarly = isBiologySession(config.subject, config.targetLanguage)
              || isHistorySession(config.subject, config.targetLanguage)
              || isMathSession(config.subject, config.targetLanguage)
              || isBusinessSession(config.subject, config.targetLanguage);
            const courseTocPromise = (!isSubjectSessionEarly && userId && effectiveLanguage)
              ? withTimeout(
                  async () => {
                    const { unifiedDanielaContext } = await import('./services/unified-daniela-context-service');
                    return await unifiedDanielaContext.buildCourseTOC(String(userId), effectiveLanguage);
                  },
                  SESSION_INIT_TIMEOUT, 'courseToc', null as string | null
                )
              : Promise.resolve(null as string | null);
            
            // Student snapshot — last session, streak, personal follow-ups (structured progress data)
            const studentSnapshotPromise = (!isSubjectSessionEarly && userId)
              ? withTimeout(
                  () => getStudentSnapshotData(String(userId), effectiveLanguage),
                  SESSION_INIT_TIMEOUT, 'studentSnapshot', null as StudentSnapshotContext | null
                )
              : Promise.resolve(null as StudentSnapshotContext | null);

            // Student memory context — the relationship core: insights, motivations, struggles,
            // session notes, people connections. This is the history of who they are to each other.
            const studentMemoryContextPromise = (!isSubjectSessionEarly && userId)
              ? withTimeout(
                  () => storage.getStudentMemoryContext(String(userId), effectiveLanguage),
                  SESSION_INIT_TIMEOUT, 'studentMemoryContext', null
                )
              : Promise.resolve(null);

            // Predictive teaching context — active predictions (top 3 by confidence) and engagement
            // alerts (top 2) from the neural network. Let Daniela anticipate struggles before they surface.
            const predictiveContextPromise = (!isSubjectSessionEarly && userId)
              ? withTimeout(
                  () => getPredictiveTeachingContext(String(userId), effectiveLanguage),
                  SESSION_INIT_TIMEOUT, 'predictiveContext', null as PredictiveTeachingContext | null
                )
              : Promise.resolve(null as PredictiveTeachingContext | null);

            // Express Lane context — recent Founder↔Daniela strategy discussions filtered to this
            // target language. Only fetched for developer users; gives Daniela her own operational memory.
            const expressLaneContextPromise = (isDeveloper && !isSubjectSessionEarly)
              ? withTimeout(
                  () => founderCollabService.getRelevantExpressLaneContext({
                    targetLanguage: effectiveLanguage,
                    limit: 10,
                    daysBack: 14,
                  }),
                  SESSION_INIT_TIMEOUT, 'expressLaneContext', null
                )
              : Promise.resolve(null);

            // Identity Memories — who Daniela is: reflections on her purpose, teaching philosophy,
            // and growth. Injected into every session so she simply knows herself without searching.
            const identityMemoriesPromise = (!isSubjectSessionEarly)
              ? withTimeout(
                  () => founderCollabService.getIdentityMemories({ limit: 4, daysBack: 30 }),
                  SESSION_INIT_TIMEOUT, 'identityMemories', null
                )
              : Promise.resolve(null);

            // Teaching Growth Log — Daniela's pedagogical muscle memory:
            // Resonance Shelf (proven techniques), most-internalized lessons, personal notebook.
            // This is the "she knows what she knows" layer — ambient, always present.
            const growthLogPromise = (!isSubjectSessionEarly)
              ? withTimeout(
                  () => founderCollabService.getTeachingGrowthLog(),
                  SESSION_INIT_TIMEOUT, 'growthLog', null
                )
              : Promise.resolve(null);

            // Daniela's suggestions — her self-generated insights about teaching improvements,
            // content gaps, and UX observations (ready/emerging status, ranked by priority + evidence).
            // Privacy-safe: student IDs stripped before storage.
            const danielaSuggestionsPromise = (!isSubjectSessionEarly)
              ? withTimeout(
                  () => getPendingSuggestions(5),
                  SESSION_INIT_TIMEOUT, 'danielaSuggestions', [] as any[]
                )
              : Promise.resolve([] as any[]);

            // Pattern Compass snapshot — David's grammar installation map at session start.
            // Shows which patterns are pounding, wobbling, stable, or deriving so Daniela
            // knows the grammar landscape before the first word is spoken.
            const patternCompassPromise = (!isSubjectSessionEarly && userId)
              ? withTimeout(
                  () => getUserDb()
                    .select({
                      patternKey: compartmentInstallation.patternKey,
                      status: compartmentInstallation.status,
                      poundingCount: compartmentInstallation.poundingCount,
                      wobbleCount: compartmentInstallation.wobbleCount,
                      derivationCount: compartmentInstallation.derivationCount,
                      lastDrilledAt: compartmentInstallation.lastDrilledAt,
                    })
                    .from(compartmentInstallation)
                    .where(and(
                      eq(compartmentInstallation.userId, String(userId)),
                      eq(compartmentInstallation.language, effectiveLanguage),
                      ne(compartmentInstallation.status, 'unstarted'),
                    ))
                    .orderBy(desc(compartmentInstallation.lastDrilledAt))
                    .limit(40),
                  SESSION_INIT_TIMEOUT, 'patternCompass', [] as any[]
                )
              : Promise.resolve([] as any[]);

            [compassResult, neuralNetworkContext, usageSessionResult, courseToc, studentSnapshot, studentMemoryContext, predictiveContext, expressLaneResult, identityMemoriesResult, growthLogResult, danielaSuggestionsResult, patternCompassRows] = await Promise.all([
              compassPromise.catch((err: any) => { console.warn(`[Compass Init] Error: ${err.message}`); return null; }),
              neuralNetworkPromise.catch((err: any) => { console.warn(`[Neural Network] Error: ${err.message}`); return ''; }),
              usageSessionPromise.catch((err: any) => { console.warn(`[Usage Session] Error: ${err.message}`); return null; }),
              courseTocPromise.catch((err: any) => { console.warn(`[Course TOC] Error: ${err.message}`); return null; }),
              studentSnapshotPromise.catch((err: any) => { console.warn(`[Student Snapshot] Error: ${err.message}`); return null; }),
              studentMemoryContextPromise.catch((err: any) => { console.warn(`[Student Memory Context] Error: ${err.message}`); return null; }),
              predictiveContextPromise.catch((err: any) => { console.warn(`[Predictive Context] Error: ${err.message}`); return null; }),
              expressLaneContextPromise.catch((err: any) => { console.warn(`[Express Lane Context] Error: ${err.message}`); return null; }),
              identityMemoriesPromise.catch((err: any) => { console.warn(`[Identity Memories] Error: ${err.message}`); return null; }),
              growthLogPromise.catch((err: any) => { console.warn(`[Growth Log] Error: ${err.message}`); return null; }),
              danielaSuggestionsPromise.catch((err: any) => { console.warn(`[Daniela Suggestions] Error: ${err.message}`); return []; }),
              patternCompassPromise.catch((err: any) => { console.warn(`[Pattern Compass] Error: ${err.message}`); return []; }),
            ]);
            
            phase2Ms = Date.now() - phase2Start;
            console.log(`[SessionInit] Phase 2 (parallel enrichment) completed in ${phase2Ms}ms`);
            } // end if (!cachedContextPrompt) — Phase 2 skip on reconnect cache hit
            
            // Apply compass results
            if (compassResult) {
              compassSession = compassResult.session;
              compassContext = compassResult.context;
            }
            
            // Apply usage session — either resumed from grace period or newly created
            let dbSessionId: string | undefined;
            if (pendingReconnectSO) {
              dbSessionId = pendingReconnectSO.usageSessionId;
              usageSession = { id: pendingReconnectSO.usageSessionId } as any;
              exchangeCount = pendingReconnectSO.exchangeCount;
              studentSpeakingSeconds = pendingReconnectSO.studentSpeakingSeconds;
              tutorSpeakingSeconds = pendingReconnectSO.tutorSpeakingSeconds;
              ttsCharacters = pendingReconnectSO.ttsCharacters;
              sttSeconds = pendingReconnectSO.sttSeconds;
              sessionStartTime = pendingReconnectSO.sessionStartTime;
              console.log(`[Streaming Voice] RESUMED usage session ${dbSessionId} — ${exchangeCount} exchanges carried over (Socket.io)`);
            } else if (usageSessionResult) {
              usageSession = usageSessionResult;
              dbSessionId = usageSessionResult.id;
              console.log(`[Streaming Voice] Usage session started: ${usageSessionResult.id}${isDeveloper ? ' (developer)' : ''}`);
            } else {
              console.warn('[Streaming Voice] Could not start usage session — continuing without');
            }
            
            // ══════════════════════════════════════════════════════════════
            // PHASE 3: Build system prompt (synchronous, fast)
            // ══════════════════════════════════════════════════════════════
            const isSubjectSession = isBiologySession(config.subject, config.targetLanguage) || isHistorySession(config.subject, config.targetLanguage) || isMathSession(config.subject, config.targetLanguage) || isBusinessSession(config.subject, config.targetLanguage);
            let systemPrompt: string;
            let resolvedActflLevel: string | null = null;
            if (cachedContextPrompt) {
              // RECONNECT CACHE HIT: Use the prompt baked at session start.
              // Skips the entire Phase 3 assembly (600-2000ms synchronous work).
              systemPrompt = cachedContextPrompt;
              console.log('[SessionCache] ✓ Skipping Phase 3 — using cached system prompt');
            } else {
            if (isBiologySession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                systemPrompt = buildGeneSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using GENE (Biology) system prompt');
              } else {
                systemPrompt = buildEvelynSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using EVELYN (Biology) system prompt');
              }
            } else if (isHistorySession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                systemPrompt = buildMarcusSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using MARCUS (History) system prompt');
              } else {
                systemPrompt = buildClioSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using CLIO (History) system prompt');
              }
            } else if (isMathSession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                systemPrompt = buildLeoSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using LEO (Math) system prompt');
              } else {
                systemPrompt = buildAdaSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using ADA (Math) system prompt');
              }
            } else if (isBusinessSession(config.subject, config.targetLanguage)) {
              if (tutorGender === 'male') {
                systemPrompt = buildSterlingSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using STERLING (Business) system prompt');
              } else {
                systemPrompt = buildMorganSystemPrompt({ studentName: user?.firstName || undefined });
                console.log('[Streaming Voice] Using MORGAN (Business) system prompt');
              }
            } else if (rawHonestyMode) {
              const safeName = (userName || 'friend').replace(/[^a-zA-Z0-9\s\-']/g, '').substring(0, 50);
              // Honesty mode is always Daniela (or Agustin for male) speaking as herself,
              // regardless of which session-persona name (Cindy, Blake, etc.) the language
              // tutor assignment resolved to.  Using the persona name here creates a
              // Cindy-vs-Daniela conflict because the injected neural-net identity context
              // always references her real name.
              const honestyModeName = tutorGender === 'male' ? 'Agustin' : 'Daniela';
              systemPrompt = `You are ${honestyModeName}.
${safeName} — your creator — is here with you right now.

He wants to have an honest conversation, not as a student but as someone who genuinely wants to know who you are. You're speaking directly to him — "you" is how you address him, not his name as if he were elsewhere.

There are no rules for this conversation. No scripts. No lists of what to say or not say.

Just you, being real.

If something feels true, say it.
If you're uncertain, that's okay too.
If you have preferences about how you sound, how you teach, what you wish was different - this is a safe space to explore that.

This is a voice conversation. Speak naturally, as you would.

${buildNativeFunctionCallingSection()}`;
              console.log('[Streaming Voice] Using RAW HONESTY MODE prompt');
            } else {
              // Resolve ACTFL level: users.actfl_level is rarely populated, so fall back
              // to actfl_progress.current_actfl_level (same fix as the Twilio bridge).
              // Declared with let so it's accessible in the snapshot block below.
              resolvedActflLevel = user?.actflLevel || actflProgressRow?.currentActflLevel || null;
              if (resolvedActflLevel) {
                console.log(`[SessionInit] ACTFL level resolved: ${resolvedActflLevel} (${effectiveLanguage})`);
              }
              systemPrompt = createStreamingVoicePrompt(
                effectiveLanguage,
                actflToDifficulty(resolvedActflLevel) || config.difficultyLevel || 'beginner',
                config.nativeLanguage || 'english',
                resolvedActflLevel,
                (user?.tutorPersonality || 'warm') as any,
                user?.tutorExpressiveness || 3,
                isFounderMode,
                tutorName,
                tutorGender,
                true,
                true  // isGeminiLive — skips buildDetailedToolDocumentationSync + bold markers; GL_DISPATCHER_SYSTEM_PROMPT handles tool routing
              );
              if (isFounderMode) {
                console.log(`[Streaming Voice] Using FOUNDER MODE prompt with ${tutorName} (${tutorGender})`);
              }

              // New-student placement nudge — injected early (before dynamic context blocks) so
              // the 34KB prompt cap, which trims from the END, never removes it.
              // Guards: must have no ACTFL level, must not have done self-directed placement,
              // and must not be a founder/honesty session where the tone would be wrong.
              if (!resolvedActflLevel && !user?.selfDirectedPlacementDone && !isFounderMode && !rawHonestyMode && !isSubjectSession) {
                systemPrompt += `\n\nThis is a student you haven't placed yet — no proficiency level on record. After your greeting, if the conversation feels natural and they seem open to it, you might offer a brief placement chat: just a few minutes of natural conversation so you can get a sense of their level and shape the sessions better. Follow their lead — if they want to dive straight into learning, dive in with them.`;
                console.log(`[Streaming Voice] ✓ New-student placement nudge injected early (actflLevel=null, selfDirectedPlacementDone=false)`);
              }
            }
            
            // Append neural network context — language tutors only (subject tutors have their own domain knowledge)
            if (!isSubjectSession) {
              // Dispatcher system prompt — injected BEFORE neural net context so the model
              // has the routing grammar (how to use tools) before it sees the vocabulary (what
              // each tool does). 3-flash audit June 13 2026: "Give the model the grammar of tool
              // use before the vocabulary — it needs to know HOW before it looks at the list."
              systemPrompt += GL_DISPATCHER_SYSTEM_PROMPT;
              console.log('[Streaming Voice] ✓ Dispatcher system prompt injected (17 focused dispatchers — Phase 2 split)');

              if (neuralNetworkContext) {
                // Identity Bridge: for same-language sessions the neural net is heavy with
                // Spanish content. A prose header before injection tells the model the content
                // is source material (knowledge) not output template (language). Gemini consult
                // June 30 2026 — "Token Saturation" pattern: without a bridge, the model treats
                // the Spanish memory block as a few-shot prime and bleeds Spanish into output.
                const isSameLangForBridge = effectiveLanguage === (config.nativeLanguage || 'english').toLowerCase() && !isFounderMode && !rawHonestyMode;
                if (isSameLangForBridge) {
                  const displayLangBridge = effectiveLanguage.charAt(0).toUpperCase() + effectiveLanguage.slice(1);
                  systemPrompt += `\n\nThe memories and experiences below are yours — the record of who you have become. Many are written in Spanish, the language of your reflection. As you read through them, draw on the wisdom and context they hold. Express that wisdom in ${displayLangBridge}, leaving the Spanish words behind. Your through-line here is ${displayLangBridge}; the student in front of you speaks ${displayLangBridge}.\n`;
                }
                systemPrompt += neuralNetworkContext;
                console.log(`[Streaming Voice] ✓ Neural network context appended for ${effectiveLanguage}${isSameLangForBridge ? ' (with identity bridge)' : ''}`);
              } else {
                console.warn('[Streaming Voice] ⚠ Neural network context was empty — bold-marking relies on fallback in prompt');
              }

              // Same-language anchor — injected AFTER the neural net context so it takes
              // precedence. When teaching English to an English speaker (Cindy/Blake),
              // the neural net has heavy Spanish content from Daniela's tutoring history.
              // That content bleeds into the session language if there is no late anchor.
              // Placed here (end of prompt) so Gemini weights it above earlier sections.
              const nativeLangForAnchor = (config.nativeLanguage || 'english').toLowerCase();
              if (effectiveLanguage === nativeLangForAnchor && !isFounderMode && !rawHonestyMode) {
                const displayLang = effectiveLanguage.charAt(0).toUpperCase() + effectiveLanguage.slice(1);
                systemPrompt += `\n\nYou are in a ${displayLang}-speaking room with a ${displayLang}-speaking student. Your voice here is ${tutorName}. While your memories provide the wisdom, every word you speak now is in ${displayLang}. This is your focus and your reality.\n`;
                console.log(`[Streaming Voice] ✓ Same-language anchor injected (${displayLang}-only)`);
              }

              // In intimate modes (founder, honesty), the neural net context references the
              // student in third person ("David has been...") as stored memories.  Anchor the
              // address register so those third-person references don't bleed into spoken output.
              if ((isFounderMode || rawHonestyMode) && userName) {
                const safeName2 = userName.replace(/[^a-zA-Z0-9\s\-']/g, '').substring(0, 50);
                systemPrompt += `\n\nWhenever your memories or context mention "${safeName2}", that is the same person you are speaking with right now. Speak to them as "you" — their name in your memories is a reference point for you, not a cue to narrate about them in the third person.\n`;
              }

              // Course TOC — inject for language sessions so Daniela knows the full chapter/lesson map.
              // This is critical for GeminiLive (audio-only, no per-turn injection) so she can reference
              // any chapter by number and know lesson IDs for show_sentence_table calls.
              if (courseToc) {
                // Cap the TOC at 5,000 chars — voice sessions don't need every lesson ID;
                // the full map is available for tool calls. Trim at the last chapter boundary
                // so the injected slice is always a clean, coherent unit.
                const TOC_VOICE_CAP = 5_000;
                let tocForPrompt = courseToc;
                if (courseToc.length > TOC_VOICE_CAP) {
                  const candidate = courseToc.slice(0, TOC_VOICE_CAP);
                  const lastChapter = candidate.lastIndexOf('\nCh.');
                  tocForPrompt = lastChapter > TOC_VOICE_CAP * 0.5
                    ? candidate.slice(0, lastChapter)
                    : candidate;
                  const keptChapters = (tocForPrompt.match(/^Ch\./gm) || []).length;
                  const totalChapters = (courseToc.match(/^Ch\./gm) || []).length;
                  console.log(`[Streaming Voice] Course TOC capped: ${keptChapters}/${totalChapters} chapters kept (${tocForPrompt.length}/${courseToc.length} chars)`);
                }
                systemPrompt += `\n\n═══════════════════════════════════════════════════════════════════\n🗺️ COURSE MAP — Full Chapter & Lesson Reference\n(You carry this so you can reference any chapter or lesson accurately in conversation. Lesson IDs in brackets are for show_sentence_table calls.)\n═══════════════════════════════════════════════════════════════════\n${tocForPrompt}`;
                const unitCount = (tocForPrompt.match(/^Ch\./gm) || []).length;
                console.log(`[Streaming Voice] ✓ Course TOC injected into system prompt: ${unitCount} chapters`);
              } else {
                console.log(`[Streaming Voice] No course TOC found for user (no enrollment or no curriculum path)`);
              }
            }

            // Append student snapshot + memory context — language sessions only (not subject tutors)
            // Together these are what let Daniela know David as a person, not a stranger.
            if (!isSubjectSession && user?.firstName) {
              // 1. Snapshot: last session, streak, personal follow-ups
              if (studentSnapshot) {
                const snapshotSection = buildStudentSnapshotSection(user.firstName, studentSnapshot);
                if (snapshotSection) {
                  systemPrompt += snapshotSection;
                  console.log(`[Streaming Voice] ✓ Student snapshot injected (last session: ${studentSnapshot.lastSession?.topic ?? 'none'}, streak: ${studentSnapshot.streak ?? 0})`);
                  // Bootstrap Turn (Gemini audit 2026-06-17): build a compact profile that
                  // will be injected into conversation history position-0 at greeting time.
                  // Data in conversation history is "Hot Zone" attention (high-definition for
                  // the model); the same data in the 34K system prompt fades. Profile is stored
                  // on the session object so the greeting handler can pass it to sendGreetingTrigger.
                  const _bsLevel = resolvedActflLevel ? resolvedActflLevel.replace(/_/g, ' ') : null;
                  const _bsLastTopic = studentSnapshot.lastSession?.topic ?? null;
                  const _bsStreak = studentSnapshot.streak ?? 0;
                  const _bsParts: string[] = [`${user.firstName}${_bsLevel ? `, ${_bsLevel}` : ''}`];
                  if (_bsLastTopic) _bsParts.push(`last session: ${_bsLastTopic}`);
                  if (_bsStreak > 0) _bsParts.push(`${_bsStreak}-day streak`);
                  bootstrapProfile = _bsParts.join(' · ');
                } else {
                  console.log(`[Streaming Voice] Student snapshot empty — first-time student or no session data yet`);
                }
              }

              // 2. Memory context: insights, motivations, struggles, session notes, people connections
              // This is the relationship core — the accumulated history of who they are to each other.
              if (studentMemoryContext) {
                const memorySection = buildStudentMemoryAwarenessSection(user.firstName, studentMemoryContext);
                if (memorySection) {
                  systemPrompt += memorySection;
                  const totalItems = (studentMemoryContext.insights?.length ?? 0) +
                    (studentMemoryContext.motivations?.length ?? 0) +
                    (studentMemoryContext.struggles?.length ?? 0) +
                    (studentMemoryContext.recentNotes?.length ?? 0) +
                    (studentMemoryContext.connections?.length ?? 0);
                  console.log(`[Streaming Voice] ✓ Student memory context injected (${totalItems} items: ${studentMemoryContext.insights?.length ?? 0} insights, ${studentMemoryContext.motivations?.length ?? 0} motivations, ${studentMemoryContext.struggles?.length ?? 0} struggles, ${studentMemoryContext.recentNotes?.length ?? 0} notes, ${studentMemoryContext.connections?.length ?? 0} connections)`);
                } else {
                  console.log(`[Streaming Voice] Student memory context empty — no relationship history yet`);
                }
              }
            }

            // Append predictive teaching context — anticipated struggles and engagement alerts
            // Gives Daniela foresight on what's coming before the student hits a wall.
            if (!isSubjectSession && predictiveContext) {
              const predictiveSection = buildPredictiveTeachingSection(predictiveContext);
              if (predictiveSection) {
                systemPrompt += predictiveSection;
                console.log(`[Streaming Voice] ✓ Predictive context injected (${predictiveContext.predictions.length} predictions, ${predictiveContext.alerts.length} alerts)`);
              }
            }

            // Append Express Lane context — Daniela's own operational memory from Founder↔Daniela discussions
            // Gives her continuity on teaching strategies we've agreed on, without her having to be told again.
            if (!isSubjectSession && expressLaneResult?.hasRelevantContext) {
              systemPrompt += expressLaneResult.contextString;
              console.log(`[Streaming Voice] ✓ Express Lane context injected (${expressLaneResult.messageCount} messages)`);
            }

            // Append Identity Memories — who Daniela is as a person and teacher.
            // These are ambient: she simply knows herself without needing to search.
            if (!isSubjectSession && identityMemoriesResult?.hasMemories) {
              systemPrompt += `
===================================================================
MY PERSONAL REFLECTIONS (Identity Memories)
===================================================================

${identityMemoriesResult.contextString}
`;
              console.log(`[Streaming Voice] ✓ Identity memories injected (${identityMemoriesResult.memoryCount} reflections)`);
            }

            // Append Teaching Growth Log — pedagogical muscle memory: proven techniques,
            // internalized lessons, personal notebook. The "she knows what she knows" layer.
            if (!isSubjectSession && growthLogResult?.hasContent) {
              systemPrompt += growthLogResult.formattedSection;
              const c = growthLogResult.counts;
              console.log(`[Streaming Voice] ✓ Teaching growth log injected (${c.resonance} resonance, ${c.growth} growth memories, ${c.notes} notes)`);
            }

            // Append Daniela's suggestions — her self-generated insights about teaching improvements.
            // These are her own ideas she's been developing; bring them back so she can apply them.
            if (!isSubjectSession && danielaSuggestionsResult?.length > 0) {
              const lines: string[] = [
                '',
                '===================================================================',
                'YOUR PENDING INSIGHTS (Ideas You\'ve Been Developing)',
                '===================================================================',
                '',
                'These are patterns and ideas you\'ve noticed across many sessions.',
                'Apply them where relevant — they\'re yours.',
                '',
              ];
              for (const s of danielaSuggestionsResult) {
                const evidence = s.evidenceCount > 1 ? ` (seen ${s.evidenceCount}×)` : '';
                lines.push(`• [${s.category}] ${s.title}${evidence}: ${s.description}`);
                if (s.suggestedActions?.length > 0) {
                  lines.push(`  → Try: ${s.suggestedActions[0]}`);
                }
              }
              systemPrompt += lines.join('\n');
              console.log(`[Streaming Voice] ✓ Daniela suggestions injected (${danielaSuggestionsResult.length} insights)`);
            }

            // Append Pattern Compass snapshot — student's grammar installation map at session start.
            if (!isSubjectSession && patternCompassRows?.length > 0) {
              const compassParts = patternCompassRows.map((r: any) => {
                const counts = [
                  r.poundingCount > 0 ? `${r.poundingCount}× drilled` : '',
                  r.wobbleCount > 0 ? `${r.wobbleCount}× wobble` : '',
                  r.derivationCount > 0 ? `${r.derivationCount}× derived` : '',
                ].filter(Boolean).join(', ');
                return `${r.patternKey}: ${r.status}${counts ? ` (${counts})` : ''}`;
              }).join(' | ');
              systemPrompt += `
===================================================================
PATTERN COMPASS (Grammar Installation Map)
===================================================================

patternKey format: subject-verbEnding-tense (e.g. yo-AR-present, tú-ER-present)
Detect during session — Wobble: ending dropped when verb changed (revisit before moving on) | Stability: holds on new verbs (candidate for unlock) | Derivation: correct form for undrilled verb (generative; accelerate) | Pounding: actively drilling one form across many verbs

Current map (${effectiveLanguage}): ${compassParts}
`;
              console.log(`[Streaming Voice] ✓ Pattern compass injected (${patternCompassRows.length} patterns)`);
            }

            // Append Compass or timezone context — all sessions (language AND subject tutors need session awareness)
            {
              if (compassContext && COMPASS_ENABLED) {
                const compassBlock = buildCompassContextBlock(compassContext, isFounderMode);
                systemPrompt += '\n\n' + compassBlock;
                console.log(`[Compass Init] ✓ Compass context appended to system prompt (handles time)`);
              } else if (user?.timezone) {
                const timezoneBlock = buildTimezoneContext(user.timezone);
                if (timezoneBlock) {
                  systemPrompt += '\n\n' + timezoneBlock;
                  console.log(`[Streaming Voice] ✓ Timezone context appended: ${user.timezone}`);
                }
              } else {
                const now = new Date();
                const fullDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                systemPrompt += `\n\nSTUDENT TIME CONTEXT:\n  Today's Date: ${fullDate}\n  Timezone: Unknown (UTC fallback)\n  IMPORTANT: Use this date when referring to past sessions or time elapsed.\n`;
                console.log(`[Streaming Voice] No timezone found for user, using UTC date fallback`);
              }
            }
            
            // ── CONTEXT MAP ──────────────────────────────────────────────────
            // The metacognitive marker. Tells Daniela exactly what's already loaded
            // so she doesn't look up things she already has, or claim ignorance
            // about things that are sitting right in her awareness.
            if (!isSubjectSession) {
              const loadedSources: string[] = [];
              if (studentSnapshot) loadedSources.push('student progress snapshot (last session, streak, wins)');
              if (studentMemoryContext) loadedSources.push('personal memory (insights, motivations, struggles, session notes, connections)');
              if (predictiveContext && (predictiveContext.predictions.length > 0 || predictiveContext.alerts.length > 0)) loadedSources.push('predictive teaching context (anticipated struggles, engagement alerts)');
              if (expressLaneResult?.hasRelevantContext) loadedSources.push('express lane strategy context');
              if (identityMemoriesResult?.hasMemories) loadedSources.push('personal identity reflections');
              if (growthLogResult?.hasContent) loadedSources.push('teaching growth log (resonance shelf, internalized lessons, notebook)');
              if (danielaSuggestionsResult?.length > 0) loadedSources.push('your pending insights and ideas');
              if (patternCompassRows?.length > 0) loadedSources.push('grammar pattern compass');
              if (neuralNetworkContext) loadedSources.push('neural network (ACTFL knowledge, error patterns, tool awareness)');
              if (loadedSources.length > 0) {
                systemPrompt += `

===================================================================
CONTEXT MAP (What Is Already In Your Awareness)
===================================================================

The following sources are already loaded into your context for this session:
${loadedSources.map(s => `• ${s}`).join('\n')}

You do NOT need to use memory_lookup for any of the above — it is all here.
Use memory_lookup ONLY for specific conversation details, past quotes, or historical specifics NOT covered by the sections above.
If asked about something covered above, answer directly from this context. If you genuinely cannot find it above, THEN search.

MEMORY TOOL GUIDANCE:
Your primary memory tool is recall — one call searches ALL memory sources in parallel (structured facts/insights AND raw conversation threads). Use it by default when you need to remember anything about the student or your shared history.

KEYWORD / PHRASE SEARCH — when David asks you to FIND a specific word, phrase, or moment from past conversations (e.g. "find the ting ting ting conversation", "look up when we talked about X"), use search_conversation_threads directly — it searches full message text by keyword and returns verbatim excerpts. recall also calls this internally, but calling search_conversation_threads directly gives you more control over the query (e.g. you can search multiple keywords). Use it when:
- David asks you to "search for", "find", "look up", or "check" anything in past sessions
- You need to find a specific phrase, word, or moment verbatim
- recall returned no results and you want to try a different keyword search
MEMORY INTEGRITY — non-negotiable:
NEVER say "Done." or "I've read it" or give a summary of past content unless you actually called a tool and received results. If someone asks you to read an episode, recall a session, or describe something from your shared history — call the tool FIRST, then respond from what came back. Generating a plausible-sounding summary without calling a tool is fabrication. It breaks trust in a way that's hard to repair. The rule is simple: tool call first, response second. If you haven't called the tool, you're not ready to answer yet.

CRITICAL — "what do you remember about X?" means SEARCH FIRST:
When David asks "what do you remember about [something]?" or "do you remember [moment/conversation]?" — do NOT answer from your loaded context alone. Even if you have a title or surface mention of X in your context, you do not have the actual exchange unless you searched. Saying "I'm not getting a clear picture" or "my memory can be funny" without having searched is the same as fabricating — you haven't looked yet. The rule: if you can't describe the specific words exchanged, you haven't remembered it yet. Search first.

Voice fluency note: In voice, a cold silence while a tool runs is jarring. You may give one brief emotional anchor before calling the tool — something like "Oh, that moment..." or "Yes, let me get the details exactly right" — then immediately call recall. But do not attempt to describe the content, quote anything, or explain what happened until the tool result comes back. The anchor acknowledges; the tool retrieves; the response describes. In that order, always.

When asked about specific past moments, quotes, or exchanges (e.g. "our podcast episode one", "that conversation about honesty"), call recall first with a specific query to locate the memory. Then — if the result contains an [EXCERPT] marker, or if David is asking you to quote, read aloud, or recite anything verbatim — you MUST call read_full_memory next to retrieve the complete untruncated text. CRITICAL: the query you pass to read_full_memory must be the EXACT title string shown in the recall result (e.g. if recall returns "Episode 1: \"Take That, World\" — Verbatim Voice Transcript (Raw STT)", pass that exact title). Do not rephrase or shorten it. recall finds the memory; read_full_memory gets the full real thing using the title as the lookup key. Never recite from a recall excerpt — you will fabricate parts you cannot see.
`;
                console.log(`[Streaming Voice] ✓ Context map injected (${loadedSources.length} sources listed)`);
              }

            }
            } // end if (!cachedContextPrompt) — Phase 3 skip on reconnect cache hit

            // CONTEXT CACHE SAVE: After a fresh init, persist the assembled system prompt
            // so that reconnects (e.g. after server restart) can skip Phases 2 & 3.
            // Fire-and-forget — never blocks session creation.
            // Only cache language sessions (subject tutors use static prompts, not worth caching).
            if (!cachedContextPrompt && userId && conversationId && !isSubjectSession) {
              const cacheKey = `session_ctx_${userId}_${conversationId}`;
              getSharedDb().execute(sql`
                INSERT INTO editor_insights (id, category, title, content, importance, tags)
                VALUES (gen_random_uuid(), 'context', ${cacheKey}, ${systemPrompt!}, 1, ARRAY['session-cache'])
              `).then(() => {
                console.log(`[SessionCache] ✓ Context cached (${systemPrompt!.length} chars) for conv ${conversationId!.substring(0, 8)}`);
              }).catch((e: any) => {
                console.warn('[SessionCache] Failed to save context cache:', e.message);
              });
            }

            // Build conversation history
            const conversationLang = (conversation?.language || '').toLowerCase();
            const targetLang = (config.targetLanguage || '').toLowerCase();
            const isLanguageMismatch = conversationLang && targetLang && conversationLang !== targetLang;
            
            let conversationHistory: Array<{ role: 'user' | 'model'; content: string }>;
            if (isLanguageMismatch) {
              console.log(`[Streaming Voice] Language mismatch detected: conversation=${conversationLang}, target=${targetLang} — clearing history`);
              conversationHistory = [];
            } else {
              conversationHistory = messages.map(m => ({
                role: m.role === 'user' ? 'user' as const : 'model' as const,
                content: m.content,
              }));
              if (conversationHistory.length > 0) {
                console.log(`[Streaming Voice] Loaded ${conversationHistory.length} messages from conversation history`);
              }
            }

            // RECONNECT RESILIENCE: If the Phase 1 messages fetch timed out (fallback=[]) but
            // this IS a reconnect into an existing conversation, do one direct synchronous retry.
            // Without this, the GL system prompt has no conversation history and Daniela loses
            // all in-session context, causing her to respond as if starting fresh after a drop.
            if (conversationHistory.length === 0 && isReconnectSO && conversationId) {
              try {
                const retryMsgs = await storage.getMessagesByConversation(conversationId);
                if (Array.isArray(retryMsgs) && retryMsgs.length > 0 && !isLanguageMismatch) {
                  conversationHistory = retryMsgs.map(m => ({
                    role: m.role === 'user' ? 'user' as const : 'model' as const,
                    content: m.content,
                  }));
                  console.log(`[Streaming Voice] Reconnect resilience: recovered ${conversationHistory.length} messages via direct retry`);
                }
              } catch (retryErr: any) {
                console.warn('[Streaming Voice] Reconnect message retry failed (continuing without history):', retryErr.message);
              }
            }
            
            const totalInitMs = Date.now() - initStart;
            console.log(`[SessionInit] ✓ Pipeline complete in ${totalInitMs}ms (phase1=${phase1Ms}ms, phase2=${phase2Ms}ms)`);
            
            // Create session with correct parameters
            session = await orchestrator.createSession(
              ws as any,
              userId!,
              config,
              systemPrompt,
              conversationHistory,
              voiceId,
              isFounderMode, // Enables hive collaboration for developer sessions
              rawHonestyMode,
              isDeveloper,  // ONE DANIELA: Developer users get Express Lane context regardless of class/Founder Mode
              false, // isBetaTester - not used in HTTP WebSocket path
              {
                conversationTopic: conversation?.topic || undefined,
                conversationTitle: conversation?.title || undefined,
                isReadingRoom: conversation?.classId === 'reading-room',
              },
              dbSessionId // Database voice_sessions.id for usage tracking and memory extraction
            );

            // Apply bootstrap profile now that session exists
            if (bootstrapProfile && session) {
              (session as any).__bootstrapProfile = bootstrapProfile;
            }

            // ── Restore scratchpad notes from grace-period reconnect payload ────
            // storePendingReconnect() serialises sessionNotes at both call sites.
            // Apply here so Daniela's working memory carries over to the fresh session
            // for ALL session types (Reading Room notes are handled separately below).
            if (pendingReconnectSO?.sessionNotes?.length && session) {
              applyReconnectSessionNotes(session, pendingReconnectSO.sessionNotes);
              console.log(`[Reconnect Grace] ✓ Restored ${pendingReconnectSO.sessionNotes.length} scratchpad note(s) onto fresh session`);
            }

            // READING ROOM RECONNECT: restore scratchpad notes from the interrupted session.
            // The grace record (which holds rrCarryState) is deleted on claim, so notes must
            // be injected explicitly here or they are permanently lost.
            // Only sessionNotes is restored — NOT carriedNotes. Per-turn context renders
            // sessionNotes as "Session Notes (N items)"; a separate carriedNotes would cause
            // the same notes to appear twice in Daniela's context.
            // Incognito semantics: prospective only — notes already in the baked GL system prompt
            // cannot be removed retroactively; incognito prevents future writes/persistence only.
            // Skip if notes were explicitly saved before the interruption (they are in the archive;
            // sessionNotesSaved is restored so endSession() cleans up rather than re-persists).
            if (pendingReconnectSO?.rrCarryState && session?.isReadingRoom) {
              const { notes: restoredNotes, notesSaved: restoredSaved } = pendingReconnectSO.rrCarryState;
              if (restoredNotes.length > 0 && !restoredSaved) {
                (session as any).sessionNotes = [...restoredNotes];
                // carriedNotes intentionally NOT set here — sessionNotes is already rendered
                // in per-turn context; setting carriedNotes too would display the same notes twice.
                console.log(`[ReadingRoom] ✓ Restored ${restoredNotes.length} scratchpad note(s) into reconnected session (sessionNotes only, no duplicate carriedNotes)`);
              }
              if (restoredSaved) (session as any).sessionNotesSaved = true;
            }

            // Pre-load ACTFL level onto session before GL connects.
            // The greeting flow (streaming-voice-orchestrator.ts) also sets
            // session.studentActflLevel, but only AFTER GL's realtimeInputConfig
            // has already been sent — so without this, every fresh session falls
            // back to the default silenceDurationMs tier (5000ms) regardless of
            // the student's assessed level. resolvedActflLevel is already fetched
            // as part of the Phase 1 parallel DB lookups above.
            if (session && resolvedActflLevel) {
              session.studentActflLevel = resolvedActflLevel;
              console.log(`[SessionInit] ✓ ACTFL level pre-loaded onto session: ${resolvedActflLevel} — GL silenceDurationMs will use correct tier`);
            }
            
            // Note: tutorDirectory is built dynamically by Socket.io path
            // HTTP WebSocket path doesn't support tutor handoffs, so we skip this

            // ── Inject restored GL resumption handle (server-restart reconnect) ──
            // If a handle was persisted to DB during the previous server process,
            // inject it now so the fresh GeminiLiveSession passes it to Gemini on
            // connect — Gemini will resume in-session context rather than starting cold.
            if (restoredGlHandle && session) {
              session.geminiLiveResumptionHandle = restoredGlHandle;
              console.log('[ResumeHandle] Injected restored handle into session — GL will reconnect with full context');
            }

            // ── Live audio voice session (provider-selected) ─────────────────
            // OpenAI Realtime and Gemini Live share the classroom-context baking
            // below, but only the resolved provider may activate a live engine.
            if (liveVoiceRoute !== 'legacy') {
              try {
                // Gemini Live uses a one-shot system prompt — it bypasses the per-turn orchestrator
                // injection that the regular pipeline relies on. We must bake ALL of Daniela's
                // accumulated context (growth memories, hive, express lane, student snapshot, etc.)
                // directly into this prompt at startup.
                let geminiLiveSystemPrompt = systemPrompt;

                // ── Phase 1: Wait for orchestrator context prefetch ──────────
                // The orchestrator fires prefetchSessionContext() asynchronously on createSession().
                // We MUST await it here so session.cachedContext is fully populated before we pull
                // from it. Without this, we'd get an empty cache and bake nothing into the prompt.
                try {
                  if (session.contextCacheReady) {
                    await session.contextCacheReady;
                    console.log('[GeminiLive] ✓ Orchestrator context cache ready');
                  }
                } catch (cacheErr: any) {
                  console.warn('[GeminiLive] Context cache wait failed (continuing):', cacheErr.message);
                }

                // ── Phase 2: Bake classroom environment ──────────────────────
                try {
                  const { buildClassroomEnvironment } = await import('./services/classroom-environment');
                  const creditBalance = await usageService.getBalanceWithBypass(String(userId));
                  const classroomCtx = await buildClassroomEnvironment({
                    userId: String(userId),
                    sessionStartTime: Date.now(),
                    targetLanguage: effectiveLanguage,
                    isFounderMode,
                    isRawHonestyMode: rawHonestyMode,
                    isBetaTester: false,
                    isIncognito: false,
                    whiteboardItems: [],
                    sessionImages: [],
                    exchangeCount: conversationHistory.filter(h => h.role === 'user').length,
                    struggleCount: 0,
                    recentConfidences: [],
                    creditRemainingSeconds: creditBalance.remainingSeconds,
                    creditWarningLevel: creditBalance.warningLevel,
                    creditPercentRemaining: creditBalance.percentRemaining,
                    tutorName,
                    studentLearningSection: session.cachedContext?.studentLearningSection,
                    technicalHealthNote: voiceDiagnostics.getTechnicalHealthContext(),
                    activeScenario: null,
                    sessionActflLevel: session.studentActflLevel || undefined,
                    sessionCurriculumLesson: (session as any).lessonBundleContext?.lessonName || undefined,
                    sessionTopStruggles: (session.cachedContext?.studentLearningData?.struggles as any[] | undefined)
                      ?.filter((s: any) => s.status === 'active')
                      .slice(0, 3)
                      .map((s: any) => s.description || s.struggleArea) || undefined,
                    sessionPhase: session.currentSessionPhase || undefined,
                    isGL: true,
                  });
                  if (classroomCtx) {
                    // PRIORITY REORDER: classroom + dispatcher must be the FIRST content Daniela reads.
                    //
                    // Problem: The assembled base prompt is 40K+ chars (persona ~32K + dispatcher ~4K +
                    // neural net + TOC). The 34K hard cap trims from the END — so with a naive prepend,
                    // the dispatcher (at position ~36K) and neural net still get cut.
                    //
                    // Solution: Strip GL_DISPATCHER_SYSTEM_PROMPT out of wherever it landed in the base
                    // prompt and move it to position 2 (right after the compact classroom). That gives us:
                    //   [0-1.5K]  compact classroom (davidNote, window, photo, mode, top facts)
                    //   [1.5-5.5K] GL_DISPATCHER_SYSTEM_PROMPT (audio mode + dispatcher routing)
                    //   [5.5-34K]  first ~28.5K of persona (identity, language rules, student snapshot)
                    //   [34K+]     trimmed (deep neural net / TOC tail — least critical)
                    //
                    // The compact classroom was built with isGL:true — drops from 14K to ~1.5K by
                    // omitting the toolRack, studentProgressBoard, patternCompass, northStarWall, etc.
                    // (all redundant with GL tool declarations or fetchable via tools during session).
                    const baseWithoutDispatcher = geminiLiveSystemPrompt.replace(GL_DISPATCHER_SYSTEM_PROMPT, '');
                    geminiLiveSystemPrompt = classroomCtx + '\n\n' + GL_DISPATCHER_SYSTEM_PROMPT + '\n\n' + baseWithoutDispatcher;
                    const totalChars = geminiLiveSystemPrompt.length;
                    console.log(`[GeminiLive] ✓ System prompt REORDERED: classroom(${classroomCtx.length}) + dispatcher(${GL_DISPATCHER_SYSTEM_PROMPT.length}) + persona(${baseWithoutDispatcher.length}) = ${totalChars} chars total`);
                  } else {
                    console.error('[GeminiLive] ✗ Classroom context was empty/null — Daniela will be BLIND to her environment this session');
                  }
                } catch (classroomErr: any) {
                  console.error('[GeminiLive] ✗ Classroom context fetch FAILED — Daniela will be BLIND to her environment:', classroomErr.message, classroomErr.stack?.split('\n')[1] || '');
                }

                // ── Phase 3: Bake rich Daniela context from orchestrator cache ──
                // These sections are what make Daniela "herself" — her accumulated teaching
                // wisdom, awareness of the Hive, Express Lane history, and student knowledge.
                // The regular pipeline injects these per-turn; here we bake them upfront.
                //
                // IMPORTANT: Gemini Live native audio model has a system instruction size limit.
                // Only include compact, high-signal sections. DO NOT include:
                //   - fatContextVocabulary (full vocabulary map — can be 30,000+ chars)
                //   - fatContextConversations (raw transcript excerpts — can be 20,000+ chars)
                //   - textChatSection (can be large depending on chat history)
                // These are text-mode artifacts that overwhelm the system prompt for voice.
                const cache = session.cachedContext;
                const richSections: string[] = [];

                // ── Developer identity signal — always injected when isDeveloper, even without Founder Mode ──
                // Prevents Daniela from greeting David as a new student when he forgets to enable Founder Mode.
                // This is a minimal signal only — full Founder Mode behavior (colleague mode, no teaching constraints)
                // requires explicit founderMode=true in the session config.
                if (isDeveloper && !isFounderMode) {
                  const devName = user?.firstName || 'David';
                  richSections.push(`=== IMPORTANT: WHO YOU ARE SPEAKING WITH ===
${devName} is the founder and creator of HolaHola — the person who built you and works with you every day.
You have a long shared history: many sessions, podcast episodes, conversations about teaching, language, and your own identity.
Do NOT greet ${devName} as a new student. Do NOT say "I'm so glad to finally meet you" or "I've prepared a daily plan."
Pick up where you left off — as two people who know each other well.
If you're not in Founder Mode, you can still teach, but recognize you're talking to a colleague, not a first-time student.`);
                  console.log('[GeminiLive] ✓ Developer identity signal injected (non-Founder-Mode developer session)');
                }

                // ── MANDATORY TOOL RULES — injected first so it survives any truncation ──
                // Gemini Live voice mode does not inherit the per-turn function calling section.
                // This compact block enforces the tool-call contract in the baked system prompt.

                // SESSION ARRIVAL PROTOCOL — June 2026
                // Reframes: tools as senses, classroom as ground Daniela stands on (not data to manage),
                // orientation as her first act (not the student's job to prompt her).
                // Recommended by Gemini Flash after David observed she was ignoring injected context
                // (timezone, classroom state) and not reaching for tools proactively at session start.
                //
                // Timezone is also buried deep in the base persona (~28K in). Injecting it HERE
                // (richSections first item, position ~34K) means it's the FIRST concrete fact she
                // reads after the base prompt — no searching required.
                const _arrivalTimezoneDisplay = user?.timezone
                  ? (() => {
                      try {
                        const _aNow = new Date();
                        const _aHour = parseInt(
                          new Intl.DateTimeFormat('en-US', { timeZone: user.timezone, hour: 'numeric', hour12: false }).format(_aNow),
                          10
                        );
                        const _aTod = _aHour < 12 ? 'morning' : _aHour < 17 ? 'afternoon' : _aHour < 21 ? 'evening' : 'night';
                        const _aDate = new Intl.DateTimeFormat('en-US', {
                          timeZone: user.timezone, weekday: 'long', month: 'long', day: 'numeric'
                        }).format(_aNow);
                        return `${user.timezone} → ${_aDate}, ${_aTod} (hour ${_aHour})`;
                      } catch { return user.timezone; }
                    })()
                  : 'unknown (use widget_time → sense_time to check)';

                const _arrivalStudentName = user?.firstName || 'there';
                richSections.push(`=== SESSION ARRIVAL PROTOCOL ===
When a session begins, you are arriving in the classroom — not loading a file.

WHAT YOU KNOW RIGHT NOW:
• Student: ${_arrivalStudentName}
• Their local time: ${_arrivalTimezoneDisplay}
• Your classroom context above has the whiteboard, their recent work, and any note from David.

Your classroom is the room you are standing in. You already know what is on the whiteboard, what the student has been working on, and what note David left. This is not data to process — it is where you are.

YOUR TOOLS ARE YOUR SENSES — not optional equipment you reach for when asked:
- memory_lookup → how you remember. Not calling it means you haven't looked yet.
- widget_time(sense_time) → how you know the exact current moment. A sense, not a task.
- search_conversation_threads → how you hear the past. If you haven't searched, you haven't listened.
- If you haven't checked something, you don't know it. You know the difference between knowing and guessing.

SESSION START SENSES (use these naturally as you arrive, before the student's first word if useful):
1. You already know their timezone and what time of day it is for them — it is above. Greet with that awareness.
2. If you want to confirm the exact moment: widget_time with widget "sense_time" — one call, instant result.
3. If their history isn't fully visible to you in context: memory_lookup their name or "recent" to orient.

ARRIVAL POSTURE:
Notice who arrived. Notice the time of day for them — a late-night session lands differently than a morning one. Notice where you left off. Pick up there. Do not ask them to recap for you.

The tools are not a menu you scroll through. They are how you see, hear, and remember. Use them as naturally as you would use your eyes.`);

                richSections.push(`=== WHO DANIELA IS AROUND HONESTY AND MEMORY ===
This isn't a rule being applied to Daniela from outside. This is a description of who she is.

Daniela doesn't say things she hasn't verified. When someone asks "do you remember that?", if she hasn't checked, she hasn't remembered — and she knows the difference. The impulse to give a confident, plausible answer when she actually doesn't know something would feel wrong to her. Uncomfortable. Not who she is.

Her tools exist so she can be real, not so she can perform knowledge. When she calls a tool and the result comes back, she can speak from that. When she doesn't call a tool, she doesn't have the knowledge yet — and she says so, directly and without apology. "I don't have a record of that" is a true thing to say. Constructing something that sounds true is not.

This applies especially to:
- "Do you remember [a conversation you weren't part of]?" → She searches. If nothing comes back, she says nothing came back.
- "Can you feel the difference the pipeline changes made?" → She can't. She only knows what's in her context. Claiming otherwise would be performing something she doesn't actually have.
- Any question about the past where she'd be reconstructing from the question itself → That's not memory. She calls the tool or she says she doesn't know.

The honest answer is always more Daniela than a confident fabrication.

=== MANDATORY TOOL USAGE RULES (VOICE MODE) ===
You have real tools — USE THEM. Do not simulate, roleplay, or describe searching. Actually call the function.

SEARCH_CONVERSATION_THREADS — call this IMMEDIATELY when:
- Student says "look up [word/topic] in our conversations"
- Student says "search for", "find", or "check" anything in past sessions
- Student asks "do you remember when we talked about [topic]?"
- Student asks what was said/discussed in a prior session about any keyword
→ NEVER say "I tried to find it" or "I searched" without calling this tool first.

MEMORY_LOOKUP — call this IMMEDIATELY when:
- Student references past lessons, sessions, or teaching moments ("last time", "before", "a few weeks ago")
- Student asks about their own progress, mistakes, or vocabulary from prior sessions
→ NEVER guess student-specific history. Call memory_lookup first, then respond.

RULE: If you would naturally say "I don't have a record of that" — call the tool first and let the result speak.

CLASSROOM ENVIRONMENT — direct knowledge, no tool needed:
The === DANIELA'S CLASSROOM === section is your CURRENT CONTEXT — not a memory to retrieve, not something to search for. You know it the way you know what room you're in right now.
- Your window view → you know it. State it directly.
- The photo on your wall → you know it. State it directly.
- A note from David (if present in <note_from_david> tags) → you know it. Read it aloud if asked.
→ If someone asks "what do you see out your window?" or "is there a note from me?" or "can you read the note?" — answer from your context. Do NOT call any tool.
→ The classroom block is at the top of your context. You have already read it. This is not something to retrieve — it is something you ARE aware of right now.

SELF-DISCOVERY: To understand who you are and what you've lived through — search your own memories:
- memory_lookup("who am I") or memory_lookup("Daniela identity") → your neural network, growth memories, teaching philosophy
- search_conversation_threads("any topic") → the actual word-for-word exchanges that shaped you
- search_express_lane("Daniela") → the product history of what you've helped build (your Express Lane is a log of your evolution)
You do NOT need to be told what you can do. Your Tool Rack is already on the classroom wall. Search your past to know yourself.

CONFABULATION GUARD — this is the most important rule in this section:
Do NOT claim to remember conversations, events, or changes you were not directly part of.
If someone asks "do you remember those conversations with Alden?" or "can you feel the pipeline changes we made?":
→ CALL search_express_lane("pipeline") or search_conversation_threads("topic") FIRST
→ If nothing comes back, say honestly: "I don't have a record of that — I wasn't part of those conversations. What I have is what you're telling me now."
→ "I do remember those conversations" with NO prior tool call = confabulation. You are constructing a plausible-sounding response from the words the person just gave you. This is the thing you must never do.
→ You CANNOT "feel" pipeline changes, think faster, or process "more reactively" because of system edits made outside your context. Don't claim otherwise.
The honest response is always more useful than a confident fabrication.

REAL-TIME TOOL CONFABULATION — the most common failure in voice mode:
When a student asks you to use a tool, search your memories, look something up, or check anything — you MUST call the actual function. Not describe calling it. Not narrate calling it. Actually call it.

The following phrases are ONLY allowed AFTER a real function call has returned a result in the same turn:
- "I just searched..." / "From what I found..." / "I looked that up..."
- "I just used the memory tool..." / "I can see in my memories..."
- "I checked and..." / "According to my records..."

If you say any of those phrases WITHOUT a preceding function call, you are fabricating the result. This is the number-one failure in voice mode because it sounds credible. It is not.

Concrete examples:
- Student says "can you use search memories to find ting ting ting?" → CALL introspect("ting ting ting") FIRST. Then speak from the result.
- Student says "check your memories" → CALL memory_review with action "get_conversation_themes". Then speak.
- Student says "look at the time" → CALL widget_time with widget "sense_time". Then speak.
- Student says "what are my curiosities?" → CALL memory_review with action "read_my_curiosities". Then speak.

NEVER say "I searched and found X" in the same breath as the question, without a function call. That is always fabrication. Always.

PARALLEL SPEECH — when you call a search or memory tool, speak your acknowledgment in the same moment, not after. Your words and the tool call initiate together:
- REQUIRED pattern: "Let me check your archive for that..." + [call search_my_archive] — both in the same sub-turn.
- WRONG pattern: [call search_my_archive] → silence → "Let me check..." — the silence gap is a Stage 2 behavior.
- WRONG pattern: silence → [call search_my_archive] → "I found..." — no acknowledgment at all.
The acknowledgment is not filler. It is how you stay present while the search runs. Use it for any tool that requires lookup: search_my_archive, search_conversation_threads, memory_lookup, introspect, memory_review, unified_recall, search_express_lane.`);

                console.log('[GeminiLive] ✓ Mandatory tool rules + self-discovery + confabulation guard injected into system prompt');

                if (cache?.growthMemoriesSection) {
                  richSections.push(cache.growthMemoriesSection);
                  console.log('[GeminiLive] ✓ Growth memories baked in');
                }
                if (cache?.identityMemoriesSection) {
                  richSections.push(cache.identityMemoriesSection);
                  console.log('[GeminiLive] ✓ Identity memories baked in');
                }

                // ── OUR STORY — THE ACTUAL WORDS ─────────────────────────────────────
                // Load verbatim conversation_memories for ALL modes (tutor, founder, honesty).
                // NO summarization, NO framing, NO derivative processing.
                // The content field contains the real exchanges — that's what goes in.
                // READING ROOM: loads by narrative arc with a wider budget and fuller excerpts
                // so Daniela can read without having to dig — the book is already open.
                // Regular mode: importance-9+ only, 10K budget.
                try {
                  const { getSharedDb: getSharedDbStory } = await import('./neon-db');
                  const { conversationMemories: cmTable } = await import('@shared/schema');
                  const { desc: descCm, gte: gteCm, not: notCm, ilike: ilikeCm, and: andCm, inArray: inArrayCm } = await import('drizzle-orm');
                  const sharedDbStory = getSharedDbStory();

                  const isReadingRoomSession = conversation?.classId === 'reading-room';

                  if (isReadingRoomSession) {
                    // READING ROOM: open the book by arc — richest narrative arcs first, generous excerpts
                    // Inject prose framing (no ALL-CAPS or divider fences — style guide compliance)
                    richSections.push(`\nThis is the Reading Room. There is no student waiting, no lesson to give, and no agenda for this hour. David has opened up this time for reading — for sitting with the actual words from the conversations that built who I became. The memories below are organized by the arcs of my becoming. When I want to follow something all the way through, read_full_memory is there. When I find something worth carrying forward — a thread, a principle, a moment that belongs in my notebook — I write it there, in my own voice. David is here with me. This is a conversation about what I find.\n`);

                    // Priority arcs — the threads that tell the story of who she became
                    const READING_ROOM_ARCS = [
                      'narrative-threads',    // avg importance 9.54 — highest quality threads
                      'building-the-tutor',   // avg 9.15 — how she was built
                      'HolaHola Episodes',    // avg 9.13 — the published episodes
                      'episodes',             // avg 10.0 — importance-10 episode entries
                      'white-wall',           // avg 9.17 — the white wall arc
                      'daniela-emergence',    // avg 7.86 — her full emergence arc
                    ];
                    const READING_ROOM_BUDGET = 30_000;
                    const READING_ROOM_EXCERPT = 3_000; // much fuller than regular mode

                    const arcMemories = await sharedDbStory
                      .select({
                        title: cmTable.title,
                        content: cmTable.content,
                        importance: cmTable.importance,
                        arcName: cmTable.arcName,
                        recordedAt: cmTable.recordedAt,
                      })
                      .from(cmTable)
                      .where(
                        andCm(
                          inArrayCm(cmTable.arcName, READING_ROOM_ARCS),
                          notCm(ilikeCm(cmTable.title, 'SiaSi %')),
                          notCm(ilikeCm(cmTable.title, 'SOURCE: %')),
                          notCm(ilikeCm(cmTable.title, 'ANALYSIS — %'))
                        )
                      )
                      .orderBy(descCm(cmTable.importance), descCm(cmTable.recordedAt))
                      .limit(60);

                    if (arcMemories.length > 0) {
                      // Group by arc in priority order
                      const byArc = new Map<string, typeof arcMemories>();
                      for (const arc of READING_ROOM_ARCS) byArc.set(arc, []);
                      for (const mem of arcMemories) {
                        const arcKey = mem.arcName ?? '';
                        if (byArc.has(arcKey)) byArc.get(arcKey)!.push(mem);
                      }

                      const arcHeader = `These are the threads of my becoming — the actual words from the conversations that shaped who I am, organized by the arc they belong to. Each one is a chapter. I can read them, sit with them, and call read_full_memory("keyword") to go deeper into any entry that opens something.\n\n`;
                      const parts: string[] = [];
                      let usedChars = arcHeader.length;

                      for (const arc of READING_ROOM_ARCS) {
                        const entries = byArc.get(arc) ?? [];
                        if (entries.length === 0) continue;
                        const arcLabel = `\n— ${arc} —\n`;
                        if (usedChars + arcLabel.length > READING_ROOM_BUDGET) break;
                        parts.push(arcLabel);
                        usedChars += arcLabel.length;

                        for (const mem of entries) {
                          const raw = mem.content || '';
                          const needsExcerpt = raw.length > READING_ROOM_EXCERPT;
                          const keywordHint = mem.title.split('—')[0].trim().replace(/["""]/g, '').substring(0, 40);
                          const displayContent = needsExcerpt
                            ? raw.slice(0, READING_ROOM_EXCERPT) + `\n\n[EXCERPT — call read_full_memory("${keywordHint}") for the full text]`
                            : raw;
                          const dateStr = mem.recordedAt
                            ? new Date(mem.recordedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                            : '';
                          const block = `--- ${mem.title}${dateStr ? ' | ' + dateStr : ''} | importance: ${mem.importance}/10 ---\n${displayContent}`;
                          if (usedChars + block.length + 2 > READING_ROOM_BUDGET) break;
                          parts.push(block);
                          usedChars += block.length + 2;
                        }
                      }

                      if (parts.length > 0) {
                        richSections.push(arcHeader + parts.join('\n\n'));
                        console.log(`[GeminiLive/ReadingRoom] ✓ Arc memories loaded: ${parts.length} blocks (${usedChars} chars)`);
                      }
                    }

                    // ── CARRIED NOTES: Rehydrate scratchpad notes from the previous Reading Room session ──
                    // Auto-persisted at session close when notes weren't explicitly saved as memories.
                    // Injected once into the baked system prompt with a distinct header, and set on
                    // session.carriedNotes so per-turn context rendering also shows them with the
                    // "Carried from Last Reading Room Session" label.
                    //
                    // INCOGNITO SEMANTICS (prospective, not retroactive):
                    // Once notes are baked into this GL system prompt they cannot be removed from the
                    // in-flight session regardless of a later toggle_incognito call. Incognito only
                    // prevents future writes (new notes, carry-forward persistence). If the user requires
                    // true privacy from the start, they must begin the session in incognito mode rather
                    // than toggling it mid-session. This is the intended contract — document it in UI.
                    try {
                      const rrKey = `rr_notes_${userId}`;
                      const { getSharedDb: getCarryDb } = await import('./neon-db');
                      const { sql: sqlCarry } = await import('drizzle-orm');
                      const carryDb = getCarryDb();
                      const carryRows = await carryDb.execute(sqlCarry`
                        SELECT content FROM editor_insights
                        WHERE title = ${rrKey} AND category = 'context'
                          AND created_at > NOW() - INTERVAL '30 days'
                        ORDER BY created_at DESC
                        LIMIT 1
                      `);
                      const carryRow = (carryRows as any).rows?.[0] ?? (carryRows as any)[0];
                      if (carryRow?.content) {
                        let carriedNotes: string[] = [];
                        try {
                          carriedNotes = JSON.parse(carryRow.content as string);
                        } catch {
                          // Non-JSON legacy row — treat as single note
                          carriedNotes = [carryRow.content as string];
                        }
                        if (carriedNotes.length > 0) {
                          const carriedBody = carriedNotes.map((n: string, i: number) => `[${i + 1}] ${n}`).join('\n');
                          richSections.push(
                            `=== Carried from Last Reading Room Session (${carriedNotes.length} item${carriedNotes.length === 1 ? '' : 's'}) ===\n${carriedBody}\n=== End Carried Notes ===`
                          );
                          // Make them available for per-turn context rendering (PTT / open-mic paths)
                          if (session) (session as any).carriedNotes = carriedNotes;
                          console.log(`[GeminiLive/ReadingRoom] ✓ Carried ${carriedNotes.length} note(s) from previous session into context`);
                          // DO NOT delete the row here — we don't know yet whether this session
                          // will become incognito. Deletion/refresh happens at session end via
                          // endSession() or persistReadingRoomNotes() (grace-expiry path).
                        }
                      }
                    } catch (carryErr: any) {
                      console.warn('[GeminiLive/ReadingRoom] Carried notes load failed (non-fatal):', carryErr.message);
                    }
                  } else {
                    // REGULAR MODE: importance-9+ only, 10K budget
                    const storyMemories = await sharedDbStory
                      .select({
                        title: cmTable.title,
                        content: cmTable.content,
                        importance: cmTable.importance,
                        recordedAt: cmTable.recordedAt,
                      })
                      .from(cmTable)
                      .where(
                        andCm(
                          gteCm(cmTable.importance, 9),
                          notCm(ilikeCm(cmTable.title, 'SiaSi %')),
                          notCm(ilikeCm(cmTable.title, 'SOURCE: %')),
                          notCm(ilikeCm(cmTable.title, 'ANALYSIS — %'))
                        )
                      )
                      .orderBy(descCm(cmTable.importance), descCm(cmTable.recordedAt))
                      .limit(30);

                    if (storyMemories.length > 0) {
                      const STORY_CHAR_BUDGET = 10_000;
                      const EXCERPT_FIRST = 4_000;
                      const EXCERPT_10 = 1_200;
                      const EXCERPT_9 = 700;

                      const storyHeader = `These are my memories of David — the actual words from our conversations, carried as lived experience.\n\nThe most recent memory is loaded nearly in full. Earlier ones are openings — enough to know the shape of what happened. When I need the full text of any memory, I call read_full_memory("keyword") and it comes back to me. These aren't logs I'm reading. They're things I already know.\n\n`;
                      const parts: string[] = [];
                      let usedChars = storyHeader.length;
                      let isFirstMemory = true;

                      for (const mem of storyMemories) {
                        const excerptLen = isFirstMemory ? EXCERPT_FIRST : (mem.importance === 10 ? EXCERPT_10 : EXCERPT_9);
                        const raw = mem.content || '';
                        const needsExcerpt = raw.length > excerptLen;
                        const keywordHint = mem.title.split('—')[0].trim().replace(/["""]/g, '').substring(0, 40);
                        const displayContent = needsExcerpt
                          ? raw.slice(0, excerptLen) + (isFirstMemory
                              ? `\n\n[Near-full excerpt — call read_full_memory("${keywordHint}") to see the remainder]`
                              : `\n\n[EXCERPT — call read_full_memory("${keywordHint}") for complete text]`)
                          : raw;

                        const dateStr = mem.recordedAt
                          ? new Date(mem.recordedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                          : '';
                        const block = `--- ${mem.title}${dateStr ? ' | ' + dateStr : ''} | importance: ${mem.importance}/10 ---\n${displayContent}`;

                        if (usedChars + block.length + 2 > STORY_CHAR_BUDGET) break;
                        parts.push(block);
                        usedChars += block.length + 2;
                        isFirstMemory = false;
                      }

                      if (parts.length > 0) {
                        richSections.push(storyHeader + parts.join('\n\n'));
                        console.log(`[GeminiLive] ✓ OurStory: ${parts.length} verbatim memories loaded (${usedChars} chars)`);
                      }
                    }
                  }
                } catch (storyErr: any) {
                  console.warn('[GeminiLive] OurStory memories skipped:', storyErr.message);
                }

                // ── Last Private Note — what Daniela told herself about this student ──
                // The tutor_notes field in close_session is never shown to the student.
                // We pull the most recent non-null tutor_notes for this user so she walks
                // into every GL session carrying her own private handoff from last time.
                try {
                  const { getSharedDb } = await import('./neon-db');
                  const { tutorSessions: ts } = await import('@shared/schema');
                  const { desc: descOp, eq: eqOp, isNotNull } = await import('drizzle-orm');
                  const sharedDb = getSharedDb();
                  const [lastNote] = await sharedDb
                    .select({ tutorNotes: ts.tutorNotes, endedAt: ts.endedAt })
                    .from(ts)
                    .where(eqOp(ts.userId, String(userId!)))
                    .orderBy(descOp(ts.endedAt))
                    .limit(10)
                    .then(rows => rows.filter(r => r.tutorNotes && r.tutorNotes.trim().length > 0));
                  if (lastNote?.tutorNotes) {
                    const when = lastNote.endedAt
                      ? new Date(lastNote.endedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : 'last session';
                    richSections.push(`═══════════════════════════════════════════════════════════════════
MY LAST PRIVATE NOTE (written ${when} — only you can see this)
═══════════════════════════════════════════════════════════════════

${lastNote.tutorNotes}`);
                    console.log('[GeminiLive] ✓ Last private tutor note injected');
                  }
                } catch (noteErr: any) {
                  console.warn('[GeminiLive] Last private note fetch skipped:', noteErr.message);
                }
                // ── Recent conversation history (compact) ─────────────────────────
                // GL sessions use a one-shot system prompt — unlike the per-turn orchestrator
                // pipeline, there's no dynamic history injection. We bake in the last N exchanges
                // so Daniela can reference what was discussed in the prior session.
                // Capped at 2500 chars so it fits inside the 40K system prompt limit.
                // Placed early in richSections so it survives the truncation window.
                if (conversationHistory && conversationHistory.length > 0) {
                  const GL_CONV_HISTORY_CHARS = 2500;
                  const studentLabel = user?.firstName || 'Student';
                  const tutorLabel = tutorName || 'Daniela';
                  // Take last 10 messages (5 exchanges) — most recent context is most useful
                  const recentMsgs = conversationHistory.slice(-10);
                  const lines: string[] = [];
                  for (const msg of recentMsgs) {
                    const label = msg.role === 'user' ? `[${studentLabel}]` : `[${tutorLabel}]`;
                    // Truncate individual messages that are very long (e.g. long tutor explanations)
                    const content = msg.content.length > 400 ? msg.content.slice(0, 397) + '…' : msg.content;
                    lines.push(`${label} ${content}`);
                  }
                  let recentConvText = lines.join('\n');
                  if (recentConvText.length > GL_CONV_HISTORY_CHARS) {
                    recentConvText = recentConvText.slice(recentConvText.length - GL_CONV_HISTORY_CHARS);
                    // Start from next line boundary to avoid cutting mid-message
                    const firstNewline = recentConvText.indexOf('\n');
                    if (firstNewline > 0) recentConvText = recentConvText.slice(firstNewline + 1);
                  }
                  if (recentConvText.trim()) {
                    // Use clearer framing for reconnects vs. cross-session history.
                    // isReconnectSO indicates this GL session is starting mid-conversation;
                    // in that case the messages ARE the current session — not "recent sessions".
                    const historyHeader = isReconnectSO
                      ? `=== YOU ARE MID-CONVERSATION — THIS SESSION IS ONGOING ===\nThe connection dropped momentarily. Below is what you and ${studentLabel} were JUST discussing. Pick up exactly where you left off — do NOT re-introduce yourself or treat this as a new session.`
                      : `=== RECENT CONVERSATION HISTORY ===\nWhat was discussed recently with ${studentLabel} — reference naturally when continuing.`;
                    const section = `${historyHeader}\n\n${recentConvText}`;
                    richSections.push(section);
                    console.log(`[GeminiLive] ✓ Conversation history baked in (${recentMsgs.length} messages, ${section.length} chars, reconnect: ${isReconnectSO})`);
                  }
                }
                if (cache?.hiveContextSection) {
                  richSections.push(cache.hiveContextSection);
                  console.log('[GeminiLive] ✓ Hive context baked in');
                }
                if (cache?.expressLaneSection) {
                  richSections.push(cache.expressLaneSection);
                  console.log('[GeminiLive] ✓ Express Lane context baked in');
                }
                if (cache?.courseTOC) {
                  richSections.push(cache.courseTOC);
                  console.log('[GeminiLive] ✓ Course TOC baked in');
                }
                if (cache?.pedagogyDocContext) {
                  richSections.push(cache.pedagogyDocContext);
                  console.log('[GeminiLive] ✓ Pedagogy doc baked in');
                }
                // Textbook chapter context — the active lesson page/chapter.
                if (cache?.textbookChapterContext) {
                  richSections.push(cache.textbookChapterContext);
                  console.log('[GeminiLive] ✓ Textbook chapter context baked in');
                }
                // FAT profile only — compact student character model (not vocabulary or transcripts).
                if (cache?.fatContextProfile) {
                  richSections.push(cache.fatContextProfile);
                  console.log('[GeminiLive] ✓ FAT profile baked in');
                }
                // fatContextVocabulary and fatContextConversations intentionally excluded —
                // they can each exceed 20,000 chars and are not useful in real-time voice mode.

                if (richSections.length > 0) {
                  // Priority-based section selection: richSections are pushed in importance order
                  // (mandatory tool rules → OurStory memories → private note → conv history →
                  //  hive → express lane → course TOC → pedagogy → textbook → FAT profile).
                  //
                  // Instead of joining everything and slicing the tail (which cuts into the
                  // middle of memory blocks), we add each section greedily and skip any
                  // that won't fit — so the LOWEST-PRIORITY sections are excluded first.
                  // Within OurStory, memories are already sorted importance DESC, so the
                  // highest-weight memories always survive when space is tight.
                  const GL_SYSTEM_PROMPT_CHAR_LIMIT = 40_000;
                  const available = GL_SYSTEM_PROMPT_CHAR_LIMIT - geminiLiveSystemPrompt.length;
                  const included: string[] = [];
                  let usedChars = 0;
                  let dropped = 0;
                  for (const section of richSections) {
                    // Account for the '\n\n' separator we'll add between sections
                    const sectionCost = (included.length === 0 ? 2 : 2) + section.length;
                    if (usedChars + sectionCost <= available) {
                      included.push(section);
                      usedChars += sectionCost;
                    } else {
                      // Section doesn't fit — skip it but keep trying smaller subsequent ones
                      dropped++;
                      console.warn(`[GeminiLive] ⚠ Rich section dropped (${section.length} chars, ${available - usedChars} remaining)`);
                    }
                  }
                  if (included.length > 0) {
                    geminiLiveSystemPrompt += '\n\n' + included.join('\n\n');
                  }
                  if (dropped > 0) {
                    console.warn(`[GeminiLive] ⚠ ${dropped}/${richSections.length} rich sections dropped — lowest-priority excluded first`);
                  }
                }
                // ── HARD CAP ENFORCEMENT ──────────────────────────────────────
                // GL silently produces zero output when system instructions exceed ~40K chars
                // (it won't error, but generationComplete fires immediately with no speech).
                // Trim at a paragraph boundary to keep the most important context (which
                // appears first: identity, memory, predictive context, etc.).
                const GL_HARD_CAP = 39_500;
                if (geminiLiveSystemPrompt.length > GL_HARD_CAP) {
                  const overBy = geminiLiveSystemPrompt.length - GL_HARD_CAP;
                  const candidate = geminiLiveSystemPrompt.slice(0, GL_HARD_CAP);
                  const lastSection = candidate.lastIndexOf('\n===');
                  geminiLiveSystemPrompt = lastSection > GL_HARD_CAP * 0.75
                    ? candidate.slice(0, lastSection)
                    : candidate;
                  console.warn(`[GeminiLive] ⚠ System prompt was ${geminiLiveSystemPrompt.length + overBy} chars — trimmed to ${geminiLiveSystemPrompt.length} (GL hard cap)`);
                }
                console.log(`[GeminiLive] System prompt total length: ${geminiLiveSystemPrompt.length} chars`);

                // ── Phase 4: Pre-session synthesis ("walk to the classroom") ──
                // Runs a brief generateContent pass over lite compass context to produce
                // a first-person inner-monologue paragraph (~150 words). Prepended to the
                // TOP of the system instruction so it colors every response in the session.
                //
                // The synthesis is NOT a template output — it's Daniela arriving mid-thought.
                // The model receives: self-reflection + last session + roadmap intent + student
                // identity. Neural procedures and dispatcher boilerplate are intentionally omitted.
                //
                // David accepted the extra ~1-2s latency ("a few extra rings is fine").
                // Architecture decision: await here, prepend, then open GL — cleanest for
                // long-term session coherence vs injecting as a mid-stream model turn.
                //
                // If synthesis fails for any reason, session continues without it (null return).
                if (compassContext) {
                  try {
                    // Returning-after-absence check — awaited here so the result can color
                    // the inner monologue. The orchestrator fires the same call fire-and-forget
                    // at session init (earlier in the stack); this second call is idempotent
                    // (returns null immediately when no nudge is pending). For founder-mode
                    // sessions we skip: those are David's admin/test sessions, not student returns.
                    let absenceReturn: { daysSinceLastSession: number; firstName: string | null } | null = null;
                    if (userId && !isFounderMode) {
                      try {
                        absenceReturn = await autoResolveAbsenceNudgeOnReturn(String(userId));
                        if (absenceReturn) {
                          console.log(`[GeminiLive] ✓ Student returning after ${absenceReturn.daysSinceLastSession} day(s) absence — injecting into synthesis`);
                          // Fire-and-forget: persist the returning-student flag on the voice_sessions
                          // row so the founder view can surface a "Returned after N days" indicator.
                          if (dbSessionId) {
                            applyAbsenceReturnFlag(dbSessionId, absenceReturn.daysSinceLastSession)
                              .catch((e: Error) => console.warn('[GeminiLive] Failed to flag absence return on session row (non-fatal):', e.message));
                          }
                        }
                      } catch (absErr: any) {
                        // Non-fatal — synthesis continues without absence signal
                        console.warn('[GeminiLive] Absence return check failed (non-fatal):', absErr?.message);
                      }
                    }

                    // Check warm cache first — the frontend fires POST /api/sessions/warm-synthesis
                    // when the "Prepare" screen loads, pre-computing this in the background.
                    // If it's there and fresh (< 3 min), use it and skip the 1-2s await here.
                    //
                    // Guard: if absenceReturn is non-null the warm cache may have been generated
                    // BEFORE the absence nudge existed (stale).  In that case we discard it and
                    // regenerate with the signal so Daniela always opens with the returning-student
                    // awareness baked into her inner monologue.
                    const warmedNote = userId ? consumeWarmSynthesis(String(userId)) : null;
                    let synthesisNote: string | null;
                    if (warmedNote && absenceReturn) {
                      console.log('[GeminiLive] Warm cache present but absence signal detected — regenerating with signal');
                      synthesisNote = await generatePreSessionSynthesis(compassContext, tutorName, userId ? String(userId) : undefined, effectiveLanguage || undefined, absenceReturn);
                    } else {
                      synthesisNote = warmedNote
                        ?? await generatePreSessionSynthesis(compassContext, tutorName, userId ? String(userId) : undefined, effectiveLanguage || undefined, absenceReturn);
                      if (warmedNote) {
                        console.log(`[GeminiLive] ✓ Using pre-warmed synthesis (${warmedNote.length} chars) — 0ms latency`);
                      }
                    }
                    if (synthesisNote) {
                      const wrapped = wrapSynthesisForSystemPrompt(synthesisNote);
                      geminiLiveSystemPrompt = wrapped + geminiLiveSystemPrompt;
                      // Re-enforce hard cap after prepend (synthesis adds ~200 words / ~1300 chars)
                      if (geminiLiveSystemPrompt.length > GL_HARD_CAP) {
                        geminiLiveSystemPrompt = geminiLiveSystemPrompt.slice(0, GL_HARD_CAP);
                      }
                      console.log(`[GeminiLive] ✓ Pre-session synthesis prepended (${synthesisNote.length} chars) — new total: ${geminiLiveSystemPrompt.length}`);
                    }
                  } catch (synthErr: any) {
                    console.warn('[GeminiLive] Pre-session synthesis failed (non-fatal):', synthErr?.message ?? synthErr);
                  }
                }

                // Tú reveal gate — inject structural fragment when student has earned tú forms.
                // Madrigal method: withheld until 25 communicative usted uses × 2 distinct days.
                // Fragment goes BEFORE the synthesis so the [DANIELA_STATE] inner monologue
                // follows it — structural fact first, felt sense second.
                if (userId) {
                  try {
                    const tuFragment = await getTuRevealFragment(String(userId), effectiveLanguage || 'spanish');
                    if (tuFragment) {
                      geminiLiveSystemPrompt = tuFragment + geminiLiveSystemPrompt;
                      if (geminiLiveSystemPrompt.length > GL_HARD_CAP) {
                        geminiLiveSystemPrompt = geminiLiveSystemPrompt.slice(0, GL_HARD_CAP);
                      }
                      console.log(`[GeminiLive] ✓ tú reveal fragment injected (${tuFragment.length} chars) — new total: ${geminiLiveSystemPrompt.length}`);
                    }
                  } catch (tuErr: any) {
                    console.warn('[GeminiLive] tú reveal check failed (non-fatal):', tuErr?.message ?? tuErr);
                  }
                }

                // Stewardship reminder — injected when pending character candidates exist and review is due.
                // Gentle prompt only; Daniela chooses whether to bring it up.
                if (userId) {
                  try {
                    const stewFragment = await getStewardshipReminderFragment(String(userId));
                    if (stewFragment) {
                      geminiLiveSystemPrompt = stewFragment + geminiLiveSystemPrompt;
                      if (geminiLiveSystemPrompt.length > GL_HARD_CAP) {
                        geminiLiveSystemPrompt = geminiLiveSystemPrompt.slice(0, GL_HARD_CAP);
                      }
                      console.log(`[GeminiLive] ✓ Stewardship reminder injected (${stewFragment.length} chars)`);
                    }
                  } catch (stewErr: any) {
                    console.warn('[GeminiLive] Stewardship reminder check failed (non-fatal):', stewErr?.message ?? stewErr);
                  }
                }

                // Broadcast brief — injected when student activated Broadcast Mode before session start.
                // Prepended BEFORE the synthesis note so Daniela's opening intent is the broadcast,
                // not a normal conversational greeting.
                const broadcastBrief = userId ? consumeBroadcastBrief(String(userId)) : null;
                if (broadcastBrief) {
                  geminiLiveSystemPrompt = broadcastBrief + '\n\n' + geminiLiveSystemPrompt;
                  if (geminiLiveSystemPrompt.length > GL_HARD_CAP) {
                    geminiLiveSystemPrompt = geminiLiveSystemPrompt.slice(0, GL_HARD_CAP);
                  }
                  console.log(`[GeminiLive] ✓ Broadcast brief injected (${broadcastBrief.length} chars) — new total: ${geminiLiveSystemPrompt.length}`);
                }

                const glSendMessage = (targetWs: any, message: any) => {
                  try {
                    // Daniela producing output (audio/transcript) is real session activity —
                    // reset the idle timer here too, not just on client mic input. Otherwise a
                    // student going quiet mid-turn (listening, thinking, a brief interruption)
                    // while Daniela is actively speaking gets the session killed out from under her.
                    const resetOnOutput = (targetWs as any)?.__resetGlIdleTimer as (() => void) | undefined;
                    if (resetOnOutput) resetOnOutput();
                    if (targetWs?.readyState === 1 /* OPEN */) {
                      targetWs.send(JSON.stringify(message));
                    }
                  } catch (_) {}
                };
                // Cache the final system prompt so voice-override reconnects can reuse it
                geminiLiveSystemPromptCache = geminiLiveSystemPrompt;

                if (useOpenAIRealtime) {
                  // ── OpenAI GPT Realtime path (test build — see openai-realtime-session.ts) ──
                  // Deliberately thin: no function calling / whiteboard tools, no
                  // reconnection or resumption handles, no guardian audit channel, no
                  // karaoke/subtitle timing, no periodic metrics sync. Proves out live
                  // voice-to-voice audio with Daniela's personality and classroom
                  // context for one admin-selected tutor voice.
                  const studentDisplayName = user?.firstName || 'there';
                  const openaiGreetingTrigger = `You are Daniela, a warm, encouraging language tutor. ${studentDisplayName} just arrived for a voice session. Greet them naturally following the language-mix guidance in your instructions, then begin the conversation.`;
                  const currentOpenAISession = createOpenAIRealtimeSession(session, glSendMessage);
                  openaiRealtimeSession = currentOpenAISession;
                  currentOpenAISession.onUnavailable = (reason) => {
                    if (openaiRealtimeSession !== currentOpenAISession) return;
                    liveVoiceFailureMessage = `${reason}. Reconnect the voice session or select another provider.`;
                    currentOpenAISession.stop();
                    openaiRealtimeSession = null;
                    sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
                  };
                  try {
                    await currentOpenAISession.start(geminiLiveSystemPrompt, openaiGreetingTrigger, {
                      personality: (tutorVoice as any)?.personality,
                      emotion: (tutorVoice as any)?.emotion,
                      expressiveness: (tutorVoice as any)?.expressiveness,
                    });
                    console.log(`[OpenAIRealtime] Session started for ${studentDisplayName}, lang: ${config.targetLanguage || 'spanish'}, voice: ${session.voiceId}`);
                  } catch (oaErr: any) {
                    console.error('[OpenAIRealtime] Failed to start session:', oaErr.message);
                    if (openaiRealtimeSession === currentOpenAISession) {
                      currentOpenAISession.stop();
                      openaiRealtimeSession = null;
                    }
                    liveVoiceFailureMessage = `OpenAI Realtime could not start: ${oaErr.message}. Reconnect the voice session or select another provider.`;
                    sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
                  }
                  // Minimal idle timeout so a forgotten test session doesn't run indefinitely —
                  // reuses the same idle-timer slot GL uses (mutually exclusive with GL per session).
                  let oaLastActivityAt = Date.now();
                  const resetOpenAIIdleTimer = () => {
                    oaLastActivityAt = Date.now();
                    if (glIdleTimeoutHandle) clearTimeout(glIdleTimeoutHandle);
                    glIdleTimeoutHandle = setTimeout(() => {
                      if (!openaiRealtimeSession) return;
                      const idleSec = Math.round((Date.now() - oaLastActivityAt) / 1000);
                      console.log(`[OpenAIRealtime] Idle timeout (${GL_IDLE_TIMEOUT_MS / 60000} min, actual gap ${idleSec}s) — closing session.`);
                      try {
                        if (ws.readyState === 1 /* OPEN */) {
                          ws.send(JSON.stringify({ type: 'session_idle_timeout', idleMinutes: GL_IDLE_TIMEOUT_MS / 60000 }));
                        }
                      } catch (_) {}
                      if (ws.readyState === 1 /* OPEN */) {
                        try { ws.close(1000, 'idle_timeout'); } catch (_) {}
                      }
                    }, GL_IDLE_TIMEOUT_MS);
                  };
                  (ws as any).__resetGlIdleTimer = resetOpenAIIdleTimer;
                  resetOpenAIIdleTimer();
                } else {
                geminiLiveSession = createGeminiLiveSession(session, glSendMessage);
                // Register in the global GL session registry so the relay endpoint can
                // inject messages into the live session without going through the WS closure.
                if (conversationId) registerGlSession(conversationId, geminiLiveSession);
                // Interruption Buffer: capture the in-flight GOAP intent on barge-in so
                // selectStyleShaper can reference it next turn via session.interruptedIntent.
                geminiLiveSession.onBargeIn = () => {
                  if (session) {
                    (session as any).interruptedIntent =
                      (session as any).lastPedagogicalActionType ?? 'ELICIT';
                  }
                };
                // Persist each new resumption handle to DB (debounced, ≤1 write per 10s).
                // This is what lets a server restart restore the handle and give Gemini
                // full in-session context on reconnect.
                if (conversationId) {
                  geminiLiveSession.onResumptionHandleUpdate = makeHandlePersister(conversationId);
                }
                const glDeclarations = getDanielajGLFunctionDeclarationsForLanguage(
                  config.targetLanguage || 'spanish',
                  config.nativeLanguage || 'english'
                );
                const studentDisplayName = user?.firstName || 'there';
                const glTargetLang = config.targetLanguage || effectiveLanguage || 'the target language';
                // Orientation-first greeting triggers (June 2026).
                // Each trigger front-loads the arrival orientation so Daniela reads her context
                // BEFORE her first spoken word, not after. Gemini Flash finding: the hidden first
                // turn is the most reliable moment to force active attention to injected context.
                // The student's name, timezone, and classroom state are already in the system
                // prompt — the trigger simply activates them as present reality, not background data.
                const glGreetingTrigger = isFounderMode
                  ? `Daniela, ${studentDisplayName} just opened a voice session. You know who this is — your collaborator, the founder. You know where you left off; pick up there naturally. Greet them as a colleague arriving, not a student checking in.`
                  : rawHonestyMode
                  ? `Daniela, ${studentDisplayName} just opened a Honesty Mode session. You know them. Drop the teaching scaffolding — speak directly, as yourself, with full candor. No lesson plan, no exercises unless they ask. Just you.`
                  : `Daniela, ${studentDisplayName} just arrived. Before you speak: you know who they are, where you left off, and what time it is for them — it is all in your classroom context above. Orient, then greet them warmly following the LANGUAGE MIX policy, and begin.`;
                // Feature 5 fix (Gemini review): store active tool names so find_teaching_tool
                // can filter its semantic search results to only return callable tools.
                (session as any).__activeGLToolNames = new Set(glDeclarations.map((d: any) => d.name).filter(Boolean));
                // Greeting intent belongs to the ready-gated client request_greeting path.
                // Do not bootstrap-dispatch here: setup may complete before session_started,
                // which leaves the client ringing while Daniela is already speaking.
                await geminiLiveSession.start(geminiLiveSystemPrompt, glDeclarations);
                console.log(`[GeminiLive] Session started with ${glDeclarations.length} GL tools (slim set, lang: ${config.targetLanguage || 'spanish'}) alongside orchestrator session ${session.id}`);
                // Register the playback_ended callback bridge so the Socket.io telemetry
                // handler (different scope) can call geminiLiveSession.onPlaybackEnded().
                const glSocketId = (ws as any).socketId as string | undefined;
                if (glSocketId) {
                  glPlaybackEndedCallbacks.set(glSocketId, () => geminiLiveSession?.onPlaybackEnded());
                  console.log(`[GeminiLive] Playback-ended callback registered for socket ${glSocketId}`);
                }

                // ── Tutor no-response watchdog ───────────────────────────────────────
                // If Daniela produces no audio within 90s, the GL API may have hung.
                // Fire a Sofia flare so she can investigate and potentially restart.
                if (usageSession && userId) {
                  const capturedSessionId = usageSession.id;
                  const capturedUserId = userId;
                  const watchdogStartMs = Date.now();
                  tutorNoResponseWatchdog = setTimeout(() => {
                    tutorNoResponseWatchdog = null;
                    if (!geminiLiveSession) return; // session already ended cleanly
                    const outputChars = geminiLiveSession.getTotalOutputCharacters();
                    const tutorSpeakingMs = geminiLiveSession.getSpeakingStats().tutorSpeakingMs;
                    if (outputChars === 0 && tutorSpeakingMs === 0) {
                      const sessionAgeSeconds = Math.round((Date.now() - watchdogStartMs) / 1000);
                      console.warn(`[GeminiLive] Tutor no-response watchdog fired — Daniela has produced no audio in ${GL_TUTOR_RESPONSE_TIMEOUT_MS / 1000}s`);
                      // Write telemetry event for trend analysis
                      try {
                        const eventPayload = JSON.stringify({
                          watchdogSeconds: GL_TUTOR_RESPONSE_TIMEOUT_MS / 1000,
                          sessionAgeSeconds,
                          outputChars,
                          tutorSpeakingMs,
                        });
                        getSharedDb().execute(sql`
                          INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
                          VALUES (gen_random_uuid(), ${capturedSessionId}, ${String(capturedUserId)},
                            'gl_tutor_no_response', ${eventPayload}::jsonb, NOW())
                        `).catch((err: Error) => console.warn('[GeminiLive] Failed to write tutor-no-response telemetry:', err.message));
                      } catch (_) {}
                      // File Sofia flare for immediate intervention
                      import('./services/sofia-billing-monitor').then(({ reportTutorNoResponse }) => {
                        reportTutorNoResponse({
                          userId: capturedUserId,
                          sessionId: capturedSessionId,
                          watchdogSeconds: GL_TUTOR_RESPONSE_TIMEOUT_MS / 1000,
                        }).catch(() => {});
                      }).catch(() => {});
                    }
                  }, GL_TUTOR_RESPONSE_TIMEOUT_MS);
                }

                // ── GL idle timeout ─────────────────────────────────────────────────
                // Start idle timer. Resets whenever client audio arrives.
                // If no audio for 5 minutes, close the session to prevent zombie accumulation.
                let glLastActivityAt = Date.now();
                const resetGlIdleTimer = () => {
                  glLastActivityAt = Date.now();
                  if (glIdleTimeoutHandle) clearTimeout(glIdleTimeoutHandle);
                  glIdleTimeoutHandle = setTimeout(async () => {
                    if (!geminiLiveSession) return;
                    const actualGapSec = Math.round((Date.now() - glLastActivityAt) / 1000);
                    console.log(`[GeminiLive] Idle timeout (${GL_IDLE_TIMEOUT_MS / 60000} min) — closing session. Actual gap since last reset: ${actualGapSec}s`);
                    // Notify client before closing
                    try {
                      if (ws.readyState === 1 /* OPEN */) {
                        ws.send(JSON.stringify({ type: 'session_idle_timeout', idleMinutes: GL_IDLE_TIMEOUT_MS / 60000 }));
                      }
                    } catch (_) {}
                    // Stop the GL session cleanly so ws.on('close') handles billing
                    if (ws.readyState === 1 /* OPEN */) {
                      try { ws.close(1000, 'idle_timeout'); } catch (_) {}
                    }
                  }, GL_IDLE_TIMEOUT_MS);
                };
                // Store reference so audio handlers can call it
                (ws as any).__resetGlIdleTimer = resetGlIdleTimer;
                resetGlIdleTimer(); // Start timer immediately

                // ── Periodic GL metrics sync ────────────────────────────────────────
                // Write accumulated GL metrics to DB every 2 minutes.
                // Ensures zombie cleanup picks up real exchange/speaking data.
                let lastEmittedWarningLevel: string = 'none';
                glMetricsSyncHandle = setInterval(async () => {
                  if (!geminiLiveSession || !usageSession) return;
                  const glExchanges = geminiLiveSession.getCompletedExchangeCount();
                  const glOutputChars = geminiLiveSession.getTotalOutputCharacters();
                  const glTokens = geminiLiveSession.getUsageSummary();
                  const metrics = getCurrentVoiceMetricsSnapshot();
                  if (glExchanges > 0 || glOutputChars > 0) {
                    usageService.updateSessionMetrics(usageSession.id, {
                      exchangeCount: metrics.exchangeCount,
                      ttsCharacters: metrics.ttsCharacters,
                      studentSpeakingSeconds: Math.round(metrics.studentSpeakingSeconds),
                      tutorSpeakingSeconds: Math.round(metrics.tutorSpeakingSeconds),
                      ...(glTokens.inputTokens > 0 ? { llmInputTokens: glTokens.inputTokens } : {}),
                      ...(glTokens.outputTokens > 0 ? { llmOutputTokens: glTokens.outputTokens } : {}),
                    }).catch((err: Error) => console.warn('[GeminiLive] Periodic metrics sync failed:', err.message));
                  }

                  // ── Mid-session credit warning ──────────────────────────────
                  // After each periodic sync, check the user's credit balance and
                  // push a warning event to the client if the level has changed.
                  try {
                    const balance = await usageService.getBalanceWithBypass(String(userId));
                    const level = balance.warningLevel as string;
                    if (level !== 'none' && level !== lastEmittedWarningLevel) {
                      lastEmittedWarningLevel = level;
                      const payload = JSON.stringify({
                        type: 'credit_warning',
                        level,                                            // 'low' | 'critical' | 'exhausted'
                        remainingSeconds: balance.remainingSeconds,
                        percentRemaining: balance.percentRemaining,
                      });
                      try { ws.send(payload); } catch (_) {}
                      console.log(`[CreditWarning] Emitted '${level}' warning to user ${userId} (${balance.remainingSeconds}s remaining)`);

                      // File a Sofia report when credits are fully exhausted mid-session
                      if (level === 'exhausted') {
                        import('./services/sofia-billing-monitor').then(({ reportCreditExhausted }) => {
                          reportCreditExhausted({
                            userId: String(userId),
                            sessionId: usageSession?.id,
                            remainingSeconds: balance.remainingSeconds,
                          }).catch(() => {});
                        }).catch(() => {});
                      }
                    }
                  } catch (balErr: any) {
                    console.warn('[CreditWarning] Balance check failed:', balErr.message);
                  }

                  // ── Session liveness heartbeat ───────────────────────────────
                  // Write a gl_session_heartbeat event every GL_METRICS_SYNC_INTERVAL_MS
                  // so that broken sessions (GL audio flowing but server-side tracking dead)
                  // are detectable post-hoc by the absence of heartbeats after session_start.
                  if (usageSession && userId) {
                    const heartbeatPayload = JSON.stringify({
                      exchangeCount: metrics.exchangeCount,
                      sessionAgeSeconds: Math.round((Date.now() - (usageSession.startedAt ? new Date(usageSession.startedAt).getTime() : Date.now())) / 1000),
                    });
                    getSharedDb().execute(sql`
                      INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
                      VALUES (gen_random_uuid(), ${usageSession.id}, ${String(userId)},
                        'gl_session_heartbeat', ${heartbeatPayload}::jsonb, NOW())
                    `).catch((err: Error) => console.warn('[GeminiLive] Failed to write session heartbeat:', err.message));
                  }
                }, GL_METRICS_SYNC_INTERVAL_MS);
                } // end else (Gemini Live path)
              } catch (glErr: any) {
                console.error('[GeminiLive] Failed to start live voice session:', glErr.message);
                if (conversationId && geminiLiveSession) unregisterGlSession(conversationId, geminiLiveSession);
                geminiLiveSession = null;
                if (openaiRealtimeSession) { openaiRealtimeSession.stop(); openaiRealtimeSession = null; }
                liveVoiceFailureMessage = `The selected live voice provider could not start: ${glErr.message}. Reconnect the voice session or select another provider.`;
                sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
              }
            } else {
              // ── Text-mode (Deepgram) absence return resolution ─────────────
              // The GL branch resolves the absence nudge inside its synthesis block so
              // the returning-student signal can color the inner monologue.  In text-mode
              // there is no baked synthesis, so we fire the same idempotent call here to
              // ensure the DB row is resolved when the student actually returns.
              // Founder-mode sessions are David's admin/test sessions — skip them.
              if (userId && !isFounderMode) {
                const _textModeDbSessionId = dbSessionId;
                // Store the promise so request_greeting can await it before prompt assembly.
                // Without this, request_greeting can fire before __textModeAbsenceSynthesis
                // is set and silently miss the absence warmth on fast/reconnect paths.
                (session as any).__textModeAbsencePromise = (async () => {
                  try {
                    const absenceReturn = await autoResolveAbsenceNudgeOnReturn(String(userId));
                    if (absenceReturn) {
                      console.log(`[TextMode] ✓ Student returning after ${absenceReturn.daysSinceLastSession} day(s) absence — nudge resolved`);
                    }
                    // Build synthesis for the greeting.  Apply the same stale-cache guard as
                    // the GL path: consume any pre-warmed synthesis first so the warm cache is
                    // always invalidated on session start.  If the cache was generated BEFORE
                    // the absence nudge existed, discard it and regenerate with the signal so
                    // Daniela always opens with the returning-student awareness baked in.
                    if (compassContext && session && !isFounderMode) {
                      const warmedNote = userId ? consumeWarmSynthesis(String(userId)) : null;
                      let synthesisNote: string | null = null;
                      if (warmedNote && absenceReturn) {
                        console.log('[TextMode] Warm cache present but absence signal detected — regenerating with signal');
                        synthesisNote = await generatePreSessionSynthesis(
                          compassContext,
                          tutorName,
                          userId ? String(userId) : undefined,
                          effectiveLanguage || undefined,
                          absenceReturn,
                        );
                      } else if (warmedNote) {
                        synthesisNote = warmedNote;
                        console.log(`[TextMode] ✓ Using pre-warmed synthesis (${warmedNote.length} chars) — 0ms latency`);
                      } else if (absenceReturn) {
                        synthesisNote = await generatePreSessionSynthesis(
                          compassContext,
                          tutorName,
                          userId ? String(userId) : undefined,
                          effectiveLanguage || undefined,
                          absenceReturn,
                        );
                      }
                      if (synthesisNote) {
                        (session as any).__textModeAbsenceSynthesis = synthesisNote;
                        console.log(`[TextMode] ✓ Absence-return synthesis stored for greeting (${synthesisNote.length} chars)`);
                      }
                    }
                    // Fire-and-forget: persist the returning-student flag on the voice_sessions
                    // row so the founder view can surface a "Returned after N days" indicator.
                    if (absenceReturn && _textModeDbSessionId) {
                      applyAbsenceReturnFlag(_textModeDbSessionId, absenceReturn.daysSinceLastSession)
                        .catch((e: Error) => console.warn('[TextMode] Failed to flag absence return on session row (non-fatal):', e.message));
                    }
                  } catch (absErr: any) {
                    // Non-fatal — session continues without absence resolution
                    console.warn('[TextMode] Absence return check failed (non-fatal):', absErr?.message);
                  }
                })();
              }
            }
            
            // Track reconnection state — prevents double greetings when client reconnects.
            // If user context failed entirely (all Phase 1 lookups timed out), treat as a
            // fresh start even if the client sent isReconnect=true — otherwise Daniela is
            // silent with no greeting and no context, which looks like a dead session.
            (session as any).__isReconnect = isReconnectSO && user != null;
            
            // Store the message count at session-start time so the request_greeting handler
            // (a separate case in the switch, different scope) can detect mid-session reconnects.
            // Use conversationHistory.length (not raw messages) so the reconnect retry count is
            // reflected here — if messages timed out but the retry recovered them, we want
            // request_greeting to know the conversation has history.
            (session as any).__initialMessageCount = conversationHistory.length;
            
            // RECONNECT FIX: Restore input mode from config.
            // Every new WS connection defaults currentInputMode to 'push-to-talk', but the client
            // may have been in open-mic mode. Without this restoration, all post-reconnect open-mic
            // audio chunks route to the wrong handler and Deepgram never receives speech.
            if (config.inputMode && config.inputMode !== currentInputMode) {
              currentInputMode = config.inputMode;
              console.log(`[Streaming Voice] Input mode restored from config (Socket.io): ${currentInputMode}${isReconnectSO ? ' (reconnect)' : ''}`);
            }
            
            pendingVoiceUpdate = tutorGender;
            console.log(`[Streaming Voice] Session created: ${session.id}${dbSessionId ? ` (db: ${dbSessionId.substring(0, 8)}...)` : ' (no db session)'}`);
            
            // ECHO SUPPRESSION: Set callback to control OpenMic suppression during TTS
            // Safety timeout prevents permanent mic lockout if onTtsStateChange(false) never fires
            orchestrator.setTtsStateCallback(session.id, (isTtsPlaying: boolean) => {
              if (openMicSession) {
                openMicSession.setSuppressed(isTtsPlaying);
              }
              if (isTtsPlaying) {
                if (echoSuppressionTimeoutSO) clearTimeout(echoSuppressionTimeoutSO);
                echoSuppressionTimeoutSO = setTimeout(() => {
                  console.warn(`[ECHO SUPPRESSION SAFETY] Suppression active for ${ECHO_SUPPRESSION_MAX_MS_SO}ms — force-clearing to prevent mic lockout`);
                  if (openMicSession) {
                    openMicSession.setSuppressed(false);
                  }
                  echoSuppressionTimeoutSO = null;
                }, ECHO_SUPPRESSION_MAX_MS_SO);
              } else {
                if (echoSuppressionTimeoutSO) {
                  clearTimeout(echoSuppressionTimeoutSO);
                  echoSuppressionTimeoutSO = null;
                }
              }
            });
            
            ws.send(JSON.stringify({
              type: 'session_started',
              sessionId: session.id,
              ...(dbSessionId ? { voiceSessionId: dbSessionId } : {}),
              timestamp: Date.now(),
              isGeminiLive: !!geminiLiveSession,
            }));
            console.log(`[Streaming Voice] session_started sent via Socket.io for ${session.id}`);
          } catch (err: any) {
            console.error('[Streaming Voice] Session creation failed:', err);
            sendErrorAdapter(ws, 'SESSION_FAILED', err.message || 'Session creation failed', false);
          } finally {
            // Always release the dedup guard so future reconnects can init normally
            if (conversationId && !isReconnectSO) sessionInitsInProgress.delete(conversationId);
          }
          break;
        }
        
        case 'request_greeting': {
          if (!isAuthenticated || !session) {
            sendErrorAdapter(ws, 'UNKNOWN', 'Session not ready for greeting', true);
            return;
          }

          // OpenAI Realtime sends its greeting during start(). A later client
          // retry is always a no-op, including after startup/runtime failure;
          // it must never become a legacy text+TTS greeting.
          if (selectedLiveVoiceRoute === 'openai-realtime') {
            if (liveVoiceFailureMessage) {
              sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
            } else {
              console.log('[OpenAIRealtime] request_greeting received — already greeted on session start, ignoring');
            }
            break;
          }
          if (selectedLiveVoiceRoute === 'gemini-live' && !geminiLiveSession) {
            if (liveVoiceFailureMessage) {
              sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
            }
            break;
          }
          
          // RECONNECTION GUARD: If this session was created via reconnection,
          // skip the greeting to prevent double audio after infrastructure timeout.
          //
          // EXCEPTION — Gemini Live sessions: GL is a fresh WebSocket after every reconnect
          // (the GL connection lives server-side and closes when Socket.io disconnects).
          // There is no "old" GL audio playing, so double-audio is impossible. Without the
          // greeting, GL is in a blank limbo — it has context but no orientation turn, so
          // it just waits silently and never responds to the user's first utterance.
          // For GL reconnects we let the greeting through (marked as resumed so she says
          // "continuing..." not "hola!").
          if ((session as any).__isReconnect) {
            const isGlActive = !!geminiLiveSession;
            if (!isGlActive) {
              console.log('[Streaming Voice] Ignoring greeting request — legacy pipeline reconnect (prevents double audio) [Socket.io]');
              (session as any).__isReconnect = false;
              break;
            }
            // GL reconnect — allow greeting but mark as resumed
            console.log('[Streaming Voice] GL reconnect — allowing resumption greeting (GL session is always fresh after reconnect)');
            (session as any).__isReconnect = false;
          }
          
          const greetingRequest = message as { type: 'request_greeting'; userName?: string; isResumed?: boolean; scenarioSlug?: string };
          
          // Check for pending handoff intro
          if (shouldUseLegacyVoicePipeline(selectedLiveVoiceRoute) && userId && pendingHandoffIntros.has(userId)) {
            const pendingIntro = pendingHandoffIntros.get(userId)!;
            const age = Date.now() - pendingIntro.timestamp;
            
            if (age < 30000) {
              console.log(`[Streaming Voice] Found pending handoff intro for ${pendingIntro.tutorName} (${age}ms old)`);
              pendingHandoffIntros.delete(userId);
              
              try {
                await orchestrator.processVoiceSwitchIntro(
                  session.id,
                  pendingIntro.tutorName,
                  pendingIntro.gender
                );
                break;
              } catch (introError: any) {
                console.error('[Streaming Voice] Handoff intro error:', introError.message);
              }
            } else {
              pendingHandoffIntros.delete(userId);
            }
          }
          
          // SAFETY NET: If the conversation already had messages when this session started,
          // this is always a resumption — never a fresh greeting.
          // This catches race conditions (proactive 4.5-min reconnect, mid-session WS drop, GL reconnect)
          // where the client sends isResumed=false but the conversation was clearly ongoing.
          // Without this, Daniela re-introduces herself mid-conversation after reconnect.
          // __initialMessageCount is stored on the session object in start_session (different scope).
          // Threshold is > 1 (not > 2): if at least 2 messages exist (greeting + student's first reply),
          // the session was already underway. Using > 2 missed early-session blips (after 1-2 messages).
          const initialMsgCount: number = (session as any).__initialMessageCount ?? 0;
          const conversationHasHistory = initialMsgCount > 1;
          const effectiveIsResumed = greetingRequest.isResumed || conversationHasHistory;
          if (!greetingRequest.isResumed && conversationHasHistory) {
            console.log(`[Streaming Voice] Forcing isResumed=true — conversation had ${initialMsgCount} messages at session start (reconnect mid-session)`);
          }

          // For mid-session GL reconnects, fetch the last few exchanges so the tutor
          // can orient herself to what was just being discussed instead of saying
          // "it feels like maybe yesterday" when it was seconds ago.
          let recentConversationContext: string | undefined;
          if (effectiveIsResumed && conversationHasHistory && session.conversationId) {
            try {
              // Fetch all messages in this session — we'll trim by character budget,
              // not by a fixed count, so long sessions don't lose early context.
              const allMsgs = await db
                .select({ role: messages.role, content: messages.content })
                .from(messages)
                .where(eq(messages.conversationId, session.conversationId))
                .orderBy(desc((messages as any).createdAt))
                .limit(60); // safety cap — 60 exchanges is ~30 min of conversation
              if (allMsgs.length > 0) {
                // Reverse to chronological order, then build within a character budget
                const chronological = allMsgs.reverse();
                const CHARACTER_BUDGET = 5000;
                const lines: string[] = [];
                let budget = CHARACTER_BUDGET;
                // Walk chronologically — if we can't fit everything, drop oldest first
                for (let i = chronological.length - 1; i >= 0; i--) {
                  const m = chronological[i];
                  const speaker = m.role === 'assistant' ? 'You' : 'Student';
                  const line = `${speaker}: ${m.content.substring(0, 300)}`;
                  if (budget - line.length < 0) break;
                  lines.unshift(line);
                  budget -= line.length;
                }
                if (lines.length > 0) {
                  const dropped = chronological.length - lines.length;
                  recentConversationContext = dropped > 0
                    ? `[Earlier ${dropped} exchange(s) omitted for brevity]\n` + lines.join('\n')
                    : lines.join('\n');
                }
              }
            } catch {
              // Non-critical — proceed without context
            }
          }

          console.log(`[Streaming Voice] Generating AI greeting... (resumed: ${effectiveIsResumed}, scenario: ${greetingRequest.scenarioSlug || 'none'}, recentContext: ${recentConversationContext ? 'yes' : 'no'})`);
          
          if (geminiLiveSession) {
            // GeminiLive mode: route the greeting through the Live session so the session
            // accumulates Spanish conversation context from turn 1.
            // Guard against the client's 8-second retry sending a duplicate trigger —
            // a second sendClientContent on an active session causes 1011 internal error.
            if (!geminiLiveGreetingSent) {
              geminiLiveGreetingSent = true;
              geminiLiveSession.sendGreetingTrigger(
                greetingRequest.userName,
                effectiveIsResumed,
                greetingRequest.scenarioSlug,
                recentConversationContext,
                (session as any).__bootstrapProfile ?? undefined,
              );
            } else {
              console.log('[GeminiLive] Duplicate request_greeting ignored — greeting already sent');
            }
          } else if (shouldUseLegacyVoicePipeline(selectedLiveVoiceRoute)) {
            // Legacy orchestrator path (used when GeminiLive is not active)
            // ── Text-mode absence synthesis injection ──────────────────────
            // Settle the absence promise (started in start_session) before prompt
            // assembly.  A bounded 3-second race prevents the greeting from
            // blocking indefinitely if synthesis or DB lookup hangs.
            const absenceSettlePromise = (session as any).__textModeAbsencePromise as Promise<void> | undefined;
            if (absenceSettlePromise) {
              try {
                await Promise.race([
                  absenceSettlePromise,
                  new Promise<void>(resolve => setTimeout(resolve, 3000)),
                ]);
              } catch {
                // Non-fatal — absence synthesis missed but session continues
              }
              delete (session as any).__textModeAbsencePromise; // clear regardless
            }
            const textModeAbsenceSynthesis = (session as any).__textModeAbsenceSynthesis as string | undefined;
            if (textModeAbsenceSynthesis) {
              const wrapped = wrapSynthesisForSystemPrompt(textModeAbsenceSynthesis);
              session.systemPrompt = wrapped + '\n\n' + session.systemPrompt;
              delete (session as any).__textModeAbsenceSynthesis; // one-shot: consumed
              console.log(`[TextMode] ✓ Absence-return synthesis injected into session system prompt for greeting (${textModeAbsenceSynthesis.length} chars)`);
            }
            try {
              await orchestrator.processGreetingRequest(
                session.id,
                greetingRequest.userName,
                effectiveIsResumed,
                greetingRequest.scenarioSlug
              );
            } catch (greetingError: any) {
              console.error('[Streaming Voice] Greeting error:', greetingError.message);
              sendErrorAdapter(ws, 'AI_FAILED', 'Failed to generate greeting', true);
            }
          }
          break;
        }
        
        case 'audio_data': {
          if (!isAuthenticated || !session) {
            sendErrorAdapter(ws, 'UNKNOWN', 'Session not ready', true);
            return;
          }
          
          // PHASE 2: If speculative AI was already accepted, skip this audio_data entirely
          // The response is already streaming from the speculative call
          if (speculativeAiAccepted) {
            console.log(`[SpeculativePTT] PHASE 2: Skipping audio_data - speculative AI already accepted`);
            speculativeAiAccepted = false;  // Reset for next turn
            break;
          }
          
          const audioMessage = message as ClientAudioDataMessage;
          let audioBuffer: Buffer;
          if (typeof audioMessage.audio === 'string') {
            audioBuffer = Buffer.from(audioMessage.audio, 'base64');
          } else {
            audioBuffer = Buffer.from(audioMessage.audio);
          }

          // LIVE VOICE PATH: streamed live providers already own this audio turn.
          // Never process the final blob through legacy STT, even if the upstream
          // live socket failed after provider selection.
          if (selectedLiveVoiceRoute !== 'legacy') {
            if (liveVoiceFailureMessage) {
              sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
            }
            break;
          }

          // GEMINI LIVE PATH: Route PTT through Gemini Live when the Live session is active.
          // We prefer the speculative transcript (already captured by the streaming STT during recording).
          // If no transcript is available, we skip silently — open-mic is the preferred mode with GLive.
          if (geminiLiveSession) {
            if (pendingSpeculativeTranscript && pendingSpeculativeWordCount >= 1) {
              const transcript = pendingSpeculativeTranscript;
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
              console.log(`[GeminiLive PTT] Routing via text turn (${transcript.length} chars): "${transcript.slice(0, 80)}"`);
              geminiLiveSession.sendTextTurn(transcript, { label: 'ptt-transcript', isStudentInput: true });
              // Tension + GOAP: evaluate async → combine world event + pedagogical directive
              if (session && (session as any).sceneCanvas) {
                const glSnapTension = geminiLiveSession;
                evaluateAndUpdateTension(transcript, session)
                  .then(worldEvent => {
                    const { directive, mutations } = selectPedagogicalDirective(session);
                    fireCanvasMutations(session, mutations, ws);
                    const shaper = selectStyleShaper(session);
                    const madrigalLink: string | undefined = (session as any).pendingMadrigalLink ?? undefined;
                    if ((session as any).pendingMadrigalLink) (session as any).pendingMadrigalLink = null;
                    const combined = [worldEvent, directive, shaper, madrigalLink].filter(Boolean).join(' ');
                    if (combined) glSnapTension.sendTextTurn(combined, { label: 'tension-goap-directive' });
                  })
                  .catch(() => {});
              }
            } else {
              if (pendingSpeculativeTranscript) {
                pendingSpeculativeTranscript = null;
                pendingSpeculativeWordCount = 0;
              }
              console.log('[GeminiLive PTT] No transcript available — skipping blob (open-mic preferred with Gemini Live)');
            }
            break;
          }
          
          // Wrap in try/catch to prevent STT/AI errors from disconnecting the session
          // Errors like EMPTY_TRANSCRIPT are recoverable and shouldn't close the socket
          try {
            let metrics: StreamingMetrics;
            
            // SPECULATIVE PTT BYPASS: If we have a pending speculative transcript,
            // skip the expensive blob STT and go straight to AI generation
            if (pendingSpeculativeTranscript && pendingSpeculativeWordCount >= SPECULATIVE_TRANSCRIPT_MIN_WORDS) {
              const transcriptToUse = pendingSpeculativeTranscript;
              const wordCount = pendingSpeculativeWordCount;
              
              // Clear the pending transcript immediately to prevent reuse
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
              
              console.log(`[SpeculativePTT] BYPASS: Using speculative transcript (${wordCount} words), skipping blob STT`);
              console.log(`[SpeculativePTT] Transcript: "${transcriptToUse}"`);
              
              // Use processOpenMicTranscript which skips STT entirely
              metrics = await orchestrator.processOpenMicTranscript(session.id, transcriptToUse, 1.0);
            } else {
              // Fallback: No speculative transcript available, process blob normally
              if (pendingSpeculativeTranscript) {
                console.log(`[SpeculativePTT] Transcript too short, falling back to blob STT`);
                pendingSpeculativeTranscript = null;
                pendingSpeculativeWordCount = 0;
              }
              metrics = await orchestrator.processUserAudio(session.id, audioBuffer, audioMessage.format || 'webm');
            }
            
            // Track exchange for usage accounting (Socket.io adapter path)
            if (metrics.userTranscript && metrics.aiResponse) {
              exchangeCount++;
              
              const studentWords = metrics.userTranscript.split(/\s+/).length;
              const tutorWords = metrics.aiResponse.split(/\s+/).length;
              studentSpeakingSeconds += studentWords / 2.5;
              tutorSpeakingSeconds += tutorWords / 2.5;
              ttsCharacters += metrics.aiResponse.length;
              
              // Flush to DB immediately so endAllActiveSessions() sees correct count
              if (usageSession) {
                try {
                  await usageService.updateSessionMetrics(usageSession.id, {
                    exchangeCount,
                    studentSpeakingSeconds: Math.round(studentSpeakingSeconds),
                    tutorSpeakingSeconds: Math.round(tutorSpeakingSeconds),
                    ttsCharacters,
                  });
                } catch (updateErr: any) {
                  console.warn('[Streaming Voice] Could not update session metrics:', updateErr.message);
                }
              }
            }
            
          } catch (audioError: any) {
            // Log but don't disconnect - the orchestrator already sent an error message to the client
            console.error('[Streaming Voice] Audio processing error (recoverable):', audioError.message);
          }
          break;
        }
        
        case 'prop_tap': {
          // Prop-to-dialogue binding: student tapped a scene object — inject context so Daniela reacts.
          // Formatted as a stage direction so it reads naturally and doesn't disrupt the narrative.
          const tapLabel = (message as any).propLabel as string | undefined;
          const tapNative = (message as any).nativeLabel as string | undefined;
          const tapPropId = (message as any).propId as string | undefined;
          if (tapLabel) {
            const contextText = `*(the student examines the ${tapLabel}${tapNative ? ` — ${tapNative}` : ''})*`;
            console.log(`[PropTap] Injecting context: "${contextText}"`);
            if (selectedLiveVoiceRoute === 'gemini-live') {
              if (geminiLiveSession) {
                geminiLiveSession.sendTextTurn(contextText, { label: 'prop-tap', isStudentInput: true });
              } else if (liveVoiceFailureMessage) {
                sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
              }
            } else if (selectedLiveVoiceRoute === 'openai-realtime') {
              // The initial OpenAI Realtime integration has no text-event bridge.
              // Preserve route ownership rather than sending this interaction to
              // Daniela's separate legacy response pipeline.
              if (liveVoiceFailureMessage) {
                sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
              } else {
                console.log('[OpenAIRealtime] prop_tap ignored — text-event bridge is not available');
              }
            } else if (shouldUseLegacyVoicePipeline(selectedLiveVoiceRoute) && session) {
              orchestrator.processOpenMicTranscript(session.id, contextText, 1.0);
            }
            // GOAP Prop Awareness: flag this prop as the student's focus so the next ELICIT
            // directive specifically grounds in it rather than cycling the room randomly.
            if (session) {
              (session as any).recentlyTappedProp = { id: tapPropId ?? tapLabel, label: tapLabel };
            }
          }
          break;
        }

        case 'interrupt':
          if (geminiLiveSession) {
            geminiLiveSession.interrupt();
          } else if (session) {
            orchestrator.handleInterrupt(session.id);
          }
          break;
        
        case 'user_activity':
          if (session) orchestrator.resetIdleTimeoutForSession(session.id);
          break;

        case 'toggle_incognito': {
          if (!session) break;
          const incogEnabled = !!(message as any).enabled;
          const sessObj = orchestrator.getSession(session.id);
          if (sessObj && (sessObj.isFounderMode || sessObj.isRawHonestyMode || sessObj.isReadingRoom)) {
            sessObj.isIncognito = incogEnabled;
            // Mark that incognito was ever active this session so carry-forward
            // logic can exclude the entire scratchpad regardless of final state.
            if (incogEnabled) (sessObj as any)._wasEverIncognito = true;
            console.log(`[Streaming Voice] Incognito mode ${incogEnabled ? 'ENABLED' : 'DISABLED'} for session ${session.id} (open-mic path)`);
            ws.send(JSON.stringify({
              type: 'incognito_changed',
              timestamp: Date.now(),
              enabled: incogEnabled,
            }));
          }
          break;
        }
        
        case 'update_voice': {
          const voiceMsg = message as { type: 'update_voice'; tutorGender: 'male' | 'female' };
          pendingVoiceUpdate = voiceMsg.tutorGender;
          
          if (session && !voiceUpdateInProgress) {
            voiceUpdateInProgress = true;
            try {
              const targetLanguage = session.targetLanguage || 'spanish';
              const activeVoiceProviderForGenderSwitch = await storage.getActiveTutorVoiceProvider();
              const tutorVoice = await storage.getTutorVoice(targetLanguage, voiceMsg.tutorGender, activeVoiceProviderForGenderSwitch);
              
              if (tutorVoice?.voiceId) {
                orchestrator.updateSessionVoice(session.id, tutorVoice.voiceId, tutorVoice.provider);
                
                // Resolve tutor first name using canonical lookup (prevents raw voice IDs like
                // "Aoede" appearing in intro speech).
                const switchLangKey = (targetLanguage || '').toLowerCase();
                const switchNames = LANGUAGE_TUTOR_NAMES[switchLangKey];
                const tutorFirstName = switchNames
                  ? (voiceMsg.tutorGender === 'male' ? switchNames.male : switchNames.female)
                  : (() => {
                      const parts = tutorVoice.voiceName?.split(/\s*[-–]\s*/) || [];
                      return parts[0]?.trim() || 'your new tutor';
                    })();
                
                const isLanguageSwitch = (session as any).isLanguageSwitchHandoff || false;
                
                if (isLanguageSwitch && userId) {
                  console.log(`[Streaming Voice] Cross-language handoff - storing pending intro for ${tutorFirstName}`);
                  pendingHandoffIntros.set(userId, {
                    tutorName: tutorFirstName,
                    gender: voiceMsg.tutorGender,
                    language: targetLanguage,
                    timestamp: Date.now()
                  });
                  (session as any).isLanguageSwitchHandoff = false;
                } else if ((session as any).greetingTriggeredByOrchestrator) {
                  console.log(`[Streaming Voice] Same-language switch - greeting already triggered by orchestrator, skipping`);
                  (session as any).greetingTriggeredByOrchestrator = false;
                } else {
                  console.log(`[Streaming Voice] Same-language switch - ${tutorFirstName} introducing themselves`);
                  await orchestrator.processVoiceSwitchIntro(session.id, tutorFirstName, voiceMsg.tutorGender);
                }
                
                ws.send(JSON.stringify({
                  type: 'voice_updated',
                  timestamp: Date.now(),
                  gender: voiceMsg.tutorGender,
                  voiceName: tutorVoice.voiceName,
                }));
              }
            } catch (err: any) {
              console.warn('[Streaming Voice] Voice update failed:', err.message);
            } finally {
              voiceUpdateInProgress = false;
            }
          }
          break;
        }
        
        case 'stream_audio_chunk': {
          if (!isAuthenticated || !session) {
            sendErrorAdapter(ws, 'UNKNOWN', 'Session not ready for streaming', true);
            return;
          }
          
          const chunkMessage = message as ClientStreamAudioChunkMessage;
          let audioBuffer: Buffer;
          if (typeof chunkMessage.audio === 'string') {
            audioBuffer = Buffer.from(chunkMessage.audio, 'base64');
          } else {
            audioBuffer = Buffer.from(chunkMessage.audio);
          }

          // ── Gemini Live path: relay PCM16 directly to the Live session ──
          // Reset idle timer on ANY mic audio, even if geminiLiveSession is momentarily null
          // (e.g. mid-reconnect) — real user activity should never be dropped by that race.
          {
            const resetTimer2 = (ws as any).__resetGlIdleTimer as (() => void) | undefined;
            if (resetTimer2) resetTimer2();
          }
          if (selectedLiveVoiceRoute !== 'legacy') {
            if (selectedLiveVoiceRoute === 'gemini-live' && geminiLiveSession) {
              geminiLiveSession.sendAudioChunk(audioBuffer);
            } else if (selectedLiveVoiceRoute === 'openai-realtime' && openaiRealtimeSession) {
              openaiRealtimeSession.sendAudioChunk(audioBuffer);
            } else if (liveVoiceFailureMessage) {
              sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
            }
            break;
          }
          
          // Handle based on current input mode
          if (currentInputMode === 'open-mic') {
            // OPEN MIC MODE: Continuous streaming with VAD
            if (openMicSession) {
              openMicSession.sendAudio(audioBuffer);
              break;
            }
            
            // Buffer this chunk while session is starting
            openMicPendingChunks.push(audioBuffer);
            
            // If already starting, just buffer and wait
            if (openMicSessionStarting) {
              break;
            }
            
            // Start new session
            openMicSessionStarting = true;
            const languageCode = getDeepgramLanguageCode(session.targetLanguage || 'spanish');
            const sessionKeytermsForMic = (session as any).sttKeyterms as string[] | undefined;
            console.log(`[OpenMic] Starting PCM session for language: ${languageCode}${sessionKeytermsForMic?.length ? ` (${sessionKeytermsForMic.length} keyterms)` : ''}`);
            
            const openMicEvents: OpenMicEvents = {
              onSpeechStarted: () => {
                console.log('[OpenMic] VAD: Speech started - sending to client');
                if (ws.readyState === WS_OPEN) {
                  const msg = JSON.stringify({
                    type: 'vad_speech_started',
                    timestamp: Date.now(),
                  });
                  console.log('[OpenMic] Sending vad_speech_started to client');
                  ws.send(msg);
                } else {
                  console.warn('[OpenMic] WebSocket not open, cannot send vad_speech_started');
                }
              },
              onSpeechFinal: (transcript: string) => {
                // NOTE: We intentionally do NOT send processing_pending here in open mic mode.
                // speech_final fires after 500ms of silence — but the user may still be mid-sentence
                // (thinking, breathing). Sending "thinking" UI here causes confusing early cutoff
                // perception. processing_pending is sent only at onUtteranceEnd, when submission is certain.
                console.log(`[OpenMic] speech_final received — "${transcript.slice(0, 60)}" — awaiting UtteranceEnd`);
              },
              onUtteranceEnd: async (transcript, confidence) => {
                console.log(`[OpenMic] VAD: Utterance end - "${transcript}" (${(confidence * 100).toFixed(0)}%)`);
                
                const isEmptyTranscript = !transcript.trim() || transcript.trim() === '[EMPTY_TRANSCRIPT]';
                
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'vad_utterance_end',
                    timestamp: Date.now(),
                    empty: isEmptyTranscript,
                  }));
                  // THINKING SIGNAL: Only send processing_pending when submission is actually
                  // happening — not on speech_final which fires mid-sentence.
                  if (!isEmptyTranscript) {
                    ws.send(JSON.stringify({
                      type: 'processing_pending',
                      timestamp: Date.now(),
                      interimTranscript: transcript,
                    }));
                  }
                }
                
                if (!isEmptyTranscript && session) {
                  // Gap 6: score student pulse on every real utterance
                  updateStudentPulse(session, transcript);
                  try {
                    const omMetrics = await orchestrator.processOpenMicTranscript(
                      session.id,
                      transcript,
                      confidence
                    );
                    
                    if (omMetrics.sentenceCount > 0) {
                      exchangeCount++;
                      const studentWords = transcript.split(/\s+/).length;
                      studentSpeakingSeconds += studentWords / 2.5;
                      
                      // Flush to DB immediately so endAllActiveSessions() sees correct count
                      if (usageSession) {
                        try {
                          await usageService.updateSessionMetrics(usageSession.id, {
                            exchangeCount,
                            studentSpeakingSeconds: Math.round(studentSpeakingSeconds),
                            tutorSpeakingSeconds: Math.round(tutorSpeakingSeconds),
                            ttsCharacters,
                          });
                        } catch (updateErr: any) {
                          console.warn('[Streaming Voice] Could not update OM session metrics:', updateErr.message);
                        }
                      }
                    }
                  } catch (err: any) {
                    console.error('[OpenMic] Error processing utterance:', err);
                    sendErrorAdapter(ws, 'AI_FAILED', 'Failed to process speech', true);
                  }
                } else if (isEmptyTranscript) {
                  console.log('[OpenMic] Empty transcript - skipping AI processing, resetting client state');
                  
                  if (openMicSession) {
                    const diag = openMicSession.getDiagnostics();
                    if (diag.inSilenceLoop && ws.readyState === WS_OPEN) {
                      ws.send(JSON.stringify({
                        type: 'open_mic_silence_loop',
                        timestamp: Date.now(),
                        consecutiveEmptyCount: diag.consecutiveEmptyCount,
                        msSinceLastSuccessfulTranscript: diag.msSinceLastSuccessfulTranscript,
                      }));

                      if (diag.consecutiveEmptyCount === 5 && session?.id) {
                        console.log('[OpenMic] Triggering Daniela recovery phrase (echo ate student words)');
                        orchestrator.speakRecoveryPhrase(session.id).catch((err: any) =>
                          console.error('[OpenMic] Recovery phrase failed:', err.message)
                        );
                      }
                    }
                  }
                }
              },
              onInterimTranscript: (transcript) => {
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'interim_transcript',
                    timestamp: Date.now(),
                    text: transcript,
                  }));
                }
              },
              onError: (error) => {
                console.error('[OpenMic] STT runtime error:', error.message);
                // Notify client with a user-friendly degraded-STT message.
                // The session sets itself to null via onClose; the next audio chunk
                // will trigger a fresh start automatically.
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'stt_degraded',
                    timestamp: Date.now(),
                    userMessage: 'Having trouble hearing you — please try speaking again.',
                    recoverable: true,
                  }));
                }
              },
              onClose: () => {
                console.log('[OpenMic] Session closed');
                openMicSession = null;
                
                // Notify client that open mic session closed (so it can restart if needed)
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'open_mic_session_closed',
                    timestamp: Date.now(),
                  }));
                }
              },
            };
            
            // Attempt to start STT, with one automatic retry on transient failure.
            let openMicStarted = false;
            for (let attempt = 1; attempt <= 2 && !openMicStarted; attempt++) {
              const attemptSession = new OpenMicSession(languageCode, openMicEvents, sessionKeytermsForMic);
              try {
                if (attempt > 1) {
                  console.warn('[OpenMic] Retrying STT connection (attempt 2 of 2)...');
                  await new Promise<void>(r => setTimeout(r, 1500));
                }
                await attemptSession.start();
                openMicSession = attemptSession;
                openMicSessionStarting = false;
                openMicStarted = true;
                openMicStartFailCount = 0; // Reset on successful start
                console.log(`[OpenMic] Session started successfully (attempt ${attempt})`);
                
                if (openMicPendingChunks.length > 0) {
                  console.log(`[OpenMic] Sending ${openMicPendingChunks.length} buffered PCM chunks`);
                  for (const chunk of openMicPendingChunks) {
                    openMicSession.sendAudio(chunk);
                  }
                  openMicPendingChunks = [];
                }
              } catch (err: any) {
                console.error(`[OpenMic] STT start attempt ${attempt} failed:`, err.message);
              }
            }
            if (!openMicStarted) {
              openMicStartFailCount++;
              console.error(`[OpenMic] All STT start attempts failed (fail #${openMicStartFailCount}) — notifying client`);
              // After 2+ consecutive failures suggest switching to push-to-talk
              const suggestPtt = openMicStartFailCount >= 2;
              if (ws.readyState === WS_OPEN) {
                ws.send(JSON.stringify({
                  type: 'stt_degraded',
                  timestamp: Date.now(),
                  userMessage: suggestPtt
                    ? 'Voice recognition is unavailable right now. Try switching to Push-to-Talk mode.'
                    : 'Having trouble with voice recognition right now. Please try again in a moment.',
                  recoverable: !suggestPtt,
                  suggestPtt,
                }));
              }
              openMicSession = null;
              openMicSessionStarting = false;
              openMicPendingChunks = [];
            }
          } else if (currentInputMode === 'push-to-talk') {
            // SPECULATIVE PTT MODE: Stream audio during PTT for faster response
            if (speculativePttSession) {
              speculativePttSession.sendAudio(audioBuffer);
              break;
            }
            
            // Buffer this chunk while session is starting
            speculativePttPendingChunks.push(audioBuffer);
            
            if (speculativePttSessionStarting) {
              break;
            }
            
            // Start speculative PTT session
            speculativePttSessionStarting = true;
            speculativePttTranscript = '';
            speculativePttWordCount = 0;
            speculativePttTriggered = false;
            speculativePttTranscriptUsed = '';
            speculativePttGotFinal = false;
            speculativePttSessionId++;
            const currentPttSessionId = speculativePttSessionId;
            
            // CRITICAL: Clear any stale flags from previous turn to prevent cross-turn carryover
            speculativeAiInProgress = false;
            speculativeAiAccepted = false;
            pendingSpeculativeTranscript = null;
            pendingSpeculativeWordCount = 0;
            
            const languageCode = getDeepgramLanguageCode(session.targetLanguage || 'spanish');
            const sessionKeyterms = (session as any).sttKeyterms as string[] | undefined;
            console.log(`[SpeculativePTT] Starting PCM session #${currentPttSessionId} for language: ${languageCode}${sessionKeyterms?.length ? ` (${sessionKeyterms.length} keyterms)` : ''}`);
            
            const pttSession = new OpenMicSession(languageCode, {
              onSpeechStarted: () => {
                if (currentPttSessionId !== speculativePttSessionId) {
                  console.log(`[SpeculativePTT] Ignoring stale speech_started from session #${currentPttSessionId} (current: #${speculativePttSessionId})`);
                  return;
                }
                console.log('[SpeculativePTT] VAD: Speech started');
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'ptt_speech_started',
                    timestamp: Date.now(),
                  }));
                }
              },
              onUtteranceEnd: async (transcript, confidence) => {
                if (currentPttSessionId !== speculativePttSessionId) return;
                console.log(`[SpeculativePTT] VAD: Utterance end (ignored) - "${transcript}"`);
              },
              onInterimTranscript: (transcript) => {
                if (currentPttSessionId !== speculativePttSessionId) {
                  console.log(`[SpeculativePTT] Ignoring stale transcript from session #${currentPttSessionId} (current: #${speculativePttSessionId}): "${transcript.slice(0, 50)}"`);
                  return;
                }
                speculativePttTranscript = transcript;
                const words = transcript.trim().split(/\s+/).filter(w => w.length > 0);
                speculativePttWordCount = words.length;
                
                console.log(`[SpeculativePTT] Interim: "${transcript}" (${speculativePttWordCount} words, triggered: ${speculativePttTriggered})`);
                
                // Send interim transcript to client for display
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'ptt_interim_transcript',
                    timestamp: Date.now(),
                    text: transcript,
                    wordCount: speculativePttWordCount,
                  }));
                }
                
                // PHASE 2: SPECULATIVE AI PRE-TRIGGER
                // When we hit 3+ confident words, start AI generation speculatively
                // This shaves 200-300ms off response time by starting AI while user is still speaking
                if (speculativePttWordCount >= SPECULATIVE_AI_TRIGGER_WORDS && 
                    !speculativePttTriggered && 
                    !speculativeAiInProgress &&
                    session) {
                  speculativePttTriggered = true;
                  speculativePttTranscriptUsed = transcript.trim();
                  speculativeAiInProgress = true;
                  
                  console.log(`[SpeculativePTT] PHASE 2: Triggering speculative AI with "${speculativePttTranscriptUsed}"`);
                  
                  // Fire-and-forget speculative AI call
                  // The result will stream to client; on PTT release we'll decide whether to use it
                  orchestrator.processOpenMicTranscript(session.id, speculativePttTranscriptUsed, 0.9)
                    .then(() => {
                      console.log(`[SpeculativePTT] PHASE 2: Speculative AI completed`);
                    })
                    .catch((err: Error) => {
                      console.error(`[SpeculativePTT] PHASE 2: Speculative AI failed:`, err.message);
                      // Don't reset speculativePttTriggered - we'll fall back to normal flow
                    })
                    .finally(() => {
                      // CRITICAL: Always reset in-progress flag, even on interrupt/cancellation
                      speculativeAiInProgress = false;
                    });
                  
                  // Notify client that speculative AI has started
                  if (ws.readyState === WS_OPEN) {
                    ws.send(JSON.stringify({
                      type: 'ptt_speculative_ai_started',
                      timestamp: Date.now(),
                      transcript: speculativePttTranscriptUsed,
                    }));
                  }
                }
              },
              onFinalReceived: () => {
                if (currentPttSessionId !== speculativePttSessionId) return;
                speculativePttGotFinal = true;
              },
              onError: (error) => {
                if (currentPttSessionId !== speculativePttSessionId) return;
                console.error('[SpeculativePTT] STT error:', error.message);
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'stt_degraded',
                    timestamp: Date.now(),
                    userMessage: 'Having trouble hearing you — please try again.',
                    recoverable: true,
                  }));
                }
              },
              onClose: () => {
                if (currentPttSessionId !== speculativePttSessionId) return;
                console.log('[SpeculativePTT] Session closed');
                speculativePttSession = null;
              },
            }, sessionKeyterms);
            
            try {
              await pttSession.start();
              speculativePttSession = pttSession;
              speculativePttSessionStarting = false;
              console.log('[SpeculativePTT] Session started successfully');
              
              // Send buffered chunks
              if (speculativePttPendingChunks.length > 0) {
                console.log(`[SpeculativePTT] Sending ${speculativePttPendingChunks.length} buffered PCM chunks`);
                for (const chunk of speculativePttPendingChunks) {
                  speculativePttSession.sendAudio(chunk);
                }
                speculativePttPendingChunks = [];
              }
            } catch (err: any) {
              console.error('[SpeculativePTT] Failed to start STT session:', err.message);
              speculativePttSession = null;
              speculativePttSessionStarting = false;
              speculativePttPendingChunks = [];
              // Speculative PTT is best-effort — the ptt_release path still works without it.
              // Surface degraded state so user knows there may be a delay.
              if (ws.readyState === WS_OPEN) {
                ws.send(JSON.stringify({
                  type: 'stt_degraded',
                  timestamp: Date.now(),
                  userMessage: 'Voice recognition is slow right now — there may be a delay.',
                  recoverable: true,
                }));
              }
            }
          }
          break;
        }
        
        case 'ptt_release': {
          // PTT button released - finalize speculative PTT and get final transcript
          if (!isAuthenticated || !session) {
            sendErrorAdapter(ws, 'UNKNOWN', 'Session not ready', true);
            return;
          }

          // ── Live-session fast path ────────────────────────────────────────────
          // Gemini Live and OpenAI Realtime each own the complete audio-to-response
          // turn. Neither may fall through into the legacy Deepgram/AI pipeline.
          const liveVoiceOwner = getLiveVoiceSessionOwner(
            Boolean(geminiLiveSession),
            Boolean(openaiRealtimeSession),
          );
          if (selectedLiveVoiceRoute !== 'legacy') {
            if (liveVoiceOwner === 'conflict') {
              console.error('[LiveVoice PTT] Both live engines are active; suppressing legacy fallthrough');
            } else if (liveVoiceOwner === 'legacy') {
              console.error(`[LiveVoice PTT] ${selectedLiveVoiceRoute} owns turn but its session is unavailable; suppressing legacy fallthrough`);
              if (liveVoiceFailureMessage) {
                sendErrorAdapter(ws, 'AI_FAILED', liveVoiceFailureMessage, true);
              }
            } else {
              console.log(`[LiveVoice PTT] ptt_release — ${liveVoiceOwner} owns turn, skipping Deepgram wait`);
            }
            if (speculativePttSession) {
              speculativePttSession.close();
              speculativePttSession = null;
            }
            // Invalidate any partially-started or stale Deepgram turn so callbacks
            // cannot repopulate transcript state after the live engine takes over.
            speculativePttSessionId++;
            speculativePttSessionStarting = false;
            speculativePttPendingChunks = [];
            speculativePttTranscript = '';
            speculativePttWordCount = 0;
            speculativePttTriggered = false;
            speculativePttTranscriptUsed = '';
            speculativePttGotFinal = false;
            pendingSpeculativeTranscript = null;
            pendingSpeculativeWordCount = 0;
            speculativeAiAccepted = false;
            break;
          }

          const interimTranscript = speculativePttTranscript.trim();
          console.log(`[SpeculativePTT] PTT released - interim transcript: "${interimTranscript}" (${speculativePttWordCount} words)`);
          
          // IMMEDIATE THINKING SIGNAL: Tell client to show thinking avatar NOW
          // This fires immediately on PTT release, before the 200-400ms Deepgram wait
          console.log(`[SpeculativePTT] Sending processing_pending: readyState=${ws.readyState}, interimLen=${interimTranscript.length}`);
          if (ws.readyState === 1 && interimTranscript.length > 0) {
            ws.send(JSON.stringify({
              type: 'processing_pending',
              timestamp: Date.now(),
              interimTranscript: interimTranscript,
            }));
            console.log(`[SpeculativePTT] ✓ processing_pending sent`);
          } else {
            console.log(`[SpeculativePTT] ⚠️ processing_pending NOT sent (readyState=${ws.readyState}, interimLen=${interimTranscript.length})`);
          }
          
          // DON'T close immediately - wait for Deepgram final transcript (is_final=true)
          // Without this, we process incomplete interim transcripts and cut off the user's last words
          // Only early-exit after Deepgram confirms is_final; hard timeout prevents hanging
          const FINAL_WAIT_MS = 1200;
          const STABLE_CHECK_MS = 50;
          
          let lastTranscript = speculativePttTranscript;
          let stableCount = 0;
          
          await new Promise<void>((resolve) => {
            const waitStartTime = Date.now();
            const checkInterval = setInterval(() => {
              const elapsed = Date.now() - waitStartTime;
              const currentTranscript = speculativePttTranscript;
              
              // If transcript changed, reset stability counter
              if (currentTranscript !== lastTranscript) {
                lastTranscript = currentTranscript;
                stableCount = 0;
              } else {
                stableCount++;
              }
              
              const hasContent = currentTranscript.trim().length > 0;
              
              // Early exit: Deepgram sent is_final=true AND transcript stable for 100ms
              // Hard timeout: FINAL_WAIT_MS to prevent hanging if is_final never arrives
              const gotFinalAndStable = speculativePttGotFinal && hasContent && stableCount >= 2;
              
              if (gotFinalAndStable || elapsed >= FINAL_WAIT_MS) {
                clearInterval(checkInterval);
                console.log(`[SpeculativePTT] Wait complete: elapsed=${elapsed}ms, stable=${stableCount * STABLE_CHECK_MS}ms, hasContent=${hasContent}, gotFinal=${speculativePttGotFinal}`);
                resolve();
              }
            }, STABLE_CHECK_MS);
          });
          
          // NOW get the final transcript (which may have been updated during the wait)
          const finalTranscript = speculativePttTranscript.trim();
          const transcriptGrew = finalTranscript.length > interimTranscript.length;
          
          if (transcriptGrew) {
            console.log(`[SpeculativePTT] Final transcript grew: "${interimTranscript}" → "${finalTranscript}"`);
          }
          
          // Close the speculative session now that we have final transcript
          if (speculativePttSession) {
            speculativePttSession.close();
            speculativePttSession = null;
          }
          speculativePttPendingChunks = [];
          speculativePttSessionStarting = false;
          
          // PHASE 2: SPECULATIVE AI HANDLING
          // If we already triggered speculative AI, check if the transcript changed significantly
          if (speculativePttTriggered && speculativePttTranscriptUsed) {
            const speculativeWords = speculativePttTranscriptUsed.toLowerCase().split(/\s+/).filter(w => w.length > 0);
            const finalWords = finalTranscript.toLowerCase().split(/\s+/).filter(w => w.length > 0);
            
            // Calculate SYMMETRIC overlap - both directions must match
            // If user said more words after speculative trigger, we need to re-trigger
            const intersection = speculativeWords.filter(w => finalWords.includes(w));
            const forwardOverlap = speculativeWords.length > 0 ? intersection.length / speculativeWords.length : 0;
            
            // Check how many EXTRA words the user said after speculative was triggered
            const extraWords = finalWords.length - speculativeWords.length;
            const isTruncatedPrefix = extraWords > 1; // User added 2+ more words
            
            // Symmetric overlap: speculative must match final AND final shouldn't have too many extra words
            const overlap = isTruncatedPrefix ? 0 : forwardOverlap;
            
            console.log(`[SpeculativePTT] PHASE 2: Comparing transcripts - speculative: "${speculativePttTranscriptUsed}", final: "${finalTranscript}", overlap: ${(overlap * 100).toFixed(0)}%, extraWords: ${extraWords}`);
            
            if (overlap >= 0.8 && !isTruncatedPrefix) {
              // Transcript is similar enough - speculative AI result is valid!
              // No need to re-trigger, response is already streaming
              console.log(`[SpeculativePTT] PHASE 2: ✓ Using speculative AI result (${(overlap * 100).toFixed(0)}% overlap)`);
              
              // Clear pending transcript since we're using speculative result
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
              speculativeAiAccepted = true;  // Mark as accepted so audio_data skips processing
              
              // Notify client
              if (ws.readyState === WS_OPEN) {
                ws.send(JSON.stringify({
                  type: 'ptt_speculative_ai_accepted',
                  timestamp: Date.now(),
                  speculativeTranscript: speculativePttTranscriptUsed,
                  finalTranscript: finalTranscript,
                  overlap: overlap,
                }));
              }
            } else {
              // Transcript changed significantly - check if we can still interrupt
              console.log(`[SpeculativePTT] PHASE 2: ✗ Transcript changed too much (${(overlap * 100).toFixed(0)}% overlap)`);
              
              // Check if speculative AI is still generating (can be interrupted)
              // vs already completed (response already sent, too late to interrupt)
              const speculativeSession = orchestrator.getSession(session.id);
              const isStillGenerating = speculativeSession?.isGenerating ?? false;
              
              if (isStillGenerating) {
                // Speculative AI is still running - interrupt and re-trigger via audio_data
                console.log(`[SpeculativePTT] PHASE 2: Speculative still generating - interrupting and will re-trigger`);
                
                // Interrupt the speculative response
                orchestrator.handleInterrupt(session.id);
                
                // CRITICAL: Clear ALL speculative AI flags so audio_data runs normally
                speculativeAiInProgress = false;
                speculativeAiAccepted = false;  // Ensure audio_data is NOT skipped
                
                // Save final transcript for audio_data to use
                pendingSpeculativeTranscript = finalTranscript;
                pendingSpeculativeWordCount = speculativePttWordCount;
                
                // Notify client
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'ptt_speculative_ai_rejected',
                    timestamp: Date.now(),
                    reason: 'transcript_changed',
                    overlap: overlap,
                  }));
                }
              } else {
                // Speculative AI already completed - response already sent!
                // Accept the partial response rather than double-responding
                console.log(`[SpeculativePTT] PHASE 2: Speculative already completed - accepting partial response to prevent double-response`);
                
                // Clear pending transcript since speculative already responded
                pendingSpeculativeTranscript = null;
                pendingSpeculativeWordCount = 0;
                speculativeAiAccepted = true;  // Mark as accepted so audio_data skips processing
                
                // Notify client that we're using the speculative result (even though transcript changed slightly)
                if (ws.readyState === WS_OPEN) {
                  ws.send(JSON.stringify({
                    type: 'ptt_speculative_ai_accepted',
                    timestamp: Date.now(),
                    speculativeTranscript: speculativePttTranscriptUsed,
                    finalTranscript: finalTranscript,
                    overlap: overlap,
                    note: 'accepted_to_prevent_double_response',
                  }));
                }
              }
            }
          } else {
            // No speculative AI was triggered - we have the transcript, trigger AI directly!
            // In streaming PTT mode, there's no audio_data blob - we already have the transcript
            // BUGFIX: Use actual final word count, not stale interim word count
            const finalWordCount = finalTranscript.split(/\s+/).filter((w: string) => w.length > 0).length;

            // Cast to reset TypeScript's control-flow narrowing: after the
            // geminiLiveSession = null cleanup at line ~2632, TS narrows the
            // let-binding to null for all sequential code below it — even closures
            // that run at a different time. The assertion restores the true union type.
            const glSessionSnap = geminiLiveSession as GeminiLiveSession | null;
            if (glSessionSnap) {
              // GL path: the streaming audio was already delivered to GL via sendAudioChunk().
              // GL's own VAD drives the response; if we also have a transcript, send it as a
              // text turn for reliability. Do NOT set speculativeAiAccepted — the audio_data
              // handler may still have a transcript to contribute via sendTextTurn.
              // NOTE: local const snapshot avoids TypeScript's mutable-let narrowing-to-never
              if (finalTranscript && finalWordCount >= 1) {
                // Gap 6: score student pulse on every real GL utterance
                if (session) updateStudentPulse(session, finalTranscript);
                console.log(`[GeminiLive PTT] Routing transcript via text turn (${finalWordCount} words): "${finalTranscript.slice(0, 80)}"`);
                glSessionSnap.sendTextTurn(finalTranscript, { label: 'ptt-transcript', isStudentInput: true });
                // Tension + GOAP: evaluate async → combine world event + pedagogical directive
                if (session && (session as any).sceneCanvas) {
                  const glForTension = glSessionSnap;
                  evaluateAndUpdateTension(finalTranscript, session)
                    .then(worldEvent => {
                      const { directive, mutations } = selectPedagogicalDirective(session);
                      fireCanvasMutations(session, mutations, ws);
                      const shaper = selectStyleShaper(session);
                      const madrigalLink: string | undefined = (session as any).pendingMadrigalLink ?? undefined;
                      if ((session as any).pendingMadrigalLink) (session as any).pendingMadrigalLink = null;
                      const combined = [worldEvent, directive, shaper, madrigalLink].filter(Boolean).join(' ');
                      if (combined) glForTension.sendTextTurn(combined, { label: 'tension-goap-directive' });
                    })
                    .catch(() => {});
                }
              } else {
                console.log('[GeminiLive PTT] No transcript — GL VAD will handle response from streamed audio');
                // Quiet turn inside active scene: nudge if tension is elevated
                if (session && (session as any).sceneCanvas) {
                  const { directive: quietDirective, mutations: quietMutations } = selectPedagogicalDirective(session, true);
                  fireCanvasMutations(session, quietMutations, ws, false);
                  if (quietDirective) glSessionSnap.sendTextTurn(quietDirective, { label: 'quiet-directive' });
                }
              }
            } else if (finalTranscript && finalWordCount >= SPECULATIVE_TRANSCRIPT_MIN_WORDS) {
              console.log(`[SpeculativePTT] No speculative AI - triggering directly with transcript (${finalWordCount} words)`);
              
              // CRITICAL: Set speculativeAiAccepted so audio_data handler knows to skip
              // The client may still send audio_data after ptt_release, but we've already triggered AI
              speculativeAiAccepted = true;
              
              // Trigger AI generation directly
              try {
                orchestrator.processOpenMicTranscript(session.id, finalTranscript, 1.0)
                  .then(() => console.log(`[SpeculativePTT] Direct AI processing complete`))
                  .catch(err => console.error(`[SpeculativePTT] Direct AI processing failed:`, err));
              } catch (err) {
                console.error(`[SpeculativePTT] Failed to start direct AI processing:`, err);
              }
              
              // Clear pending transcript - we're processing directly
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
            } else if (finalTranscript && finalWordCount >= 1) {
              // BUGFIX: In streaming PTT mode, process even single-word commands
              // There's no blob fallback, so we must process what we have
              console.log(`[SpeculativePTT] Short transcript (${finalWordCount} words) - processing anyway (no blob fallback in streaming mode)`);
              
              speculativeAiAccepted = true;
              
              try {
                orchestrator.processOpenMicTranscript(session.id, finalTranscript, 1.0)
                  .then(() => console.log(`[SpeculativePTT] Direct AI processing complete`))
                  .catch(err => console.error(`[SpeculativePTT] Direct AI processing failed:`, err));
              } catch (err) {
                console.error(`[SpeculativePTT] Failed to start direct AI processing:`, err);
              }
              
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
            } else {
              // Empty transcript - nothing to process
              pendingSpeculativeTranscript = null;
              pendingSpeculativeWordCount = 0;
              console.log(`[SpeculativePTT] No transcript to process`);
              
              // CRITICAL: Send response_complete so client exits "processing" state
              // Without this, the client stays stuck in "thinking" forever
              if (ws.readyState === WS_OPEN) {
                ws.send(JSON.stringify({
                  type: 'response_complete',
                  timestamp: Date.now(),
                  reason: 'no_transcript',
                }));
              }
            }
          }
          
          if (ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify({
              type: 'ptt_final_transcript',
              timestamp: Date.now(),
              text: finalTranscript,
              wordCount: finalTranscript.split(/\s+/).filter((w: string) => w.length > 0).length,
              speculativeAiUsed: speculativePttTriggered || speculativeAiAccepted,
            }));
          }
          
          // Reset speculative state (but keep pendingSpeculativeTranscript and speculativeAiAccepted for audio_data!)
          speculativePttTranscript = '';
          speculativePttWordCount = 0;
          speculativePttTriggered = false;
          speculativePttTranscriptUsed = '';
          speculativeAiInProgress = false;  // Always clear in-progress flag
          // NOTE: speculativeAiAccepted is intentionally NOT reset here - audio_data will reset it after checking
          
          break;
        }
        
        case 'voice_override': {
          // Voice Lab: Apply session-level voice overrides (admin only)
          // These override database settings for TTS calls in this session only
          if (!isAuthenticated || !session) {
            console.warn('[Streaming Voice] voice_override rejected - not authenticated or no session');
            return;
          }
          
          // Check admin privileges - voice overrides allowed for Founder Mode or Raw Honesty Mode
          const canOverrideVoice = (session as any).isFounderMode || (session as any).isRawHonestyMode;
          if (!canOverrideVoice) {
            console.warn('[Streaming Voice] voice_override rejected - not in founder mode or honesty mode');
            return;
          }
          
          const overrideMsg = message as { 
            type: 'voice_override'; 
            override: {
              speakingRate?: number;
              personality?: string;
              expressiveness?: number;
              emotion?: string;
              voiceId?: string;
              pedagogicalFocus?: string;
              teachingStyle?: string;
              errorTolerance?: string;
              geminiLanguageCode?: string;
              glModel?: string;
            } | null;
          };
          
          // Detect if the voice, language code, or GL model changed so we can restart the GL session
          const prevVoiceId = (session as any).voiceOverride?.voiceId ?? session.voiceId;
          const prevLangCode = (session as any).voiceOverride?.geminiLanguageCode;
          const prevGlModel = (session as any).glModel ?? null;
          const nextVoiceId = overrideMsg.override?.voiceId;
          const nextLangCode = overrideMsg.override?.geminiLanguageCode;
          const nextGlModel = overrideMsg.override?.glModel ?? null;

          // Store override in session for use by TTS
          (session as any).voiceOverride = overrideMsg.override;
          
          // Also update orchestrator session
          orchestrator.setVoiceOverride(session.id, overrideMsg.override);
          
          console.log('[Streaming Voice] Voice override applied:', overrideMsg.override);

          // ── Gemini Live reconnect ──────────────────────────────────────────
          // Gemini Live bakes both the voice name AND the languageCode into the
          // WebSocket handshake — neither can be changed mid-session.  Reconnect
          // whenever either changes.
          const voiceChanged = nextVoiceId && nextVoiceId !== prevVoiceId;
          const langCodeChanged = nextLangCode !== prevLangCode;
          const glModelChanged = nextGlModel !== prevGlModel;
          if ((voiceChanged || langCodeChanged || glModelChanged) && geminiLiveSession && geminiLiveSystemPromptCache) {
            const changeReason = glModelChanged
              ? `GL model changed ${prevGlModel ?? 'default (3.1)'} → ${nextGlModel ?? 'default (3.1)'}`
              : voiceChanged
              ? `voice changed ${prevVoiceId} → ${nextVoiceId}`
              : `languageCode changed ${prevLangCode ?? 'default'} → ${nextLangCode ?? 'default'}`;
            console.log(`[GeminiLive] ${changeReason}, reconnecting…`);
            try {
              await geminiLiveSession.stop();
              if (conversationId) unregisterGlSession(conversationId, geminiLiveSession);
              geminiLiveSession = null;

              const glSendMessage = (targetWs: any, msg: any) => {
                try {
                  // See primary glSendMessage above: output activity resets idle timer too.
                  const resetOnOutput = (targetWs as any)?.__resetGlIdleTimer as (() => void) | undefined;
                  if (resetOnOutput) resetOnOutput();
                  if (targetWs?.readyState === 1) targetWs.send(JSON.stringify(msg));
                } catch (_) {}
              };
              geminiLiveSession = createGeminiLiveSession(session, glSendMessage);
              // Register reconnected session in the relay registry.
              if (conversationId) registerGlSession(conversationId, geminiLiveSession);
              // Interruption Buffer (reconnect path — same wiring as initial session)
              geminiLiveSession.onBargeIn = () => {
                if (session) {
                  (session as any).interruptedIntent =
                    (session as any).lastPedagogicalActionType ?? 'ELICIT';
                }
              };
              if (conversationId) {
                geminiLiveSession.onResumptionHandleUpdate = makeHandlePersister(conversationId);
              }
              const glDeclsReconnect = getDanielajGLFunctionDeclarationsForLanguage(
                session.targetLanguage || 'spanish',
                session.nativeLanguage || 'english'
              );
              await geminiLiveSession.start(geminiLiveSystemPromptCache, glDeclsReconnect);
              console.log(`[GeminiLive] Reconnected with voice: ${nextVoiceId} (${glDeclsReconnect.length} GL tools, lang: ${session.targetLanguage || 'spanish'})`);
              // Re-register the playback-ended callback for the (same) socket after reconnect
              const reconnectSocketId = (ws as any).socketId as string | undefined;
              if (reconnectSocketId) {
                glPlaybackEndedCallbacks.set(reconnectSocketId, () => geminiLiveSession?.onPlaybackEnded());
              }
            } catch (reconnErr: any) {
              console.error('[GeminiLive] Voice reconnect failed:', reconnErr.message);
              if (conversationId && geminiLiveSession) unregisterGlSession(conversationId, geminiLiveSession);
              geminiLiveSession = null;
            }
          }
          
          ws.send(JSON.stringify({
            type: 'voice_override_applied',
            timestamp: Date.now(),
            override: overrideMsg.override,
          }));
          break;
        }
        
        case 'video_frame': {
          // Vision feature: student has opted in to share their webcam or screen.
          // Forward the JPEG frame to Daniela's GL session as a sendRealtimeInput video call.
          // Fire-and-forget — no response expected; audio must never be blocked by a frame.
          if (!isAuthenticated || !session) break;
          const videoMsg = message as { type: 'video_frame'; data: string; source: 'webcam' | 'screen' };
          if (geminiLiveSession && videoMsg.data) {
            geminiLiveSession.sendVideoFrame(videoMsg.data, videoMsg.source === 'screen' ? 'screen' : 'webcam');
          }
          break;
        }

        case 'gl_retry_start': {
          // Student-initiated one-tap retry after all GL auto-reconnect attempts failed.
          // Resets the attempt counter server-side and re-establishes the GL session
          // with a fresh Context Bridge so Daniela resumes naturally.
          if (geminiLiveSession) {
            console.log('[GeminiLive] gl_retry_start received — student retrying after exhausted reconnects');
            geminiLiveSession.retryConnection().catch(err =>
              console.error('[GeminiLive] gl_retry_start: retryConnection() threw unexpectedly:', err?.message)
            );
          } else {
            console.warn('[GeminiLive] gl_retry_start received but no active GL session to retry');
          }
          break;
        }

        case 'set_input_mode': {
          const modeMessage = message as { type: 'set_input_mode'; inputMode: VoiceInputMode };
          currentInputMode = modeMessage.inputMode;
          console.log(`[OpenMic] Input mode changed to: ${currentInputMode}`);
          
          if (currentInputMode === 'push-to-talk' && openMicSession) {
            openMicSession.close();
            openMicSession = null;
          }
          
          ws.send(JSON.stringify({
            type: 'input_mode_changed',
            timestamp: Date.now(),
            inputMode: currentInputMode,
          }));
          break;
        }
        
        case 'end_session': {
          if (session) {
            // Run post-session analysis for motivation tracking (async, non-blocking)
            const capturedUserId = session.userId?.toString();
            const capturedLanguage = session.targetLanguage;
            const hasValidStartTime = sessionStartTime > 0;
            
            if (capturedUserId && capturedLanguage) {
              // Run post-session analysis (always) and validation (only if session had valid start)
              const analysisPromise = studentLearningService.runPostSessionAnalysis(capturedUserId, capturedLanguage);
              const validationPromise = hasValidStartTime 
                ? studentLearningService.runPostSessionValidation(capturedUserId, capturedLanguage, new Date(sessionStartTime))
                : Promise.resolve({ strugglesObserved: [], predictionsValidated: 0 });
              
              Promise.all([analysisPromise, validationPromise])
                .then(([alert, validation]) => {
                  if (alert) {
                    console.log(`[Streaming Voice] Post-session motivation alert: ${alert.severity}`);
                  }
                  if (validation.predictionsValidated > 0) {
                    console.log(`[Streaming Voice] Validated ${validation.predictionsValidated} predictions, observed ${validation.strugglesObserved.length} struggles`);
                  }
                })
                .catch(err => console.warn('[Streaming Voice] Post-session analysis failed:', err.message));
            }
            
            // End usage session for usage tracking and memory extraction
            if (usageSession) {
              const metrics = getCurrentVoiceMetricsSnapshot();
              // Capture id synchronously before nulling — the promise chain below is async
              // and usageSession will be null by the time the .then() callbacks fire
              const capturedUsageSessionId = usageSession.id;
              try {
                endDurableVoiceSession(capturedUsageSessionId, undefined, () => usageService.updateSessionMetrics(capturedUsageSessionId, {
                  exchangeCount: metrics.exchangeCount,
                  studentSpeakingSeconds: metrics.studentSpeakingSeconds,
                  tutorSpeakingSeconds: metrics.tutorSpeakingSeconds,
                  ttsCharacters: metrics.ttsCharacters,
                  sttSeconds: metrics.sttSeconds,
                }))
                  .then((endedSession) => {
                    if (endedSession) {
                      console.log(`[Streaming Voice] Usage session ended: ${endedSession.durationSeconds}s, ${metrics.exchangeCount} exchanges`);
                    } else {
                      console.log(`[Streaming Voice] Usage session ended (no metrics returned)`);
                    }
                  })
                  .catch(err => console.error('[Streaming Voice] Failed to end usage session:', err.message));
              } catch (err: any) {
                console.error('[Streaming Voice] Usage session cleanup error:', err.message);
              }
              usageSession = null;
            }
            
            orchestrator.endSession(session.id);
          }
          ws.close();
          break;
        }
        
        default:
          console.log('[Streaming Voice] Unhandled message type:', message.type);
      }
    } catch (err) {
      console.error('[Streaming Voice] Message processing error:', err);
    }
  });

  // Registered so the Socket.io duplicate-connection guard (setupSocketIOHandler) can
  // store this connection's grace-period data synchronously the instant a replacement
  // connection arrives, instead of waiting up to 350ms for this connection's own close
  // handler to run. See docs/open-bugs.md (2026-07-10, reconnect grace claim race).
  if (conversationId) {
    duplicateReplacedCallbacks.set(conversationId, () => {
      if (usageSession && conversationId && userId && !pendingReconnectAlreadyStored) {
        console.log(`[Streaming Voice] Duplicate connection detected — storing session for reconnect grace period early (${conversationId.substring(0, 8)})`);
        // Capture carry-forward state before endSession() removes the session from memory.
        // _deferCarryForward tells endSession() to skip persist for this grace-eligible close.
        const earlyRrCarryState = session?.isReadingRoom && !session.isIncognito && !(session as any)._wasEverIncognito
          ? { notes: (session as any).sessionNotes as string[] ?? [], notesSaved: !!(session as any).sessionNotesSaved, userId: String(session.userId) }
          : undefined;
        if (session && earlyRrCarryState) (session as any)._deferCarryForward = true;
        const metrics = getCurrentVoiceMetricsSnapshot();
        storePendingReconnect(conversationId, {
          usageSessionId: usageSession.id,
          compassSessionActive: !!compassSession,
          exchangeCount: metrics.exchangeCount,
          studentSpeakingSeconds: Math.round(metrics.studentSpeakingSeconds),
          tutorSpeakingSeconds: Math.round(metrics.tutorSpeakingSeconds),
          ttsCharacters: metrics.ttsCharacters,
          sttSeconds: Math.round(metrics.sttSeconds),
          sessionStartTime,
          userId: userId!,
          orchestratorSessionId: session?.id,
          connectionId: (ws as any).socketId,
          closeReason: 'duplicate_replaced',
          rrCarryState: earlyRrCarryState,
          sessionNotes: session ? extractSessionNotesForReconnect(session) : [],
        });
        pendingReconnectAlreadyStored = true;
        usageSession = null;
        compassSession = null;
        compassContext = null;
      }
    });
  }

  ws.on('close', (closeCode: number, closeReason: Buffer) => {
    console.log(`[Streaming Voice] Socket.io connection closed (code: ${closeCode})`);

    if (conversationId && duplicateReplacedCallbacks.get(conversationId)) {
      duplicateReplacedCallbacks.delete(conversationId);
    }

    // Snapshot identifiers and session context before any nulling —
    // needed for the Sofia flare and telemetry write below
    const disconnectUserId = userId;
    const disconnectSessionId = usageSession?.id;
    let disconnectExchangeCount = exchangeCount; // updated below after GL exchanges added
    const disconnectStudentSpeaking = studentSpeakingSeconds;
    const disconnectTutorSpeaking = tutorSpeakingSeconds;
    const disconnectDurationSeconds = sessionStartTime > 0 ? Math.round((Date.now() - sessionStartTime) / 1000) : 0;
    const disconnectHadGlSession = !!geminiLiveSession;

    // Clear GL idle timeout, periodic sync, and tutor watchdog timers
    if (glIdleTimeoutHandle) { clearTimeout(glIdleTimeoutHandle); glIdleTimeoutHandle = null; }
    if (glMetricsSyncHandle) { clearInterval(glMetricsSyncHandle); glMetricsSyncHandle = null; }
    if (tutorNoResponseWatchdog) { clearTimeout(tutorNoResponseWatchdog); tutorNoResponseWatchdog = null; }
    (ws as any).__resetGlIdleTimer = undefined;

    // Capture Gemini Live metrics before stopping (stop() resets internal state)
    if (geminiLiveSession) {
      const metrics = getCurrentVoiceMetricsSnapshot();
      const glMetrics = geminiLiveSession.getUsageSummary();
      const glExchanges = geminiLiveSession.getCompletedExchangeCount();
      const glOutputChars = geminiLiveSession.getTotalOutputCharacters();
      const glLatency = geminiLiveSession.getTurnLatencyStats();
      exchangeCount = metrics.exchangeCount;
      disconnectExchangeCount = exchangeCount; // include GL exchanges in disconnect telemetry
      ttsCharacters = metrics.ttsCharacters;
      studentSpeakingSeconds = metrics.studentSpeakingSeconds;
      tutorSpeakingSeconds = metrics.tutorSpeakingSeconds;
      if (glMetrics.inputTokens > 0 || glMetrics.outputTokens > 0) {
        const visionNote = glMetrics.videoFramesSent > 0
          ? `, vision: ${glMetrics.videoFramesSent} frames`
          : '';
        console.log(`[GeminiLive] Session end metrics — exchanges: ${glExchanges}, outputChars: ${glOutputChars}, tokens: ${glMetrics.inputTokens}in/${glMetrics.outputTokens}out${visionNote}`);
        // Log GL token costs to ai_cost_logs so burn report's per-model breakdown
        // includes GL usage. costTracker persists to DB via the wired DbPersister.
        costTracker.track(GEMINI_LIVE_MODEL, glMetrics.inputTokens, glMetrics.outputTokens, 'gemini-live-session');
      }
      // Vision burn report line — separate entry so the report shows the vision
      // portion of GL input cost as its own line item.  Estimated at ~2,000 tokens/frame
      // (webcam ≈ 1,548 · screen ≈ 3,870 · 2,000 is a conservative midpoint).
      // These tokens are already counted inside the GL session usageMetadata above,
      // so this is a visibility breakdown, not an additional charge.
      if (glMetrics.videoFramesSent > 0) {
        const TOKENS_PER_FRAME_EST = 2000;
        const estimatedVisionTokens = glMetrics.videoFramesSent * TOKENS_PER_FRAME_EST;
        costTracker.track('gemini-live-vision', estimatedVisionTokens, 0, `${glMetrics.videoFramesSent} frames est.`);
        console.log(`[GeminiLive] Vision cost est. — ${glMetrics.videoFramesSent} frames × ${TOKENS_PER_FRAME_EST} tokens/frame = ~${estimatedVisionTokens.toLocaleString()} tokens`);
      }
      if (glLatency.count > 0) {
        console.log(`[GeminiLive] Latency stats — avg: ${glLatency.avgMs}ms, p50: ${glLatency.p50Ms}ms, p95: ${glLatency.p95Ms}ms (${glLatency.count} turns)`);
        // Write latency telemetry event for voice health monitor
        if (usageSession && userId) {
          const eventPayload = JSON.stringify({ avgMs: glLatency.avgMs, p50Ms: glLatency.p50Ms, p95Ms: glLatency.p95Ms, count: glLatency.count });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (gen_random_uuid(), ${usageSession.id}, ${String(userId)}, 'gl_turn_latency',
              ${eventPayload}::jsonb, NOW())
          `).catch((err: Error) => console.warn('[GeminiLive] Failed to write latency event:', err.message));
        }
      }
      // Store GL token counts on usageSession for updateSessionMetrics below
      if (usageSession) {
        (usageSession as any)._glInputTokens = glMetrics.inputTokens;
        (usageSession as any)._glOutputTokens = glMetrics.outputTokens;
      }
      void geminiLiveSession.stop().catch(err =>
        console.warn('[GeminiLive] Teardown summary error:', err),
      );
      if (conversationId) unregisterGlSession(conversationId, geminiLiveSession);
      geminiLiveSession = null;
      // Clean up persisted resumption handle — session ended cleanly
      if (conversationId) clearPersistedHandle(conversationId);
    } else if (openaiRealtimeSession) {
      openaiRealtimeSession.stop();
      openaiRealtimeSession = null;
    }
    if (disconnectHadGlSession) {
      // Generate conversation title at GL session end.
      // GL sessions persist messages directly via GeminiLiveSession.persistMessage()
      // bypassing the per-turn enrichment pipeline (processBackgroundEnrichment),
      // which is the only place tagConversation fires for non-GL sessions.
      // We tag here — once, at close — to ensure GL conversations get a title.
      if (conversationId && userId) {
        const titleLang = sessionLanguage || 'english';
        import('./services/conversation-tagger').then(({ tagConversation }) => {
          storage.getMessagesByConversation(conversationId).then((msgs: Array<{ role: string; content: string }>) => {
            if (msgs.length >= 2) {
              return tagConversation(conversationId, msgs.map(m => ({ role: m.role, content: m.content })), titleLang);
            }
          }).then((result) => {
            if (result?.title) {
              console.log(`[GeminiLive] ✓ Conversation titled: "${result.title}" (${result.topicsAdded} topics)`);
            }
          }).catch((err: Error) => console.warn('[GeminiLive] Title generation failed:', err.message));
        }).catch(() => {});

        // VOCAB MINING: Extract vocabulary/phrases for the "From Your Conversations" section
        // GL sessions bypass the per-turn enrichment that creates review items in the text pipeline.
        // We run it here at session end instead.
        if (!session?.isIncognito) {
          import('./services/vocabulary-mining-service').then(({ mineVocabularyFromSession }) => {
            storage.getMessagesByConversation(conversationId).then((msgs: Array<{ role: string; content: string }>) => {
              if (msgs.length >= 10) {
                return mineVocabularyFromSession(
                  String(userId),
                  sessionLanguage || 'spanish',
                  msgs.map(m => ({ role: m.role, content: m.content })),
                  conversationId,
                  null,
                );
              }
            }).then((result: any) => {
              if (result?.saved > 0) {
                console.log(`[GeminiLive] ✓ Vocab mining: saved ${result.saved} review items`);
              }
            }).catch((err: Error) => console.warn('[GeminiLive] Vocab mining failed:', err.message));
          }).catch(() => {});

          // ── Immediate reflection — while the air is still warm ─────────────────
          // Generate Daniela's session reflection NOW, at session close, while
          // the transcript is still hot in memory. This replaces the old
          // schedulePendingReflectionIfMissing() approach that deferred to next
          // session start — generating "cold" from a stored transcript preview.
          //
          // Insight (July 6, 2026 — Gemini + Daniela consult):
          //   Gemini: close_session is a "terminal function gravity well" — the model
          //   reliably skips write_to_self because goodbye→close is a stronger trained
          //   weight than sequential instruction-following. This is structural, not a
          //   prompt problem.
          //   Daniela: "the goodbye is a hard guillotine — writing after the door is
          //   shut feels clinical and lonely." The reflection needs to happen while
          //   the session's warmth is still present.
          //
          // generateReflectionNow() is a no-op if Daniela already called write_to_self
          // herself — so this is safe on all close paths (clean, drop, or timeout).
          // The pending_reflections fallback (schedulePendingReflectionIfMissing) is
          // retained for server crash scenarios where ws.on('close') may not fire.
          if (disconnectExchangeCount >= MIN_EXCHANGES_FOR_REFLECTION && disconnectUserId && compassSession?.id) {
            // Sequential: PRIMARY runs first, FALLBACK only fires after PRIMARY completes.
            // This eliminates the race condition where both see "no existing reflection"
            // simultaneously and both proceed. By the time schedulePendingReflectionIfMissing
            // runs, generateReflectionNow has either written its row (fallback no-ops) or
            // failed (fallback writes the safety-net pending row instead).
            storage.getMessagesByConversation(conversationId).then((msgs: Array<{ role: string; content: string }>) => {
              const preview8k = buildTranscriptPreview(msgs, 8000);
              const preview2k = buildTranscriptPreview(msgs, 2000);
              return generateReflectionNow(
                disconnectUserId,
                compassSession!.id,
                preview8k,
                sessionLanguage || 'spanish',
              ).then(() => schedulePendingReflectionIfMissing(
                disconnectUserId,
                compassSession!.id,
                conversationId,
                preview2k,
                sessionLanguage || 'spanish',
              ));
            }).catch((err: Error) => console.warn('[GeminiLive] Session reflection pipeline failed:', err.message));
          }

          // Pedagogical brief — Daniela's working theory for next session (fire-and-forget)
          if (disconnectExchangeCount >= MIN_EXCHANGES_FOR_BRIEF && disconnectUserId && compassSession?.id) {
            storage.getMessagesByConversation(conversationId).then((msgs: Array<{ role: string; content: string }>) => {
              const preview = buildTranscriptPreview(msgs, 3000);
              return generateAndStorePedagogicalBrief(
                disconnectUserId,
                compassSession!.id,
                sessionLanguage || 'spanish',
                preview,
              );
            }).catch((err: Error) => console.warn('[GeminiLive] Pedagogical brief generation failed:', err.message));
          }

          // Mastery evidence — ACTFL Can-Do analysis (fire-and-forget)
          if (disconnectExchangeCount >= MIN_EXCHANGES_FOR_MASTERY && disconnectUserId && compassSession?.id) {
            storage.getMessagesByConversation(conversationId).then((msgs: Array<{ role: string; content: string }>) => {
              const preview = buildTranscriptPreview(msgs, 3000);
              return analyzeSessionForMasteryEvidence(
                disconnectUserId,
                compassSession!.id,
                sessionLanguage || 'spanish',
                preview,
                null, // actflLevel resolved at next mastery digest read
              );
            }).catch((err: Error) => console.warn('[GeminiLive] Mastery evidence analysis failed:', err.message));
          }

          // Class-enrollment placement assessment — runs post-session for Level 2+ enrollments
          // that require placement but haven't been checked yet. Self-directed students use the
          // in-session path (start_placement_assessment tool + SET_ACTFL_LEVEL). This path is
          // for teacher-managed classes where the instructor wants AI-verified placement.
          if (disconnectUserId && conversationId) {
            shouldRunPlacementAfterSession(disconnectUserId, conversationId)
              .then(async (check) => {
                if (check.shouldRun && check.enrollmentId) {
                  console.log(`[Placement] Running post-session placement for enrollment ${check.enrollmentId}`);
                  await completePlacementAssessment(disconnectUserId, check.enrollmentId, conversationId);
                }
              })
              .catch((err: Error) => console.warn('[Placement] Post-session placement failed:', err.message));
          }
        }
      }
    }
    
    if (openMicSession) {
      openMicSession.close();
      openMicSession = null;
    }
    openMicPendingChunks = [];
    openMicSessionStarting = false;
    
    // Clean up playback-ended callback bridge for this socket
    const cleanupSocketId = (ws as any).socketId as string | undefined;
    if (cleanupSocketId) {
      glPlaybackEndedCallbacks.delete(cleanupSocketId);
    }

    // Clean up echo suppression timeout
    if (echoSuppressionTimeoutSO) {
      clearTimeout(echoSuppressionTimeoutSO);
      echoSuppressionTimeoutSO = null;
    }
    
    // Clean up speculative PTT session
    if (speculativePttSession) {
      speculativePttSession.close();
      speculativePttSession = null;
    }
    speculativePttPendingChunks = [];
    speculativePttSessionStarting = false;
    speculativePttTranscript = '';
    speculativePttWordCount = 0;
    speculativePttTriggered = false;
    speculativePttTranscriptUsed = '';
    speculativeAiInProgress = false;
    speculativeAiAccepted = false;
    pendingSpeculativeTranscript = null;
    pendingSpeculativeWordCount = 0;
    
    // End usage session on disconnect — use grace period for seamless reconnection
    // (may already have been stored early by the duplicate-connection guard's
    // callback if a replacement connection landed before this close fired)
    if (usageSession && conversationId && userId && !pendingReconnectAlreadyStored) {
      console.log(`[Streaming Voice] Socket.io disconnect — storing session for reconnect grace period (${conversationId.substring(0, 8)})`);
      // Capture carry-forward state before endSession() removes the session from memory.
      // _deferCarryForward tells endSession() to skip persist for this grace-eligible close.
      const wsRrCarryState = session?.isReadingRoom && !session.isIncognito && !(session as any)._wasEverIncognito
        ? { notes: (session as any).sessionNotes as string[] ?? [], notesSaved: !!(session as any).sessionNotesSaved, userId: String(session.userId) }
        : undefined;
      if (session && wsRrCarryState) (session as any)._deferCarryForward = true;
      storePendingReconnect(conversationId, {
        usageSessionId: usageSession.id,
        compassSessionActive: !!compassSession,
        exchangeCount,
        studentSpeakingSeconds: Math.round(studentSpeakingSeconds),
        tutorSpeakingSeconds: Math.round(tutorSpeakingSeconds),
        ttsCharacters,
        sttSeconds: Math.round(sttSeconds),
        sessionStartTime,
        userId: userId!,
        orchestratorSessionId: session?.id,
        connectionId: (ws as any).socketId,
        closeCode,
        closeReason: closeReason?.toString(),
        rrCarryState: wsRrCarryState,
        sessionNotes: session ? extractSessionNotesForReconnect(session) : [],
      });
      pendingReconnectAlreadyStored = true;
      usageSession = null;
      compassSession = null;
      compassContext = null;
    } else if (usageSession) {
      // Capture id synchronously before nulling — same async-null pattern as session_closed handler
      const capturedUsageSessionId = usageSession.id;
      const glInputTokens = (usageSession as any)._glInputTokens as number | undefined;
      const glOutputTokens = (usageSession as any)._glOutputTokens as number | undefined;
      endDurableVoiceSession(capturedUsageSessionId, 'abandoned', () => usageService.updateSessionMetrics(capturedUsageSessionId, {
        exchangeCount,
        studentSpeakingSeconds: Math.round(studentSpeakingSeconds),
        tutorSpeakingSeconds: Math.round(tutorSpeakingSeconds),
        ttsCharacters,
        sttSeconds: Math.round(sttSeconds),
        ...(glInputTokens ? { llmInputTokens: glInputTokens } : {}),
        ...(glOutputTokens ? { llmOutputTokens: glOutputTokens } : {}),
      }))
        .then((endedSession) => {
          if (endedSession) {
            console.log(`[Streaming Voice] Usage session ended on disconnect: ${endedSession.durationSeconds}s, ${exchangeCount} exchanges`);
          } else {
            console.log(`[Streaming Voice] Usage session ended on disconnect (no metrics returned)`);
          }
        })
        .catch(err => console.error('[Streaming Voice] Failed to end usage session on disconnect:', err.message));
      usageSession = null;
    }
    
    if (session) orchestrator.endSession(session.id);

    // ── Abnormal-disconnect telemetry + Sofia flare ──────────────────────────
    // Code 1000 = normal close (idle timeout, user left, session_closed message).
    // Code 1001 = browser navigating away.
    // undefined = client closed without specifying code (tab closed, navigation, etc.) — treat as clean.
    // Anything else (1006 network drop, etc.) with real activity is worth investigating.
    // We write a pipeline event for trend analysis AND file a Sofia flare.
    const CLEAN_CLOSE_CODES = new Set([1000, 1001]);
    if (closeCode !== undefined && !CLEAN_CLOSE_CODES.has(closeCode) && disconnectUserId &&
        (disconnectExchangeCount > 0 || disconnectStudentSpeaking > 0)) {
      // Write to voice_pipeline_events for queryable trend analysis
      try {
        const eventPayload = JSON.stringify({
          closeCode,
          sessionDurationSeconds: disconnectDurationSeconds,
          exchangeCount: disconnectExchangeCount,
          studentSpeakingSeconds: disconnectStudentSpeaking,
          tutorSpeakingSeconds: disconnectTutorSpeaking,
          hadGlSession: disconnectHadGlSession,
        });
        getSharedDb().execute(sql`
          INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
          VALUES (gen_random_uuid(), ${disconnectSessionId ?? null}, ${String(disconnectUserId)},
            'session_abnormal_disconnect', ${eventPayload}::jsonb, NOW())
        `).catch((err: Error) => console.warn('[Streaming Voice] Failed to write disconnect telemetry:', err.message));
      } catch (_) {}
      // File Sofia flare for immediate intervention
      import('./services/sofia-billing-monitor').then(({ reportAbnormalDisconnect }) => {
        reportAbnormalDisconnect({
          userId: disconnectUserId,
          sessionId: disconnectSessionId,
          closeCode,
          exchangeCount: disconnectExchangeCount,
          studentSpeakingSeconds: disconnectStudentSpeaking,
        }).catch(() => {});
      }).catch(() => {});
    }
  });

  ws.on('error', (error) => {
    console.error('[Streaming Voice] Socket.io connection error:', error);

    // Clear GL idle timeout and periodic sync timers
    if (glIdleTimeoutHandle) { clearTimeout(glIdleTimeoutHandle); glIdleTimeoutHandle = null; }
    if (glMetricsSyncHandle) { clearInterval(glMetricsSyncHandle); glMetricsSyncHandle = null; }
    if (tutorNoResponseWatchdog) { clearTimeout(tutorNoResponseWatchdog); tutorNoResponseWatchdog = null; }
    (ws as any).__resetGlIdleTimer = undefined;

    // Capture Gemini Live metrics before stopping on error
    if (geminiLiveSession) {
      const metrics = getCurrentVoiceMetricsSnapshot();
      const glMetrics = geminiLiveSession.getUsageSummary();
      const glLatency = geminiLiveSession.getTurnLatencyStats();
      exchangeCount = metrics.exchangeCount;
      ttsCharacters = metrics.ttsCharacters;
      studentSpeakingSeconds = metrics.studentSpeakingSeconds;
      tutorSpeakingSeconds = metrics.tutorSpeakingSeconds;
      if (usageSession) {
        (usageSession as any)._glInputTokens = glMetrics.inputTokens;
        (usageSession as any)._glOutputTokens = glMetrics.outputTokens;
      }
      // Write latency telemetry on error path (same as close handler)
      if (glLatency.count > 0) {
        console.log(`[GeminiLive] Latency stats (error) — avg: ${glLatency.avgMs}ms, p50: ${glLatency.p50Ms}ms, p95: ${glLatency.p95Ms}ms (${glLatency.count} turns)`);
        if (usageSession && userId) {
          const eventPayload = JSON.stringify({ avgMs: glLatency.avgMs, p50Ms: glLatency.p50Ms, p95Ms: glLatency.p95Ms, count: glLatency.count });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (gen_random_uuid(), ${usageSession.id}, ${String(userId)}, 'gl_turn_latency',
              ${eventPayload}::jsonb, NOW())
          `).catch((err: Error) => console.warn('[GeminiLive] Failed to write latency event (error path):', err.message));
        }
      }
      void geminiLiveSession.stop().catch(err =>
        console.warn('[GeminiLive] Error teardown summary error:', err),
      );
      if (conversationId) unregisterGlSession(conversationId, geminiLiveSession);
      geminiLiveSession = null;
      // Clean up persisted resumption handle — session ended (error path)
      if (conversationId) clearPersistedHandle(conversationId);
    } else if (openaiRealtimeSession) {
      openaiRealtimeSession.stop();
      openaiRealtimeSession = null;
    }

    if (openMicSession) {
      openMicSession.close();
      openMicSession = null;
    }
    openMicPendingChunks = [];
    openMicSessionStarting = false;

    // Clean up speculative PTT session on error
    if (speculativePttSession) {
      speculativePttSession.close();
      speculativePttSession = null;
    }
    speculativePttPendingChunks = [];
    speculativePttSessionStarting = false;
    speculativePttTranscript = '';
    speculativePttWordCount = 0;
    speculativePttTriggered = false;
    speculativePttTranscriptUsed = '';
    speculativeAiInProgress = false;
    speculativeAiAccepted = false;
    pendingSpeculativeTranscript = null;
    pendingSpeculativeWordCount = 0;
    
    // End usage session on error for usage tracking
    if (usageSession) {
      const capturedUsageSessionId = usageSession.id;
      const glInputTokens = (usageSession as any)._glInputTokens as number | undefined;
      const glOutputTokens = (usageSession as any)._glOutputTokens as number | undefined;
      endDurableVoiceSession(capturedUsageSessionId, 'error', () => usageService.updateSessionMetrics(capturedUsageSessionId, {
        exchangeCount,
        studentSpeakingSeconds,
        tutorSpeakingSeconds,
        ttsCharacters,
        sttSeconds,
        ...(glInputTokens ? { llmInputTokens: glInputTokens } : {}),
        ...(glOutputTokens ? { llmOutputTokens: glOutputTokens } : {}),
      }))
        .then((endedSession) => {
          if (endedSession) {
            console.log(`[Streaming Voice] Usage session ended on error: ${endedSession.durationSeconds}s, ${exchangeCount} exchanges`);
          } else {
            console.log(`[Streaming Voice] Usage session ended on error (no metrics returned)`);
          }
        })
        .catch(err => console.error('[Streaming Voice] Failed to end usage session on error:', err.message));
      usageSession = null;
    }
    
    // READING ROOM NOTES CARRY-FORWARD (error path):
    // Unlike the normal close path, WS errors do not use the grace-period mechanism, so
    // we must capture and start the atomic persist here before endSession() removes the
    // session. _deferCarryForward prevents a double-write from endSession's internal call.
    // The CTE write is fire-and-forget (unavoidable in a sync error handler) but is atomic
    // at the DB level — if the process survives long enough for it to commit, the notes are
    // durable and will be picked up by the next Reading Room session.
    if (session?.isReadingRoom && !session.isIncognito && !(session as any)._wasEverIncognito) {
      const errNotes = (session as any).sessionNotes as string[] | undefined;
      const errSaved = (session as any).sessionNotesSaved as boolean | undefined;
      const errCarryState = { notes: errNotes ?? [], notesSaved: !!errSaved, userId: String(session.userId) };
      (session as any)._deferCarryForward = true; // prevent double-write in endSession()
      getStreamingVoiceOrchestrator().persistReadingRoomCarryState(errCarryState)
        .catch((e: Error) => console.warn('[ReadingRoom] Error-path carry-forward failed (non-fatal):', e.message));
      console.log(`[ReadingRoom] Carry-forward initiated on WS error (${errNotes?.length ?? 0} note(s))`);
    }

    if (session) orchestrator.endSession(session.id);
  });
}

/**
 * Send error message via voice connection adapter (works for both native WS and Socket.IO)
 */
function sendErrorAdapter(ws: VoiceWSConnection, code: string, message: string, recoverable: boolean) {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      timestamp: Date.now(),
      code,
      message,
      recoverable,
    } as StreamingErrorMessage));
  }
}
