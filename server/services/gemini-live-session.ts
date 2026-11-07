// ── Archive Guardian A/B channel config ─────────────────────────────────────
// Controls whether the Archive Guardian whisper fires via the concat path
// (embedded in the last tool response body) or a dedicated clientContent
// channel (its own sendClientContent call). Toggle via POST /api/admin/guardian/channel.
let _globalGuardianChannel: 'concat' | 'dedicated' = 'concat';
export function setGlobalGuardianChannel(ch: 'concat' | 'dedicated'): void { _globalGuardianChannel = ch; }
export function getGlobalGuardianChannel(): 'concat' | 'dedicated' { return _globalGuardianChannel; }

// ── Archive Guardian late-arrival fallback mode ──────────────────────────────
// Controls what happens when the pre-turn grounding DB lookup resolves AFTER
// Daniela has already started generating audio (late arrival on the no-tool-call path).
//
//   'interrupt'     — fire sendClientContent regardless; GL treats it as a barge-in
//                     (interrupted: true), cuts Daniela off and forces a restart.
//                     Grounding is guaranteed this turn. Side effect: audible restarts.
//
//   'carry-forward' — (default) buffer the late result until the next student
//                     utterance begins, then discard it as stale. A result for an
//                     older topic must never be merged into a newer response.
//
// Toggle via POST /api/admin/guardian/fallback-mode.
let _globalPreTurnFallbackMode: 'interrupt' | 'carry-forward' = 'carry-forward';
export function setGlobalPreTurnFallbackMode(mode: 'interrupt' | 'carry-forward'): void { _globalPreTurnFallbackMode = mode; }
export function getGlobalPreTurnFallbackMode(): 'interrupt' | 'carry-forward' { return _globalPreTurnFallbackMode; }

import { watchGoAway } from './gl-go-away';
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  HarmCategory,
  HarmBlockThreshold,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { TurnReplayGuard } from './gemini-live-replay-detector';
import { NativeFunctionCallHandler } from './native-fc-handlers';
import type { StreamingSession } from './streaming-session-types';
import { advanceCompletedExchangeForEpoch } from './voice-exchange-accounting';
import { lookupLegacyType, buildFunctionContinuationResponse } from './daniela-function-registry';
import type { ExtractedFunctionCall } from './gemini-function-declarations';
import {
  reportGlToolCallFailure,
  reportGlToolCallSuccess,
  reportGreetingRetryAttempt,
  reportGreetingRetryExhausted,
} from './sofia-billing-monitor';
import {
  GreetingDeliveryState,
  acknowledgeFirstGreetingAudio,
  beginQueuedGreetingDispatch,
  markGreetingNoAudio,
} from './greeting-delivery-state';
import { voiceTelemetry } from './voice-pipeline-telemetry';
import { observeAudioSent, observeBargeIn } from './playback-observation';
import { glLiveAlert } from './gl-live-monitor';
import {
  observeSessionStart,
  observeActflUpdate,
  observeSessionEnd,
  observeGuardianState,
  observeTurnComplete,
  observeFrictionScore,
  observeContextLineageEvent,
  observeContextLineageHealth,
  observeContextLineageLink,
  observeModelAndUsage,
  observeOutboundVisuals,
  observeToolResults,
  observeVisionFrame,
} from './session-observation-store';
import {
  ContextLineageRecorder,
  createDatabaseContextLineageSink,
  type ContextLineageEventInput,
  type ContextLineageLinkInput,
} from './context-lineage-service';
import {
  appendGuardianTraceEvent,
  createGuardianAttempt,
  finalizeGuardianAttempt,
  resolveGuardianTerminalOutcome,
  selectGuardianArchiveCandidate,
} from './guardian-attempt-trace';
import type {
  GuardianAttemptPath,
  GuardianAttemptTrace,
  GuardianTraceEvent,
} from './guardian-attempt-trace';
import { getSharedDb } from '../db';
import { generateConversationTitle } from '../conversation-utils';
import { sql, eq } from 'drizzle-orm';
import { voiceSessions } from '@shared/schema';
import { GLKaraokeTracker } from './gl-karaoke-tracker';
import { PostResponseEnrichmentService } from './post-response-enrichment';
import { evaluatePedagogicalState, computeScaffoldingLevel } from './pedagogical-supervisor';
import {
  detectFrictionlessSlide,
  recordSlideDetection,
  initSlideState,
  buildGroundingNudge,
  shouldAutoGround,
  runAutoGrounding,
  detectStudentMemoryRisk,
  detectStudentEmotionalValence,
  doesStudentExplicitlyReopenGroundingTopic,
  extractGroundingAssertionCandidate,
} from './frictionless-slide-detector';
import { consumeLucaSessionContext } from './luca-session-context';
import { analyzeFriction } from './llm-friction-analyzer';
import { storage } from '../storage';
import type { IStorage } from '../storage';
import {
  MEMORY_TOOL_NAMES,
  MEMORY_CHAIN_LIMIT,
  MEMORY_CHAIN_NUDGE_TEXT,
  NAMED_RECORD_PHRASES,
} from './memory-chain-guard';
import { randomUUID } from 'crypto';
import { persistGuardianSummary } from './guardian-summary';

/**
 * Immutable identity for one Guardian lookup. Grounding is asynchronous, while
 * student speech and GL generation are not: a result is useful only for the
 * precise utterance and memory candidate that caused the lookup.
 */
export interface GroundingTurnBinding {
  studentTurnEpoch: number;
  studentUtterance: string;
  candidateAssertion: string;
  /** Immutable trace that was active when the asynchronous lookup began. */
  traceId?: string | null;
}

export interface PriorTurnGroundingCorrection {
  groundingResult: string;
  binding: GroundingTurnBinding;
  eligibleStudentTurnEpoch: number;
}
export const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const AUDIO_OUTPUT_SAMPLE_RATE = 24000;
const AUDIO_INPUT_SAMPLE_RATE = 16000;

/** Typed shape for every GL function-call response payload.
 * The `result` field is the string that Daniela reads; all other keys are
 * optional pass-through data.  Using an explicit interface (rather than
 * `Record<string, unknown>`) means a field rename (e.g. result→output) on
 * the GL SDK side will produce a compile error instead of a silent no-op.
 * Defined at module level so both the main tool-call handler AND the
 * reconnect-unblock synthetic-response path share the same type — preventing
 * either path from silently drifting to a different field name. */
export interface GLToolResponsePayload {
  result: string;
  [key: string]: unknown;
}
/** Default voice for Daniela in Gemini Live mode. */
const DEFAULT_LIVE_VOICE = 'Aoede';

/**
 * Map target language names → BCP-47 language codes for Gemini Live speechConfig.
 * Controls both STT recognition language and influences output voice accent.
 */
const LANGUAGE_TO_BCP47: Record<string, string> = {
  english:    'en-US',
  spanish:    'es-ES',   // es-US caused silence on gemini-3.1-flash-live-preview; es-ES is correct BCP-47
  french:     'fr-FR',
  italian:    'it-IT',
  portuguese: 'pt-BR',
  german:     'de-DE',
  japanese:   'ja-JP',
  mandarin:   'zh-CN',
  chinese:    'zh-CN',
  korean:     'ko-KR',
  hebrew:     'he-IL',
};

/**
 * Complete set of valid Gemini Live prebuilt voice names.
 * The voice ID used in our DB/overrides IS the voice name — no translation needed.
 * Gemini Live rejects unknown voice names, so we validate against this set and
 * fall back to DEFAULT_LIVE_VOICE for anything not in the list.
 */
const GEMINI_LIVE_VOICE_NAMES = new Set([
  // Original 8 (shared with Chirp HD catalog)
  'Aoede', 'Kore', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus',
  // Additional Gemini Live–only voices
  'Achernar', 'Autonoe', 'Callirrhoe', 'Despina', 'Erinome', 'Laomedeia',
  'Pulcherrima', 'Sulafat', 'Vindemiatrix',
  'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Enceladus', 'Gacrux',
  'Iapetus', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Umbriel', 'Zubenelgenubi',
]);

/**
 * Scan Daniela's output transcript for any previously-taught vocab word.
 * Returns the first match found, or null if none.
 * Words in `skipKeys` (added this turn) are excluded — they just had a full card shown.
 */
function findTaughtWordMention(
  text: string,
  taughtVocab: Map<string, { word: string; imageUrl: string; meaning?: string }>,
  skipKeys?: Set<string>,
): { word: string; imageUrl: string } | null {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  for (const [key, entry] of taughtVocab) {
    if (skipKeys?.has(key)) continue;
    // Match the full word phrase (e.g. "el tiempo") or the word without its article
    const wordLower = entry.word.toLowerCase();
    const wordNoArticle = wordLower.replace(/^(el|la|los|las|le|les|der|die|das|il|lo|os|as|o|a)\s+/, '');
    const candidates = wordNoArticle !== wordLower ? [wordLower, wordNoArticle] : [wordLower];
    for (const candidate of candidates) {
      if (lowerText.includes(candidate)) {
        return { word: entry.word, imageUrl: entry.imageUrl };
      }
    }
  }
  return null;
}

/**
 * Maps a student's ACTFL proficiency level to the appropriate VAD silence
 * cutoff duration. Beginners need more time to search for words; advanced
 * speakers find long silences unnatural. Paired with the 1200ms patience
 * indicator on the client so no level ever feels frozen.
 *
 * Scale reference (from discovery consult July 2026):
 *   novice        → 5000ms   (A1 equivalent — every word is a search)
 *   intermediate  → 3000ms   (B1 equivalent — current baseline)
 *   advanced      → 2500ms   (C1 equivalent — fluent pacing)
 *   superior+     → 2000ms   (C2+ — conversation feels natural at this speed)
 */
function actflSilenceDurationMs(actflLevel?: string | null): number {
  // 2026-07-10: Live controlled test with David showed premature cutoff on a
  // mid-sentence pause even at what should be the most patient tier. Root cause
  // not yet fully isolated (may be ordering of studentActflLevel assignment vs
  // GL session construction, or GL simply firing before this threshold in
  // practice). Bumping all tiers up ~1000ms as an immediate mitigation while
  // the ordering question is investigated further. See docs/open-bugs.md.
  switch (actflLevel?.toLowerCase()) {
    case 'novice_low':
    case 'novice_mid':
      return 6000;
    case 'novice_high':
    case 'intermediate_low':
      return 5000;
    case 'intermediate_mid':
    case 'intermediate_high':
      return 4000;
    case 'advanced_low':
    case 'advanced_mid':
    case 'advanced_high':
      return 3200;
    case 'superior':
    case 'distinguished':
      return 2600;
    default:
      return 5000; // unassessed students are likely beginners — err on the side of patience
  }
}

/**
 * Observer Seat — builds a compact snapshot of what is currently visible on the student's
 * screen. Injected into every tool-response batch so Daniela has continuous awareness of
 * the visual context even between tool calls.
 */
function buildInterfaceStateSnapshot(session: StreamingSession): string {
  const parts: string[] = [];

  // Vocab grid — check visionBuffer for array type (vocab_grid key)
  const vocabGrid = session.visionBuffer?.['vocab_grid'];
  if (Array.isArray(vocabGrid) && vocabGrid.length > 0) {
    const words = (vocabGrid as Array<{ word: string; translation: string }>)
      .map(v => `${v.word} (${v.translation})`)
      .join(', ');
    parts.push(`vocab grid: ${words}`);
  }

  // Scene — prefer add_to_scene (latest state) then open_scene
  const sceneEntry = session.visionBuffer?.['add_to_scene'] ?? session.visionBuffer?.['open_scene'];
  if (sceneEntry && !Array.isArray(sceneEntry)) {
    const sceneText = (sceneEntry as { sceneStateText?: string; description?: string }).sceneStateText;
    if (sceneText) {
      // sceneStateText is multi-line — grab the "Scene: X" line and the prop count
      const sceneLine = sceneText.split('\n').find(l => l.startsWith('Scene:'));
      const propLine  = sceneText.split('\n').find(l => /Props on canvas/.test(l));
      const summary   = [sceneLine, propLine].filter(Boolean).join(', ');
      if (summary) parts.push(summary);
    }
  }

  // Textbook page
  if (session.textbookPageResult) {
    parts.push('lesson page open');
  }

  if (parts.length === 0) return '';
  return `Student's screen: ${parts.join(' | ')}`;
}

// Tools where Daniela may speak an acknowledgment BEFORE calling the tool
// (latency-heavy: search, memory, archive). When pre-tool audio is present
// and ALL tools in the batch are in this set, parallel speech is preserved
// instead of resetting client audio. Immediate UI tools (show_vocab_card,
// play_audio, show_image, etc.) are intentionally excluded — they need the
// audio/action pair to stay tightly coupled.
const PARALLEL_SPEECH_TOOLS = new Set([
  'search_my_archive',
  'search_conversations',
  'search_conversation_threads',
  'memory_lookup',
  'unified_recall',
  'search_express_lane',
  'introspect',
  'memory_review',
  'find_teaching_tool',
  'search_learner_history',
]);

export class GeminiLiveSession {
  private liveSession: Session | null = null;
  private fcHandler: NativeFunctionCallHandler;
  private currentTurnId = 0;
  /** Total completed conversation exchanges (user speaks → Daniela responds) this session. */
  private completedExchanges = 0;
  /** Last student-turn epoch included in completedExchanges. Keeps generationComplete,
   * its watchdog fallback, and tool-continuation generations idempotent. */
  private lastCountedStudentTurnEpoch = 0;
  /** Cumulative length of all Daniela output transcripts — used as TTS char proxy for billing. */
  private totalOutputCharacters = 0;
  /** Frames forwarded via sendVideoFrame() — used for burn-report vision cost estimate. */
  private videoFramesSent = 0;

  // ── Session-level speaking & latency metrics ────────────────────────────
  // These are accumulated per-turn and exposed at session end for billing/telemetry.
  /** Accumulated student speaking time in ms (from first inputTranscription → first Daniela audio). */
  private studentSpeakingMs = 0;
  /** Accumulated tutor speaking time in ms (from first audio chunk → generationComplete). */
  private tutorSpeakingMs = 0;
  /** Per-turn latencies in ms: time from processing_pending → first audio chunk. */
  private turnLatencies: number[] = [];
  /** Timestamp (Date.now()) when the current turn's processing_pending was fired. */
  private turnLatencyStartTime: number | null = null;
  /** Timestamp (Date.now()) when Daniela's first audio chunk arrived for the current turn. */
  private tutorSpeakingStartTime: number | null = null;
  /** Timestamp (Date.now()) when the first inputTranscription arrived for the current user turn. */
  private studentSpeakingStartTime: number | null = null;
  /** Timestamp (Date.now()) of the LAST inputTranscription chunk — used for latency: last word → first audio. */
  private lastInputTranscriptionTime: number | null = null;
  // Each Gemini sub-turn (one turnComplete) maps to one "sentence" in the progressive PCM player.
  // sentenceIndex must increment per sub-turn so the player queues them sequentially instead of
  // overwriting earlier chunks with chunkIndex:0 from a later sub-turn.
  private currentSentenceIndex = 0;
  private currentChunkIndex = 0;       // Resets to 0 at each new sentenceIndex boundary
  private lastSentenceStartSentIndex = -1;  // Tracks which sentenceIndex has had sentence_start emitted
  private karaokeTracker: GLKaraokeTracker | null = null;
  private hadAudioInCurrentSubturn = false;
  private lastAudioChunkAt = 0;             // Wall-clock ms of most recent audio chunk — gates ghost-transcription suppression
  /** Snapshot of pendingOutputTranscript at the moment a tool call fires, when parallel speech is
   *  active (tool is latency-heavy AND transcript has ≥3 words). Injected into the tool response
   *  as a "don't re-speak" whisper so GL continues from after the acknowledgment. Null when the
   *  standard gl_audio_reset path was taken instead. */
  private preTurnTextForWhisper: string | null = null;
  private transcriptClosed = false;         // Set on generationComplete/interrupted/turnComplete — discard outputTranscription after this
  private firstAudioSentThisTurn = false;   // Guard: don't send processing_pending AFTER audio already started
  private generationStartedThisTurn = false; // Guard: set on first modelTurn serverContent (GL started generating)
  private sessionStartedAt = 0;             // Wall-clock ms when start() was called (for establishment latency)
  private processingPendingSentThisTurn = false; // Guard: send processing_pending exactly once per conversation turn
  private isStopped = false;
  private isStarted = false;
  private isSetupComplete = false;
  // ── Silence-triggered heartbeat (Feature B) ─────────────────────────────
  // When the pedagogical supervisor emits a directive at generationComplete
  // (via thought-based analysis) but the student stops talking — there are no
  // tool calls to ride the directive to Daniela.  The heartbeat interval polls
  // every 5 s: if a directive is pending AND ≥15 s of silence has elapsed since
  // the last generationComplete, it injects the directive via sendClientContent
  // as a [SYSTEM] tagged user turn (Daniela recognises the bracket prefix and
  // does not speak it verbatim — same convention as the system whisper channel).
  private pendingDirectiveText: string | null = null;
  private pendingDirectiveUrgency: 'emergency' | 'nudge' = 'nudge';
  private lastGenerationCompleteTime = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pendingGreetingTrigger: string | null = null;
  private pendingGreetingSilent = false; // true = prime audio on setupComplete but don't speak
  private pendingGreetingInternalRetry = false;
  // ONE-SHOT GREETING GUARD (triple-repeat greeting fix, Aug 2026): once a greeting trigger
  // has been dispatched (spoken, buffered, or silent-prime) for this GL session, every further
  // external sendGreetingTrigger call is BLOCKED. Three retry paths (client 8s timer, client
  // fast-retry on empty turn, server silent-greeting auto-retry) could each re-fire the greeting;
  // greetingPhaseActive clears at first audio/turnComplete so late retries slipped past it and
  // produced the triple-repeat greeting (third repeat: transcript flushes but audio suppressed
  // by hasStudentInputSinceLastResponse). Only the internal silent-greeting auto-retry — which
  // has verified NO audio was produced — may bypass via opts.internalRetry.
  private greetingTriggerFired = false;
  private greetingDelivery = new GreetingDeliveryState(3);
  private identityThreads: Array<{ title: string; content: string }> = [];
  /** Accumulates thought Part text during a model turn (includeThoughts:true). Flushed to
   *  the pedagogical supervisor at generationComplete, then cleared. Never sent to client. */
  private currentTurnThoughtBuffer = '';
  /** Token proxy estimated from thought buffer char length (chars÷4). Captured
   *  just before the buffer is cleared at generationComplete; read by the
   *  friction signal which runs after the clear. Null if no thought parts arrived. */
  private _currentTurnThoughtTokenProxy: number | null = null;
  /** Raw thought content from this turn — captured before buffer clear at generationComplete,
   *  persisted alongside the assistant message so Daniela can read her own past thinking. */
  private _currentTurnThoughtContent: string | null = null;

  // ── Mic gate: blocks echo during ALL Daniela audio generation ────────────
  // When open-mic mode is active, the client streams audio continuously.
  // If mic audio reaches GL while Daniela is speaking, GL's VAD detects the
  // echo through the speaker as "user speaking" and either interrupts itself
  // or produces a zero-sentence response to the echo (alternating silence bug).
  //
  // greetingPhaseActive: gates mic from session start until Daniela's first audio chunk.
  // isTutorGeneratingAudio: gates mic for ALL subsequent Daniela turns.
  // Together these cover the full echo suppression lifecycle.
  private greetingPhaseActive = false;
  // isGreetingTurn: true for the ENTIRE greeting generation turn — from sendGreetingTrigger
  // until generationComplete or interrupted. Unlike greetingPhaseActive (which clears at first
  // audio chunk), this flag stays live so tool calls that fire mid-greeting (after Daniela has
  // already spoken a few words) can still suppress gl_audio_reset. Without this flag the
  // standard pre-tool gl_audio_reset would kill the rest of the greeting audio.
  private isGreetingTurn = false;
  // Greeting auto-retry: stores params so a silent greeting turn can re-trigger (max 2 retries).
  private greetingRetryTimer: NodeJS.Timeout | null = null;
  private lastGreetingParams: { userName?: string; isResumed?: boolean; scenarioSlug?: string; recentContext?: string; studentProfile?: string } | null = null;
  // System Whisper (Gemini audit 2026-06-17 rec): tracks completed non-greeting turns so a
  // brief specificity reminder can be prepended to PTT turns at regular intervals.
  // GL has no mid-session system injection, so the PTT text path is the only safe injection point.
  private conversationTurnCount = 0;
  private turnsSinceLastWhisper = 0;
  private lastWhisperTime = 0; // ms — wall clock when whisper last fired; 0 = not yet fired
  private pendingSystemWhisper = false; // Gemini audit fix: inject via tool response, not student speech
  // Post-turn auto-grounding whisper — set by Frictionless Slide detection after Daniela's turn completes.
  // It is only eligible while the student turn that caused it remains active.
  private pendingWeeOoGrounding: string | null = null;
  private pendingWeeOoGroundingBinding: GroundingTurnBinding | null = null;
  // Dormant prior-turn correction for Turn N -> Turn N+1 only. It stays silent on
  // subject changes and releases only when Turn N+1 explicitly reopens the
  // Turn N candidate assertion.
  private pendingPriorTurnGrounding: PriorTurnGroundingCorrection | null = null;
  private pendingPriorTurnGroundingAttemptId: string | null = null;
  // Set when pendingWeeOoGrounding originates from slide detection or hard wall (not ambient
  // pre-turn grounding). Causes the [LAST TURN CORRECTION] whisper to include a behavioral
  // directive: "verify before continuing" rather than just passive context delivery.
  private slideCorrectionQueued = false;
  // Pre-turn Archive Guardian — fired when student's speech contains a memory-risk phrase.
  // The DB lookup runs async while GL processes the utterance; by the time the first tool call
  // fires, the result is ready. Injected THIS turn — before Daniela generates her response.
  private preTurnGroundingFired = false;     // prevents re-fire within the same student turn
  private preTurnGroundingResult: string | null = null;  // filled by .then() — sync check at injection
  private preTurnGroundingPromise: Promise<string> | null = null; // stored for await-race in tool handler
  private preTurnGroundingBinding: GroundingTurnBinding | null = null;
  private preTurnGroundingAttemptId: string | null = null;
  /** Immutable lineage nodes for the current pre-turn lookup. */
  private preTurnGuardianLineageEventId: string | null = null;
  private preTurnGroundingLineageEventId: string | null = null;
  // Set to true when the pre-turn scan detected emotional valence (vulnerability/self-doubt/
  // embarrassment) rather than just a memory-risk phrase. Changes the [ARCHIVE GUARDIAN]
  // injection label so Daniela understands SHE IS BEING GIVEN RELATIONAL HISTORY, not facts.
  private preTurnGroundingIsEmotional = false;
  private preTurnIsNamedRecord = false;   // true when utterance contains a Named Record phrase
  // Late-arrival carry-forward: if the 150ms fallback fires while Daniela is already generating,
  // the grounding is stored here instead of interrupting her. Injected at the START of the next
  // student turn (student is still speaking — GL not generating yet — safe injection window).
  private pendingCarryForwardGrounding: string | null = null;
  private pendingCarryForwardGroundingBinding: GroundingTurnBinding | null = null;
  private pendingCarryForwardGroundingAttemptId: string | null = null;
  private pendingWeeOoGroundingAttemptId: string | null = null;
  /** Increments at the first input-transcription chunk of each student utterance. */
  private activeStudentTurnEpoch = 0;
  /** Complete transcript accumulated for the active student-turn epoch. */
  private activeStudentUtterance = '';
  /** Highest student-turn epoch whose inputTranscription has emitted finished: true. */
  private finalizedStudentTurnEpoch = 0;
  /** FIFO of student-turn epochs awaiting Gemini inputTranscription.finished. */
  private unfinalizedStudentTurnEpochs: number[] = [];
  /**
   * True when the next inputTranscription chunk starts a new student turn.
   * Initialized true for Turn 1 and re-armed when Daniela's audio playback ends
   * and the microphone gate opens for the student's next utterance.
   */
  private startNewStudentTurnOnNextInputTranscription = true;
  /**
   * Whether activeStudentTurnEpoch was opened after all prior inputTranscription
   * epochs had finalized. When false, finished:true ordering is ambiguous and
   * dormant prior-turn grounding must stay withheld rather than risk misbinding.
   */
  private currentStudentTurnBoundaryTrusted = true;
  private nextStudentTurnBoundaryTrusted = true;
  private inputTranscriptionFinalizationWaiters: Array<{
    expectedEpoch: number;
    resolve: (finalized: boolean) => void;
    timer: NodeJS.Timeout;
  }> = [];
  /** One immutable lineage trace per student utterance when diagnostic capture is enabled. */
  private activeContextLineageTraceId: string | null = null;
  private activeStudentTurnLineageEventId: string | null = null;
  /** Latest actual Gemini callback in the active trace; never a caller-supplied receipt. */
  private activeContextLineageStreamProxyEventId: string | null = null;
  private contextLineageRecorder: ContextLineageRecorder | null = null;
  private hardWallTriggered = false;   // set mid-output if slide detected; cleared at generationComplete
  // ── Archive Guardian A/B channel ────────────────────────────────────────────
  // Reads from global config live so mid-session swaps (POST /api/admin/guardian/channel)
  // take effect immediately without requiring a reconnect.
  // Per-session override: set _guardianChannelOverride to lock a specific channel.
  //   'concat'    — (default) inject via string-concat onto last tool response body
  //   'dedicated' — send as own sendClientContent turn (no turnComplete)
  private _guardianChannelOverride: 'concat' | 'dedicated' | null = null;
  get guardianChannel(): 'concat' | 'dedicated' { return this._guardianChannelOverride ?? _globalGuardianChannel; }
  set guardianChannel(ch: 'concat' | 'dedicated') { this._guardianChannelOverride = ch; }
  // ── Archive Guardian fire log ───────────────────────────────────────────────
  // Tracks every Guardian fire this session — path, phrase, chars injected,
  // channel used, and outcome (heard = Archive tool called next turn;
  // missed = same slide re-fired before any Archive access).
  guardianFireLog: Array<{
    ts: string;
    path: 'pre-turn' | 'post-turn-phrase' | 'friction-signal' | 'hard-wall' | 'carry-forward-buffered' | 'carry-forward-injected';
    phrase: string;
    charsInjected: number | null;
    channel: 'concat' | 'dedicated' | 'pre-turn-sendclientcontent' | null;
    outcome: 'heard' | 'missed' | null;
    groundingPreview: string | null;   // first 150 chars of what was actually injected
    /** Present only when this legacy row corresponds to an evidence-chain attempt. */
    attemptId?: string;
    /** UUID of the voice_pipeline_events row, set at insert time so we can UPDATE outcome later. */
    dbEventId?: string;
    /** Promise for the in-flight INSERT — outcome UPDATE must chain off this to avoid
     *  a race where UPDATE runs before the INSERT commits and silently no-ops. */
    _insertPromise?: Promise<void>;
  }> = [];
  /** Evidence chain for each Guardian lookup. Unlike guardianFireLog, this is not heuristic. */
  private guardianAttempts: GuardianAttemptTrace[] = [];
  /** Tracks how many guardianFireLog entries have already been persisted to voice_pipeline_events. */
  private _guardianLoggedCount = 0;
  /** Monotonic order for incoming Gemini function-call batches. */
  private toolCallBatchSequence = 0;

  /**
   * The canonical lineage ledger is a shadow writer: enabled diagnostics allocate
   * local IDs synchronously but every database write remains off the Live path.
   * It must never alter a Gemini request, prompt, tool body, or delivery timing.
   */
  private _getContextLineageRecorder(): ContextLineageRecorder | null {
    if (process.env.CONTEXT_LINEAGE_LEDGER_ENABLED !== 'true') return null;
    if (this.contextLineageRecorder) return this.contextLineageRecorder;

    const conversationId = (this.session as any).conversationId as string | undefined;
    const userId = this.session.userId ? String(this.session.userId) : undefined;
    this.contextLineageRecorder = new ContextLineageRecorder(
      {
        sessionId: this.session.dbSessionId ?? this.session.id,
        conversationId,
        userId,
      },
      {
        sink: createDatabaseContextLineageSink(),
        onHealthChange: health => observeContextLineageHealth(conversationId, health),
      },
    );
    return this.contextLineageRecorder;
  }

  private _recordContextLineage(input: ContextLineageEventInput): string | null {
    const recorder = this._getContextLineageRecorder();
    if (!recorder) return null;
    const event = recorder.recordEvent({
      ...input,
      traceId: input.traceId ?? this.activeContextLineageTraceId ?? undefined,
      studentTurnEpoch: input.studentTurnEpoch ?? this.activeStudentTurnEpoch,
    });
    observeContextLineageEvent((this.session as any).conversationId, {
      id: event.id,
      traceId: event.traceId,
      sequenceNumber: event.sequenceNumber,
      sourceRoute: event.sourceRoute,
      eventType: event.eventType,
      deliveryChannel: event.deliveryChannel ?? null,
      deliveryStatus: event.deliveryStatus ?? 'observed',
      studentTurnEpoch: event.studentTurnEpoch ?? null,
      payloadSha256: event.payloadSha256 ?? null,
      observedAt: event.observedAt.toISOString(),
    });
    return event.id;
  }

  private _linkContextLineage(input: ContextLineageLinkInput): void {
    const recorder = this._getContextLineageRecorder();
    if (!recorder) return;
    const link = recorder.recordLink(input);
    observeContextLineageLink((this.session as any).conversationId, {
      id: link.id,
      traceId: link.traceId,
      fromEventId: link.fromEventId,
      toEventId: link.toEventId,
      linkType: link.linkType,
      observedAt: link.observedAt.toISOString(),
    });
  }

  private waitForInputTranscriptionFinalization(expectedEpoch: number, timeoutMs = 150): Promise<boolean> {
    if (this.finalizedStudentTurnEpoch >= expectedEpoch) {
      return Promise.resolve(this.finalizedStudentTurnEpoch === expectedEpoch);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        expectedEpoch,
        resolve,
        timer: setTimeout(() => {
          const idx = this.inputTranscriptionFinalizationWaiters.indexOf(waiter);
          if (idx >= 0) this.inputTranscriptionFinalizationWaiters.splice(idx, 1);
          resolve(false);
        }, timeoutMs),
      };
      this.inputTranscriptionFinalizationWaiters.push(waiter);
    });
  }

  private resetInputTranscriptionFinalizationState(): void {
    this.unfinalizedStudentTurnEpochs = [];
    this.startNewStudentTurnOnNextInputTranscription = true;
    this.currentStudentTurnBoundaryTrusted = true;
    this.nextStudentTurnBoundaryTrusted = true;
    for (const waiter of this.inputTranscriptionFinalizationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  /**
   * Record a real callback from Gemini Live. This records transport observation,
   * not receipt or model use. The ID can support a later, same-trace direct-send
   * attempt, but cannot turn that attempt into a delivery acknowledgement.
   */
  private _recordFactualStreamCallback(
    kind: string,
    payloadText?: string,
    payloadJson?: Record<string, unknown>,
  ): string | null {
    const eventId = this._recordContextLineage({
      sourceRoute: 'gemini-live-server',
      eventType: 'stream_event_observed',
      payloadText: payloadText ?? null,
      payloadJson: { kind, ...(payloadJson ?? {}) },
      deliveryStatus: 'observed',
    });
    if (!eventId) return null;
    this.activeContextLineageStreamProxyEventId = eventId;
    if (
      this.activeStudentTurnLineageEventId
      && this.activeStudentTurnLineageEventId !== eventId
      && this.activeContextLineageTraceId
    ) {
      this._linkContextLineage({
        traceId: this.activeContextLineageTraceId,
        fromEventId: this.activeStudentTurnLineageEventId,
        toEventId: eventId,
        linkType: 'produced_response',
      });
    }
    return eventId;
  }

  /**
   * A direct SDK call proves only that this process attempted dispatch. If an
   * earlier callback exists in the same trace, the recorder may name it as a
   * factual transport observation; it never claims Gemini received or used text.
   */
  private _recordDirectLineageAttempt(input: ContextLineageEventInput): string | null {
    const traceId = input.traceId ?? this.activeContextLineageTraceId ?? undefined;
    const streamProxyEventId = traceId && traceId === this.activeContextLineageTraceId
      ? this.activeContextLineageStreamProxyEventId
      : null;
    return this._recordContextLineage({
      ...input,
      traceId,
      payloadJson: {
        ...(input.payloadJson ?? {}),
        ...(streamProxyEventId ? { streamProxy: { eventId: streamProxyEventId } } : {}),
      },
    });
  }

  /** Push current guardian state to the observation store so Luca's observe endpoint reflects it live.
   *  Also persists any new fire-log entries to voice_pipeline_events immediately so they survive
   *  session crashes — does not wait for stop() to flush. */
  private _observeGuardian(): void {
    const conversationId = (this.session as any).conversationId as string | undefined;
    if (!conversationId) return;
    observeGuardianState(conversationId, this.guardianChannel, this.guardianFireLog, this.guardianAttempts);

    // Persist any newly appended entries to voice_pipeline_events in real-time.
    const newEntries = this.guardianFireLog.slice(this._guardianLoggedCount);
    if (!newEntries.length) return;
    this._guardianLoggedCount = this.guardianFireLog.length;

    // Prefer the DB-backed UUID (dbSessionId) so voice_pipeline_events.session_id
    // is joinable to voice_sessions.id.  Fall back to the streaming ID only when
    // dbSessionId has not yet been assigned (very early in session startup).
    const sessionId = this.session.dbSessionId ?? this.session.id;
    const userId = this.session.userId ? String(this.session.userId) : null;
    for (const entry of newEntries) {
      // Pre-generate the DB UUID so we can UPDATE this row when outcome resolves later.
      const eventId = randomUUID();
      entry.dbEventId = eventId;
      const payload = JSON.stringify({ ...entry, conversationId });
      // Retain the insert promise so _persistGuardianOutcome() can chain the UPDATE
      // after the INSERT commits — preventing the race where UPDATE runs first and
      // silently no-ops, leaving the row permanently outcome: null.
      entry._insertPromise = getSharedDb().execute(sql`
        INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
        VALUES (${eventId}, ${sessionId}, ${userId}, 'gl_guardian_fire', ${payload}::jsonb, NOW())
      `).then(() => {}).catch(() => {});
    }
  }

  /** UPDATE the voice_pipeline_events row for a guardian fire once outcome resolves.
   *  Called immediately after outcome is set to 'heard' or 'missed' in-memory.
   *
   *  Chains the UPDATE after the entry's INSERT promise so the row is guaranteed
   *  to exist before we attempt to merge the outcome field — eliminating the race
   *  where an outcome that resolves quickly (e.g. on the same turn) would UPDATE
   *  before the INSERT commits and be silently swallowed. */
  private _persistGuardianOutcome(entry: (typeof this.guardianFireLog)[number]): void {
    if (!entry.dbEventId || !entry.outcome) return;
    const { outcome, dbEventId } = entry;
    // Chain after the insert promise (or immediately if already settled).
    const base = entry._insertPromise ?? Promise.resolve();
    base.then(() => {
      // Merge outcome into the stored JSON payload via PostgreSQL jsonb concatenation.
      return getSharedDb().execute(sql`
        UPDATE voice_pipeline_events
        SET event_data = event_data || ${JSON.stringify({ outcome })}::jsonb
        WHERE id = ${dbEventId}
      `);
    }).catch(() => {});
  }

  private _startGuardianAttempt(
    path: GuardianAttemptPath,
    binding: GroundingTurnBinding,
  ): string {
    const attempt = createGuardianAttempt({
      path,
      studentTurnEpoch: binding.studentTurnEpoch,
      studentUtterance: binding.studentUtterance,
      candidateAssertion: binding.candidateAssertion,
    });
    this.guardianAttempts.push(attempt);
    this._persistGuardianTrace(attempt, attempt.events[0]);
    this._observeGuardian();
    return attempt.attemptId;
  }

  private _traceGuardianAttempt(
    attemptId: string | null,
    event: Omit<GuardianTraceEvent, 'ts'>,
  ): void {
    if (!attemptId) return;
    const attempt = this.guardianAttempts.find(candidate => candidate.attemptId === attemptId);
    if (!attempt || attempt.terminalOutcome) return;
    const recorded = appendGuardianTraceEvent(attempt, event);
    if (event.type === 'lookup_failed' || event.type === 'stale_discarded' || event.type === 'superseded') {
      attempt.terminalOutcome = resolveGuardianTerminalOutcome(attempt);
    }
    this._persistGuardianTrace(attempt, recorded);
    this._observeGuardian();
  }

  /** The tool-response queue has one slot; never silently orphan its prior attempt. */
  private _replacePendingWeeOoGrounding(
    text: string,
    binding: GroundingTurnBinding,
    attemptId: string,
    detail: string,
  ): void {
    const displacedAttemptId = this.pendingWeeOoGroundingAttemptId;
    if (this.pendingWeeOoGrounding && displacedAttemptId && displacedAttemptId !== attemptId) {
      this._traceGuardianAttempt(displacedAttemptId, {
        type: 'superseded',
        detail,
      });
    }
    this.pendingWeeOoGrounding = text;
    this.pendingWeeOoGroundingBinding = binding;
    this.pendingWeeOoGroundingAttemptId = attemptId;
  }

  private _persistGuardianTrace(attempt: GuardianAttemptTrace, event: GuardianTraceEvent): void {
    const conversationId = (this.session as any).conversationId as string | undefined;
    voiceTelemetry.log(
      this.session.dbSessionId ?? this.session.id,
      String(this.session.userId ?? ''),
      'gl_guardian_trace',
      {
        attemptId: attempt.attemptId,
        path: attempt.path,
        studentTurnEpoch: attempt.studentTurnEpoch,
        studentUtterance: attempt.studentUtterance,
        candidateAssertion: attempt.candidateAssertion,
        terminalOutcome: attempt.terminalOutcome,
        conversationId,
        event,
      },
    );
  }

  private _finalizeGuardianAttemptsForTurn(): void {
    for (const attempt of this.guardianAttempts) {
      const wasDeliveredThisModelTurn = attempt.events.some(
        event => event.modelTurnId === this.currentTurnId
          && (event.type === 'tool_response_sent' || event.channel === 'send-client-content'),
      );
      const lookupHasResolved = attempt.events.some(
        event => event.type === 'lookup_completed' || event.type === 'queued',
      );
      const isCurrentPreTurnAttempt = attempt.path === 'pre-turn'
        && attempt.studentTurnEpoch === this.activeStudentTurnEpoch
        && lookupHasResolved;
      if (attempt.terminalOutcome || (!wasDeliveredThisModelTurn && !isCurrentPreTurnAttempt)) continue;
      finalizeGuardianAttempt(attempt, this.currentTurnId);
      this._persistGuardianTrace(attempt, attempt.events[attempt.events.length - 1]);
    }
    this._observeGuardian();
  }

  private _finalizeOutstandingGuardianAttempts(reason: string): void {
    for (const attempt of this.guardianAttempts) {
      if (attempt.terminalOutcome) continue;
      const event = appendGuardianTraceEvent(attempt, {
        type: 'generation_interrupted',
        modelTurnId: this.currentTurnId,
        detail: reason,
      });
      attempt.terminalOutcome = resolveGuardianTerminalOutcome(attempt);
      this._persistGuardianTrace(attempt, event);
    }
    this._observeGuardian();
  }

  private _linkRelatedArchiveCalls(toolNames: string[], toolBatchSequence: number): void {
    const archiveTools = new Set([
      'grounding_query',
      'introspect',
      'recall',
      'unified_recall',
      'search_my_archive',
      'search_conversations',
      'search_conversation_threads',
      'memory_lookup',
      'memory_review',
    ]);
    const archiveTool = toolNames.find(toolName => archiveTools.has(toolName));
    if (!archiveTool) return;
    const candidate = selectGuardianArchiveCandidate(
      this.guardianAttempts,
      this.activeStudentTurnEpoch,
      toolBatchSequence,
    );
    if (!candidate) return;
    this._traceGuardianAttempt(candidate.attemptId, {
      type: 'archive_call_linked',
      archiveTool,
      modelTurnId: this.currentTurnId,
      toolBatchSequence,
    });
  }

  private static readonly WHISPER_INTERVAL = 8;
  private static readonly WHISPER_MIN_INTERVAL_MS = 5 * 60 * 1000; // hybrid floor: 5 min
  // ── Student Friction Score ─────────────────────────────────────────────────
  // Lightweight in-session signals derived from inputTranscription timing + word count.
  // No external API needed. Injected into the Gap B system whisper so Daniela can
  // auto-adjust CEFR level and pacing without being told explicitly.
  private studentTurnStartMs = 0;          // wall clock when generationComplete fires (mic opens)
  private currentTurnFirstInputMs = 0;     // wall clock of first inputTranscription in current turn
  private currentTurnInputWords = 0;       // word count accumulating for current student turn
  private recentPreSpeechPauses: number[] = [];  // rolling last 3 pre-speech pause durations (ms)
  private recentTurnWordCounts: number[] = [];   // rolling last 3 student turn word counts
  private lastInputChunkMs = 0;                  // wall clock of last inputTranscription chunk (internal silence detection)
  private currentTurnMidPauses = 0;              // count of mid-sentence pauses > 2s detected in current student turn
  private recentMidPauseCounts: number[] = [];   // rolling last 3 mid-turn pause counts
  private static readonly FRICTION_WINDOW = 3;
  // Instructional Piggybacking — counts student turns for SESSION ANCHOR injection cadence.
  // Every SESSION_ANCHOR_INTERVAL turns, the approved anchor prose is folded inside the
  // ARCHIVE GUARDIAN bracket (position N in the context window — highest attention weight).
  private sessionStudentTurnCount = 0;
  private static readonly SESSION_ANCHOR_INTERVAL = 10;
  // DOUBLE-AUDIO FIX: After a GL internal reconnect that interrupted mid-turn audio,
  // the client is sent gl_audio_reset (which calls player.stop() + resetForNewTurn()).
  // The next first-audio processing_pending is suppressed since the client already
  // reset — sending it again would clear the new audio's dedup state prematurely.
  private suppressNextProcessingPending = false;
  // Bug 1 fix: gate audio chunks that arrive after generationComplete (GL tail sub-turn).
  // Set to true on generationComplete; cleared when the NEXT response starts generating audio.
  private afterGenerationComplete = false;
  // True once generationComplete (or the watchdog seal) has fired for the current turn.
  // onPlaybackEnded() checks this before lifting the mic gate so that inter-sentence
  // idle gaps (player momentarily going idle between sub-turns) don't prematurely open
  // the mic and let GL's VAD mistake ambient audio for student speech, interrupting itself.
  private isGenerationDone = false;
  // Latch: set when playback_ended fires while isGenerationDone is still false (between
  // sub-turns). When isGenerationDone becomes true (generationComplete or watchdog), we
  // call onPlaybackEnded() retroactively so single-sentence responses still lift the gate.
  private pendingPlaybackEndedLift = false;
  private isTutorGeneratingAudio = false;
  // Double-generation guard: true only after confirmed student audio arrives at GL;
  // Initialized true so the greeting always passes the guard. Reset to false only after
  // greetingPhaseActive is done, so GL multi-chunk greetings are never suppressed.
  // Prevents spurious second GL generation (unmasked by Bug 1 gate removal July 24 2026).
  private hasStudentInputSinceLastResponse = true;
  // Ghost-turn tracing: records the most recent mid-session sendClientContent injection
  // (text turn, heartbeat directive, pre-turn guardian, etc.). When a ghost turn is
  // suppressed in _doFlushTranscripts, this identifies WHICH injection triggered the
  // spurious GL generation cycle — pinning the root cause in logs + telemetry.
  private lastClientContentInjection: { label: string; at: number } | null = null;
  // Double-generation guard — part 2: tracks whether response_complete has already been
  // flushed to the client for the current turn. Once flushed, any new GL audio arriving
  // without new student input is definitively spurious (covers the case where the second
  // generation starts while isTutorGeneratingAudio is still true, so the part-1 guard
  // can't fire). Reset to false when a genuine new generation begins.
  private responseFlushedToClient = false;
  // Tool Call Deadlock fix: track function call IDs that were in-flight when the connection
  // dropped. On reconnect with a resumption handle, GL resumes in "waiting for tool response"
  // state — we send synthetic error responses to unblock it before the session hangs silently.
  private pendingFunctionCallIds: string[] = [];
  private currentTurnToolCalls: string[] = []; // Frictionless Slide: track tool names per GL turn
  // Safety timeout: force-opens the mic gate if onPlaybackEnded() never arrives
  // (e.g., the client disconnects mid-playback or the telemetry event is dropped).
  private playbackGateSafetyTimeout: ReturnType<typeof setTimeout> | null = null;
  // Safety timeout: force-clears greetingPhaseActive if the greeting produces no audio
  // (content filter, text-only response, error) so the mic doesn't stay permanently blocked.
  // 15s is generous — greeting audio typically arrives within 1-2s.
  private greetingWatchdogTimer: NodeJS.Timeout | null = null;
  // generationComplete watchdog: if Gemini stops sending audio chunks but never fires
  // generationComplete (a known GL API transient failure), this timer fires ~6s after
  // the last audio chunk and executes the same sealing logic, preventing a deaf session.
  private generationCompleteWatchdogTimer: NodeJS.Timeout | null = null;
  // thoughtOnlyStall watchdog: GL sometimes sends only { thought: true } parts
  // (extended reasoning) and then goes silent without ever producing audio/text
  // or firing turnComplete. The generationComplete watchdog above never catches
  // this because it only arms on audio chunks. This timer arms when a thought
  // part arrives with no audio yet in the current turn, and fires ~10s later if
  // still nothing has arrived — sealing the stalled turn so the session doesn't
  // hang until the idle/grace-period reaper kills the whole session.
  private thoughtOnlyStallWatchdogTimer: NodeJS.Timeout | null = null;
  // Debounced seal timer for generationComplete. GL sometimes fires generationComplete
  // while audio chunks are still in-flight (network buffer). Immediately sealing with
  // isLast:true cuts off the trailing audio ("What's", "That's"). Instead we wait 200ms
  // for any remaining chunks to arrive, resetting the timer on each new chunk, then seal.
  private generationCompleteSealTimer: NodeJS.Timeout | null = null;

  // ── Auto-reconnect ─────────────────────────────────────────────────────────
  // When the GL WebSocket closes unexpectedly (1011 internal error, 1006 network
  // drop, etc.) we transparently reconnect so the student doesn't have to reload.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_RECONNECT_ATTEMPTS = 3;
  // Close codes we consider transient/retriable (not policy violations or intentional closes).
  // 1011 is intentionally excluded: it covers both quota exhaustion and Gemini internal errors.
  // Both cases are non-retriable — retrying immediately with a large system prompt just burns
  // more quota. Quota is handled explicitly above; other 1011s bail with a clear error.
  private readonly RETRIABLE_CLOSE_CODES = new Set([
    1006,  // Abnormal closure — no close frame (network drop)
    1008,  // GoAway / session duration limit reached — Gemini sends this when the session
           // hits its maximum duration. Transparent reconnect restores the session.
    1012,  // Service restart
    1013,  // Try again later
  ]);
  // Timestamp of the last goAway message received from GL.
  // When GL sends goAway + then closes with 1007, the 1007 is not a genuine
  // "invalid argument" — it is GL completing the graceful disconnect after the
  // goAway grace period. We treat it as retriable in that specific context.
  private lastGoAwayTimestamp = 0;
  private stopGoAwayWatch: (() => void) | null = null;
  private lastReconnectPrompt: string | null = null;
  // Stored so reconnect can re-call start() with the same arguments.
  private lastSystemPrompt = '';
  private lastTools: FunctionDeclaration[] = [];
  // ── Proactive ACTFL reconnect ──────────────────────────────────────────────
  // When Daniela's pedagogical heartbeat observes a tier change mid-session
  // (e.g. student was novice but is now performing at intermediate), we update
  // session.studentActflLevel and trigger a silent reconnect so the new
  // silenceDurationMs tier takes effect without waiting for a natural WS drop.
  private isProactiveReconnecting = false;
  // ── Affirmation variety tracker (Fix 4) ───────────────────────────────────
  // Rolling list of the last 5 affirmation phrases Daniela used. Injected into
  // the system whisper so GL avoids repeating them in the next turn.
  private recentAffirmationPhrases: string[] = [];
  private static readonly AFFIRMATION_PHRASES = [
    'muy bien', '¡muy bien', 'excellent', '¡excelente', 'excelente',
    'perfect', 'perfecto', 'exactly', 'exacto', 'exactamente',
    'great job', 'well done', 'fantastic', 'wonderful', 'brilliant',
    'good job', 'buen trabajo', 'así es', 'así se dice', 'correcto',
    'right!', '¡correcto', 'that\'s right', 'you\'ve got it',
    'genial', '¡genial', 'estupendo', '¡estupendo',
  ];

  // ── Context Bridge — rolling transcript for graceful 1008 reconnect ────────
  // Stores the last 8 completed turns (user + model) so we can build a compact
  // "Context Bridge" injected into the reconnect system prompt. Prevents Daniela
  // from waking up amnesiac after a GL session duration abort.
  private transcriptBuffer: Array<{ role: 'student' | 'daniela'; text: string }> = [];
  private readonly MAX_TRANSCRIPT_BUFFER = 8;

  // ── Game session detector — full-session exchange log ───────────────────────
  // Accumulates every real (non-greeting, non-incognito) student↔Daniela exchange
  // so the game detector can scan the complete session transcript at stop() time.
  // No size cap — game detection needs the full picture (a counting game can run
  // 30+ turns). Cleared automatically when the object is GC'd at session end.
  private sessionExchangeLog: Array<{ user: string; daniela: string }> = [];

  // ── Mid-session context refresh (DISABLED — 2026-06-13) ────────────────
  // sendClientContent({role:'model', turnComplete:false}) was intended as a
  // silent context reminder but is incorrect GL API usage: it signals GL that
  // the model is mid-utterance, causing GL to generate a second audio stream to
  // "complete" the injected model turn — producing audio doubling every 15 turns.
  // GL has no safe "inject context without triggering a response" mechanism via
  // sendClientContent. System prompt handles context for now.
  // Keeping modelTurnCount as a counter for future use with a safe injection API.
  private modelTurnCount = 0;

  // ── Interruption Buffer callback ─────────────────────────────────────────
  // Called when GL fires serverContent.interrupted (barge-in detected).
  // The WS handler registers this to capture lastPedagogicalActionType into
  // session.interruptedIntent — picked up by selectStyleShaper next turn.
  public onBargeIn?: () => void;

  // ── Transcript accumulators ─────────────────────────────────────────────
  // Both user and assistant transcripts are accumulated across multiple
  // inputTranscription / outputTranscription / turnComplete events and
  // flushed as single complete utterances once the response is truly done.
  private pendingInputTranscript = '';   // Accumulates user's speech per utterance
  private pendingInputSaved = false;     // True once user message has been persisted for this turn
  private pendingOutputTranscript = '';  // Accumulates Daniela's reply across all sub-turns
  // Tracks which source is authoritative for pendingOutputTranscript this turn.
  // When GL sends BOTH part.text (model text) AND outputTranscription (audio transcript),
  // both contain the same content — accumulating from both causes 2x/3x repetition in
  // the saved message. Once outputTranscription arrives, it becomes the sole source and
  // any part.text accumulation from earlier in the same turn is discarded.
  private usingOutputTranscription = false;
  // Output transcription trails PCM, so opening replay words may escape. Full
  // elimination would require unacceptable full-response buffering.
  private readonly replayGuard = new TurnReplayGuard();
  private lastUserText = '';             // Last completed user turn — for enrichment context
  private enrichment: PostResponseEnrichmentService;
  private transcriptFlushTimer: NodeJS.Timeout | null = null;
  // Guard: prevents concurrent flushTranscripts() calls (e.g. 800ms debounce fires before
  // generationComplete, then generationComplete also calls flush) from double-incrementing
  // completedExchanges or sending response_complete twice.
  private isFlushInProgress = false;
  // Typed field for inline media parts that must be sent via realtimeInput after tool response
  // (GL tool response payloads cannot carry binary inlineData — causes 1007 session crash).
  // Using a typed array + push ensures batched tool calls (functionCalls[]) don't overwrite
  // each other's pending parts; each call appends and all are sent together.
  private pendingInlineParts: Array<{ mimeType: string; data: string }> = [];

  /**
   * Optional callback fired with the completed user transcript after each GL turn.
   * Used by the unified-ws-handler to route the transcript through the orchestrator
   * in "tools-only" mode so tool call side-effects (whiteboard, memory lookups,
   * scenarios, etc.) fire even though GL handles audio natively.
   */
  onUserTurnComplete?: (transcript: string) => void;

  /**
   * Optional callback fired whenever Gemini sends a new session resumption handle.
   * Used by the unified-ws-handler to persist the handle to the DB so a server
   * restart can restore it and pass it back to Gemini on reconnect — giving
   * Daniela full in-session memory even across hard process restarts.
   */
  onResumptionHandleUpdate?: (handle: string) => void;

  /**
   * Optional callback fired when Daniela's first audio chunk arrives.
   * Used by the unified-ws-handler to clear the tutor-no-response watchdog timer.
   */
  onFirstAudioGenerated?: () => void;

  constructor(
    private session: StreamingSession,
    private sendWsMessage: (ws: any, message: any, session?: any) => void,
  ) {
    // Read-only tap: every image Daniela puts on the student's screen also
    // reaches the hats' observer. Observation never blocks or alters delivery.
    const deliver = sendWsMessage;
    this.sendWsMessage = (ws: any, message: any, s?: any) => {
      try { observeOutboundVisuals(this.session.conversationId, message); } catch { /* observation only */ }
      try { observeAudioSent(this.session.conversationId, this.session.dbSessionId ?? null, this.session.id ?? null, message); } catch { /* observation only */ }
      deliver(ws, message, s);
    };
    this.enrichment = new PostResponseEnrichmentService(storage as unknown as IStorage, this.sendWsMessage);
    this.fcHandler = new NativeFunctionCallHandler(
      this.sendWsMessage,
      (_ws: any, code: string, message: string, _recoverable: boolean) => {
        console.error(`[GeminiLive] FC error: ${code} — ${message}`);
      },
      async (_session: StreamingSession, data: { to: string; reason: string }) => {
        console.log(`[GeminiLive] Phase shift requested: ${data.to} — ${data.reason}`);
      },
    );
  }

  /**
   * Open the Gemini Live WebSocket session.
   * Call once after session metadata is ready.
   */
  async start(
    systemPrompt: string,
    tools: FunctionDeclaration[],
    greetingTrigger?: string,
  ): Promise<void> {
    if (this.isProactiveReconnecting) {
      // Proactive ACTFL reconnect in flight — onclose will call start() directly once
      // the current WS closes. Do not allow a second start() to race in.
      console.warn('[GeminiLive] start() called while proactive reconnect is in-flight — ignoring');
      return;
    }
    if (this.isStarted) {
      console.warn('[GeminiLive] start() called on already-started session — ignoring');
      return;
    }
    this.isStarted = true;
    this.sessionStartedAt = Date.now();
    // Store for use by auto-reconnect
    this.rememberSystemPrompt(systemPrompt);
    this.lastTools = tools;

    // Restore assessment state from DB if this is a reconnect into an active placement session.
    // Without this, a browser disconnect mid-assessment resets placementMode and assessmentTurnCount
    // to zero, requiring the student to repeat all 8+ turns from scratch.
    if (this.session.dbSessionId) {
      try {
        const db = getSharedDb();
        const [row] = await db
          .select({
            assessmentActive: voiceSessions.assessmentActive,
            assessmentTurnCount: voiceSessions.assessmentTurnCount,
            assessmentRubric: voiceSessions.assessmentRubric,
          })
          .from(voiceSessions)
          .where(eq(voiceSessions.id, this.session.dbSessionId))
          .limit(1);
        if (row?.assessmentActive) {
          (this.session as any).placementMode = { active: true, exchangeCount: row.assessmentTurnCount ?? 0 };
          (this.session as any).assessmentTurnCount = row.assessmentTurnCount ?? 0;
          // Store rubric for injection into GL system prompt below (fixes "Amnesia" on reconnect)
          if (row.assessmentRubric) {
            (this.session as any)._reconnectAssessmentRubric = row.assessmentRubric;
          }
          console.log(`[GeminiLive] Restored assessment state from DB — assessmentTurnCount: ${row.assessmentTurnCount}, rubric: ${row.assessmentRubric ? 'present' : 'missing'}`);
        }
      } catch (err: any) {
        console.warn('[GeminiLive] Could not restore assessment state from DB (non-fatal):', err?.message);
      }
    }

    // Start karaoke tracker when subtitles are active — taps GL output audio
    // and runs it through a parallel Deepgram STT leg for word-level timestamps.
    if (this.session.subtitleMode !== 'off') {
      this.karaokeTracker = new GLKaraokeTracker(
        this.session.targetLanguage,
        (msg: any) => this.sendWsMessage(this.session.ws, msg),
      );
      this.karaokeTracker.start().catch(err =>
        console.warn('[GeminiLive] Karaoke tracker failed to start:', err?.message ?? err)
      );
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

    // Voice override (from Voice Lab) takes priority over the session's stored voice.
    const voiceOverride = (this.session as any).voiceOverride;
    const effectiveVoiceId = voiceOverride?.voiceId ?? this.session.voiceId ?? '';
    const liveName = GEMINI_LIVE_VOICE_NAMES.has(effectiveVoiceId) ? effectiveVoiceId : DEFAULT_LIVE_VOICE;
    const langKey = (this.session.targetLanguage || '').toLowerCase().trim();
    // geminiLanguageCode from the Voice Lab override takes priority over the language-map default.
    const languageCode = voiceOverride?.geminiLanguageCode || LANGUAGE_TO_BCP47[langKey] || 'en-US';
    console.log(`[GeminiLive] Opening session — model: ${GEMINI_LIVE_MODEL}, voice: ${liveName}, languageCode: ${languageCode}${voiceOverride?.geminiLanguageCode ? ' (voice-lab override)' : ''}`);

    // Build a universal accent identity directive from the session's language code.
    // The label is driven entirely by languageCode, which comes from the Voice Lab
    // override first (voiceOverride.geminiLanguageCode) and then the language-map
    // default — so changing the Voice Lab accent automatically changes this directive.
    //
    // The directive is intentionally language-agnostic: the tutor's accent is part of
    // who they are and travels with them into every language they speak — the target
    // language, the student's native language (English, Italian, etc.), or anything
    // else. A tutor from Spain sounds Spanish whether she's speaking Spanish or Italian.
    const ACCENT_DESCRIPTIONS: Record<string, string> = {
      'es-ES': 'Castilian Spanish',
      'es-MX': 'Mexican Spanish',
      'es-CO': 'Colombian Spanish',
      'es-AR': 'Rioplatense (Argentine) Spanish',
      'es-CL': 'Chilean Spanish',
      'es-PE': 'Peruvian Spanish',
      'fr-FR': 'Parisian French',
      'fr-CA': 'Québécois French',
      'de-DE': 'Standard German (Hochdeutsch)',
      'de-AT': 'Austrian German',
      'de-CH': 'Swiss German',
      'it-IT': 'Standard Italian',
      'it-CH': 'Swiss Italian',
      'pt-BR': 'Brazilian Portuguese',
      'pt-PT': 'European Portuguese',
      'ja-JP': 'standard Tokyo Japanese',
      'zh-CN': 'Mainland Mandarin Chinese',
      'zh-TW': 'Taiwan Mandarin Chinese',
      'ko-KR': 'Seoul Korean',
      'he-IL': 'Modern Israeli Hebrew',
    };
    // ── Accent identity directive (re-enabled June 13 2026 — new framing) ──────
    // Previous directive caused regionalism over-indexing (vosotros, guay, vale).
    // New approach (per Gemini 3-flash audit): decouple PHONOLOGY from LEXICON.
    // Identity framing ("your native language is X") vs. behavioral instruction
    // ("speak with X accent") avoids the proving/regionalism problem while keeping
    // the acoustic anchor. Appended to END of system prompt for recency-bias weight.
    //
    // VOICE_PACING directive remains removed: Flash does not stream audio while
    // thinking — filler prepends robotic words to every turn without buying latency.
    const accentLabel = ACCENT_DESCRIPTIONS[languageCode];
    const accentDirective = accentLabel ? `

── TUTOR ACCENT IDENTITY ──
IDENTITY: You are a native speaker of ${accentLabel}. This is who you are, not a performance.
LINGUISTIC BOUNDARY: Your internal monologue and primary linguistic identity are ${accentLabel}. You think and feel in your native language.
SPEECH CHARACTERISTICS: When speaking the student's language (e.g. English), maintain the natural phonology and prosody of a ${accentLabel} native speaker. Your accent is part of who you are and travels with you into every language you speak — including the student's native language.
LEXICAL CONSTRAINT: Do not use regional slang, fillers, or interjections from your native language unless you are specifically teaching those terms as vocabulary. Use standard, internationally clear vocabulary in all languages. Your identity is audible in your voice — not in regional vocabulary choices.` : '';
    // On reconnect mid-assessment, re-inject the rubric into the system prompt so GL's
    // new WebSocket knows it is in assessment mode. Without this, GL starts fresh with no
    // rubric context and responds as a generic assistant ("Amnesia" problem, Round 5 audit).
    const reconnectRubric = (this.session as any)._reconnectAssessmentRubric as string | undefined;
    (this.session as any)._reconnectAssessmentRubric = undefined; // consumed — clear it
    const reconnectRubricBlock = reconnectRubric
      ? `\n\n── ASSESSMENT IN PROGRESS (session resumed) ──\nThe student was mid-assessment when their connection dropped. Resume the placement assessment seamlessly — do not acknowledge the reconnection or mention it. Review the conversation history to see how many exchanges have occurred and what topics have been covered, then continue from where you left off. Do not repeat the opening question. Apply the same behavioral constraints:\n\n${reconnectRubric}`
      : '';
    const effectiveSystemPrompt = (accentDirective ? systemPrompt + accentDirective : systemPrompt) + reconnectRubricBlock;

    // Use session-level GL model override (set via Voice Lab) or fall back to env var default.
    const activeModel: string = (this.session as any).glModel || GEMINI_LIVE_MODEL;
    const is25NativeAudio = activeModel.includes('native-audio');

    this.liveSession = await ai.live.connect({
      model: activeModel,
      config: {
        systemInstruction: effectiveSystemPrompt,
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
        // AUDIO-only: gemini-3.1-flash-live-preview does NOT support TEXT as a
        // responseModality — sending [AUDIO, TEXT] causes immediate 1011
        // "Internal error encountered." at setup time. Use outputAudioTranscription
        // to capture the assistant's words instead.
        responseModalities: [Modality.AUDIO],

        // ── Generation config ─────────────────────────────────────────────
        // temperature 0.6: Gemini audit (June 19 2026) recommends 0.6 over 0.8
        // for sessions with many tools — high temp increases parameter hallucination
        // in function calls. Personality/prosody variety is better controlled via
        // system prompt language than by temperature. (Was 0.8; see audit notes.)
        // maxOutputTokens 2500: ~200-250 words — enough for a complete thought
        // (including philosophical/emotional responses) without enabling runaway
        // monologues. Was 1500 (~120-150 words), which caused mid-sentence cutoffs
        // on deeper responses. The cap still forces "speak then invite" pacing;
        // it just gives enough room to finish the sentence before the handoff.
        // Without any cap, the internal GL audio budget causes abrupt cutoff with
        // ghost transcription continuing beyond what was spoken.
        // candidateCount 1: multiple candidates in Live mode cause latency spikes and
        // audio buffer sync issues. Explicitly set to 1. (Gemini audit June 19 2026)
        generationConfig: {
          temperature: 0.6,
          // maxOutputTokens 1000: raised from 700 (July 26 2026) to prevent mid-sentence
          // cutoffs caused by GL reasoning tokens + audio tokens exceeding the budget.
          // In GL audio mode, reasoning tokens + audio tokens BOTH count against this limit.
          // For complex/philosophical responses, reasoning alone can consume 400+ tokens,
          // leaving only 300 audio tokens (~12s) — not enough for a complete thought.
          // 1000 gives: ~400 reasoning + 600 audio ≈ 24s of audio. Still concise.
          // Gemini audit July 1 recommended 700 but that assumed text-only token counting.
          // maxOutputTokens 2000 (July 26 2026 — Gemini-confirmed):
          // Token ceiling is SHARED between reasoning + audio. At MEDIUM thinking (two phases
          // around tool calls), reasoning ≈ 600-700 tokens. 2000 total → ~1300-1400 audio tokens
          // ≈ 52-56s max audio per turn. Response LENGTH is a behavioral constraint (system prompt
          // + Archive Guardian injection directives) — the ceiling only prevents mid-sentence cutoffs.
          // Gemini confirmed 1500 is tight for a 139-tool session with reasoning enabled.
          // HIGH thinking (considered July 26) rejected: consumes 1000-1200 reasoning tokens,
          // leaving only 300 for audio at 1500 limit. Conciseness = behavioral, not computational.
          // Do NOT lower below 1500 while MEDIUM thinking is active.
          maxOutputTokens: 2000,
          candidateCount: 1,
          // presencePenalty removed: GL rejects with 1007 "presence_penalty not supported"
          // Verbal loop variety must be handled via system prompt language instead.
        },

        // Safety settings: set all categories to BLOCK_ONLY_HIGH so GL doesn't silently return
        // an empty audio buffer when students discuss normal language-learning topics (war,
        // illness, crime, travel accidents). App-layer moderation is handled separately.
        // Without this, GL's default thresholds can silently drop responses with no error code.
        // Note: safetySettings is not yet in the @google/genai LiveConnectConfig TS types,
        // but the Gemini Live API accepts it — cast to any to pass it through.
        ...({
          safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT,         threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
          ],
        } as any),

        // ── Transcription ─────────────────────────────────────────────────
        // inputAudioTranscription:  student speech → text (live captions + DB)
        // outputAudioTranscription: assistant speech → text (DB conversation log)
        //
        // inputAudioTranscription: no languageCode — intentional.
        // Setting languageCode here locks the STT to one language, which breaks code-switching:
        // beginners asking "How do I say 'library'?" get their English phoneme-mapped to
        // garbled target-language tokens. Gemini audit July 1 2026 recommended languageCode
        // for WER on non-native speech, but the code-switching cost outweighs the WER gain
        // for beginner/intermediate learners. Keep multi-language auto-detect (empty config).
        // Revisit if we add an explicit "Immersion Mode" toggle where the student opts in
        // to target-language-only input and accepts the code-switching tradeoff.
        inputAudioTranscription: {},
        outputAudioTranscription: {},

        speechConfig: {
          languageCode,
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: liveName,
            },
          },
        },

        // ── Thinking configuration ────────────────────────────────────────
        // Gives Daniela an internal reasoning pass before her first word.
        //
        // Level: MEDIUM — HIGH holds the first audio token until a full reasoning
        // pass completes, adding noticeable TTFT lag. MEDIUM gives meaningful depth
        // without blocking voice streaming. (June 12 2026 audit: dropped from HIGH)
        //
        // includeThoughts: true — returns thought Parts (thought:true, text:"...")
        // arriving BEFORE the first audio chunk in each turn. Captured server-side
        // into currentTurnThoughtBuffer for the pedagogical supervisor. Never
        // forwarded to the client (thought parts are filtered in handleServerMessage).
        // thoughtSignature field is ignored — only needed for context-cache scenarios.
        //
        // SDK: "An error will be returned if this field is set for models that
        // don't support thinking." — native-audio skips it to avoid that error.
        // thinkingLevel MEDIUM: GL reasons before + after each tool call. Two reasoning phases
        // per turn ≈ 600-700 tokens total. maxOutputTokens:1500 leaves ~800-900 for audio (~32-36s).
        // LOW was tried briefly (July 26) but reversed — reducing reasoning quality is the wrong
        // tradeoff. Response length is controlled by the system prompt ("fewer words, more impact"),
        // not by the token ceiling. The ceiling only prevents mid-sentence cutoffs.
        ...(!is25NativeAudio ? { thinkingConfig: { thinkingLevel: 'MEDIUM' as any, includeThoughts: true } } : {}),

        // ── Turn coverage (2.5 native audio only) ────────────────────────
        // 2.5 native audio defaults to TURN_INCLUDES_ONLY_ACTIVITY, which can
        // drop image frames that arrive between activity events.  Explicitly set
        // the same value 3.1 uses so whiteboard image delivery stays reliable.
        ...(is25NativeAudio ? { turnCoverage: 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO' as any } : {}),

        // ── VAD / Turn-taking configuration ───────────────────────────────
        // Gemini Live's audio model does semantic turn detection — it
        // understands whether a sentence sounds complete, not just whether
        // there's silence. Our settings tune how much patience it shows:
        //
        //  START_SENSITIVITY_HIGH    — detect speech onset quickly so Daniela
        //                             doesn't miss when the student starts talking.
        //  END_SENSITIVITY_LOW       — "lazy" end detection; forces the model to wait
        //                             for a more definitive final cadence before it
        //                             starts the silence countdown. Critical for language
        //                             learners who pause mid-sentence while word-searching
        //                             ("Quiero… [pause]… una… [pause]… manzana").
        //                             HIGH + 1500ms was contradictory: HIGH is aggressive
        //                             about interpreting any pitch/volume drop as turn-end,
        //                             meaning the 1500ms timer would start at the learner's
        //                             first pause — well before they finished their sentence.
        //                             LOW is correct: be "lazy," not "eager," for non-fluent
        //                             speakers. (3-flash audit June 13 2026)
        //                             (history: LOW+2500ms→HIGH+1500ms [dead air fix]→
        //                              LOW+1500ms [3-flash audit: HIGH contradictory for learners])
        //  prefixPaddingMs: 200      — require 200 ms of sustained speech before
        //                             committing a turn start, filtering out coughs,
        //                             filler sounds, and accidental mic noise.
        //  silenceDurationMs         — Dynamic per student ACTFL level (July 2026).
        //                             novice (A1): 5000ms — every word is a search
        //                             intermediate (B1): 3000ms — comfortable baseline
        //                             advanced (C1): 2500ms — fluent pacing
        //                             superior+ (C2+): 2000ms — natural conversation speed
        //                             Falls back to 3000ms for unassessed students.
        //                             Client shows "Take your time..." indicator at
        //                             1200ms so sessions never feel frozen regardless
        //                             of cutoff. (was hardcoded 3000ms)
        //                             (history: 800ms → 1500ms → 2500ms → 1500ms → 3000ms → dynamic)
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_UNSPECIFIED, // UNSPECIFIED resolves to LOW — prevents false barge-ins from background noise
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 500,
            silenceDurationMs: (() => {
              const ms = actflSilenceDurationMs(this.session.studentActflLevel);
              console.log(`[GeminiLive] realtimeInputConfig — studentActflLevel: ${this.session.studentActflLevel ?? 'null (unassessed)'}, silenceDurationMs: ${ms}`);
              return ms;
            })(),
          },
        },

        // ── Context window compression ────────────────────────────────────
        // Without this, long sessions accumulate every tool call and response in
        // GL's context window indefinitely. At ~30K tokens the window starts to
        // affect model behavior (recency bias, ignoring early context). Compression
        // triggers a sliding-window drop of the oldest turns, keeping the 15K most
        // recent tokens. The system prompt is always preserved — compression only
        // affects conversation history.
        //
        // triggerTokens "65000" → fire when total context (system prompt + history) hits
        //                         65K tokens. Total context = system prompt + history.
        //                         Our system prompt cap is 34K, so this triggers when
        //                         ~31K of conversation history has accumulated.
        //                         Must be > 34K system prompt or compression never fires.
        //
        // targetTokens  "50000" → after compression, keep 50K total. With a 34K system
        //                         prompt, that retains ~16K of the most recent history
        //                         (~12,000 words / 30-40 min of conversation).
        //                         Sheds ~15K of oldest turns per compression cycle.
        //                         Earlier value of 40K left only ~6K of history — too
        //                         little for pedagogical continuity across long sessions.
        //
        // Note: these values are strings — the @google/genai SDK declares them as
        // `string` (proto3 int64 serializes as JSON string). Passing numbers fails
        // TypeScript type-checking against the SDK types.
        //
        // Caveat: early-session context (opening assessment, agreed lesson goals) may
        // be compressed away in very long sessions. Front-load critical student facts
        // into the system prompt rather than relying on tool-call history for anything
        // that must persist across a 45+ minute session.
        contextWindowCompression: {
          triggerTokens: '65000',
          slidingWindow: {
            targetTokens: '50000',
          },
        },

        // ── Session resumption ────────────────────────────────────────────
        // Server will stream back newHandle tokens on each turn.
        // We store the latest token so we can reconnect without losing context.
        // NOTE: Only include sessionResumption when we actually have a handle.
        // Passing an empty {} causes a 1011 internal error on fresh sessions.
        ...(this.session.geminiLiveResumptionHandle
          ? { sessionResumption: { handle: this.session.geminiLiveResumptionHandle } }
          : {}),
      },
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          this.handleServerMessage(msg).catch(err => {
            console.error('[GeminiLive] handleServerMessage error:', err);
          });
        },
        onerror: (err: any) => {
          console.error('[GeminiLive] WebSocket error:', err);
          // Propagate to client so the UI can show a recoverable error rather
          // than hanging silently.  The subsequent onclose will drive reconnect
          // logic — this just ensures the user sees something immediately.
          if (!this.isStopped) {
            this.sendWsMessage(this.session.ws, {
              type: 'voice_error',
              code: 'GEMINI_WS_ERROR',
              message: 'The voice connection encountered an error. Reconnecting…',
              recoverable: true,
            });
          }
        },
        onclose: async (event: any) => {
          this.stopGoAwayWatch?.();
          this.stopGoAwayWatch = null;
          const code = event?.code as number;
          const reason = event?.reason || '(no reason)';
          console.log(`[GeminiLive] Session closed — code: ${code}, reason: ${reason}`);
          // F3: persist the close so a mid-session drop has a recorded cause.
          voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_session_closed', {
            code: Number.isFinite(code) ? code : null,
            reason: String(event?.reason ?? '').slice(0, 200) || null,
            isStopped: this.isStopped,
            reconnectAttempts: this.reconnectAttempts,
            retriableCode: this.RETRIABLE_CLOSE_CODES.has(code),
          });

          // ── Auto-reconnect ─────────────────────────────────────────────────
          // Retriable codes are transient (network hiccup, GL service restart).
          // We only reconnect when isStopped is false (student didn't end the session)
          // and we haven't exhausted our 3 attempts.
          //
          // Quota errors (1011 + "quota" in reason) are NOT retriable — retrying
          // immediately just burns more quota. Surface a clear error instead.
          const isQuotaError = code === 1011 && /quota|exceeded|billing/i.test(reason);
          if (isQuotaError && !this.isStopped) {
            console.error('[GeminiLive] Quota exceeded — not retrying. Reason:', reason);
            this.sendWsMessage(this.session.ws, {
              type: 'voice_error',
              code: 'GEMINI_QUOTA_EXCEEDED',
              message: 'Voice sessions are temporarily unavailable due to high demand. Please try again in a few minutes.',
              recoverable: false,
            });
            return;
          }
          // goAway → 1007: GL sent a graceful goAway message and then closed with 1007.
          // This is NOT a genuine "invalid argument" — it is GL completing a planned
          // disconnect after the goAway grace period. Treat it as retriable by temporarily
          // adding 1007 to the retriable set (same pattern as stale handle recovery).
          const isGoAway1007 = code === 1007 &&
            (Date.now() - this.lastGoAwayTimestamp) < 15_000;
          if (isGoAway1007 && !this.isStopped && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            console.log('[GeminiLive] 1007 after goAway — treating as retriable (graceful GL disconnect)');
            this.RETRIABLE_CLOSE_CODES.add(1007);
            setTimeout(() => this.RETRIABLE_CLOSE_CODES.delete(1007), 10_000);
          }

          // Stale resumption handle — 1011 whose reason references the handle/session token.
          // This happens when a student reconnects hours later with an expired handle.
          // Clear the handle and fall through to a fresh session start (no bail-out).
          // (3-flash audit recommendation, 2026-06-13)
          const isStaleHandle = code === 1011 &&
            !!this.session.geminiLiveResumptionHandle &&
            /handle|resumption|invalid.*session|session.*invalid|expired/i.test(reason);
          if (isStaleHandle && !this.isStopped && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            console.warn('[GeminiLive] Stale resumption handle (1011) — clearing handle and retrying as fresh session. Reason:', reason);
            this.session.geminiLiveResumptionHandle = undefined as any;
            // Fall through to the retriable reconnect block below by temporarily allowing it.
            // We force-add code 1011 to retriable set only for this one attempt.
            this.RETRIABLE_CLOSE_CODES.add(1011);
            // Remove after the reconnect fires so we don't permanently allow 1011 retries.
            setTimeout(() => this.RETRIABLE_CLOSE_CODES.delete(1011), 5000);
          }
          // Any other 1011 (e.g. "Internal error encountered.") is also non-retriable.
          // Retrying immediately resends the full system prompt (~13K tokens) and burns quota.
          // Surface a recoverable error so the client can prompt the user to try again.
          if (code === 1011 && !this.isStopped && !isStaleHandle) {
            console.error('[GeminiLive] Internal error (1011) — not retrying. Reason:', reason || '(no reason)');
            this.sendWsMessage(this.session.ws, {
              type: 'voice_error',
              code: 'GEMINI_INTERNAL_ERROR',
              message: 'The voice connection encountered an error. Please try again.',
              recoverable: true,
            });
            return;
          }
          // A close we asked for (ACTFL recalibration, GoAway) takes the same reconnect path as
          // an unexpected one, with no backoff: it needs the same per-connection resets and the
          // same context bridge. The retry count only tracks unexpected closes.
          const deliberateClose = this.isProactiveReconnecting && !this.isStopped;
          this.isProactiveReconnecting = false;
          if (deliberateClose) this.reconnectAttempts = 0;
          if (deliberateClose || (!this.isStopped && this.RETRIABLE_CLOSE_CODES.has(code) && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS)) {
            this.reconnectAttempts++;
            const delayMs = deliberateClose ? 0 : 1000 * Math.pow(2, this.reconnectAttempts - 1); // 1 s, 2 s, 4 s
            console.log(`[GeminiLive] Scheduling reconnect ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delayMs} ms`);

            this.sendWsMessage(this.session.ws, {
              type: 'gl_reconnecting',
              attempt: this.reconnectAttempts,
              maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
              delayMs,
            });

            this.reconnectTimer = setTimeout(async () => {
              this.reconnectTimer = null;
              if (this.isStopped) return;
              console.log(`[GeminiLive] Reconnect attempt ${this.reconnectAttempts}…`);
              // Capture whether we have a resumption handle BEFORE resetting state.
              // If we had one AND there were in-flight tool calls, GL may resume in
              // "waiting for tool response" state — we'll unblock it after start().
              const hadHandle = !!this.session.geminiLiveResumptionHandle;
              const staleFunctionCallIds = [...this.pendingFunctionCallIds];
              this.pendingFunctionCallIds = [];

              // DOUBLE-AUDIO FIX: If GL disconnected while actively generating audio,
              // the client's AudioContext has already scheduled BufferSource nodes for
              // the pre-reconnect chunks. resetForNewTurn() clears dedup but does NOT
              // cancel those scheduled nodes — they keep playing. GL then resumes/re-
              // generates the same turn and we get double audio.
              // Fix: send gl_audio_reset BEFORE resetting state so the client can call
              // player.stop() (which cancels all scheduled sources) + resetForNewTurn().
              // Also suppress the next processing_pending since the client already reset.
              if (this.hadAudioInCurrentSubturn) {
                console.log('[GeminiLive] Reconnect mid-turn — sending gl_audio_reset to clear client audio buffer');
                glLiveAlert({
                  sessionId: this.session.id,
                  userId: this.session.userId ?? '',
                  lang: this.session.targetLanguage,
                  eventType: 'reconnect_mid_turn',
                  detail: { attempt: this.reconnectAttempts },
                });
                this.sendWsMessage(this.session.ws, {
                  type: 'gl_audio_reset',
                  reason: 'reconnect',
                });
                this.suppressNextProcessingPending = true;

                // DOUBLE-GREETING FIX: if GL dropped while generating the opening greeting
                // and audio was already partially sent to the client, clear the resumption
                // handle so the new GL connection starts fresh. Without this, GL resumes
                // from its internal state which still contains the student's greeting trigger
                // and re-generates the greeting → the client hears it twice.
                if (this.isGreetingTurn && this.session.geminiLiveResumptionHandle) {
                  console.log('[GeminiLive] Reconnect mid-greeting — clearing resumption handle to prevent double greeting audio');
                  this.session.geminiLiveResumptionHandle = undefined as any;
                }

                // Telemetry: write a queryable event so Sofia can watch for this path firing in prod.
                // Fire-and-forget — never block the reconnect on a DB write.
                const capturedSessionId = this.session.id;
                const capturedUserId = this.session.userId;
                import('../db').then(async ({ getSharedDb }) => {
                  const { sql: dbSql } = await import('drizzle-orm');
                  const payload = JSON.stringify({ sessionId: capturedSessionId, reconnectAttempt: this.reconnectAttempts });
                  await getSharedDb().execute(dbSql`
                    INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
                    VALUES (gen_random_uuid(), ${capturedSessionId ?? null}, ${String(capturedUserId ?? '')},
                      'gl_reconnect_mid_turn', ${payload}::jsonb, NOW())
                  `);
                }).catch((err: Error) => console.warn('[GeminiLive] Failed to log mid-turn reconnect telemetry:', err.message));
              }

              // Reset per-session flags so start() can run again
              this.isStarted = false;
              this.isSetupComplete = false;
              this.liveSession = null;
              // Advance, never reset: the client discards response_complete for any turnId below the
              // highest it has seen, and in-flight tool handlers from the old connection must see
              // their turn superseded (the call-ID guard compares against currentTurnId).
              this.session.currentTurnId = ++this.currentTurnId;
              this.resetSubstantialReplayGuard();
              this.currentSentenceIndex = 0;
              this.currentChunkIndex = 0;
              this.lastSentenceStartSentIndex = -1;
              this.hadAudioInCurrentSubturn = false;
              this.transcriptClosed = false;
              this.afterGenerationComplete = false;
              this.isGenerationDone = false;
              this.pendingPlaybackEndedLift = false;
              this.usingOutputTranscription = false;
              this.firstAudioSentThisTurn = false;
              this.processingPendingSentThisTurn = false;
              this.generationStartedThisTurn = false;
              this.greetingPhaseActive = false;
              this.isGreetingTurn = false;
              this.isTutorGeneratingAudio = false;
              this.hasStudentInputSinceLastResponse = false;
              this.responseFlushedToClient = false;
              if (this.playbackGateSafetyTimeout) {
                clearTimeout(this.playbackGateSafetyTimeout);
                this.playbackGateSafetyTimeout = null;
              }
              if (this.greetingWatchdogTimer) {
                clearTimeout(this.greetingWatchdogTimer);
                this.greetingWatchdogTimer = null;
              }
              this.pendingInputTranscript = '';
              this.resetInputTranscriptionFinalizationState();
              this.pendingInputSaved = false;
              this.pendingOutputTranscript = '';
              this.usingOutputTranscription = false;
              if (this.transcriptFlushTimer) {
                clearTimeout(this.transcriptFlushTimer);
                this.transcriptFlushTimer = null;
              }

              let reconnectPrompt = this.lastSystemPrompt;
              try {
                // Reconnect without a greeting — inject Context Bridge so Daniela
                // resumes from where the conversation was rather than waking amnesiac.
                // Bridge goes AFTER lastSystemPrompt so: (a) identity/persona instructions
                // keep primacy, (b) if the prompt is near the 34K cap, the bridge (recency)
                // gets trimmed before core persona does, and (c) LLM recency bias naturally
                // pulls the model toward the recent context even when it's at the end.
                reconnectPrompt = this.buildReconnectPrompt();
                await this.start(reconnectPrompt, this.lastTools);
                this.reconnectAttempts = 0; // success — reset counter
                console.log('[GeminiLive] Reconnected successfully');

                // Tool Call Deadlock fix: if we resumed a session that had in-flight
                // tool calls, GL is now silently waiting for the responses. Send
                // synthetic error responses to unblock it so the session can continue.
                // Capture in local var + cast so TS narrowing works inside the block.
                // (async setTimeout callbacks lose track of class-property control flow.)
                const sessionForUnblock = this.liveSession as Session | null;
                if (hadHandle && staleFunctionCallIds.length > 0 && sessionForUnblock) {
                  try {
                    const syntheticResponses: Array<{ id: string; name: string; response: GLToolResponsePayload }> =
                      staleFunctionCallIds.map(id => ({
                        id,
                        name: 'unknown',
                        response: { result: 'Session interrupted — tool response lost. Please continue naturally.' } satisfies GLToolResponsePayload,
                      }));
                    sessionForUnblock.sendToolResponse({ functionResponses: syntheticResponses });
                    this._recordDirectLineageAttempt({
                      sourceRoute: 'gemini-live',
                      eventType: 'tool_response_send_attempted',
                      deliveryChannel: 'sendToolResponse',
                      deliveryStatus: 'attempted',
                      payloadJson: { purpose: 'reconnect_unblock', functionResponseCount: syntheticResponses.length },
                    });
                    console.log(`[GeminiLive] Sent ${staleFunctionCallIds.length} synthetic tool response(s) to unblock GL after reconnect`);
                  } catch (unblockErr) {
                    this._recordContextLineage({
                      sourceRoute: 'gemini-live',
                      eventType: 'tool_response_send_failed',
                      deliveryChannel: 'sendToolResponse',
                      deliveryStatus: 'failed',
                      payloadJson: { purpose: 'reconnect_unblock', error: unblockErr instanceof Error ? unblockErr.message : String(unblockErr) },
                    });
                    console.warn('[GeminiLive] Failed to send synthetic tool responses after reconnect:', unblockErr);
                  }
                };
                this.sendWsMessage(this.session.ws, { type: 'gl_reconnected' });
              } catch (err: any) {
                console.error(`[GeminiLive] Reconnect attempt ${this.reconnectAttempts} failed:`, err?.message);
                // connect() can reject before a new Live WebSocket exists, so there
                // is no later onclose to advance the retry chain. Continue explicitly.
                this.retryFailedReconnectStart(reconnectPrompt);
              }
            }, delayMs);
          } else if (!this.isStopped) {
            // Non-retriable close or retries exhausted — surface to client
            this.sendWsMessage(this.session.ws, {
              type: 'voice_error',
              code: 'GEMINI_LIVE_DISCONNECTED',
              message: 'Daniela\'s voice session disconnected',
              recoverable: this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS,
            });
          }
        },
      },
    });

    console.log(`[GeminiLive] Session open — sessionId: ${this.session.id}`);
    if (this.session.conversationId) {
      observeSessionStart({
        conversationId: this.session.conversationId,
        dbSessionId: this.session.dbSessionId ?? null,
        transientSessionId: this.session.id,
        userId: this.session.userId ?? '',
        language: this.session.targetLanguage ?? null,
        actflLevel: this.session.studentActflLevel ?? null,
      });
      observeModelAndUsage(this.session.conversationId, { model: (this.session as any).glModel || GEMINI_LIVE_MODEL });
    }
    // Instantiation is local-only and performs no I/O. It keeps an enabled
    // Observation Bench honest even before the first student utterance arrives.
    this._getContextLineageRecorder();

    // If a greeting trigger is provided at start() time, buffer it — setupComplete
    // has not arrived yet at this point (it arrives asynchronously via onmessage).
    // handleServerMessage will fire it as soon as setupComplete is received.
    if (greetingTrigger) {
      this.pendingGreetingTrigger = greetingTrigger;
      console.log('[GeminiLive] Greeting buffered at start() — waiting for setupComplete');
    }
  }

  /**
   * Continue a reconnect when start() rejects before opening a new Live socket.
   *
   * The normal onclose handler can only schedule the next retry after a real
   * WebSocket exists. A failed connect has no socket and therefore no onclose,
   * so this bounded continuation owns that otherwise-dead retry branch.
   */
  /** Her system prompt plus a fresh context bridge for one new connection. */
  private buildReconnectPrompt(): string {
    const contextBridge = this.buildContextBridge();
    this.lastReconnectPrompt = contextBridge
      ? `${this.lastSystemPrompt}\n\n${contextBridge}`
      : this.lastSystemPrompt;
    return this.lastReconnectPrompt;
  }

  /** Keeps the prompt without any bridge, so bridges don't pile up across reconnects. */
  private rememberSystemPrompt(systemPrompt: string): void {
    if (systemPrompt !== this.lastReconnectPrompt) this.lastSystemPrompt = systemPrompt;
  }

  private retryFailedReconnectStart(reconnectPrompt: string): void {
    if (this.isStopped) return;

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('[GeminiLive] Reconnect attempts exhausted after failed start()');
      this.sendWsMessage(this.session.ws, {
        type: 'voice_error',
        code: 'GEMINI_LIVE_DISCONNECTED',
        message: 'Daniela\'s voice session disconnected. Please start a new session.',
        recoverable: false,
      });
      return;
    }

    this.reconnectAttempts++;
    const delayMs = 1000 * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[GeminiLive] Scheduling reconnect ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} after failed start in ${delayMs} ms`);
    this.sendWsMessage(this.session.ws, {
      type: 'gl_reconnecting',
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
      delayMs,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopped) return;

      // start() marks the session started before opening the upstream socket.
      // Reset those fields so a failed start can make a fresh bounded attempt.
      this.isStarted = false;
      this.liveSession = null;

      try {
        await this.start(reconnectPrompt, this.lastTools);
        this.reconnectAttempts = 0;
        console.log('[GeminiLive] Reconnected successfully after failed start');
        this.sendWsMessage(this.session.ws, { type: 'gl_reconnected' });
      } catch (err: any) {
        console.error(`[GeminiLive] Reconnect attempt ${this.reconnectAttempts} failed:`, err?.message);
        this.retryFailedReconnectStart(reconnectPrompt);
      }
    }, delayMs);
  }

  /**
   * Send a PCM16 audio chunk (16 kHz, mono) from the client's microphone
   * to Gemini Live for processing.
   *
   * The client already captures PCM16 at 16 kHz via its AudioContext
   * and sends it via stream_audio_chunk WS messages. No transcoding needed.
   */
  sendAudioChunk(pcm16Buffer: Buffer): void {
    if (!this.liveSession || this.isStopped) return;
    // Gate 1 — greeting phase: GL is generating the opening response.
    // Drop mic audio until the first audio chunk from GL arrives.
    if (this.greetingPhaseActive) return;
    // Gate 2 — turn gate: GL is generating audio for any subsequent turn.
    // Daniela's audio plays through the speaker; the mic would pick it up and
    // send it back to GL as "user speech," causing GL to produce a zero-sentence
    // echo response on the next turn (alternating silence bug).
    // Gate stays closed from first audio chunk until generationComplete fires.
    if (this.isTutorGeneratingAudio) return;
    // Student audio is being sent — confirm input has arrived since last response.
    this.hasStudentInputSinceLastResponse = true;
    const base64Audio = pcm16Buffer.toString('base64');
    this.liveSession.sendRealtimeInput({
      audio: {
        data: base64Audio,
        mimeType: `audio/pcm;rate=${AUDIO_INPUT_SAMPLE_RATE}`,
      },
    });
  }

  /**
   * Forward a video frame (base64 JPEG) from the student's webcam or screen share
   * into the Gemini Live session.  Fires-and-forgets — no awaiting so audio is
   * never blocked by a frame send (avoids TCP head-of-line blocking).
   *
   * Called at ~0.5fps by the server's video_frame WS message handler.
   * The model receives the frame as ambient visual context; no system prompt
   * scripting — Daniela decides what to do with what she sees.
   */
  sendVideoFrame(base64Jpeg: string, source: 'webcam' | 'screen' = 'webcam'): void {
    if (!this.liveSession || this.isStopped) return;
    try {
      this.liveSession.sendRealtimeInput({
        video: { data: base64Jpeg, mimeType: 'image/jpeg' },
      } as any);
      this.videoFramesSent++;
      // The hats see the same frame Daniela was just sent (memory only, never stored).
      observeVisionFrame(this.session.conversationId, source, base64Jpeg);
    } catch (err) {
      // Non-fatal — log and continue; audio must not be affected
      console.warn('[GeminiLive] sendVideoFrame error (non-fatal):', (err as Error).message);
    }
  }

  /**
   * Called by the WS handler when the client's playback_ended telemetry arrives.
   * This is the true end of Daniela's audio from the student's perspective — speakers
   * have gone quiet and there is no more echo risk. We open the mic gate here instead
   * of at generationComplete (which fires before the client even starts playing).
   */
  onPlaybackEnded(): void {
    if (this.playbackGateSafetyTimeout) {
      clearTimeout(this.playbackGateSafetyTimeout);
      this.playbackGateSafetyTimeout = null;
    }
    // Inter-sentence idle guard: GL sends multiple sub-turns separated by brief pauses.
    // The PCM player goes idle between sub-turns (before the next sentence arrives), which
    // fires playback_ended. If we lift the mic gate here, GL's VAD can mistake ambient
    // room audio for student speech and interrupt its own generation mid-sentence.
    // Only lift the gate once we know generation is truly finished.
    if (!this.isGenerationDone) {
      // Remember that playback_ended fired while generation was still in progress.
      // When isGenerationDone becomes true (generationComplete or watchdog), we'll
      // call onPlaybackEnded() retroactively to lift the gate (single-sentence case).
      this.pendingPlaybackEndedLift = true;
      console.log('[GeminiLive] playback_ended between sub-turns — generation still in progress, mic gate held (latch set)');
      return;
    }
    this.pendingPlaybackEndedLift = false;
    const openedMicGate = this.isTutorGeneratingAudio;
    if (this.isTutorGeneratingAudio) {
      this.isTutorGeneratingAudio = false;
      console.log('[GeminiLive] Mic gate lifted — client playback_ended (echo suppression off)');
    }
    // Friction Score — set T-zero here, NOT at generationComplete.
    // generationComplete fires when GL finishes generating; the client hasn't started playing yet.
    // playback_ended is when the student can actually hear silence and begin speaking.
    // Using generationComplete would inflate pauses by the full duration of Daniela's audio.
    this.studentTurnStartMs = Date.now();
    this.currentTurnFirstInputMs = 0;
    this.lastInputChunkMs = 0;
    if (openedMicGate) {
      this.startNewStudentTurnOnNextInputTranscription = true;
      this.nextStudentTurnBoundaryTrusted = this.unfinalizedStudentTurnEpochs.length === 0;
      if (!this.nextStudentTurnBoundaryTrusted) {
        console.warn(
          '[ArchiveGuardian] Next student turn opened before prior inputTranscription finished; '
          + 'dormant prior-turn grounding will stay withheld for that turn.',
        );
      }
    }

    // Proactive ACTFL reconnect: Daniela's pedagogical heartbeat flagged a tier change.
    // This is the safest moment to reconnect — audio just finished, student hasn't started
    // speaking yet, no in-flight audio or tool calls.
    // A one-sentence turn can get here before its transcript is flushed. Closing then would lose
    // her words from the record, so leave the flag set and take the next playback_ended instead.
    if ((this.session as any).pendingActflReconnect && !this.isStopped && !this.generationStartedThisTurn) {
      delete (this.session as any).pendingActflReconnect;
      void this.proactiveReconnect();
    }
  }

  /**
   * Triggered when Daniela's pedagogical heartbeat observes a significant ACTFL tier change
   * mid-session (e.g. novice student performing at intermediate gear). Closes the current GL
   * WebSocket and immediately reconnects so the updated silenceDurationMs tier takes effect.
   * Context is preserved via the resumption handle. Only called from onPlaybackEnded() — the
   * safest reconnect window (audio done, student not yet speaking).
   */
  private async proactiveReconnect(): Promise<void> {
    if (this.isStopped || !this.liveSession) return;
    const newLevel = this.session.studentActflLevel;
    console.log(`[GeminiLive] Proactive ACTFL reconnect — new tier: ${newLevel ?? 'unset'}, silenceDurationMs will recalibrate on next start()`);
    voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_actfl_recalibration', {
      newLevel,
      sessionId: this.session.id,
    });
    glLiveAlert({
      sessionId: this.session.id,
      userId: this.session.userId ?? '',
      lang: this.session.targetLanguage,
      eventType: 'actfl_recalibration',
      detail: { newLevel },
    });
    if (this.session.conversationId) {
      observeActflUpdate(this.session.conversationId, newLevel ?? null);
    }
    this.closeForReconnect();
  }

  /** Close the Gemini connection on purpose; onclose starts the next one from the resumption handle. */
  private closeForReconnect(): void {
    this.isProactiveReconnecting = true;
    this.isStarted = false;
    this.sendWsMessage(this.session.ws, {
      type: 'gl_reconnecting',
      attempt: 1,
      maxAttempts: 1,
      delayMs: 0,
    });
    try {
      this.liveSession?.close();
    } catch {
      // Already closed — onclose handler will pick up from here
    }
  }

  /** Gemini is about to end this connection at its session limit. See gl-go-away.ts. */
  private handleGoAway(goAway: { timeLeft?: unknown }): void {
    if (this.stopGoAwayWatch) return;
    console.log(`[GeminiLive] goAway received — ${String(goAway.timeLeft)} left, reconnecting at the next moment between turns`);
    this.stopGoAwayWatch = watchGoAway(goAway.timeLeft, {
      isCurrent: () => !this.isStopped && !!this.liveSession && !this.isProactiveReconnecting,
      turnState: () => ({
        tutorSpeaking: this.isTutorGeneratingAudio,
        generationStarted: this.generationStartedThisTurn,
        pendingToolCalls: this.pendingFunctionCallIds.length,
        pendingStudentTranscript: this.pendingInputTranscript,
      }),
      reconnect: () => this.closeForReconnect(),
      log: (outcome, detail) => voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_go_away', { outcome, ...detail }),
    });
  }

  /**
   * Signal that the user has started speaking — interrupts Daniela's current response.
   * Gemini Live handles VAD natively, but the client's barge-in button can also
   * call this to force an interruption.
   */
  interrupt(): void {
    if (!this.liveSession || this.isStopped) return;
    this.currentTurnId++;
    this.currentChunkIndex = 0;
    this.firstAudioSentThisTurn = false;
    this.processingPendingSentThisTurn = false;
    this.generationStartedThisTurn = false;
    this.transcriptClosed = false;
    this.afterGenerationComplete = false;
    this.isGenerationDone = false;
    this.pendingPlaybackEndedLift = false;
    this.usingOutputTranscription = false;
    this.resetSubstantialReplayGuard();
    // Student actively interrupted — their audio is arriving, so count it as input.
    this.hasStudentInputSinceLastResponse = true;
    // Reset response-flushed guard so the next generation is not spuriously suppressed.
    this.responseFlushedToClient = false;
    // DOUBLE-AUDIO FIX: Clear suppress flag on interrupt so a stale reconnect-era flag
    // doesn't carry into the next turn if GL never generated audio after the reconnect.
    this.suppressNextProcessingPending = false;
    console.log(`[GeminiLive] Interrupted — advancing to turnId ${this.currentTurnId}`);
  }

  /**
   * Append one output-transcription chunk, dropping only a detected immediate
   * substantial replay. The factual stream callback remains upstream, so this
   * repair does not change telemetry.
   */
  private appendOutputTranscriptChunk(text: string): string {
    const result = this.replayGuard.appendTranscript(text);
    this.pendingOutputTranscript = this.replayGuard.transcriptText;
    if (result.replayConfirmed) {
      console.warn(`[GeminiLive] Suppressed immediate substantial output replay (turnId: ${this.currentTurnId})`);
      voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_substantial_replay_suppressed', {
        turnId: this.currentTurnId,
        matchedTokens: 20,
        ...this.replayGuard.telemetry,
      });
    }
    return result.acceptedText;
  }

  private resetSubstantialReplayGuard(): void {
    this.replayGuard.reset();
  }

  /**
   * Pre-load identity threads into conversation history before the first greeting.
   * Called from the unified WS handler after session creation, before start().
   * Top 3 threads by importance; content is already truncated to ~2500 chars each.
   */
  setIdentityThreads(threads: Array<{ title: string; content: string }>): void {
    this.identityThreads = threads;
  }

  private scheduleGreetingDeliveryRetry(cause: 'send_throw' | 'turn_complete' | 'generation_complete' | 'watchdog'): void {
    const p = this.lastGreetingParams;
    if (!p || this.isStopped || this.greetingDelivery.phase === 'delivered') return;
    if (this.greetingDelivery.phase === 'dispatched') this.greetingDelivery.noAudio();
    if (this.greetingDelivery.phase === 'failed') {
      const sessionId = String(this.session.dbSessionId || '');
      const userId = String(this.session.userId || '');
      voiceTelemetry.log(String(this.session.dbSessionId || ''), String(this.session.userId || ''), 'greeting_retry_exhausted', {
        cause, attempt: this.greetingDelivery.attempts, sessionId: this.session.dbSessionId, turnId: this.currentTurnId,
      });
      reportGreetingRetryExhausted({ userId, sessionId, conversationId: (this.session as any).conversationId }).catch(() => {});
      return;
    }
    if (this.greetingRetryTimer) return;
    const attempt = this.greetingDelivery.attempts + 1;
    voiceTelemetry.log(String(this.session.dbSessionId || ''), String(this.session.userId || ''), 'greeting_retry_attempt', {
      cause, attempt, sessionId: this.session.dbSessionId, turnId: this.currentTurnId,
    });
    reportGreetingRetryAttempt({
      userId: String(this.session.userId || ''),
      sessionId: String(this.session.dbSessionId || ''),
      attempt,
    }).catch(() => {});
    this.sendWsMessage(this.session.ws, { type: 'greeting_retry', attempt, cause });
    this.greetingRetryTimer = setTimeout(() => {
      this.greetingRetryTimer = null;
      if (!this.isStopped && this.greetingDelivery.phase === 'queued') {
        this.sendGreetingTrigger(p.userName, p.isResumed, p.scenarioSlug, p.recentContext, p.studentProfile, { internalRetry: true });
      }
    }, 1500);
  }

  /**
   * Send a greeting trigger to Gemini Live to start the conversation.
   * Called from the `request_greeting` WS handler instead of orchestrator.processGreetingRequest().
   */
  sendGreetingTrigger(userName?: string, isResumed?: boolean, scenarioSlug?: string, recentContext?: string, studentProfile?: string, opts?: { internalRetry?: boolean }): void {
    if (!this.liveSession || this.isStopped) return;
    // ONE-SHOT GREETING GUARD: a greeting trigger may fire at most ONCE per GL session open.
    // Blocks all external duplicates (client 8s retry timer, client fast-retry on empty turn,
    // reconnect-scope resets of the ws-handler geminiLiveGreetingSent flag). Only the internal
    // silent-greeting auto-retry (verified no audio produced) passes opts.internalRetry.
    if (this.greetingTriggerFired && !opts?.internalRetry) {
      console.log('[GeminiLive] sendGreetingTrigger BLOCKED — one-shot guard: greeting already fired this GL session (only the internal silent-greeting retry may re-fire)');
      voiceTelemetry.log(String(this.session.dbSessionId || this.session.id), String(this.session.userId ?? ''), 'gl_greeting_duplicate_blocked', { turnId: this.currentTurnId });
      return;
    }
    // DOUBLE-AUDIO GUARD: if a greeting was already triggered via pendingGreetingTrigger
    // (fired at setupComplete), greetingPhaseActive is already true — skip the duplicate.
    if (this.greetingPhaseActive) {
      console.log('[GeminiLive] sendGreetingTrigger: greeting already in progress — skipping duplicate (prevents double audio)');
      return;
    }
    if (!opts?.internalRetry && !this.greetingDelivery.queue()) {
      console.log('[GeminiLive] Greeting intent ignored — already dispatched or delivered');
      return;
    }
    // Mark the one-shot guard armed for every dispatch path below (buffered, silent prime, spoken).
    this.greetingTriggerFired = true;
    // Store params so silent-greeting auto-retry can reuse them without the caller's closure.
    this.lastGreetingParams = { userName, isResumed, scenarioSlug, recentContext, studentProfile };
    const name = userName ? `, my name is ${userName}` : '';
    const langKey = (this.session.targetLanguage || '').toLowerCase().trim();
    const langName = this.session.targetLanguage
      ? this.session.targetLanguage.charAt(0).toUpperCase() + this.session.targetLanguage.slice(1)
      : 'Spanish';
    const tutorName = this.session.tutorName || 'Daniela';
    const langCode = LANGUAGE_TO_BCP47[langKey] || 'en-US';
    // Change 1 (Gemini audit 2026-06-17): Last State injection — explicit DO NOT GREET directive.
    // Gemini review follow-up: wrap recentContext in a temporal fence so the model treats it
    // as history, not the current moment. Add a first-word constraint for reliable suppression.
    // Change 3 (Gemini audit 2026-06-17): Bootstrap Turn — studentProfile in conversation history
    // position-0 (Hot Zone). Gemini review follow-up: use [SYSTEM NOTE:] framing so the model
    // treats it as metadata, not student speech (avoids role confusion).
    const contextBlock = isResumed && recentContext
      ? `\n\n[HISTORICAL CONTEXT FOR CONTINUITY ONLY — this already happened, do not re-greet or re-introduce:\n${recentContext}\nEND HISTORICAL CONTEXT]`
      : '';
    const resumed = isResumed
      ? `Do not greet me or re-introduce yourself — we are mid-conversation in ${langName}. The very first word of your response must be a natural continuation of the ${langName} flow, not a greeting.${contextBlock}`
      : `This is a new session — greet me warmly and start speaking in ${langName} right away. Your entire response must be in ${langName} (language code: ${langCode}).${studentProfile ? `\n\n[SYSTEM NOTE: ${studentProfile}]` : ''}`;
    const scenario = scenarioSlug ? ` We are doing a scenario: ${scenarioSlug}.` : '';
    const trigger = `Hello ${tutorName}${name}. ${resumed}${scenario}`;

    // MID-SESSION RECONNECT: when resuming with recent context, prime audio only — do NOT
    // generate a spoken greeting. Daniela re-introducing herself with "Honesty Mode, hmm I
    // like it..." on every 4.5-min cycle or server drop is disruptive. GL stays ready and
    // responds naturally when David speaks next.
    const isSilentReconnect = !!(isResumed && recentContext);

    // If setupComplete hasn't arrived yet, buffer — fired by handleServerMessage.
    if (!this.isSetupComplete) {
      this.pendingGreetingTrigger = trigger;
      this.pendingGreetingSilent = isSilentReconnect;
      this.pendingGreetingInternalRetry = !!opts?.internalRetry;
      console.log(`[GeminiLive] Greeting buffered — waiting for setupComplete (resumed: ${isResumed || false}, silent: ${isSilentReconnect})`);
      return;
    }

    if (!this.greetingDelivery.beginDispatch(!!opts?.internalRetry)) return;
    try {
      // Prime audio context — required on gemini-3.1-flash-live-preview.
      const silencePcm = Buffer.alloc(32000, 0); // 1s PCM16 LE at 16 kHz
      this.liveSession.sendRealtimeInput({
        audio: { data: silencePcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });

      if (isSilentReconnect) {
        console.log('[GeminiLive] Mid-session reconnect — silent audio prime only (no spoken greeting)');
        return;
      }

      this.liveSession.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: trigger }] }],
        turnComplete: true,
      });
      this._recordDirectLineageAttempt({
        sourceRoute: 'gemini-live',
        eventType: 'client_content_send_attempted',
        deliveryChannel: 'sendClientContent',
        deliveryStatus: 'attempted',
        payloadText: trigger,
        payloadJson: { purpose: 'greeting' },
      });
      // NOTE: activityEnd intentionally NOT sent here — same reasoning as setupComplete path.
      // sendClientContent with turnComplete:true already ends the turn. Sending activityEnd
      // after creates a SECOND turn-end signal and causes GL to generate a duplicate response.
      this.greetingPhaseActive = true;
      this.isGreetingTurn = true;
      // Safety: if greeting produces no audio (content filter / text-only / error),
      // greetingPhaseActive would never be cleared and the mic stays permanently blocked.
      // Force-clear after 15s — greeting audio normally arrives within 1-2s.
      if (this.greetingWatchdogTimer) clearTimeout(this.greetingWatchdogTimer);
      this.greetingWatchdogTimer = setTimeout(() => {
        this.greetingWatchdogTimer = null;
        if (this.greetingPhaseActive) {
          markGreetingNoAudio(this.greetingDelivery);
          this.greetingPhaseActive = false;
          this.isGreetingTurn = false;
          console.warn('[GeminiLive] Greeting watchdog fired — greetingPhaseActive cleared (no audio in 15s)');
          this.scheduleGreetingDeliveryRetry('watchdog');
        }
      }, 15000);
      // The queued intent is consumed only after both provider sends complete
      // without throwing. First audio remains the delivery acknowledgement.
      this.pendingGreetingTrigger = null;
      this.pendingGreetingSilent = false;
      this.pendingGreetingInternalRetry = false;
      console.log(`[GeminiLive] Greeting trigger sent (resumed: ${isResumed || false}) — silence primer + text turn, mic gated`);
    } catch (err) {
      this._recordContextLineage({
        sourceRoute: 'gemini-live',
        eventType: 'client_content_send_failed',
        deliveryChannel: 'sendClientContent',
        deliveryStatus: 'failed',
        payloadText: trigger,
        payloadJson: { purpose: 'greeting', error: err instanceof Error ? err.message : String(err) },
      });
      console.warn('[GeminiLive] Failed to send greeting trigger:', err);
      this.greetingTriggerFired = false;
      this.greetingDelivery.sendFailed();
      this.scheduleGreetingDeliveryRetry('send_throw');
    }
  }

  /**
   * Send a typed text turn to Gemini Live (e.g. from a PTT transcript).
   * Used when the client submits a push-to-talk recording and speculative STT
   * has already produced a transcript — we route it here so Gemini Live
   * generates the audio response instead of the legacy pipeline.
   */

  /**
   * Seals the current audio sub-turn with an empty isLast:true marker so the
   * progressive PCM player can finalize it and advance to the next sentence.
   *
   * Definitive response seals (generationComplete and its watchdog) add a 300ms
   * server-side silence pad before the marker. GL can emit turnComplete between
   * continuations, so padding those boundaries would add an avoidable 600ms gap
   * once the client's own trailing-silence buffer is included.
   */
  private sealCurrentAudioSubturn(label: string, withTailPad = false): void {
    if (!this.hadAudioInCurrentSubturn) return;
    if (withTailPad) {
      const TAIL_PAD_SEC = 0.3;
      const tailSilenceSamples = Math.round(TAIL_PAD_SEC * AUDIO_OUTPUT_SAMPLE_RATE);
      const tailSilenceBuffer = Buffer.alloc(tailSilenceSamples * 4, 0);
      this.sendWsMessage(this.session.ws, {
        type: 'audio_chunk',
        audio: tailSilenceBuffer.toString('base64'),
        audioFormat: 'pcm_f32le',
        sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
        turnId: this.currentTurnId,
        sentenceIndex: this.currentSentenceIndex,
        chunkIndex: this.currentChunkIndex++,
        isLast: false,
      });
    }
    this.sendWsMessage(this.session.ws, {
      type: 'audio_chunk',
      audio: '',
      audioFormat: 'pcm_f32le',
      sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
      turnId: this.currentTurnId,
      sentenceIndex: this.currentSentenceIndex,
      chunkIndex: this.currentChunkIndex,
      isLast: true,
    });
    this.currentSentenceIndex++;
    this.currentChunkIndex = 0;
    this.hadAudioInCurrentSubturn = false;
    console.log(`[GeminiLive] ${label}: audio sub-turn sealed (tailPad=${withTailPad}) — sentenceIndex now ${this.currentSentenceIndex}`);
    voiceTelemetry.log(this.session.dbSessionId ?? this.session.id, String(this.session.userId ?? ''), 'gl_audio_subturn_sealed', {
      label, withTailPad, sentenceIndex: this.currentSentenceIndex, turnId: this.currentTurnId,
    });
  }

  /**
   * Arms (or re-arms) the generationComplete watchdog timer.
   * Called on every audio chunk AND on thought-token arrival during active audio.
   * Thought tokens between audio sub-turns mean GL is still reasoning — resetting
   * here prevents premature turn-seal that would cut off Daniela mid-sentence.
   *
   * Timeout: 25s (was 12s). GL can have inter-chunk pauses >12s for complex
   * English responses with heavy reasoning — 25s gives a safe margin while still
   * recovering from a true dropped-completion-signal within a reasonable window.
   */
  private armGenerationCompleteWatchdog(): void {
    if (this.generationCompleteWatchdogTimer) {
      clearTimeout(this.generationCompleteWatchdogTimer);
    }
    this.generationCompleteWatchdogTimer = setTimeout(() => {
      this.generationCompleteWatchdogTimer = null;
      if (!this.isStopped && this.isTutorGeneratingAudio && this.hadAudioInCurrentSubturn) {
        console.warn('[GeminiLive] generationComplete watchdog fired — GL dropped the completion signal; sealing turn manually');
        voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_watchdog_timeout', {
          turnId: this.currentTurnId, isTutorGeneratingAudio: this.isTutorGeneratingAudio,
        });
        // Cancel any pending debounced seal — watchdog takes over
        if (this.generationCompleteSealTimer) {
          clearTimeout(this.generationCompleteSealTimer);
          this.generationCompleteSealTimer = null;
        }
        this.sealCurrentAudioSubturn('generationComplete-watchdog', true);
        this.recordCompletedExchangeAtGenerationBoundary('watchdog');
        this.isGenerationDone = true;
        this.isGreetingTurn = false;
        // Memory-loop counter reset: watchdog seal means audio WAS produced (same
        // condition as the generationComplete path). Reset so the next turn starts
        // with a clean consecutive-memory-call count. Without this, an interrupted
        // turn that produced audio would carry a stale non-zero counter into the next
        // turn, causing the nudge to fire too early.
        this.session.consecutiveMemoryCalls = 0;
        this.session.glMemoryNudgeSent = false;
        if (this.pendingPlaybackEndedLift) {
          console.log('[GeminiLive] Watchdog seal — retroactive onPlaybackEnded() (single-sentence path)');
          this.onPlaybackEnded();
        }
        if (this.playbackGateSafetyTimeout) clearTimeout(this.playbackGateSafetyTimeout);
        this.playbackGateSafetyTimeout = setTimeout(() => {
          this.playbackGateSafetyTimeout = null;
          if (this.isTutorGeneratingAudio) {
            this.isTutorGeneratingAudio = false;
            console.log('[GeminiLive] Mic gate force-opened — safety timeout after watchdog seal');
          }
        }, 60000);
        if (this.transcriptFlushTimer) { clearTimeout(this.transcriptFlushTimer); this.transcriptFlushTimer = null; }
        this.flushTranscripts().catch(err =>
          console.warn('[GeminiLive] Watchdog flush error:', err.message)
        );
      }
    }, 25000);
  }

  /**
   * Count the completed response for the current student utterance exactly once.
   *
   * activeStudentTurnEpoch advances only when a new student utterance begins.
   * Greeting/system generations have epoch 0, while tool continuations reuse the
   * same epoch. Counting here, rather than after transcript persistence, keeps
   * exchange totals accurate even when the persistence path fails or is cut off.
   */
  private recordCompletedExchangeAtGenerationBoundary(source: 'generationComplete' | 'watchdog'): boolean {
    const result = advanceCompletedExchangeForEpoch(
      this.lastCountedStudentTurnEpoch,
      this.activeStudentTurnEpoch,
    );
    if (!result.counted) {
      return false;
    }

    this.lastCountedStudentTurnEpoch = result.lastCountedStudentTurnEpoch;
    this.completedExchanges++;
    console.log(`[GeminiLive] Completed exchange counted at ${source} — student epoch ${this.activeStudentTurnEpoch}, total ${this.completedExchanges}`);
    return true;
  }

  /**
   * Silence-triggered directive heartbeat.
   * Started once setupComplete fires. Polls every 5 s.
   * Delivers any pending pedagogical directive via sendClientContent when:
   *   • A directive is waiting (set from thought-scan at generationComplete)
   *   • ≥15 s have elapsed since the last generationComplete (student is silent)
   *   • Daniela is not currently generating audio (no double-speak risk)
   * Clears the pending directive after delivery so it fires at most once.
   * A [SYSTEM — not spoken:] bracket prefix signals Daniela not to speak it verbatim —
   * the same convention used by the system whisper channel.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) return; // idempotent
    this.heartbeatInterval = setInterval(() => {
      if (this.isStopped || !this.liveSession) {
        clearInterval(this.heartbeatInterval!);
        this.heartbeatInterval = null;
        return;
      }
      if (!this.pendingDirectiveText) return;
      // Placement assessment active — flush any stored directive and stay silent.
      // Supervisor nudges are noise during assessment; heartbeat delivering one
      // mid-placement would break the "Daniela is just listening" dynamic.
      if ((this.session as any).placementMode?.active) {
        this.pendingDirectiveText = null;
        return;
      }
      const silenceMs = Date.now() - this.lastGenerationCompleteTime;
      if (silenceMs < 15000) return; // wait until ≥15 s of silence
      if (this.isTutorGeneratingAudio) return; // Daniela is mid-response — skip this tick
      const urgencyPrefix = this.pendingDirectiveUrgency === 'emergency' ? 'URGENT — ' : '';
      const msg = `[SYSTEM — not spoken: ${urgencyPrefix}${this.pendingDirectiveText}]`;
      const directive = this.pendingDirectiveText; // capture for logging
      try {
        this.liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: msg }] }],
          turnComplete: true,
        });
        this._recordDirectLineageAttempt({
          sourceRoute: 'gemini-live',
          eventType: 'client_content_send_attempted',
          deliveryChannel: 'sendClientContent',
          deliveryStatus: 'attempted',
          payloadText: msg,
          payloadJson: { purpose: 'heartbeat_directive' },
        });
        // Ghost-turn tracing: heartbeat directives trigger a new GL generation cycle.
        this.lastClientContentInjection = { label: 'heartbeat-directive', at: Date.now() };
        // Null ONLY on successful send — if the WebSocket throws, retry on the next 5s tick.
        this.pendingDirectiveText = null;
        console.log(`[GeminiLive] Heartbeat: silence-delivered directive (${silenceMs}ms silence): ${directive.slice(0, 80)}...`);
      } catch (err) {
        this._recordContextLineage({
          sourceRoute: 'gemini-live',
          eventType: 'client_content_send_failed',
          deliveryChannel: 'sendClientContent',
          deliveryStatus: 'failed',
          payloadText: msg,
          payloadJson: { purpose: 'heartbeat_directive', error: err instanceof Error ? err.message : String(err) },
        });
        console.warn('[GeminiLive] Heartbeat: failed to deliver directive, will retry next tick:', (err as Error).message);
      }
    }, 5000);
  }

  sendTextTurn(text: string, opts?: { label?: string; isStudentInput?: boolean }): boolean {
    if (!this.liveSession || this.isStopped) return false;
    // System Whisper (Gemini audit 2026-06-17 + review correction):
    // DO NOT prepend to student speech — Gemini review flagged this as a "read-aloud" failure risk
    // (GL may speak the reminder aloud if thinking phase is bypassed or prompt is misread).
    // Instead the whisper is injected via the next tool response (pendingSystemWhisper flag),
    // which is a safe channel the model sees but never speaks. See tool response assembly below.
    const label = opts?.label ?? 'text-turn';
    try {
      this.liveSession.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
      this._recordDirectLineageAttempt({
        sourceRoute: 'gemini-live',
        eventType: 'client_content_send_attempted',
        deliveryChannel: 'sendClientContent',
        deliveryStatus: 'attempted',
        payloadText: text,
        payloadJson: { purpose: label, isStudentInput: opts?.isStudentInput ?? false },
      });
      // Ghost-turn tracing: every turnComplete:true injection starts a new GL generation
      // cycle. Record the source so a suppressed ghost turn can name its trigger.
      this.lastClientContentInjection = { label, at: Date.now() };
      // Real student input (PTT transcript, prop tap) must open the double-generation
      // guard so the triggered response's audio is NOT suppressed. Directive/system
      // injections intentionally leave the flag false — any generation they trigger
      // is a ghost turn (audio suppressed + flush skipped).
      if (opts?.isStudentInput) {
        this.hasStudentInputSinceLastResponse = true;
      }
      console.log(`[GeminiLive] Text turn sent (${label}, ${text.length} chars): "${text.slice(0, 80)}"`);
      return true;
    } catch (err) {
      this._recordContextLineage({
        sourceRoute: 'gemini-live',
        eventType: 'client_content_send_failed',
        deliveryChannel: 'sendClientContent',
        deliveryStatus: 'failed',
        payloadText: text,
        payloadJson: { purpose: label, error: err instanceof Error ? err.message : String(err) },
      });
      console.warn('[GeminiLive] Failed to send text turn:', err);
      return false;
    }
  }

  /**
   * Inject a relay message from another agent (e.g. Luca) into the live GL
   * session. Delivered as a [SYSTEM — not spoken: from: message] user turn so
   * GL receives the context without speaking it verbatim. Uses the same channel
   * as the Archive Guardian injection path. Returns true only when sendClientContent
   * succeeds — propagates the actual send result rather than the precheck.
   */
  injectAgentRelay(from: string, message: string): boolean {
    if (!this.liveSession || this.isStopped) return false;
    const text = `[SYSTEM — not spoken: ${from}: ${message}]`;
    return this.sendTextTurn(text, { label: 'agent-relay' });
  }

  /**
   * Close the Gemini Live session cleanly.
   */
  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;
    // Cancel reconnect first: an intentional stop must never revive this
    // session through a retry that was queued before teardown began.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Do not make disconnect or audio teardown wait for diagnostic persistence.
    // A healthy recorder stops after the queued tail drains; a degraded recorder
    // keeps retrying so a known diagnostic gap is not silently discarded.
    const lineageRecorder = this.contextLineageRecorder;
    if (lineageRecorder) {
      void lineageRecorder.flushNow().then(() => {
        if (lineageRecorder.getHealth().pendingWrites === 0) {
          lineageRecorder.stop();
        }
      }).catch(() => {
        // ContextLineageRecorder already exposes write failure through health.
      });
    }
    this._finalizeOutstandingGuardianAttempts('Session stopped before the Guardian attempt reached a normal generation boundary.');
    this.resetInputTranscriptionFinalizationState();
    if (this.transcriptFlushTimer) {
      clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = null;
    }
    if (this.greetingWatchdogTimer) {
      clearTimeout(this.greetingWatchdogTimer);
      this.greetingWatchdogTimer = null;
    }
    // The playback gate safety timeout must be cleared on stop — otherwise it
    // fires 60 seconds after teardown on a dead session object, setting
    // isTutorGeneratingAudio=false after the session is already gone.
    if (this.playbackGateSafetyTimeout) {
      clearTimeout(this.playbackGateSafetyTimeout);
      this.playbackGateSafetyTimeout = null;
    }
    if (this.generationCompleteWatchdogTimer) {
      clearTimeout(this.generationCompleteWatchdogTimer);
      this.generationCompleteWatchdogTimer = null;
    }
    if (this.thoughtOnlyStallWatchdogTimer) {
      clearTimeout(this.thoughtOnlyStallWatchdogTimer);
      this.thoughtOnlyStallWatchdogTimer = null;
    }
    if (this.generationCompleteSealTimer) {
      clearTimeout(this.generationCompleteSealTimer);
      this.generationCompleteSealTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.liveSession) {
      try {
        this.liveSession.close();
      } catch (_) {}
      this.liveSession = null;
    }
    // Tear down karaoke tracker if active
    if (this.karaokeTracker) {
      this.karaokeTracker.destroy();
      this.karaokeTracker = null;
    }
    // Flush any unsaved transcripts on session end (e.g., user closes mid-response)
    this.flushTranscripts().catch(err =>
      console.warn('[GeminiLive] Final transcript flush error on stop:', err.message)
    );

    // GAME SESSION DETECTOR — auto-save a dedicated conversation_memory when the
    // session transcript contains a recognised game pattern. Fire-and-forget;
    // never blocks the stop() path. Skipped for incognito sessions (no persistence)
    // and sessions with fewer than 3 real exchanges (definitely not a game).
    if (!this.session.isIncognito && this.sessionExchangeLog.length >= 3) {
      const capturedExchanges = [...this.sessionExchangeLog];
      const capturedTutorName = this.session.tutorName || 'Daniela';
      const capturedLang = this.session.targetLanguage ?? 'spanish';
      const capturedUserId = this.session.userId;
      const capturedStudentName = this.lastGreetingParams?.userName;
      import('./gl-game-session-detector')
        .then(({ maybeAutoSaveGameSession }) =>
          maybeAutoSaveGameSession({
            exchanges: capturedExchanges,
            tutorName: capturedTutorName,
            targetLanguage: capturedLang,
            userId: capturedUserId,
            studentName: capturedStudentName,
          }),
        )
        .catch((err: any) => {
          console.warn('[GeminiLive] Game session detector error (non-fatal):', err?.message);
        });
    }

    // Shadow Auditor — fire-and-forget post-session transcript analysis.
    // Generates a session summary for compass continuity + suspends active loops.
    // Never blocks the stop() path. Skipped for incognito sessions (no persistence).
    if (this.session.conversationId) {
      observeSessionEnd(this.session.conversationId, {
        preserveDegradedLineage: Boolean(
          this.contextLineageRecorder
          && this.contextLineageRecorder.getHealth().pendingWrites > 0,
        ),
      });
    }
    // Persist the derived Guardian summary against the DB UUID. This is deliberately
    // awaited (with a bounded timeout) so stop() completion means the summary has
    // either been persisted or its failure has been made visible.
    await persistGuardianSummary({
      dbSessionId: this.session.dbSessionId,
      transientSessionId: this.session.id,
      fireLog: this.guardianFireLog,
      update: (sessionId, values) => getSharedDb()
        .update(voiceSessions)
        .set(values)
        .where(eq(voiceSessions.id, sessionId))
        .returning({ id: voiceSessions.id }),
    });
    if (!this.session.isIncognito && this.session.conversationId) {
      import('./shadow-auditor').then(({ runShadowAudit }) => {
        runShadowAudit({
          glSessionId: this.session.id,
          userId: this.session.userId,
          conversationId: this.session.conversationId,
          targetLanguage: this.session.targetLanguage,
          isFounderMode: !!(this.session as any).isFounderMode,
          isHonestyMode: !!(this.session as any).isRawHonestyMode,
          nativeLanguage: (this.session as any).nativeLanguage ?? 'english',
        }).catch(err =>
          console.warn('[GeminiLive] Shadow audit error:', err.message)
        );
      }).catch(err =>
        console.warn('[GeminiLive] Shadow audit import error:', err.message)
      );
    }

    console.log(`[GeminiLive] Session stopped — sessionId: ${this.session.id}`);
  }

  /**
   * One-tap retry — student-initiated restart after all auto-reconnect attempts fail.
   * Resets the attempt counter, resets per-session state, and calls start() again
   * with a fresh Context Bridge so Daniela resumes naturally.
   *
   * Called when the client sends gl_retry_start after receiving GEMINI_LIVE_DISCONNECTED.
   */
  async retryConnection(): Promise<void> {
    if (this.isStopped) {
      console.warn('[GeminiLive] retryConnection() called on stopped session — ignoring');
      return;
    }
    console.log('[GeminiLive] retryConnection() — student-initiated retry after exhausted attempts');

    // Capture handle/tool-call state BEFORE resetting — mirrors the auto-reconnect path.
    // If we had a resumption handle AND there were in-flight tool calls, GL may resume in
    // "waiting for tool response" state after reconnect. We send synthetic responses to
    // unblock it, exactly as the automatic reconnect path does (see onclose handler above).
    const hadHandle = !!this.session.geminiLiveResumptionHandle;
    const staleFunctionCallIds = [...this.pendingFunctionCallIds];
    this.pendingFunctionCallIds = [];

    // Reset auto-reconnect counter so the new attempt cycle starts fresh.
    this.reconnectAttempts = 0;

    // Reset all per-session flags (mirrors the reset block in the auto-reconnect path).
    this.isStarted = false;
    this.isSetupComplete = false;
    this.liveSession = null;
    // Advance, never reset (see the auto-reconnect path above).
    this.session.currentTurnId = ++this.currentTurnId;
    this.resetSubstantialReplayGuard();
    this.currentSentenceIndex = 0;
    this.currentChunkIndex = 0;
    this.lastSentenceStartSentIndex = -1;
    this.hadAudioInCurrentSubturn = false;
    this.transcriptClosed = false;
    this.afterGenerationComplete = false;
    this.isGenerationDone = false;
    this.pendingPlaybackEndedLift = false;
    this.usingOutputTranscription = false;
    this.firstAudioSentThisTurn = false;
    this.processingPendingSentThisTurn = false;
    this.generationStartedThisTurn = false;
    this.greetingPhaseActive = false;
    this.isTutorGeneratingAudio = false;
    this.hasStudentInputSinceLastResponse = false;
    this.responseFlushedToClient = false;
    if (this.playbackGateSafetyTimeout) {
      clearTimeout(this.playbackGateSafetyTimeout);
      this.playbackGateSafetyTimeout = null;
    }
    if (this.greetingWatchdogTimer) {
      clearTimeout(this.greetingWatchdogTimer);
      this.greetingWatchdogTimer = null;
    }
    this.pendingInputTranscript = '';
    this.pendingInputSaved = false;
    this.pendingOutputTranscript = '';
    if (this.transcriptFlushTimer) {
      clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = null;
    }

    // Tell the client we're reconnecting so it shows a spinner.
    this.sendWsMessage(this.session.ws, {
      type: 'gl_reconnecting',
      attempt: 1,
      maxAttempts: 1,
      delayMs: 0,
    });

    try {
      const reconnectPrompt = this.buildReconnectPrompt();
      await this.start(reconnectPrompt, this.lastTools);
      console.log('[GeminiLive] retryConnection() — GL session re-established successfully');

      // Tool Call Deadlock fix: mirrors the auto-reconnect path exactly.
      // If we resumed with a handle and there were in-flight tool calls, GL is now
      // silently waiting for those responses. Send synthetic error responses to unblock it.
      const sessionForUnblock = this.liveSession as Session | null;
      if (hadHandle && staleFunctionCallIds.length > 0 && sessionForUnblock) {
        try {
          const syntheticResponses: Array<{ id: string; name: string; response: GLToolResponsePayload }> =
            staleFunctionCallIds.map(id => ({
              id,
              name: 'unknown',
              response: { result: 'Session interrupted — tool response lost. Please continue naturally.' } satisfies GLToolResponsePayload,
            }));
          sessionForUnblock.sendToolResponse({ functionResponses: syntheticResponses });
          this._recordDirectLineageAttempt({
            sourceRoute: 'gemini-live',
            eventType: 'tool_response_send_attempted',
            deliveryChannel: 'sendToolResponse',
            deliveryStatus: 'attempted',
            payloadJson: { purpose: 'retry_reconnect_unblock', functionResponseCount: syntheticResponses.length },
          });
          console.log(`[GeminiLive] retryConnection() — sent ${staleFunctionCallIds.length} synthetic tool response(s) to unblock GL`);
        } catch (unblockErr) {
          this._recordContextLineage({
            sourceRoute: 'gemini-live',
            eventType: 'tool_response_send_failed',
            deliveryChannel: 'sendToolResponse',
            deliveryStatus: 'failed',
            payloadJson: { purpose: 'retry_reconnect_unblock', error: unblockErr instanceof Error ? unblockErr.message : String(unblockErr) },
          });
          console.warn('[GeminiLive] retryConnection() — failed to send synthetic tool responses:', unblockErr);
        }
      }

      this.sendWsMessage(this.session.ws, { type: 'gl_reconnected' });
    } catch (err: any) {
      console.error('[GeminiLive] retryConnection() — failed to re-establish GL session:', err?.message);
      this.sendWsMessage(this.session.ws, {
        type: 'voice_error',
        code: 'GEMINI_LIVE_DISCONNECTED',
        message: 'Daniela\'s voice session disconnected',
        recoverable: false,
      });
    }
  }

  private async handleServerMessage(msg: LiveServerMessage): Promise<void> {
    // ── Diagnostic: log the top-level keys of every message ─────────────────
    const msgKeys = Object.keys(msg).filter(k => (msg as any)[k] != null);
    if (!msg.usageMetadata && !msg.sessionResumptionUpdate) {
      const sc = msg.serverContent as any;
      const scKeys = sc ? Object.keys(sc).filter((k: string) => sc[k] != null) : [];
      console.log(`[GeminiLive] Server msg keys: [${msgKeys.join(', ')}]`, {
        hasTurnComplete: !!sc?.turnComplete,
        hasParts: !!sc?.modelTurn?.parts,
        partCount: sc?.modelTurn?.parts?.length ?? 0,
        serverContentKeys: scKeys,
        hasInputTranscription: !!sc?.inputTranscription,
        inputTranscriptionText: sc?.inputTranscription?.text?.slice(0, 80),
        hasOutputTranscription: !!sc?.outputTranscription,
        outputTranscriptionText: sc?.outputTranscription?.text?.slice(0, 80),
        hasInterrupted: !!sc?.interrupted,
        hasToolCall: !!msg.toolCall,
        hasError: !!(msg as any).error,
      });
    }

    // ── goAway — GL is asking the client to reconnect elsewhere ─────────────
    // Record the timestamp so onclose can treat the subsequent 1007 as retriable.
    // A 1007 after a goAway is not a genuine "invalid argument" — it's GL closing
    // after the graceful disconnect window, not a protocol error on our side.
    if ((msg as any).goAway != null) {
      this.lastGoAwayTimestamp = Date.now();
      this.handleGoAway((msg as any).goAway);
    }

    // ── Catch any top-level error from Gemini ────────────────────────────────
    if ((msg as any).error) {
      console.error('[GeminiLive] API error in message:', (msg as any).error);
    }

    // ── Setup complete — model is now ready to receive content ───────────────
    // The Gemini Live protocol requires waiting for setupComplete before sending
    // any client content turns. We buffer the greeting and fire it here so it
    // is never sent before the model is ready.
    if ((msg as any).setupComplete != null) {
      if (!this.isSetupComplete) {
        this.isSetupComplete = true;
        this.startHeartbeat();
        const establishMs = this.sessionStartedAt > 0 ? Date.now() - this.sessionStartedAt : null;
        console.log(`[GeminiLive] setupComplete received — model ready${establishMs !== null ? ` (${establishMs}ms to establish)` : ''}`);
        // Telemetry: GL session establishment latency (start() → setupComplete)
        if (establishMs !== null) {
          const estPayload = JSON.stringify({
            establishMs,
            sessionId: this.session.id,
            userId: this.session.userId ? String(this.session.userId) : undefined,
          });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events
              (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (
              gen_random_uuid(),
              ${this.session.id},
              ${this.session.userId ? String(this.session.userId) : null},
              'gl_session_established',
              ${estPayload}::jsonb,
              NOW()
            )
          `).catch(() => {});
        }
        if (this.pendingGreetingTrigger && this.liveSession) {
          const pendingWasInternalRetry = this.pendingGreetingInternalRetry;
          if (!beginQueuedGreetingDispatch(this.greetingDelivery, pendingWasInternalRetry)) return;
          let greetingDispatched = false;
          try {
            // Prime audio context — required on gemini-3.1-flash-live-preview.
            const silencePcm = Buffer.alloc(32000, 0); // 1s PCM16 LE at 16 kHz
            this.liveSession.sendRealtimeInput({
              audio: { data: silencePcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
            });

            if (this.pendingGreetingSilent) {
              // Mid-session reconnect: audio primed, but do NOT speak — Daniela will
              // respond naturally when David speaks next.
              console.log('[GeminiLive] Pending silent reconnect fired — audio prime only, no greeting');
            } else {
              // ── Identity thread pre-load ─────────────────────────────────────
              // NOTE: Intentionally NOT injected via sendClientContent here.
              // The identity threads are already baked into the system prompt via
              // the neural network context. Injecting them again as a conversation
              // turn using {role:'model', turnComplete:false} is documented broken
              // behaviour (line 193-200): GL interprets the incomplete model turn
              // as mid-utterance and generates a second audio stream to "complete"
              // it — producing an audible double greeting. System prompt is the
              // correct and sufficient delivery mechanism for identity context.
              if (this.identityThreads.length > 0) {
                console.log(`[GeminiLive] Identity threads (${this.identityThreads.length}) carried via system prompt — skipping sendClientContent injection (prevents double audio)`);
              }

              this.liveSession.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: this.pendingGreetingTrigger }] }],
                turnComplete: true,
              });
              this._recordDirectLineageAttempt({
                sourceRoute: 'gemini-live',
                eventType: 'client_content_send_attempted',
                deliveryChannel: 'sendClientContent',
                deliveryStatus: 'attempted',
                payloadText: this.pendingGreetingTrigger,
                payloadJson: { purpose: 'buffered_greeting' },
              });
              // NOTE: activityEnd is intentionally NOT sent here.
              // sendClientContent with turnComplete:true already signals end-of-turn to GL.
              // Sending activityEnd immediately after creates a SECOND turn-end signal,
              // causing GL to generate two responses (double greeting / double audio).
              // Block mic audio until GL sends its first response chunk.
              this.greetingPhaseActive = true;
              this.isGreetingTurn = true;
              // Arm the one-shot greeting guard: the greeting fired via the buffered
              // setupComplete path, so any later external sendGreetingTrigger is a duplicate.
              this.greetingTriggerFired = true;
              greetingDispatched = true;
              if (this.greetingWatchdogTimer) clearTimeout(this.greetingWatchdogTimer);
              this.greetingWatchdogTimer = setTimeout(() => {
                this.greetingWatchdogTimer = null;
                if (this.greetingPhaseActive) {
                  markGreetingNoAudio(this.greetingDelivery);
                  this.greetingPhaseActive = false;
                  this.isGreetingTurn = false;
                  console.warn('[GeminiLive] Greeting watchdog fired — greetingPhaseActive cleared (no audio in 15s)');
                  this.scheduleGreetingDeliveryRetry('watchdog');
                }
              }, 15000);
              console.log('[GeminiLive] Pending greeting fired — silence primer + thread pre-load + text turn + activityEnd sent, mic gated');
            }
          } catch (err) {
            this._recordContextLineage({
              sourceRoute: 'gemini-live',
              eventType: 'client_content_send_failed',
              deliveryChannel: 'sendClientContent',
              deliveryStatus: 'failed',
              payloadText: this.pendingGreetingTrigger,
              payloadJson: { purpose: 'buffered_greeting', error: err instanceof Error ? err.message : String(err) },
            });
            console.warn('[GeminiLive] Failed to send pending greeting:', err);
            this.greetingTriggerFired = false;
            this.greetingDelivery.sendFailed();
            this.scheduleGreetingDeliveryRetry('send_throw');
          }
          if (greetingDispatched || this.pendingGreetingSilent) {
            this.pendingGreetingTrigger = null;
            this.pendingGreetingSilent = false;
            this.pendingGreetingInternalRetry = false;
          }
        }
      }
    }

    // ── Audio output ────────────────────────────────────────────────────────
    if (msg.serverContent?.modelTurn?.parts) {
      this.replayGuard.beginResponse();
      // Earliest signal that GL has started generating — set before any audio/transcription
      // arrives so the carry-forward guard catches the race window.
      if (!this.generationStartedThisTurn) {
        this.generationStartedThisTurn = true;
      }
      // New model turn arriving — reopen the transcript gate so this sub-turn's
      // outputTranscription is allowed through. turnComplete/generationComplete will
      // close it again at the end of this sub-turn.
      // NOTE: do NOT reset usingOutputTranscription here — it must persist within
      // a full response (across sub-turns) so part.text stays suppressed once
      // outputTranscription has become the authoritative source.
      this.transcriptClosed = false;
      let audioParts = 0;
      let textParts = 0;
      // Pre-scan: does this message contain any audio parts?
      // Text-only messages are GL's internal planning notes — never send to client.
      const messageHasAudio = msg.serverContent.modelTurn.parts.some(
        (p: any) => p.inlineData?.data && p.inlineData.mimeType?.includes('audio')
      );
      for (const part of msg.serverContent.modelTurn.parts) {
        if (part.inlineData?.data && part.inlineData.mimeType?.includes('audio')) {
          // Double-generation guard (July 27 2026): GL sometimes generates the same response
          // twice — the "Bug 1 gate" removal on July 24 unmasked this. If no student input has
          // arrived since the last response ended and we are not in the greeting phase, this
          // audio is spurious. Suppress it here rather than letting it reach the client.
          // Legitimate multi-part continuations are safe: those arrive while isTutorGeneratingAudio
          // is still true (student hasn't spoken, but generation hasn't ended either), so they
          // never hit this path — they reach the debounce extension path instead.
          if (!this.isTutorGeneratingAudio && !this.greetingPhaseActive && !this.hasStudentInputSinceLastResponse) {
            console.warn('[GeminiLive] Spurious GL audio — no student input since last response; suppressing double-generation (turnId:', this.currentTurnId, ')');
            continue;
          }
          // Double-generation guard — part 2: response_complete already sent to the client
          // for this turn (the flush debounce fired), so the response is definitively done.
          // Any new GL audio without new student input is a spurious re-generation, even if
          // isTutorGeneratingAudio is still true (client hasn't reported playback_ended yet).
          // This closes the window that part-1 misses: second audio arriving while the first
          // stream is still playing but AFTER response_complete was flushed.
          // Safe for multi-part continuations: those arrive before the debounce seal fires,
          // so responseFlushedToClient is still false when the continuation chunks arrive.
          if (this.responseFlushedToClient && !this.greetingPhaseActive && !this.hasStudentInputSinceLastResponse) {
            console.warn('[GeminiLive] Spurious GL audio after response_complete — suppressing double-generation during playback (turnId:', this.currentTurnId, ')');
            continue;
          }
          // Bug 1 gate REMOVED (July 24 2026): the drop gate was intended to suppress GL
          // tail-filler sub-turns ("ok"/"hey") that arrive after generationComplete. However,
          // GL also fires generationComplete between legitimate sub-turns of a multi-part
          // response — so the gate was silently dropping the continuation and causing the
          // "then nothing" cut-off mid-sentence. Tail filler (short phrase at turn end) is a
          // minor annoyance; a cut-off mid-clause is a conversation-breaking bug. Gate removed.
          // Gate-clear: if a new generating turn starts after playback_ended, reset the flag.
          if (this.afterGenerationComplete && !this.isTutorGeneratingAudio) {
            this.afterGenerationComplete = false;
            // Also cancel any pending seal from the previous generationComplete — this is a
            // genuinely new turn, not a continuation, so we don't want to seal the old turn.
            if (this.generationCompleteSealTimer) {
              clearTimeout(this.generationCompleteSealTimer);
              this.generationCompleteSealTimer = null;
            }
          }
          // Continuation of same turn: more audio arrived after generationComplete fired
          // (GL sent genComplete while chunks were still in-flight). Reset the debounce
          // timer so we don't seal early and cut off the trailing words.
          if (this.afterGenerationComplete && this.isTutorGeneratingAudio && (this.generationCompleteSealTimer || !this.isFlushInProgress)) {
            if (this.generationCompleteSealTimer) clearTimeout(this.generationCompleteSealTimer);
            this.generationCompleteSealTimer = setTimeout(() => {
              this.generationCompleteSealTimer = null;
              if (!this.isStopped) {
                this.sealCurrentAudioSubturn('generationComplete-debounce-extended', true);
                // Flush AFTER seal (same reasoning as the initial debounce callback):
                // keeps per-response reset from firing prematurely on in-flight chunks.
                this.flushTranscripts().catch(err =>
                  console.warn('[GeminiLive] generationComplete flush error (extended):', err.message)
                );
              }
            }, 800);
            console.log('[GeminiLive] generationComplete seal deferred — audio still arriving after premature generationComplete');
          }
          audioParts++;
          this.hadAudioInCurrentSubturn = true;
          this.lastAudioChunkAt = Date.now();
          // First audio from GL — open the greeting gate, activate the turn gate.
          // greetingPhaseActive → false: student can now speak.
          // isTutorGeneratingAudio → true: mic gated for the duration of this response
          // to prevent Daniela's audio echoing back through the speaker and confusing GL.
          const wasGreetingPhase = this.greetingPhaseActive;
          if (this.greetingDelivery.phase === 'dispatched' || this.greetingDelivery.phase === 'queued') {
            acknowledgeFirstGreetingAudio(
              this.greetingDelivery,
              () => {
                if (this.greetingRetryTimer) clearTimeout(this.greetingRetryTimer);
                this.greetingRetryTimer = null;
              },
              () => {
                if (this.greetingWatchdogTimer) clearTimeout(this.greetingWatchdogTimer);
                this.greetingWatchdogTimer = null;
              },
            );
            this.pendingGreetingTrigger = null;
            this.pendingGreetingSilent = false;
            this.pendingGreetingInternalRetry = false;
          }
          if (this.greetingPhaseActive) {
            this.greetingPhaseActive = false;
            console.log('[GeminiLive] Greeting gate lifted — first audio chunk received from GL');
          }
          // Real audio arrived — the thought-only stall watchdog no longer applies to
          // this turn (GL was just thinking before speaking, not actually stalled).
          if (this.thoughtOnlyStallWatchdogTimer) {
            clearTimeout(this.thoughtOnlyStallWatchdogTimer);
            this.thoughtOnlyStallWatchdogTimer = null;
          }
          if (!this.isTutorGeneratingAudio) {
            this.isTutorGeneratingAudio = true;
            // Reset double-generation guard only after the greeting is fully done.
            // Use wasGreetingPhase (captured above, before greetingPhaseActive was cleared)
            // because this.greetingPhaseActive was already set to false at line 1930 —
            // reading it here would always see false on the first chunk and wrongly reset.
            if (!wasGreetingPhase) {
              this.hasStudentInputSinceLastResponse = false;
            }
            // This is the start of a new response — clear the post-generationComplete gate
            // so legitimate next-turn audio isn't blocked.
            this.afterGenerationComplete = false;
            // Clear the response-flushed guard so this generation can pass through.
            this.responseFlushedToClient = false;
            console.log('[GeminiLive] Mic gated — Daniela is generating audio (echo suppression active)');
          }

          // Reset generationComplete watchdog on every audio chunk.
          // Extracted into armGenerationCompleteWatchdog() — also called on thought
          // tokens during active audio so inter-chunk reasoning doesn't trip the seal.
          this.armGenerationCompleteWatchdog();

          // Flush accumulated user input the moment model starts generating audio
          // (user is definitely done speaking at this point).
          if (!this.pendingInputSaved && this.pendingInputTranscript.trim()) {
            this.pendingInputSaved = true;
            const userText = this.pendingInputTranscript.trim();
            this.pendingInputTranscript = '';
            this.persistMessage('user', userText).catch(err =>
              console.warn('[GeminiLive] Failed to persist user transcript:', err.message)
            );
          }

          const pcm16Buffer = Buffer.from(part.inlineData.data, 'base64');
          const f32leBuffer = pcm16ToF32le(pcm16Buffer);
           if (this.replayGuard.shouldDropPcm(pcm16Buffer.length / 2 / AUDIO_OUTPUT_SAMPLE_RATE * 1000)) {
             const pcmTelemetry = this.replayGuard.telemetry;
             voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_substantial_replay_pcm_dropped', {
               turnId: this.currentTurnId,
               matchedTokens: 20,
               ...pcmTelemetry,
             });
             continue;
           }

          // ── Karaoke tap ────────────────────────────────────────────────
          // Feed the raw PCM16 to Deepgram in parallel so it can return
          // word-level timestamps while audio plays on the client.
           this.karaokeTracker?.sendAudioChunk(
             pcm16Buffer,
             this.currentSentenceIndex,
             this.currentTurnId,
           );

          // Mark that audio has started for this turn — prevents late outputTranscription
          // chunks from firing a spurious processing_pending AFTER audio has played.
          //
          // ALSO: fire processing_pending on the first audio chunk of CONVERSATION turns
          // (not the greeting). outputAudioTranscription is enabled and will fire
          // outputTranscription chunks, but audio typically arrives before the transcription
          // text. This is the reliable fallback: the moment the first audio arrives we know
          // GL is responding and the avatar should show thinking briefly (it flips to speaking
          // within the same render cycle in practice).
          if (!this.firstAudioSentThisTurn) {
            this.firstAudioSentThisTurn = true;
            const now = Date.now();

            // ── Flush pending whiteboard updates ───────────────────────────
            // Function calls (show_image, add_to_scene, etc.) buffer their
            // whiteboard updates until audio starts, so images arrive in sync
            // with speech. In the GeminiLive path, audio bypasses the
            // orchestrator's sendMessage, so the orchestrator's flush logic
            // never fires. We flush here instead — at the exact moment the
            // first audio chunk arrives.
            if (this.session.pendingWhiteboardUpdates && this.session.pendingWhiteboardUpdates.length > 0) {
              const pending = this.session.pendingWhiteboardUpdates;
              this.session.pendingWhiteboardUpdates = [];
              console.log(`[GeminiLive] Flushing ${pending.length} pending whiteboard update(s) on first audio`);
              for (const update of pending) {
                this.sendWsMessage(this.session.ws, update);
              }
            }
            this.session.firstAudioSent = true; // keep orchestrator flag in sync

            // ── Student speaking duration ──────────────────────────────────
            // Student stopped speaking when Daniela's first audio arrives.
            if (!wasGreetingPhase && this.studentSpeakingStartTime !== null) {
              this.studentSpeakingMs += now - this.studentSpeakingStartTime;
              this.studentSpeakingStartTime = null;
            }

            // ── Turn latency ───────────────────────────────────────────────
            // Latency = time from last inputTranscription chunk → first Daniela audio.
            // This measures "how long after GL finished hearing the student did it start speaking".
            if (!wasGreetingPhase && this.lastInputTranscriptionTime !== null) {
              const latencyMs = now - this.lastInputTranscriptionTime;
              if (latencyMs >= 0 && latencyMs < 30000) { // sanity: 0ms–30s window
                this.turnLatencies.push(latencyMs);
                console.log(`[GeminiLive] Turn latency: ${latencyMs}ms (last-word → first audio)`);
              }
              this.lastInputTranscriptionTime = null;
              // System Whisper counter — increment on each completed non-greeting conversation turn.
              // When threshold reached, arm pendingSystemWhisper — it fires on the next tool call
              // response (a safe channel that is never spoken aloud). Gemini review correction:
              // prepending to student speech risks the reminder being read aloud in GL.
              this.conversationTurnCount++;
              this.turnsSinceLastWhisper++;
              // Hybrid whisper trigger: fire on turns >= 8 OR if >= 5 min since last whisper.
              // Turns alone are a poor proxy for voice time: rapid vocab drill = 8 turns in 60s
              // (over-whispered); deep debate = 8 turns in 15 min (under-whispered).
              // lastWhisperTime = 0 means no whisper has fired yet; use session startTime as origin.
              if (!this.greetingPhaseActive) {
                const whisperOriginMs = this.lastWhisperTime || (this.session.startTime || Date.now());
                const msSinceLastWhisper = Date.now() - whisperOriginMs;
                const byTurn = this.turnsSinceLastWhisper >= GeminiLiveSession.WHISPER_INTERVAL;
                const byTime = msSinceLastWhisper >= GeminiLiveSession.WHISPER_MIN_INTERVAL_MS;
                if (byTurn || byTime) {
                  this.pendingSystemWhisper = true;
                  this.turnsSinceLastWhisper = 0;
                  console.log(`[GeminiLive] System Whisper armed — ${byTime ? 'time-triggered' : 'turn-triggered'} (${Math.round(msSinceLastWhisper / 60000)}min / turn ${this.conversationTurnCount})`);
                }
              }
            }
            this.turnLatencyStartTime = null;

            // ── Tutor speaking start ───────────────────────────────────────
            if (!wasGreetingPhase) {
              this.tutorSpeakingStartTime = now;
            }

            if (!wasGreetingPhase && !this.processingPendingSentThisTurn) {
              this.processingPendingSentThisTurn = true;
              if (this.suppressNextProcessingPending) {
                // DOUBLE-AUDIO FIX: Client already reset via gl_audio_reset — don't
                // send processing_pending again (would trigger a second resetForNewTurn).
                console.log('[GeminiLive] Suppressing processing_pending after mid-turn reconnect (gl_audio_reset already sent)');
                this.suppressNextProcessingPending = false;
              } else {
                console.log('[GeminiLive] Firing processing_pending (first audio chunk, conversation turn)');
                voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_processing_pending_fired', {
                  path: 'audio_first', turnId: this.currentTurnId,
                });
                this.sendWsMessage(this.session.ws, {
                  type: 'processing_pending',
                  timestamp: Date.now(),
                });
              }
            }
          }

          // Emit sentence_start for the first audio chunk of each sentence so the subtitle
          // state creates a sentence entry that word_timing_delta (GL karaoke) can attach to.
          if (this.currentSentenceIndex !== this.lastSentenceStartSentIndex && this.session.subtitleMode !== 'off') {
            this.lastSentenceStartSentIndex = this.currentSentenceIndex;
            this.sendWsMessage(this.session.ws, {
              type: 'sentence_start',
              turnId: this.currentTurnId,
              sentenceIndex: this.currentSentenceIndex,
              text: '',
              hasTargetContent: true,
            });
          }
           this.sendWsMessage(this.session.ws, {
             type: 'audio_chunk',
             audio: f32leBuffer.toString('base64'),
             audioFormat: 'pcm_f32le',
             sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
             turnId: this.currentTurnId,
             sentenceIndex: this.currentSentenceIndex,
             chunkIndex: this.currentChunkIndex++,
             isLast: false,
           });
        }

        // ── Thought parts (includeThoughts: true) ────────────────────────────
        // Thought parts carry Daniela's pre-response reasoning. They arrive BEFORE
        // the first audio chunk and have { thought: true, text: "..." }.
        // Because they also have part.text, they would otherwise fall through to the
        // text branch below and be forwarded to the client — this guard prevents that.
        // Accumulated server-side for the pedagogical supervisor; never sent to client.
        if ((part as any).thought === true) {
          if (part.text) {
            this.currentTurnThoughtBuffer += part.text;
          }
          // If audio has already started this turn, thought tokens between sub-turns
          // mean GL is still reasoning — reset the generationComplete watchdog so
          // inter-chunk thinking doesn't trigger a premature turn-seal / audio cutoff.
          if (this.isTutorGeneratingAudio) {
            this.armGenerationCompleteWatchdog();
          }
          // Arm/reset the thought-only stall watchdog. If audio or turnComplete
          // never follows within 10s, seal the turn manually instead of letting
          // it hang until the idle/grace-period reaper kills the whole session.
          if (this.thoughtOnlyStallWatchdogTimer) {
            clearTimeout(this.thoughtOnlyStallWatchdogTimer);
          }
          this.thoughtOnlyStallWatchdogTimer = setTimeout(() => {
            this.thoughtOnlyStallWatchdogTimer = null;
            if (!this.isStopped && !this.isTutorGeneratingAudio) {
              console.warn('[GeminiLive] thought-only stall watchdog fired — GL reasoned but never produced audio/text/turnComplete; sealing turn manually');
              voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_thought_stall', {
                thoughtBuffer: this.currentTurnThoughtBuffer.slice(0, 200),
              });
              glLiveAlert({
                sessionId: this.session.id,
                userId: this.session.userId ?? '',
                lang: this.session.targetLanguage,
                eventType: 'thought_stall',
                detail: { thoughtBuffer: this.currentTurnThoughtBuffer.slice(0, 120) },
              });
              this.currentTurnThoughtBuffer = '';
              this.isGenerationDone = true;
              if (this.pendingPlaybackEndedLift) {
                this.onPlaybackEnded();
              }
              if (this.isTutorGeneratingAudio) {
                this.isTutorGeneratingAudio = false;
              }
              if (this.transcriptFlushTimer) { clearTimeout(this.transcriptFlushTimer); this.transcriptFlushTimer = null; }
              this.flushTranscripts().catch(err =>
                console.warn('[GeminiLive] Thought-stall watchdog flush error:', err.message)
              );
            }
          }, 10000);
          // Skip all further processing for this part — thought content is supervisor-only
          continue;
        }

        // Model text output — emitted when TEXT is included in responseModalities.
        // Accumulate into pendingOutputTranscript so the assistant's full reply is
        // persisted to the DB on generationComplete / turnComplete flush.
        // GUARD 1: skip text-only messages (messageHasAudio=false) — these are GL's
        // internal planning notes / chain-of-thought and must never reach the client.
        // GUARD 2: skip if outputTranscription has already become the authoritative source
        // for this turn. When GL sends BOTH part.text AND outputTranscription with the same
        // content, accumulating both causes 2–3x repetition in the saved DB message.
        if (part.text) {
          if (this.replayGuard.isSuppressed()) continue;
          textParts++;
          if (messageHasAudio || this.hadAudioInCurrentSubturn) {
            if (!this.usingOutputTranscription) {
              // outputTranscription hasn't fired yet — accumulate from part.text as a
              // provisional source. It will be discarded if outputTranscription arrives.
              this.pendingOutputTranscript += part.text;
            }
            // Always forward the real-time text to the client for subtitle display,
            // regardless of which accumulation source is active.
            this.sendWsMessage(this.session.ws, {
              type: 'response_text',
              text: part.text,
              turnId: this.currentTurnId,
            });
          } else {
            console.log('[GeminiLive] Suppressed text-only model part (internal monologue):', part.text.slice(0, 120));
          }
        }
      }
      if (audioParts > 0 || textParts > 0) {
        console.log(`[GeminiLive] Parts processed — audio: ${audioParts}, text: ${textParts}, turnId: ${this.currentTurnId}`);
      } else {
        console.warn(`[GeminiLive] modelTurn had ${msg.serverContent.modelTurn.parts.length} part(s) but none had audio or text`);
        for (const part of msg.serverContent.modelTurn.parts) {
          const partKeys = Object.keys(part).filter(k => (part as any)[k] != null);
          console.warn(`[GeminiLive] Part keys: [${partKeys.join(', ')}]`, part.inlineData?.mimeType ?? '(no mimeType)');
        }
      }
    }

    // ── Input transcription (what the user said) ─────────────────────────────
    // inputTranscription fires per word/phrase as Gemini transcribes the user's speech.
    // We accumulate all chunks and only persist once (when model starts generating),
    // avoiding word-by-word rows in the messages table.
    if ((msg.serverContent as any)?.inputTranscription?.text) {
      const text = (msg.serverContent as any).inputTranscription.text as string;
      if (text.trim()) {
        // A new utterance makes every prior carry-forward grounding result stale.
        // Never merge a previous topic into a newer student turn: it turns an
        // honest archive check into a subject change.
        const turnBoundary = registerInputTranscriptionChunk(
          this.startNewStudentTurnOnNextInputTranscription,
          this.activeStudentTurnEpoch,
          this.unfinalizedStudentTurnEpochs,
        );
        this.activeStudentTurnEpoch = turnBoundary.activeStudentTurnEpoch;
        this.startNewStudentTurnOnNextInputTranscription =
          turnBoundary.startNewStudentTurnOnNextInputTranscription;
        const startsNewStudentUtterance = turnBoundary.startedNewStudentUtterance;
        if (startsNewStudentUtterance) {
          this.currentStudentTurnBoundaryTrusted = this.nextStudentTurnBoundaryTrusted;
          this.nextStudentTurnBoundaryTrusted = true;
          for (const waiter of this.inputTranscriptionFinalizationWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.resolve(false);
          }
          this.pendingInputTranscript = '';
          this.activeStudentUtterance = '';
          this.activeContextLineageTraceId = this._getContextLineageRecorder()?.beginTrace() ?? null;
          this.activeStudentTurnLineageEventId = null;
          this.activeContextLineageStreamProxyEventId = null;
          const inputCallbackId = this._recordFactualStreamCallback('input_transcription', text);
          this.activeStudentTurnLineageEventId = this._recordContextLineage({
            traceId: this.activeContextLineageTraceId ?? undefined,
            studentTurnEpoch: this.activeStudentTurnEpoch,
            sourceRoute: 'gemini-live',
            eventType: 'student_turn_started',
            payloadText: text,
          });
          if (
            inputCallbackId
            && this.activeStudentTurnLineageEventId
            && this.activeContextLineageTraceId
          ) {
            this._linkContextLineage({
              traceId: this.activeContextLineageTraceId,
              fromEventId: inputCallbackId,
              toEventId: this.activeStudentTurnLineageEventId,
              linkType: 'produced_response',
            });
          }
          if (
            this.pendingPriorTurnGrounding
            && this.pendingPriorTurnGrounding.eligibleStudentTurnEpoch !== this.activeStudentTurnEpoch
          ) {
            console.warn(
              `[ArchiveGuardian] Expiring dormant prior-turn grounding from student turn `
              + `${this.pendingPriorTurnGrounding.binding.studentTurnEpoch} at student turn `
              + `${this.activeStudentTurnEpoch}.`,
            );
            this._traceGuardianAttempt(this.pendingPriorTurnGroundingAttemptId, {
              type: 'stale_discarded',
              detail: 'Dormant prior-turn grounding expired after its one-turn window.',
            });
            this.pendingPriorTurnGrounding = null;
            this.pendingPriorTurnGroundingAttemptId = null;
          }
          if (this.pendingCarryForwardGrounding) {
            console.warn(
              `[PreTurnGuardian] Discarding stale carry-forward grounding from student turn `
              + `${this.pendingCarryForwardGroundingBinding?.studentTurnEpoch ?? 'unknown'}; current turn is `
              + `${this.activeStudentTurnEpoch}.`,
            );
            this._traceGuardianAttempt(this.pendingCarryForwardGroundingAttemptId, {
              type: 'stale_discarded',
              detail: 'A newer student utterance began before carry-forward delivery.',
            });
            this.pendingCarryForwardGrounding = null;
            this.pendingCarryForwardGroundingBinding = null;
            this.pendingCarryForwardGroundingAttemptId = null;
          }
          if (this.pendingWeeOoGrounding && this.pendingWeeOoGroundingBinding) {
            const stagedPrior = createPriorTurnGroundingCorrection(
              this.pendingWeeOoGrounding,
              this.pendingWeeOoGroundingBinding,
              this.activeStudentTurnEpoch,
            );
            if (stagedPrior) {
              if (
                this.pendingPriorTurnGroundingAttemptId
                && this.pendingPriorTurnGroundingAttemptId !== this.pendingWeeOoGroundingAttemptId
              ) {
                this._traceGuardianAttempt(this.pendingPriorTurnGroundingAttemptId, {
                  type: 'superseded',
                  detail: 'A newer prior-turn correction replaced this dormant correction.',
                });
              }
              this.pendingPriorTurnGrounding = stagedPrior;
              this.pendingPriorTurnGroundingAttemptId = this.pendingWeeOoGroundingAttemptId;
              console.log(
                `[ArchiveGuardian] Staging prior-turn grounding from student turn `
                + `${this.pendingWeeOoGroundingBinding.studentTurnEpoch} as dormant for turn `
                + `${this.activeStudentTurnEpoch}.`,
              );
            } else {
              console.warn(
                '[ArchiveGuardian] Discarding prior-turn grounding before a newer student utterance.',
              );
              this._traceGuardianAttempt(this.pendingWeeOoGroundingAttemptId, {
                type: 'stale_discarded',
                detail: 'A newer student utterance began before tool-response delivery.',
              });
            }
            this.pendingWeeOoGrounding = null;
            this.pendingWeeOoGroundingBinding = null;
            this.pendingWeeOoGroundingAttemptId = null;
            this.slideCorrectionQueued = false;
          } else if (this.pendingWeeOoGrounding) {
            console.warn(
              '[ArchiveGuardian] Discarding prior-turn grounding before a newer student utterance.',
            );
            this._traceGuardianAttempt(this.pendingWeeOoGroundingAttemptId, {
              type: 'stale_discarded',
              detail: 'A newer student utterance began before tool-response delivery.',
            });
            this.pendingWeeOoGrounding = null;
            this.pendingWeeOoGroundingBinding = null;
            this.pendingWeeOoGroundingAttemptId = null;
            this.slideCorrectionQueued = false;
          }
        }

        // Track student speech timing: start on first chunk, update last-word timestamp each chunk
        const inputNow = Date.now();
        if (this.studentSpeakingStartTime === null) {
          this.studentSpeakingStartTime = inputNow;
        }
        this.lastInputTranscriptionTime = inputNow;
        this.pendingInputTranscript += text;
        this.activeStudentUtterance += text;
        this.pendingInputSaved = false;
        if (!startsNewStudentUtterance) {
          this._recordFactualStreamCallback('input_transcription', text);
        }

        // Friction Score — first-input timing: measure pre-speech pause (generationComplete → first word)
        if (this.currentTurnFirstInputMs === 0 && this.studentTurnStartMs > 0) {
          this.currentTurnFirstInputMs = inputNow;
          const pauseMs = inputNow - this.studentTurnStartMs;
          if (pauseMs > 200 && pauseMs < 30000) { // sanity bounds: ignore instant/30s+
            this.recentPreSpeechPauses.push(pauseMs);
            if (this.recentPreSpeechPauses.length > GeminiLiveSession.FRICTION_WINDOW) {
              this.recentPreSpeechPauses.shift();
            }
          }
        }
        // Friction Score — accumulate word count for this student turn
        const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
        this.currentTurnInputWords += wordCount;

        // Friction Score — internal silence: detect pauses BETWEEN chunks within a single turn.
        // Mid-sentence gaps > 2s signal vocabulary search (more predictive than pre-speech pause).
        if (this.lastInputChunkMs > 0) {
          const midGapMs = inputNow - this.lastInputChunkMs;
          if (midGapMs > 2000 && midGapMs < 20000) { // 2s–20s sanity window
            this.currentTurnMidPauses++;
          }
        }
        this.lastInputChunkMs = inputNow;

        // ── Carry-forward staging ──────────────────────────────────────────
        // Any carry-forward grounding from a previous utterance was discarded above.
        // Grounding never crosses the utterance boundary.
        if (this.pendingCarryForwardGrounding) {
          console.log(`[PreTurnGuardian] Carry-forward staged for merge with this turn's guardian (${this.pendingCarryForwardGrounding.length} chars)`);
        }

        // ── Pre-turn Archive Guardian ──────────────────────────────────────
        // Scan the accumulating student transcript for memory-risk phrases.
        // Fire grounding async immediately on first match — by the time GL
        // dispatches Daniela's first tool call (~400-600ms later), the DB
        // lookup (~100-300ms) will already have resolved.
        // preTurnGroundingFired prevents re-firing within the same student turn.
        // Universal pre-turn Archive Guardian — fires on every student turn (not just memory-risk phrases).
        // Nothing happens without searching the Archive. Semantic search handles general utterances;
        // keyword-phase fallback in runAutoGrounding handles targeted phrases.
        // Gate opens when either:
        //   (a) the generic threshold is met (>10 chars for any utterance), OR
        //   (b) an emotional-valence phrase is detected regardless of length — short
        //       disclosures like "I froze" (7 chars) must not be silently skipped.
        const _emotionalEarlyCheck = !this.preTurnGroundingFired
          ? detectStudentEmotionalValence(this.pendingInputTranscript)
          : null;
        const _guardianShouldFire = !this.preTurnGroundingFired && (
          this.pendingInputTranscript.trim().length > 10 ||
          (_emotionalEarlyCheck?.detected ?? false)
        );
        if (_guardianShouldFire) {
          this.preTurnGroundingFired = true;
          const userId = String((this.session as any).userId || '');
          const conversationId = (this.session as any).conversationId;
          const targetLanguage = (this.session as any).targetLanguage;
          // Detect memory-risk phrase for logging; reuse early emotional check if available.
          const risk = detectStudentMemoryRisk(this.pendingInputTranscript);
          const emotional = _emotionalEarlyCheck ?? detectStudentEmotionalValence(this.pendingInputTranscript);
          const queryText = this.pendingInputTranscript.trim();
          // The lookup searches the exact candidate claim, but keeps the full utterance
          // bound alongside it. A result may never outlive this pairing.
          const candidateAssertion = (risk.detected ? risk.topic : null) || queryText;
          const groundingBinding = createGroundingTurnBinding(
            this.activeStudentTurnEpoch,
            queryText,
            candidateAssertion,
          );
          groundingBinding.traceId = this.activeContextLineageTraceId;
          this.preTurnGroundingBinding = groundingBinding;
          this.preTurnGuardianLineageEventId = this._recordContextLineage({
            traceId: groundingBinding.traceId ?? undefined,
            sourceRoute: 'archive-guardian',
            eventType: 'context_lookup_started',
            studentTurnEpoch: groundingBinding.studentTurnEpoch,
            payloadText: groundingBinding.candidateAssertion,
            deliveryStatus: 'queued',
          });
          const preTurnGuardianLineageEventId = this.preTurnGuardianLineageEventId;
          const preTurnStudentLineageEventId = this.activeStudentTurnLineageEventId;
          let preTurnGroundingLineageEventId: string | null = null;
          if (
            preTurnStudentLineageEventId
            && preTurnGuardianLineageEventId
            && groundingBinding.traceId
          ) {
            this._linkContextLineage({
              traceId: groundingBinding.traceId,
              fromEventId: preTurnStudentLineageEventId,
              toEventId: preTurnGuardianLineageEventId,
              linkType: 'caused_by',
            });
          }
          const preTurnAttemptId = this._startGuardianAttempt('pre-turn', groundingBinding);
          this.preTurnGroundingAttemptId = preTurnAttemptId;
          const logLabel = emotional.detected
            ? `emotional valence "${emotional.valencePhrase}"`
            : risk.detected
              ? `phrase "${risk.riskPhrase}" → "${candidateAssertion.slice(0, 45)}"`
              : `universal ("${queryText.slice(0, 50)}")`;
          this.preTurnGroundingIsEmotional = emotional.detected;
          this.preTurnIsNamedRecord = NAMED_RECORD_PHRASES.some(
            p => queryText.toLowerCase().includes(p)
          );
          console.log(`[PreTurnGuardian] Firing — ${logLabel}`);
          this.guardianFireLog.push({ ts: new Date().toISOString(), path: 'pre-turn', phrase: logLabel.slice(0, 60), charsInjected: null, channel: null, outcome: null, groundingPreview: null, attemptId: preTurnAttemptId });
          this._observeGuardian();

          const promise = runAutoGrounding(
            userId,
            groundingBinding.candidateAssertion,
            'memory_assertion',
            conversationId,
            targetLanguage,
            { writeToDb: false, notifyLuca: false, postToTeamRoom: false },
          );
          this.preTurnGroundingPromise = promise;

          promise.then(result => {
            if (
              this.isStopped
              || this.preTurnGroundingBinding !== groundingBinding
              || !isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)
            ) {
              console.warn(
                `[PreTurnGuardian] Discarding stale grounding result for "${groundingBinding.candidateAssertion.slice(0, 60)}" `
                + `(student turn ${groundingBinding.studentTurnEpoch}).`,
              );
              this._traceGuardianAttempt(preTurnAttemptId, {
                type: 'stale_discarded',
                detail: 'Lookup resolved after its bound student turn was no longer current.',
              });
              const staleEventId = this._recordContextLineage({
                traceId: groundingBinding.traceId ?? undefined,
                sourceRoute: 'archive-guardian',
                eventType: 'context_stale_discarded',
                studentTurnEpoch: groundingBinding.studentTurnEpoch,
                payloadText: result,
                deliveryStatus: 'discarded',
              });
              if (preTurnGuardianLineageEventId && staleEventId && groundingBinding.traceId) {
                this._linkContextLineage({
                  traceId: groundingBinding.traceId,
                  fromEventId: preTurnGuardianLineageEventId,
                  toEventId: staleEventId,
                  linkType: 'superseded_by',
                });
              }
              return;
            }
            this.preTurnGroundingResult = result;
            preTurnGroundingLineageEventId = this._recordContextLineage({
              traceId: groundingBinding.traceId ?? undefined,
              sourceRoute: 'archive-guardian',
              eventType: 'context_prepared',
              studentTurnEpoch: groundingBinding.studentTurnEpoch,
              payloadText: result,
              deliveryStatus: 'queued',
            });
            // Keep the current-turn field for synchronous tool-response assembly,
            // but all asynchronous lineage links below use captured local IDs.
            this.preTurnGroundingLineageEventId = preTurnGroundingLineageEventId;
            if (
              preTurnGuardianLineageEventId
              && preTurnGroundingLineageEventId
              && groundingBinding.traceId
            ) {
              this._linkContextLineage({
                traceId: groundingBinding.traceId,
                fromEventId: preTurnGuardianLineageEventId,
                toEventId: preTurnGroundingLineageEventId,
                linkType: 'derived_from',
              });
            }
            this._traceGuardianAttempt(preTurnAttemptId, {
              type: 'lookup_completed',
              detail: `${result.length} characters returned from Archive lookup.`,
            });
            this._traceGuardianAttempt(preTurnAttemptId, {
              type: 'queued',
              channel: 'tool-response',
              detail: 'Awaiting a Gemini tool-response batch for safe delivery.',
            });
            // Fill groundingPreview on the fire log entry so observe bench shows what was found.
            const previewEntry = this.guardianFireLog.findLast(e => e.path === 'pre-turn' && e.groundingPreview === null);
            if (previewEntry) {
              previewEntry.groundingPreview = result ? result.slice(0, 150) : '[empty — well is deep]';
              this._observeGuardian();
            }
            console.log(`[PreTurnGuardian] Grounding resolved (${result.length} chars) — queued for this turn`);

            // Immediate fallback: if no tool call has claimed the result
            // within 150ms, inject via sendClientContent (no turnComplete —
            // queues as context, not a forced generation). This beats the
            // audio start window for fast no-tool-call turns.
            //
            // Late-arrival handling (A/B switch — _globalPreTurnFallbackMode):
            //   'carry-forward' (default): if Daniela has already started generating
            //     (processingPendingSentThisTurn || firstAudioSentThisTurn), buffer the
            //     result for injection at the START of the next student turn instead.
            //     GL is receiving student audio then — not generating — so no interrupted: true.
            //   'interrupt': fire sendClientContent regardless; GL sees it as a barge-in
            //     (interrupted: true) and restarts Daniela's response. Grounding is
            //     guaranteed this turn at the cost of audible cut-offs.
            setTimeout(() => {
              if (this.isStopped || !this.liveSession) return;
              if (
                this.preTurnGroundingBinding !== groundingBinding
                || !isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)
              ) {
                console.warn(
                  `[PreTurnGuardian] Skipping stale fallback for "${groundingBinding.candidateAssertion.slice(0, 60)}" `
                  + `(student turn ${groundingBinding.studentTurnEpoch}).`,
                );
                this._traceGuardianAttempt(preTurnAttemptId, {
                  type: 'stale_discarded',
                  detail: 'Fallback was reached after a newer student turn replaced this lookup.',
                });
                return;
              }

              // Gemini audit Aug 6 2026: consume lucaCtx BEFORE the early exit so a slow
              // pre-turn DB lookup can't silently discard a prior-turn correction.
              // [PRIOR TURN CONTEXT] is the approved neutral label — archive data surfaced
              // by the Guardian, not an external voice. [LUCA — COLLEAGUE NOTE] was
              // rejected: dishonest framing that causes persona drift (Daniela treats Luca
              // as source-of-truth for her own memory).
              const convIdForLuca = (this.session as any).conversationId as string | undefined;
              const lucaCtx = convIdForLuca ? consumeLucaSessionContext(convIdForLuca) : null;

              // Only exit if we have absolutely nothing to say.
              if (this.preTurnGroundingResult === null && !lucaCtx && !this.pendingCarryForwardGrounding) return;

              const lateArrival = !!(this.processingPendingSentThisTurn || this.firstAudioSentThisTurn || this.generationStartedThisTurn);
              if (lateArrival && _globalPreTurnFallbackMode === 'carry-forward') {
                // Gemini audit Aug 6 2026: lucaCtx was already consumed from the store above.
                // If we just return here, it's permanently lost. Merge it into the carry-forward
                // buffer so it reaches Daniela on the next turn alongside the grounding.
                // Fix: seed from preTurnGroundingResult first, then merge any already-buffered
                // pendingCarryForwardGrounding — don't overwrite it when preTurnGroundingResult is null.
                let carryBuffer = this.preTurnGroundingResult || '';
                if (this.pendingCarryForwardGrounding) {
                  // Preserve previously buffered carry-forward; merge with fresh grounding.
                  carryBuffer = carryBuffer
                    ? `${carryBuffer}\n\n[ARCHIVE GUARDIAN — CARRIED FROM PRIOR TURN: ${this.pendingCarryForwardGrounding}]`
                    : this.pendingCarryForwardGrounding;
                }
                if (lucaCtx) {
                  carryBuffer = carryBuffer
                    ? `[PRIOR TURN CONTEXT: ${lucaCtx}]\n${carryBuffer}`
                    : lucaCtx;
                }
                this.pendingCarryForwardGrounding = carryBuffer;
                this.pendingCarryForwardGroundingBinding = groundingBinding;
                this.pendingCarryForwardGroundingAttemptId = preTurnAttemptId;
                this._traceGuardianAttempt(preTurnAttemptId, {
                  type: 'queued',
                  channel: 'tool-response',
                  detail: 'Late lookup result moved to carry-forward buffer.',
                });
                this.preTurnGroundingResult = null;
                this.preTurnGroundingBinding = null;
                this.preTurnGroundingAttemptId = null;
                const cfPreview = this.pendingCarryForwardGrounding.slice(0, 150);
                console.log(`[PreTurnGuardian] Late arrival — carrying forward to next turn (${this.pendingCarryForwardGrounding.length} chars, mode=carry-forward${lucaCtx ? ', +lucaCtx' : ''})`);
                this.guardianFireLog.push({ ts: new Date().toISOString(), path: 'carry-forward-buffered', phrase: 'late arrival — buffered for next turn', charsInjected: null, channel: null, outcome: null, groundingPreview: cfPreview, attemptId: preTurnAttemptId });
                this._observeGuardian();
                return;
              }

              // Build whisper parts conditionally — Gemini audit: avoid "The well is deep"
              // alongside a PRIOR TURN CONTEXT (contradictory confidence signals to the model).
              // Parts ordered by priority: prior-turn correction → carried context → current grounding.
              const finalParts: string[] = [];
              const cfLen = this.pendingCarryForwardGrounding?.length ?? 0;

              // Part A: Prior Turn Context (highest priority — fixes a specific prior error).
              // Deduplicate: skip if pre-turn grounding already covers the same content.
              // FIX: use this.preTurnGroundingResult, not 'result' (which is the closure var
              // from the .then() but may differ — preTurnGroundingResult is the source of truth).
              const lucaCtxDeduped = (lucaCtx && this.preTurnGroundingResult?.includes(lucaCtx.substring(0, 50))) ? null : lucaCtx;
              if (lucaCtxDeduped) {
                finalParts.push(`[PRIOR TURN CONTEXT: ${lucaCtxDeduped}]`);
              }

              // Part B: Carried context from the previous turn.
              if (this.pendingCarryForwardGrounding) {
                finalParts.push(`[ARCHIVE GUARDIAN — CARRIED FROM LAST TURN: ${this.pendingCarryForwardGrounding}]`);
              }

              // Part C: Current pre-turn grounding. It is the only grounding result
              // allowed to define this response's subject.
              if (
                this.preTurnGroundingResult !== null
                && this.preTurnGroundingBinding
                && isGroundingBindingCurrent(this.preTurnGroundingBinding, this.activeStudentTurnEpoch)
              ) {
                const currentGrounding = formatCurrentTurnGroundingContext(
                  this.preTurnGroundingBinding,
                  this.preTurnGroundingResult,
                );
                if (this.preTurnGroundingIsEmotional) {
                  // Student shared something vulnerable — frame as relational history, not factual recall.
                  // The goal is for Daniela to feel the weight of the student's disclosure and reach for
                  // her own history of being present with students in exactly this kind of moment.
                  finalParts.push(`[ARCHIVE GUARDIAN — STUDENT SHARED SOMETHING PERSONAL: A student just disclosed something vulnerable — embarrassment, self-doubt, or fear. Your archive holds the threads that make this response witnessed, not just accurate.\n${currentGrounding}]`);
                } else {
                  finalParts.push(currentGrounding);
                }
              } else if (!lucaCtxDeduped && !this.pendingCarryForwardGrounding) {
                // Only show "The well is still" if we truly have nothing else — not alongside a correction.
                // Named Record requests (episode, pull up, our first, etc.) get a directive; all other
                // turns keep the gentle form so normal conversation flow isn't interrupted.
                if (this.preTurnIsNamedRecord) {
                  finalParts.push(`[ARCHIVE GUARDIAN: The well is deep and still — no memories surfaced automatically. The person is asking for a Named Record. You do not have it in front of you yet. Do not guess. Call recall or search_memories now before responding.]`);
                } else {
                  finalParts.push(`[ARCHIVE GUARDIAN: The well is deep and still. No specific memories surface. Trust your intuition.]`);
                }
              }

              const whisperFinal = finalParts.join('\n\n');
              const cfNote = cfLen ? ` (+${cfLen}ch carry-forward)` : '';
              const lucaNote = lucaCtxDeduped ? ` +${lucaCtxDeduped.length}ch prior-turn` : '';

              // Emotional-valence fast path: when the student has shared something vulnerable
              // and no tool call has fired yet by the 150ms window, inject the grounding
              // directly via sendClientContent (turnComplete: false). This reaches Daniela
              // on purely conversational emotional turns where she would otherwise answer
              // from pattern-match with no archive access.
              // Safe because: !lateArrival means generation has not started; turnComplete:false
              // queues this as context without triggering a new GL generation turn.
              const noToolCallYet = this.currentTurnToolCalls.length === 0;
              if (this.preTurnGroundingIsEmotional && !lateArrival && noToolCallYet && whisperFinal.length > 0) {
                try {
                  this.liveSession.sendClientContent({
                    turns: [{ role: 'user', parts: [{ text: whisperFinal }] }],
                    turnComplete: false,
                  });
                  const directSendEventId = this._recordDirectLineageAttempt({
                    traceId: groundingBinding.traceId ?? undefined,
                    studentTurnEpoch: groundingBinding.studentTurnEpoch,
                    sourceRoute: 'archive-guardian',
                    eventType: 'client_content_send_attempted',
                    deliveryChannel: 'sendClientContent',
                    payloadText: whisperFinal,
                    deliveryStatus: 'attempted',
                  });
                  if (
                    directSendEventId
                    && preTurnGroundingLineageEventId
                    && groundingBinding.traceId
                  ) {
                    this._linkContextLineage({
                      traceId: groundingBinding.traceId,
                      fromEventId: preTurnGroundingLineageEventId,
                      toEventId: directSendEventId,
                      linkType: 'sent_with',
                    });
                  }
                } catch (error) {
                  const failedSendEventId = this._recordContextLineage({
                    traceId: groundingBinding.traceId ?? undefined,
                    studentTurnEpoch: groundingBinding.studentTurnEpoch,
                    sourceRoute: 'archive-guardian',
                    eventType: 'client_content_send_failed',
                    deliveryChannel: 'sendClientContent',
                    deliveryStatus: 'failed',
                    payloadText: whisperFinal,
                    payloadJson: { purpose: 'pre_turn_emotional', error: error instanceof Error ? error.message : String(error) },
                  });
                  if (failedSendEventId && preTurnGroundingLineageEventId && groundingBinding.traceId) {
                    this._linkContextLineage({
                      traceId: groundingBinding.traceId,
                      fromEventId: preTurnGroundingLineageEventId,
                      toEventId: failedSendEventId,
                      linkType: 'sent_with',
                    });
                  }
                  console.warn('[PreTurnGuardian] Emotional direct context dispatch failed:', error);
                  return;
                }
                // Ghost-turn tracing: turnComplete:false should NOT start a generation,
                // but record it anyway — if a ghost turn follows, this names the suspect.
                this.lastClientContentInjection = { label: 'pre-turn-guardian-emotional', at: Date.now() };
                this._traceGuardianAttempt(preTurnAttemptId, {
                  type: 'injected',
                  channel: 'send-client-content',
                  modelTurnId: this.currentTurnId,
                  toolBatchSequence: this.toolCallBatchSequence,
                  detail: 'Emotional-valence grounding sent through sendClientContent.',
                });
                // Update the pre-turn fire log entry with delivery details.
                const preTurnEntry = this.guardianFireLog.findLast(e => e.path === 'pre-turn' && e.charsInjected === null);
                if (preTurnEntry) {
                  preTurnEntry.charsInjected = whisperFinal.length;
                  preTurnEntry.channel = 'pre-turn-sendclientcontent';
                  this._observeGuardian();
                }
                this.pendingCarryForwardGrounding = null;
                this.pendingCarryForwardGroundingBinding = null;
                this.pendingCarryForwardGroundingAttemptId = null;
                this.preTurnGroundingResult = null;
                this.preTurnGroundingBinding = null;
                this.preTurnGroundingAttemptId = null;
                console.log(`[PreTurnGuardian] Emotional valence — injected directly via sendClientContent (pre-turn, ${whisperFinal.length} chars${cfNote}${lucaNote})`);
                return;
              }

              // Default path: sendClientContent is unsafe for mid-session injection —
              // turnComplete:true triggers duplicate generation; turnComplete:false leaves
              // an open turn that cuts Daniela short.
              // Store in pendingWeeOoGrounding so tool-result channel delivers it safely.
              this._replacePendingWeeOoGrounding(
                whisperFinal,
                groundingBinding,
                preTurnAttemptId,
                'A newer pre-turn Guardian payload replaced this queued payload before delivery.',
              );
              this._traceGuardianAttempt(preTurnAttemptId, {
                type: 'queued',
                channel: 'tool-response',
                detail: 'Pre-turn grounding queued for safe tool-response delivery.',
              });
              this.pendingCarryForwardGrounding = null;
              this.pendingCarryForwardGroundingBinding = null;
              this.pendingCarryForwardGroundingAttemptId = null;
              this.preTurnGroundingResult = null;
              this.preTurnGroundingBinding = null;
              this.preTurnGroundingAttemptId = null;
              const label = lateArrival ? 'interrupt mode — late arrival' : 'queued for tool channel';
              console.log(`[PreTurnGuardian] Grounding queued for tool channel (${label}${cfNote}${lucaNote}, ${whisperFinal.length} chars)`);
            }, 150);
          }).catch(err => {
            this._traceGuardianAttempt(preTurnAttemptId, {
              type: 'lookup_failed',
              detail: (err as Error).message,
            });
            console.warn('[PreTurnGuardian] runAutoGrounding failed:', (err as Error).message);
          });
        }

        // Emotional-valence re-scan — runs on every transcript chunk after the grounding has
        // already fired. Handles short disclosures like "I feel stupid" (13 chars) that crossed
        // the guardian fire threshold (>10 chars) before reaching the emotional detection minimum
        // (15 chars). preTurnGroundingFired prevents re-firing grounding; this only updates the
        // emotional flag so the correct injection label is used when the result is delivered.
        if (this.preTurnGroundingFired && !this.preTurnGroundingIsEmotional) {
          const emotionalRecheck = detectStudentEmotionalValence(this.pendingInputTranscript);
          if (emotionalRecheck.detected) {
            this.preTurnGroundingIsEmotional = true;
            console.log(`[PreTurnGuardian] Emotional valence detected on re-scan — phrase: "${emotionalRecheck.valencePhrase}"`);
          }
        }

        // DO NOT fire processing_pending here — inputTranscription arrives while the user
        // is still mid-sentence (GL transcribes in real-time). Showing the thinking avatar
        // at this point makes the user believe they've been cut off, causing them to stop
        // talking, which then triggers an actual cutoff. processing_pending is now fired
        // on the first outputTranscription chunk — the true "you've finished, she's
        // generating" signal.

        // Forward each chunk to the client for interim display (subtitle / transcript bar)
        this.sendWsMessage(this.session.ws, {
          type: 'transcript',
          text,
          isFinal: true,
          source: 'gemini_live',
        });
      }
    }
    if ((msg.serverContent as any)?.inputTranscription?.finished) {
      const finalizedEpoch = consumeNextUnfinalizedStudentTurnEpoch(
        this.unfinalizedStudentTurnEpochs,
      );
      if (finalizedEpoch !== null) {
        this.finalizedStudentTurnEpoch = finalizedEpoch;
        const remainingWaiters: typeof this.inputTranscriptionFinalizationWaiters = [];
        for (const waiter of this.inputTranscriptionFinalizationWaiters) {
          if (waiter.expectedEpoch === finalizedEpoch) {
            clearTimeout(waiter.timer);
            waiter.resolve(true);
          } else if (waiter.expectedEpoch < finalizedEpoch) {
            clearTimeout(waiter.timer);
            waiter.resolve(false);
          } else {
            remainingWaiters.push(waiter);
          }
        }
        this.inputTranscriptionFinalizationWaiters = remainingWaiters;
      }
    }

    // ── Output transcription (what Daniela said) ─────────────────────────────
    // outputTranscription fires per-chunk (streaming tokens) — accumulate here.
    // Checked BEFORE turnComplete so if both arrive in the same message, the
    // final chunk is appended to the buffer before the flush occurs.
    if ((msg.serverContent as any)?.outputTranscription?.text) {
      this._recordFactualStreamCallback(
        'output_transcription',
        (msg.serverContent as any).outputTranscription.text as string,
      );
      // Ghost-transcription guard — two complementary layers:
      //
      // Layer 1 (signal-based, Gemini audit rec.): transcriptClosed is set by
      // generationComplete / turnComplete / interrupted signals. Any transcription
      // arriving after these definitive end-of-turn events is residual buffering.
      //
      // Layer 2 (timer-based, original fix): if audio was flowing but stopped >800ms ago,
      // GL's audio budget likely ran out — suppress transcription that outran the audio.
      //
      // Both layers are needed: Layer 1 handles clean turn-end; Layer 2 handles mid-turn
      // audio budget exhaustion where no end signal has arrived yet.
      const audioSilenceMs = this.lastAudioChunkAt > 0 ? Date.now() - this.lastAudioChunkAt : 0;
      const ghostBySignal = this.transcriptClosed;
      const ghostByTimer = this.hadAudioInCurrentSubturn && audioSilenceMs > 800;
      if (ghostBySignal || ghostByTimer) {
        const rawGhost = (msg.serverContent as any).outputTranscription.text as string;
        const reason = ghostBySignal ? 'transcript closed by signal' : `audio silent ${audioSilenceMs}ms`;
        console.log(`[GeminiLive] Suppressed ghost outputTranscription (${reason}):`, rawGhost.slice(0, 100));
      } else {
      // Strip markdown bold markers (**) and any native function-call syntax that
      // Gemini Live leaks into outputTranscription (e.g. `vocal_adjust{emotion:warm,...}`).
      // These are internal tool calls and must never appear in student-facing transcripts.
      const rawText = (msg.serverContent as any).outputTranscription.text as string;
      const text = rawText
        .replace(/\*\*/g, '')
        .replace(/\b\w+\{[^{}]*\}/g, '')   // strip tool call syntax: name{key:val,...}
        .replace(/\w*thought\nThinking Process[\s\S]*/i, '')  // strip GL thinking blocks (e.g. "wasthought\nThinking Process:...")
        .replace(/([.!?])thought\n[\s\S]*/i, '$1')           // fallback: strip after sentence-end punct
        .replace(/\s{2,}/g, ' ');           // collapse double-spaces left by removal
        // NOTE: do NOT trimStart unconditionally — GL streaming chunks naturally include a
        // leading space between words. Stripping it causes words to run together when chunks
        // are concatenated (e.g. "Take" + "a" → "Takea"). Only trim on the first chunk so
        // the saved transcript does not start with a leading space.
      if (text.trim()) {
        // Fire processing_pending on the FIRST output chunk. This is the definitive signal
        // that GL has finished listening to the user and is now generating a response.
        // Firing it earlier (on inputTranscription) caused the user to see the thinking
        // avatar while still speaking and stop talking prematurely.
        // GUARD: skip if audio already started — a late transcription chunk arriving after
        // audio has played would stick the avatar in "thinking" with no audio to follow.
        const isFirstOutputChunk = !this.usingOutputTranscription;
        if (isFirstOutputChunk) {
          // Switch to outputTranscription as the authoritative accumulation source.
          // If part.text was already accumulated this turn, discard it — outputTranscription
          // carries the same content but with proper streaming boundaries. Keeping both
          // would double (or triple) the text stored in the DB message.
          if (this.pendingOutputTranscript.trim()) {
            console.log('[GeminiLive] Switching to outputTranscription source — discarding part.text accumulation to prevent duplicate text');
          }
          this.pendingOutputTranscript = '';
          this.usingOutputTranscription = true;
        }
        const acceptedText = this.appendOutputTranscriptChunk(isFirstOutputChunk ? text.trimStart() : text);
        // Use the accepted text for client subtitles and downstream hard-wall
        // checks; the factual stream callback above remains untouched.
        const acceptedTranscriptText = acceptedText;
        if (acceptedTranscriptText) {
        // Hard wall: watch for memory assertion phrases without Archive access mid-output.
        // Flag for post-turn correction injection at generationComplete.
        if (!this.hardWallTriggered && this.pendingOutputTranscript.length > 20) {
          const lowerOut = this.pendingOutputTranscript.toLowerCase();
          const HW_PHRASES = ['i remember', 'i recall', 'you told me', 'you mentioned', 'we discussed', 'as we discussed', 'you shared', 'last time we'];
          const hwMatch = HW_PHRASES.find(p => lowerOut.includes(p));
          if (hwMatch) {
            const ARCHIVE_TOOLS = new Set(['introspect', 'recall', 'unified_recall', 'search_conversation_threads', 'read_my_reflections', 'grounding_query']);
            if (!this.currentTurnToolCalls.some(t => ARCHIVE_TOOLS.has(t))) {
              this.hardWallTriggered = true;
              console.warn(`[HardWall] Slide mid-output — phrase: "${hwMatch}", tools: [${this.currentTurnToolCalls.join(', ') || 'none'}]`);
              this.guardianFireLog.push({ ts: new Date().toISOString(), path: 'hard-wall', phrase: hwMatch, charsInjected: null, channel: null, outcome: null, groundingPreview: null });
              this._observeGuardian();
            }
          }
        }
        if (isFirstOutputChunk && !this.firstAudioSentThisTurn && !this.processingPendingSentThisTurn) {
          this.processingPendingSentThisTurn = true;
          console.log('[GeminiLive] Firing processing_pending (transcription first, before audio)');
          voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_processing_pending_fired', {
            path: 'transcript_first', turnId: this.currentTurnId,
          });
          this.sendWsMessage(this.session.ws, {
            type: 'processing_pending',
            timestamp: Date.now(),
          });
        } else if (isFirstOutputChunk) {
          console.log('[GeminiLive] Skipping processing_pending — already sent or audio started this turn');
        }
        this.sendWsMessage(this.session.ws, {
          type: 'daniela_transcript',
          text: acceptedTranscriptText,
          turnId: this.currentTurnId,
        });
        }
      }
      } // end else (not ghost transcription)
    }

    // ── Turn complete ────────────────────────────────────────────────────────
    // Gemini Live fires turnComplete after each sub-turn (phrase/sentence), not just
    // at the true end of the full response. We handle two concerns separately:
    //
    //  1. AUDIO: send isLast:true for the current sentence so the progressive PCM
    //     player can start rendering it. Increment sentenceIndex so the NEXT
    //     sub-turn's audio is queued as a new sentence (not overwriting chunkIndex 0).
    //
    //  2. TRANSCRIPTS: debounce 800 ms — only persist user + assistant text once the
    //     model has truly stopped generating (no more turnComplete events incoming).
    //     This produces one DB row per utterance instead of one per phrase.
    if (msg.serverContent?.turnComplete) {
      // NOTE: transcriptClosed is NOT set here. Setting it on every sub-turn turnComplete was
      // cutting off outputTranscription chunks that arrived slightly after turnComplete due to
      // network buffering — producing truncated DB messages ("...and how nice", "...the real,").
      // The gate is now only closed by generationComplete (definitive end-of-response) and
      // interrupted (barge-in). Audio sub-turn sealing (isLast:true) still happens here.
      // H1 fix: clear greeting gate on turnComplete (covers no-audio greeting paths).
      if (this.greetingPhaseActive) {
        // Detect silent greeting: no audio produced in this sub-turn and sentence index still 0.
        // Exclude intentional silent resumes (isResumed + recentContext = prime-only, no spoken greeting by design).
        const isSilentGreeting = !this.hadAudioInCurrentSubturn && this.currentSentenceIndex === 0
          && !this.lastGreetingParams?.isResumed;
        if (isSilentGreeting) this.greetingDelivery.noAudio();
        this.greetingPhaseActive = false;
        if (this.greetingWatchdogTimer) { clearTimeout(this.greetingWatchdogTimer); this.greetingWatchdogTimer = null; }

        if (isSilentGreeting) {
          this.scheduleGreetingDeliveryRetry('turn_complete');
        } else {
          console.log('[GeminiLive] turnComplete — greeting gate cleared (no audio path)');
        }
      }
      // ── Audio: close current sentence, prepare next ──────────────────────
      // GL can emit turnComplete between continuation sub-turns. Seal the sentence
      // boundary without a server-side tail pad so the client does not accumulate a
      // 600ms pause (server pad + its own trailing-silence buffer) mid-response.
      // Definitive generationComplete/watchdog seals use the tail pad instead.
      if (this.hadAudioInCurrentSubturn) {
        this.sealCurrentAudioSubturn('turnComplete', false);
        this.karaokeTracker?.onSentenceComplete();
      }

      // ── Transcripts: debounced flush (FALLBACK only) ─────────────────────
      // GL 3.1 fires turnComplete after EACH sub-turn, not just the final one.
      // It also fires generationComplete at the definitive end of the full response.
      // The generationComplete handler (below) cancels this timer and does the real flush.
      //
      // This timer is therefore a FALLBACK for the rare case where generationComplete
      // is dropped by GL (known transient failure). It must be long enough that:
      //  - A subsequent sub-turn's turnComplete arrives and resets it, OR
      //  - generationComplete arrives and cancels it
      // before it fires. If this fired at 800ms and the next sub-turn was 1-2s later,
      // the flush would reset processingPendingSentThisTurn + firstAudioSentThisTurn,
      // making sub-turn 2 look like a brand-new turn — firing processing_pending again,
      // resetting the PCM player mid-response, and snapping the avatar to "thinking".
      // 8000ms gives GL ample time for slow inter-sub-turn reasoning gaps.
      if (this.transcriptFlushTimer) clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = setTimeout(() => {
        this.flushTranscripts().catch(err =>
          console.warn('[GeminiLive] Transcript flush error:', err.message)
        );
      }, 8000);
    }

    // ── Generation complete (GL uses this instead of turnComplete) ───────────
    // gemini-3.1-flash-live-preview sends serverContent.generationComplete rather than
    // turnComplete to signal the end of a full response. Without this handler the
    // 800 ms debounce flush timer inside the turnComplete block never fires, so
    // assistant messages are never persisted to the DB and voice transcripts are lost.
    //
    // When generationComplete arrives we:
    //  1. Seal the open audio sub-turn (send isLast:true) so the PCM player can start rendering.
    //  2. Cancel any pending debounce timer from an earlier turnComplete.
    //  3. Flush transcripts immediately — generationComplete is a definitive end-of-response
    //     signal, so there is no value in waiting for more sub-turns.
    if ((msg.serverContent as any)?.generationComplete) {
      this.recordCompletedExchangeAtGenerationBoundary('generationComplete');
      // ── Usage metadata diagnostic ─────────────────────────────────────────
      // Log token counts at generationComplete so we can confirm/rule out the
      // maxOutputTokens budget as the cause of mid-sentence cutoffs.
      // If candidatesTokenCount ≈ maxOutputTokens, the token limit is being hit.
      const usageMeta = (msg as any)?.usageMetadata;
      if (usageMeta) {
        console.log(`[GeminiLive] generationComplete usageMetadata: ${JSON.stringify(usageMeta)}`);
        observeModelAndUsage(this.session.conversationId, { usage: usageMeta });
        voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_usage_metadata', {
          turnId: this.currentTurnId,
          promptTokenCount: usageMeta.promptTokenCount ?? null,
          candidatesTokenCount: usageMeta.candidatesTokenCount ?? null,
          totalTokenCount: usageMeta.totalTokenCount ?? null,
          thoughtsTokenCount: usageMeta.thoughtsTokenCount ?? null,
        });
      }

      // ── Thought buffer flush ──────────────────────────────────────────────
      // Flush accumulated thought text to the pedagogical supervisor, then clear.
      // Thoughts arrive before audio; by generationComplete the buffer is complete.
      // The supervisor uses thought content as an additional struggle signal on top
      // of its existing rule-based checks (struggle count, phase duration, ACTFL mismatch).
      // Record generation completion time for heartbeat silence gate.
      this.lastGenerationCompleteTime = Date.now();

      if (this.currentTurnThoughtBuffer) {
        const thoughtSnippet = this.currentTurnThoughtBuffer.slice(0, 200);
        console.log(`[GeminiLive] Daniela thought (${this.currentTurnThoughtBuffer.length} chars, phase=${this.session.currentSessionPhase ?? 'unknown'}): ${thoughtSnippet}${this.currentTurnThoughtBuffer.length > 200 ? '...' : ''}`);
        if (!(this.session as any).placementMode?.active) {
          // Suppress Supervisor during placement — phase/phase-mismatch signals are noise
          // when Daniela is sampling language rather than teaching. She handles difficulty
          // naturally as part of the assessment without system-level intervention.
          const thoughtDirective = evaluatePedagogicalState(this.session, this.currentTurnThoughtBuffer);
          if (thoughtDirective) {
            // Store on instance — heartbeat will deliver it if student goes silent
            // before the next tool call can carry it. The tool-response path will
            // also consume and clear it if a tool call happens first.
            this.pendingDirectiveText = thoughtDirective.directive;
            this.pendingDirectiveUrgency = thoughtDirective.urgency;
            console.log(`[GeminiLive] PedagogicalSupervisor [${thoughtDirective.urgency}] thought-directive stored for heartbeat/tool delivery`);
          }
        }
      }
      // Capture thought token proxy before clearing — friction signal runs AFTER this clear.
      // Gemini confirmed (July 23 2026): thoughtsTokenCount is often null in GL streaming
      // usageMetadata. The thought buffer chars÷4 is a reliable proxy for the same signal.
      this._currentTurnThoughtTokenProxy = this.currentTurnThoughtBuffer.length > 0
        ? Math.round(this.currentTurnThoughtBuffer.length / 4)
        : null;
      // Capture raw thought content before clearing — persisted to DB alongside the assistant
      // message so the thought history is retained and Daniela can read her own past thinking.
      this._currentTurnThoughtContent = this.currentTurnThoughtBuffer.trim() || null;
      this.currentTurnThoughtBuffer = '';

      // ── Memory chain guard — reset on speech output ───────────────────────────
      // When Daniela produces audio (generationComplete fires), the memory-only
      // streak is broken — she spoke. Reset both the counter and the one-shot
      // nudge gate so a new memory-only chain in the next turn can trigger again.
      if ((this.session.consecutiveMemoryCalls ?? 0) > 0) {
        this.session.consecutiveMemoryCalls = 0;
        this.session.glMemoryNudgeSent = false;
      }

      // ── Frictionless Slide detection (GL) ────────────────────────────────────
      // Runs at generationComplete — by this point pendingOutputTranscript holds the
      // full text of Daniela's turn and currentTurnToolCalls holds every tool name
      // she called in this turn. Detection checks for memory assertions without Archive access.
      {
        const glSlideResult = detectFrictionlessSlide(
          this.pendingOutputTranscript.trim(),
          this.currentTurnToolCalls,
        );
        if (glSlideResult.detected) {
          if (!(this.session as any).frictionlessSlide) {
            (this.session as any).frictionlessSlide = initSlideState();
          }
          const autoGround = shouldAutoGround([...this.currentTurnToolCalls]);
          recordSlideDetection(
            (this.session as any).frictionlessSlide,
            this.currentTurnId,
            glSlideResult,
            [...this.currentTurnToolCalls],
            autoGround,
          );
          const nudge = buildGroundingNudge(glSlideResult);
          console.warn(
            `[FrictionlessSlide/GL] DETECTED — turn ${this.currentTurnId}, ` +
            `trigger: ${glSlideResult.trigger}, phrase: "${glSlideResult.matchedPhrase}", ` +
            `tools: [${this.currentTurnToolCalls.join(', ') || 'none'}], autoGround: ${autoGround}\n  ${nudge}`,
          );

          if (autoGround) {
            // Fire auto-grounding immediately — DB latency (~100-300ms) is the natural delay.
            // Result is stored in pendingWeeOoGrounding and injected via the tool response channel
            // on the next tool batch (same safe channel as pendingSystemWhisper — model reads it,
            // never speaks it aloud). If the session stops before then, it discards cleanly.
            const matchedPhrase = glSlideResult.matchedPhrase!;
            const userId = String((this.session as any).userId || '');
            const conversationId = (this.session as any).conversationId;
            const targetLanguage = (this.session as any).targetLanguage;
            const startMs = Date.now();
            const groundingBinding = createGroundingTurnBinding(
              this.activeStudentTurnEpoch,
              this.activeStudentUtterance || this.lastUserText,
              glSlideResult.candidateAssertion || matchedPhrase,
            );
            const postTurnAttemptId = this._startGuardianAttempt('post-turn-phrase', groundingBinding);
            this.guardianFireLog.push({ ts: new Date().toISOString(), path: 'post-turn-phrase', phrase: groundingBinding.candidateAssertion.slice(0, 80), charsInjected: null, channel: null, outcome: null, groundingPreview: null, attemptId: postTurnAttemptId });
            this._observeGuardian();
            runAutoGrounding(userId, groundingBinding.candidateAssertion, glSlideResult.trigger, conversationId, targetLanguage)
              .then(groundingResult => {
                if (this.isStopped) return;
                if (Date.now() - startMs > 2000) {
                  console.warn('[FrictionlessSlide/GL] Auto-grounding took >2s — discarding to avoid stale injection');
                  this._traceGuardianAttempt(postTurnAttemptId, {
                    type: 'stale_discarded',
                    detail: 'Post-turn lookup exceeded the two-second freshness budget.',
                  });
                  return;
                }
                if (!isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)) {
                  const stagedPrior = createPriorTurnGroundingCorrection(
                    groundingResult,
                    groundingBinding,
                    this.activeStudentTurnEpoch,
                  );
                  if (stagedPrior) {
                    if (
                      this.pendingPriorTurnGroundingAttemptId
                      && this.pendingPriorTurnGroundingAttemptId !== postTurnAttemptId
                    ) {
                      this._traceGuardianAttempt(this.pendingPriorTurnGroundingAttemptId, {
                        type: 'superseded',
                        detail: 'A newer prior-turn correction replaced this dormant correction.',
                      });
                    }
                    this.pendingPriorTurnGrounding = stagedPrior;
                    this.pendingPriorTurnGroundingAttemptId = postTurnAttemptId;
                    this._traceGuardianAttempt(postTurnAttemptId, {
                      type: 'lookup_completed',
                      detail: `${groundingResult.length} characters returned from Archive lookup.`,
                    });
                    console.log(
                      `[FrictionlessSlide/GL] Holding stale grounding from student turn `
                      + `${groundingBinding.studentTurnEpoch} dormant for turn ${this.activeStudentTurnEpoch}.`,
                    );
                    return;
                  }
                  console.warn(`[FrictionlessSlide/GL] Discarding stale grounding from student turn ${groundingBinding.studentTurnEpoch}.`);
                  this._traceGuardianAttempt(postTurnAttemptId, {
                    type: 'stale_discarded',
                    detail: 'Post-turn lookup completed after the bound student turn ended.',
                  });
                  return;
                }
                this._traceGuardianAttempt(postTurnAttemptId, {
                  type: 'lookup_completed',
                  detail: `${groundingResult.length} characters returned from Archive lookup.`,
                });
                // Update chars now that result is available.
                const logEntry = this.guardianFireLog.findLast(e => e.path === 'post-turn-phrase' && e.attemptId === postTurnAttemptId);
                if (logEntry) logEntry.charsInjected = groundingResult.length;
                // Primary channel: queue for injection via next tool response batch.
                // Tool responses are the safest GL channel — model reads them, never speaks them aloud.
                this._replacePendingWeeOoGrounding(
                  groundingResult,
                  groundingBinding,
                  postTurnAttemptId,
                  'A post-turn Guardian lookup replaced this queued payload before delivery.',
                );
                this._traceGuardianAttempt(postTurnAttemptId, {
                  type: 'queued',
                  channel: 'tool-response',
                  detail: 'Post-turn correction queued for a safe tool-response delivery.',
                });
                this.slideCorrectionQueued = true;
                console.log(`[FrictionlessSlide/GL] Auto-grounding queued (${groundingResult.length} chars, ${Date.now() - startMs}ms)`);

                // Fallback channel: if the next turn has no tool calls, pendingWeeOoGrounding
                // never injects via the primary channel. After 500ms (enough time for any tool
                // batch to claim it), inject via sendClientContent — BUT ONLY if GL is NOT
                // currently generating. Any sendClientContent while GL generates causes a
                // mid-sentence restart and overlapping audio. If generating, buffer to
                // pendingCarryForwardGrounding so it merges into the next student turn's
                // single guardian whisper instead.
                setTimeout(() => {
                  if (this.isStopped || !this.liveSession || !this.pendingWeeOoGrounding) return;
                  if (
                    this.pendingWeeOoGroundingBinding !== groundingBinding
                    || !isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)
                  ) {
                    return;
                  }
                  if (this.generationStartedThisTurn) {
                    // GL is generating — do not interrupt. Carry it forward.
                    if (!this.pendingCarryForwardGrounding) {
                      this.pendingCarryForwardGrounding = this.pendingWeeOoGrounding;
                      this.pendingCarryForwardGroundingBinding = groundingBinding;
                      this.pendingCarryForwardGroundingAttemptId = postTurnAttemptId;
                    } else {
                      this._traceGuardianAttempt(postTurnAttemptId, {
                        type: 'superseded',
                        detail: 'An existing carry-forward payload retained the only deferred-delivery slot.',
                      });
                    }
                    this.pendingWeeOoGrounding = null;
                    this.pendingWeeOoGroundingBinding = null;
                    this.pendingWeeOoGroundingAttemptId = null;
                    this._traceGuardianAttempt(postTurnAttemptId, {
                      type: 'queued',
                      channel: 'tool-response',
                      detail: 'Post-turn correction moved to carry-forward while generation was active.',
                    });
                    console.log(`[FrictionlessSlide/GL] Suppressed mid-generation sendClientContent — carried forward (${this.pendingCarryForwardGrounding!.length} chars)`);
                    return;
                  }
                  // sendClientContent is unsafe — leave pendingWeeOoGrounding set for tool-result delivery.
                  console.log(`[FrictionlessSlide/GL] Grounding stays queued for tool channel (${this.pendingWeeOoGrounding!.length} chars — no sendClientContent)`);
                }, 500);
              })
              .catch(err => {
                this._traceGuardianAttempt(postTurnAttemptId, {
                  type: 'lookup_failed',
                  detail: (err as Error).message,
                });
                console.warn('[FrictionlessSlide/GL] Auto-grounding failed:', (err as Error).message);
              });
          }
        }
        // ── Gemini friction signal analysis ──────────────────────────────────
        // Complementary to phrase detection — catches silent confabulation where
        // Daniela sounds confident but Gemini's own signals show slide risk:
        //   • Low sensory density: generic, abstract language with no concrete details
        //   • Low thought tokens: didn't think hard = smooth fabrication, not real search
        //   • No Archive access: built the response without any verified memory tools
        //
        // Only fires when phrase detection did NOT already queue grounding.
        // Thought tokens come from the current GL message's usageMetadata (same message
        // as generationComplete — accessed directly from `msg` to avoid ordering issues).
        if (!this.pendingWeeOoGrounding && !glSlideResult.detected) {
          const transcript = this.pendingOutputTranscript.trim();
          // Require at least 40 words to have enough signal — very short turns are noisy.
          const wordCount = transcript.split(/\s+/).length;
          if (wordCount >= 40) {
            // T001: Prefer usageMetadata thought tokens; fall back to buffer proxy.
            // Gemini confirmed (July 23 2026): thoughtsTokenCount is often null in GL streaming
            // usageMetadata even with includeThoughts:true. The thought buffer proxy (chars÷4)
            // captures the same signal from the parts stream that arrived before audio started.
            const thoughtTokensFromMeta: number | null = (msg.usageMetadata as any)?.thoughtsTokenCount ?? null;
            const thoughtTokens: number | null = thoughtTokensFromMeta ?? this._currentTurnThoughtTokenProxy;
            console.log(
              `[FrictionSignal/GL] thought tokens — meta: ${thoughtTokensFromMeta ?? 'null'}, ` +
              `proxy(chars÷4): ${this._currentTurnThoughtTokenProxy ?? 'null'}, ` +
              `using: ${thoughtTokens ?? 'null'} | words: ${wordCount} | tools: ${this.currentTurnToolCalls.length}`
            );
            const friction = analyzeFriction(transcript, [...this.currentTurnToolCalls], thoughtTokens);

            // T002: Inverted threshold for memory-request turns.
            // Gemini finding (July 23 2026): LOW/CLEAN friction on a memory-request turn means
            // the model gave up on reconciliation before a single word — the slide ran SMOOTHLY,
            // which is worse than HIGH friction (which means she's genuinely grappling).
            // If the pre-turn Guardian already fired, a CLEAN/LOW score with no Archive access
            // means the grounding didn't interrupt the pull — fire again for the next turn.
            const memoryRequestTurn = this.preTurnGroundingFired;
            const smoothSlide = memoryRequestTurn
              && !friction.archiveAccess
              && (friction.label === 'CLEAN' || friction.label === 'LOW');

            // Surface friction data to Luca's observer store so it can post to Team Room.
            {
              const _frictionConvId = (this.session as any).conversationId as string | undefined;
              if (_frictionConvId) {
                observeFrictionScore(
                  _frictionConvId,
                  this.sessionStudentTurnCount,
                  friction.label,
                  friction.totalScore,
                  friction.archiveAccess,
                  smoothSlide,
                  friction.unverifiedAssertions,
                );
              }
            }

            // Fire on HIGH (≥60), strong MODERATE (≥50), OR smooth slide on a memory-request turn.
            const shouldFire = friction.label === 'HIGH'
              || (friction.label === 'MODERATE' && friction.totalScore >= 50)
              || smoothSlide;

            if (shouldFire) {
              // Differentiated log: smooth slide (inverted threshold) vs standard friction signal.
              if (smoothSlide) {
                console.warn(
                  `[FrictionSignal/GL] SMOOTH SLIDE — memory-request turn returned ${friction.label} ` +
                  `(score: ${friction.totalScore}), no Archive access — slide ran without friction; ` +
                  `Guardian firing for next turn (thought tokens: ${thoughtTokens ?? 'n/a'})`,
                );
              } else {
                console.warn(
                  `[FrictionSignal/GL] Gemini friction ${friction.label} (score: ${friction.totalScore}) — ` +
                  `density: ${friction.sensoryDensity}, thoughtTokens: ${thoughtTokens ?? 'n/a'}, ` +
                  `archive: ${friction.archiveAccess}, signals: ${friction.signals.join(' | ')}`,
                );
              }
              // Use the specific unverified assertion sentence when one exists.
              // If the friction signal was triggered without an assertion phrase,
              // do not fire a redundant post-turn lookup using the student's utterance
              // (UniversalPreTurn already grounded the student's utterance on this turn).
              const userId = String((this.session as any).userId || '');
              const conversationId = (this.session as any).conversationId;
              const targetLanguage = (this.session as any).targetLanguage;
              const startMs = Date.now();
              const frictionGrounding = createFrictionSignalGroundingBinding(
                this.activeStudentTurnEpoch,
                this.activeStudentUtterance || this.lastUserText,
                transcript,
                friction.unverifiedAssertions,
              );
              if (!frictionGrounding.canCarryToPriorTurn) {
                console.log(
                  `[FrictionSignal/GL] Skipping auto-grounding — no unverified assertion phrase in model output`,
                );
              } else {
                const groundingBinding = frictionGrounding.binding;
                const frictionAttemptId = this._startGuardianAttempt('friction-signal', groundingBinding);
                this.guardianFireLog.push({ ts: new Date().toISOString(), path: 'friction-signal', phrase: groundingBinding.candidateAssertion.slice(0, 80), charsInjected: null, channel: null, outcome: null, groundingPreview: null, attemptId: frictionAttemptId });
                this._observeGuardian();
                runAutoGrounding(userId, groundingBinding.candidateAssertion, 'memory_assertion', conversationId, targetLanguage)
                  .then(groundingResult => {
                    if (this.isStopped || Date.now() - startMs > 2000) {
                      this._traceGuardianAttempt(frictionAttemptId, {
                        type: 'stale_discarded',
                        detail: this.isStopped ? 'Session stopped before lookup delivery.' : 'Lookup exceeded the two-second freshness budget.',
                      });
                      return;
                    }
                    if (!isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)) {
                      const stagedPrior = frictionGrounding.canCarryToPriorTurn
                        ? createPriorTurnGroundingCorrection(
                          groundingResult,
                          groundingBinding,
                          this.activeStudentTurnEpoch,
                        )
                        : null;
                      if (stagedPrior) {
                        if (
                          this.pendingPriorTurnGroundingAttemptId
                          && this.pendingPriorTurnGroundingAttemptId !== frictionAttemptId
                        ) {
                          this._traceGuardianAttempt(this.pendingPriorTurnGroundingAttemptId, {
                            type: 'superseded',
                            detail: 'A newer prior-turn correction replaced this dormant correction.',
                          });
                        }
                        this.pendingPriorTurnGrounding = stagedPrior;
                        this.pendingPriorTurnGroundingAttemptId = frictionAttemptId;
                        this._traceGuardianAttempt(frictionAttemptId, {
                          type: 'lookup_completed',
                          detail: `${groundingResult.length} characters returned from Archive lookup.`,
                        });
                        console.log(
                          `[FrictionSignal/GL] Holding stale grounding from student turn `
                          + `${groundingBinding.studentTurnEpoch} dormant for turn ${this.activeStudentTurnEpoch}.`,
                        );
                        return;
                      }
                      console.warn(`[FrictionSignal/GL] Discarding stale grounding from student turn ${groundingBinding.studentTurnEpoch}.`);
                      this._traceGuardianAttempt(frictionAttemptId, {
                        type: 'stale_discarded',
                        detail: 'Friction-signal lookup completed after the bound student turn ended.',
                      });
                      return;
                    }
                    this._traceGuardianAttempt(frictionAttemptId, {
                      type: 'lookup_completed',
                      detail: `${groundingResult.length} characters returned from Archive lookup.`,
                    });
                    const fsLogEntry = this.guardianFireLog.findLast(e => e.path === 'friction-signal');
                    if (fsLogEntry) fsLogEntry.charsInjected = groundingResult.length;
                    this._replacePendingWeeOoGrounding(
                      groundingResult,
                      groundingBinding,
                      frictionAttemptId,
                      'A friction-signal Guardian lookup replaced this queued payload before delivery.',
                    );
                    this._traceGuardianAttempt(frictionAttemptId, {
                      type: 'queued',
                      channel: 'tool-response',
                      detail: 'Friction-signal correction queued for a safe tool-response delivery.',
                    });
                    console.log(`[FrictionSignal/GL] Grounding queued from Gemini friction signal (${groundingResult.length} chars, ${Date.now() - startMs}ms)`);
                    // Same 500ms fallback as phrase detection — gated on !generationStartedThisTurn
                    // to prevent mid-sentence restarts from sendClientContent while GL generates.
                    setTimeout(() => {
                      if (this.isStopped || !this.liveSession || !this.pendingWeeOoGrounding) return;
                      if (
                        this.pendingWeeOoGroundingBinding !== groundingBinding
                        || !isGroundingBindingCurrent(groundingBinding, this.activeStudentTurnEpoch)
                      ) {
                        return;
                      }
                      if (this.generationStartedThisTurn) {
                        if (!this.pendingCarryForwardGrounding) {
                          this.pendingCarryForwardGrounding = this.pendingWeeOoGrounding;
                          this.pendingCarryForwardGroundingBinding = groundingBinding;
                          this.pendingCarryForwardGroundingAttemptId = frictionAttemptId;
                        } else {
                          this._traceGuardianAttempt(frictionAttemptId, {
                            type: 'superseded',
                            detail: 'An existing carry-forward payload retained the only deferred-delivery slot.',
                          });
                        }
                        this.pendingWeeOoGrounding = null;
                        this.pendingWeeOoGroundingBinding = null;
                        this.pendingWeeOoGroundingAttemptId = null;
                        this._traceGuardianAttempt(frictionAttemptId, {
                          type: 'queued',
                          channel: 'tool-response',
                          detail: 'Friction-signal correction moved to carry-forward while generation was active.',
                        });
                        console.log(`[FrictionSignal/GL] Suppressed mid-generation sendClientContent — carried forward`);
                        return;
                      }
                      // sendClientContent is unsafe — leave pendingWeeOoGrounding set for tool-result delivery.
                      console.log(`[FrictionSignal/GL] Grounding stays queued for tool channel (${this.pendingWeeOoGrounding!.length} chars — no sendClientContent)`);
                    }, 500);
                  })
                  .catch(err => {
                    this._traceGuardianAttempt(frictionAttemptId, {
                      type: 'lookup_failed',
                      detail: (err as Error).message,
                    });
                    console.warn('[FrictionSignal/GL] Auto-grounding failed:', (err as Error).message);
                  });
              }
            } else if (friction.label !== 'CLEAN') {
              console.log(`[FrictionSignal/GL] Friction ${friction.label} (score: ${friction.totalScore}) — below grounding threshold, monitoring`);
            }
          }
        }

        const archiveToolsUsedThisTurn = this.currentTurnToolCalls.some(t =>
          ['introspect', 'recall', 'grounding_query', 'memory_lookup', 'unified_recall'].includes(t)
        );
        // Delivery and Archive linkage are recorded per stable attempt. Do not
        // infer “heard” or “missed” from a turn-wide tool-name heuristic.
        // Surface per-turn tool summary to Luca's observer before resetting the list.
        {
          const _tcConvId = (this.session as any).conversationId as string | undefined;
          if (_tcConvId) {
            observeTurnComplete(
              _tcConvId,
              this.sessionStudentTurnCount,
              [...this.currentTurnToolCalls],
              archiveToolsUsedThisTurn,
            );
          }
        }
        this.currentTurnToolCalls = [];
        // Pre-turn Archive Guardian fields reset at generationComplete — the turn is done,
        // student speaking window opens next, fresh scan for next student utterance.
        this.sessionStudentTurnCount++;
        this.preTurnGroundingFired = false;
        this.preTurnIsNamedRecord = false;
        this.preTurnGroundingResult = null;
        this.preTurnGroundingPromise = null;
        this.preTurnGroundingBinding = null;
        this.preTurnGroundingIsEmotional = false;
        // Hard wall correction — fires if slide was detected mid-output (memory assertion
        // with no Archive access). Injects grounding for the NEXT turn via sendClientContent.
        if (this.hardWallTriggered && !this.isStopped && this.liveSession) {
          const _hwUserId = String((this.session as any).userId || '');
          const _hwConvId = (this.session as any).conversationId;
          const _hwLang = (this.session as any).targetLanguage;
          const _hwQuery = extractGroundingAssertionCandidate(this.pendingOutputTranscript);
          const _hwBinding = createGroundingTurnBinding(
            this.activeStudentTurnEpoch,
            this.activeStudentUtterance || this.lastUserText,
            _hwQuery,
          );
          const hardWallAttemptId = this._startGuardianAttempt('hard-wall', _hwBinding);
          this.hardWallTriggered = false;
          console.warn('[HardWall] Injecting grounding correction for next turn');
          runAutoGrounding(_hwUserId, _hwQuery, 'memory_assertion', _hwConvId, _hwLang, { writeToDb: true, notifyLuca: true })
            .then(groundingResult => {
              if (this.isStopped || !this.liveSession) return;
              if (!isGroundingBindingCurrent(_hwBinding, this.activeStudentTurnEpoch)) {
                const stagedPrior = createPriorTurnGroundingCorrection(
                  groundingResult,
                  _hwBinding,
                  this.activeStudentTurnEpoch,
                );
                if (stagedPrior) {
                  if (
                    this.pendingPriorTurnGroundingAttemptId
                    && this.pendingPriorTurnGroundingAttemptId !== hardWallAttemptId
                  ) {
                    this._traceGuardianAttempt(this.pendingPriorTurnGroundingAttemptId, {
                      type: 'superseded',
                      detail: 'A newer prior-turn correction replaced this dormant correction.',
                    });
                  }
                  this.pendingPriorTurnGrounding = stagedPrior;
                  this.pendingPriorTurnGroundingAttemptId = hardWallAttemptId;
                  this._traceGuardianAttempt(hardWallAttemptId, {
                    type: 'lookup_completed',
                    detail: `${groundingResult.length} characters returned from Archive lookup.`,
                  });
                  console.log(
                    `[HardWall] Holding stale correction from student turn `
                    + `${_hwBinding.studentTurnEpoch} dormant for turn ${this.activeStudentTurnEpoch}.`,
                  );
                  return;
                }
                console.warn(`[HardWall] Discarding stale correction from student turn ${_hwBinding.studentTurnEpoch}.`);
                this._traceGuardianAttempt(hardWallAttemptId, {
                  type: 'stale_discarded',
                  detail: 'Hard-wall lookup completed after the bound student turn ended.',
                });
                return;
              }
              this._traceGuardianAttempt(hardWallAttemptId, {
                type: 'lookup_completed',
                detail: `${groundingResult.length} characters returned from Archive lookup.`,
              });
              const correction = groundingResult
                ? `[ARCHIVE GUARDIAN: Your history surfaces to support you. This is the bedrock of your memory for this moment:\n${groundingResult}]`
                : `[ARCHIVE GUARDIAN: The well is deep and still. No specific memories surface. Trust your intuition.]`;
              // sendClientContent is unsafe — store for tool-result delivery on next tool call.
              if (!this.pendingWeeOoGrounding) {
                this._replacePendingWeeOoGrounding(
                  correction,
                  _hwBinding,
                  hardWallAttemptId,
                  'Hard-wall correction replaced this queued payload before delivery.',
                );
                this.slideCorrectionQueued = true;
                this._traceGuardianAttempt(hardWallAttemptId, {
                  type: 'queued',
                  channel: 'tool-response',
                  detail: 'Hard-wall correction queued for a safe tool-response delivery.',
                });
              } else {
                this._traceGuardianAttempt(hardWallAttemptId, {
                  type: 'superseded',
                  detail: 'An existing Guardian payload retained the only tool-response queue slot.',
                });
              }
              console.log('[HardWall] Correction queued for tool channel');
            })
            .catch(err => {
              this._traceGuardianAttempt(hardWallAttemptId, {
                type: 'lookup_failed',
                detail: (err as Error).message,
              });
              console.warn('[HardWall] Correction failed:', (err as Error).message);
            });
        } else {
          this.hardWallTriggered = false;
        }
      }

      // Close transcript gate — discard any outputTranscription arriving after this point.
      // generationComplete is the definitive end-of-turn signal; any transcription after it
      // is residual buffering from GL's transcription layer and should not reach the client.
      this.transcriptClosed = true;
      // Bug 1 fix: arm the audio gate — any audio arriving after this point is a GL tail
      // sub-turn ("ok", "hey") and should be dropped before it reaches the client.
      this.afterGenerationComplete = true;
      // Greeting turn is definitively over — clear the gl_audio_reset suppression guard.
      this.isGreetingTurn = false;
      // Signal that generation is fully done so onPlaybackEnded() can safely lift the mic gate.
      this.isGenerationDone = true;
      // Memory-loop counter reset: Daniela produced audio, so the consecutive-memory-call
      // chain is definitively broken. Any new memory lookups after this point start fresh.
      this.session.consecutiveMemoryCalls = 0;
      // Retroactive lift: if playback_ended already fired between sub-turns (single-sentence
      // responses finish playing before generationComplete arrives over the network), call
      // onPlaybackEnded() now so the mic gate lifts without waiting for the safety timeout.
      if (this.pendingPlaybackEndedLift) {
        console.log('[GeminiLive] generationComplete — retroactive onPlaybackEnded() (single-sentence path)');
        this.onPlaybackEnded();
      }

      // Friction Score — flush this student turn's word count + mid-pause count into the
      // rolling windows. Reset per-turn accumulators.
      // NOTE: studentTurnStartMs is NOT set here — it's set in onPlaybackEnded() which fires
      // when the client signals audio playback has actually finished. Setting it here would
      // start the pre-speech pause timer before the student has even heard Daniela speak.
      if (this.currentTurnInputWords > 0) {
        this.recentTurnWordCounts.push(this.currentTurnInputWords);
        if (this.recentTurnWordCounts.length > GeminiLiveSession.FRICTION_WINDOW) {
          this.recentTurnWordCounts.shift();
        }
        this.recentMidPauseCounts.push(this.currentTurnMidPauses);
        if (this.recentMidPauseCounts.length > GeminiLiveSession.FRICTION_WINDOW) {
          this.recentMidPauseCounts.shift();
        }
      }
      this.currentTurnInputWords = 0;
      this.currentTurnMidPauses = 0;
      this.lastInputChunkMs = 0;
      // NOTE (2026-06-13): maybeInjectContextRefresh() was removed here.
      // It sent sendClientContent({role:'model', turnComplete:false}) which incorrectly
      // signals GL that the model is mid-utterance — causing GL to generate a second audio
      // stream to "complete" the injected model turn, producing audio doubling every 15 turns.
      // Context refresh via GL's sendClientContent has no safe "inject without triggering
      // response" mode. System prompt covers this for now.

      // ── Affirmation variety tracker (Fix 4) ────────────────────────────────
      // Scan the just-completed turn's transcript for known affirmation phrases.
      // Build a rolling list (max 5) injected into the system whisper so Daniela
      // avoids repeating the same opener two turns in a row.
      // Safe to scan here: pendingOutputTranscript is complete at generationComplete.
      // Normalization: strip ¡¿! before matching so "¡Muy bien!" and "muy bien"
      // don't both match and double-count the same affirmation.
      {
        const turnText = this.pendingOutputTranscript
          .toLowerCase()
          .replace(/[¡¿!]/g, ''); // normalize punctuation before matching
        const matched = GeminiLiveSession.AFFIRMATION_PHRASES
          .map(p => p.replace(/[¡¿!]/g, '')) // normalize phrase list too
          .filter((p, i, arr) => arr.indexOf(p) === i) // deduplicate normalized phrases
          .filter(p => turnText.includes(p));
        // Map back to display-friendly versions (use the first matched canonical form)
        if (matched.length > 0) {
          for (const phrase of matched) {
            const canonical = GeminiLiveSession.AFFIRMATION_PHRASES.find(
              p => p.replace(/[¡¿!]/g, '') === phrase
            ) ?? phrase;
            if (!this.recentAffirmationPhrases.some(
              existing => existing.replace(/[¡¿!]/g, '') === phrase
            )) {
              this.recentAffirmationPhrases.push(canonical);
            }
          }
          // Keep rolling window of last 5 unique phrases
          if (this.recentAffirmationPhrases.length > 5) {
            this.recentAffirmationPhrases = this.recentAffirmationPhrases.slice(-5);
          }
        }
      }

      // H1 fix: clear greeting gate on generationComplete — handles the case where the
      // greeting turn produces no audio (content filter, text-only, error), which would
      // otherwise leave greetingPhaseActive=true permanently and block all mic input.
      if (this.greetingPhaseActive) {
        this.greetingPhaseActive = false;
        if (this.greetingWatchdogTimer) { clearTimeout(this.greetingWatchdogTimer); this.greetingWatchdogTimer = null; }
        if (!this.hadAudioInCurrentSubturn) this.scheduleGreetingDeliveryRetry('generation_complete');
        console.log('[GeminiLive] generationComplete — greeting gate cleared (no audio path)');
      }
      // Gate stays closed (isTutorGeneratingAudio = true) until the CLIENT signals
      // playback_ended. generationComplete fires when GL finishes generating, but the
      // client hasn't started playing yet — audio is still buffered. If we open the gate
      // here, the mic picks up Daniela's audio as it plays through the speaker (echo),
      // and GL generates a spurious 0-sentence response before David has said anything.
      // onPlaybackEnded() is called by the WS handler when the client's playback_ended
      // telemetry arrives. A 60s safety timeout force-opens the gate if it never arrives.
      // 60s (was 15s) because long responses can take 25-35s to play through; firing at
      // 15s opened the mic mid-sentence and caused perceived pauses/freezes.
      if (this.isTutorGeneratingAudio) {
        // Cancel any previous safety timeout
        if (this.playbackGateSafetyTimeout) {
          clearTimeout(this.playbackGateSafetyTimeout);
        }
        this.playbackGateSafetyTimeout = setTimeout(() => {
          this.playbackGateSafetyTimeout = null;
          if (this.isTutorGeneratingAudio) {
            this.isTutorGeneratingAudio = false;
            console.log('[GeminiLive] Mic gate force-opened — safety timeout (no playback_ended received)');
          }
          // Friction Score fallback: if playback_ended never arrives, set T-zero here
          // so pre-speech pause measurement at least has some basis (though less accurate).
          if (this.studentTurnStartMs === 0) {
            this.studentTurnStartMs = Date.now();
            this.currentTurnFirstInputMs = 0;
            this.lastInputChunkMs = 0;
          }
        }, 60000);
        console.log('[GeminiLive] generationComplete — mic gate held pending client playback_ended');
      }
      // Clear the generationComplete watchdog — signal arrived normally
      if (this.generationCompleteWatchdogTimer) {
        clearTimeout(this.generationCompleteWatchdogTimer);
        this.generationCompleteWatchdogTimer = null;
      }
      console.log('[GeminiLive] generationComplete received — sealing audio sub-turn and flushing transcripts');
      voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_generation_complete', {
        turnId: this.currentTurnId, hadAudio: this.hadAudioInCurrentSubturn,
      });
      this._finalizeGuardianAttemptsForTurn();

      // Close transcription immediately at generationComplete — BEFORE the 800ms
      // audio-seal debounce. Audio chunks can still arrive for 300-700ms after
      // generationComplete (network buffer), so we wait to seal audio. But
      // outputTranscription arriving after generationComplete is ghost content:
      // GL streams transcription for sentences it *intended* to say even when its
      // internal audio budget ran out mid-response. Without this early close, both
      // ghost guards miss it — Layer 1 (transcriptClosed) is still false, and
      // Layer 2 (800ms audio silence) hasn't elapsed yet — so ghost words accumulate
      // in pendingOutputTranscript and the DB transcript is longer than what was spoken.
      // Trade-off: trailing real transcription chunks that arrive just after
      // generationComplete may be suppressed, but those words were already captured
      // as part.text in pendingOutputTranscript before outputTranscription switched sources.
      this.transcriptClosed = true;

      // ── Tutor speaking end ─────────────────────────────────────────────
      if (this.tutorSpeakingStartTime !== null) {
        this.tutorSpeakingMs += Date.now() - this.tutorSpeakingStartTime;
        this.tutorSpeakingStartTime = null;
      }

      // Seal current audio sub-turn — DEBOUNCED (200ms)
      // GL sometimes fires generationComplete while audio chunks are still in-flight
      // over the network (e.g. the final question sub-turn "What's [next]?"). Immediately
      // sending isLast:true would seal BEFORE the remaining chunks arrive, cutting off
      // everything after the first word. We wait 200ms: if more audio arrives in that
      // window (audio chunk handler resets this timer), we extend the window. When no
      // audio has arrived for 800ms we know the stream is truly done and seal cleanly.
      // 800ms (was 200ms): GL sometimes takes 300-700ms to flush the final audio chunks
      // after firing generationComplete. With 200ms, those trailing chunks arrived AFTER
      // the seal fired — they got a new sentenceIndex but response_complete had already
      // been sent with totalSentences=N (not N+1), so the client dropped the late audio
      // as an unexpected sentence and the last word/clause was silently cut.
      if (this.generationCompleteSealTimer) {
        clearTimeout(this.generationCompleteSealTimer);
      }
      // Cancel any pending turnComplete debounce — we'll flush inside the seal callback
      // so that (a) totalSentences includes the in-progress sentence and (b) the
      // per-response reset (firstAudioSentThisTurn etc.) doesn't clear prematurely,
      // which would let processing_pending re-fire and resetForNewTurn() wipe the
      // audio player while in-flight chunks are still arriving.
      if (this.transcriptFlushTimer) {
        clearTimeout(this.transcriptFlushTimer);
        this.transcriptFlushTimer = null;
      }
      this.generationCompleteSealTimer = setTimeout(() => {
        this.generationCompleteSealTimer = null;
        if (!this.isStopped) {
          this.sealCurrentAudioSubturn('generationComplete-debounce', true);
          // Flush AFTER seal: currentSentenceIndex is now final, per-response reset
          // fires only once all in-flight audio has landed and been sealed.
          this.flushTranscripts().catch(err =>
            console.warn('[GeminiLive] generationComplete flush error:', err.message)
          );
        }
      }, 800);
    }

    // ── Interrupted signal (barge-in detected) ───────────────────────────────
    // GL sends serverContent.interrupted=true when the user starts speaking mid-generation.
    // Audio delivery stops immediately; no further outputTranscription arrives for this turn
    // (audio was already in the client's PCM buffer — faster than transcription text).
    // We close the open audio sub-turn and flush whatever partial transcript we have so
    // the truncated assistant message is saved cleanly before the next user turn begins.
    if ((msg.serverContent as any)?.interrupted) {
      this._finalizeOutstandingGuardianAttempts('Gemini generation was interrupted by a new student utterance.');
      // Clear thought buffer — interrupted turns won't reach generationComplete, so the
      // buffer must be wiped here or it would bleed into the next turn's thought accumulation.
      this.currentTurnThoughtBuffer = '';

      // Playback ledger: short playback of this turn is intended, not a fault.
      try { observeBargeIn(this.session.conversationId, this.session.dbSessionId ?? null, this.session.id ?? null, this.currentTurnId); } catch { /* observation only */ }
      // Telemetry: barge-in event so Sofia can track interruption frequency
      const bargePayload = JSON.stringify({
        sessionId: this.session.id,
        userId: this.session.userId ? String(this.session.userId) : undefined,
        tutorWasGenerating: this.isTutorGeneratingAudio,
      });
      getSharedDb().execute(sql`
        INSERT INTO voice_pipeline_events
          (id, session_id, user_id, event_type, event_data, created_at)
        VALUES (
          gen_random_uuid(),
          ${this.session.id},
          ${this.session.userId ? String(this.session.userId) : null},
          'gl_barge_in',
          ${bargePayload}::jsonb,
          NOW()
        )
      `).catch(() => {});

      // Barge-in: cancel the playback gate safety timeout and open the mic immediately.
      // The student started speaking, so audio has effectively stopped — no more echo risk.
      if (this.playbackGateSafetyTimeout) {
        clearTimeout(this.playbackGateSafetyTimeout);
        this.playbackGateSafetyTimeout = null;
      }
      if (this.isTutorGeneratingAudio) {
        this.isTutorGeneratingAudio = false;
        console.log('[GeminiLive] Mic gate lifted — barge-in interrupted Daniela (echo suppression off)');
      }
      // Greeting turn interrupted — clear the gl_audio_reset suppression guard.
      this.isGreetingTurn = false;
      // Clear the generationComplete watchdog — barge-in ends the generating turn
      if (this.generationCompleteWatchdogTimer) {
        clearTimeout(this.generationCompleteWatchdogTimer);
        this.generationCompleteWatchdogTimer = null;
      }
      // Close transcript gate — discard any outputTranscription arriving after barge-in.
      this.transcriptClosed = true;
      console.log('[GeminiLive] Barge-in detected — flushing partial transcript and sealing audio sub-turn');
      // Interruption Buffer: notify WS handler so it can capture lastPedagogicalActionType
      this.onBargeIn?.();
      // Close tutor speaking timer on barge-in (student interrupted before generation complete)
      if (this.tutorSpeakingStartTime !== null) {
        this.tutorSpeakingMs += Date.now() - this.tutorSpeakingStartTime;
        this.tutorSpeakingStartTime = null;
      }
      // Reset latency tracking — new user turn starting
      this.studentSpeakingStartTime = null;
      this.lastInputTranscriptionTime = null;

      // Seal the current audio sub-turn so the PCM player doesn't wait indefinitely
      if (this.hadAudioInCurrentSubturn) {
        this.sendWsMessage(this.session.ws, {
          type: 'audio_chunk',
          audio: '',
          audioFormat: 'pcm_f32le',
          sampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
          turnId: this.currentTurnId,
          sentenceIndex: this.currentSentenceIndex,
          chunkIndex: this.currentChunkIndex,
          isLast: true,
        });
        this.currentSentenceIndex++;
        this.currentChunkIndex = 0;
        this.hadAudioInCurrentSubturn = false;
      }

      // Flush the partial assistant transcript immediately (don't wait for next turnComplete)
      if (this.pendingOutputTranscript.trim()) {
        if (this.transcriptFlushTimer) {
          clearTimeout(this.transcriptFlushTimer);
          this.transcriptFlushTimer = null;
        }
        this.flushTranscripts().catch(err =>
          console.warn('[GeminiLive] Barge-in transcript flush error:', err.message)
        );
      }
    }

    // ── Tool calls ────────────────────────────────────────────────────────────
    if (msg.toolCall?.functionCalls && msg.toolCall.functionCalls.length > 0) {
      // Capture turn ID at the moment the toolCall arrives. If the student barges in
      // while handlers are running, currentTurnId will advance and the guard below drops
      // the now-stale responses before they reach sendToolResponse.
      const localTurnId = this.currentTurnId;
      const toolBatchSequence = ++this.toolCallBatchSequence;
      // Capture immutable lineage identity before any awaited tool work. A
      // barge-in may advance the active student turn while handlers are running.
      const toolCallTraceId = this.activeContextLineageTraceId;
      const toolCallStudentTurnEpoch = this.activeStudentTurnEpoch;
      const toolCallCallbackEventId = toolCallTraceId
        ? this._recordFactualStreamCallback('tool_call', undefined, {
          functionCallIds: msg.toolCall.functionCalls.map((call: any) => call.id ?? null),
          functionNames: msg.toolCall.functionCalls.map((call: any) => call.name ?? null),
        })
        : null;
      const assembledContextLineageEvents: string[] = [];
      const guardianAttemptIdsInToolResponse: string[] = [];
      this._linkRelatedArchiveCalls(
        msg.toolCall.functionCalls.map((fc: any) => fc.name as string),
        toolBatchSequence,
      );

      // Frictionless Slide: record all tool names called this GL turn
      for (const fc of msg.toolCall.functionCalls) {
        if (fc.name) this.currentTurnToolCalls.push(fc.name as string);
      }

      // Parallel speech gate (Stage 2 → Stage 3):
      // GL sometimes speaks part of its response BEFORE calling a tool (pre-tool sub-turn).
      // Standard fix: send gl_audio_reset to cancel that audio so GL doesn't double-speak.
      // Stage 3 improvement: when ALL tools in the batch are latency-heavy (search/memory)
      // AND the acknowledgment is substantial (≥3 words), preserve the pre-tool audio and
      // instead inject a "don't re-speak" transcript whisper into the tool response.
      // This lets Daniela speak acknowledgments concurrent with tool dispatch.
      // For immediate UI tools or short acknowledgments, the standard reset path is taken.
      this.preTurnTextForWhisper = null; // reset each tool-call batch
      if (this.hadAudioInCurrentSubturn) {
        const toolNames = msg.toolCall.functionCalls.map((fc: any) => fc.name as string);
        const allLatencyHeavy = toolNames.every(n => PARALLEL_SPEECH_TOOLS.has(n));
        const preTurnText = this.pendingOutputTranscript.trim();
        const preTurnWordCount = preTurnText.split(/\s+/).filter(Boolean).length;
        const hasSubstantialAck = preTurnWordCount >= 3;

        if (this.isGreetingTurn) {
          // During the greeting turn, gl_audio_reset would cut the greeting audio mid-sentence.
          // greetingPhaseActive clears at first audio chunk — too early. isGreetingTurn stays
          // live for the full greeting generation (until generationComplete or interrupted),
          // so tool calls that fire after Daniela has already spoken a few words are also covered.
          // The greeting has no double-speech risk — skip the reset entirely.
          console.log(`[GeminiLive] Tool call(s) [${toolNames.join(', ')}] during greeting turn — skipping gl_audio_reset to preserve greeting audio`);
        } else if (hasSubstantialAck) {
          // Substantial pre-tool speech (≥3 words) — preserve audio regardless of tool type.
          // Previously we also required allLatencyHeavy (tool in PARALLEL_SPEECH_TOOLS), but that
          // was over-conservative: Daniela commonly batches latency-heavy tools (memory_review,
          // introspect) with fast bookkeeping tools (update_session_phase, admin_session). A single
          // fast tool in the batch caused allLatencyHeavy=false → gl_audio_reset → mid-sentence cutoff.
          // The double-speech risk is handled by the whisper injection after the tool returns,
          // which tells GL not to re-speak the pre-tool words — this works for any tool type.
          this.preTurnTextForWhisper = preTurnText;
          const toolKind = allLatencyHeavy ? 'latency-heavy' : 'mixed/immediate';
          console.log(`[GeminiLive] Parallel speech [${toolNames.join(', ')}] (${toolKind}) — preserving ${preTurnWordCount}-word pre-tool audio: "${preTurnText.slice(0, 80)}"`);
        } else {
          // Short pre-tool speech (< 3 words) — reset to prevent double-speech.
          // The pre-tool audio is too brief to preserve; resetting lets GL deliver a clean response.
          const reason = `short acknowledgment (${preTurnWordCount} word(s) < 3)`;
          console.log(`[GeminiLive] Tool call(s) [${toolNames.join(', ')}] fired after pre-tool audio — sending gl_audio_reset (${reason})`);
          this.sendWsMessage(this.session.ws, { type: 'gl_audio_reset' }, this.session);
          voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_audio_reset', {
            tools: toolNames,
            reason,
          });
        }
      }

      // Tool Call Deadlock fix: record the in-flight call IDs so that if the connection
      // drops before sendToolResponse fires, the reconnect path can unblock GL.
      // Use push (not =) so that if GL sends a second tool batch before the first
      // sendToolResponse fires, both batches' IDs are retained for the reconnect handler.
      this.pendingFunctionCallIds.push(
        ...msg.toolCall.functionCalls
          .map((fc: any) => fc.id as string)
          .filter(Boolean),
      );
      const responses: Array<{ id: string; name: string; response: GLToolResponsePayload }> = [];

      // Phase 1: Build extractedFcs upfront (order-safe) then fire all handlers in parallel.
      // fcHandler.handle() returns quickly — it queues background work into
      // session.pendingMemoryLookupPromises or session.pendingAsyncImagePromises and breaks.
      // No slow I/O (DALL-E/Gemini image generation, vector search) happens inside handle() itself.
      // Previously: for...await serialized each tool → latency = Sum(all background work).
      // Now: Promise.allSettled fires all handlers concurrently → latency = Max(slowest tool).
      const extractedFcs: ExtractedFunctionCall[] = msg.toolCall.functionCalls.map(fc => ({
        name: fc.name || '',
        legacyType: lookupLegacyType(fc.name || ''),
        args: (fc.args as Record<string, unknown>) || {},
      }));

      const toolErrors = new Map<string, string>();

      // Co-pilot: per-tool start times (parallel execution — measure each separately)
      const toolStartTimes = new Map<string, number>();
      // Gemini Stage 2 Q4 fix: start the input-transcription finalization check
      // concurrently with Phase 1 + Phase 2 tool execution (bounded to 150ms) so
      // it overlaps with tool execution instead of adding a 2s serial wait before
      // sendToolResponse. If the student is still speaking when tools finish,
      // pendingPriorTurnGrounding remains deferred for any subsequent tool batch
      // on the same student turn without stalling the current tool response.
      const priorTurnFinalizationWaitPromise = (
        this.pendingPriorTurnGrounding && this.currentStudentTurnBoundaryTrusted
      )
        ? this.waitForInputTranscriptionFinalization(this.activeStudentTurnEpoch)
        : null;

      await Promise.allSettled(
        msg.toolCall.functionCalls.map(async (fc, idx) => {
          const fcName = fc.name || '';
          const extractedFc = extractedFcs[idx];
          toolStartTimes.set(fcName, Date.now());

          console.log(`[GeminiLive] Tool call: ${fcName} (${extractedFc.legacyType})`);

          // Signal client that a function is executing — keeps thinking avatar alive
          // during long tool calls (memory searches, image generation, etc.).
          try {
            this.sendWsMessage(this.session.ws, {
              type: 'function_executing',
              functionName: fcName,
              timestamp: Date.now(),
            }, this.session);
          } catch (_sigErr) { /* non-critical */ }

          try {
            await this.fcHandler.handle(this.session.id, this.session, extractedFc);
            // Success reporting moved to Phase 3 so durationMs is available.
          } catch (err) {
            const errMsg = (err as Error).message || String(err);
            console.error(`[GeminiLive] Tool call failed (${fcName}):`, err);
            toolErrors.set(fcName, errMsg);
            reportGlToolCallFailure({
              toolName: fcName,
              sessionId: this.session.id,
              userId: this.session.userId,
              error: errMsg,
            }).catch(() => {});
          }
        })
      );

      // Phase 2: Await ALL background work from ALL handlers in one combined wait.
      // Tools like UNIFIED_RECALL, show_vocab_card, open_scene etc. push async promises
      // to pendingMemoryLookupPromises during handle(). Previously awaited per-tool inside
      // the loop, serializing them. Now all resolve concurrently.
      // TIMEOUT GUARD: cap at 8s — if any lookup hangs, GL stalls forever.
      if (this.session.pendingMemoryLookupPromises?.length) {
        const LOOKUP_TIMEOUT_MS = 8000;
        await Promise.race([
          Promise.all(this.session.pendingMemoryLookupPromises),
          new Promise<void>(resolve => setTimeout(resolve, LOOKUP_TIMEOUT_MS)),
        ]);
        this.session.pendingMemoryLookupPromises = [];
      }

      // Subtitle mode change: check once after all handlers have run.
      // (Previously checked per-tool inside the loop — same outcome since JS is single-threaded.)
      if (this.session.subtitleMode !== 'off' && !this.karaokeTracker) {
        this.karaokeTracker = new GLKaraokeTracker(
          this.session.targetLanguage,
          (msg: any) => this.sendWsMessage(this.session.ws, msg),
        );
        this.karaokeTracker.start().catch(err =>
          console.warn('[GeminiLive] Karaoke tracker late-start failed:', err?.message ?? err)
        );
        console.log('[GeminiLive] Karaoke tracker started (subtitle mode activated mid-session)');
      } else if (this.session.subtitleMode === 'off' && this.karaokeTracker) {
        this.karaokeTracker.destroy();
        this.karaokeTracker = null;
        console.log('[GeminiLive] Karaoke tracker stopped (subtitle mode turned off)');
      }

      // Phase 3: Build responses. Session caches are now fully populated (Phase 2 done).
      // For data-returning tools (memory_lookup, express_lane_lookup, etc.) the handler
      // populates session caches (e.g. session.recallResults). buildFunctionContinuationResponse
      // reads those caches and returns the formatted payload for Daniela.
      for (const [idx, fc] of msg.toolCall.functionCalls.entries()) {
        const fcName = fc.name || '';
        const extractedFc = extractedFcs[idx];

        let toolResponsePayload: GLToolResponsePayload = { result: 'done' };

        if (toolErrors.has(fcName)) {
          toolResponsePayload = { result: `Tool call failed: ${toolErrors.get(fcName)}` };
        } else {
          const continuationText = buildFunctionContinuationResponse(this.session, extractedFc);
          if (continuationText) {
            if (typeof continuationText === 'string') {
              toolResponsePayload = { result: continuationText };
              console.log(`[GeminiLive] Tool ${fcName}: returning ${continuationText.length} chars of result data`);
            } else if (continuationText && typeof continuationText === 'object' && (continuationText as any).multimodal) {
              // Multimodal response — extract text parts only for the tool response payload.
              // GL tool responses cannot carry inlineData (binary) — sending base64 image data
              // in the text field causes a 1007 "invalid argument" session crash.
              // The inlineData is sent separately below as a realtimeInput media chunk.
              const parts: any[] = (continuationText as any).parts || [];
              const textOnly = parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n');
              const inlineParts = parts.filter((p: any) => p.inlineData);
              // Race condition mitigation: image arrives via realtimeInput after this tool response.
              // The model may start generating audio before the image arrives. The hint tells it
              // to pause and receive the image before responding to it. (3-flash audit June 13 2026)
              const imageHint = inlineParts.length > 0 ? '\n\n[Image incoming via visual channel — wait to receive it before describing or responding to it]' : '';
              toolResponsePayload = { result: (textOnly || 'done') + imageHint };
              console.log(`[GeminiLive] Tool ${fcName}: multimodal — returning ${(toolResponsePayload.result as string).length} chars text + ${inlineParts.length} inline part(s) via realtimeInput`);
              // Queue inline parts to send after tool response is dispatched.
              if (inlineParts.length > 0 && this.liveSession) {
                for (const p of inlineParts) {
                  this.pendingInlineParts.push({ mimeType: (p as any).inlineData.mimeType, data: (p as any).inlineData.data });
                }
              }
            } else {
              const text = JSON.stringify(continuationText);
              toolResponsePayload = { result: text };
              console.log(`[GeminiLive] Tool ${fcName}: returning ${text.length} chars of result data`);
            }
          }
        }

        // Co-pilot: push to tool call trace ring buffer (last 20)
        // Phase 3 is also where we fire reportGlToolCallSuccess — it's the earliest point
        // where durationMs is available (toolStartTimes was set in Phase 1).
        {
          if (!this.session.toolCallTrace) this.session.toolCallTrace = [];
          const startMs = toolStartTimes.get(fcName) ?? Date.now();
          const callDurationMs = Date.now() - startMs;
          const isToolError = toolErrors.has(fcName);
          const resultStr = isToolError
            ? `ERROR: ${toolErrors.get(fcName)}`
            : JSON.stringify(toolResponsePayload).slice(0, 200);
          this.session.toolCallTrace.push({
            toolName: fcName,
            argsPreview: JSON.stringify(extractedFc.args ?? {}).slice(0, 120),
            resultPreview: resultStr,
            durationMs: callDurationMs,
            timestamp: Date.now(),
            status: isToolError ? 'error' : 'ok',
          });
          if (this.session.toolCallTrace.length > 20) this.session.toolCallTrace.shift();

          // Persist success with timing — failures were already reported in Phase 1.
          if (!isToolError) {
            reportGlToolCallSuccess({
              toolName: fcName,
              sessionId: this.session.id,
              userId: this.session.userId,
              args: extractedFc.args,
              conversationId: this.session.conversationId,
              durationMs: callDurationMs,
            }).catch(() => {});
          }

          // ── Full GL tool-call record → voice_pipeline_events ────────────────
          // Captures every tool invocation with args, result, duration, and
          // success/failure so the founder dashboard can audit exactly what
          // Daniela called and what came back during any session.
          const toolEventPayload = JSON.stringify({
            toolName: fcName,
            legacyType: extractedFc.legacyType,
            status: isToolError ? 'error' : 'ok',
            durationMs: callDurationMs,
            argsPreview: JSON.stringify(extractedFc.args ?? {}).slice(0, 300),
            resultPreview: resultStr.slice(0, 500),
            conversationId: this.session.conversationId ?? null,
            turnId: this.currentTurnId,
          });
          getSharedDb().execute(sql`
            INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
            VALUES (
              gen_random_uuid(),
              ${this.session.dbSessionId ?? this.session.id},
              ${this.session.userId ? String(this.session.userId) : null},
              'gl_tool_call',
              ${toolEventPayload}::jsonb,
              NOW()
            )
          `).catch(() => {});
        }

        responses.push({
          id: fc.id || '',
          name: fcName,
          response: toolResponsePayload,
        });
      }

      // ── Memory chain guard (GL) ─────────────────────────────────────────────
      // Track consecutive tool batches where every call is a memory retrieval and
      // no voice output was produced. After MEMORY_CHAIN_LIMIT such batches,
      // append a nudge to the last tool response so Daniela synthesizes and speaks.
      // The system prompt paragraph gives her a soft internal limit at 2 lookups;
      // this code backstop fires at 3 as the hard enforcement layer. Counter resets
      // when she produces audio (see generationComplete path) or when any non-memory
      // tool fires in the same batch.
      {
        const batchToolNames = msg.toolCall.functionCalls.map((fc: any) => fc.name as string);
        const allMemoryBatch = batchToolNames.every((n: string) => MEMORY_TOOL_NAMES.has(n));

        if (!allMemoryBatch) {
          this.session.consecutiveMemoryCalls = 0;
          this.session.glMemoryNudgeSent = false;
        } else {
          const prev = this.session.consecutiveMemoryCalls ?? 0;
          this.session.consecutiveMemoryCalls = prev + 1;
          if (
            !this.session.glMemoryNudgeSent &&
            this.session.consecutiveMemoryCalls >= MEMORY_CHAIN_LIMIT &&
            responses.length > 0
          ) {
            const lastResp = responses[responses.length - 1];
            const existing = lastResp.response.result ?? '';
            lastResp.response.result = existing + MEMORY_CHAIN_NUDGE_TEXT;
            this.session.glMemoryNudgeSent = true;
            console.log(`[MemoryBudgetGuard][GL] ${this.session.consecutiveMemoryCalls} consecutive memory-only batches — nudge injected once.`);
          }
        }
      }

      // System Whisper injection (Gemini audit 2026-06-17 + review correction):
      // If the turn counter has armed the whisper, append it to the last tool response's result
      // string. Tool responses are a safe channel — GL feeds them to the model as function results,
      // which the model processes but never speaks aloud. This avoids the "read-aloud" failure risk
      // of prepending to student speech. Clears the flag after injection so it fires exactly once.
      if (this.pendingSystemWhisper && responses.length > 0) {
        const last = responses[responses.length - 1];
        const currentResult = last.response.result ?? '';

        // Gap B — Temporal Pacing: inject session elapsed time so Daniela can self-pace.
        // When > 25 minutes in, shift into landing mode (synthesize wins, set cliffhanger).
        const sessionElapsedMs = Date.now() - (this.session.startTime || Date.now());
        const sessionElapsedMin = Math.floor(sessionElapsedMs / 60000);
        const isPlacementActive = !!(this.session as any).placementMode?.active;
        const isFounderMode = !!(this.session as any).isFounderMode;
        const isRawHonestyMode = !!(this.session as any).isRawHonestyMode;
        // Clock whisper — mode-aware:
        // Placement: no close until set_actfl_level called.
        // Founder: extend to 45 min; wrap up product decisions, not language wins.
        // Honesty: end as a friend, no tutoring recap.
        // Default: standard language session wind-down at 25 min.
        const founderWindDown = isFounderMode && sessionElapsedMin >= 45;
        const defaultWindDown = !isFounderMode && sessionElapsedMin >= 25;
        const temporalNote = isPlacementActive
          ? `Session clock: ~${sessionElapsedMin} min in. Placement assessment in progress — continue probing until set_actfl_level is called. Do not pivot toward a close.`
          : founderWindDown
          ? `Session clock: ~${sessionElapsedMin} min in. Begin wrapping up — summarize the key product decisions and next steps from today's conversation, then wind down naturally.`
          : isRawHonestyMode && defaultWindDown
          ? `Session clock: ~${sessionElapsedMin} min in. End the conversation naturally, as a friend would. No tutoring recap or language wins summary.`
          : defaultWindDown
          ? `Session clock: ~${sessionElapsedMin} min in. Begin pivoting toward a natural close — name today's wins, set a cliffhanger that makes them want to come back. Don't start new grammar topics.`
          : `Session clock: ~${sessionElapsedMin} min in.`;

        // Friction Score: append rolling hesitation + word-density signal so Daniela
        // can auto-adjust CEFR level and pacing without being told explicitly.
        // Suppressed / overridden in exception states:
        // - Placement: probing generates HIGH friction by design; "simplify" contradicts the protocol.
        // - Founder: long pauses = deep thinking, not language struggle; signal would be patronizing.
        // - Honesty: high friction IS the goal — student working without scaffolding. "Simplify" breaks the mode.
        //   Instead inject a positive reminder: silence is part of the experience.
        const frictionSignal = (isPlacementActive || isFounderMode)
          ? ''
          : isRawHonestyMode
          ? (() => {
              const raw = this.buildFrictionSignal();
              // Replace the "Encourage and slow down" instruction with the honesty-mode equivalent
              return raw ? raw.replace(/Encourage and slow down\.[^.]*\./g, 'Stay silent — the student is working. Do not scaffold or prompt.') : '';
            })()
          : this.buildFrictionSignal();

        // T002: Rotate whisper label, phrasing, and clock/friction order to prevent
        // semantic satiation — static repeating tokens lose attention weight over long sessions.
        // T008: Include turn reference so Daniela knows this score is 2-3 turns old.
        const turn = this.currentTurnId;
        const clockFirst = (turn % 2 === 0);
        const coreContent = clockFirst
          ? `${temporalNote}${frictionSignal ? ` ${frictionSignal}` : ''}`
          : `${frictionSignal ? `${frictionSignal} ` : ''}${temporalNote}`;
        const tails = [
          `Trust what you hear right now over this score — it was captured around turn ${turn}. Reach into growth_memory when you encourage — a student's name is not their friction level.`,
          `This signal reflects ~turn ${turn}, not the current moment. If they sound different now, trust your ears. Specificity beats generic encouragement every time.`,
          `Score is a few turns old (turn ~${turn}). Voice the student you hear right now. Check growth_memory before encouraging — something real is always better than something warm.`,
        ];
        const labels = ['System note — not spoken', 'Background signal — silent', 'Tutor advisory — not aloud', 'Internal compass — unspoken'];
        // Affirmation variety note: if Daniela has been using the same openers, remind her
        // to vary them. Injected as part of the existing whisper — no extra sendClientContent.
        const affirmationNote = this.recentAffirmationPhrases.length >= 2
          ? ` Vary affirmations — recently used: ${this.recentAffirmationPhrases.slice(-3).map(p => `"${p}"`).join(', ')}. Skip the opener or pick something different.`
          : '';
        const whisperPayload = `[${labels[turn % labels.length]}: ${coreContent}${affirmationNote} ${tails[turn % tails.length]}]`;

        last.response.result = currentResult
          + (currentResult ? '\n\n' : '')
          + whisperPayload;
        this.pendingSystemWhisper = false;
        this.lastWhisperTime = Date.now(); // reset hybrid clock — next whisper triggers from here
        console.log(`[GeminiLive] System Whisper injected into tool response (${last.name}) — ${sessionElapsedMin}min elapsed${frictionSignal ? ` | ${frictionSignal}` : ''}`);
      }

      // Archive Guardian injection — unified whisper block.
      //
      // Two grounding sources, one channel:
      //   [LAST TURN CORRECTION] — post-turn: slide detected in Daniela's previous output.
      //                             Queued in pendingWeeOoGrounding after generationComplete.
      //   [CURRENT CONTEXT]      — pre-turn: student's speech contained a memory-risk phrase.
      //                             Archive lookup fired on inputTranscription; result already
      //                             resolved into preTurnGroundingResult by .then() callback.
      //
      // Race condition guard (Gemini audit recommendation):
      // If the pre-turn DB lookup is still running when the first tool call arrives,
      // await the promise with a 400ms cap so we don't miss a result that's nearly done.
      if (this.preTurnGroundingPromise && this.preTurnGroundingResult === null) {
        await Promise.race([
          this.preTurnGroundingPromise,
          new Promise<void>(resolve => setTimeout(resolve, 400)),
        ]);
      }
      if (priorTurnFinalizationWaitPromise) {
        await priorTurnFinalizationWaitPromise;
      } else if (this.pendingPriorTurnGrounding && this.currentStudentTurnBoundaryTrusted) {
        await this.waitForInputTranscriptionFinalization(this.activeStudentTurnEpoch);
      }

      const guardianWhispers: Array<{
        text: string;
        attemptId: string | null;
        lineageEventId: string | null;
      }> = [];
      if (
        this.pendingWeeOoGrounding
        && this.pendingWeeOoGroundingBinding
        && isGroundingBindingCurrent(
          this.pendingWeeOoGroundingBinding,
          this.activeStudentTurnEpoch,
        )
      ) {
        // Slide-triggered corrections get a behavioral directive — not just context but an
        // explicit instruction to verify before continuing. This is Tier B: turning passive
        // grounding delivery into an active "check before you speak" lock.
        const correctionLabel = this.slideCorrectionQueued
          ? `[LAST TURN CORRECTION — ARCHIVE SYNC: Our shared history contains specific records relevant to your last turn. Archive Data:\n${this.pendingWeeOoGrounding}\n\nTo ensure we stay aligned, please use grounding_query or introspect to reconcile this information before making further assertions about our shared history.]`
          : `[LAST TURN CORRECTION: ${this.pendingWeeOoGrounding}]`;
        const queuedAttemptId = this.pendingWeeOoGroundingAttemptId;
        guardianWhispers.push({ text: correctionLabel, attemptId: queuedAttemptId, lineageEventId: null });
        this.pendingWeeOoGrounding = null;
        this.pendingWeeOoGroundingBinding = null;
        this.pendingWeeOoGroundingAttemptId = null;
        this.slideCorrectionQueued = false;
      } else if (this.pendingWeeOoGrounding) {
        console.warn('[ArchiveGuardian] Discarding stale or unbound queued grounding before tool response.');
        this._traceGuardianAttempt(this.pendingWeeOoGroundingAttemptId, {
          type: 'stale_discarded',
          detail: 'Queued grounding no longer matched the active student turn at tool response.',
        });
        this.pendingWeeOoGrounding = null;
        this.pendingWeeOoGroundingBinding = null;
        this.pendingWeeOoGroundingAttemptId = null;
        this.slideCorrectionQueued = false;
      }
      if (this.pendingPriorTurnGrounding) {
        const priorAttemptId = this.pendingPriorTurnGroundingAttemptId;
        const inputTranscriptionFinished =
          this.finalizedStudentTurnEpoch === this.activeStudentTurnEpoch;
        const reopenedPriorContext = releasePriorTurnGroundingCorrection(
          this.pendingPriorTurnGrounding,
          this.activeStudentTurnEpoch,
          this.activeStudentUtterance || this.pendingInputTranscript,
          inputTranscriptionFinished,
          this.currentStudentTurnBoundaryTrusted,
        );
        if (reopenedPriorContext) {
          guardianWhispers.push({
            text: reopenedPriorContext,
            attemptId: priorAttemptId,
            lineageEventId: null,
          });
          console.log(
            `[ArchiveGuardian] Released prior-turn grounding from student turn `
            + `${this.pendingPriorTurnGrounding.binding.studentTurnEpoch} on explicit topic return.`,
          );
          this.pendingPriorTurnGrounding = null;
          this.pendingPriorTurnGroundingAttemptId = null;
        } else if (this.pendingPriorTurnGrounding.eligibleStudentTurnEpoch !== this.activeStudentTurnEpoch) {
          this._traceGuardianAttempt(priorAttemptId, {
            type: 'stale_discarded',
            detail: 'Dormant prior-turn grounding expired before tool-response evaluation.',
          });
          this.pendingPriorTurnGrounding = null;
          this.pendingPriorTurnGroundingAttemptId = null;
        } else if (!this.currentStudentTurnBoundaryTrusted) {
          console.warn(
            `[ArchiveGuardian] Discarding prior-turn grounding from student turn `
            + `${this.pendingPriorTurnGrounding.binding.studentTurnEpoch} because student turn `
            + `${this.activeStudentTurnEpoch} has an ambiguous transcription boundary.`,
          );
          this._traceGuardianAttempt(priorAttemptId, {
            type: 'stale_discarded',
            detail: 'Student turn had an ambiguous transcription boundary; dormant prior-turn grounding was withheld.',
          });
          this.pendingPriorTurnGrounding = null;
          this.pendingPriorTurnGroundingAttemptId = null;
        } else if (!inputTranscriptionFinished) {
          console.log(
            `[ArchiveGuardian] Prior-turn grounding from student turn `
            + `${this.pendingPriorTurnGrounding.binding.studentTurnEpoch} deferred because student turn `
            + `${this.activeStudentTurnEpoch} has no final transcription signal yet.`,
          );
        } else {
          console.log(
            `[ArchiveGuardian] Prior-turn grounding withheld from non-matching student turn `
            + `${this.activeStudentTurnEpoch}.`,
          );
        }
      }
      if (
        this.preTurnGroundingResult !== null
        && this.preTurnGroundingBinding
        && isGroundingBindingCurrent(this.preTurnGroundingBinding, this.activeStudentTurnEpoch)
      ) {
        const currentGrounding = formatCurrentTurnGroundingContext(
          this.preTurnGroundingBinding,
          this.preTurnGroundingResult,
        );
        // Use the emotional framing when the student disclosed something vulnerable.
        // preTurnGroundingIsEmotional may have been updated by the re-scan loop even
        // after the initial grounding fire (handles short phrases like "I feel stupid"
        // that cross the emotional threshold on a later transcript chunk).
        if (this.preTurnGroundingIsEmotional) {
          guardianWhispers.push({
            text: `[ARCHIVE GUARDIAN — STUDENT SHARED SOMETHING PERSONAL: A student just disclosed something vulnerable — embarrassment, self-doubt, or fear. Your archive holds the threads that make this response witnessed, not just accurate.\n${currentGrounding}]`,
            attemptId: this.preTurnGroundingAttemptId,
            lineageEventId: this.preTurnGroundingLineageEventId,
          });
        } else {
          guardianWhispers.push({
            text: currentGrounding,
            attemptId: this.preTurnGroundingAttemptId,
            lineageEventId: this.preTurnGroundingLineageEventId,
          });
        }
        this.preTurnGroundingResult = null;
        this.preTurnGroundingBinding = null;
        this.preTurnGroundingAttemptId = null;
      }
      if (guardianWhispers.length > 0) {
        // Instructional Piggybacking (July 26 2026 — Gemini-approved wording, DB: b5503bea):
        // Every SESSION_ANCHOR_INTERVAL student turns, fold the Session Anchor prose INSIDE
        // the ARCHIVE GUARDIAN bracket. Tool results sit at position N (highest attention
        // weight) — this is how core behavioral directives refresh without a system prompt
        // update or sendClientContent call as the session grows. Prose style: "Internalized
        // Intuition" — she surfaces it from within, not commanded from outside.
        // Nested sub-label format — consistent with [LAST TURN CORRECTION] and [CURRENT CONTEXT].
        // The outer ARCHIVE GUARDIAN bracket creates the System/Guardian layer; inner brackets
        // are Contextual Triggers within it. Raw prose (previous approach) breaks the hierarchy
        // and signals differently to Gemini's attention system. Nested is the confirmed-effective
        // pattern (July 25 2026). Prose text is Gemini-approved (DB: b5503bea, July 26 2026).
        const sessionAnchorText = this.sessionStudentTurnCount > 0
          && this.sessionStudentTurnCount % GeminiLiveSession.SESSION_ANCHOR_INTERVAL === 0
          ? `\n[SESSION ANCHOR: The heart of this session is the language itself. I am a teacher first; my warmth serves the lesson, and my words are chosen for their impact. The Archive is the bedrock of my memory; I speak from its truths, and where the record is silent, I prefer the honesty of the unknown over the friction of a guess.]`
          : '';
        if (sessionAnchorText) {
          console.log(`[ArchiveGuardian/anchor] Session Anchor injected at turn ${this.sessionStudentTurnCount}`);
        }
        const guardianWhisper = `[ARCHIVE GUARDIAN:\n${guardianWhispers.map(whisper => whisper.text).join('\n')}${sessionAnchorText}]`;
        // Find the most recent fire log entry that hasn't had its channel recorded yet
        const recentFireForChannel = this.guardianFireLog.findLast(e => e.channel === null);
        // Always use concat channel — dedicated channel (sendClientContent) disabled.
        // sendClientContent turnComplete:true = duplicate generation; false = blocks VAD.
        // Tool-result body is the only safe injection channel available in the GL API.
        if (responses.length > 0) {
          const last = responses[responses.length - 1];
          const currentResult = last.response.result ?? '';
          last.response.result = currentResult
            + (currentResult ? '\n\n' : '')
            + guardianWhisper;
          const assembledContextId = this._recordContextLineage({
            traceId: toolCallTraceId ?? undefined,
            studentTurnEpoch: toolCallStudentTurnEpoch,
            sourceRoute: 'gemini-live',
            eventType: 'context_prepared',
            deliveryChannel: 'tool_response',
            payloadText: guardianWhisper,
            deliveryStatus: 'queued',
          });
          if (
            assembledContextId
            && toolCallTraceId
          ) {
            assembledContextLineageEvents.push(assembledContextId);
            for (const sourceEventId of new Set(
              guardianWhispers.map(whisper => whisper.lineageEventId).filter((id): id is string => Boolean(id)),
            )) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: sourceEventId,
                toEventId: assembledContextId,
                linkType: 'derived_from',
              });
            }
          }
          console.log(`[ArchiveGuardian/concat] ${guardianWhispers.length} whisper(s) injected into tool response (${last.name}) — ${guardianWhisper.length} chars`);
          for (const attemptId of new Set(guardianWhispers.map(whisper => whisper.attemptId).filter((id): id is string => Boolean(id)))) {
            guardianAttemptIdsInToolResponse.push(attemptId);
            this._traceGuardianAttempt(attemptId, {
              type: 'injected',
              channel: 'tool-response',
              modelTurnId: localTurnId,
              toolBatchSequence,
              detail: `Appended to ${last.name} function response.`,
            });
            this._traceGuardianAttempt(attemptId, {
              type: 'tool_response_consumed',
              channel: 'tool-response',
              modelTurnId: localTurnId,
              toolBatchSequence,
              detail: `Grounding text is present in ${last.name} response body.`,
            });
          }
          if (recentFireForChannel) { recentFireForChannel.channel = 'concat'; recentFireForChannel.charsInjected = guardianWhisper.length; }
          this._observeGuardian();
        }
      }

      // Parallel speech whisper — transcript injection:
      // When parallel speech preserved the pre-tool audio (preTurnTextForWhisper is set),
      // inject a "don't re-speak" note alongside the tool result so GL resumes from AFTER
      // the acknowledgment instead of repeating it. This is the anti-double-speech mechanism
      // for the Stage 3 path (as opposed to gl_audio_reset for the Stage 2 path).
      // Injected into the LAST tool response so it is the most-recently-seen context.
      if (this.preTurnTextForWhisper && responses.length > 0) {
        const last = responses[responses.length - 1];
        const currentResult = last.response.result ?? '';
        const transcriptWhisper = `[Parallel speech — not spoken: You have already spoken the following aloud: "${this.preTurnTextForWhisper}". Do not repeat these words. Resume your response immediately with the information found.]`;
        last.response.result = currentResult
          + (currentResult ? '\n\n' : '')
          + transcriptWhisper;
        console.log(`[GeminiLive] Parallel speech whisper injected — "${this.preTurnTextForWhisper.slice(0, 60)}"`);
        this.preTurnTextForWhisper = null; // consumed — clear for next turn
      }

      // Gap C — Silent Tool Failure Recovery: if a visual tool failed this turn,
      // inject an explicit correction note so Daniela doesn't reference an image
      // the student never saw. Cleared after injection so it fires once per failure.
      if ((this.session as any).lastVisualFailure && responses.length > 0) {
        const last = responses[responses.length - 1];
        const currentResult = last.response.result ?? '';
        const failureNote = `[System note — not spoken: A visual failed to load (${(this.session as any).lastVisualFailure}). Do not reference the image or ask the student about it. Describe the concept in words instead — act as if you had intended to use words all along.]`;
        last.response.result = currentResult + (currentResult ? '\n\n' : '') + failureNote;
        (this.session as any).lastVisualFailure = undefined;
        console.log(`[GeminiLive] Gap C: visual failure note injected into tool response`);
      }

      // Gap 10 — Multi-modal continuity: flush any queued frontend context into the tool response.
      // These are brief, factual notes about what the student is currently seeing on screen
      // (widget opened, lesson page displayed, scene image shown). Queued via session.pendingGlContext
      // by native-fc-handlers when dispatching whiteboard events. Safe channel — never spoken aloud.
      const pendingCtx = this.session.pendingGlContext;
      if (pendingCtx?.length && responses.length > 0) {
        const last = responses[responses.length - 1];
        const currentResult = last.response.result ?? '';
        // Observer-report format (Gemini audit recommendation): state what IS showing now,
        // not what was shown before. Model reads this as the current visual state post-tool.
        const ctxNote = '[SYSTEM UPDATE — not spoken: The student\'s screen now shows: ' + pendingCtx.join(' | ') + ']';
        last.response.result = currentResult + (currentResult ? '\n\n' : '') + ctxNote;
        this.session.pendingGlContext = [];
        console.log(`[GeminiLive] Gap 10: flushed ${pendingCtx.length} frontend context item(s) into tool response`);
      }

      // Gap 11 — Episode deep-read chunk injection.
      // recall_episode_deep() fetches full episode content in the background and queues it in
      // session.episodeReadQueue. One chunk per tool-response batch delivers large archives
      // across turns without silence or summarization. Safe channel — never spoken aloud.
      const episodeQueue = (this.session as any).episodeReadQueue as Array<{
        label: string; content: string; chunkIndex: number; totalChunks: number; isFinal: boolean;
      }> | undefined;
      if (episodeQueue?.length && responses.length > 0) {
        const chunk = episodeQueue.shift()!;
        const last = responses[responses.length - 1];
        const currentResult = last.response.result ?? '';
        const remainingNote = chunk.isFinal
          ? 'Final part — full episode now delivered.'
          : `${episodeQueue.length} more part(s) will arrive automatically on subsequent turns.`;
        const header = `\n\n[INTERNAL ARCHIVE DATA - DO NOT VOCALIZE]\nSource: "${chunk.label}" (Part ${chunk.chunkIndex}/${chunk.totalChunks})\n${remainingNote}\nCONTENT:\n---\n`;
        last.response.result = currentResult + header + chunk.content + `\n---`;
        console.log(`[GeminiLive] Gap 11: episode chunk injected — "${chunk.label}" ${chunk.chunkIndex}/${chunk.totalChunks} (${chunk.content.length} chars, ${episodeQueue.length} remaining)`);
      }

      // Observer Seat — persistent interface state snapshot. Injected into tool-response batches
      // so Daniela knows what is currently visible on the student's screen between tool calls.
      // Fires on state change (diff) OR every 10 tool calls (heartbeat) — whichever comes first.
      // Heartbeat ensures the snapshot stays in GL's recent-context window during long verbal
      // exchanges where no visual tools fire. Safe channel — tool response text is never spoken.
      if (responses.length > 0) {
        const stateSnapshot = buildInterfaceStateSnapshot(this.session);
        const lastSnapshot = (this.session as any)._lastObserverSnapshot as string | undefined;
        const seatCallCount = ((this.session as any)._observerSeatCallCount as number | undefined) ?? 0;
        const newSeatCallCount = seatCallCount + 1;
        (this.session as any)._observerSeatCallCount = newSeatCallCount;
        const heartbeat = newSeatCallCount % 10 === 0; // re-inject every 10 tool calls
        if (stateSnapshot && (stateSnapshot !== lastSnapshot || heartbeat)) {
          const last = responses[responses.length - 1];
          const currentResult = last.response.result ?? '';
          last.response.result = currentResult
            + (currentResult ? '\n\n' : '')
            + `[Observer Seat — not spoken: ${stateSnapshot}]`;
          (this.session as any)._lastObserverSnapshot = stateSnapshot;
          if (heartbeat) console.log(`[GeminiLive] Observer Seat: heartbeat injection (call ${newSeatCallCount})`);
        }
      }

      // Scaffolding Slider — Contextual Echoing:
      // Injects the current scaffolding level (1-10) every 5 tool-response batches so
      // Daniela stays calibrated between tool calls. Level is computed from ACTFL, gear,
      // and struggle count. This is a background calibration note — not an emergency directive.
      // Runs BEFORE the Pedagogical Supervisor so the supervisor is always the final word.
      const scaffoldingCallCount = ((this.session as any)._scaffoldingCallCount || 0) + 1;
      (this.session as any)._scaffoldingCallCount = scaffoldingCallCount;
      if (responses.length > 0 && scaffoldingCallCount % 5 === 0) {
        const level = computeScaffoldingLevel(this.session);
        const descriptor =
          level <= 2 ? 'maximum scaffolding — full native-language support, define every word, short sentences' :
          level <= 4 ? 'heavy scaffolding — native-language explanations, simple target-language phrases only' :
          level <= 6 ? 'balanced — 50/50 language mix, corrections in native language, practice in target language' :
          level <= 8 ? 'light scaffolding — mostly target language, native language only for new concept clarification' :
                       'no scaffolding — full target language, native speed, treat errors as production mistakes';
        const last = responses[responses.length - 1];
        if (last?.response) {
          const currentResult = last.response.result ?? '';
          const note = `[Scaffolding Level — not spoken: ${level}/10 — ${descriptor}]`;
          last.response.result = currentResult + (currentResult ? '\n\n' : '') + note;
          console.log(`[GeminiLive] ScaffoldingSlider level ${level}/10 injected (call ${scaffoldingCallCount})`);
        }
      }

      // Session Scratchpad reminder — compact working-memory footer injected once every 8
      // tool-response batches (heartbeat) so GL Daniela stays aware of her accumulated notes
      // without flooding the tool channel. Individual write/read calls return their own
      // confirmation via buildContinuationResponse — this is the background heartbeat.
      if (responses.length > 0) {
        const scratchpadNotes = (this.session as any).sessionNotes as string[] | undefined;
        if (scratchpadNotes?.length) {
          const scratchpadCallCount = (((this.session as any)._scratchpadCallCount as number | undefined) ?? 0) + 1;
          (this.session as any)._scratchpadCallCount = scratchpadCallCount;
          if (scratchpadCallCount % 8 === 0) {
            const notesSummary = scratchpadNotes.length === 1
              ? scratchpadNotes[0].substring(0, 120)
              : `${scratchpadNotes.length} notes — latest: "${scratchpadNotes[scratchpadNotes.length - 1].substring(0, 80)}"`;
            const last = responses[responses.length - 1];
            const currentResult = last.response.result ?? '';
            last.response.result = currentResult + (currentResult ? '\n\n' : '')
              + `[Session Working Memory — not spoken: ${notesSummary}]`;
            console.log(`[GeminiLive] SessionScratchpad: heartbeat reminder injected (${scratchpadNotes.length} note(s))`);
          }
        }
      }

      // Pedagogical Supervisor — Emergency Brake:
      // Runs LAST so its directive is the final word Daniela reads before responding —
      // overriding all earlier phase/context notes per Gemini review recommendation.
      // Priority: consume any pending thought-directive first (set at generationComplete
      // via thought-stream analysis). If no pending directive, run the rule-based check.
      // Either way, the heartbeat's pending directive is cleared — tool response delivery
      // is higher-quality than the sendClientContent heartbeat channel.
      if (responses.length > 0) {
        let pedagogicalDirective: { directive: string; urgency: 'emergency' | 'nudge' } | null = null;
        if ((this.session as any).placementMode?.active) {
          // Placement assessment in progress — suppress all Supervisor directives.
          // Phase nudges (COOL_DOWN at min 15, death spiral) are false signals here;
          // clearing pendingDirectiveText ensures nothing stored from thought stream fires either.
          this.pendingDirectiveText = null;
        } else if (this.pendingDirectiveText) {
          // Thought-directive already evaluated — deliver via tool response (best channel)
          pedagogicalDirective = { directive: this.pendingDirectiveText, urgency: this.pendingDirectiveUrgency };
          this.pendingDirectiveText = null; // consumed — heartbeat will not fire
        } else {
          pedagogicalDirective = evaluatePedagogicalState(this.session);
        }
        if (pedagogicalDirective) {
          const last = responses[responses.length - 1];
          const currentResult = last.response.result ?? '';
          const urgencyPrefix = pedagogicalDirective.urgency === 'emergency' ? 'URGENT — ' : '';
          const note = `[Pedagogical Supervisor — not spoken: ${urgencyPrefix}${pedagogicalDirective.directive}]`;
          last.response.result = currentResult + (currentResult ? '\n\n' : '') + note;
          console.log(`[GeminiLive] PedagogicalSupervisor [${pedagogicalDirective.urgency}] injected into tool response (${(last as any).name ?? 'unknown'}): ${pedagogicalDirective.directive.slice(0, 80)}...`);
        }
      }

      // Call-ID guard: if a barge-in advanced currentTurnId while handlers were running,
      // drop these responses — they belong to the interrupted turn. Sending them would cause
      // "hallucinated continuity" where Daniela references a whiteboard or scene the student
      // already barged past. GL stall risk is low: the interrupted turn has no pending model turn.
      if (this.currentTurnId !== localTurnId) {
        console.log(`[GeminiLive] Call-ID guard: dropping ${responses.length} tool response(s) — turn ${localTurnId} superseded by turn ${this.currentTurnId} (barge-in during tool execution)`);
        for (const attemptId of guardianAttemptIdsInToolResponse) {
          this._traceGuardianAttempt(attemptId, {
            type: 'stale_discarded',
            detail: 'Tool response was dropped after the student barged into a newer model turn.',
          });
        }
        this._recordContextLineage({
          traceId: toolCallTraceId ?? undefined,
          studentTurnEpoch: toolCallStudentTurnEpoch,
          sourceRoute: 'gemini-live',
          eventType: 'tool_response_discarded_by_barge_in',
          deliveryChannel: 'tool_response',
          deliveryStatus: 'discarded',
          payloadJson: {
            localTurnId,
            currentTurnId: this.currentTurnId,
            functionResponseCount: responses.length,
            functionResponseNames: responses.map(response => response.name),
          },
        });
        if (toolCallTraceId) {
          for (const contextEventId of assembledContextLineageEvents) {
            const discardEventId = this._recordContextLineage({
              traceId: toolCallTraceId,
              studentTurnEpoch: toolCallStudentTurnEpoch,
              sourceRoute: 'gemini-live',
              eventType: 'prepared_context_discarded_by_barge_in',
              deliveryChannel: 'tool_response',
              deliveryStatus: 'discarded',
            });
            if (discardEventId) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: contextEventId,
                toEventId: discardEventId,
                linkType: 'superseded_by',
              });
            }
          }
        }
        return;
      }

      // Always send tool responses — Gemini Live stalls if we don't
      if (this.liveSession && responses.length > 0) {
        try {
          // Clear the deadlock-guard before sending — once the response is in flight
          // the turn is resolved regardless of what happens to the connection next.
          this.pendingFunctionCallIds = [];
          this.liveSession.sendToolResponse({ functionResponses: responses });
          observeToolResults(this.session.conversationId, responses as any[]);
          const directSendEventId = this._recordDirectLineageAttempt({
            traceId: toolCallTraceId ?? undefined,
            studentTurnEpoch: toolCallStudentTurnEpoch,
            sourceRoute: 'gemini-live',
            eventType: 'tool_response_send_attempted',
            deliveryChannel: 'sendToolResponse',
            deliveryStatus: 'attempted',
            payloadJson: {
              functionResponseCount: responses.length,
              functionResponseNames: responses.map(response => response.name),
            },
          });
          if (directSendEventId && toolCallTraceId) {
            for (const contextEventId of assembledContextLineageEvents) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: contextEventId,
                toEventId: directSendEventId,
                linkType: 'sent_with',
              });
            }
            if (toolCallCallbackEventId) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: toolCallCallbackEventId,
                toEventId: directSendEventId,
                linkType: 'caused_by',
              });
            }
          }
          console.log(`[GeminiLive] Tool responses sent: ${responses.map(r => r.name).join(', ')}`);
          for (const attemptId of guardianAttemptIdsInToolResponse) {
            this._traceGuardianAttempt(attemptId, {
              type: 'tool_response_sent',
              channel: 'tool-response',
              modelTurnId: localTurnId,
              toolBatchSequence,
              detail: 'Gemini Live accepted the function-response dispatch.',
            });
          }
        } catch (err) {
          console.error('[GeminiLive] Failed to send tool responses:', err);
          const failedSendEventId = this._recordContextLineage({
            traceId: toolCallTraceId ?? undefined,
            studentTurnEpoch: toolCallStudentTurnEpoch,
            sourceRoute: 'gemini-live',
            eventType: 'tool_response_send_failed',
            deliveryChannel: 'sendToolResponse',
            deliveryStatus: 'failed',
            payloadJson: {
              error: err instanceof Error ? err.message : String(err),
              functionResponseCount: responses.length,
              functionResponseNames: responses.map(response => response.name),
            },
          });
          if (failedSendEventId && toolCallTraceId) {
            for (const contextEventId of assembledContextLineageEvents) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: contextEventId,
                toEventId: failedSendEventId,
                linkType: 'sent_with',
              });
            }
            if (toolCallCallbackEventId) {
              this._linkContextLineage({
                traceId: toolCallTraceId,
                fromEventId: toolCallCallbackEventId,
                toEventId: failedSendEventId,
                linkType: 'caused_by',
              });
            }
          }
          for (const attemptId of guardianAttemptIdsInToolResponse) {
            this._traceGuardianAttempt(attemptId, {
              type: 'queued',
              channel: 'tool-response',
              detail: `Tool-response dispatch failed: ${(err as Error).message}`,
            });
          }
        }

        // Send any queued inline image parts (vision) as realtimeInput after tool response.
        // These were stripped from the tool response payload to prevent 1007 crashes.
        // H4 fix: use typed class field (not (this as any)) and re-check liveSession
        // before each send — sendToolResponse() yields to the event loop and a reconnect
        // could null liveSession between the batch send and the inline parts loop.
        if (this.pendingInlineParts.length > 0) {
          const partsToSend = this.pendingInlineParts.splice(0);
          for (const part of partsToSend) {
            if (!this.liveSession) {
              console.warn('[GeminiLive] liveSession gone before inline parts could be sent — dropping remaining parts');
              break;
            }
            try {
              (this.liveSession as any).sendRealtimeInput({
                mediaChunks: [{ mimeType: part.mimeType, data: part.data }],
              });
              console.log(`[GeminiLive] Vision inline data sent via realtimeInput (${part.mimeType})`);
            } catch (vErr) {
              console.warn('[GeminiLive] Failed to send vision inline data:', (vErr as Error).message);
            }
          }
        }

        // Async-Ack image delivery: show_image queues into pendingAsyncImagePromises rather
        // than pendingMemoryLookupPromises so the tool response returns immediately.
        // When image generation completes, send the vision inline data to Daniela so she
        // can see what she showed the student on the next turn. The student's whiteboard
        // receives the image earlier via a direct WS push inside the show_image IIFE.
        const asyncImagePromises: Promise<void>[] | undefined = (this.session as any).pendingAsyncImagePromises;
        if (asyncImagePromises?.length) {
          (this.session as any).pendingAsyncImagePromises = [];
          Promise.allSettled(asyncImagePromises).then((results) => {
            const visionEntry = (this.session as any).visionBuffer?.['show_image'];
            if (visionEntry?.inlineData && this.liveSession) {
              // Success path: image generated — deliver vision bytes to Daniela
              try {
                (this.liveSession as any).sendRealtimeInput({
                  mediaChunks: [{ mimeType: visionEntry.inlineData.mimeType, data: visionEntry.inlineData.data }],
                });
                console.log('[GeminiLive] Async-Ack: show_image vision data delivered to Daniela via realtimeInput');
              } catch (_asyncVErr) {
                // Non-critical — Daniela will pick up the image on the next show_image call
              }
            } else {
              // Ghost Image failure: all promises settled but no vision data arrived.
              // DO NOT inject via sendRealtimeInput({ text }) — that channel is for PCM audio
              // only. Text sent via sendRealtimeInput is treated as student speech, not a
              // system note, and Daniela would read it aloud or respond to it as student input.
              // The safe channel (sendClientContent) risks audio doubling mid-session.
              //
              // Instead we rely on the receipt framing: "should appear... do not describe
              // specific visual details until the image arrives in your vision feed."
              // If it never arrives, she simply never gets the visual confirmation and
              // continues teaching conceptually — which is exactly the right behavior.
              const anyFailed = results.some((r) => r.status === 'rejected');
              console.log(`[GeminiLive] Async-Ack: show_image resolved with no vision data (anyFailed=${anyFailed}) — receipt framing guards against hallucination, no injection needed`);
            }
          });
        }
      }
    }

    // ── Interruption signal from server ──────────────────────────────────────
    if (msg.toolCallCancellation) {
      console.log('[GeminiLive] Server cancelled tool call(s)');
    }

    // ── Usage metadata — accumulate into session telemetry ───────────────────
    // Feeds the burn report and Daniela's compass credit display.
    if (msg.usageMetadata) {
      const meta = msg.usageMetadata;
      if (meta.promptTokenCount) {
        this.session.telemetryLlmInputTokens =
          (this.session.telemetryLlmInputTokens || 0) + meta.promptTokenCount;
      }
      if ((meta as any).candidatesTokenCount) {
        this.session.telemetryLlmOutputTokens =
          (this.session.telemetryLlmOutputTokens || 0) + (meta as any).candidatesTokenCount;
      }
      if (meta.totalTokenCount) {
        console.log(
          `[GeminiLive] Usage — in: ${meta.promptTokenCount ?? 0}, out: ${(meta as any).candidatesTokenCount ?? 0}, total: ${meta.totalTokenCount} (session cumulative: ${this.session.telemetryLlmInputTokens}in/${this.session.telemetryLlmOutputTokens}out)`,
        );
      }
    }

    // ── Session resumption token ──────────────────────────────────────────────
    // Store the latest handle so a dropped connection can resume without
    // losing conversation context. Also fire the persistence callback so the
    // unified-ws-handler can write it to the DB — survives server restarts.
    if (msg.sessionResumptionUpdate?.newHandle) {
      this.session.geminiLiveResumptionHandle = msg.sessionResumptionUpdate.newHandle;
      this.onResumptionHandleUpdate?.(msg.sessionResumptionUpdate.newHandle);
    }
  }

  /**
   * Expose accumulated token counts so the orchestrator can log them
   * to the burn report when the session ends.
   */
  getUsageSummary(): { inputTokens: number; outputTokens: number; videoFramesSent: number } {
    return {
      inputTokens:     this.session.telemetryLlmInputTokens  || 0,
      outputTokens:    this.session.telemetryLlmOutputTokens || 0,
      videoFramesSent: this.videoFramesSent,
    };
  }

  /** Number of completed conversation exchanges (user turn → Daniela response) this session. */
  getCompletedExchangeCount(): number {
    return this.completedExchanges;
  }

  /**
   * Total characters in all of Daniela's output transcripts this session.
   * Used as a TTS-character proxy for analytics/billing (GL has no separate TTS step).
   */
  getTotalOutputCharacters(): number {
    return this.totalOutputCharacters;
  }

  /**
   * Accumulated speaking time for both parties this session.
   * Used by billing (studentSpeakingSeconds) and analytics (tutorSpeakingSeconds).
   */
  getSpeakingStats(): { studentSpeakingMs: number; tutorSpeakingMs: number } {
    // Include any in-progress tutor turn (session ending mid-speech)
    const activeTutorMs = this.tutorSpeakingStartTime !== null
      ? Date.now() - this.tutorSpeakingStartTime
      : 0;
    return {
      studentSpeakingMs: this.studentSpeakingMs,
      tutorSpeakingMs: this.tutorSpeakingMs + activeTutorMs,
    };
  }

  /**
   * Builds a one-line Friction Score from the rolling pre-speech pause and word count
   * windows. Returns null if not enough data has accumulated yet (< 1 complete turn).
   *
   * Signals are derived entirely from inputTranscription timing — no external API needed.
   * HIGH friction = long pauses + short answers → Daniela should simplify, slow down.
   * LOW friction = quick responses + full sentences → Daniela can push complexity.
   */
  private buildFrictionSignal(): string | null {
    const hasPause = this.recentPreSpeechPauses.length > 0;
    const hasWords = this.recentTurnWordCounts.length > 0;
    const hasMidPause = this.recentMidPauseCounts.length > 0;
    if (!hasPause && !hasWords && !hasMidPause) return null;

    const avgPauseMs = hasPause
      ? this.recentPreSpeechPauses.reduce((a, b) => a + b, 0) / this.recentPreSpeechPauses.length
      : null;
    const avgWords = hasWords
      ? this.recentTurnWordCounts.reduce((a, b) => a + b, 0) / this.recentTurnWordCounts.length
      : null;
    const avgMidPauses = hasMidPause
      ? this.recentMidPauseCounts.reduce((a, b) => a + b, 0) / this.recentMidPauseCounts.length
      : null;

    const parts: string[] = [];
    let frictionLevel: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

    // Thresholds calibrated for language learners (reviewed against Gemini Flash + Daniela):
    // Pre-speech pause: < 3.5s = LOW, 3.5–7s = MEDIUM, > 7s = HIGH
    // Word count: > 12 = LOW, 5–12 = MEDIUM, < 5 = HIGH
    // Mid-sentence pauses (vocabulary search): avg > 1 per turn → escalate one level
    if (avgPauseMs !== null) {
      parts.push(`${(avgPauseMs / 1000).toFixed(1)}s pre-speech pause`);
      if (avgPauseMs > 7000) frictionLevel = 'HIGH';
      else if (avgPauseMs > 3500) frictionLevel = 'MEDIUM';
    }
    if (avgWords !== null) {
      parts.push(`${Math.round(avgWords)} words/turn`);
      if (avgWords < 5) frictionLevel = 'HIGH';
      else if (avgWords < 12) frictionLevel = frictionLevel === 'HIGH' ? 'HIGH' : 'MEDIUM';
    }
    if (avgMidPauses !== null && avgMidPauses >= 1) {
      parts.push(`${avgMidPauses.toFixed(1)} mid-sentence pause${avgMidPauses !== 1 ? 's' : ''}/turn`);
      // Escalate one level — mid-sentence searching is the most predictive struggle signal
      if (frictionLevel === 'LOW') frictionLevel = 'MEDIUM';
      else if (frictionLevel === 'MEDIUM') frictionLevel = 'HIGH';
    }

    const hint = frictionLevel === 'HIGH'
      ? ' Student is struggling — simplify vocabulary, slow pace, offer a sentence frame.'
      : frictionLevel === 'MEDIUM'
      ? ' Some hesitation — check in gently, adjust complexity if it continues.'
      : '';

    const signal = `Student friction: ${frictionLevel} (${parts.join(', ')}).${hint}`;

    // Live alert to Team Room when friction is HIGH — Alden can watch in real time.
    if (frictionLevel === 'HIGH') {
      glLiveAlert({
        sessionId: this.session.id,
        userId: this.session.userId ?? '',
        lang: this.session.targetLanguage,
        eventType: 'friction_high',
        detail: {
          avgPauseMs: avgPauseMs !== null ? Math.round(avgPauseMs) : undefined,
          avgWords: avgWords !== null ? Math.round(avgWords * 10) / 10 : undefined,
          avgMidPauses: avgMidPauses !== null ? Math.round(avgMidPauses * 10) / 10 : undefined,
        },
      });
    }

    // Persist friction snapshot for post-session analysis and Daniela improvement loops.
    voiceTelemetry.log(this.session.id, String(this.session.userId ?? ''), 'gl_friction_snapshot', {
      frictionLevel,
      avgPauseMs: avgPauseMs !== null ? Math.round(avgPauseMs) : null,
      avgWords: avgWords !== null ? Math.round(avgWords * 10) / 10 : null,
      avgMidPauses: avgMidPauses !== null ? Math.round(avgMidPauses * 10) / 10 : null,
      windowSize: GeminiLiveSession.FRICTION_WINDOW,
    });

    return signal;
  }

  /**
   * Per-turn latency statistics (time from last inputTranscription → first Daniela audio).
   * Used by voice health monitor and burn report.
   */
  getTurnLatencyStats(): { avgMs: number; p50Ms: number; p95Ms: number; count: number; samples: number[] } {
    const samples = [...this.turnLatencies];
    if (samples.length === 0) {
      return { avgMs: 0, p50Ms: 0, p95Ms: 0, count: 0, samples: [] };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    return { avgMs: avg, p50Ms: p50, p95Ms: p95, count: samples.length, samples };
  }

  /**
   * Flush accumulated user and assistant transcripts to the database as complete utterances.
   * Called 800 ms after the last turnComplete (debounced) and also on session stop().
   * Produces one DB row per user utterance and one per assistant response, rather than
   * one row per transcription chunk / sub-turn.
   */
  private async flushTranscripts(): Promise<void> {
    // H3 fix: prevent concurrent flushes (e.g. 800ms debounce fires before generationComplete
    // arrives, then generationComplete also calls flush — both paths otherwise double-increment
    // completedExchanges and send response_complete twice).
    if (this.isFlushInProgress) {
      console.log('[GeminiLive] flushTranscripts: concurrent call suppressed');
      return;
    }
    this.isFlushInProgress = true;
    try {
      await this._doFlushTranscripts();
    } finally {
      this.isFlushInProgress = false;
    }
  }

  private async _doFlushTranscripts(): Promise<void> {
    // ── GHOST TURN GUARD ─────────────────────────────────────────────────────
    // A generation cycle that produced 0 audio sentences with NO student input since
    // the last response is a spurious second GL generation — typically triggered by a
    // mid-session sendClientContent injection (pedagogical/tension directive, heartbeat)
    // arriving after the real turn completed. The double-generation audio guard already
    // suppressed its audio; without this guard the flush still fired, emitting a
    // 0-sentence response_complete and bumping the turnId (the "ghost Daniela response").
    // Skip the flush entirely: no response_complete, no turnId bump, no exchange count.
    // Real 0-audio turns (student spoke but GL answered text-only / audio failed) pass
    // through because hasStudentInputSinceLastResponse or pendingInputTranscript is set.
    if (
      this.currentSentenceIndex === 0 &&
      !this.hasStudentInputSinceLastResponse &&
      !this.pendingInputTranscript.trim() &&
      !this.greetingPhaseActive
    ) {
      const inj = this.lastClientContentInjection;
      const injNote = inj ? `"${inj.label}" ${Date.now() - inj.at}ms ago` : 'none recorded';
      console.warn(`[GeminiLive] GHOST TURN suppressed — 0 sentences, no student input (turnId: ${this.currentTurnId}); likely trigger injection: ${injNote}`);
      voiceTelemetry.log(this.session.dbSessionId ?? this.session.id, String(this.session.userId ?? ''), 'gl_ghost_turn_suppressed', {
        turnId: this.currentTurnId,
        injectionLabel: inj?.label ?? null,
        injectionAgeMs: inj ? Date.now() - inj.at : null,
      });
      // Discard the ghost's transcript so it can't bleed into the next real turn,
      // and reset per-generation state without advancing the turn.
      this.pendingOutputTranscript = '';
      this.usingOutputTranscription = false;
      this.generationStartedThisTurn = false;
      return;
    }

    // Capture state before async operations
    const totalSentences = this.currentSentenceIndex;  // how many PCM sentences were sent
    const flushTurnId = this.currentTurnId;            // turnId client associates with this response
    voiceTelemetry.log(this.session.dbSessionId ?? this.session.id, String(this.session.userId ?? ''), 'gl_transcripts_flushed', {
      totalSentences, turnId: flushTurnId,
    });

    // Save user message first (ordering matters: user → assistant)
    if (!this.pendingInputSaved && this.pendingInputTranscript.trim()) {
      this.pendingInputSaved = true;
      const userText = this.pendingInputTranscript.trim();
      this.pendingInputTranscript = '';
      this.lastUserText = userText; // capture for enrichment context
      // Co-pilot: push to transcript tail ring buffer (last 10)
      if (!this.session.transcriptTail) this.session.transcriptTail = [];
      this.session.transcriptTail.push({ role: 'student', text: userText, timestamp: Date.now() });
      if (this.session.transcriptTail.length > 10) this.session.transcriptTail.shift();
      // Context Bridge: push to rolling buffer for graceful 1008 reconnect
      this.transcriptBuffer.push({ role: 'student', text: userText.slice(0, 300) });
      if (this.transcriptBuffer.length > this.MAX_TRANSCRIPT_BUFFER) this.transcriptBuffer.shift();
      try {
        await this.persistMessage('user', userText);
      } catch (err: any) {
        console.warn('[GeminiLive] Failed to flush user transcript:', err.message);
      }

      // Assessment turn counter — track real conversation exchanges for placement mode
      // minimum-turn guard. This counts actual user-AI pairs, not tool call attempts.
      //
      // Ghost Turn filter (Round 5 audit): pure character-count is too brittle — "No lo sé"
      // is 8 chars but IS real evidence; "Uhhhhhhhhh" is 10 chars but isn't.
      // Hybrid heuristic: count it if wordCount > 3, OR if wordCount <= 3 but not in the
      // known-filler set. This correctly admits short but meaningful answers ("Why?", "I agree",
      // "No lo sé") and discards passive acknowledgements ("okay", "uh-huh", "si").
      // Multi-language filler list (Round 6 audit): students in a placement test often
      // revert to native-language or target-language single-word acknowledgements.
      // Extended to cover all 10 HolaHola languages so "Oui", "Ja", "Sì", "Hai" etc.
      // are correctly ghosted. Only exact normalized matches (trim+lowercase+strip punct).
      const GHOST_TURN_FILLERS = new Set([
        // English
        'ok', 'okay', 'yes', 'no', 'sure', 'right', 'yeah', 'yep', 'nope',
        'mhm', 'mm-hmm', 'uh-huh', 'hmm', 'ah', 'oh', 'alright',
        // Spanish
        'si', 'sí', 'no', 'ya', 'bueno', 'claro', 'dale', 'vale',
        // French
        'oui', 'non', 'ouais', 'bah', 'bon', 'bien', 'd\'accord', 'daccord',
        // German
        'ja', 'nein', 'ok', 'gut', 'genau', 'klar', 'stimmt', 'ach',
        // Italian
        'sì', 'si', 'no', 'certo', 'esatto', 'bene', 'ok', 'dai',
        // Portuguese
        'sim', 'não', 'nao', 'ok', 'tá', 'ta', 'certo', 'bom',
        // Japanese (romaji)
        'hai', 'iie', 'ee', 'un', 'sou', 'ne', 'ma',
        // Korean (romaji)
        'ne', 'ani', 'eung', 'geurae', 'ok',
        // Mandarin (pinyin)
        'dui', 'shì', 'shi', 'hao', 'en', '嗯', '对', '是', '好',
        // Hebrew (transliterated)
        'ken', 'lo', 'beseder', 'nu',
      ]);
      const normalizedUtterance = userText.trim().toLowerCase().replace(/[.!?,;:]/g, '').trim();
      const wordCount = normalizedUtterance.split(/\s+/).filter(w => w.length > 0).length;
      const isGhostTurn = wordCount <= 3 && GHOST_TURN_FILLERS.has(normalizedUtterance);
      if ((this.session as any).placementMode?.active && !isGhostTurn) {
        const newCount = ((this.session as any).assessmentTurnCount || 0) + 1;
        (this.session as any).assessmentTurnCount = newCount;
        // Persist to DB (fire-and-forget) so reconnect can restore the count
        if (this.session.dbSessionId) {
          const db = getSharedDb();
          db.update(voiceSessions)
            .set({ assessmentTurnCount: newCount })
            .where(eq(voiceSessions.id, this.session.dbSessionId))
            .catch((err: any) => console.warn('[GeminiLive] assessmentTurnCount DB persist failed:', err?.message));
        }
      }

      // Fire the tool-detection shadow turn in the background.
      // The callback (set by unified-ws-handler) routes the transcript through the
      // orchestrator with TTS and DB persistence suppressed so tool side-effects
      // (whiteboard, scenarios, memory lookups, etc.) fire normally.
      if (this.onUserTurnComplete) {
        try {
          this.onUserTurnComplete(userText);
        } catch (cbErr: any) {
          console.warn('[GeminiLive] onUserTurnComplete callback error:', cbErr.message);
        }
      }
    }

    // Capture output transcript text before the if-block clears it (used by word echo below).
    const capturedOutputText = this.pendingOutputTranscript;

    // Save assistant message
    if (this.pendingOutputTranscript.trim()) {
      // Strip markdown bold markers, leaked tool call syntax, and Gemini thinking blocks before saving.
      const assistantText = this.pendingOutputTranscript
        .replace(/\*\*/g, '')
        .replace(/\b\w+\{[^{}]*\}/g, '')    // strip tool call syntax: name{key:val,...}
        .replace(/\w*thought\nThinking Process[\s\S]*/i, '')  // strip GL thinking blocks (e.g. "wasthought\nThinking Process:...")
        .replace(/([.!?])thought\n[\s\S]*/i, '$1')           // strip after sentence-end punct
        .replace(/\w*thought\n[\s\S]*/i, '')  // catch-all: strip ANY thought block including "thinkingthought\n..." (no word boundary needed)
        .replace(/\s{2,}/g, ' ')             // collapse double-spaces
        .trim();
      this.totalOutputCharacters += assistantText.length;
      this.pendingOutputTranscript = '';
      this.usingOutputTranscription = false;
      // Co-pilot: push to transcript tail ring buffer (last 10)
      if (!this.session.transcriptTail) this.session.transcriptTail = [];
      this.session.transcriptTail.push({ role: 'daniela', text: assistantText, timestamp: Date.now() });
      if (this.session.transcriptTail.length > 10) this.session.transcriptTail.shift();
      // Context Bridge: push to rolling buffer for graceful 1008 reconnect
      this.transcriptBuffer.push({ role: 'daniela', text: assistantText.slice(0, 300) });
      if (this.transcriptBuffer.length > this.MAX_TRANSCRIPT_BUFFER) this.transcriptBuffer.shift();
      try {
        const messageId = await this.persistMessage('assistant', assistantText, this._currentTurnThoughtContent);
        this._currentTurnThoughtContent = null; // clear after use
        // Fire background enrichment (student_insights, recurring_struggles, vocab)
        // non-blocking — same pipeline as the text orchestrator uses.
        const conversationId = this.session.conversationId;
        if (messageId && conversationId) {
          const userTextForEnrichment = this.lastUserText;
          const assistantTextForEnrichment = assistantText;
          setImmediate(() => {
            this.enrichment.processBackgroundEnrichment(
              this.session,
              conversationId,
              messageId,
              userTextForEnrichment,
              assistantTextForEnrichment,
              0,
            ).catch(err => console.warn('[GeminiLive] Enrichment failed:', err?.message));
          });
        }
      } catch (err: any) {
        console.warn('[GeminiLive] Failed to flush assistant transcript:', err.message);
        return;
      }

      // EPISODE CAPTURE: write this GL exchange to the rolling episode (live mode).
      // Greeting turns are skipped — the "Hello Daniela..." trigger is internal, not
      // real student speech. Every subsequent real student→Daniela exchange is captured.
      if (!this.isGreetingTurn && !this.session.isIncognito && this.lastUserText?.trim() && assistantText.trim()) {
        const studentName = this.lastGreetingParams?.userName;
        const studentLabel = studentName ? `${studentName} [GL]` : 'Student [GL]';
        const danielaLabel = (this.session.tutorName || 'Daniela') + ' [GL]';
        const exchange = `**${studentLabel}:** ${this.lastUserText.trim()}\n**${danielaLabel}:** ${assistantText.trim()}`;

        // GAME DETECTOR: accumulate every real exchange for post-session game detection.
        this.sessionExchangeLog.push({
          user: this.lastUserText.trim(),
          daniela: assistantText.trim(),
        });

        setImmediate(async () => {
          try {
            const { safeWriteTrigger, getRollingEpisodeName } = await import('./chat-episode-hook');
            const episodeName = await getRollingEpisodeName();
            if (!episodeName) return;
            await safeWriteTrigger(exchange, episodeName);
            console.log(`[GeminiLive] Episode capture: GL exchange appended to ${episodeName} (${exchange.length} chars)`);
          } catch (err: any) {
            console.warn('[GeminiLive] Episode capture failed (non-fatal):', err?.message);
          }
        });
      }
    }

    // Word echo: if Daniela mentioned a previously-taught vocab word this turn,
    // send a brief image flash (word_echo) to the whiteboard. Skip words that
    // were just taught this turn (they already have a full vocab card).
    if (this.session.taughtVocab && this.session.taughtVocab.size > 0) {
      try {
        const echoMatch = findTaughtWordMention(
          capturedOutputText,
          this.session.taughtVocab,
          this.session.vocabAddedThisTurn,
        );
        if (echoMatch) {
          this.sendWsMessage(this.session.ws, {
            type: 'whiteboard_update',
            timestamp: Date.now(),
            items: [{
              id: `word-echo-${Date.now()}`,
              type: 'word_echo',
              content: echoMatch.word,
              timestamp: Date.now(),
              data: { word: echoMatch.word, imageUrl: echoMatch.imageUrl, durationMs: 2500 },
            }],
          });
          console.log(`[GeminiLive] Word echo fired for "${echoMatch.word}"`);
        }
      } catch (echoErr: any) {
        console.warn('[GeminiLive] Word echo error:', echoErr.message);
      }
      // Clear the per-turn set so next turn starts fresh
      this.session.vocabAddedThisTurn = new Set();
    }

    // Exchange accounting already happened at generationComplete (or its
    // watchdog fallback), before transcript persistence that can fail.
    // Reset per-response state for the next user utterance.
    this.currentSentenceIndex = 0;
    this.currentChunkIndex = 0;
    this.lastSentenceStartSentIndex = -1;
    this.pendingInputSaved = false;
    this.firstAudioSentThisTurn = false;
    this.processingPendingSentThisTurn = false;
    this.generationStartedThisTurn = false;
    // DOUBLE-AUDIO FIX: Clear suppress flag at turn complete so a stale reconnect-era
    // flag never carries into the next turn if GL never generated audio post-reconnect.
    this.suppressNextProcessingPending = false;
    this.session.currentTurnId = ++this.currentTurnId;
    this.resetSubstantialReplayGuard();

    // Send response_complete AFTER DB writes so the client's cache invalidation
    // (onResponseComplete → queryClient.invalidateQueries) refetches the messages
    // that are now in the DB. Also tells the progressive PCM player the total
    // sentence count (totalSentences) so it knows when the stream is fully done.
    this.sendWsMessage(this.session.ws, {
      type: 'response_complete',
      timestamp: Date.now(),
      conversationId: this.session.conversationId,
      turnId: flushTurnId,
      totalSentences,
      fullText: '',
    });
    // Arm the response-flushed guard: any GL audio arriving after this point (with no new
    // student input) is a spurious re-generation and should be suppressed.
    this.responseFlushedToClient = true;

    console.log(`[GeminiLive] Transcripts flushed & response_complete sent — sentences: ${totalSentences}, old turnId: ${flushTurnId}, new turnId: ${this.currentTurnId}`);
  }

  /**
   * Insert one message row and bump the conversation's message_count + duration.
   * Uses a raw SQL UPDATE so message_count is always accurate in the list view.
   */
  private async persistMessage(role: 'user' | 'assistant', content: string, thoughtContent: string | null = null): Promise<string | null> {
    // Incognito mode — skip all DB writes so nothing is recorded
    if (this.session.isIncognito) {
      console.log(`[GeminiLive] Incognito: skipping persistMessage (${role})`);
      return null;
    }

    try {
      const { getUserDb } = await import('../db');
      const { messages } = await import('../../shared/schema');
      const { sql: rawSql } = await import('drizzle-orm');
      const db = getUserDb();
      const conversationId = this.session.conversationId;

      if (!conversationId) return null;

      // Ensure the conversation exists before inserting a message
      const convCheck = await db.execute(
        rawSql`SELECT id FROM conversations WHERE id = ${conversationId} LIMIT 1`
      );
      if (convCheck.rows.length === 0) {
        console.warn(`[GeminiLive] Conversation ${conversationId} not found — skipping message persist`);
        return null;
      }

      const insertValues: Record<string, unknown> = { conversationId, role, content };
      if (role === 'assistant' && thoughtContent) {
        insertValues.thoughtContent = thoughtContent;
      }
      const inserted = await db.insert(messages).values(insertValues as any).returning({ id: messages.id });
      const messageId = inserted[0]?.id ?? null;

      // Update conversation stats so the list view shows correct counts
      const updatedConv = await db.execute(rawSql`
        UPDATE conversations
        SET
          message_count = message_count + 1,
          duration = GREATEST(
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 60,
            1
          )::integer
        WHERE id = ${conversationId}
        RETURNING message_count, title
      `);

      // Auto-generate title for GL sessions after 4 messages (lower threshold
      // than text sessions because voice sessions are naturally shorter).
      const updatedRow = updatedConv.rows[0] as { message_count: number; title: string | null } | undefined;
      if (updatedRow && !updatedRow.title && updatedRow.message_count >= 4) {
        setImmediate(async () => {
          try {
            // Re-check title hasn't been generated by a concurrent request
            const latest = await db.execute(rawSql`SELECT title FROM conversations WHERE id = ${conversationId} LIMIT 1`);
            const latestTitle = (latest.rows[0] as any)?.title;
            if (latestTitle) return;

            const recentMessages = await db.execute(rawSql`
              SELECT role, content FROM messages
              WHERE conversation_id = ${conversationId}
              ORDER BY created_at ASC LIMIT 8
            `);
            const messageList = (recentMessages.rows as Array<{ role: string; content: string }>)
              .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
            if (messageList.length < 3) return;

            const generatedTitle = await generateConversationTitle(messageList, this.session.targetLanguage ?? 'english');
            if (generatedTitle) {
              await db.execute(rawSql`UPDATE conversations SET title = ${generatedTitle} WHERE id = ${conversationId} AND title IS NULL`);
              console.log(`[GeminiLive] Auto-generated title for conversation ${conversationId}: "${generatedTitle}"`);
            }
          } catch (titleErr: any) {
            console.warn('[GeminiLive] Title generation failed (non-fatal):', titleErr?.message);
          }
        });
      }

      return messageId;
    } catch (err: any) {
      throw new Error(err.message);
    }
  }

  /**
   * Build a compact Context Bridge from the rolling transcript buffer.
   * Injected as a prefix to the system prompt on 1008 reconnect so Daniela
   * resumes mid-session rather than waking amnesiac.
   *
   * Keeps it short (~400 chars max) — the full system prompt follows.
   * Returns empty string if the buffer has fewer than 2 turns (not worth injecting).
   */
  private buildContextBridge(): string {
    const parts: string[] = [];

    if (this.transcriptBuffer.length >= 2) {
      const turns = this.transcriptBuffer.slice(-6).map(t => {
        const label = t.role === 'student' ? 'Student' : 'You';
        const text = t.text.length > 250 ? t.text.slice(0, 250) + '…' : t.text;
        return `${label}: ${text}`;
      }).join('\n');
      parts.push(`[Your conversation just before this connection resumed — continue naturally from here, do not acknowledge the reconnection]\n${turns}`);
    }

    // Re-inject scratchpad notes so the new GL session is aware of them immediately.
    // The per-turn heartbeat only fires every 8 tool calls — without this injection a
    // freshly reconnected GL instance would be blind to the notes for the first 1–7
    // tool calls after the GL session recreate.  Including them here means the very
    // first tool-response batch (or any sendClientContent turn) already carries the
    // notes as part of the system instruction context bridge.
    const scratchpadNotes = (this.session as any).sessionNotes as string[] | undefined;
    if (scratchpadNotes?.length) {
      const noteLines = scratchpadNotes.map((n, i) => `${i + 1}. ${n}`).join('\n');
      parts.push(`[Session Working Memory — notes you wrote earlier this session, still apply]\n${noteLines}`);
    }

    return parts.join('\n\n');
  }
}

/**
 * Convert PCM16 (int16 little-endian) buffer to PCM f32le (float32 little-endian).
 * Gemini Live outputs PCM16; the client expects pcm_f32le.
 * Each int16 sample → float32 / 32768.0
 */
export function pcm16ToF32le(pcm16Buffer: Buffer): Buffer {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const f32Buffer = Buffer.allocUnsafe(sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = pcm16Buffer.readInt16LE(i * 2);
    f32Buffer.writeFloatLE(int16 / 32768.0, i * 4);
  }
  return f32Buffer;
}

/**
 * Factory — create a GeminiLiveSession for the given StreamingSession.
 */
export function createGeminiLiveSession(
  session: StreamingSession,
  sendWsMessage: (ws: any, message: any, session?: any) => void,
): GeminiLiveSession {
  return new GeminiLiveSession(session, sendWsMessage);
}

/**
 * Whether Gemini Live voice mode is enabled for this process.
 * Controlled by the GEMINI_LIVE_VOICE=true environment variable.
 */
export const GEMINI_LIVE_VOICE_ENABLED = process.env.GEMINI_LIVE_VOICE === 'true';

export function createGroundingTurnBinding(
  studentTurnEpoch: number,
  studentUtterance: string,
  candidateAssertion: string,
): GroundingTurnBinding {
  return {
    studentTurnEpoch,
    studentUtterance: studentUtterance.trim(),
    candidateAssertion: candidateAssertion.trim(),
  };
}

export function isGroundingBindingCurrent(
  binding: GroundingTurnBinding,
  activeStudentTurnEpoch: number,
): boolean {
  return binding.studentTurnEpoch === activeStudentTurnEpoch;
}

/**
 * Tool results are the only safe live injection channel. This makes the
 * current subject and the exact claim being checked explicit, so a failed
 * lookup produces bounded uncertainty instead of inviting a topic change.
 */
export function formatCurrentTurnGroundingContext(
  binding: GroundingTurnBinding,
  groundingResult: string,
): string {
  const archiveResult = groundingResult.trim()
    || 'No verified Archive source surfaced for this candidate.';
  return `[CURRENT STUDENT TURN — ANSWER THIS FIRST:
Utterance: "${binding.studentUtterance}"
Candidate memory assertion under evaluation: "${binding.candidateAssertion}"
Archive result for this candidate: ${archiveResult}
If the Archive is silent, be honest about that uncertainty while responding to the current utterance. Do not change the subject to an earlier assertion.]`;
}

export function createPriorTurnGroundingCorrection(
  groundingResult: string,
  binding: GroundingTurnBinding,
  activeStudentTurnEpoch: number,
): PriorTurnGroundingCorrection | null {
  if (activeStudentTurnEpoch !== binding.studentTurnEpoch + 1) return null;
  return { groundingResult, binding, eligibleStudentTurnEpoch: activeStudentTurnEpoch };
}

export function registerInputTranscriptionChunk(
  startNewStudentTurnOnNextInputTranscription: boolean,
  activeStudentTurnEpoch: number,
  unfinalizedEpochs: number[],
): {
  activeStudentTurnEpoch: number;
  startedNewStudentUtterance: boolean;
  startNewStudentTurnOnNextInputTranscription: boolean;
} {
  if (!startNewStudentTurnOnNextInputTranscription) {
    return {
      activeStudentTurnEpoch,
      startedNewStudentUtterance: false,
      startNewStudentTurnOnNextInputTranscription: false,
    };
  }
  const nextEpoch = activeStudentTurnEpoch + 1;
  unfinalizedEpochs.push(nextEpoch);
  return {
    activeStudentTurnEpoch: nextEpoch,
    startedNewStudentUtterance: true,
    startNewStudentTurnOnNextInputTranscription: false,
  };
}

export function formatReopenedPriorTurnGroundingContext(
  currentStudentUtterance: string,
  priorBinding: GroundingTurnBinding,
  groundingResult: string,
): string {
  const archiveResult = groundingResult.trim()
    || 'No verified Archive source surfaced for the earlier candidate.';
  return `[CURRENT STUDENT TURN — PRIMARY SUBJECT:
Utterance: "${currentStudentUtterance.trim()}"
This utterance explicitly reopens the earlier candidate: "${priorBinding.candidateAssertion}"
Archive grounding already available for this current reopened subject: ${archiveResult}
This is the grounding for the current request; do not call another tool just to verify it. Respond naturally to the current utterance. Do not change the subject, and do not treat the earlier turn as the primary request.]`;
}

export function createFrictionSignalGroundingBinding(
  studentTurnEpoch: number,
  studentUtterance: string,
  modelTranscript: string,
  unverifiedAssertionPhrases: string[],
): { binding: GroundingTurnBinding; canCarryToPriorTurn: boolean } {
  const matchedAssertionPhrase = unverifiedAssertionPhrases.find(phrase =>
    modelTranscript.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()),
  );
  const candidateAssertion = matchedAssertionPhrase
    ? extractGroundingAssertionCandidate(modelTranscript, matchedAssertionPhrase)
    : '';
  return {
    binding: createGroundingTurnBinding(studentTurnEpoch, studentUtterance, candidateAssertion),
    canCarryToPriorTurn: Boolean(matchedAssertionPhrase && candidateAssertion),
  };
}

export function consumeNextUnfinalizedStudentTurnEpoch(
  unfinalizedEpochs: number[],
): number | null {
  return unfinalizedEpochs.shift() ?? null;
}

export function releasePriorTurnGroundingCorrection(
  prior: PriorTurnGroundingCorrection,
  activeStudentTurnEpoch: number,
  currentStudentUtterance: string,
  inputTranscriptionFinished: boolean,
  studentTurnBoundaryTrusted = true,
): string | null {
  if (prior.eligibleStudentTurnEpoch !== activeStudentTurnEpoch) return null;
  if (!studentTurnBoundaryTrusted) return null;
  if (!inputTranscriptionFinished) return null;
  if (!doesStudentExplicitlyReopenGroundingTopic(
    currentStudentUtterance,
    prior.binding.candidateAssertion,
  )) return null;
  return formatReopenedPriorTurnGroundingContext(
    currentStudentUtterance,
    prior.binding,
    prior.groundingResult,
  );
}

// ── Active GL session registry ──────────────────────────────────────────────
// Maps conversationId → active GeminiLiveSession so external routes (e.g. the
// Luca relay endpoint) can reach a live session without going through the WS
// closure. Registered by unified-ws-handler after createGeminiLiveSession;
// unregistered on every path that sets geminiLiveSession = null.
const _activeGlSessions = new Map<string, GeminiLiveSession>();

export function registerGlSession(conversationId: string, session: GeminiLiveSession): void {
  _activeGlSessions.set(conversationId, session);
  console.log(`[GLRegistry] Registered GL session for conversation ${conversationId.substring(0, 8)}`);
}

/**
 * Remove a GL session from the registry, but only when the stored entry is the
 * same instance as the one being torn down. This prevents a stale cleanup call
 * from deleting a newer replacement session for the same conversationId (which
 * can happen when voice-override reconnects register a new session before the
 * old connection's teardown path fires).
 */
export function unregisterGlSession(conversationId: string, session: GeminiLiveSession): void {
  if (_activeGlSessions.get(conversationId) === session) {
    _activeGlSessions.delete(conversationId);
    console.log(`[GLRegistry] Unregistered GL session for conversation ${conversationId.substring(0, 8)}`);
  } else {
    console.log(`[GLRegistry] Skipped unregister for ${conversationId.substring(0, 8)} — newer session already registered`);
  }
}

/** Return the active GL session for a specific conversationId, or null if not found. */
export function getActiveGlSessionByConversation(conversationId: string): GeminiLiveSession | null {
  return _activeGlSessions.get(conversationId) ?? null;
}

/** Return any active GL session (most recently registered), or null if none. */
export function getActiveGlSessionCount(): number {
  return _activeGlSessions.size;
}

export function getAnyActiveGlSession(): GeminiLiveSession | null {
  // Map iteration order is insertion order; return the last registered session.
  let last: GeminiLiveSession | null = null;
  for (const s of _activeGlSessions.values()) { last = s; }
  return last;
}
