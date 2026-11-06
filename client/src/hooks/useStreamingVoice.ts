/**
 * Streaming Voice Hook
 * 
 * Unified hook that integrates:
 * - StreamingVoiceClient (WebSocket connection)
 * - StreamingAudioPlayer (progressive audio playback)
 * - StreamingSubtitles (karaoke-style word highlighting)
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { getStreamingVoiceClient, StreamingVoiceClient } from '../lib/streamingVoiceClient';
import { getStreamingAudioPlayer, StreamingAudioPlayer, StreamingAudioChunk, StreamingPlaybackState, isVerboseLoggingEnabled, getPlaybackLedger } from '../lib/audioUtils';
import { useStreamingSubtitles, UseStreamingSubtitlesReturn } from './useStreamingSubtitles';
import { logAudioChunkReceived, updateDebugTimingState, trackWsMessage } from '../lib/debugTimingState';
import { setGlobalPlaybackState, getGlobalPlaybackState } from '../lib/playbackStateStore';
import { useGlobalPropTap } from '../lib/propTapStore';
import { diagSetSession, diagSetHookRefs, diagEvent, diagMarkConnect, diagMarkFirstAudio, diagMarkResponseComplete, diagMarkDisconnect, diagMarkTurnStart, diagMarkSpeechEnd, diagMarkError, diagMarkTtsError, diagMarkFailsafe, reportDiagnostic, startLockoutWatchdog, startGreetingSilenceWatchdog } from '../lib/lockoutDiagnostics';
import { acquireWakeLock, releaseWakeLock } from '../lib/wakeLock';
import { validateSpotlightMessage } from '../lib/spotlight-guard';
import { validatePronunciationScorePayload } from '../lib/pronunciation-score-guard';
import { validateGrammarFlagPayload } from '../lib/grammar-flag-guard';
import { validateQuizPayload } from '../lib/quiz-guard';
import { validateCulturalContextPayload } from '../lib/cultural-context-guard';
import { preWarmMicroAcks, selectMicroAck, playMicroAck } from '../services/microAckService';
import { 
  STREAMING_FEATURE_FLAGS,
  type StreamingClientState,
  type StreamingMetrics,
  type StreamingProcessingMessage,
  type StreamingSentenceStartMessage,
  type StreamingSentenceReadyMessage,
  type StreamingAudioChunkMessage,
  type StreamingWordTimingMessage,
  type StreamingWordTimingDeltaMessage,
  type StreamingWordTimingFinalMessage,
  type StreamingResponseCompleteMessage,
  type StreamingWhiteboardMessage,
} from '../../../shared/streaming-voice-types';

/**
 * Streaming voice state
 */
export interface StreamingVoiceState {
  connectionState: StreamingClientState;
  voiceSessionId: string | null;
  playbackState: StreamingPlaybackState;
  isConnecting: boolean;
  isProcessing: boolean;
  isPlaying: boolean;
  isSwitchingTutor: boolean;  // True during tutor handoff - mic should stay locked
  sofiaIncident: { incidentId: string; category: string; priority: string; message: string; timestamp: number } | null;  // Active Sofia support incident
  ttsUnavailable: boolean;    // True when TTS fails; clears after 8s
  sttDegraded: boolean;       // True when Deepgram STT has an error; clears after 6s
  sttDegradedMessage: string; // User-facing message for STT degraded state
  sttSuggestPtt: boolean;     // True when repeated open-mic failures suggest switching to PTT
  currentText: string;
  currentWordIndex: number;
  visibleWordCount: number;
  error: string | null;
  metrics: StreamingMetrics | null;
  activeCharacter: { id: string; displayName: string; role: string; gender: 'male' | 'female' } | null;
  serverRestarting: boolean;  // True when server sent SIGTERM — deploy rotation in progress
  glDisconnectedForRetry: boolean;  // True when GL retries exhausted — student can tap to retry
}

/**
 * Session configuration for streaming voice
 */
export interface StreamingSessionConfig {
  conversationId: string;
  targetLanguage: string;
  nativeLanguage: string;
  difficultyLevel: string;
  subtitleMode: 'off' | 'target';
  tutorPersonality?: string;
  tutorExpressiveness?: number;
  tutorGender?: 'male' | 'female';
  voiceSpeed?: 'normal' | 'slow';
  rawHonestyMode?: boolean;  // Minimal prompting for authentic conversation with Daniela
  founderMode?: boolean;  // Explicit founder mode flag - only true when user selects "Founder Mode" context
  inputMode?: string;  // Voice input mode (ptt, open-mic, etc.)
  onResponseComplete?: (conversationId: string) => void;
  /** Called when processing_pending arrives — sets component-level thinking state immediately */
  onProcessingPending?: () => void;
  /** Called when server detects no speech during PTT - resets processing state */
  onNoSpeechDetected?: () => void;
  /** Called when server sends whiteboard updates (e.g., enriched WORD_MAP items) */
  onWhiteboardUpdate?: (items: any[], shouldClear: boolean) => void;
  /** Called when Daniela adds an item to the session lesson notes */
  onLessonNoteAdded?: (note: { id: string; type: string; content: string; detail?: string; timestamp: number }) => void;
  /** Called when Daniela shows a pronunciation score card */
  onPronunciationScoreShown?: (data: { id: string; phrase: string; wordScores: Array<{ word: string; score: number; tip?: string }>; overallScore: number; encouragement?: string; timestamp?: number }) => void;
  /** Called when Daniela flags a grammar correction */
  onGrammarFlagShown?: (data: { id: string; original: string; corrected: string; explanation: string; ruleLabel?: string; timestamp: number }) => void;
  /** Called when Daniela presents a quiz */
  onQuizPresented?: (data: { id: string; question: string; options: string[]; correctIndex: number; explanation?: string; timestamp: number }) => void;
  /** Called when Daniela shows a cultural context card */
  onCulturalContextShown?: (data: { id: string; title: string; text: string; category?: string; sourceUrl?: string; timestamp: number }) => void;
  /** Called when Daniela spotlights a UI element */
  onSpotlightShown?: (data: { id: string; zone: string; message: string; durationMs: number; timestamp: number }) => void;
  /** Called when Daniela sets a shared session mission (Gap D) */
  onMissionSet?: (mission: string) => void;
  /** Called when VAD detects speech start (open mic mode) */
  onVadSpeechStarted?: () => void;
  /** Called when VAD detects utterance end (open mic mode) */
  onVadUtteranceEnd?: (transcript: string, empty?: boolean) => void;
  /** Called when interim transcript available (open mic mode) */
  onInterimTranscript?: (transcript: string) => void;
  /** Called for each Gemini Live real-time speech chunk (GL mode only). Distinct from onInterimTranscript
   *  which is shared with Deepgram. Accumulate chunks to build the live user caption bar. */
  onGlUserTranscript?: (chunk: string) => void;
  /** Called when open mic session closes (e.g., Deepgram timeout) */
  onOpenMicSessionClosed?: () => void;
  /** Called when OpenMic detects consecutive empty transcripts (silence loop) */
  onOpenMicSilenceLoop?: (consecutiveEmptyCount: number, msSinceLastSuccessfulTranscript: number) => void;
  /** Called when connection is successfully restored after a drop */
  onReconnected?: () => void;
  /** Called when GL 1008 reconnect begins — server building Context Bridge; show "gathering thoughts" */
  onReconnecting?: () => void;
  /** Called when the GL WebSocket is re-established after a drop (Socket.io never dropped) — clear error UI, resume listening */
  onGlReconnected?: () => void;
  /** 
   * Called when voice-initiated tutor handoff occurs (student asked to switch tutors)
   * Supports both intra-language (gender only) and cross-language (gender + language) handoffs
   */
  onTutorHandoff?: (handoff: TutorHandoffInfo) => void;
  /** Called when pronunciation coaching feedback is received from Deepgram word-level analysis */
  onPronunciationCoaching?: (coaching: PronunciationCoachingData) => void;
  /** Called when server commands a subtitle mode change (tutor [SUBTITLE on/off/target] command) */
  onSubtitleModeChange?: (mode: 'off' | 'target') => void;
  /** Called when server commands a custom overlay show/hide (tutor [SHOW: text] / [HIDE] commands) */
  onCustomOverlay?: (action: 'show' | 'hide', text?: string) => void;
  /** Called when server requests text input from student (tutor [TEXT_INPUT: prompt] command) */
  onTextInputRequest?: (prompt: string) => void;
  /** Called when an immersive scenario is loaded from the library */
  onScenarioLoaded?: (scenario: any) => void;
  /** Called when the active scenario ends */
  onScenarioEnded?: (data: { scenarioId?: string; scenarioSlug?: string; performanceNotes?: string }) => void;
  /** Called when a scenario prop is updated (e.g., bill filled in with items/total) */
  onPropUpdate?: (data: { propTitle: string; updates: Array<{ label: string; value: string }>; updatedFields: Array<{ label: string; value: string }> }) => void;
  /** Called when Daniela enters or exits immersive fullscreen mode */
  onImmersiveModeChange?: (active: boolean) => void;
  /** Called when the AI advances to the next scene zone within a scenario */
  onSceneZoneAdvanced?: (data: { zoneIndex: number; zoneName: string | null; imageUrl: string | null; isChain?: boolean; nextScenarioSlug?: string | null; isComplete?: boolean }) => void;
  /** Called when server confirms the incognito toggle (authoritative state source) */
  onIncognitoChanged?: (enabled: boolean) => void;
  /** Called when server pushes a mid-session credit balance warning (every 2 min periodic check) */
  onCreditWarning?: (data: { level: 'low' | 'critical' | 'exhausted'; remainingSeconds: number; percentRemaining: number }) => void;
}

/**
 * Pronunciation coaching data from word-level confidence analysis
 */
export interface PronunciationCoachingData {
  overallScore: number;
  wordFeedback: Array<{
    word: string;
    confidence: number;
    status: 'excellent' | 'good' | 'needs_work' | 'difficult';
    suggestion?: string;
  }>;
  coachingTips: string[];
  encouragement: string;
  lowConfidenceWords: string[];
  phonemeHints: Array<{
    phoneme: string;
    word: string;
    tip: string;
  }>;
}

/**
 * Information about a tutor handoff (intra-language or cross-language)
 */
export interface TutorHandoffInfo {
  targetGender: 'male' | 'female';
  targetLanguage?: string;    // For cross-language handoffs (e.g., "japanese")
  tutorName?: string;         // New tutor's name (e.g., "Sayuri")
  isLanguageSwitch: boolean;  // True if this is a cross-language handoff
  requiresGreeting?: boolean; // True if client should request greeting after reconnecting
  isAssistant?: boolean;      // True if switching to assistant tutor (navigate to practice page)
  mode?: string;              // Optional mode to apply after handoff
}

/**
 * Return type for the hook
 */
export interface UseStreamingVoiceReturn {
  state: StreamingVoiceState;
  subtitles: UseStreamingSubtitlesReturn;
  connect: (config: StreamingSessionConfig) => Promise<void>;
  disconnect: () => void;
  sendAudio: (audioData: ArrayBuffer) => Promise<void>;
  requestGreeting: (userName?: string, isResumed?: boolean, scenarioSlug?: string) => void;
  updateVoice: (tutorGender: 'male' | 'female') => void;
  stop: () => void;
  isSupported: () => boolean;
  isReady: () => boolean;
  getCombinedAudioBlob: () => Blob | null;
  clearStoredAudio: () => void;
  sendStreamingChunk: (audioData: ArrayBuffer, sequenceId: number) => boolean;
  stopStreaming: () => void;
  setInputMode: (mode: 'push-to-talk' | 'open-mic') => void;
  sendInterrupt: () => void;
  sendUserActivity: () => void;
  sendPttRelease: () => void;
  sendDrillResult: (drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string) => void;
  sendTextInput: (itemId: string, response: string) => void;
  sendVoiceOverride: (override: {
    speakingRate?: number;
    personality?: string;
    expressiveness?: number;
    emotion?: string;
    geminiLanguageCode?: string;
  } | null) => void;
  sendVideoFrame: (base64Jpeg: string, source: string) => void;
  sendToggleIncognito: (enabled: boolean) => void;
  forceResetProcessing: () => void;
  retryGlSession: () => void;
  microAckPlaying: boolean;
}

/**
 * Hook for streaming voice functionality
 */
export function useStreamingVoice(): UseStreamingVoiceReturn {
  // State
  const [connectionState, setConnectionState] = useState<StreamingClientState>('disconnected');
  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null);
  const handleSessionStart = useCallback((event: { sessionId: string; voiceSessionId: string | null }) => {
    setVoiceSessionId(event.voiceSessionId);
  }, []);
  const [playbackState, setPlaybackState] = useState<StreamingPlaybackState>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  isProcessingRef.current = isProcessing;
  const [isSwitchingTutor, setIsSwitchingTutor] = useState(false);  // Mic lockout during tutor handoff
  const [sofiaIncident, setSofiaIncident] = useState<{ incidentId: string; category: string; priority: string; message: string; timestamp: number } | null>(null);
  const isSwitchingTutorRef = useRef(false);
  isSwitchingTutorRef.current = isSwitchingTutor;
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<StreamingMetrics | null>(null);
  const [ttsUnavailable, setTtsUnavailable] = useState(false);
  const ttsUnavailableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sttDegraded, setSttDegraded] = useState(false);
  const sttDegradedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sttDegradedMessage, setSttDegradedMessage] = useState<string>('');
  const [sttSuggestPtt, setSttSuggestPtt] = useState(false);

  // Micro-ack: short ack clip played immediately after user stops speaking
  const [microAckPlaying, setMicroAckPlaying] = useState(false);
  const [serverRestarting, setServerRestarting] = useState(false);
  const [glDisconnectedForRetry, setGlDisconnectedForRetry] = useState(false);
  const microAckPlayingRef = useRef(false);
  const microAckMsgBufferRef = useRef<StreamingAudioChunkMessage[]>([]);
  const microAckFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref used by fireMicroAck to replay buffered audio chunks after ack ends
  const handleAudioChunkRef = useRef<((msg: StreamingAudioChunkMessage) => void) | null>(null);
  
  // Ref for tutor switch timeout (error recovery)
  const tutorSwitchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Fire-and-forget client-side error reporter — sends to server for pipeline event log
  const reportVoiceClientError = useCallback((eventType: string, errorMsg: string, extraMs?: number) => {
    try {
      const conversationId = sessionConfigRef.current?.conversationId;
      fetch('/api/telemetry/voice-client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType,
          sessionId: conversationId ?? 'unknown',
          error: errorMsg,
          durationMs: extraMs,
        }),
      }).catch(() => {}); // truly fire-and-forget
    } catch {
      // never throw from a diagnostic helper
    }
  }, []);

  // Ref for processing timeout (stuck thinking recovery)
  // If no activity for 30+ seconds while isProcessing=true, reset state
  // Increased from 15s to 25s Jan 2026 to handle server delays from RAM pressure
  const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PROCESSING_TIMEOUT_MS = 60000;  // 60 seconds max "thinking" time (Gemini TTS can take 40-50s for long responses)
  
  // Ref for greeting silence watchdog (cleanup on disconnect)
  const greetingSilenceWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Speculative thinking timer — fires 700ms after the last inputTranscription chunk
  // to switch the avatar to 'thinking' before the real processing_pending arrives.
  // Cancelled if processing_pending arrives first (the authoritative signal).
  const speculativeThinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set true on first audio chunk — prevents greeting_retry from resetting watchdog after audio already arrived.
  const greetingAudioArrivedRef = useRef(false);

  // Prop-to-dialogue binding — watches global prop tap store, sends socket signal
  const activePropTap = useGlobalPropTap();
  const prevPropTapTimestampRef = useRef<number>(0);

  // Refs
  const clientRef = useRef<StreamingVoiceClient | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  
  // Track orchestrator response completion and pending audio
  // isProcessing should only be cleared when BOTH:
  // 1. Server has sent response_complete (responseCompleteRef = true)
  // 2. No pending audio chunks (pendingAudioCount = 0)
  // 3. Audio has actually started playing (or no audio was sent)
  const responseCompleteRef = useRef(false);
  
  // Track connection state in a ref so closures (failsafes, timeouts) can read it
  const connectionStateRef = useRef<StreamingClientState>('disconnected');
  const pendingAudioCountRef = useRef(0);
  const setIsProcessingRef = useRef(setIsProcessing);
  setIsProcessingRef.current = setIsProcessing;

  // Track when sentence playback last started — used by the tier-2 failsafe to avoid
  // nuclear reset while a long sentence (e.g. greeting) is still actively playing.
  // onSentenceStart clears audioReceivedInTurnRef (so the healthy-turn guard can't help),
  // but audio can still be playing for 20-30s after that. This timestamp fills the gap.
  const lastSentenceStartedAtRef = useRef(0);
  
  // Turn counter: prevents stale failsafe timers from old turns from firing during
  // new turns. Each timer captures the turn number at creation time and bails if
  // the current turn has advanced. Without this, old 45s timers see
  // responseCompleteRef=true (set by a NEWER turn) and incorrectly fire, calling
  // player.stop() which cuts off audio mid-sentence and triggers Sofia popups.
  const turnCounterRef = useRef(0);
  
  // Track whether audio has been received in the current turn
  // When true, isProcessing should stay true until playback actually starts
  // This prevents the thinking→listening flash when response_complete arrives
  // before the audio player has transitioned to 'playing' state
  const audioReceivedInTurnRef = useRef(false);
  
  // Store current session config for callbacks
  const sessionConfigRef = useRef<StreamingSessionConfig | null>(null);
  
  // Track current turn ID for subtitle packet ordering (prevents phantom subtitles)
  const currentTurnIdRef = useRef(0);
  
  // Track difficulty level for ACTFL-aware subtitle timing
  const [difficultyLevel, setDifficultyLevel] = useState<string>('beginner');

  // Active secondary character (null = Daniela is speaking)
  const [activeCharacter, setActiveCharacter] = useState<{ id: string; displayName: string; role: string; gender: 'male' | 'female' } | null>(null);
  
  // Helper to check if we can clear isProcessing
  // Note: Does NOT reset responseCompleteRef - that's done when new request starts
  const checkAndClearProcessing = useCallback(() => {
    const isComplete = responseCompleteRef.current;
    const noPendingAudio = pendingAudioCountRef.current === 0;
    const audioReceived = audioReceivedInTurnRef.current;
    
    console.log(`[StreamingVoice] checkAndClearProcessing: complete=${isComplete}, pending=${pendingAudioCountRef.current}, audioReceived=${audioReceived}`);
    
    if (isComplete && noPendingAudio) {
      if (audioReceived) {
        console.log('[StreamingVoice] Response complete but audio was received - deferring isProcessing clear until playback starts');
        // SAFETY: If playback never starts (decode error, autoplay block, etc),
        // onSentenceStart never fires and mic stays locked forever. Schedule a
        // deferred clear — if onSentenceStart fires in time, it will clear
        // audioReceivedInTurnRef and the next checkAndClearProcessing call will
        // handle cleanup normally. This 10s timeout is a safety net only.
        setTimeout(() => {
          if (audioReceivedInTurnRef.current && responseCompleteRef.current && pendingAudioCountRef.current === 0) {
            const currentPlaybackState = (window as any).__lastPlaybackCallback?.state || 'unknown';
            const ctxState = playerRef.current?.getAudioContextState?.() || 'unknown';
            if (currentPlaybackState === 'playing' || currentPlaybackState === 'buffering') {
              console.log(`[StreamingVoice] audioReceived guard timeout: playback still active (${currentPlaybackState}) — skipping force-clear`);
              return;
            }
            console.log(`[StreamingVoice] audioReceived guard timeout: playback never started after 10s — force-clearing (ctxState=${ctxState})`);
            audioReceivedInTurnRef.current = false;
            setIsProcessingRef.current(false);
            setGlobalPlaybackState('idle');
            playerRef.current?.stop?.();
          }
        }, 10000);
      } else {
        console.log('[StreamingVoice] Response complete AND no pending audio (no audio turn) - clearing isProcessing');
        setIsProcessingRef.current(false);
      }
    }
  }, []);
  
  // Subtitle management with ACTFL-level-aware timing
  const subtitles = useStreamingSubtitles({ difficultyLevel });
  
  // Keep a ref to subtitles to avoid stale closure issues in audio player callbacks
  // The audio player callbacks are set once on mount but need access to latest subtitles methods
  const subtitlesRef = useRef(subtitles);
  subtitlesRef.current = subtitles;
  
  // Generate a unique callback ID for this component instance
  const callbackIdRef = useRef(`cb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  
  // Track the setPlaybackState function in a ref for stable reference
  const setPlaybackStateRef = useRef(setPlaybackState);
  setPlaybackStateRef.current = setPlaybackState;
  
  /**
   * Initialize the audio player and SUBSCRIBE to callbacks
   * CRITICAL: Use subscribe/unsubscribe pattern to survive Vite HMR
   * Each component instance gets a unique subscriber ID and properly cleans up
   */
  useEffect(() => {
    const player = getStreamingAudioPlayer();
    playerRef.current = player;
    const subscriberId = callbackIdRef.current;
    
    console.log(`[CALLBACK SETUP] Subscribing with ID: ${subscriberId}`);
    
    // Subscribe to player callbacks with unique ID
    // NOTE: isProcessing is only cleared when BOTH:
    // 1. Server has sent response_complete (responseCompleteRef = true)
    // 2. No pending audio chunks (pendingAudioCountRef = 0)
    // IMPORTANT: Use refs to get latest values (avoids stale closure)
    player.subscribe(subscriberId, {
      onStateChange: (state) => {
        // CRITICAL DEBUG: Log and trace every callback invocation
        // Also store in window for DevTools inspection
        (window as any).__lastPlaybackCallback = {
          timestamp: Date.now(),
          state,
          subscriberId,
          setPlaybackStateRefType: typeof setPlaybackStateRef.current
        };
        console.log(`[PLAYBACK CALLBACK ${subscriberId}] onStateChange: ${state}`, (window as any).__lastPlaybackCallback);
        
        // Verify the ref is valid before calling
        if (typeof setPlaybackStateRef.current !== 'function') {
          console.error('[PLAYBACK CALLBACK] setPlaybackStateRef.current is NOT a function!', setPlaybackStateRef.current);
          return;
        }
        
        // Use ref to ensure we always call the current setPlaybackState
        setPlaybackStateRef.current(state);
        (window as any).__playbackStateSetCount = ((window as any).__playbackStateSetCount || 0) + 1;
        
        // GL/PCM PATH FIX: In the Gemini Live path, audio goes through
        // enqueueProgressivePcmChunk which bypasses the traditional sentence
        // queue's playNext() → notifyComplete() chain. This means onComplete
        // never fires, so checkAndClearProcessing is never retried after
        // onSentenceStart clears the audioReceivedInTurnRef guard.
        // When the player transitions to 'idle' and response_complete has
        // already arrived, we know the turn is truly done — clear the guard
        // and re-run the check so the hook's isProcessing clears immediately
        // instead of waiting for the 10-second deferred timeout.
        if (state === 'idle' && responseCompleteRef.current) {
          audioReceivedInTurnRef.current = false;
          checkAndClearProcessing();
        }
      },
      onProgress: (currentTime, duration) => {
        // Update subtitle highlighting with actual duration for rescaling
        // Use ref to get latest subtitles (avoids stale closure from mount-time capture)
        subtitlesRef.current.updatePlaybackTime(currentTime, duration);
      },
      onSentenceStart: (sentenceIndex) => {
        if (isVerboseLoggingEnabled()) {
          console.log(`[StreamingVoice] Sentence ${sentenceIndex} started (turn ${currentTurnIdRef.current})`);
        }
        // Record when this sentence started playing — the tier-2 failsafe uses this to
        // avoid nuclear reset while a long sentence (greeting, etc.) is still active.
        lastSentenceStartedAtRef.current = Date.now();
        // Audio is now actually playing - clear the audioReceived guard
        // so that onComplete/checkAndClearProcessing can clear isProcessing
        audioReceivedInTurnRef.current = false;
        // Update debug state for tracking
        updateDebugTimingState({ lastOnSentenceStartFired: sentenceIndex });
        // Pass turnId for subtitle packet ordering (prevents phantom subtitles)
        subtitlesRef.current.startPlayback(sentenceIndex, currentTurnIdRef.current);
      },
      onSentenceEnd: (sentenceIndex) => {
        if (isVerboseLoggingEnabled()) {
          console.log(`[StreamingVoice] Sentence ${sentenceIndex} ended (turn ${currentTurnIdRef.current})`);
        }
        // Update debug state for tracking
        updateDebugTimingState({ lastOnSentenceEndFired: sentenceIndex });
        subtitlesRef.current.completeSentence(sentenceIndex, currentTurnIdRef.current);
      },
      onComplete: () => {
        if (isVerboseLoggingEnabled()) {
          console.log('[StreamingVoice] Playback queue empty');
        }
        // Only stop subtitles when response is truly complete
        // Don't stop during buffer gaps between sentences
        if (responseCompleteRef.current && pendingAudioCountRef.current === 0) {
          subtitlesRef.current.stopPlayback();
        }
        // Check if we can clear isProcessing
        checkAndClearProcessing();
      },
      onError: (err) => {
        console.error('[StreamingVoice] Playback error:', err);
        setError(err.message);
        setIsProcessingRef.current(false);
        setGlobalPlaybackState('idle');
        playerRef.current?.stop?.();
      },
      onPendingAudioChange: (count) => {
        if (isVerboseLoggingEnabled()) {
          console.log(`[StreamingVoice] Pending audio: ${count}`);
        }
        pendingAudioCountRef.current = count;
        // If no pending audio and response complete, clear isProcessing
        if (count === 0) {
          checkAndClearProcessing();
        }
      },
    });
    
    return () => {
      // CRITICAL: Unsubscribe to remove stale callbacks
      console.log(`[CALLBACK CLEANUP] Unsubscribing ID: ${subscriberId}`);
      player.unsubscribe(subscriberId);
      player.destroy();
    };
  }, []);
  
  /**
   * DOM Event Bridge: Parallel path for receiving playback state changes
   * This ensures state updates even if the callback closure becomes stale during HMR
   */
  useEffect(() => {
    const handlePlaybackStateEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ state: StreamingPlaybackState; timestamp: number; subscriberCount: number }>;
      const { state, timestamp, subscriberCount } = customEvent.detail;
      
      console.log(`[DOM EVENT BRIDGE] Received state: ${state}, subscribers: ${subscriberCount}, ts: ${timestamp}`);
      
      // Update state via direct setter (fresh closure, not the ref)
      setPlaybackState(state);
    };
    
    window.addEventListener('streaming-playback-state', handlePlaybackStateEvent);
    console.log('[DOM EVENT BRIDGE] Listener registered');
    
    return () => {
      window.removeEventListener('streaming-playback-state', handlePlaybackStateEvent);
      console.log('[DOM EVENT BRIDGE] Listener removed');
    };
  }, []);
  
  /**
   * Mobile AudioContext recovery — two layers:
   * 
   * 1. visibilitychange: When user returns from screen lock / app switch,
   *    resume AudioContext immediately and clear stuck processing state.
   * 
   * 2. User interaction fallback (touchstart/click): If the AudioContext is
   *    still suspended after visibility resume (Chrome requires a user gesture),
   *    the next tap will resume it. This also catches the greeting-silence case
   *    where audio was generated but never played because the context was suspended.
   */
  useEffect(() => {
    let needsInteractionResume = false;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[StreamingVoice] App became visible — resuming AudioContext');
        
        if (playerRef.current) {
          playerRef.current.resumeAudioContext().then(() => {
            const state = playerRef.current?.getAudioContextState?.();
            if (state === 'suspended') {
              needsInteractionResume = true;
              console.log('[StreamingVoice] AudioContext still suspended after resume — will retry on next user tap');
            }
          }).catch(() => {
            needsInteractionResume = true;
          });
        }
        
        setTimeout(() => {
          if (responseCompleteRef.current && pendingAudioCountRef.current === 0) {
            console.log('[StreamingVoice] Visibility recovery: response was complete, clearing stuck isProcessing');
            audioReceivedInTurnRef.current = false;
            setIsProcessingRef.current(false);
          } else if (responseCompleteRef.current) {
            console.log('[StreamingVoice] Visibility recovery: response complete but pendingAudio > 0, force-clearing');
            pendingAudioCountRef.current = 0;
            audioReceivedInTurnRef.current = false;
            setIsProcessingRef.current(false);
          }
        }, 500);
      }
    };

    const handleUserInteraction = () => {
      if (!needsInteractionResume) return;
      needsInteractionResume = false;
      if (playerRef.current) {
        const state = playerRef.current.getAudioContextState?.();
        if (state === 'suspended' || state === 'uninitialized') {
          console.log('[StreamingVoice] User gesture detected — resuming AudioContext');
          playerRef.current.resumeAudioContext().catch(() => {});
        }
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('touchstart', handleUserInteraction, { passive: true });
    document.addEventListener('click', handleUserInteraction);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('touchstart', handleUserInteraction);
      document.removeEventListener('click', handleUserInteraction);
    };
  }, []);
  
  /**
   * Handle processing message (new turn started)
   * This sets the turnId for subtitle packet ordering, preventing phantom subtitles
   * 
   * CRITICAL: Uses subtitlesRef.current to avoid stale closure issues.
   * CRITICAL: Must reset audio player to clear previous turn's schedule,
   * preventing stale onSentenceStart callbacks from mixing with new turn.
   */
  const handleGreetingRetry = useCallback((msg: { type: string; attempt: number }) => {
    if (greetingAudioArrivedRef.current) {
      console.log(`[StreamingVoice] Greeting retry #${msg.attempt} ignored — audio already arrived`);
      return;
    }
    console.log(`[StreamingVoice] Greeting retry #${msg.attempt} — resetting 15s silence watchdog`);
    if (greetingSilenceWatchdogRef.current) {
      clearTimeout(greetingSilenceWatchdogRef.current);
    }
    greetingSilenceWatchdogRef.current = startGreetingSilenceWatchdog();
  }, []);

  const handleProcessing = useCallback((msg: StreamingProcessingMessage) => {
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Processing turn ${msg.turnId}: "${msg.userTranscript.substring(0, 30)}..."`);
    }
    
    // CRITICAL: Reset turn-start diagnostics so the lockout watchdog doesn't fire mid-turn.
    // The PTT path calls diagMarkTurnStart() in sendAudio(); open-mic never did, leaving
    // responseCompleteTimestamp set from the previous turn. If the new turn takes > 8 s
    // (e.g. Gemini + function-call chain), the watchdog would fire a false positive.
    // The server's 'processing' message is the authoritative "new turn started" signal
    // for both PTT and open-mic, so this is the correct place to reset it.
    diagMarkTurnStart();
    
    // CRITICAL: Set processing state when server indicates new turn is processing
    // This ensures thinking indicator shows for server-initiated responses (tutor handoffs, etc.)
    setIsProcessing(true);
    // Guard: never overwrite 'playing' or 'buffering' — audio may already be streaming
    // (race condition: audio chunk arrives before the processing signal in the GL path)
    if (getGlobalPlaybackState() !== 'playing' && getGlobalPlaybackState() !== 'buffering') {
      setGlobalPlaybackState('thinking');
    }
    
    // Reset audio received flag for new turn
    audioReceivedInTurnRef.current = false;
    
    // Store turnId for use in callbacks
    currentTurnIdRef.current = msg.turnId;
    
    // Start processing timeout (stuck thinking recovery) - applies to BOTH PTT and open mic
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Processing timeout - resetting stuck thinking state + playback');
      reportVoiceClientError('processing_timeout', 'Processing timeout — handleProcessing', PROCESSING_TIMEOUT_MS);
      setIsProcessing(false);
      setError('Response timeout - please try again');
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, PROCESSING_TIMEOUT_MS);
    
    // CRITICAL FIX: Reset audio player for new turn
    // This clears the previous turn's sentence/word schedule, preventing
    // stale callbacks from firing when new audio starts playing
    if (playerRef.current) {
      playerRef.current.resetForNewTurn();
    }
    
    // Initialize subtitle state for new turn
    subtitlesRef.current.setCurrentTurnId(msg.turnId);
  }, []);

  /**
   * Handle processing_pending message - IMMEDIATE thinking signal
   * This fires right when PTT is released, before Deepgram finalization wait.
   * Triggers thinking avatar immediately for better perceived responsiveness.
   */
  const handleProcessingPending = useCallback((msg: { type: string; timestamp: number; interimTranscript?: string }) => {
    console.log(`[StreamingVoice] Processing pending: "${(msg.interimTranscript ?? '').substring(0, 30)}..."`);
    
    // Cancel any speculative thinking timer — real signal arrived.
    if (speculativeThinkingTimerRef.current) {
      clearTimeout(speculativeThinkingTimerRef.current);
      speculativeThinkingTimerRef.current = null;
    }

    // IMMEDIATELY show thinking indicator
    setIsProcessing(true);
    // Guard: never overwrite 'playing' or 'buffering' — in the GL path, processing_pending
    // fires on the same first audio chunk, so audio may already be streaming by the time
    // this handler runs. Overwriting 'playing' with 'thinking' causes the avatar to get
    // stuck on the thinking state for the entire duration of the response.
    if (getGlobalPlaybackState() !== 'playing' && getGlobalPlaybackState() !== 'buffering') {
      setGlobalPlaybackState('thinking');
    }
    audioReceivedInTurnRef.current = false;
    
    // GL PATH FIX: Reset the audio player's deduplication state for the new turn.
    // In the GL path, only processing_pending fires (never the 'processing' event),
    // so resetForNewTurn() was never called between turns. The dedup set from the
    // previous turn persisted, causing early chunks of the new turn (s0_c0, s0_c1, …)
    // to be incorrectly blocked as "already seen" — chopping off the first few seconds
    // of every GL response after the first. This is idempotent: calling it in both
    // handleProcessingPending and handleProcessing (PTT path) is safe.
    playerRef.current?.resetForNewTurn?.();
    
    // Pre-warm the AudioContext so the first audio samples don't fade in from silence.
    // processing_pending fires just before audio arrives — an ideal time to resume.
    playerRef.current?.resumeAudioContext?.();
    
    // Notify component so it can set its own isProcessing state immediately.
    // This drives the thinking avatar via the component-level isProcessing prop
    // (which is properly cleared by onResponseComplete), avoiding the hook's
    // internal timing issues with checkAndClearProcessing in the PCM audio path.
    sessionConfigRef.current?.onProcessingPending?.();
    
    // Start processing timeout (same as handleProcessing)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Processing timeout (pending) - resetting stuck thinking state + playback');
      reportVoiceClientError('processing_timeout', 'Processing timeout — handleProcessingPending', PROCESSING_TIMEOUT_MS);
      setIsProcessing(false);
      setError('Response timeout - please try again');
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, PROCESSING_TIMEOUT_MS);
  }, []);

  const handleNoSpeechDetected = useCallback(() => {
    console.log('[StreamingVoice] No speech detected - resetting to idle');
    setIsProcessing(false);
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    if (sessionConfigRef.current?.onNoSpeechDetected) {
      sessionConfigRef.current.onNoSpeechDetected();
    }
  }, []);

  /**
   * Handle function_executing message — server is running a tool call (memory search,
   * image generation, etc.). Refreshes the thinking state so the avatar stays in
   * "thinking" mode for the full duration of the tool call, not just until processing_pending.
   */
  const handleFunctionExecuting = useCallback((msg: { type: string; functionName?: string; timestamp?: number }) => {
    console.log(`[StreamingVoice] Function executing: ${msg.functionName || 'unknown'} — refreshing thinking state`);
    // Guard: never override active audio playback
    if (getGlobalPlaybackState() === 'playing' || getGlobalPlaybackState() === 'buffering') return;
    // Refresh thinking state and re-arm the processing timeout so the avatar doesn't
    // time out during a long tool call (e.g. 15-30s image generation).
    setIsProcessing(true);
    setGlobalPlaybackState('thinking');
    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Function-executing timeout — resetting stuck state');
      reportVoiceClientError('processing_timeout', 'Processing timeout — functionExecuting', PROCESSING_TIMEOUT_MS);
      setIsProcessing(false);
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, PROCESSING_TIMEOUT_MS);
    // Notify component so it keeps its own isProcessing ref active
    sessionConfigRef.current?.onProcessingPending?.();
  }, []);
  
  /**
   * Handle sentence start message
   * Now includes turnId and hasTargetContent for server-driven subtitle state
   * 
   * CRITICAL: Uses subtitlesRef.current to avoid stale closure issues.
   */
  const handleSentenceStart = useCallback((msg: StreamingSentenceStartMessage) => {
    // ALWAYS log sentence_start for debugging subtitle issues
    console.log(`[SENTENCE_START] sentence=${msg.sentenceIndex}, hasTarget=${msg.hasTargetContent}, targetText="${(msg.targetLanguageText || '').substring(0, 40)}..."`);
    
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Sentence ${msg.sentenceIndex} (turn ${msg.turnId}): "${msg.text.substring(0, 40)}..." hasTarget=${msg.hasTargetContent}`);
    }
    
    // Activity detected - extend the safety timeout since audio generation is underway
    // 45s is enough for even long multi-sentence TTS to complete (reduced from 180s
    // which left mobile users stuck for 3 minutes when AudioContext suspended)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = setTimeout(() => {
        console.log('[StreamingVoice] Processing timeout - resetting stuck thinking state');
        setIsProcessing(false);
        setError('Response timeout - please try again');
      }, 45000);
    }
    
    // Store turnId for callbacks (in case processing message wasn't received)
    if (msg.turnId > currentTurnIdRef.current) {
      currentTurnIdRef.current = msg.turnId;
    }
    
    // Use new v2 API with turnId and hasTargetContent
    subtitlesRef.current.addSentence(
      msg.sentenceIndex, 
      msg.text, 
      msg.turnId,
      msg.hasTargetContent,
      msg.targetLanguageText, 
      msg.wordMapping
    );
  }, []);
  
  /**
   * Handle audio chunk message
   * Supports both MP3 (HTMLAudioElement) and raw PCM (Web Audio API)
   * 
   * PROGRESSIVE STREAMING: When audioFormat is 'pcm_f32le', route to
   * progressive playback which schedules chunks for gapless playback
   * as they arrive. This eliminates the ~2s sentence buffering delay.
   */
  const handleAudioChunk = useCallback((msg: StreamingAudioChunkMessage) => {
    console.log('[HOOK handleAudioChunk] CALLED! sentence=', msg.sentenceIndex, 'chunk=', msg.chunkIndex, 'audioLen=', msg.audio?.length || 0);
    
    if (msg.chunkIndex === 0) {
      audioReceivedInTurnRef.current = true;
      greetingAudioArrivedRef.current = true;  // guard: greeting_retry is a no-op once audio lands
    }
    
    diagMarkFirstAudio();
    
    // CRITICAL DEBUG: Track chunks via debug panel state (reliable visibility)
    logAudioChunkReceived(msg.sentenceIndex);
    
    // CRITICAL DEBUG: Track chunks at window level for debugging
    if (typeof window !== 'undefined') {
      const w = window as any;
      if (!w._chunkStats) w._chunkStats = { total: 0, bySentence: {} };
      w._chunkStats.total++;
      w._chunkStats.bySentence[msg.sentenceIndex] = (w._chunkStats.bySentence[msg.sentenceIndex] || 0) + 1;
      w._lastChunk = { s: msg.sentenceIndex, c: msg.chunkIndex, t: Date.now() };
    }
    
    // Force log with console.error to ensure capture - only when verbose
    if (isVerboseLoggingEnabled()) {
      console.error(`[CHUNK RECEIVED] sentence=${msg.sentenceIndex}, chunk=${msg.chunkIndex}, format=${msg.audioFormat}, isLast=${msg.isLast}, audioLen=${msg.audio?.length || 0}`);
    }
    
    // CRITICAL DEBUG: Track empty chunks specifically
    if (msg.isLast && (!msg.audio || msg.audio.length === 0) && isVerboseLoggingEnabled()) {
      console.error(`[EMPTY CHUNK RECEIVED] sentence=${msg.sentenceIndex}, chunk=${msg.chunkIndex} - THIS IS A SENTENCE-END MARKER`);
    }
    
    if (!playerRef.current) {
      console.warn('[StreamingVoice] Audio chunk received but no player - DROPPING AUDIO');
      if (msg.audioFormat === 'pcm_f32le') getPlaybackLedger().dropped(msg.turnId, 'no_player');
      return;
    }

    // Buffer main response chunks while micro-ack is playing (max 700ms hold via safety timer)
    if (microAckPlayingRef.current) {
      microAckMsgBufferRef.current.push(msg);
      return;
    }

    const formatLabel = msg.audioFormat === 'pcm_f32le' ? 'PCM' : 'MP3';
    // Ensure chunkIndex is a number, not a string
    const chunkIndex = typeof msg.chunkIndex === 'number' ? msg.chunkIndex : parseInt(msg.chunkIndex as any, 10) || 0;
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Processing audio chunk (${formatLabel}): turn=${msg.turnId}, sentence=${msg.sentenceIndex}, chunk=${chunkIndex}, base64Len=${msg.audio?.length || 0}, isLast=${msg.isLast}`);
    }
    
    // Decode base64 to ArrayBuffer
    const binaryString = atob(msg.audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Audio decoded: ${bytes.buffer.byteLength} bytes (${formatLabel}) for sentence ${msg.sentenceIndex}`);
    }
    
    // PROGRESSIVE STREAMING: Use progressive playback for PCM chunks
    // This schedules audio for gapless playback as chunks arrive,
    // eliminating the ~2s delay from waiting for full sentence synthesis
    if (msg.audioFormat === 'pcm_f32le') {
      const sampleRate = msg.sampleRate || 24000;
      playerRef.current.enqueueProgressivePcmChunk(
        msg.sentenceIndex,
        chunkIndex,
        bytes.buffer,
        msg.durationMs,
        msg.isLast,
        sampleRate,
        msg.turnId
      );
      return;
    }
    
    // Traditional playback for MP3 (full sentence buffering)
    const chunk: StreamingAudioChunk = {
      sentenceIndex: msg.sentenceIndex,
      audio: bytes.buffer,
      durationMs: msg.durationMs,
      isLast: msg.isLast,
      audioFormat: msg.audioFormat || 'mp3',  // Default to MP3 for backwards compatibility
      sampleRate: msg.sampleRate || 24000,
    };
    
    playerRef.current.enqueue(chunk);
  }, []);
  
  /**
   * Handle word timing message (BUFFERED MODE ONLY)
   * 
   * In buffered mode (PROGRESSIVE_AUDIO_STREAMING: false), all word timings
   * arrive BEFORE the audio chunk. This guarantees karaoke highlighting
   * is properly synchronized because:
   * 1. Timings are registered with audio player FIRST
   * 2. Audio plays AFTER, using AudioContext.currentTime as truth
   * 
   * IMPORTANT: Only register with audio player in BUFFERED mode.
   * In progressive mode, handleWordTimingDelta handles registration to avoid duplicates.
   * 
   * CRITICAL: Uses subtitlesRef.current to avoid stale closure issues.
   */
  const handleWordTiming = useCallback((msg: StreamingWordTimingMessage) => {
    const isBufferedMode = !STREAMING_FEATURE_FLAGS.PROGRESSIVE_AUDIO_STREAMING;
    if (isVerboseLoggingEnabled()) {
      console.log(`[WORD_TIMING] Sentence ${msg.sentenceIndex}: ${msg.timings.length} words received (mode: ${isBufferedMode ? 'buffered' : 'progressive'})`);
    }
    
    // BUFFERED MODE ONLY: Register ALL word timings with the audio player for karaoke highlighting
    // This populates wordSchedule BEFORE audio playback starts
    // In progressive mode, handleWordTimingDelta handles this to avoid duplicate registrations
    if (isBufferedMode && playerRef.current && msg.timings && msg.timings.length > 0) {
      for (let i = 0; i < msg.timings.length; i++) {
        const timing = msg.timings[i];
        playerRef.current.registerWordTiming(
          msg.sentenceIndex,
          i,
          timing.word,
          timing.startTime,
          timing.endTime
        );
      }
      if (isVerboseLoggingEnabled()) {
        console.log(`[WORD_TIMING] Registered ${msg.timings.length} timings with audio player (buffered mode)`);
      }
    }
    
    // Always update subtitle hook for UI state (both modes)
    subtitlesRef.current.setWordTimings(msg.sentenceIndex, msg.turnId, msg.timings, msg.expectedDurationMs);
  }, []);

  // Keep ref in sync so fireMicroAck can flush buffered chunks
  handleAudioChunkRef.current = handleAudioChunk;

  /**
   * Fire a micro-ack clip immediately after the user stops speaking.
   * Sets microAckPlayingRef while the clip plays, buffering any incoming
   * main-response audio chunks. Flushes the buffer as soon as ack ends
   * (or after a 700ms safety timeout).
   */
  const fireMicroAck = (transcript: string) => {
    const clip = selectMicroAck(transcript);
    if (!clip) return;

    microAckPlayingRef.current = true;
    setMicroAckPlaying(true);

    const flush = () => {
      if (microAckFlushTimerRef.current) {
        clearTimeout(microAckFlushTimerRef.current);
        microAckFlushTimerRef.current = null;
      }
      microAckPlayingRef.current = false;
      setMicroAckPlaying(false);
      const buffered = microAckMsgBufferRef.current.splice(0);
      buffered.forEach(msg => handleAudioChunkRef.current?.(msg));
    };

    // Safety: flush after 700ms even if audio hasn't ended
    microAckFlushTimerRef.current = setTimeout(flush, 700);

    playMicroAck(clip).then(flush);
  };

  /**
   * PROGRESSIVE STREAMING: Handle incremental word timing update
   * These arrive as words are timestamped during progressive TTS
   * 
   * CRITICAL: Uses subtitlesRef.current to avoid stale closure issues.
   * Without this, the callback registered in connect() would use a stale
   * subtitles object, and progressive word timings would be lost.
   */
  const handleWordTimingDelta = useCallback((msg: StreamingWordTimingDeltaMessage) => {
    if (isVerboseLoggingEnabled()) {
      console.log(`[DELTA RECEIVED] sentence=${msg.sentenceIndex}, word=${msg.wordIndex} "${msg.word}"`);
    }
    
    // WORD-BASED TIMING: Register word with ABSOLUTE AudioContext times
    // This enables direct word matching in the timing loop
    if (playerRef.current) {
      playerRef.current.registerWordTiming(
        msg.sentenceIndex,
        msg.wordIndex,
        msg.word,
        msg.startTime,  // Relative to sentence start
        msg.endTime     // Relative to sentence start
      );
    }
    
    // Add the word timing incrementally for progressive display
    subtitlesRef.current.addProgressiveWordTiming(
      msg.sentenceIndex,
      msg.turnId,
      msg.wordIndex,
      msg.word,
      msg.startTime,
      msg.endTime,
      msg.estimatedTotalDuration
    );
  }, []);
  
  /**
   * NEW: Handle atomic sentence_ready message
   * 
   * This message contains BOTH the first audio chunk AND the first word timings,
   * sent atomically by the server to prevent the timing race condition where
   * playback starts before timings arrive.
   * 
   * Client should use this as the signal to start playback - guaranteed to have timing data.
   */
  const handleSentenceReady = useCallback((msg: StreamingSentenceReadyMessage) => {
    const { sentenceIndex, turnId, firstAudioChunk, firstWordTimings, estimatedTotalDuration } = msg;
    
    // ALWAYS log sentence_ready receipt for diagnostics (this was a critical silent failure)
    const audioStripped = (firstAudioChunk as any)?.audioStripped === true;
    const hasAudio = firstAudioChunk?.audio && firstAudioChunk.audio.length > 0;
    console.log(`[SENTENCE_READY] Received: sentence=${sentenceIndex}, turn=${turnId}, timings=${firstWordTimings?.length || 0}, hasAudio=${hasAudio}, audioStripped=${audioStripped}`);
    
    // Mark that audio has been received in this turn
    // This prevents checkAndClearProcessing from clearing isProcessing
    // before the audio player has actually started playing
    audioReceivedInTurnRef.current = true;
    
    // Audio is arriving - clear the "thinking" timeout since we have proof the response is being generated
    // Use a safety net timeout (45s) to handle multi-segment TTS responses
    // 45s is sufficient for even long responses while preventing extended mobile lockout
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Safety timeout after sentence_ready - resetting stuck state + playback');
      reportVoiceClientError('processing_timeout', 'Safety timeout after sentence_ready', 45000);
      setIsProcessing(false);
      setError('Response timeout - please try again');
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, 45000);
    
    // TUTOR SWITCH: If we were switching tutors, clear the flag now that audio is ready
    setIsSwitchingTutor(false);
    if (tutorSwitchTimeoutRef.current) {
      clearTimeout(tutorSwitchTimeoutRef.current);
      tutorSwitchTimeoutRef.current = null;
    }
    
    const hasTimings = firstWordTimings && firstWordTimings.length > 0;
    
    if (!hasTimings) {
      console.log(`[SENTENCE_READY] Sentence ${sentenceIndex} has no timings yet (silent intro)`);
    }
    
    const reconstructedText = hasTimings 
      ? firstWordTimings.map(t => t.word).join(' ') 
      : '';
    subtitlesRef.current.addSentence(
      sentenceIndex,
      reconstructedText,
      turnId,
      false,
      undefined,
      undefined
    );
    
    // 1. Register all word timings with the player FIRST (before audio plays)
    if (playerRef.current && hasTimings) {
      for (let i = 0; i < firstWordTimings.length; i++) {
        const timing = firstWordTimings[i];
        playerRef.current.registerWordTiming(
          sentenceIndex,
          i,
          timing.word,
          timing.startTime,
          timing.endTime
        );
      }
    }
    
    // 2. Add word timings to subtitles for progressive display
    if (hasTimings) {
      for (let i = 0; i < firstWordTimings.length; i++) {
        const timing = firstWordTimings[i];
        subtitlesRef.current.addProgressiveWordTiming(
          sentenceIndex,
          turnId,
          i,
          timing.word,
          timing.startTime,
          timing.endTime,
          estimatedTotalDuration
        );
      }
    }
    
    // 3. Enqueue the first audio chunk for playback
    // PROXY FIX: If audioStripped=true, audio was too large for the proxy and will
    // arrive as a separate audio_chunk message. Skip enqueue here - handleAudioChunk handles it.
    if (playerRef.current && hasAudio && !audioStripped) {
      logAudioChunkReceived(sentenceIndex);
      
      const binaryString = atob(firstAudioChunk.audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      if (isVerboseLoggingEnabled()) {
        console.error(`[SENTENCE_READY] Enqueueing first audio chunk: ${bytes.buffer.byteLength} bytes`);
      }
      
      if (firstAudioChunk.audioFormat === 'pcm_f32le') {
        const normalizedChunkIndex = typeof firstAudioChunk.chunkIndex === 'number' 
          ? firstAudioChunk.chunkIndex 
          : parseInt(firstAudioChunk.chunkIndex as any, 10) || 0;
        playerRef.current.enqueueProgressivePcmChunk(
          sentenceIndex,
          normalizedChunkIndex,
          bytes.buffer,
          firstAudioChunk.durationMs,
          false,
          firstAudioChunk.sampleRate
        );
      } else {
        console.log(`[SENTENCE_READY] MP3 audio embedded - enqueueing via traditional path: ${bytes.buffer.byteLength} bytes`);
        const chunk: StreamingAudioChunk = {
          sentenceIndex,
          audio: bytes.buffer,
          durationMs: firstAudioChunk.durationMs,
          isLast: false,
          audioFormat: firstAudioChunk.audioFormat || 'mp3',
          sampleRate: firstAudioChunk.sampleRate || 24000,
        };
        playerRef.current.enqueue(chunk);
      }
    } else if (audioStripped) {
      console.log(`[SENTENCE_READY] Audio stripped by proxy adapter - will arrive as separate audio_chunk`);
    }
  }, []);
  
  /**
   * PROGRESSIVE STREAMING: Handle final word timing reconciliation
   * Sent when sentence synthesis completes with authoritative timings
   * 
   * CRITICAL: Uses subtitlesRef.current to avoid stale closure issues.
   */
  const handleWordTimingFinal = useCallback((msg: StreamingWordTimingFinalMessage) => {
    // Update with authoritative timings for perfect sync
    subtitlesRef.current.finalizeWordTimings(
      msg.sentenceIndex,
      msg.turnId,
      msg.words,
      msg.actualDurationMs
    );
  }, []);
  
  /**
   * Handle response complete message
   * The server has finished streaming all audio chunks.
   * Check if we can clear isProcessing (no pending audio remaining).
   * 
   * CRITICAL FIX: Pass totalSentences to audio player so it knows how many
   * sentences to expect before allowing playback to stop. This prevents
   * premature timing loop termination between sentences.
   */
  const handleResponseComplete = useCallback((msg: StreamingResponseCompleteMessage) => {
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Server signaled response complete: ${msg.totalSentences} sentences${msg.wasInterrupted ? ' (INTERRUPTED)' : ''}`);
    }
    
    // GUARD-RESET GUARD: The server sends synthetic response_complete messages with
    // turnId="guard-reset-<timestamp>" (a string, not a numeric turn sequence) when it
    // decides NOT to process an utterance (dedup, rapid-fire, greeting-in-progress, etc).
    // These are meant to reset client state ONLY when no real turn is in flight. If a
    // real turn IS currently streaming/playing audio, this synthetic message must be
    // ignored entirely — otherwise it prematurely clears isProcessing/pending audio and
    // cuts off the real response mid-playback (previously slipped past the stale-turn
    // guard below because a string turnId compared with `<` against a number is always
    // false, so it was never recognized as "stale").
    const isGuardResetMsg = typeof msg.turnId === 'string' && (msg.turnId as string).startsWith('guard-reset-');
    if (isGuardResetMsg) {
      const realTurnInFlight = audioReceivedInTurnRef.current || pendingAudioCountRef.current > 0 || !responseCompleteRef.current;
      if (realTurnInFlight) {
        console.log(`[StreamingVoice] Ignoring guard-reset response_complete — real turn is in flight (pending=${pendingAudioCountRef.current}, audioReceived=${audioReceivedInTurnRef.current})`);
        return;
      }
    }

    // STALE TURN GUARD: Ignore response_complete from a previous turn.
    // This prevents the greeting's response_complete from poisoning the OpenMic turn state
    // when both run concurrently (causes freeze: client thinks turn ended with no audio).
    if (msg.turnId !== undefined && !isGuardResetMsg && msg.turnId < currentTurnIdRef.current) {
      console.log(`[StreamingVoice] Ignoring stale response_complete: turnId=${msg.turnId}, current=${currentTurnIdRef.current}`);
      return;
    }
    
    setMetrics(msg.metrics || null);
    
    // BARGE-IN: If response was interrupted, immediately stop audio playback
    // This prevents overlapping audio when user speaks while AI is responding
    if (msg.wasInterrupted) {
      console.log('[StreamingVoice] Response interrupted by user - stopping audio immediately');
      playerRef.current?.stop();
      subtitlesRef.current.stopPlayback();
      subtitlesRef.current.reset();
      responseCompleteRef.current = true;
      pendingAudioCountRef.current = 0;
      // Clear processing timeout on interrupt
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
      setIsProcessing(false);
      return; // Don't do normal completion handling
    }
    
    trackWsMessage('response_complete');
    diagMarkResponseComplete(msg.totalSentences || 0);
    
    console.log(`[StreamingVoice] response_complete received: sentences=${msg.totalSentences}, pending=${pendingAudioCountRef.current}, wasComplete=${responseCompleteRef.current}`);
    
    // CRITICAL: Tell the audio player how many sentences this turn has
    // This prevents premature loop termination when early sentences finish
    // before later sentences have even arrived
    if (playerRef.current && msg.totalSentences !== undefined) {
      playerRef.current.setExpectedSentenceCount(msg.totalSentences);
    }
    
    // Mark response as complete
    responseCompleteRef.current = true;
    
    // Clear processing timeout (response received successfully)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    
    // Call the onResponseComplete callback to refresh messages
    // Messages are persisted server-side, so we need to refetch
    if (sessionConfigRef.current?.onResponseComplete && sessionConfigRef.current?.conversationId) {
      sessionConfigRef.current.onResponseComplete(sessionConfigRef.current.conversationId);
    }
    
    // FIX: If the brain produced zero sentences (e.g., pure tool call turn, or error path
    // that sent response_complete with totalSentences=0), no audio will ever arrive.
    // HOWEVER: GL sometimes fires a thinking-only generationComplete (no audio sub-turns)
    // immediately BEFORE the real audio response begins. Clearing isProcessing immediately
    // opens the mic gate while Daniela's audio is about to play — speaker echo feeds back
    // into the live mic, VAD fires, and she gets cut off mid-sentence.
    // Grace period: wait 400ms. If audio chunks start arriving, keep mic closed and let
    // the audio lifecycle handle cleanup. Only clear if truly no audio comes in that window.
    if (msg.totalSentences === 0) {
      const graceTurn = turnCounterRef.current;
      console.log('[StreamingVoice] response_complete totalSentences=0 — 400ms grace before opening mic (echo-barge-in guard)');
      setTimeout(() => {
        if (turnCounterRef.current !== graceTurn) return;  // new non-zero-sentence turn started
        if (audioReceivedInTurnRef.current) return;         // audio arrived — keep mic closed
        if (pendingAudioCountRef.current > 0) return;       // audio in flight — keep mic closed
        console.log('[StreamingVoice] totalSentences=0 grace elapsed — no audio, clearing isProcessing');
        audioReceivedInTurnRef.current = false;
        pendingAudioCountRef.current = 0;
        setIsProcessingRef.current(false);
      }, 400);
      return;
    }
    
    // Check if we can clear isProcessing (no pending audio)
    checkAndClearProcessing();
    
    // Increment turn counter so stale failsafe timers from previous turns bail out.
    // Without this, a 45s timer from Turn 1 fires during Turn 3, sees
    // responseCompleteRef=true (set by Turn 3), and incorrectly stops audio.
    const thisTurn = ++turnCounterRef.current;
    
    // FAILSAFE: If checkAndClearProcessing didn't clear isProcessing (e.g., due to
    // pendingAudioCount stuck > 0 from a previous bug), schedule a delayed force-clear.
    // IMPORTANT: Respect the audioReceivedInTurnRef guard — if audio was received but
    // playback hasn't started yet (common in batch TTS mode), don't force-clear
    // isProcessing here. Let the playback lifecycle (onSentenceStart → onComplete)
    // handle it. Otherwise we get a thinking → listening flash before speaking starts.
    setTimeout(() => {
      if (turnCounterRef.current !== thisTurn) return;
      if (audioReceivedInTurnRef.current) return;
      if (responseCompleteRef.current && pendingAudioCountRef.current === 0) {
        setIsProcessingRef.current(false);
      }
    }, 1000);
    
    // TIERED HARD FAILSAFE: Two tiers to cover both mobile and desktop lockout.
    // Each timer checks turnCounterRef to avoid acting on a stale turn.
    //
    // Tier 1 (20s): AudioContext-aware — catches mobile suspension where audio callbacks
    // never fire because the OS suspended the AudioContext.
    setTimeout(() => {
      if (turnCounterRef.current !== thisTurn) return;
      if (!responseCompleteRef.current) return;
      const player = playerRef.current;
      const ctxState = player?.getAudioContextState?.() || 'unknown';
      if (ctxState === 'suspended' || ctxState === 'closed' || ctxState === 'uninitialized') {
        console.log(`[StreamingVoice] Tier-1 failsafe (20s): AudioContext ${ctxState} — clearing state (turn=${thisTurn}, pending=${pendingAudioCountRef.current})`);
        diagMarkFailsafe('tier1_20s', { ctxState, pending: pendingAudioCountRef.current });
        reportDiagnostic('failsafe_tier1_20s', { failsafeTier: 'tier1_20s' });
        pendingAudioCountRef.current = 0;
        audioReceivedInTurnRef.current = false;
        setIsProcessingRef.current(false);
        setGlobalPlaybackState('idle');
        if (ctxState === 'suspended') {
          console.log('[StreamingVoice] Tier-1: AudioContext suspended — keeping queued audio alive (will play on user gesture)');
          player?.resumeAudioContext?.().catch(() => {});
        } else {
          player?.stop?.();
        }
      }
    }, 20000);
    
    // Tier 2 (8s, or immediate when WS is disconnected): Catches stuck states where
    // AudioContext is "running" but audio callbacks silently failed.
    //
    // Why 8s is the right floor:
    //   - The nuclear reset tears down the audio rendering stack only. The GL WebSocket
    //     and conversation thread are untouched — nobody notices, nobody loses their place.
    //   - TTS first-chunk delivery is typically <500ms after response_complete (streaming
    //     synthesis runs sentence-by-sentence during GL generation). Worst case on slow
    //     mobile: ~3-4s. 8s gives a 2× safety margin without sitting on a broken worklet.
    //   - The audioReceivedInTurnRef guard eliminates false positives on healthy turns:
    //     if audio already played successfully this turn and nothing is pending, there is
    //     no stuck worklet to fix — bail early and skip the reset entirely.
    //   - "Just a second" pauses are safe: if the student pauses mid-conversation, GL is
    //     still listening and the session is alive. When the next exchange generates audio,
    //     it plays on the fresh worklet with no hiccup.
    //
    // When the connection is already gone (WS dropped), audio will never arrive —
    // clear immediately without waiting 8s.
    // Playback-aware: if audio is actively playing or buffering, unlock mic and defer 45s.
    setTimeout(() => {
      if (turnCounterRef.current !== thisTurn) return;
      if (!responseCompleteRef.current) return;
      // Fast path: WS disconnected, no audio received — clear immediately
      const wsState = connectionStateRef.current;
      if ((wsState === 'disconnected' || wsState === 'reconnecting') && !audioReceivedInTurnRef.current) {
        console.log(`[StreamingVoice] Tier-2 fast path: WS ${wsState} + no audio — clearing stuck state (turn=${thisTurn})`);
        diagMarkFailsafe('tier2_45s', { ctxState: 'ws_disconnected', pending: pendingAudioCountRef.current });
        reportDiagnostic('failsafe_tier2_45s', { failsafeTier: 'tier2_ws_drop' });
        pendingAudioCountRef.current = 0;
        audioReceivedInTurnRef.current = false;
        setIsProcessingRef.current(false);
        setGlobalPlaybackState('idle');
        return;
      }
      // Healthy-turn guard: audio already arrived and played, nothing pending — pipeline is
      // fine. Resetting a healthy AudioContext is harmless but pointless; bail now.
      if (audioReceivedInTurnRef.current && pendingAudioCountRef.current === 0) {
        return;
      }
      const player = playerRef.current;
      const ctxState = player?.getAudioContextState?.() || 'unknown';
      const currentPlayback = getGlobalPlaybackState();
      
      if (currentPlayback === 'playing' || currentPlayback === 'buffering') {
        // Audio is genuinely active — unlock the mic now so the student isn't blocked,
        // but give the playback 45 more seconds before the final force-clear.
        console.log(`[StreamingVoice] Tier-2 failsafe (8s): audio active (${currentPlayback}) — unlocking mic, deferring force-clear 45s (turn=${thisTurn})`);
        pendingAudioCountRef.current = 0;
        audioReceivedInTurnRef.current = false;
        setIsProcessingRef.current(false);
        
        setTimeout(() => {
          if (turnCounterRef.current !== thisTurn) return;
          if (!responseCompleteRef.current) return;
          const finalPlayback = getGlobalPlaybackState();
          const finalCtxState = player?.getAudioContextState?.() || 'unknown';
          console.log(`[StreamingVoice] Tier-2 extended failsafe (53s): force-clear (playback=${finalPlayback}, ctxState=${finalCtxState}, turn=${thisTurn})`);
          diagMarkFailsafe('tier2_90s', { ctxState: finalCtxState, pending: pendingAudioCountRef.current });
          reportDiagnostic('failsafe_tier2_45s', { failsafeTier: 'tier2_90s' });
          pendingAudioCountRef.current = 0;
          audioReceivedInTurnRef.current = false;
          setIsProcessingRef.current(false);
          setGlobalPlaybackState('idle');
          player?.stop?.();
        }, 45000);
      } else {
        // No audio playing, AudioContext "running" but callbacks stalled — stuck worklet.
        // Nuclear reset: close + recreate AudioContext so the next turn starts clean.
        // GL WebSocket is unaffected; the conversation thread is intact.
        //
        // GUARD: onSentenceStart clears audioReceivedInTurnRef so the healthy-turn guard
        // above can't protect turns where a long sentence is still playing (greeting audio
        // can run 20-30s). Use lastSentenceStartedAtRef to detect this: if a sentence
        // started within the last 30s, the audio is likely still playing — skip the nuclear
        // reset and just clear isProcessing so the mic unlocks. The audio finishes naturally.
        const msSinceSentenceStart = Date.now() - lastSentenceStartedAtRef.current;
        const sentenceRecentlyStarted = lastSentenceStartedAtRef.current > 0 && msSinceSentenceStart < 30000;
        console.log(`[StreamingVoice] Tier-2 failsafe (8s): audio NOT active (${currentPlayback}), msSinceSentenceStart=${msSinceSentenceStart}, sentenceRecentlyStarted=${sentenceRecentlyStarted} (turn=${thisTurn}, pending=${pendingAudioCountRef.current})`);
        diagMarkFailsafe('tier2_45s', { ctxState, pending: pendingAudioCountRef.current });
        reportDiagnostic('failsafe_tier2_45s', { failsafeTier: 'tier2_45s' });
        pendingAudioCountRef.current = 0;
        audioReceivedInTurnRef.current = false;
        setIsProcessingRef.current(false);
        if (sentenceRecentlyStarted) {
          // Audio is likely still playing (long sentence, state sync lag). Don't nuke the
          // pipeline — just unlock the mic and let playback finish naturally.
          console.log(`[StreamingVoice] Tier-2: sentence started ${msSinceSentenceStart}ms ago — skipping nuclear reset, audio may still be playing`);
        } else {
          setGlobalPlaybackState('idle');
          if (ctxState === 'suspended') {
            console.log('[StreamingVoice] Tier-2: AudioContext suspended — keeping queued audio alive (will play on user gesture)');
            player?.resumeAudioContext?.().catch(() => {});
          } else {
            // AudioContext is "running" but audio callbacks stalled (AudioWorklet stuck state).
            // stop() alone leaves the broken pipe intact — use nuclear reset to close and
            // recreate the AudioContext so the next turn starts with a fresh worklet.
            console.warn('[StreamingVoice] Tier-2: AudioContext running but stalled — nuclear reset to clear stuck AudioWorklet');
            player?.resetAudioPipeline?.();
          }
        }
      }
    }, 8000);
    
    startLockoutWatchdog();
  }, [checkAndClearProcessing]);

  const handleExpectedSentenceCount = useCallback((data: { count: number }) => {
    if (playerRef.current) {
      console.log(`[StreamingVoice] Early sentence count: ${data.count} sentences expected`);
      playerRef.current.setExpectedSentenceCount(data.count);
    }
  }, []);

  /**
   * Handle errors - also clears tutor switch state to prevent mic lockout
   */
  const handleTtsError = useCallback((data: { code: string; message: string }) => {
    diagMarkTtsError(data.code, data.message);
    console.warn(`[StreamingVoice] TTS audio failed: ${data.message}`);
    // Show a brief "audio unavailable" indicator so the user knows what happened
    setTtsUnavailable(true);
    if (ttsUnavailableTimerRef.current) clearTimeout(ttsUnavailableTimerRef.current);
    ttsUnavailableTimerRef.current = setTimeout(() => setTtsUnavailable(false), 8000);
  }, []);

  const handleSttDegraded = useCallback((data: { userMessage?: string; suggestPtt?: boolean }) => {
    const msg = data?.userMessage || 'Having trouble hearing you — please try again.';
    const suggest = Boolean(data?.suggestPtt);
    console.warn('[StreamingVoice] STT degraded:', msg, suggest ? '(suggest PTT)' : '');
    setSttDegraded(true);
    setSttDegradedMessage(msg);
    setSttSuggestPtt(suggest);
    if (sttDegradedTimerRef.current) clearTimeout(sttDegradedTimerRef.current);
    // Persistent failures stay visible; transient ones auto-clear after 6s
    if (!suggest) {
      sttDegradedTimerRef.current = setTimeout(() => setSttDegraded(false), 6000);
    }
  }, []);

  const handleError = useCallback((err: Error) => {
    console.error('[StreamingVoice] Error:', err);
    diagMarkError('ws_error', err.message);
    reportVoiceClientError('voice_error', err.message);
    const isCreditsError = err.message?.includes('credits have been used up') || err.message?.includes('Insufficient tutoring hours');
    if (!isCreditsError) {
      reportDiagnostic('error');
    }
    setError(err.message);
    setIsProcessing(false);
    setGlobalPlaybackState('idle');
    playerRef.current?.stop?.();
    
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    
    // Clear tutor switch state to prevent mic lockout on errors
    if (tutorSwitchTimeoutRef.current) {
      clearTimeout(tutorSwitchTimeoutRef.current);
      tutorSwitchTimeoutRef.current = null;
    }
    setIsSwitchingTutor(false);
  }, []);

  const handleIdleTimeout = useCallback(({ idleMinutes }: { idleMinutes: number }) => {
    console.warn(`[StreamingVoice] Session ended due to ${idleMinutes} min inactivity`);
    setError(`Session ended after ${idleMinutes} minutes of inactivity. Tap the button to start a new session.`);
    setIsProcessing(false);
    setGlobalPlaybackState('idle');
    playerRef.current?.stop?.();
  }, []);

  const handleCreditWarning = useCallback(({ level, remainingSeconds, percentRemaining }: {
    level: 'low' | 'critical' | 'exhausted';
    remainingSeconds: number;
    percentRemaining: number;
  }) => {
    console.warn(`[StreamingVoice] Credit warning: ${level} (${remainingSeconds}s / ${percentRemaining.toFixed(1)}% remaining)`);
    if (sessionConfigRef.current?.onCreditWarning) {
      sessionConfigRef.current.onCreditWarning({ level, remainingSeconds, percentRemaining });
    }
  }, []);

  const handleSessionConflict = useCallback(({ message }: { message: string; existingSessionId?: string }) => {
    console.warn('[StreamingVoice] Session conflict:', message);
    setError(message || 'A session is already active in another tab. Please close it and try again.');
    setIsProcessing(false);
    setGlobalPlaybackState('idle');
    playerRef.current?.stop?.();
  }, []);

  /**
   * Handle whiteboard updates from server (e.g., enriched WORD_MAP items)
   */
  const handleWhiteboardUpdate = useCallback((message: StreamingWhiteboardMessage) => {
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] Whiteboard update received:', message.items?.length || 0, 'items');
    }
    
    if (sessionConfigRef.current?.onWhiteboardUpdate && message.items) {
      sessionConfigRef.current.onWhiteboardUpdate(message.items, message.shouldClear || false);
    }
  }, []);

  const handleLessonNoteAdded = useCallback((message: { type: string; timestamp: number; note: any }) => {
    if (sessionConfigRef.current?.onLessonNoteAdded && message.note) {
      sessionConfigRef.current.onLessonNoteAdded(message.note);
    }
  }, []);

  const handlePronunciationScoreShown = useCallback((message: { type: string; timestamp: number; data: any }) => {
    if (!sessionConfigRef.current?.onPronunciationScoreShown || !message.data) return;
    // Guard: validatePronunciationScorePayload drops malformed payloads before they
    // reach the component (missing phrase, empty wordScores, non-numeric overallScore).
    // It also sanitises whitespace-only encouragement strings.
    const payload = validatePronunciationScorePayload(message.data);
    if (!payload) {
      console.warn('[useStreamingVoice] Dropped malformed pronunciation_score_shown — phrase or wordScores invalid', message.data);
      return;
    }
    sessionConfigRef.current.onPronunciationScoreShown(payload);
  }, []);

  const handleGrammarFlagShown = useCallback((message: { type: string; timestamp: number; data: any }) => {
    if (!sessionConfigRef.current?.onGrammarFlagShown || !message.data) return;
    const payload = validateGrammarFlagPayload(message.data);
    if (!payload) {
      console.warn('[useStreamingVoice] handleGrammarFlagShown: malformed grammar flag data (blank original, corrected, or explanation)', message.data);
      return;
    }
    sessionConfigRef.current.onGrammarFlagShown(payload);
  }, []);

  const handleQuizPresented = useCallback((message: { type: string; timestamp: number; data: any }) => {
    if (!sessionConfigRef.current?.onQuizPresented || !message.data) return;
    const payload = validateQuizPayload(message.data);
    if (!payload) {
      console.warn('[useStreamingVoice] handleQuizPresented: malformed data, skipping', message.data);
      return;
    }
    sessionConfigRef.current.onQuizPresented(payload);
  }, []);

  const handleCulturalContextShown = useCallback((message: { type: string; timestamp: number; data: any }) => {
    if (!sessionConfigRef.current?.onCulturalContextShown || !message.data) return;
    const payload = validateCulturalContextPayload(message.data);
    if (!payload) {
      console.warn('[useStreamingVoice] handleCulturalContextShown: malformed cultural context data', message.data);
      return;
    }
    sessionConfigRef.current.onCulturalContextShown(payload);
  }, []);

  const handleSpotlightShown = useCallback((message: { type: string; timestamp: number; data: any }) => {
    if (!sessionConfigRef.current?.onSpotlightShown || !message.data) return;
    const d = validateSpotlightMessage(message.data);
    if (!d) {
      console.warn('[useStreamingVoice] handleSpotlightShown: malformed spotlight data (empty message)', message.data);
      return;
    }
    sessionConfigRef.current.onSpotlightShown(d as any);
  }, []);

  // Gap D — Shared Mission
  const handleSofiaSupportMessage = useCallback((message: { type: string; incidentId: string; category: string; priority: string; message: string; timestamp: number }) => {
    setSofiaIncident({ incidentId: message.incidentId, category: message.category, priority: message.priority, message: message.message, timestamp: message.timestamp });
  }, []);

  const handleSofiaAllClear = useCallback((_message: { type: string; incidentId: string; timestamp: number }) => {
    setSofiaIncident(null);
  }, []);

  const handleMissionSet = useCallback((message: { type: string; mission: string; timestamp: number }) => {
    if (message.mission) {
      // Update global store so ImmersiveOverlay (outside StreamingVoiceChat tree) can render it
      import('@/lib/missionStore').then(({ setGlobalMission }) => setGlobalMission(message.mission));
      if (sessionConfigRef.current?.onMissionSet) {
        sessionConfigRef.current.onMissionSet(message.mission);
      }
    }
  }, []);
  
  /**
   * Handle pronunciation coaching feedback from server
   * Provides real-time feedback based on Deepgram word-level confidence scores
   */
  const handlePronunciationCoaching = useCallback((message: {
    type: string;
    timestamp: number;
    turnId: string;
    coaching: {
      overallScore: number;
      wordFeedback: Array<{
        word: string;
        confidence: number;
        status: 'excellent' | 'good' | 'needs_work' | 'difficult';
        suggestion?: string;
      }>;
      coachingTips: string[];
      encouragement: string;
      lowConfidenceWords: string[];
      phonemeHints: Array<{
        phoneme: string;
        word: string;
        tip: string;
      }>;
    };
  }) => {
    console.log(`[StreamingVoice] Pronunciation coaching: ${message.coaching.overallScore}% score, ${message.coaching.lowConfidenceWords.length} words need attention`);
    
    if (sessionConfigRef.current?.onPronunciationCoaching) {
      sessionConfigRef.current.onPronunciationCoaching(message.coaching);
    }
  }, []);
  
  /**
   * Handle VAD speech started event (open mic mode)
   */
  const handleVadSpeechStarted = useCallback((message: { type: string }) => {
    // ALWAYS log VAD events for barge-in debugging
    console.log('[StreamingVoice] VAD speech started - triggering onVadSpeechStarted callback');
    sessionConfigRef.current?.onVadSpeechStarted?.();
  }, []);
  
  /**
   * Handle VAD utterance end event (open mic mode)
   */
  const handleVadUtteranceEnd = useCallback((message: { type: string; transcript?: string; empty?: boolean }) => {
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] VAD utterance end, transcript:', message.transcript, 'empty:', message.empty);
    }
    // Mark speech end for E2E latency tracking (speech_end → first_audio) — skip empty VAD pings
    if (!message.empty) {
      diagMarkSpeechEnd('vad');
      fireMicroAck(message.transcript || '');
    }
    sessionConfigRef.current?.onVadUtteranceEnd?.(message.transcript || '', message.empty);
  }, []);
  
  /**
   * Handle interim transcript (open mic mode)
   * NOTE: Server sends "text" field, not "transcript"
   */
  const handleInterimTranscript = useCallback((message: { type: string; text?: string; transcript?: string }) => {
    // Server sends "text" field, but support "transcript" as fallback
    const transcript = message.text || message.transcript || '';
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] Interim transcript:', transcript);
    }
    sessionConfigRef.current?.onInterimTranscript?.(transcript);
  }, []);
  
  /**
   * Handle open mic session closed (e.g., Deepgram timeout)
   */
  const handleOpenMicSessionClosed = useCallback(() => {
    console.log('[StreamingVoice] Open mic session closed - client should restart if in open mic mode');
    sessionConfigRef.current?.onOpenMicSessionClosed?.();
  }, []);
  
  const handleOpenMicSilenceLoop = useCallback((message: { consecutiveEmptyCount: number; msSinceLastSuccessfulTranscript: number }) => {
    console.warn(`[StreamingVoice] Silence loop: ${message.consecutiveEmptyCount} empty transcripts, ${message.msSinceLastSuccessfulTranscript}ms since last speech`);
    sessionConfigRef.current?.onOpenMicSilenceLoop?.(message.consecutiveEmptyCount, message.msSinceLastSuccessfulTranscript);
  }, []);

  // ── Gemini Live transcript events ──────────────────────────────────────────
  const handleTranscript = useCallback((message: { type: string; text: string; isFinal: boolean; source: string }) => {
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] User transcript (Gemini Live):', message.text.substring(0, 60));
    }
    // Forward as barge-in signal (same as Deepgram interim, drives open-mic state machine)
    sessionConfigRef.current?.onInterimTranscript?.(message.text);
    // Also fire dedicated GL callback so the component can accumulate the live caption bar
    // without conflating it with Deepgram interim transcripts.
    sessionConfigRef.current?.onGlUserTranscript?.(message.text);

    // Speculative thinking: restart the 700ms debounce on each new GL inputTranscription chunk.
    // When chunks stop arriving, GL has committed the student's turn and is generating.
    // Switching the avatar to 'thinking' here closes the gap between the student's last
    // word and the real processing_pending (which arrives with the first audio/transcription).
    // Guard: only fire if not already in a generating/playing state.
    if (speculativeThinkingTimerRef.current) {
      clearTimeout(speculativeThinkingTimerRef.current);
    }
    speculativeThinkingTimerRef.current = setTimeout(() => {
      speculativeThinkingTimerRef.current = null;
      const state = getGlobalPlaybackState();
      if (state !== 'thinking' && state !== 'playing' && state !== 'buffering') {
        console.log('[StreamingVoice] Speculative thinking — GL inputTranscription stopped, student turn likely done');
        setGlobalPlaybackState('thinking');
      }
    }, 700);
  }, []);

  const handleDanielaTranscript = useCallback((message: { type: string; text: string; turnId: number }) => {
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] Daniela transcript (Gemini Live):', message.text.substring(0, 60));
    }
  }, []);

  const handleReconnected = useCallback((_message: { timestamp: number }) => {
    console.log('[StreamingVoice] Successfully reconnected after connection drop — clearing stale processing state');

    // AUTOSCALE RECOVERY: The server instance that was mid-sentence is gone.
    // Reset all processing/playback state so the client isn't stuck waiting
    // for audio that will never arrive from the old instance.
    playerRef.current?.stop();
    subtitles.stopPlayback();
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    setIsProcessingRef.current(false);

    sessionConfigRef.current?.onReconnected?.();
  }, [subtitles]);

  /**
   * GL 1008 reconnect initiated — server is rebuilding the GL session with a Context Bridge.
   * Show "gathering thoughts" state so there's no silent gap for the student.
   */
  const handleGlReconnecting = useCallback((_message: { type: string }) => {
    console.log('[StreamingVoice] gl_reconnecting — Daniela is rebuilding session context');
    // Clear any stale "connection failed" error so the UI shows the transient
    // reconnecting indicator (driven by connectionState === 'reconnecting')
    // instead of a hard error popup while the server rebuilds the GL session.
    setError(null);
    // Clear the retry prompt — the student already tapped or the server is auto-reconnecting.
    setGlDisconnectedForRetry(false);
    setGlobalPlaybackState('thinking');
    sessionConfigRef.current?.onReconnecting?.();
  }, []);

  /**
   * GL reconnect succeeded — server re-established the Gemini Live WebSocket
   * (e.g. after a 1008 drop) and injected the Context Bridge. The Socket.io
   * connection to the client never dropped, so the session is fully usable:
   * clear any error popup and stuck processing/playback state so the student
   * can keep talking without a page reload.
   */
  const handleGlReconnected = useCallback((_message: { type: string }) => {
    console.log('[StreamingVoice] gl_reconnected — GL session restored, resuming without reload');
    setError(null);
    setGlDisconnectedForRetry(false);
    setIsProcessingRef.current(false);
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    // ECHO GUARD: pre-drop Daniela audio may still be scheduled in the AudioContext
    // (the server only sends gl_audio_reset when hadAudioInCurrentSubturn is true,
    // which can be cleared by a server-side seal before client playback finishes).
    // Stop the player FIRST so no stale audio keeps playing into an open mic,
    // then reset dedup state for the post-reconnect turn and stop subtitles.
    playerRef.current?.stop?.();
    playerRef.current?.resetForNewTurn?.();
    subtitles.stopPlayback();
    // Clear the 'thinking' state set by handleGlReconnecting (if no audio follows,
    // it would otherwise stick and gate the mic indefinitely). Safe now that the
    // player has been stopped above.
    setGlobalPlaybackState('idle');
    sessionConfigRef.current?.onGlReconnected?.();
  }, [subtitles]);

  /**
   * GL internal reconnect reset — fired when GL disconnects mid-turn (goAway→1007).
   * Cancels all scheduled AudioContext sources and resets dedup so the re-generated
   * response plays cleanly without double audio.
   */
  const handleGlAudioReset = useCallback((_message: { type: string; reason: string }) => {
    console.log('[StreamingVoice] gl_audio_reset received — stopping player and resetting for reconnect');
    // stop() cancels all scheduled AudioBufferSource nodes (prevents pre-reconnect audio replaying)
    playerRef.current?.stop?.();
    // resetForNewTurn() clears dedup sets so post-reconnect audio is accepted cleanly
    playerRef.current?.resetForNewTurn?.();
  }, []);

  /**
   * Proactive 4.5-minute WS cycle — fired before Replit's proxy kills the connection at 5min.
   * Logs a diagnostic event so we can distinguish intentional cycles from real drops.
   */
  const handleProactiveReconnect = useCallback((_message: { timestamp: number; state: string }) => {
    console.log('[StreamingVoice] Proactive WS cycle initiated — logging diagnostic event');
    diagEvent('proactive_reconnect', { state: _message.state });
  }, []);

  /**
   * Handle subtitle mode change from server (tutor [SUBTITLE on/off/target] command)
   */
  const handleSubtitleModeChange = useCallback((message: { type: string; mode: 'off' | 'target'; timestamp: number }) => {
    const { mode } = message;
    console.log('[StreamingVoice] Subtitle mode change from tutor:', mode);
    sessionConfigRef.current?.onSubtitleModeChange?.(mode);
  }, []);
  
  /**
   * Handle custom overlay from server (tutor [SHOW: text] / [HIDE] commands)
   */
  const handleCustomOverlay = useCallback((message: { type: string; action: 'show' | 'hide'; text?: string; timestamp: number }) => {
    const { action, text } = message;
    console.log('[StreamingVoice] Custom overlay from tutor:', action, text?.substring(0, 50));
    sessionConfigRef.current?.onCustomOverlay?.(action, text);
  }, []);
  
  /**
   * Handle text input request from server (tutor [TEXT_INPUT: prompt] command)
   */
  const handleTextInputRequest = useCallback((message: { type: string; prompt: string; timestamp: number }) => {
    const { prompt } = message;
    console.log('[StreamingVoice] Text input request from tutor:', prompt?.substring(0, 50));
    sessionConfigRef.current?.onTextInputRequest?.(prompt);
  }, []);

  const handleScenarioLoaded = useCallback((message: any) => {
    console.log('[StreamingVoice] Scenario loaded:', message.scenario?.title);
    // New scenario = fresh start; clear any lingering mission from a previous scene.
    import('@/lib/missionStore').then(({ setGlobalMission }) => setGlobalMission(null));
    sessionConfigRef.current?.onScenarioLoaded?.(message.scenario);
  }, []);

  const handleZoneAdvanced = useCallback((message: any) => {
    // Zone change = new scene context; clear mission so old objective doesn't ghost.
    // Daniela can re-set it immediately if the mission spans scenes.
    import('@/lib/missionStore').then(({ setGlobalMission }) => setGlobalMission(null));
    sessionConfigRef.current?.onSceneZoneAdvanced?.({
      zoneIndex: message.zoneIndex,
      zoneName: message.zoneName ?? null,
      imageUrl: message.imageUrl ?? null,
      isChain: message.isChain ?? false,
      nextScenarioSlug: message.nextScenarioSlug ?? null,
      isComplete: message.isComplete ?? false,
    });
  }, []);

  const handleScenarioEnded = useCallback((message: any) => {
    console.log('[StreamingVoice] Scenario ended:', message.scenarioSlug);
    sessionConfigRef.current?.onScenarioEnded?.({
      scenarioId: message.scenarioId,
      scenarioSlug: message.scenarioSlug,
      performanceNotes: message.performanceNotes,
    });
  }, []);

  const handlePropUpdate = useCallback((message: any) => {
    console.log('[StreamingVoice] Prop updated:', message.propTitle);
    sessionConfigRef.current?.onPropUpdate?.(message);
  }, []);

  const handleImmersiveMode = useCallback((message: any) => {
    console.log('[StreamingVoice] Immersive mode change:', message.active);
    sessionConfigRef.current?.onImmersiveModeChange?.(Boolean(message.active));
  }, []);

  const handleCharacterChange = useCallback((message: { type: string; character: { id: string; displayName: string; role: string; gender: 'male' | 'female' } | null }) => {
    setActiveCharacter(message.character);
  }, []);

  const handleIncognitoChanged = useCallback((message: { type: string; enabled: boolean; timestamp: number }) => {
    sessionConfigRef.current?.onIncognitoChanged?.(message.enabled);
  }, []);
  
  /**
   * Handle tutor handoff - triggered after current tutor says goodbye
   * Automatically switches voice to new tutor and triggers their introduction
   * Supports both intra-language (gender only) and cross-language (gender + language) handoffs
   * 
   * MIC LOCKOUT: During handoff, mic stays locked until new tutor starts speaking
   * to prevent user from accidentally interrupting the transition
   */
  const handleTutorHandoff = useCallback((message: { 
    type: string; 
    targetGender: 'male' | 'female'; 
    targetLanguage?: string;
    tutorName?: string;
    isLanguageSwitch: boolean;
    requiresGreeting?: boolean;
    isAssistant?: boolean;
    timestamp: number;
  }) => {
    const { targetGender, targetLanguage, tutorName, isLanguageSwitch, requiresGreeting, isAssistant } = message;
    
    if (isAssistant) {
      console.log(`[StreamingVoice] Assistant handoff to ${tutorName} (${targetGender}) - navigate to practice page`);
    } else if (isLanguageSwitch && targetLanguage) {
      console.log(`[StreamingVoice] Cross-language handoff to ${tutorName} (${targetGender}) in ${targetLanguage}`);
      // For cross-language handoffs, the server will skip intro generation
      // and the client will request greeting after reconnecting with new language
    } else {
      console.log(`[StreamingVoice] Tutor handoff to ${tutorName || targetGender} tutor`);
    }
    
    // MIC LOCKOUT: Lock mic during tutor switch
    // This prevents user from speaking during the transition
    console.log('[StreamingVoice] Tutor switching - locking mic');
    setIsSwitchingTutor(true);
    
    // Error recovery: If something goes wrong, unlock mic after 15 seconds
    // This ensures user isn't permanently locked out if the switch fails
    if (tutorSwitchTimeoutRef.current) {
      clearTimeout(tutorSwitchTimeoutRef.current);
    }
    tutorSwitchTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Tutor switch timeout - unlocking mic (error recovery)');
      setIsSwitchingTutor(false);
    }, 15000);  // 15 second timeout for error recovery
    
    // Notify parent component to update UI state (avatar, buttons)
    // Pass full handoff info for cross-language and assistant support
    sessionConfigRef.current?.onTutorHandoff?.({
      targetGender,
      targetLanguage,
      tutorName,
      isLanguageSwitch,
      requiresGreeting,
      isAssistant,
    });
    
    // Call updateVoice to complete the handoff workflow
    // For cross-language switches, server will skip intro generation (isLanguageSwitchHandoff flag)
    // but we still need to call this to complete the handoff gracefully
    // NOTE: For assistant switches, we don't update voice here - the parent will navigate away
    if (clientRef.current?.isReady() && !isAssistant) {
      clientRef.current.updateVoice(targetGender);
    }
  }, []);
  
  /**
   * Tracks which voice errors arrived so GL-disconnect retry state can be set.
   * Only GEMINI_LIVE_DISCONNECTED (non-recoverable, retries exhausted) arms the
   * one-tap retry prompt. Other error codes are left to their existing handlers.
   * Declared before connect() so connect()'s listener registration is not a forward reference.
   */
  const handleVoiceError = useCallback((event: { code: string; message: string; recoverable: boolean }) => {
    if (event.code === 'GEMINI_LIVE_DISCONNECTED' && !event.recoverable) {
      setGlDisconnectedForRetry(true);
    }
  }, []);

  /**
   * Connect to streaming voice service and start a session
   */
  const connect = useCallback(async (config: StreamingSessionConfig) => {
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Connecting for conversation ${config.conversationId}`);
    }
    
    // A fresh caller-owned session must not display the prior durable identity
    // while waiting for its session_started response.
    setVoiceSessionId(null);

    // Store config for callbacks (e.g., onResponseComplete)
    sessionConfigRef.current = config;
    
    // Update difficulty level for ACTFL-aware subtitle timing
    setDifficultyLevel(config.difficultyLevel);

    // Pre-warm micro-ack clips in the background — fire-and-forget
    preWarmMicroAcks(config.targetLanguage, config.tutorGender || 'female');
    
    // CRITICAL: Pre-warm AudioContext in user gesture context
    // This MUST happen during the click handler, not later when audio chunks arrive
    // Otherwise browsers will block audio playback due to autoplay policy
    try {
      const player = getStreamingAudioPlayer();
      await player.resumeAudioContext();
      const ctxState = player.getAudioContextState();
      console.log(`[StreamingVoice] AudioContext pre-warmed during user gesture → ${ctxState}`);
      if (ctxState !== 'running') {
        console.warn(`[StreamingVoice] AudioContext NOT running after pre-warm (${ctxState}) — playback may fail`);
      }
    } catch (warmErr) {
      console.warn('[StreamingVoice] Failed to pre-warm AudioContext:', warmErr);
    }
    
    try {
      // Get or create client
      clientRef.current = getStreamingVoiceClient();
      
      // Set up callbacks
      clientRef.current.on('stateChange', (state) => {
        connectionStateRef.current = state;
        setConnectionState(state);
        if (state === 'disconnected') {
          setVoiceSessionId(null);
        }

        // Keep the lockout-diagnostics connectionStatus in sync so snapshots
        // show the real WS state instead of the stale initial 'disconnected'.
        const diagStatus = (
          state === 'connected' || state === 'ready' || state === 'processing' ? 'connected' :
          state === 'streaming'    ? 'streaming'   :
          state === 'connecting'   ? 'connecting'  :
          state === 'reconnecting' ? 'reconnecting' :
          state === 'error'        ? 'error'        :
          'disconnected'
        ) as 'disconnected' | 'connecting' | 'connected' | 'streaming' | 'reconnecting' | 'error';
        updateDebugTimingState({ connectionStatus: diagStatus });

        // Fast recovery: if WS drops while we're waiting for audio that will never
        // arrive (response_complete received but TTS chunks were in-flight over the
        // now-dead socket), don't make the user wait 45s. Clear in 8s instead.
        if ((state === 'reconnecting' || state === 'disconnected') &&
            isProcessingRef.current &&
            responseCompleteRef.current &&
            !audioReceivedInTurnRef.current) {
          const thisTurn = turnCounterRef.current;
          console.log('[StreamingVoice] WS dropped while waiting for audio — scheduling 8s fast recovery');
          setTimeout(() => {
            if (turnCounterRef.current !== thisTurn) return;
            if (!isProcessingRef.current) return;
            console.log('[StreamingVoice] Fast recovery: clearing stuck processing state after WS drop');
            pendingAudioCountRef.current = 0;
            audioReceivedInTurnRef.current = false;
            setIsProcessingRef.current(false);
            setGlobalPlaybackState('idle');
          }, 8000);
        }
        
        // Animation desync fix: if WS drops while audio is actively playing/buffering,
        // the avatar can get stuck showing the "speaking/hand-up" state because no more
        // audio chunks will arrive but the player state stays non-idle.
        // Schedule a fast check: if the player hasn't naturally drained within 4s of the
        // WS drop, force-clear the playback state so the avatar returns to idle.
        if ((state === 'reconnecting' || state === 'disconnected') &&
            (getGlobalPlaybackState() === 'playing' || getGlobalPlaybackState() === 'buffering')) {
          const thisTurn = turnCounterRef.current;
          const capturedPlaybackStateAtDrop = getGlobalPlaybackState();
          console.log(`[StreamingVoice] WS dropped during active audio (${capturedPlaybackStateAtDrop}) — scheduling 4s avatar-desync guard`);
          setTimeout(() => {
            if (turnCounterRef.current !== thisTurn) return;
            const currentPlayback = getGlobalPlaybackState();
            if (currentPlayback === 'playing' || currentPlayback === 'buffering') {
              console.log(`[StreamingVoice] Avatar-desync guard: playback still ${currentPlayback} 4s after WS drop — forcing idle to restore avatar`);
              setGlobalPlaybackState('idle');
              playerRef.current?.stop?.();
            }
          }, 4000);
        }
      });
      clientRef.current.on('sessionStart', handleSessionStart);
      clientRef.current.on('greetingRetry', handleGreetingRetry);  // Server auto-retrying silent greeting
      clientRef.current.on('processing', handleProcessing);
      clientRef.current.on('processing_pending', handleProcessingPending);  // Immediate thinking signal
      clientRef.current.on('functionExecuting', handleFunctionExecuting);   // Tool call in progress — refresh thinking
      clientRef.current.on('sentenceStart', handleSentenceStart);
      clientRef.current.on('expectedSentenceCount', handleExpectedSentenceCount);
      clientRef.current.on('sentenceReady', handleSentenceReady);  // NEW: Atomic first audio + timing
      clientRef.current.on('audioChunk', handleAudioChunk);
      clientRef.current.on('wordTiming', handleWordTiming);
      clientRef.current.on('wordTimingDelta', handleWordTimingDelta);  // Progressive streaming
      clientRef.current.on('wordTimingFinal', handleWordTimingFinal);  // Progressive streaming
      clientRef.current.on('responseComplete', handleResponseComplete);
      clientRef.current.on('whiteboardUpdate', handleWhiteboardUpdate);  // Enriched whiteboard items
      clientRef.current.on('lessonNoteAdded', handleLessonNoteAdded);  // Session lesson notes
      clientRef.current.on('pronunciationScoreShown', handlePronunciationScoreShown);
      clientRef.current.on('grammarFlagShown', handleGrammarFlagShown);
      clientRef.current.on('quizPresented', handleQuizPresented);
      clientRef.current.on('culturalContextShown', handleCulturalContextShown);
      clientRef.current.on('spotlightShown', handleSpotlightShown);
      clientRef.current.on('missionSet', handleMissionSet);  // Gap D: shared session mission badge
      clientRef.current.on('sofiaSupportMessage', handleSofiaSupportMessage);  // Sofia student support
      clientRef.current.on('sofiaAllClear', handleSofiaAllClear);  // Sofia incident resolved
      clientRef.current.on('pronunciationCoaching', handlePronunciationCoaching);  // Live pronunciation feedback
      clientRef.current.on('error', handleError);
      clientRef.current.on('ttsError', handleTtsError);
      clientRef.current.on('sttDegraded', handleSttDegraded);
      clientRef.current.on('noSpeechDetected', handleNoSpeechDetected);  // Empty PTT reset
      clientRef.current.on('vadSpeechStarted', handleVadSpeechStarted);  // Open mic VAD
      clientRef.current.on('vadUtteranceEnd', handleVadUtteranceEnd);  // Open mic VAD
      clientRef.current.on('interimTranscript', handleInterimTranscript);  // Open mic interim
      clientRef.current.on('openMicSessionClosed', handleOpenMicSessionClosed);  // Open mic session ended
      clientRef.current.on('openMicSilenceLoop', handleOpenMicSilenceLoop);  // Open mic silence loop detection
      clientRef.current.on('transcript', handleTranscript);  // Gemini Live final user transcript
      clientRef.current.on('danielaTranscript', handleDanielaTranscript);  // Gemini Live Daniela transcript
      clientRef.current.on('voiceError', handleVoiceError);  // GL exhausted retries or non-retriable error
      clientRef.current.on('reconnected', handleReconnected);  // Successful reconnection after drop
      clientRef.current.on('glReconnecting', handleGlReconnecting);  // GL 1008 reconnect — context bridge loading
      clientRef.current.on('glReconnected', handleGlReconnected);  // GL 1008 reconnect succeeded — resume without reload
      clientRef.current.on('glAudioReset', handleGlAudioReset);  // GL mid-turn reconnect — clear audio buffer
      clientRef.current.on('proactive_reconnect', handleProactiveReconnect);  // Intentional 4.5-min WS cycle
      clientRef.current.on('tutorHandoff', handleTutorHandoff);  // Voice-initiated tutor switch
      clientRef.current.on('subtitleModeChange', handleSubtitleModeChange);  // Server subtitle mode command
      clientRef.current.on('customOverlay', handleCustomOverlay);  // Server custom overlay command
      clientRef.current.on('textInputRequest', handleTextInputRequest);  // Server text input request
      clientRef.current.on('scenarioLoaded', handleScenarioLoaded);
      clientRef.current.on('scenarioEnded', handleScenarioEnded);
      clientRef.current.on('zoneAdvanced', handleZoneAdvanced);
      clientRef.current.on('propUpdate', handlePropUpdate);
      clientRef.current.on('immersiveMode', handleImmersiveMode);
      clientRef.current.on('characterChange', handleCharacterChange);
      clientRef.current.on('incognitoChanged', handleIncognitoChanged);
      clientRef.current.on('idleTimeout', handleIdleTimeout);
      clientRef.current.on('creditWarning', handleCreditWarning);
      clientRef.current.on('sessionConflict', handleSessionConflict);
      clientRef.current.on('server_restarting', () => {
        console.log('[StreamingVoice] server_restarting event — showing update banner');
        setServerRestarting(true);
      });
      
      // Keep screen alive on mobile during voice session
      acquireWakeLock();

      // Connect WebSocket
      await clientRef.current.connect(config.conversationId);
      if (isVerboseLoggingEnabled()) {
        console.log('[StreamingVoice] WebSocket connected, starting session...');
      }
      
      diagSetSession({
        conversationId: config.conversationId,
        userId: null,
        language: config.targetLanguage,
        inputMode: config.inputMode,
      });
      diagSetHookRefs({
        isProcessingFn: () => isProcessingRef.current,
        pendingAudioCountFn: () => pendingAudioCountRef.current,
        audioReceivedInTurnFn: () => audioReceivedInTurnRef.current,
        responseCompleteFn: () => responseCompleteRef.current,
        isSwitchingTutorFn: () => isSwitchingTutorRef.current,
      });
      diagMarkConnect();
      // Store timer ID so we can clean it up on disconnect
      greetingAudioArrivedRef.current = false;  // reset on each new connection
      if (greetingSilenceWatchdogRef.current) {
        clearTimeout(greetingSilenceWatchdogRef.current);
      }
      greetingSilenceWatchdogRef.current = startGreetingSilenceWatchdog();
      
      (await import('@/lib/consoleCapture')).startSessionCapture({
        conversationId: config.conversationId,
        tutorGender: config.tutorGender,
        language: config.targetLanguage,
        difficulty: config.difficultyLevel,
      });
      
      // Start session with config - this triggers server to send 'connected' message
      // which will transition state to 'ready'
      clientRef.current.startSession({
        conversationId: config.conversationId,
        targetLanguage: config.targetLanguage,
        nativeLanguage: config.nativeLanguage,
        difficultyLevel: config.difficultyLevel,
        subtitleMode: config.subtitleMode,
        tutorPersonality: config.tutorPersonality,
        tutorExpressiveness: config.tutorExpressiveness,
        tutorGender: config.tutorGender,
        voiceSpeed: config.voiceSpeed,
        rawHonestyMode: config.rawHonestyMode,  // Minimal prompting mode
        founderMode: config.founderMode,  // Explicit founder mode flag
      });
      
      if (isVerboseLoggingEnabled()) {
        console.log('[StreamingVoice] Session started, waiting for ready state...');
      }
      
    } catch (err: any) {
      console.error('[StreamingVoice] Connection failed:', err);
      releaseWakeLock();
      setError(err.message);
      throw err;
    }
  }, [handleSessionStart, handleProcessing, handleProcessingPending, handleNoSpeechDetected, handleSentenceStart, handleExpectedSentenceCount, handleSentenceReady, handleAudioChunk, handleWordTiming, handleWordTimingDelta, handleWordTimingFinal, handleResponseComplete, handleWhiteboardUpdate, handleLessonNoteAdded, handlePronunciationCoaching, handleError, handleIdleTimeout, handleCreditWarning, handleSessionConflict, handleVadSpeechStarted, handleVadUtteranceEnd, handleInterimTranscript, handleOpenMicSilenceLoop, handleTranscript, handleDanielaTranscript, handleReconnected, handleGlReconnecting, handleGlReconnected, handleGlAudioReset, handleSubtitleModeChange, handleCustomOverlay, handleTextInputRequest, handleScenarioLoaded, handleScenarioEnded, handleZoneAdvanced, handlePropUpdate, handleImmersiveMode, handleCharacterChange, handleIncognitoChanged, handlePronunciationScoreShown, handleGrammarFlagShown, handleQuizPresented, handleCulturalContextShown, handleSpotlightShown]);
  
  /**
   * Disconnect from streaming voice service
   */
  const disconnect = useCallback(() => {
    diagMarkDisconnect('user_disconnect');
    releaseWakeLock();
    import('@/lib/consoleCapture').then(m => m.endSessionCapture()).catch(() => {});
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] Disconnecting');
    }
    
    if (clientRef.current) {
      clientRef.current.off('stateChange', setConnectionState);
      clientRef.current.off('sessionStart', handleSessionStart);
      clientRef.current.off('greetingRetry', handleGreetingRetry);  // Server auto-retrying silent greeting
      clientRef.current.off('processing', handleProcessing);
      clientRef.current.off('processing_pending', handleProcessingPending);  // Immediate thinking signal
      clientRef.current.off('sentenceStart', handleSentenceStart);
      clientRef.current.off('expectedSentenceCount', handleExpectedSentenceCount);
      clientRef.current.off('sentenceReady', handleSentenceReady);  // NEW: Atomic first audio + timing
      clientRef.current.off('audioChunk', handleAudioChunk);
      clientRef.current.off('wordTiming', handleWordTiming);
      clientRef.current.off('wordTimingDelta', handleWordTimingDelta);  // Progressive streaming
      clientRef.current.off('wordTimingFinal', handleWordTimingFinal);  // Progressive streaming
      clientRef.current.off('responseComplete', handleResponseComplete);
      clientRef.current.off('whiteboardUpdate', handleWhiteboardUpdate);  // Enriched whiteboard items
      clientRef.current.off('lessonNoteAdded', handleLessonNoteAdded);  // Session lesson notes
      clientRef.current.off('pronunciationScoreShown', handlePronunciationScoreShown);
      clientRef.current.off('grammarFlagShown', handleGrammarFlagShown);
      clientRef.current.off('quizPresented', handleQuizPresented);
      clientRef.current.off('culturalContextShown', handleCulturalContextShown);
      clientRef.current.off('spotlightShown', handleSpotlightShown);
      clientRef.current.off('missionSet', handleMissionSet);  // Gap D
      clientRef.current.off('sofiaSupportMessage', handleSofiaSupportMessage);
      clientRef.current.off('sofiaAllClear', handleSofiaAllClear);
      clientRef.current.off('pronunciationCoaching', handlePronunciationCoaching);  // Live pronunciation feedback
      clientRef.current.off('error', handleError);
      clientRef.current.off('noSpeechDetected', handleNoSpeechDetected);  // Empty PTT reset
      clientRef.current.off('vadSpeechStarted', handleVadSpeechStarted);  // Open mic VAD
      clientRef.current.off('vadUtteranceEnd', handleVadUtteranceEnd);  // Open mic VAD
      clientRef.current.off('interimTranscript', handleInterimTranscript);  // Open mic interim
      clientRef.current.off('openMicSilenceLoop', handleOpenMicSilenceLoop);  // Open mic silence loop
      clientRef.current.off('transcript', handleTranscript);  // Gemini Live final user transcript
      clientRef.current.off('danielaTranscript', handleDanielaTranscript);  // Gemini Live Daniela transcript
      clientRef.current.off('voiceError', handleVoiceError);  // GL exhausted retries or non-retriable error
      clientRef.current.off('reconnected', handleReconnected);  // Successful reconnection
      clientRef.current.off('glReconnecting', handleGlReconnecting);  // GL 1008 context bridge
      clientRef.current.off('glReconnected', handleGlReconnected);  // GL 1008 reconnect succeeded
      clientRef.current.off('glAudioReset', handleGlAudioReset);  // GL mid-turn reconnect
      clientRef.current.off('proactive_reconnect', handleProactiveReconnect);  // Intentional 4.5-min WS cycle
      clientRef.current.off('subtitleModeChange', handleSubtitleModeChange);  // Server subtitle mode command
      clientRef.current.off('customOverlay', handleCustomOverlay);  // Server custom overlay command
      clientRef.current.off('textInputRequest', handleTextInputRequest);  // Server text input request
      clientRef.current.off('scenarioLoaded', handleScenarioLoaded);
      clientRef.current.off('scenarioEnded', handleScenarioEnded);
      clientRef.current.off('zoneAdvanced', handleZoneAdvanced);
      clientRef.current.off('propUpdate', handlePropUpdate);
      clientRef.current.off('immersiveMode', handleImmersiveMode);
      clientRef.current.off('characterChange', handleCharacterChange);
      clientRef.current.off('incognitoChanged', handleIncognitoChanged);
      clientRef.current.off('idleTimeout', handleIdleTimeout);
      clientRef.current.off('creditWarning', handleCreditWarning);
      clientRef.current.off('sessionConflict', handleSessionConflict);
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    
    // Stop playback
    playerRef.current?.stop();
    subtitles.reset();
    // Bug 6 fix: clear any custom overlay text from the previous session so Japanese/foreign
    // text doesn't persist into a new session (e.g. [SHOW: そうですね] never followed by [HIDE]).
    sessionConfigRef.current?.onCustomOverlay?.('hide', undefined);
    
    // Reset state
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    setConnectionState('disconnected');
    setVoiceSessionId(null);
    setIsProcessing(false);
    setError(null);
    
    // Clear processing timeout (prevents stale timeout from old session firing after reconnect)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    
    // Clear tutor switch state and timeout
    if (tutorSwitchTimeoutRef.current) {
      clearTimeout(tutorSwitchTimeoutRef.current);
      tutorSwitchTimeoutRef.current = null;
    }
    setIsSwitchingTutor(false);
  }, [handleProcessing, handleSentenceStart, handleSentenceReady, handleAudioChunk, handleWordTiming, handleWordTimingDelta, handleWordTimingFinal, handleResponseComplete, handleWhiteboardUpdate, handleLessonNoteAdded, handlePronunciationCoaching, handleError, handleVadSpeechStarted, handleVadUtteranceEnd, handleInterimTranscript, handleOpenMicSilenceLoop, handleTranscript, handleDanielaTranscript, handleReconnected, handleGlReconnecting, handleGlReconnected, handleGlAudioReset, handleSubtitleModeChange, handleCustomOverlay, handleTextInputRequest, handleIncognitoChanged, handlePronunciationScoreShown, handleGrammarFlagShown, handleQuizPresented, handleCulturalContextShown, handleSpotlightShown, subtitles]);
  
  /**
   * Send audio for processing
   */
  const sendAudio = useCallback(async (audioData: ArrayBuffer) => {
    // Check client's actual state, not React state (avoid stale closure)
    const actualState = clientRef.current?.getState();
    if (!clientRef.current || !clientRef.current.isReady()) {
      console.error('[StreamingVoice] Cannot send audio - not ready. Client state:', actualState);
      throw new Error('Not connected to streaming voice service');
    }
    
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Sending ${audioData.byteLength} bytes of audio`);
    }
    
    // Reset state for new request
    diagMarkTurnStart();
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    setIsProcessing(true);
    setError(null);
    subtitles.reset();
    
    // Start processing timeout (stuck thinking recovery)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Processing timeout (sendAudio) - resetting stuck thinking state + playback');
      setIsProcessing(false);
      setError('Response timeout - please try again');
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, PROCESSING_TIMEOUT_MS);
    
    // Clear stored audio from previous response before new request
    playerRef.current?.clearStoredAudio();
    
    await clientRef.current.sendAudio(audioData);
  }, [connectionState, subtitles]);
  
  /**
   * Get combined audio blob for replay
   */
  const getCombinedAudioBlob = useCallback((): Blob | null => {
    return playerRef.current?.getCombinedAudioBlob() ?? null;
  }, []);
  
  /**
   * Clear stored audio for replay
   */
  const clearStoredAudio = useCallback(() => {
    playerRef.current?.clearStoredAudio();
  }, []);
  
  /**
   * Send streaming audio chunk for open mic mode
   */
  const sendStreamingChunk = useCallback((audioData: ArrayBuffer, sequenceId: number): boolean => {
    return clientRef.current?.sendStreamingChunk(audioData, sequenceId) ?? false;
  }, []);
  
  /**
   * Stop streaming audio (open mic mode)
   */
  const stopStreaming = useCallback(() => {
    clientRef.current?.stopStreaming();
  }, []);
  
  /**
   * Set input mode (push-to-talk or open-mic)
   */
  const setInputMode = useCallback((mode: 'push-to-talk' | 'open-mic') => {
    clientRef.current?.setInputMode(mode);
  }, []);
  
  /**
   * Send interrupt signal (user started speaking - stop TTS)
   */
  const sendInterrupt = useCallback(() => {
    clientRef.current?.sendInterrupt();
  }, []);
  
  /**
   * Send user activity signal to prevent idle timeout
   * Called when user starts recording (push-to-talk button pressed)
   * This prevents session timeout while user is actively recording
   * Also holds audio playback to prevent AI speaking while user records
   */
  const sendUserActivity = useCallback(() => {
    // Hold audio playback while user is recording
    // This prevents AI from speaking while user is still holding PTT
    playerRef.current?.holdPlayback();
    clientRef.current?.sendUserActivity();
  }, []);
  
  /**
   * Send PTT release signal to finalize speculative transcript
   * Called when user releases the push-to-talk button
   * Also releases audio playback to start playing buffered audio
   */
  const sendPttRelease = useCallback(() => {
    // Mark speech end for E2E latency tracking (speech_end → first_audio)
    diagMarkSpeechEnd('ptt');
    // Release audio playback - any buffered audio will now play
    playerRef.current?.releasePlayback();
    clientRef.current?.sendPttRelease();
    // Fire micro-ack immediately — transcript not available yet, so use empty string
    // (defaults to affirmative pool in selectMicroAck)
    fireMicroAck('');
  }, []);

  const sendToggleIncognito = useCallback((enabled: boolean) => {
    clientRef.current?.sendToggleIncognito(enabled);
  }, []);
  
  /**
   * Request AI-generated personalized greeting
   * Called when starting a new conversation or resuming a previous one
   * @param userName - Optional student name for personalization
   * @param isResumed - True if resuming a previous conversation (triggers context-aware welcome back)
   */
  const requestGreeting = useCallback((userName?: string, isResumed?: boolean, scenarioSlug?: string) => {
    if (!clientRef.current || !clientRef.current.isReady()) {
      console.error('[StreamingVoice] Cannot request greeting - not ready');
      return;
    }
    
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Requesting AI greeting... (resumed: ${isResumed || false}, scenario: ${scenarioSlug || 'none'})`);
    }
    
    // Reset state for greeting
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    setIsProcessing(true);
    setError(null);
    subtitles.reset();
    
    // Start processing timeout (stuck thinking recovery for greetings too)
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
    }
    processingTimeoutRef.current = setTimeout(() => {
      console.log('[StreamingVoice] Greeting timeout - resetting stuck thinking state + playback');
      setIsProcessing(false);
      setError('Response timeout - please try again');
      setGlobalPlaybackState('idle');
      playerRef.current?.stop?.();
    }, PROCESSING_TIMEOUT_MS);
    
    // Clear stored audio
    playerRef.current?.clearStoredAudio();
    
    // Request greeting from server (forward scenarioSlug so server can inject load_scenario prompt)
    clientRef.current.requestGreeting(userName, isResumed, scenarioSlug);
  }, [subtitles]);
  
  /**
   * Update voice mid-session (when user changes tutor)
   */
  const updateVoice = useCallback((tutorGender: 'male' | 'female') => {
    if (!clientRef.current || !clientRef.current.isReady()) {
      console.warn('[StreamingVoice] Cannot update voice - not connected');
      return;
    }
    
    if (isVerboseLoggingEnabled()) {
      console.log(`[StreamingVoice] Updating voice to ${tutorGender}`);
    }
    clientRef.current.updateVoice(tutorGender);
  }, []);
  
  /**
   * Stop playback and processing
   */
  const stop = useCallback(() => {
    if (isVerboseLoggingEnabled()) {
      console.log('[StreamingVoice] Stopping');
    }
    
    playerRef.current?.stop();
    subtitles.stopPlayback();
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    setIsProcessing(false);
  }, [subtitles]);
  
  /**
   * Check if streaming is supported
   */
  const isSupported = useCallback(() => {
    return 'WebSocket' in window;
  }, []);
  
  /**
   * Check if client is ready to send audio (checks actual client state, not React state)
   */
  const isReady = useCallback(() => {
    return clientRef.current?.isReady() ?? false;
  }, []);
  
  /**
   * Send drill result for pedagogical tracking
   */
  const sendDrillResult = useCallback((drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string) => {
    if (clientRef.current) {
      clientRef.current.sendDrillResult(drillId, drillType, isCorrect, responseTimeMs, toolContent);
    }
  }, []);
  
  /**
   * Send text input response (from TEXT_INPUT whiteboard tool)
   */
  const sendTextInput = useCallback((itemId: string, response: string) => {
    if (clientRef.current) {
      clientRef.current.sendTextInput(itemId, response);
    }
  }, []);
  
  /**
   * Send voice override settings (Voice Lab - admin only)
   * These session-level overrides apply to the next TTS call
   */
  const sendVoiceOverride = useCallback((override: {
    speakingRate?: number;
    personality?: string;
    expressiveness?: number;
    emotion?: string;
    geminiLanguageCode?: string;
  } | null) => {
    if (clientRef.current) {
      clientRef.current.sendVoiceOverride(override);
    }
  }, []);
  
  const sendVideoFrame = useCallback((base64Jpeg: string, source: string) => {
    if (clientRef.current) {
      (clientRef.current as any).sendVideoFrame(base64Jpeg, source);
    }
  }, []);

  const retryGlSession = useCallback(() => {
    setGlDisconnectedForRetry(false);
    clientRef.current?.retryGlSession();
  }, []);

  const forceResetProcessing = useCallback(() => {
    console.warn('[StreamingVoice] forceResetProcessing called — clearing all audio and processing state');
    setIsProcessing(false);
    setError(null);
    setGlobalPlaybackState('idle');
    playerRef.current?.stop?.();
    responseCompleteRef.current = false;
    pendingAudioCountRef.current = 0;
    audioReceivedInTurnRef.current = false;
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
  }, []);

  // Store disconnect in a ref so cleanup can use latest version without dependency
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;
  
  // Send prop_tap signal to server whenever the student taps a scene prop
  useEffect(() => {
    if (!activePropTap || activePropTap.timestamp === prevPropTapTimestampRef.current) return;
    prevPropTapTimestampRef.current = activePropTap.timestamp;
    clientRef.current?.sendPropTap(activePropTap);
  }, [activePropTap]);

  useEffect(() => {
    return () => {
      disconnectRef.current();
    };
  }, []);
  
  return {
    state: {
      connectionState,
      voiceSessionId,
      playbackState,
      isConnecting: connectionState === 'connecting' || connectionState === 'reconnecting',
      isProcessing,
      isPlaying: playbackState === 'playing',
      isSwitchingTutor,  // Mic lockout during tutor handoff
      sofiaIncident,    // Active Sofia support incident (null = no active incident)
      ttsUnavailable,    // True when TTS fails; clears after 8s
      sttDegraded,       // True when Deepgram STT has an error; clears after 6s
      sttDegradedMessage, // User-facing message for STT degraded state
      sttSuggestPtt,     // True when repeated open-mic failures suggest switching to PTT
      currentText: subtitles.state.fullText,
      currentWordIndex: subtitles.state.currentWordIndex,
      activeCharacter,   // Currently speaking secondary character (null = Daniela)
      visibleWordCount: subtitles.state.visibleWordCount,
      error,
      metrics,
      serverRestarting,
      glDisconnectedForRetry,
    },
    subtitles,
    connect,
    disconnect,
    sendAudio,
    requestGreeting,
    updateVoice,
    stop,
    isSupported,
    isReady,
    getCombinedAudioBlob,
    clearStoredAudio,
    sendStreamingChunk,
    stopStreaming,
    setInputMode,
    sendInterrupt,
    sendUserActivity,
    sendPttRelease,
    sendToggleIncognito,
    sendDrillResult,
    sendTextInput,
    sendVoiceOverride,
    sendVideoFrame,
    forceResetProcessing,
    retryGlSession,
    microAckPlaying,
  };
}
