/**
 * StreamingVoiceChat - WebSocket-based streaming voice chat
 * 
 * This component uses STREAMING ONLY mode:
 * - Deepgram Nova-3 STT → Gemini 2.5 Flash → Cartesia Sonic-3 TTS
 * - Progressive audio delivery via WebSocket
 * - Target: <1s TTFB (Time To First Byte)
 * 
 * REST FALLBACK CODE IS PRESERVED BUT NEVER EXECUTED
 * The REST code below (starting around line 1020) is kept as emergency backup
 * but is protected by STREAMING_ONLY_MODE = true which prevents it from running.
 * DO NOT set STREAMING_ONLY_MODE to false without extensive testing.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, Loader2, EyeOff, VolumeX, Flag, BookOpen, X, Download, Globe, Sparkles, Camera, Monitor } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { type Message, type User } from "@shared/schema";
import { processVoiceMessage, synthesizeSpeech, requestSlowRepeat, type WordTiming } from "@/lib/restVoiceApi";
import { getStreamingAudioPlayer } from "@/lib/audioUtils";
import { InstructorAvatar, type AvatarState } from "@/components/InstructorAvatar";
import { CompactDifficultyControl } from "@/components/CompactDifficultyControl";
import { LanguageSelector } from "@/components/LanguageSelector";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { VoiceChatViewManager } from "@/components/VoiceChatViewManager";
import { useStreamingVoice } from "@/hooks/useStreamingVoice";
import { useVisionCapture } from "@/hooks/useVisionCapture";
import { visionSessionPhase } from "@/lib/vision-session-state";
import { usePlaybackState, getGlobalPlaybackState, setGlobalPlaybackState } from "@/lib/playbackStateStore";
import { useUser } from "@/lib/auth";
import { useLearningFilter } from "@/contexts/LearningFilterContext";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useWhiteboard } from "@/hooks/useWhiteboard";
import { VoiceInputContext } from "@/contexts/VoiceInputContext";
import { useDanielaSession } from "@/contexts/DanielaSessionContext";
import { deriveVoiceStatus } from "@/lib/voice-widget-state";
import { setGlobalVoiceInput } from "@/lib/voiceInputStore";
import { getTutorNames } from "@/lib/tutor-avatars";
import { SupportAssistModal } from "@/components/SupportAssistModal";
import { setRemediationCallback } from "@/lib/lockoutDiagnostics";
import { getStreamingVoiceClient } from "@/lib/streamingVoiceClient";
import type { VoiceInputMode, OpenMicState } from "@shared/streaming-voice-types";
import type { VoiceOverride } from "./VoiceLabPanel";
import type { LessonNote } from "@shared/whiteboard-types";
import { SofiaWidget } from "@/components/SophiaWidget";
import { isSpotlightMessageValid } from "@/lib/spotlight-guard";
import { validateCulturalContextPayload } from "@/lib/cultural-context-guard";

// ============================================================================
// STREAMING MODE CONFIGURATION
// ============================================================================
// STREAMING_ONLY_MODE = true means REST code is NEVER executed
// This is the production setting - do not change without extensive testing
// ============================================================================
const ENABLE_STREAMING_MODE = true;
const STREAMING_ONLY_MODE = true; // CRITICAL: Never fall back to REST

// Helper to prevent double-greetings on mobile app reloads
// Tracks WHEN last greeting played AND which message ID was synthesized
const GREETING_TIMESTAMP_KEY = 'linguaflow_last_greeting_time';
const GREETING_MESSAGE_KEY = 'linguaflow_last_greeting_message';
const GREETING_COOLDOWN_MS = 5000; // 5 seconds - prevent double-greeting on mount, but allow reconnections

// Module-level lock to prevent race conditions when multiple components mount simultaneously
// This uses a compare-and-swap pattern: check and set atomically
let greetingInProgress = false;
let synthesizedMessageId: string | null = null; // Track which message was already synthesized

// Atomically try to acquire the greeting lock
// Returns true if lock acquired, false if already locked
function tryAcquireGreetingLock(messageId: string): boolean {
  // Check if we already synthesized this specific message
  // This persists across React remounts
  if (synthesizedMessageId === messageId) {
    console.log('[VOICE GREETING] Already synthesized message:', messageId);
    return false;
  }
  
  // Also check sessionStorage for persistence across HMR
  try {
    const storedMessageId = sessionStorage.getItem(GREETING_MESSAGE_KEY);
    if (storedMessageId === messageId) {
      console.log('[VOICE GREETING] Already synthesized (from storage):', messageId);
      return false;
    }
  } catch {
    // Ignore storage errors
  }
  
  // Fast synchronous lock check - prevents race conditions on double-mount
  if (greetingInProgress) {
    console.log('[VOICE GREETING] Already in progress (sync lock)');
    return false;
  }
  
  // Check cooldown timer
  try {
    const stored = sessionStorage.getItem(GREETING_TIMESTAMP_KEY);
    if (stored) {
      const lastTime = parseInt(stored, 10);
      const elapsed = Date.now() - lastTime;
      if (elapsed < GREETING_COOLDOWN_MS) {
        console.log('[VOICE GREETING] Cooldown active - last greeting was', Math.round(elapsed / 1000), 'seconds ago');
        return false;
      }
    }
  } catch {
    // Ignore storage errors
  }
  
  // ATOMICALLY acquire lock, set message ID, and set timestamp together
  greetingInProgress = true;
  synthesizedMessageId = messageId;
  try {
    sessionStorage.setItem(GREETING_TIMESTAMP_KEY, Date.now().toString());
    sessionStorage.setItem(GREETING_MESSAGE_KEY, messageId);
  } catch {
    // Ignore storage errors
  }
  
  console.log('[VOICE GREETING] Lock acquired for message:', messageId);
  return true;
}

function clearGreetingLock(): void {
  greetingInProgress = false;
  synthesizedMessageId = null;
  try {
    sessionStorage.removeItem(GREETING_MESSAGE_KEY);
    sessionStorage.removeItem(GREETING_TIMESTAMP_KEY);
  } catch {
  }
}

interface StreamingVoiceChatProps {
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  setCurrentConversationOnboarding: (isOnboarding: boolean | null) => void;
  isResumedConversation?: boolean;
  onResumeHandled?: () => void;
  onLanguageHandoff?: (tutorName: string, targetLanguage: string) => void;
  onLanguageHandoffComplete?: () => void;
  isExhausted?: boolean;
  onInsufficientCredits?: () => void;
  onWhiteboardItemsChange?: (items: import("@shared/whiteboard-types").WhiteboardItem[]) => void;
  whiteboardCallbacksRef?: React.MutableRefObject<{
    clear: () => void;
    drillComplete: (drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string) => void;
    textInputSubmit: (itemId: string, response: string) => void;
  } | null>;
  useDesktopWhiteboard?: boolean;
  onScenarioLoaded?: (scenario: any) => void;
  onScenarioEnded?: (data: { scenarioId?: string; scenarioSlug?: string; performanceNotes?: string }) => void;
  onPropUpdate?: (data: { propTitle: string; updates: Array<{ label: string; value: string }>; updatedFields: Array<{ label: string; value: string }> }) => void;
  onStudioImage?: (image: { word: string; description: string; imageUrl: string; context?: string; slot?: string; category?: string }) => void;
  onImmersiveModeChange?: (active: boolean) => void;
  onSceneZoneAdvanced?: (data: { zoneIndex: number; zoneName: string | null; imageUrl: string | null; isChain?: boolean; nextScenarioSlug?: string | null; isComplete?: boolean }) => void;
  /** Override the language sent to the server without touching the user's stored language preference.
   *  Use this for subject pages (biology, history) so their subject identifier reaches the WS handler
   *  but does NOT bleed into the user's learning-language context. */
  targetLanguageOverride?: string;
  /** Route to navigate to when an unrecoverable error occurs. Defaults to '/chat'. */
  homeRoute?: string;
  /** Background image URL to render behind Daniela's avatar (center backdrop / broadcast mode). */
  backdropImageUrl?: string;
}

export function StreamingVoiceChat({ 
  conversationId, 
  setConversationId, 
  setCurrentConversationOnboarding,
  isResumedConversation,
  onResumeHandled,
  onLanguageHandoff,
  onLanguageHandoffComplete,
  isExhausted,
  onInsufficientCredits,
  onWhiteboardItemsChange,
  whiteboardCallbacksRef,
  useDesktopWhiteboard = false,
  onScenarioLoaded,
  onScenarioEnded,
  onPropUpdate,
  onStudioImage,
  onImmersiveModeChange,
  onSceneZoneAdvanced,
  targetLanguageOverride,
  homeRoute = '/chat',
  backdropImageUrl,
}: StreamingVoiceChatProps) {
  const [, navigate] = useLocation();
  const { language, difficulty, setLanguage, subtitleMode, setSubtitleMode, tutorGender, voiceSpeed, setTutorGender, setVoiceSpeed } = useLanguage();
  const { isDeveloper, isAdmin, user } = useUser();
  const { learningContext, isHonestyMode } = useLearningFilter();
  const { toast } = useToast();
  
  // Check if we're in class mode
  const isInClassMode = learningContext !== "self-directed" && 
                        learningContext !== "all" && 
                        learningContext !== "all-classes" && 
                        learningContext !== "all-learning" &&
                        learningContext !== "founder-mode" &&
                        learningContext !== "honesty-mode";
  const classId = isInClassMode ? learningContext : null;
  
  // Developer tools mutations
  const reloadCreditsMutation = useMutation({
    mutationFn: async () => {
      if (!classId) throw new Error("No class selected");
      const res = await apiRequest("POST", "/api/developer/reload-credits", { 
        classId,
        hours: 120 
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/usage/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/student/classes"] });
      toast({
        title: "Credits Reloaded",
        description: `Reset to ${data.hours || 120} hours`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to reload credits",
        description: error.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const resetDataMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("User not found");
      const res = await apiRequest("POST", `/api/admin/users/${user.id}/reset-learning-data`, {
        resetVocabulary: true,
        resetGrammar: true,
        resetProgress: true,
        resetConversations: true,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vocabulary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/grammar"] });
      queryClient.invalidateQueries({ queryKey: ["/api/progress"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/review-hub"] }); // Invalidate language hub stats
      toast({
        title: "Learning Data Reset",
        description: `Cleared: ${data.deletedVocabulary || 0} words, ${data.deletedGrammar || 0} exercises`,
      });
      // Force new conversation after reset
      setConversationId(null);
    },
    onError: (error: any) => {
      toast({
        title: "Failed to reset data",
        description: error.message || "Unknown error",
        variant: "destructive",
      });
    },
  });
  
  // Query voice config from database - this is the source of truth for tutor names
  const { data: tutorVoices } = useQuery<{ 
    language: string; 
    female: { name: string; voiceId: string; speakingRate: number } | null; 
    male: { name: string; voiceId: string; speakingRate: number } | null 
  }>({
    queryKey: ['/api/tutor-voices', language?.toLowerCase()],
    enabled: !!language,
  });
  
  // Get tutor names from database (Voice Lab is source of truth), fallback to directory
  const tutorNames = useMemo(() => {
    const fallback = getTutorNames(language);
    return {
      male: tutorVoices?.male?.name || fallback.male,
      female: tutorVoices?.female?.name || fallback.female,
    };
  }, [tutorVoices, language]);
  const [isRecording, setIsRecording] = useState(false);
  const [isPttButtonHeld, setIsPttButtonHeld] = useState(false); // Track if PTT button is physically held (separate from MediaRecorder state)
  
  // Voice Lab: Session-level voice overrides (admin only - applies to next TTS call)
  const [voiceOverride, setVoiceOverride] = useState<VoiceOverride | null>(null);
  // Incognito mode: off-the-record voice sessions (Founder/Honesty mode only)
  const [isIncognito, setIsIncognito] = useState(false);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const isPttButtonHeldRef = useRef(false); // Synchronous ref for guards (state is async)
  const activeInputTypeRef = useRef<'mouse' | 'touch' | 'keyboard' | null>(null); // Track which input started recording
  const [isMicPreparing, setIsMicPreparing] = useState(false); // Show "Preparing mic..." before actual recording starts
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarState, setAvatarState] = useState<AvatarState>('idle');
  const [currentPlayingMessageId, setCurrentPlayingMessageId] = useState<string | null>(null);
  
  // Voice input mode: push-to-talk or open-mic (default)
  const [inputMode, setInputMode] = useState<VoiceInputMode>('open-mic');
  // Open mic visual state for feedback
  const [openMicState, setOpenMicState] = useState<OpenMicState>('idle');
  const openMicStateRef = useRef<OpenMicState>('idle');
  // Listening patience indicator: when student has been quiet for 1200ms mid-turn
  // (before the 3s silence cutoff fires), show "Take your time..." so the session
  // doesn't feel frozen. Timer starts on VAD speech start, clears on utterance end.
  const [showListeningPatience, setShowListeningPatience] = useState(false);
  const listeningPatienceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // UI fallback hint: if greeting hasn't arrived after 5s, stop ringing + show subtle prompt
  const [showStartHint, setShowStartHint] = useState(false);
  const startHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stuck-listening ceiling: if VAD stays open for too long (background noise keeps mic hot),
  // Daniela never gets a turn. Ceiling fires after 30s and forces an utterance-end.
  const listeningCeilingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LISTENING_CEILING_MS = 30_000;
  // Track if we're awaiting/playing a response (to ignore VAD events)
  const isAwaitingResponseRef = useRef(false);
  // Track previous input mode to detect mode changes
  const prevInputModeRef = useRef<VoiceInputMode>(inputMode);
  // CRITICAL: Track current inputMode for use in callbacks (avoids stale closure)
  const inputModeRef = useRef<VoiceInputMode>(inputMode);
  inputModeRef.current = inputMode; // Always keep in sync
  openMicStateRef.current = openMicState; // Always keep in sync
  // CRITICAL: Track current avatarState for use in callbacks (avoids stale closure)
  const avatarStateRef = useRef<AvatarState>(avatarState);
  avatarStateRef.current = avatarState; // Always keep in sync
  // Track when Daniela started speaking — used to suppress echo-triggered barge-in
  const danielaSpeakingStartedAtRef = useRef<number>(0);
  // CRITICAL: Track current connectionState for use in polling loops (avoids stale closure)
  // Note: The actual sync happens AFTER streamingVoice is initialized below
  const connectionStateRef = useRef<string>('disconnected');
  
  // OPEN MIC SAFETY: Failsafe timer to auto-recover from stuck 'processing' state
  const openMicProcessingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const OPEN_MIC_PROCESSING_TIMEOUT_MS = 35000;

  // Store last audio for replay functionality
  const [lastAudioBlob, setLastAudioBlob] = useState<Blob | null>(null);
  const [lastMessageId, setLastMessageId] = useState<string | null>(null);
  const [isSlowRepeatLoading, setIsSlowRepeatLoading] = useState(false);
  const [isSupportModalOpen, setIsSupportModalOpen] = useState(false);
  
  // Whiteboard hook - tutor-controlled visual teaching aids
  const whiteboard = useWhiteboard();

  // Lesson notes — accumulate throughout the session as Daniela adds them
  const [lessonNotes, setLessonNotes] = useState<LessonNote[]>([]);
  const [lessonNotesOpen, setLessonNotesOpen] = useState(false);

  // Pronunciation score — temporary floating overlay
  const [pronunciationScore, setPronunciationScore] = useState<{
    id: string; phrase: string;
    wordScores: Array<{ word: string; score: number; tip?: string }>;
    overallScore: number; encouragement?: string;
  } | null>(null);
  const pronunciationScoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Grammar flag — temporary auto-dismissing correction card
  const [grammarFlag, setGrammarFlag] = useState<{
    id: string; original: string; corrected: string; explanation: string; ruleLabel?: string;
  } | null>(null);
  const grammarFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Quiz — interactive overlay with multiple-choice options
  const [activeQuiz, setActiveQuiz] = useState<{
    id: string; question: string; options: string[]; correctIndex: number; explanation?: string;
    selectedIndex?: number; showResult?: boolean;
  } | null>(null);

  // Cultural context — persistent floating card until dismissed
  const [culturalContext, setCulturalContext] = useState<{
    id: string; title: string; text: string; category?: string; sourceUrl?: string;
  } | null>(null);

  // Spotlight — full-screen dimmed overlay directing attention
  const [spotlight, setSpotlight] = useState<{
    id: string; zone: string; message: string; durationMs: number;
  } | null>(null);
  const spotlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Gap D — Shared Mission: persistent badge showing the session objective set by Daniela
  const [activeMission, setActiveMission] = useState<string | null>(null);
  
  // Sync whiteboard items to parent for desktop panel rendering
  const onWhiteboardItemsChangeRef = useRef(onWhiteboardItemsChange);
  onWhiteboardItemsChangeRef.current = onWhiteboardItemsChange;
  useEffect(() => {
    onWhiteboardItemsChangeRef.current?.(whiteboard.items);
  }, [whiteboard.items]);

  // Cleanup: clear the stuck-listening ceiling timer on unmount to prevent
  // a timer firing on a null/unmounted component (memory leak / crash guard).
  useEffect(() => {
    return () => {
      if (listeningCeilingTimerRef.current) {
        clearTimeout(listeningCeilingTimerRef.current);
        listeningCeilingTimerRef.current = null;
      }
    };
  }, []);
  
  // Expose whiteboard callbacks to parent via ref (for desktop panel drill/text interactions)
  // This needs to be set after streamingVoice is available, so we use a separate effect below
  const whiteboardCallbacksRefLocal = whiteboardCallbacksRef;
  
  // Cache for slow repeat audio - so subsequent presses just replay
  const slowRepeatCacheRef = useRef<{ messageId: string; audioBlob: Blob } | null>(null);
  
  // Word timing data for synchronized subtitles - persisted per message ID
  // Using a ref to persist across re-renders without causing re-renders
  const wordTimingsMapRef = useRef<Map<string, WordTiming[]>>(new Map());
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  // Note: Scroll is handled by VoiceChatViewManager - no scroll refs needed here
  const streamRef = useRef<MediaStream | null>(null);
  const currentConversationRef = useRef<string | null>(conversationId);
  const hasPlayedGreetingRef = useRef<string | null>(null); // Track which conversation's greeting was played
  const hasDanielaSpokeOnceRef = useRef<boolean>(false); // Track if Daniela has spoken at least once this session
  const needsGreetingAfterReconnectRef = useRef<boolean>(false); // Set after proactive reconnect so greeting re-fires
  const connectionReadyAtRef = useRef<number>(0); // Timestamp when connectionState last became 'ready'
  const isRecordingRef = useRef<boolean>(false);
  const isProcessingRef = useRef<boolean>(false);
  const isPlayingRef = useRef<boolean>(false); // For stable keyboard handlers
  const recordingRequestedRef = useRef<boolean>(false); // Track if recording was requested (for race condition prevention)
  
  // Silence detection refs (only for auto-stop mode)
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Streaming voice mode for low-latency responses
  const streamingVoice = useStreamingVoice();
  const globalPlaybackState = usePlaybackState(); // Global store - reliable during HMR

  // Vision capture — opt-in webcam + screen share sent to Daniela's GL session
  // Vision stays on through every turn and across a reconnect; it is released only when the session ends.
  const visionPhase = visionSessionPhase(streamingVoice.state.connectionState);
  const vision = useVisionCapture(streamingVoice.sendVideoFrame, visionPhase !== 'ended');
  const streamingConnectedRef = useRef(false);
  const useStreamingMode = ENABLE_STREAMING_MODE && streamingVoice.isSupported();
  // Keep connectionStateRef in sync (must be after streamingVoice is defined)
  connectionStateRef.current = streamingVoice.state.connectionState;
  
  // Populate whiteboard callbacks ref for desktop panel (after streamingVoice is available)
  useEffect(() => {
    if (whiteboardCallbacksRefLocal) {
      whiteboardCallbacksRefLocal.current = {
        clear: whiteboard.clear,
        drillComplete: (drillId, drillType, isCorrect, responseTimeMs, toolContent) => {
          if (useStreamingMode) {
            streamingVoice.sendDrillResult(drillId, drillType, isCorrect, responseTimeMs, toolContent);
          }
        },
        textInputSubmit: (itemId, response) => {
          if (useStreamingMode) {
            streamingVoice.sendTextInput(itemId, response);
          }
        },
      };
    }
    return () => {
      if (whiteboardCallbacksRefLocal) {
        whiteboardCallbacksRefLocal.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteboardCallbacksRefLocal, useStreamingMode]);
  
  // Telephone ringing sound during connection
  const ringingAudioRef = useRef<{ 
    context: AudioContext; 
    gainNode: GainNode;
    oscillatorInterval: NodeJS.Timeout | null;
    isPlaying: boolean;
  } | null>(null);
  
  // Pre-create ringing AudioContext eagerly at mount time (within navigation gesture context)
  // This avoids the suspended-context problem when startRinging is called from useEffect later
  const ringingContextRef = useRef<AudioContext | null>(null);
  if (!ringingContextRef.current && typeof window !== 'undefined') {
    try {
      ringingContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('[RINGING] Pre-created AudioContext at mount, state:', ringingContextRef.current.state);
    } catch (e) {
      console.warn('[RINGING] Failed to pre-create AudioContext:', e);
    }
  }
  
  // Mic warm-up: cache stream for instant recording start
  const cachedStreamRef = useRef<MediaStream | null>(null);
  const micWarmedUpRef = useRef(false);
  
  // Cross-language handoff tracking
  // When true, we're reconnecting after a language switch
  const isLanguageHandoffRef = useRef(false);
  const pendingHandoffModeRef = useRef<'tutor_mode' | 'founder_mode' | 'honesty_mode' | undefined>(undefined);
  
  // Keep refs updated with current state
  useEffect(() => {
    currentConversationRef.current = conversationId;
    isRecordingRef.current = isRecording;
    isProcessingRef.current = isProcessing;
  }, [conversationId, isRecording, isProcessing]);
  
  // Reset hasDanielaSpokeOnce when conversation changes (new session)
  useEffect(() => {
    hasDanielaSpokeOnceRef.current = false;
    // Also clear any pending start-hint timer from the previous session
    if (startHintTimerRef.current) {
      clearTimeout(startHintTimerRef.current);
      startHintTimerRef.current = null;
    }
    setShowStartHint(false);
  }, [conversationId]);
  
  // Voice Lab: Send voice override to server when it changes.
  // Tracks the last-sent value to avoid re-sending on every connectionState toggle
  // (processing ↔ ready fires constantly while Daniela speaks, which would restart
  // the GL session mid-sentence on each transition and cause both a voice change and
  // an audio cutoff). Only re-sends when voiceOverride itself changes, or when the
  // connection becomes ready after a full disconnect (lastSent won't match current).
  const lastSentVoiceOverrideRef = useRef<typeof voiceOverride | null>(null);
  useEffect(() => {
    const connected = streamingVoice.state.connectionState === 'ready' || 
                      streamingVoice.state.connectionState === 'processing';
    if (!connected || voiceOverride === null) return;
    if (JSON.stringify(lastSentVoiceOverrideRef.current) === JSON.stringify(voiceOverride)) return;
    lastSentVoiceOverrideRef.current = voiceOverride;
    streamingVoice.sendVoiceOverride(voiceOverride);
    console.log('[Voice Lab] Sent voice override to server:', voiceOverride);
  }, [voiceOverride, streamingVoice.state.connectionState]);
  
  // Handle input mode changes - cleanup when switching modes
  // Note: Uses a ref-based approach since stopOpenMicRecording is defined later in the file
  const handleModeChangeCleanupRef = useRef<(() => void) | null>(null);
  
  useEffect(() => {
    const prevMode = prevInputModeRef.current;
    
    // If switching FROM open-mic to push-to-talk, cleanup open mic state
    // NOTE: We do NOT stop audio here - let barge-in handle interruption when user speaks
    if (prevMode === 'open-mic' && inputMode === 'push-to-talk') {
      console.log('[MODE SWITCH] Switching from open-mic to push-to-talk - cleaning up mic state (audio continues)');
      
      // Use ref-based cleanup function if available
      if (handleModeChangeCleanupRef.current) {
        handleModeChangeCleanupRef.current();
      }
      
      // Stop WebSocket streaming for mic
      streamingVoice.stopStreaming();
      
      // Reset recording states only (let audio continue)
      setIsRecording(false);
      isRecordingRef.current = false;
      setOpenMicState('idle');
      isAwaitingResponseRef.current = false;
    }
    
    // If switching TO open-mic mode, AUTO-START the session
    // This eliminates the confusing extra tap requirement
    // IMPORTANT: Must wait for session to be fully ready (session_started received)
    // NOTE: We do NOT stop audio here - barge-in handles interruption when user actually speaks
    if (prevMode === 'push-to-talk' && inputMode === 'open-mic') {
      console.log('[MODE SWITCH] Switching to open-mic - will AUTO-START when session ready (audio continues until barge-in)');
      
      // Show preparing state while we start
      setOpenMicState('idle');
      
      // Poll until session is ready (connectionState === 'ready' or 'processing')
      // This ensures we don't start Open Mic before the greeting is processed
      let retryCount = 0;
      const maxRetries = 25; // 5 seconds max wait
      
      const checkAndStart = () => {
        // CRITICAL: Use ref to get current state, not stale closure value
        const currentState = connectionStateRef.current;
        console.log('[MODE SWITCH] Checking session state:', currentState, 'retry:', retryCount);
        
        // Session is ready or processing - good to start
        if ((currentState === 'ready' || currentState === 'processing') && inputModeRef.current === 'open-mic') {
          console.log('[MODE SWITCH] Session ready - AUTO-STARTING open mic, ref exists:', !!startOpenMicRecordingRef.current);
          if (startOpenMicRecordingRef.current) {
            console.log('[MODE SWITCH] Calling startOpenMicRecordingRef.current()...');
            startOpenMicRecordingRef.current().then(() => {
              console.log('[MODE SWITCH] Open mic auto-started successfully — enabling green mic');
              setOpenMicState('ready');
            }).catch((err: any) => {
              console.error('[MODE SWITCH] Failed to auto-start open mic:', err);
              setOpenMicState('idle');
            });
          }
        } else if (currentState === 'error' || currentState === 'disconnected') {
          // Session failed - don't auto-start
          console.log('[MODE SWITCH] Session failed, not auto-starting:', currentState);
        } else if (retryCount < maxRetries && inputModeRef.current === 'open-mic') {
          // Still waiting - retry
          retryCount++;
          setTimeout(checkAndStart, 200);
        } else {
          console.log('[MODE SWITCH] Gave up waiting for session, retries:', retryCount);
        }
      };
      
      // Start checking after small delay
      setTimeout(checkAndStart, 100);
    }
    
    // Update prev mode ref
    prevInputModeRef.current = inputMode;
  }, [inputMode, streamingVoice]);
  
  useEffect(() => {
    setRemediationCallback(() => {
      console.warn('[StreamingVoiceChat] Auto-remediation: force-resetting mic state');
      setIsProcessing(false);
      isProcessingRef.current = false;
      setGlobalPlaybackState('idle');
      streamingVoice.forceResetProcessing?.();
    });
    return () => {
      setRemediationCallback(null);
    };
  }, [streamingVoice]);

  // Pre-warm microphone on component mount for instant recording
  // This requests mic permission early and caches the stream
  // NOTE: This may fail on browsers that require user gesture for mic access
  useEffect(() => {
    if (micWarmedUpRef.current) return;
    
    const warmUpMic = async () => {
      try {
        console.log('[MIC WARMUP] Pre-warming microphone (500ms after mount)...');
        const startTime = performance.now();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        cachedStreamRef.current = stream;
        micWarmedUpRef.current = true;
        console.log('[MIC WARMUP] SUCCESS! Microphone ready for instant recording (took', (performance.now() - startTime).toFixed(0), 'ms)');
      } catch (err: any) {
        console.log('[MIC WARMUP] FAILED - Browser likely requires user gesture for mic access:', err.name, err.message);
        // Not a critical error - we'll request permission on first button press
      }
    };
    
    // Small delay to let the UI render first
    const timeoutId = setTimeout(warmUpMic, 500);
    
    return () => {
      clearTimeout(timeoutId);
      // Clean up cached stream on unmount
      if (cachedStreamRef.current) {
        cachedStreamRef.current.getTracks().forEach(track => track.stop());
        cachedStreamRef.current = null;
      }
    };
  }, []);

  // AUDIO CONTEXT PRE-WARM + MOBILE AUDIO UNLOCK
  // Eagerly create & resume AudioContext on mount (may still be within user gesture window
  // from clicking the tutor card to navigate here). Also listen for future clicks/taps
  // in case the eager attempt fails (incognito, mobile Safari, background tab, etc.)
  useEffect(() => {
    if (!useStreamingMode) return;
    
    let unlocked = false;
    const unlockAudio = async (source: string) => {
      if (unlocked) return;
      
      try {
        const player = getStreamingAudioPlayer();
        await player.resumeAudioContext();
        const ctxState = player.getAudioContextState?.() || 'unknown';
        if (ctxState === 'running') {
          unlocked = true;
          console.log(`[AUDIO UNLOCK] AudioContext running (source: ${source})`);
          document.removeEventListener('touchstart', onGesture, true);
          document.removeEventListener('touchend', onGesture, true);
          document.removeEventListener('click', onGesture, true);
        } else {
          console.log(`[AUDIO UNLOCK] AudioContext still ${ctxState} after resume attempt (source: ${source})`);
        }
      } catch (err) {
        console.warn(`[AUDIO UNLOCK] Failed (source: ${source}):`, err);
      }
      
      if (ringingAudioRef.current?.context?.state === 'suspended') {
        ringingAudioRef.current.context.resume().then(() => {
          console.log('[AUDIO UNLOCK] Ringing AudioContext also resumed');
        }).catch(() => {});
      }
      
      if (ringingContextRef.current?.state === 'suspended') {
        ringingContextRef.current.resume().then(() => {
          console.log('[AUDIO UNLOCK] Pre-created ringing context resumed');
        }).catch(() => {});
      }
      
      if (openMicAudioContextRef.current?.state === 'suspended') {
        openMicAudioContextRef.current.resume().then(() => {
          console.log('[AUDIO UNLOCK] Open-mic AudioContext resumed');
        }).catch(() => {});
      }
    };
    
    const onGesture = () => unlockAudio('user-gesture');
    
    unlockAudio('eager-mount');
    
    document.addEventListener('touchstart', onGesture, true);
    document.addEventListener('touchend', onGesture, true);
    document.addEventListener('click', onGesture, true);
    
    return () => {
      document.removeEventListener('touchstart', onGesture, true);
      document.removeEventListener('touchend', onGesture, true);
      document.removeEventListener('click', onGesture, true);
    };
  }, [useStreamingMode]);
  
  // Telephone ringing sound functions
  const startRinging = async () => {
    if (ringingAudioRef.current?.isPlaying) return;
    
    try {
      // Reuse the pre-created context (created at mount time within gesture context)
      // Fall back to creating a new one if somehow missing
      const context = ringingContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
      ringingContextRef.current = null; // Consumed — will be cleaned up via ringingAudioRef
      
      if (context.state === 'suspended') {
        try {
          await context.resume();
          console.log('[RINGING] AudioContext was suspended, resumed successfully');
        } catch (resumeErr) {
          console.warn('[RINGING] AudioContext resume failed (no user gesture yet) - ringing will be silent:', resumeErr);
        }
      }
      
      console.log('[RINGING] Using AudioContext, state:', context.state);
      
      const gainNode = context.createGain();
      gainNode.connect(context.destination);
      gainNode.gain.value = 0.15;
      
      const playRingCycle = () => {
        if (!ringingAudioRef.current?.isPlaying) return;
        
        // Resume context if it got suspended between rings (belt-and-suspenders)
        if (context.state === 'suspended') {
          context.resume().catch(() => {});
        }
        
        const osc1 = context.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.value = 440;
        osc1.connect(gainNode);
        osc1.start(context.currentTime);
        osc1.stop(context.currentTime + 0.4);
        
        const osc2 = context.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.value = 480;
        osc2.connect(gainNode);
        osc2.start(context.currentTime + 0.05);
        osc2.stop(context.currentTime + 0.35);
      };
      
      ringingAudioRef.current = {
        context,
        gainNode,
        oscillatorInterval: null,
        isPlaying: true,
      };
      
      playRingCycle();
      
      ringingAudioRef.current.oscillatorInterval = setInterval(() => {
        if (ringingAudioRef.current?.isPlaying) {
          playRingCycle();
        }
      }, 2500);
      
      console.log('[RINGING] Started telephone ring sound (context state:', context.state, ')');
    } catch (err) {
      console.error('[RINGING] Failed to start ring sound:', err);
    }
  };
  
  const stopRinging = () => {
    if (!ringingAudioRef.current) return;
    
    ringingAudioRef.current.isPlaying = false;
    
    if (ringingAudioRef.current.oscillatorInterval) {
      clearInterval(ringingAudioRef.current.oscillatorInterval);
    }
    
    try {
      ringingAudioRef.current.context.close();
    } catch (err) {
      // Ignore close errors
    }
    
    ringingAudioRef.current = null;
    console.log('[RINGING] Stopped telephone ring sound');
  };
  
  // Play ringing sound during voice connection
  // Ring only until the session is confirmed ready/listening. Greeting transport may
  // still be initializing after that point; continuing the phone ring is misleading.
  // IMPORTANT: Don't ring on reconnects if Daniela has already spoken (prevents mid-call ringing)
  // NOTE: Ringing is started explicitly in connectStreaming() below, not from connectionState,
  // because warm-up can pre-connect the socket causing connect() to skip the 'connecting' state.
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const { connectionState } = streamingVoice.state;
    
    // Start ringing when connecting (WebSocket opening) — fallback for non-warmed connections
    // BUT only if Daniela hasn't spoken yet (prevents ringing during reconnects)
    if (connectionState === 'connecting' && !hasDanielaSpokeOnceRef.current) {
      startRinging();
    }
    
    if (connectionState === 'ready' || connectionState === 'disconnected' || connectionState === 'error') {
      stopRinging();
    }
  }, [streamingVoice.state.connectionState, useStreamingMode]);
  
  // Connection timeout: If stuck in INITIAL connecting for too long, redirect to language hub
  // IMPORTANT: Only applies to 'connecting' (first call), NOT 'reconnecting' (auto-recovery).
  // During reconnection after a server restart we want to stay on the page and keep retrying.
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const INITIAL_CONNECTION_TIMEOUT_MS = 30000; // 30 seconds for the very first connect attempt
  
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const { connectionState } = streamingVoice.state;
    
    // Only timeout on INITIAL connection — reconnection has its own multi-minute retry window
    if (connectionState === 'connecting') {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      
      connectionTimeoutRef.current = setTimeout(() => {
        console.log('[STREAMING] Initial connection timeout - redirecting to language hub');
        stopRinging();
        toast({
          title: "Connection timed out",
          description: "Unable to reach the tutor. Please try again.",
        });
        navigate(homeRoute);
      }, INITIAL_CONNECTION_TIMEOUT_MS);
    }
    
    // Clear timeout when connected successfully or disconnected (but NOT on reconnecting —
    // let the client's own retry logic run uninterrupted during server restarts)
    if (connectionState === 'ready' || connectionState === 'disconnected') {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    }
    
    // Cleanup on unmount
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };
  }, [streamingVoice.state.connectionState, useStreamingMode, navigate, toast]);
  
  // Handle unrecoverable connection errors - redirect to language hub
  useEffect(() => {
    const { error: streamError, connectionState } = streamingVoice.state;
    
    if (!streamError || connectionState !== 'disconnected') return;
    
    // Helper: update the shared reconnect toast slot in-place, or show a new toast if none exists.
    const showConnectionToast = (title: string, description: string) => {
      if (reconnectToastRef.current) {
        reconnectToastRef.current.update({ id: reconnectToastRef.current.id, title, description });
        reconnectToastRef.current = null;
      } else {
        toast({ title, description });
      }
    };

    // Credits exhausted - show clear message and redirect to account
    if (streamError.includes('credits have been used up') || streamError.includes('Insufficient tutoring hours')) {
      console.log('[STREAMING] Credits exhausted - redirecting to account page');
      stopRinging();
      showConnectionToast("Session hours used up", "Visit your Account page to add more hours.");
      setTimeout(() => {
        navigate(homeRoute);
      }, 2500);
      return;
    }
    
    // Check for unrecoverable errors (after all reconnect attempts failed or session expired)
    if (streamError.includes('Please restart') || streamError.includes('session has ended') || streamError.includes('Please start a new')) {
      console.log('[STREAMING] Unrecoverable error - redirecting to language hub');
      stopRinging();
      showConnectionToast("Session ended", "The connection was lost. Starting a fresh session.");
      setTimeout(() => {
        navigate(homeRoute);
      }, 1500);
    }
  }, [streamingVoice.state.error, streamingVoice.state.connectionState, navigate, toast]);

  // Reconnect grace timer — only surface a notification after 4 s of continuous reconnecting.
  // Transient drops that auto-recover within 4 s produce no toast at all.
  const reconnectGraceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Hold the full toast handle for the in-flight "Reconnecting…" toast so we can
  // update it in-place when the session fully fails (preventing stacked toasts).
  const reconnectToastRef = useRef<{ id: string; dismiss: () => void; update: (props: any) => void } | null>(null);
  useEffect(() => {
    if (!useStreamingMode) return;
    const { connectionState } = streamingVoice.state;

    if (connectionState === 'reconnecting') {
      // Start the grace timer only once per reconnect episode
      if (!reconnectGraceTimerRef.current) {
        reconnectGraceTimerRef.current = setTimeout(() => {
          reconnectGraceTimerRef.current = null;
          // Only show if still reconnecting when the timer fires
          if (connectionStateRef.current === 'reconnecting') {
            reconnectToastRef.current = toast({
              title: "Reconnecting…",
              description: "Restoring your voice session.",
              duration: 10000,
            });
          }
        }, 4000);
      }
    } else {
      // Recovered or fully disconnected — cancel any pending grace notification
      if (reconnectGraceTimerRef.current) {
        clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
      // Dismiss the visible "Reconnecting…" toast if the connection left that state
      if (reconnectToastRef.current) {
        reconnectToastRef.current.dismiss();
        reconnectToastRef.current = null;
      }
    }

    return () => {
      if (reconnectGraceTimerRef.current) {
        clearTimeout(reconnectGraceTimerRef.current);
        reconnectGraceTimerRef.current = null;
      }
    };
  }, [streamingVoice.state.connectionState, useStreamingMode, toast]);

  // When the server is restarting (deploy rotation), poll until it's back then start fresh.
  // A new session is better UX than waiting 60s for WebSocket reconnect — Daniela's memory
  // carries full context so the student experience is seamless.
  const restartPollRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!streamingVoice.state.serverRestarting) return;

    // Reuse the reconnect toast slot if one is already visible, so the two
    // connection-state toasts never stack on top of each other.
    if (reconnectToastRef.current) {
      reconnectToastRef.current.update({
        id: reconnectToastRef.current.id,
        title: "HolaHola is updating",
        description: "We'll be right back — starting a fresh session automatically.",
        duration: 90000,
      });
    } else {
      reconnectToastRef.current = toast({
        title: "HolaHola is updating",
        description: "We'll be right back — starting a fresh session automatically.",
        duration: 90000,
      });
    }

    const poll = () => {
      fetch('/api/health')
        .then(r => {
          if (r.ok) {
            console.log('[StreamingVoice] Server back — navigating to fresh session');
            if (reconnectToastRef.current) {
              reconnectToastRef.current.dismiss();
              reconnectToastRef.current = null;
            }
            navigate(homeRoute);
          } else {
            restartPollRef.current = setTimeout(poll, 3000);
          }
        })
        .catch(() => {
          restartPollRef.current = setTimeout(poll, 3000);
        });
    };

    // Give the server a moment to finish draining before first poll
    restartPollRef.current = setTimeout(poll, 5000);

    return () => {
      if (restartPollRef.current) clearTimeout(restartPollRef.current);
      if (reconnectToastRef.current) {
        reconnectToastRef.current.dismiss();
        reconnectToastRef.current = null;
      }
    };
  }, [streamingVoice.state.serverRestarting, toast, navigate, homeRoute]);

  // One-tap retry when all GL reconnect attempts are exhausted.
  // Shows a persistent toast with a "Tap to reconnect" action so the student
  // does not need to reload the page — the existing socket is reused.
  const glRetryToastRef = useRef<{ id: string; dismiss: () => void } | null>(null);
  useEffect(() => {
    if (!useStreamingMode) return;

    if (streamingVoice.state.glDisconnectedForRetry) {
      // Dismiss any stale reconnect progress toast first.
      if (reconnectToastRef.current) {
        reconnectToastRef.current.dismiss();
        reconnectToastRef.current = null;
      }
      // Only show one retry toast at a time.
      if (!glRetryToastRef.current) {
        const handle = toast({
          title: "Voice session disconnected",
          description: "The connection to Daniela was lost.",
          duration: 60000,
          action: (
            <ToastAction
              altText="Tap to reconnect"
              onClick={() => {
                glRetryToastRef.current?.dismiss();
                glRetryToastRef.current = null;
                streamingVoice.retryGlSession();
              }}
            >
              Tap to reconnect
            </ToastAction>
          ),
        });
        glRetryToastRef.current = handle;
      }
    } else {
      // Retry succeeded or state was reset — dismiss the prompt.
      if (glRetryToastRef.current) {
        glRetryToastRef.current.dismiss();
        glRetryToastRef.current = null;
      }
    }

    return () => {
      if (glRetryToastRef.current) {
        glRetryToastRef.current.dismiss();
        glRetryToastRef.current = null;
      }
    };
  }, [streamingVoice.state.glDisconnectedForRetry, streamingVoice.retryGlSession, useStreamingMode, toast]);

  // Separate cleanup effect for unmount only
  useEffect(() => {
    return () => {
      stopRinging();
    };
  }, []);

  // Fetch existing messages
  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ["/api/conversations", conversationId, "messages"],
    enabled: !!conversationId,
  });
  
  // Stamp when connectionState first becomes 'ready' so the greeting grace window is accurate
  useEffect(() => {
    if (!useStreamingMode) return;
    if (streamingVoice.state.connectionState === 'ready') {
      connectionReadyAtRef.current = Date.now();
    }
  }, [streamingVoice.state.connectionState, useStreamingMode]);

  // FIX: Stop ringing when 'ready' AND this is an existing conversation that won't get a greeting.
  // For existing conversations with user messages, no auto-greeting plays, so we must stop ringing.
  // BUT: give a 6-second grace window after the connection becomes 'ready' so the greeting has
  // time to arrive (GL thinks for ~2s before emitting audio). If greeting arrives in that window
  // the ring stops naturally when audio plays. If nothing arrives in 6s, we stop it on the timer.
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const { connectionState } = streamingVoice.state;
    
    if (connectionState === 'ready' && messages.length > 0) {
      const userMessages = messages.filter(m => m.role === 'user');
      const aiMessages = messages.filter(m => m.role === 'assistant');
      const isNewConversation = userMessages.length === 0 && aiMessages.length <= 1;
      const willGreet = isNewConversation || isResumedConversation || needsGreetingAfterReconnectRef.current;
      
      // If no greeting will play, stop ringing — but honor a 6s grace window after connect
      if (!willGreet) {
        const GREETING_GRACE_MS = 6000;
        const msSinceReady = Date.now() - connectionReadyAtRef.current;
        const remaining = GREETING_GRACE_MS - msSinceReady;
        if (remaining > 0) {
          // Grace window still open — schedule the stop so a late greeting can win
          const timer = setTimeout(() => {
            console.log('[RINGING] Stopping ring - existing conversation with no greeting (grace elapsed)');
            stopRinging();
          }, remaining);
          return () => clearTimeout(timer);
        }
        console.log('[RINGING] Stopping ring - existing conversation with no greeting');
        stopRinging();
      }
    }
  }, [streamingVoice.state.connectionState, useStreamingMode, messages, isResumedConversation]);

  // AUTO-START open mic whenever session becomes ready in open-mic mode.
  // This covers: initial session load (mode already open-mic), and reconnects.
  // The mode-switch effect only fires when switching FROM push-to-talk → open-mic,
  // so this is needed for the initial default-mode case.
  useEffect(() => {
    if (!useStreamingMode) return;
    const { connectionState } = streamingVoice.state;
    if (connectionState === 'ready' && inputModeRef.current === 'open-mic') {
      console.log('[OPEN MIC AUTO-START] Session ready in open-mic mode — auto-starting recording');
      if (startOpenMicRecordingRef.current) {
        startOpenMicRecordingRef.current().then(() => {
          console.log('[OPEN MIC AUTO-START] Recording started — enabling green mic');
          setOpenMicState('ready');
        }).catch((err: any) => {
          console.error('[OPEN MIC AUTO-START] Failed to auto-start recording:', err);
        });
      }
    }
  }, [streamingVoice.state.connectionState, useStreamingMode]);

  // Fetch user details to get tutor gender preference
  const { data: userDetails } = useQuery<User>({
    queryKey: ["/api/auth/user"],
  });
  
  // Connect streaming voice when conversation and user data are available
  useEffect(() => {
    if (!useStreamingMode || !conversationId || !userDetails) return;
    
    // Block connection if credits are exhausted
    if (isExhausted) {
      console.log('[STREAMING] Connection blocked - credits exhausted');
      if (onInsufficientCredits) {
        onInsufficientCredits();
      }
      return;
    }
    
    const connectStreaming = async () => {
      try {
        console.log('[STREAMING] Connecting to streaming voice...');
        
        if (!hasDanielaSpokeOnceRef.current) {
          startRinging();
        }
        
        const handoffMode = pendingHandoffModeRef.current;
        pendingHandoffModeRef.current = undefined; // consume it
        const isExplicitFounderMode = learningContext === 'founder-mode' || handoffMode === 'founder_mode';
        const isExplicitHonestyMode = isHonestyMode || handoffMode === 'honesty_mode';
        
        await streamingVoice.connect({
          conversationId,
          targetLanguage: targetLanguageOverride ?? language,
          nativeLanguage: userDetails.nativeLanguage || 'english',
          difficultyLevel: difficulty,
          subtitleMode,
          tutorPersonality: userDetails.tutorPersonality || 'warm',
          tutorExpressiveness: userDetails.tutorExpressiveness || 3,
          tutorGender,  // Pass current tutor gender from context
          rawHonestyMode: isExplicitHonestyMode,  // Minimal prompting for authentic conversation
          founderMode: isExplicitFounderMode,  // Only true when explicitly selected
          onProcessingPending: () => {
            // processing_pending fired (PTT released, Gemini transcribed) — set thinking immediately.
            // Uses component-level isProcessing (properly cleared by onResponseComplete) rather
            // than the hook-level state, which can get stuck in the Gemini Live PCM audio path.
            setIsProcessing(true);
            isProcessingRef.current = true;
            isAwaitingResponseRef.current = true;
          },
          onNoSpeechDetected: () => {
            console.log('[STREAMING] No speech detected - resetting processing state');
            setIsProcessing(false);
            isProcessingRef.current = false;
            setProcessingStage(null);
            pttReleaseSentRef.current = false;
          },
          onResponseComplete: (convId: string) => {
            console.log('[STREAMING] Response complete - refreshing messages for', convId);
            queryClient.invalidateQueries({ queryKey: ["/api/conversations", convId, "messages"] });
            
            const currentPlayback = getGlobalPlaybackState();
            const isAudioPlaying = currentPlayback === 'playing' || currentPlayback === 'buffering';
            
            setProcessingStage(null);
            
            if (isAudioPlaying) {
              console.log('[STREAMING] Response complete, audio playing - clearing isProcessing (mic stays locked via isAudioActive)');
            } else {
              console.log('[STREAMING] Response complete, audio idle - clearing isProcessing');
            }
            setIsProcessing(false);
            isProcessingRef.current = false;
            
            pttReleaseSentRef.current = false;  // Reset for next PTT turn
            // Reset awaiting flag for next utterance
            isAwaitingResponseRef.current = false;
            // TRUE DUPLEX: Keep green light ready if open mic is active
            if (inputModeRef.current === 'open-mic' && openMicActiveRef.current) {
              console.log('[OPEN MIC DUPLEX] Response complete - keeping green light ready');
              setOpenMicState('ready');
            } else {
              setOpenMicState('idle');
            }
            
            // CRITICAL: Restart open mic session if we're in open-mic mode
            // The server closes the session after each utterance, so we need to restart it
            // Use inputModeRef.current to get current value (avoids stale closure)
            if (inputModeRef.current === 'open-mic') {
              console.log('[OPEN MIC] Response complete - restarting session for next utterance');
              setTimeout(() => {
                // Use the ref to call the local startOpenMicRecording function
                if (startOpenMicRecordingRef.current) {
                  startOpenMicRecordingRef.current().then(() => {
                    // DON'T show green light here!
                    // The playback state effect will show it when audio actually finishes
                    console.log('[OPEN MIC] Session restarted - green light controlled by playback state');
                  }).catch((err: any) => {
                    console.error('[OPEN MIC] Failed to restart after response:', err);
                    setOpenMicState('idle');
                  });
                }
              }, 200); // Small delay to let audio finish playing
            }
            
            // Store combined audio blob for replay functionality
            const combinedBlob = streamingVoice.getCombinedAudioBlob();
            if (combinedBlob) {
              console.log('[STREAMING] Storing combined audio for replay:', combinedBlob.size, 'bytes');
              setLastAudioBlob(combinedBlob);
              
              // Find the latest assistant message ID for replay tracking
              // We need to invalidate first and let messages refresh, then set the ID
              // Since invalidation is async, we'll set lastMessageId in a separate effect
            }
          },
          onLessonNoteAdded: (note) => {
            setLessonNotes(prev => [...prev, note as LessonNote]);
            // Don't auto-open — notes accumulate quietly; student opens when ready
          },
          onPronunciationScoreShown: (data) => {
            // ARCHITECTURE NOTE: The streaming path does NOT call /api/pronunciation-scores/analyze.
            // Instead, Daniela scores the student's pronunciation herself via the show_pronunciation_score
            // tool (see daniela-function-registry.ts). The scores arrive here as a WebSocket event.
            // This means the OpenAI key error path from VoiceChat.tsx (pronunciation_unavailable) cannot
            // occur in this path — there is no server-side OpenAI call on the scoring route.
            // The guard below covers the only failure mode that can reach here: malformed tool data.
            //
            // Guard: validate required fields before updating state.
            // wordScores must be an array — rendering calls .map() on it directly.
            // A missing or non-array value would throw a runtime error with no user feedback.
            if (
              !data ||
              typeof data.phrase !== 'string' || !data.phrase.trim() ||
              !Array.isArray(data.wordScores) || data.wordScores.length === 0 ||
              typeof data.overallScore !== 'number'
            ) {
              console.warn('[StreamingVoiceChat] Received malformed pronunciation score data — skipping display', data);
              toast({
                title: "Pronunciation feedback is temporarily unavailable",
                description: "Scoring data could not be displayed right now.",
                variant: "destructive",
              });
              return;
            }
            // Sanitize optional encouragement: strip whitespace-only values so the
            // card never renders a blank encouragement line.
            const sanitizedData = (typeof data.encouragement === 'string' && !data.encouragement.trim())
              ? { ...data, encouragement: undefined }
              : data;
            if (pronunciationScoreTimerRef.current) clearTimeout(pronunciationScoreTimerRef.current);
            setPronunciationScore(sanitizedData);
            pronunciationScoreTimerRef.current = setTimeout(() => setPronunciationScore(null), 8000);
          },
          onGrammarFlagShown: (data) => {
            if (!data.original || !data.original.trim() || !data.corrected || !data.corrected.trim() || !data.explanation || !data.explanation.trim()) {
              console.warn('[StreamingVoiceChat] onGrammarFlagShown: malformed grammar flag data (blank original, corrected, or explanation)', data);
              toast({ title: 'Grammar correction unavailable', description: 'Daniela sent an incomplete grammar correction card — skipping.', variant: 'destructive' });
              return;
            }
            if (grammarFlagTimerRef.current) clearTimeout(grammarFlagTimerRef.current);
            setGrammarFlag(data);
            grammarFlagTimerRef.current = setTimeout(() => setGrammarFlag(null), 6000);
          },
          onQuizPresented: (data) => {
            if (typeof data.question !== 'string' || !data.question.trim() ||
                !Array.isArray(data.options) || data.options.length === 0 ||
                !data.options.every((o: unknown) => typeof o === 'string' && (o as string).trim().length > 0) ||
                typeof data.correctIndex !== 'number' || !Number.isInteger(data.correctIndex) ||
                data.correctIndex < 0 || data.correctIndex >= data.options.length) {
              console.warn('[StreamingVoiceChat] onQuizPresented: malformed quiz data', data);
              toast({ title: 'Quiz unavailable', description: 'Daniela sent an incomplete quiz — skipping.', variant: 'destructive' });
              return;
            }
            setActiveQuiz({ ...data, selectedIndex: undefined, showResult: false });
          },
          onCulturalContextShown: (data) => {
            const validated = validateCulturalContextPayload(data);
            if (!validated) {
              console.warn('[StreamingVoiceChat] onCulturalContextShown: malformed cultural context data', data);
              toast({ title: 'Cultural note unavailable', description: 'Daniela sent an incomplete cultural context card — skipping.', variant: 'destructive' });
              return;
            }
            setCulturalContext(validated);
          },
          onSpotlightShown: (data) => {
            if (!isSpotlightMessageValid(data)) {
              console.warn('[StreamingVoiceChat] onSpotlightShown: malformed spotlight data (empty message)', data);
              toast({ title: 'Spotlight unavailable', description: 'Daniela sent an incomplete spotlight card — skipping.', variant: 'destructive' });
              return;
            }
            if (spotlightTimerRef.current) clearTimeout(spotlightTimerRef.current);
            setSpotlight(data);
            spotlightTimerRef.current = setTimeout(() => setSpotlight(null), data.durationMs);
          },
          onMissionSet: (mission) => {
            setActiveMission(mission);
          },
          onWhiteboardUpdate: (items, shouldClear) => {
            const imageItems = items.filter((item: any) => item.type === 'image' && item.data?.imageUrl);
            const otherItems = items.filter((item: any) => !(item.type === 'image' && item.data?.imageUrl));
            imageItems.forEach((img: any) => {
              onStudioImage?.({
                word: img.data.word || img.content,
                description: img.data.description || img.content,
                imageUrl: img.data.imageUrl,
                context: img.data.context,
                slot: img.data.slot,
                category: img.data.category,
              });
            });
            if (otherItems.length > 0 || shouldClear) {
              whiteboard.addOrUpdateItems(otherItems, shouldClear);
            }
          },
          onScenarioLoaded: (scenario) => {
            onScenarioLoaded?.(scenario);
          },
          onScenarioEnded: (data) => {
            onScenarioEnded?.(data);
          },
          onSceneZoneAdvanced: (data) => {
            onSceneZoneAdvanced?.(data);
          },
          onPropUpdate: (data) => {
            onPropUpdate?.(data);
          },
          onImmersiveModeChange: (active) => {
            onImmersiveModeChange?.(active);
          },
          onIncognitoChanged: (enabled) => {
            setIsIncognito(enabled);
          },
          onCreditWarning: ({ level, remainingSeconds }) => {
            const mins = Math.floor(remainingSeconds / 60);
            const secs = remainingSeconds % 60;
            const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            if (level === 'critical' || level === 'exhausted') {
              toast({
                title: 'Credits running low',
                description: `You have about ${timeStr} of speaking time remaining. Purchase more to keep learning.`,
                variant: 'destructive',
              });
            } else if (level === 'low') {
              toast({
                title: 'Credit reminder',
                description: `You have about ${timeStr} of speaking time remaining.`,
              });
            }
          },
          onVadSpeechStarted: () => {
            // TRUE DUPLEX: Always handle VAD speech events for visual feedback
            // NOTE: We no longer interrupt on VAD alone - echo/feedback can trigger false VAD
            // Interrupt is now handled in onInterimTranscript when we have ACTUAL user speech
            console.log('[OPEN MIC] VAD speech started - avatarState=', avatarStateRef.current, 'hasDanielaSpokeOnce=', hasDanielaSpokeOnceRef.current);
            
            // PHONE CALL MODEL: Only show green light if Daniela has "answered the call" (spoken at least once)
            // This prevents the confusing premature green light before Daniela greets
            if (hasDanielaSpokeOnceRef.current) {
              setOpenMicState('listening');
            } else {
              console.log('[OPEN MIC] Daniela hasnt spoken yet - keeping mic blue (waiting for her to answer)');
            }

            // Patience indicator: after 1200ms of the student speaking, arm a 1200ms
            // "still listening" timer. When it fires it shows "Take your time..." so the
            // student gets permission to pause and think (silence cutoff is now 3000ms).
            if (listeningPatienceTimerRef.current) clearTimeout(listeningPatienceTimerRef.current);
            setShowListeningPatience(false);
            listeningPatienceTimerRef.current = setTimeout(() => {
              setShowListeningPatience(true);
            }, 1200);
            // Stuck-listening ceiling: if VAD stays open for the full ceiling window
            // (e.g. background noise keeps the mic hot), Daniela never gets a turn.
            // After 30s, force-close the recording session — simulates a natural utterance end.
            if (listeningCeilingTimerRef.current) clearTimeout(listeningCeilingTimerRef.current);
            listeningCeilingTimerRef.current = setTimeout(() => {
              listeningCeilingTimerRef.current = null;
              const alreadyProcessing = openMicStateRef.current === 'processing';
              if (alreadyProcessing) return; // utterance end already handled naturally
              console.warn('[OPEN MIC] Stuck-listening ceiling fired — forcing utterance end after 30s');
              setOpenMicState('processing');
              openMicStateRef.current = 'processing';
              setShowListeningPatience(false);
              if (stopOpenMicRecordingRef.current) stopOpenMicRecordingRef.current();
            }, LISTENING_CEILING_MS);
          },
          onVadUtteranceEnd: (transcript, empty) => {
            console.log('[OPEN MIC] VAD utterance end, transcript:', transcript, 'empty:', empty);
            // Clear patience indicator and listening ceiling — student's turn is complete
            if (listeningPatienceTimerRef.current) clearTimeout(listeningPatienceTimerRef.current);
            if (listeningCeilingTimerRef.current) clearTimeout(listeningCeilingTimerRef.current);
            listeningCeilingTimerRef.current = null;
            setShowListeningPatience(false);
            if (empty) {
              console.log('[OPEN MIC] Empty transcript - resetting to listening (no AI call needed)');
              setOpenMicState('ready');
              setIsProcessing(false);
              isProcessingRef.current = false;
              isAwaitingResponseRef.current = false;
              return;
            }
            setOpenMicState('processing');
            setIsProcessing(true);
            isProcessingRef.current = true;
            isAwaitingResponseRef.current = true;
            // Show thinking avatar immediately — don't wait for the processing_pending
            // server round-trip. By the time processing_pending arrives, the first audio
            // chunk may already be batching in, causing React to skip the 'thinking'
            // state entirely and jump straight to 'playing'.
            if (getGlobalPlaybackState() !== 'playing' && getGlobalPlaybackState() !== 'buffering') {
              setGlobalPlaybackState('thinking');
            }
            
            // SAFETY: Start failsafe timer to recover from stuck processing state
            if (openMicProcessingTimeoutRef.current) clearTimeout(openMicProcessingTimeoutRef.current);
            openMicProcessingTimeoutRef.current = setTimeout(() => {
              const currentState = openMicStateRef.current;
              if (currentState === 'processing') {
                console.warn(`[OPEN MIC SAFETY] Processing stuck for ${OPEN_MIC_PROCESSING_TIMEOUT_MS}ms — force-recovering to ready state`);
                setOpenMicState('ready');
                setIsProcessing(false);
                isProcessingRef.current = false;
                isAwaitingResponseRef.current = false;
                setAvatarState('listening');
              }
              openMicProcessingTimeoutRef.current = null;
            }, OPEN_MIC_PROCESSING_TIMEOUT_MS);
          },
          onInterimTranscript: (transcript) => {
            console.log('[OPEN MIC] Interim transcript:', transcript);
            
            // Reinforce 'listening' state when we get actual transcribed words from Deepgram
            // Having real transcript text is the most reliable indicator the user is speaking
            if (transcript && transcript.trim().length > 0) {
              const currentOMState = openMicStateRef.current;
              if (currentOMState !== 'listening' && currentOMState !== 'processing') {
                console.log('[OPEN MIC] Interim transcript with words - forcing listening state (was:', currentOMState, ')');
                setOpenMicState('listening');
              }
              
              // BARGE-IN: Interrupt tutor when we have ACTUAL transcribed speech.
              // Require ≥5 words before triggering to filter mic echo artifacts —
              // GL inputTranscription can pick up the tutor's own audio playing
              // through the speaker (especially without headphones) and a few
              // echo words would cut off the tutor mid-sentence.
              // ALSO: suppress barge-in within the first 1.5s of Daniela starting to
              // speak — echo arrives immediately, genuine interruption takes longer.
              const wordCount = transcript.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
              const msSinceSpeakingStarted = Date.now() - danielaSpeakingStartedAtRef.current;
              const echoSuppressed = avatarStateRef.current === 'speaking' && msSinceSpeakingStarted < 1500;
              if (!echoSuppressed && (avatarStateRef.current === 'speaking' || isAwaitingResponseRef.current) && wordCount >= 5) {
                console.log('[BARGE-IN] User speaking with transcript (' + wordCount + ' words, ' + msSinceSpeakingStarted + 'ms since Daniela started) - stopping audio and sending interrupt');
                // CRITICAL: Stop audio playback immediately on client side
                streamingVoice.stop();
                // Also notify server to stop generating
                streamingVoice.sendInterrupt();
                // Reset awaiting flag so new speech is captured
                isAwaitingResponseRef.current = false;
                // Update avatar state immediately
                setAvatarState('listening');
              }
            }
          },
          onOpenMicSessionClosed: () => {
            console.log('[OPEN MIC] Server session closed');
            // CRITICAL: Reset both the active ref AND isRecording state so restart can work
            // This is needed because the server session closed unexpectedly
            if (openMicActiveRef.current) {
              console.log('[OPEN MIC] Resetting openMicActiveRef for restart');
              openMicActiveRef.current = false;
            }
            // Also reset isRecording state to allow restart
            isRecordingRef.current = false;
            setIsRecording(false);
            
            // If still in open mic mode and not awaiting response, restart the session
            // Use inputModeRef.current to get current value (avoids stale closure)
            // BUT only restart if audio has finished playing (not during greeting)
            // Check avatarStateRef to ensure Daniela isn't speaking
            if (inputModeRef.current === 'open-mic' && !isAwaitingResponseRef.current && avatarStateRef.current !== 'speaking') {
              console.log('[OPEN MIC] Restarting open mic session after server close');
              setOpenMicState('idle');
              // Use a small delay to allow any cleanup to complete
              setTimeout(() => {
                if (inputModeRef.current === 'open-mic' && startOpenMicRecordingRef.current) {
                  startOpenMicRecordingRef.current().then(() => {
                    // DON'T show green light here!
                    // The playback state effect will show it when audio actually finishes
                    console.log('[OPEN MIC] Session restarted - green light controlled by playback state');
                  }).catch((err: any) => {
                    console.error('[OPEN MIC] Failed to restart session:', err);
                    setOpenMicState('idle');
                  });
                }
              }, 100);
            } else if (inputModeRef.current === 'open-mic' && avatarStateRef.current === 'speaking') {
              console.log('[OPEN MIC] Server closed during Daniela speaking - will restart when done');
            }
          },
          onOpenMicSilenceLoop: (emptyCount, msSinceLast) => {
            console.warn(`[OPEN MIC] Silence loop: ${emptyCount} empties, ${msSinceLast}ms since last speech`);
            if (emptyCount >= 8 && inputModeRef.current === 'open-mic') {
              setOpenMicState('silence_issue');
            }
          },
          onGlReconnected: () => {
            // GL-only reconnect (e.g. Gemini 1008 drop): the Socket.io connection to the
            // client never dropped and the server rebuilt the GL session with a Context
            // Bridge — no greeting or recorder reset needed. Just clear any stale
            // "connection failed" error UI so the student can keep talking.
            console.log('[StreamingVoice] GL session restored (socket intact) — clearing error state');
            setError(null);
            setAvatarState('idle');
            isAwaitingResponseRef.current = false;
            isProcessingRef.current = false;
            setIsProcessing(false);
            // Restore open-mic readiness so the mic loop resumes listening immediately.
            if (inputModeRef.current === 'open-mic') {
              setOpenMicState('idle');
            }
          },
          onReconnected: () => {
            console.log('[StreamingVoice] Connection restored after drop — resetting UI state for fresh start');

            // AUTOSCALE RECOVERY: Clear all stale "Juliette was speaking" client state
            // so the user isn't stuck waiting for audio from the dead server instance.
            setGlobalPlaybackState('idle');
            setAvatarState('idle');
            setIsRecording(false);
            isRecordingRef.current = false;
            isAwaitingResponseRef.current = false;
            isProcessingRef.current = false;
            // No toast — reconnects from autoscale rotation are routine infrastructure
            // events and should be completely invisible to the user.

            // GREETING LOCK RESET: GL is always a fresh WebSocket after reconnect — needs
            // an orientation greeting or it waits silently for the user's first utterance.
            greetingRequestedRef.current = null;
            clearGreetingLock();
            needsGreetingAfterReconnectRef.current = true;

            // Restart open-mic automatically if that was the active mode
            if (inputModeRef.current === 'open-mic') {
              setOpenMicState('idle');
              let retries = 0;
              const tryRestart = () => {
                const state = connectionStateRef.current;
                if ((state === 'ready' || state === 'processing') && startOpenMicRecordingRef.current) {
                  console.log('[RECONNECT] Auto-restarting open mic after reconnect');
                  startOpenMicRecordingRef.current().catch((err: any) => {
                    console.error('[RECONNECT] Failed to restart open mic:', err);
                    setOpenMicState('idle');
                  });
                } else if (retries < 20 && inputModeRef.current === 'open-mic') {
                  retries++;
                  setTimeout(tryRestart, 250);
                }
              };
              setTimeout(tryRestart, 300);
            }
          },
          onTutorHandoff: (handoff) => {
            const { targetGender, targetLanguage, tutorName, isLanguageSwitch, isAssistant, mode: handoffMode } = handoff;
            
            // Store requested mode so it's applied when the new session connects
            if (handoffMode && handoffMode !== 'tutor_mode') {
              pendingHandoffModeRef.current = handoffMode as 'tutor_mode' | 'founder_mode' | 'honesty_mode';
            }

            // ASSISTANT HANDOFF: Navigate to assistant practice page
            if (isAssistant) {
              console.log(`[TUTOR HANDOFF] Assistant handoff to ${tutorName} - navigating to practice page`);
              // Disconnect from streaming voice before navigation
              streamingVoice.disconnect();
              streamingConnectedRef.current = false;
              // Navigate to assistant practice page
              window.location.href = '/practice';
              return;
            }
            
            if (isLanguageSwitch && targetLanguage) {
              console.log(`[TUTOR HANDOFF] Cross-language switch to ${tutorName} (${targetGender}) in ${targetLanguage}${handoffMode ? ` [${handoffMode}]` : ''}`);
              // Mark that we're in a language handoff - used to complete handoff after reconnection
              isLanguageHandoffRef.current = true;
              // CRITICAL: Clear greeting lock so new tutor can greet
              // Without this, the lock from the old tutor's session prevents the new tutor's greeting
              greetingRequestedRef.current = null;
              clearGreetingLock();
              try {
                sessionStorage.removeItem(GREETING_MESSAGE_KEY);
              } catch {
                // Ignore storage errors
              }
              console.log('[TUTOR HANDOFF] Cleared greeting lock for new tutor');
              // Notify parent to show transition overlay BEFORE language change
              // This prevents the white screen crash during context update
              onLanguageHandoff?.(tutorName || 'tutor', targetLanguage);
              // Update language context - parent will manage conversation reset
              setLanguage(targetLanguage);
            } else {
              console.log(`[TUTOR HANDOFF] Switching to ${tutorName || targetGender} tutor`);
            }
            setTutorGender(targetGender);
          },
          // Handle server-initiated subtitle mode change (tutor [SUBTITLE on/off/target] command)
          onSubtitleModeChange: (mode) => {
            console.log('[SUBTITLE] Server command to change subtitle mode to:', mode);
            // Update whiteboard's regularSubtitleMode (used by FloatingSubtitleOverlay)
            whiteboard.setRegularSubtitleMode(mode);
            // Also update context for persistence
            setSubtitleMode(mode);
          },
          // Handle server-initiated custom overlay (tutor [SHOW: text] / [HIDE] commands)
          onCustomOverlay: (action, text) => {
            console.log('[OVERLAY] Server command:', action, text?.substring(0, 50));
            whiteboard.setCustomOverlayText(action === 'show' ? (text || null) : null);
          },
        });
        streamingConnectedRef.current = true;
        console.log('[STREAMING] Connected successfully');
        
        // Complete language handoff if we were in one
        // The parent chat.tsx manages the handoff overlay and conversation reset
        // We just signal that the new connection is ready
        if (isLanguageHandoffRef.current) {
          console.log('[STREAMING] Connection ready after language handoff - signaling completion');
          isLanguageHandoffRef.current = false;
          // Signal immediately - parent will handle the reset
          // No timeout needed since the parent's safety timeout handles edge cases
          onLanguageHandoffComplete?.();
        }
      } catch (err: any) {
        console.error('[STREAMING] Failed to connect:', err.message);
        streamingConnectedRef.current = false;
        // Don't silently fail - show error to user
        setError('Voice streaming connection failed. Retrying...');
        
        // Keep handoff flag set so next retry can trigger completion
        // The safety timeout in chat.tsx will handle cleanup if all retries fail
        // DON'T clear isLanguageHandoffRef here - let it persist for retries
      }
    };
    
    connectStreaming();
    
    return () => {
      if (streamingConnectedRef.current) {
        console.log('[STREAMING] Disconnecting...');
        streamingVoice.disconnect();
        streamingConnectedRef.current = false;
      }
    };
  // NOTE: `user?.id` (not `user`) is intentional — the effect guards on `userDetails` from the
  // query cache; using the full `user` object caused a spurious cleanup+disconnect every time
  // the auth context hydrated (~3s after mount), killing the active greeting session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, useStreamingMode, user?.id, language, difficulty, subtitleMode, onLanguageHandoffComplete, isExhausted, onInsufficientCredits]);
  
  // DEBUG: Log mic lockout state changes
  // CRITICAL: Use globalPlaybackState for accurate mic lock timing (avoids stale closure issues)
  useEffect(() => {
    // Include 'streaming' as valid - it means connection is active and audio is flowing
    const connValid = streamingVoice.state.connectionState === 'ready' || 
                      streamingVoice.state.connectionState === 'connected' ||
                      streamingVoice.state.connectionState === 'streaming';
    const isAudioActive = globalPlaybackState === 'playing' || globalPlaybackState === 'buffering';
    const isUsersTurn = connValid &&
      !streamingVoice.state.isSwitchingTutor &&
      (
        // PTT ACTIVE: If user is holding PTT button, keep mic active regardless of audio state
        isPttButtonHeld ||
        // Normal case: not processing and playback is idle (using globalPlaybackState for immediate response)
        (!isProcessing && !streamingVoice.state.isProcessing && !isAudioActive) ||
        (!!streamingVoice.state.error && !streamingVoice.state.isProcessing && globalPlaybackState === 'idle')
      );
    
    console.log(`[MIC LOCKOUT DEBUG] isUsersTurn=${isUsersTurn}`, {
      connectionState: streamingVoice.state.connectionState,
      connValid,
      isSwitchingTutor: streamingVoice.state.isSwitchingTutor,
      isProcessing,
      streamIsProcessing: streamingVoice.state.isProcessing,
      globalPlaybackState,
      hookPlaybackState: streamingVoice.state.playbackState,
      isAudioActive,
      error: !!streamingVoice.state.error,
      isPttButtonHeld,
    });
  }, [isProcessing, streamingVoice.state.connectionState, streamingVoice.state.isProcessing, 
      globalPlaybackState, streamingVoice.state.isSwitchingTutor, streamingVoice.state.error, isPttButtonHeld]);
  
  // UNIVERSAL MIC LOCKOUT FAILSAFE
  // Interval-based watchdog: checks every 5s whether mic has been locked too long.
  // Uses a monotonic "last voice activity" timestamp that only updates on actual pipeline
  // events (processing start, audio chunk, response_complete, playback state changes).
  // If mic is locked and no voice activity for 35s, force-resets ALL three mic-gating states.
  // 35s is intentionally above the observed worst-case brain latency (~23.6s) so the watchdog
  // never fires before the brain has had a chance to respond.
  const lastVoiceActivityRef = useRef<number>(Date.now());
  const MIC_LOCK_MAX_IDLE_MS = 35000;
  
  useEffect(() => {
    lastVoiceActivityRef.current = Date.now();
  }, [globalPlaybackState, streamingVoice.state.isProcessing]);
  
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const watchdogInterval = setInterval(() => {
      const currentPlayback = getGlobalPlaybackState();
      const isAudioActive = currentPlayback === 'playing' || currentPlayback === 'buffering';
      const isMicLocked = isProcessingRef.current || isAudioActive;
      
      if (!isMicLocked) return;
      
      const idleMs = Date.now() - lastVoiceActivityRef.current;
      if (idleMs >= MIC_LOCK_MAX_IDLE_MS) {
        console.warn(`[MIC WATCHDOG] Mic locked with no activity for ${Math.round(idleMs / 1000)}s — force-resetting ALL state`);
        setIsProcessing(false);
        isProcessingRef.current = false;
        setGlobalPlaybackState('idle');
        streamingVoice.forceResetProcessing?.();
        lastVoiceActivityRef.current = Date.now();
      }
    }, 5000);
    
    return () => clearInterval(watchdogInterval);
  }, [useStreamingMode, streamingVoice]);
  
  // Sync streaming voice state with component state
  // CRITICAL: Use globalPlaybackState from the global store, NOT streamingVoice.state.playbackState
  // The hook's internal useState has stale closure issues during HMR - global store is reliable
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const { isProcessing: streamProcessing, error: streamError, connectionState } = streamingVoice.state;
    
    // Update avatar state based on streaming state
    // Only show speaking when audio is ACTUALLY playing (not just processing)
    // Processing state should show a "thinking" indicator, not speaking avatar
    // NOTE: Don't override avatar state if greeting is currently playing (via REST)
    // USING GLOBAL PLAYBACK STATE - reliable source of truth that updates during HMR
    const isStreamingPlaying = globalPlaybackState === 'playing' || globalPlaybackState === 'buffering';
    
    // Debug: Log every time this effect runs with playback state changes
    console.log('[AVATAR SYNC DEBUG - GLOBAL STORE]', {
      globalPlaybackState,
      hookPlaybackState: streamingVoice.state.playbackState,
      isStreamingPlaying,
      avatarState,
      streamProcessing,
      isProcessingRef: isProcessingRef.current,
      currentPlayingMessageId,
      inputMode: inputModeRef.current,
    });
    
    // Check if we're in the middle of greeting playback (non-streaming)
    // If currentPlayingMessageId is set but we're not streaming, a greeting is playing
    const isGreetingPlaying = currentPlayingMessageId && !isStreamingPlaying && avatarState === 'speaking';
    
    if (isGreetingPlaying) {
      // Don't override greeting playback state
      console.log('[AVATAR SYNC DEBUG] Greeting guard triggered - returning early');
      return;
    }
    
    if (isStreamingPlaying) {
      // Audio is actually playing - show speaking state
      console.log('[AVATAR SYNC DEBUG] Setting avatarState to speaking');
      // Record when Daniela started speaking so barge-in echo guard can suppress
      // false interrupts from mic picking up speaker audio
      if (avatarStateRef.current !== 'speaking') {
        danielaSpeakingStartedAtRef.current = Date.now();
      }
      setAvatarState('speaking');
      
      // CRITICAL: Clear currentPlayingMessageId when streaming starts
      // This prevents stale greeting ID from blocking avatar state reset when streaming ends
      if (currentPlayingMessageId) {
        console.log('[AVATAR STATE] Streaming playing - clearing stale currentPlayingMessageId');
        setCurrentPlayingMessageId(null);
      }
      
      // Clear isProcessing now that audio is actually playing
      // This is safe because the avatar state logic prioritizes isStreamingPlaying over isProcessing
      // We NEED to clear it here so that when audio finishes, the avatar doesn't briefly
      // show "thinking" (which would happen if isProcessing was still true when playback ends)
      if (isProcessingRef.current) {
        console.log('[AVATAR SYNC] Audio playing - clearing deferred isProcessing');
        setIsProcessing(false);
        isProcessingRef.current = false;
      }
      if (isAwaitingResponseRef.current) {
        console.log('[AVATAR SYNC] Audio playing - clearing isAwaitingResponse');
        isAwaitingResponseRef.current = false;
      }
      
      // Mark that Daniela has spoken at least once this session
      hasDanielaSpokeOnceRef.current = true;
      // Stop ringing when audio starts playing (Daniela "picks up")
      stopRinging();
      // Clear the start-hint if it fired or is still pending — Daniela is here now
      if (startHintTimerRef.current) {
        clearTimeout(startHintTimerRef.current);
        startHintTimerRef.current = null;
      }
      setShowStartHint(false);
      // SAFETY: Clear processing timeout since response arrived
      if (openMicProcessingTimeoutRef.current) {
        clearTimeout(openMicProcessingTimeoutRef.current);
        openMicProcessingTimeoutRef.current = null;
      }
      // TRUE DUPLEX: Keep green light ON while Daniela speaks
      // Don't check openMicActiveRef - just show green if we're in open-mic mode
      if (inputModeRef.current === 'open-mic' && openMicState !== 'ready') {
        console.log('[OPEN MIC DUPLEX] Daniela speaking - showing green light (duplex mode)');
        setOpenMicState('ready');
      }
    } else if (streamProcessing || isProcessingRef.current) {
      // Processing but audio hasn't arrived yet — show thinking state
      setAvatarState('thinking');
    } else if (!streamProcessing && !isProcessingRef.current && !isAwaitingResponseRef.current) {
      // Not processing (hook) AND not processing (component) AND not awaiting response AND not playing
      // The isAwaitingResponseRef guard prevents the "thinking→listening→speaking" blip:
      // Without it, when streamProcessing clears but audio hasn't started yet, the avatar
      // briefly drops to "listening" before audio chunks arrive and push it to "speaking"
      
      // OPEN MIC: Show listening immediately when Daniela finishes speaking
      // CRITICAL: Only do this if Daniela has actually spoken at least once (prevents premature green light)
      if (inputModeRef.current === 'open-mic' && hasDanielaSpokeOnceRef.current) {
        console.log('[OPEN MIC] Playback finished - transitioning to listening');
        
        // IMMEDIATELY show listening state - don't wait for ref checks
        // This fixes the delay where avatar stays in idle/speaking for 4-10 seconds
        setOpenMicState('ready');
        setAvatarState('listening');
        
        // If session isn't active yet (rare race condition), start it
        if (!isRecordingRef.current || !openMicActiveRef.current) {
          console.log('[OPEN MIC] Session not fully active - ensuring it starts');
          if (startOpenMicRecordingRef.current) {
            startOpenMicRecordingRef.current().catch((err: any) => {
              console.error('[OPEN MIC] Failed to ensure session after playback:', err);
            });
          }
        }
      } else {
        // Not in open mic mode or Daniela hasn't spoken yet - go to idle
        setAvatarState('idle');
      }
    }
    // Note: When streamProcessing is true but not playing yet, 
    // avatar stays in current state (idle/listening) until audio actually starts
    
    // Handle streaming errors - only reset processing on CONNECTION-level errors
    // Non-fatal audio playback errors (e.g. "Failed to load because no supported source was found"
    // from 0-byte end-marker audio chunks) should NOT clear isProcessing or avatar state
    if (streamError) {
      const isConnectionError = connectionState === 'error' || connectionState === 'disconnected';
      
      if (isConnectionError) {
        console.error('[STREAMING] Connection error:', streamError);
        if (isProcessingRef.current) {
          setIsProcessing(false);
          isProcessingRef.current = false;
          setProcessingStage(null);
        }
        setAvatarState('idle');
        setError(streamError);
        streamingConnectedRef.current = false;
        if (isLanguageHandoffRef.current) {
          console.log('[STREAMING] Error during language handoff - resetting flag');
          isLanguageHandoffRef.current = false;
        }
      } else {
        console.warn('[STREAMING] Non-fatal error (not clearing processing state):', streamError);
      }
    }
    
    // Handle disconnects during handoff
    if (connectionState === 'disconnected' && isLanguageHandoffRef.current) {
      console.log('[STREAMING] Disconnected during language handoff - resetting flag');
      isLanguageHandoffRef.current = false;
    }
    
    // Clear error when connection recovers
    if (connectionState === 'connected' && streamingConnectedRef.current === false) {
      streamingConnectedRef.current = true;
      setError(null);
    }
  }, [streamingVoice.state, useStreamingMode, globalPlaybackState]);
  
  // Update lastMessageId for replay when streaming completes and messages are refreshed
  useEffect(() => {
    // When we have a lastAudioBlob but no lastMessageId, find the latest assistant message
    if (lastAudioBlob && !lastMessageId && messages.length > 0) {
      const latestAssistantMessage = [...messages]
        .reverse()
        .find(m => m.role === 'assistant');
      if (latestAssistantMessage) {
        console.log('[STREAMING] Setting lastMessageId for replay:', latestAssistantMessage.id);
        setLastMessageId(latestAssistantMessage.id);
      }
    }
  }, [lastAudioBlob, lastMessageId, messages]);

  // Initialize audio player
  useEffect(() => {
    audioPlayerRef.current = new Audio();
    return () => {
      audioPlayerRef.current?.pause();
      audioPlayerRef.current = null;
    };
  }, []);
  
  // Pre-warm Deepgram and TTS connections to avoid cold-start latency
  useEffect(() => {
    const warmServices = async () => {
      // Warm both services in parallel for faster startup
      const warmDeepgram = fetch('/api/voice/warm', {
        method: 'POST',
        credentials: 'include',
      }).then(res => res.json()).then(data => {
        if (data.warmed) {
          console.log(`[VOICE] Deepgram pre-warmed in ${data.latency}ms`);
        }
      }).catch(() => {
        console.log('[VOICE] Deepgram pre-warming skipped');
      });
      
      const warmTts = fetch('/api/voice/warm-tts', {
        method: 'POST',
        credentials: 'include',
      }).then(res => res.json()).then(data => {
        if (data.warmed) {
          console.log(`[VOICE] TTS pre-warmed in ${data.latency}ms`);
        }
      }).catch(() => {
        console.log('[VOICE] TTS pre-warming skipped');
      });
      
      await Promise.all([warmDeepgram, warmTts]);
    };
    warmServices();
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    const client = getStreamingVoiceClient();
    client.warmUp(conversationId);
  }, [conversationId]);

  // Cleanup on unmount or conversation change
  useEffect(() => {
    return () => {
      console.log('[CLEANUP] Cleaning up voice recording resources...');
      cleanupRecording();
    };
  }, [conversationId]);

  // Note: Auto-scroll is handled by VoiceChatViewManager which renders the message list

  // Process streaming text through whiteboard to extract markup
  // The tutor may include [WRITE]...[/WRITE] tags for visual teaching aids
  useEffect(() => {
    if (!useStreamingMode) return;
    
    const currentText = streamingVoice.subtitles.state.currentSentenceText;
    if (currentText) {
      whiteboard.processMessage(currentText);
    }
  }, [useStreamingMode, streamingVoice.subtitles.state.currentSentenceText]);
  
  // Clear whiteboard when conversation changes
  useEffect(() => {
    whiteboard.clear();
  }, [conversationId]);

  // Request AI-generated streaming greeting for new conversations
  // When streaming mode is enabled, we use the streaming pipeline for dynamic greetings
  // that are ACTFL-aware, personalized, and context-aware
  // Store the full lockKey (including -resumed suffix) to prevent duplicate triggers
  // Initialize from sessionStorage to survive HMR/remounts
  const getStoredGreetingKey = (): string | null => {
    try {
      return sessionStorage.getItem(GREETING_MESSAGE_KEY);
    } catch {
      return null;
    }
  };
  const greetingRequestedRef = useRef<string | null>(getStoredGreetingKey());
  // Settling delay timer — cleared on each effect re-run to cancel stale pending greetings
  const greetingSettlingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Handle resume flag clearing even if connection isn't ready - prevents re-triggering
  useEffect(() => {
    if (isResumedConversation && conversationId && onResumeHandled) {
      // Clear resume flag immediately when we detect a resume attempt
      // This prevents duplicate welcome-back greetings on component remounts
      const lockKey = `streaming-greeting-${conversationId}-resumed`;
      if (greetingRequestedRef.current === lockKey) {
        console.log('[STREAMING GREETING] Resume already handled for this conversation');
        onResumeHandled();
      }
    }
  }, [isResumedConversation, conversationId, onResumeHandled]);
  
  useEffect(() => {
    // Cancel any pending settling timeout from a previous effect run
    if (greetingSettlingTimeoutRef.current) {
      clearTimeout(greetingSettlingTimeoutRef.current);
      greetingSettlingTimeoutRef.current = null;
    }

    // Only for streaming mode
    if (!useStreamingMode) return;
    
    // Wait for streaming connection to be ready
    const { connectionState } = streamingVoice.state;
    if (connectionState !== 'ready') return;
    
    // Need conversation and user data
    if (!conversationId || !userDetails) return;
    
    // Don't request if recording or processing
    if (isRecording || isProcessing) return;
    
    // NOTE on reconnected sessions: Previously we skipped the greeting entirely here to
    // prevent double audio on legacy-pipeline reconnects. That guard has been moved server-side
    // (the server suppresses request_greeting for legacy sessions but allows it for GL sessions).
    // GL is always a fresh WebSocket after reconnect — without a greeting Daniela waits silently.
    // The greeting lock is cleared in onReconnected so this effect can re-fire after reconnect.
    const client = getStreamingVoiceClient();
    if (client.isReconnectedSession) {
      console.log('[STREAMING GREETING] Reconnected session — allowing greeting (server-side guard handles legacy vs GL)');
    }
    
    // Check if this is a new conversation (no messages yet, or only AI greeting placeholder)
    const aiMessages = messages.filter(m => m.role === 'assistant');
    const userMessages = messages.filter(m => m.role === 'user');
    
    // Request greeting if: new conversation (no user messages) OR resuming a past conversation
    // OR just reconnected mid-session (GL always needs an orientation turn after reconnect)
    const isNewConversation = userMessages.length === 0 && aiMessages.length <= 1;
    const isReconnectGreeting = needsGreetingAfterReconnectRef.current;
    const shouldGreet = isNewConversation || isResumedConversation || isReconnectGreeting;
    
    if (shouldGreet) {
      // ATOMICALLY try to acquire lock (using full lock key including -resumed/-reconnect suffix)
      // This prevents double-greetings on mobile reloads and fast switching
      const lockKey = `streaming-greeting-${conversationId}${isResumedConversation ? '-resumed' : isReconnectGreeting ? '-reconnect' : ''}`;
      
      // Check if we already requested greeting for this exact lockKey (handles both new and resumed)
      if (greetingRequestedRef.current === lockKey) {
        console.log('[STREAMING GREETING] Already requested for this lock key:', lockKey);
        return;
      }
      
      // Try to acquire the lock
      if (!tryAcquireGreetingLock(lockKey)) {
        console.log('[STREAMING GREETING] Lock not acquired - skipping');
        // Still clear resume flag to prevent retry loops
        if (isResumedConversation && onResumeHandled) {
          onResumeHandled();
        }
        return;
      }
      
      // Mark as requested using full lockKey to distinguish new vs resumed vs reconnect
      greetingRequestedRef.current = lockKey;
      hasPlayedGreetingRef.current = lockKey;
      
      // Clear the reconnect flag — it's a one-shot trigger
      if (isReconnectGreeting) {
        needsGreetingAfterReconnectRef.current = false;
      }
      
      const greetingType = isResumedConversation ? 'RESUMED (welcome-back)' : isReconnectGreeting ? 'RECONNECT (continuing)' : 'NEW conversation';
      console.log(`[STREAMING GREETING] Requesting ${greetingType} AI-generated personalized greeting...`);
      
      // Pick up any pending scenario slug (set when navigating from scenario browser)
      const pendingScenarioSlug = sessionStorage.getItem('pending_scenario_slug') || undefined;
      if (pendingScenarioSlug) {
        sessionStorage.removeItem('pending_scenario_slug');
        console.log('[STREAMING GREETING] Passing pending scenario slug to greeting:', pendingScenarioSlug);
      }
      
      // Request greeting through the streaming pipeline
      // The server will generate an ACTFL-aware, history-aware greeting
      // For resumed/reconnected conversations, it will generate a contextual "welcome back" message
      // isResumed=true on reconnect so Daniela continues naturally rather than re-introducing herself
      const isResumedForGreeting = isResumedConversation || isReconnectGreeting;

      greetingSettlingTimeoutRef.current = setTimeout(() => {
        greetingSettlingTimeoutRef.current = null;
        streamingVoice.requestGreeting(userDetails.firstName ?? undefined, isResumedForGreeting, pendingScenarioSlug);

        // UI FALLBACK HINT: If greeting audio hasn't arrived within 5s, stop ringing and
        // show a subtle "She's ready — say hello" prompt so the student knows what to do.
        if (startHintTimerRef.current) clearTimeout(startHintTimerRef.current);
        startHintTimerRef.current = setTimeout(() => {
          startHintTimerRef.current = null;
          if (!hasDanielaSpokeOnceRef.current) {
            console.warn('[GREETING HINT] No audio after 5s — stopping ringing + showing start hint');
            stopRinging();
            setShowStartHint(true);
          }
        }, 5000);
      }, 0);
      
      // Mark resume as handled so we don't keep triggering it
      if (isResumedConversation && onResumeHandled) {
        onResumeHandled();
      }
      
      // Clear lock after a delay to allow for the greeting to play
      setTimeout(() => {
        clearGreetingLock();
      }, 5000);
    }
  }, [
    useStreamingMode, 
    streamingVoice.state.connectionState, 
    conversationId, 
    userDetails, 
    messages, 
    isRecording, 
    isProcessing, 
    streamingVoice,
    isResumedConversation,
    onResumeHandled
  ]);
  
  // Fallback: REST-based greeting for non-streaming mode only
  useEffect(() => {
    // Skip if streaming mode is enabled (streaming handles greeting)
    if (useStreamingMode) return;
    
    // Only process if we have messages and conversation ID
    if (!conversationId || !messages || messages.length === 0) return;
    
    // Don't play greeting if already recording or processing
    if (isRecording || isProcessing) return;
    
    // Check if this is a new conversation with just a greeting (1 AI message, no user messages)
    const aiMessages = messages.filter(m => m.role === 'assistant');
    const userMessages = messages.filter(m => m.role === 'user');
    
    if (aiMessages.length === 1 && userMessages.length === 0) {
      const greetingMessage = aiMessages[0];
      const greetingConversationId = conversationId; // Capture for closure
      
      // ATOMICALLY try to acquire lock - this checks:
      // 1. If we already synthesized this exact message ID (module-level + sessionStorage)
      // 2. If another synthesis is in progress (sync lock)
      // 3. If cooldown is active (30 second timer)
      if (!tryAcquireGreetingLock(greetingMessage.id)) {
        console.log('[VOICE GREETING] Skipping - lock not acquired');
        return;
      }
      
      // Also mark in ref for same-instance checks
      hasPlayedGreetingRef.current = greetingMessage.id;
      
      // Generate TTS for the greeting (but don't change state yet)
      // KARAOKE ENABLED: Cartesia Sonic-3 provides estimated word timings for highlighting
      const needTimings = subtitleMode !== "off";
      console.log(`[VOICE GREETING] Generating greeting audio for new conversation (karaoke: ${needTimings})`);
      
      // Use target language voice for consistency (Spanish voice speaks English = Spanish accent)
      // This gives immersive learning experience from the very first word
      // Use friendly emotion for warm greeting (no AI-selected emotion available for initial greeting)
      synthesizeSpeech(greetingMessage.content, language, undefined, undefined, needTimings, 'friendly')
        .then(result => {
          const audioBlob = result.audioBlob;
          // Use refs to check current state (not stale closure values)
          // Don't play if:
          // 1. User started recording or processing
          // 2. Conversation changed
          if (isRecordingRef.current || isProcessingRef.current) {
            console.log('[VOICE GREETING] Skipping playback - user is now recording/processing');
            return;
          }
          
          if (currentConversationRef.current !== greetingConversationId) {
            console.log('[VOICE GREETING] Skipping playback - conversation changed');
            return;
          }
          
          if (audioPlayerRef.current) {
            // CRITICAL: Stop any existing audio playback first
            // This prevents two voices playing simultaneously
            audioPlayerRef.current.pause();
            audioPlayerRef.current.currentTime = 0;
            
            const audioUrl = URL.createObjectURL(audioBlob);
            audioPlayerRef.current.src = audioUrl;
            
            // Rescale word timings to match actual audio duration for precise karaoke sync
            audioPlayerRef.current.onloadedmetadata = () => {
              if (result.wordTimings && result.wordTimings.length > 0 && audioPlayerRef.current) {
                const actualDuration = audioPlayerRef.current.duration;
                const estimatedDuration = result.wordTimings[result.wordTimings.length - 1].endTime;
                
                if (actualDuration && estimatedDuration && Math.abs(actualDuration - estimatedDuration) > 0.1) {
                  const scale = actualDuration / estimatedDuration;
                  const rescaledTimings = result.wordTimings.map(timing => ({
                    word: timing.word,
                    startTime: timing.startTime * scale,
                    endTime: Math.min(timing.endTime * scale, actualDuration),
                  }));
                  wordTimingsMapRef.current.set(greetingMessage.id, rescaledTimings);
                  console.log(`[VOICE GREETING] Rescaled timings: ${estimatedDuration.toFixed(2)}s → ${actualDuration.toFixed(2)}s`);
                } else if (subtitleMode !== "off") {
                  wordTimingsMapRef.current.set(greetingMessage.id, result.wordTimings);
                  console.log('[VOICE GREETING] Stored word timings:', greetingMessage.id, result.wordTimings.length, 'words');
                }
              }
            };
            
            // Track if we've already cleaned up (to prevent double cleanup)
            let hasCleanedUp = false;
            let fallbackTimer: NodeJS.Timeout | null = null;
            
            const cleanup = () => {
              if (hasCleanedUp) return;
              hasCleanedUp = true;
              if (fallbackTimer) clearTimeout(fallbackTimer);
              URL.revokeObjectURL(audioUrl);
              setAvatarState('idle');
              setCurrentPlayingMessageId(null);
              clearGreetingLock();
              console.log('[VOICE GREETING] Cleaned up and returned to idle');
            };
            
            audioPlayerRef.current.onended = cleanup;
            audioPlayerRef.current.onerror = cleanup;
            
            // Use 'onplaying' event to set avatar state - fires when audio ACTUALLY starts
            // This is more accurate than setting state before play() call
            audioPlayerRef.current.onplaying = () => {
              console.log('[VOICE GREETING] Audio actually started - setting avatar to speaking');
              setAvatarState('speaking');
            };
            
            // Set current playing message ID (for subtitle sync) but NOT avatar state yet
            setCurrentPlayingMessageId(greetingMessage.id);
            
            audioPlayerRef.current.play()
              .then(() => {
                console.log('[VOICE GREETING] Greeting audio playing');
                // MOBILE FIX: Add fallback timer in case onended doesn't fire
                // Estimate duration from audio blob size (roughly 16KB/second for MP3)
                const estimatedDurationMs = Math.max(5000, (audioBlob.size / 16) + 2000);
                fallbackTimer = setTimeout(() => {
                  if (!hasCleanedUp) {
                    console.log('[VOICE GREETING] Fallback timer triggered - resetting avatar state');
                    cleanup();
                  }
                }, estimatedDurationMs);
              })
              .catch(err => {
                console.error('[VOICE GREETING] Failed to play greeting:', err);
                cleanup();
              });
          }
        })
        .catch(err => {
          console.error('[VOICE GREETING] Failed to generate greeting audio:', err);
          clearGreetingLock(); // Clear lock on synthesis failure
        });
    }
  }, [useStreamingMode, messages, conversationId, language, isProcessing, isRecording, subtitleMode]);

  // Enter key keyboard shortcut for mic button (hold to talk)
  // Using refs to avoid cleanup-triggered premature stops during React re-renders
  const recordingStartTimeRef = useRef<number | null>(null);
  const isKeyboardHeldRef = useRef(false); // Track if Enter key is physically held
  const MIN_RECORDING_DURATION_MS = 500; // Minimum 500ms to avoid empty recordings
  
  // Keep existing refs in sync with state for stable keyboard handlers
  // (refs are already declared earlier in the component)
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { inputModeRef.current = inputMode; }, [inputMode]);
  useEffect(() => { isPlayingRef.current = avatarState === 'speaking'; }, [avatarState]);

  // Task #32: Publish voice status to DanielaSessionContext so FloatingVoiceWidget shows live state
  const { publishVoiceStatus } = useDanielaSession();
  useEffect(() => {
    publishVoiceStatus(deriveVoiceStatus(avatarState, streamingVoice.state.connectionState));
  }, [avatarState, streamingVoice.state.connectionState, publishVoiceStatus]);
  // NOTE: We intentionally do NOT reset voiceStatus to 'idle' on unmount.
  // The widget should continue to show the last known active state while the
  // student browses other pages.  voiceStatus is reset to 'idle' in
  // DanielaSessionContext when sessionConversationId becomes null (session ends).
  
  // Track playbackState for guards - 'buffering' happens before 'playing'
  // This catches speculative PTT audio earlier than avatarState
  // CRITICAL: Use globalPlaybackState for reliability during HMR
  const playbackStateRef = useRef<string>('idle');
  useEffect(() => { 
    console.log('[STREAMING VOICE CHAT DEBUG] playbackState changed:', globalPlaybackState);
    playbackStateRef.current = globalPlaybackState; 
  }, [globalPlaybackState]);

  // Stable keyboard handlers that use refs instead of state (no dependency churn)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only enable in push-to-talk mode
      if (inputModeRef.current !== 'push-to-talk') return;
      
      // Only trigger if Enter is pressed
      if (event.code !== 'Enter') return;
      
      // Ignore key repeat events (holding Enter)
      if (event.repeat) return;
      
      // Don't trigger if user is typing in any text input element
      const target = event.target as HTMLElement;
      const activeElement = document.activeElement as HTMLElement;
      
      const isTextInput = (el: HTMLElement | null) => {
        if (!el) return false;
        const tagName = el.tagName?.toUpperCase();
        return (
          tagName === 'INPUT' || 
          tagName === 'TEXTAREA' || 
          el.isContentEditable ||
          el.getAttribute('role') === 'textbox' ||
          el.closest('[contenteditable="true"]') !== null ||
          el.closest('input, textarea, [role="textbox"]') !== null
        );
      };
      
      if (isTextInput(target) || isTextInput(activeElement)) return;
      
      // Don't trigger if no conversation or processing
      if (!currentConversationRef.current || isProcessingRef.current) return;
      
      // BARGE-IN: If audio is playing, interrupt AND start recording in one keypress
      if (playbackStateRef.current !== 'idle') {
        console.log(`[KEYBOARD] Barge-in: interrupt + record - playbackState='${playbackStateRef.current}'`);
        streamingVoice.stop();
        streamingVoice.sendInterrupt();
      }
      
      // Prevent default behavior
      event.preventDefault();
      
      // Mark keyboard as held BEFORE starting recording
      isKeyboardHeldRef.current = true;
      
      // Start recording on keydown (if not already recording)
      if (!isRecordingRef.current) {
        console.log('[KEYBOARD] Enter pressed - starting recording, isKeyboardHeld=true');
        recordingStartTimeRef.current = Date.now();
        startPushToTalkRecording('keyboard');
      }
    };
    
    const handleKeyUp = (event: KeyboardEvent) => {
      // Only trigger if Enter is released
      if (event.code !== 'Enter') return;
      
      // CRITICAL: Only process if keyboard was actually being held by us
      if (!isKeyboardHeldRef.current) {
        console.log('[KEYBOARD] Enter keyup ignored - keyboard was not held by PTT');
        return;
      }
      
      // Don't trigger if user is typing in any text input element
      const target = event.target as HTMLElement;
      const activeElement = document.activeElement as HTMLElement;
      
      const isTextInput = (el: HTMLElement | null) => {
        if (!el) return false;
        const tagName = el.tagName?.toUpperCase();
        return (
          tagName === 'INPUT' || 
          tagName === 'TEXTAREA' || 
          el.isContentEditable ||
          el.getAttribute('role') === 'textbox' ||
          el.closest('[contenteditable="true"]') !== null ||
          el.closest('input, textarea, [role="textbox"]') !== null
        );
      };
      
      if (isTextInput(target) || isTextInput(activeElement)) return;
      
      // ALWAYS stop recording on keyup - the guard is on keydown not keyup
      // We want to let the user release normally even during speculative PTT
      
      // Mark keyboard as released
      isKeyboardHeldRef.current = false;
      
      // Stop recording on keyup (if recording)
      if (isRecordingRef.current || isPttButtonHeldRef.current) {
        const recordingDuration = recordingStartTimeRef.current 
          ? Date.now() - recordingStartTimeRef.current 
          : 0;
        
        // Ensure minimum recording time to avoid empty recordings
        if (recordingDuration < MIN_RECORDING_DURATION_MS) {
          const remainingTime = MIN_RECORDING_DURATION_MS - recordingDuration;
          console.log(`[KEYBOARD] Recording too short (${recordingDuration}ms), waiting ${remainingTime}ms`);
          setTimeout(() => {
            console.log('[KEYBOARD] Enter released - stopping recording (delayed)');
            recordingStartTimeRef.current = null;
            stopPushToTalkRecording('keyboard');
          }, remainingTime);
        } else {
          console.log('[KEYBOARD] Enter released - stopping recording');
          recordingStartTimeRef.current = null;
          stopPushToTalkRecording('keyboard');
        }
      }
    };

    // Add stable event listeners (empty dependency array - never re-attached)
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    // Cleanup only on unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []); // Empty deps - handlers use refs, not state

  const cleanupRecording = () => {
    console.log('[CLEANUP] Cleaning up recording resources...');
    
    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    
    // Stop all media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Clean up silence detection
    if (silenceCheckIntervalRef.current) {
      clearInterval(silenceCheckIntervalRef.current);
      silenceCheckIntervalRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    analyserRef.current = null;
    
    setIsRecording(false);
    isRecordingRef.current = false; // Update ref immediately
  };

  const setupSilenceDetection = (stream: MediaStream) => {
    try {
      // Create audio context and analyser
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      microphone.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      // Thresholds
      const SILENCE_THRESHOLD = 10; // Volume below this is considered silence (0-255 scale)
      const SILENCE_DURATION = 2000; // 2 seconds of silence triggers auto-stop
      
      let silenceStartTime: number | null = null;
      
      // Check audio level every 100ms
      silenceCheckIntervalRef.current = setInterval(() => {
        if (!isRecordingRef.current) {
          // Stopped recording externally, cleanup
          if (silenceCheckIntervalRef.current) {
            clearInterval(silenceCheckIntervalRef.current);
            silenceCheckIntervalRef.current = null;
          }
          return;
        }
        
        analyser.getByteTimeDomainData(dataArray);
        
        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          const value = Math.abs(dataArray[i] - 128); // Center around 0
          sum += value;
        }
        const average = sum / bufferLength;
        
        // Check if silent
        if (average < SILENCE_THRESHOLD) {
          if (silenceStartTime === null) {
            silenceStartTime = Date.now();
            console.log('[SILENCE DETECTION] Silence started');
          } else {
            const silenceDuration = Date.now() - silenceStartTime;
            if (silenceDuration >= SILENCE_DURATION) {
              console.log('[SILENCE DETECTION] 2 seconds of silence detected - auto-stopping');
              stopRecording();
            }
          }
        } else {
          // Reset silence timer if sound detected
          if (silenceStartTime !== null) {
            console.log('[SILENCE DETECTION] Sound detected - resetting silence timer');
          }
          silenceStartTime = null;
        }
      }, 100); // Check every 100ms
      
    } catch (err) {
      console.error('[SILENCE DETECTION] Failed to setup:', err);
      // Continue recording without silence detection
    }
  };

  const startRecording = async () => {
    if (isRecording) return;
    
    // Block recording if credits are exhausted
    if (isExhausted) {
      console.log('[RECORDING] Blocked - credits exhausted');
      if (onInsufficientCredits) {
        onInsufficientCredits();
      }
      return;
    }
    
    try {
      setError(null);
      
      
      // Capture conversation ID for this session
      const recordingConversationId = conversationId;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      // Determine best available audio codec for MediaRecorder
      // Try opus first (best for speech), fallback to vorbis, then generic webm
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=vorbis')) {
        mimeType = 'audio/webm;codecs=vorbis';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      }
      console.log('[RECORDING] Using audio codec:', mimeType);
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
      });
      
      // Isolated state for this recording session
      const recordingChunks: Blob[] = [];
      const sessionStream = stream; // Capture in closure
      const sessionRecorder = mediaRecorder; // Capture in closure
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunks.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        console.log('[RECORDER] Stopped, processing audio...');
        
        // Check if this is still the active session
        const isActiveSession = mediaRecorderRef.current === sessionRecorder;
        
        // Session-safe cleanup: only touch resources that belong to THIS session
        sessionStream.getTracks().forEach(track => track.stop());
        
        // Clean up silence detection resources IMMEDIATELY after stop
        if (silenceCheckIntervalRef.current) {
          clearInterval(silenceCheckIntervalRef.current);
          silenceCheckIntervalRef.current = null;
          console.log('[CLEANUP] Cleared silence detection interval');
        }
        
        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
          console.log('[CLEANUP] Closed AudioContext');
        }
        
        analyserRef.current = null;
        
        // Only touch shared state if this is still the active session
        if (isActiveSession) {
          mediaRecorderRef.current = null;
          streamRef.current = null;
          setIsRecording(false);
          isRecordingRef.current = false; // Update ref immediately
          // DON'T set avatarState to 'idle' here - let processRecording manage it
          // This prevents flickering between listening → idle → speaking
          
        } else {
          console.log('[RECORDER] Session superseded - new recording already started');
        }
        
        // Build audio blob from this session's chunks
        const audioBlob = new Blob(recordingChunks, { type: 'audio/webm' });
        
        // Check if conversation changed by comparing to current ref value
        const currentConv = currentConversationRef.current;
        
        if (recordingConversationId === currentConv && recordingConversationId && isActiveSession) {
          console.log('[RECORDER] Processing audio for conversation:', recordingConversationId);
          await processRecording(audioBlob, recordingConversationId);
        } else {
          console.log('[RECORDER] Discarding audio - conversation changed or session superseded');
          // Only set idle when discarding - processRecording handles its own state
          setAvatarState('idle');
        }
      };
      
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
      isRecordingRef.current = true; // Update ref immediately
      setAvatarState('listening');
      
      // Start silence detection for auto-stop
      console.log('[VOICE] Starting silence detection');
      setupSilenceDetection(stream);
    } catch (err: any) {
      console.error('Failed to start recording:', err);
      setError(err.message || 'Failed to access microphone');
      cleanupRecording();
    }
  };

  const stopRecording = () => {
    console.log('[STOP] Stopping recording...');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      // Note: actual cleanup happens in onstop handler
    } else {
      // If recorder already inactive, cleanup manually
      cleanupRecording();
    }
  };

  // Push-to-talk mode: Hold down to record, release to stop
  const startPushToTalkRecording = async (inputType: 'mouse' | 'touch' | 'keyboard' = 'mouse') => {
    const startTime = performance.now();
    console.log('[PUSH-TO-TALK] Button pressed at', startTime.toFixed(0), 'ms, inputType:', inputType);
    
    if (isRecording || isMicPreparing) {
      console.log('[PUSH-TO-TALK] Already recording or preparing, ignoring');
      return;
    }
    
    try {
      setError(null);
      
      // Track that button is being held (for stable instruction text)
      // Use both state (for UI) and ref (for synchronous guards)
      console.log('[PTT-STATE-DEBUG] Setting isPttButtonHeld=TRUE at', new Date().toISOString());
      setIsPttButtonHeld(true);
      isPttButtonHeldRef.current = true;
      activeInputTypeRef.current = inputType;
      
      // Mark that recording was requested - for race condition prevention
      recordingRequestedRef.current = true;
      
      // Capture conversation ID for this session
      const recordingConversationId = conversationId;
      
      let stream: MediaStream;
      
      // Use cached stream for INSTANT recording if available
      // Must verify: stream active AND at least one audio track is live and enabled
      const cachedStream = cachedStreamRef.current;
      const audioTracks = cachedStream?.getAudioTracks() || [];
      const hasLiveTrack = audioTracks.some(track => 
        track.readyState === 'live' && track.enabled && !track.muted
      );
      
      console.log('[PUSH-TO-TALK] Cached stream status:', {
        exists: !!cachedStream,
        active: cachedStream?.active,
        trackCount: audioTracks.length,
        trackStates: audioTracks.map(t => ({ readyState: t.readyState, enabled: t.enabled, muted: t.muted })),
        hasLiveTrack
      });
      
      if (cachedStream && cachedStream.active && hasLiveTrack) {
        console.log('[PUSH-TO-TALK] Using cached stream - INSTANT start! (+' + (performance.now() - startTime).toFixed(0) + 'ms)');
        stream = cachedStream;
        cachedStreamRef.current = null; // Will re-warm after recording
        // No preparing state needed - jump straight to recording!
      } else {
        // Cached stream unusable - dispose of it if exists
        if (cachedStream) {
          console.log('[PUSH-TO-TALK] Cached stream unusable, disposing...');
          cachedStream.getTracks().forEach(track => track.stop());
          cachedStreamRef.current = null;
        }
        // No cached stream - show preparing state and request new one
        console.log('[PUSH-TO-TALK] No cached stream, requesting microphone... (+' + (performance.now() - startTime).toFixed(0) + 'ms)');
        setIsMicPreparing(true);
        
        const micStartTime = performance.now();
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('[PUSH-TO-TALK] getUserMedia completed in', (performance.now() - micStartTime).toFixed(0), 'ms');
        
        // Check if user released the button while we were waiting for microphone
        if (!recordingRequestedRef.current) {
          console.log('[PUSH-TO-TALK] Button released before mic ready - aborting');
          stream.getTracks().forEach(track => track.stop());
          setIsMicPreparing(false);
          return;
        }
        
        setIsMicPreparing(false);
      }
      
      streamRef.current = stream;
      
      // DIAGNOSTIC: Log audio track capabilities and settings
      const tracks = stream.getAudioTracks();
      console.log('[PTT DIAGNOSTIC] Audio tracks:', tracks.length);
      tracks.forEach((track, i) => {
        const settings = track.getSettings();
        const constraints = track.getConstraints();
        const capabilities = track.getCapabilities ? track.getCapabilities() : 'N/A';
        console.log(`[PTT DIAGNOSTIC] Track ${i} settings:`, settings);
        console.log(`[PTT DIAGNOSTIC] Track ${i} constraints:`, constraints);
        console.log(`[PTT DIAGNOSTIC] Track ${i} capabilities:`, capabilities);
        console.log(`[PTT DIAGNOSTIC] Track ${i} state:`, {
          readyState: track.readyState,
          enabled: track.enabled,
          muted: track.muted,
          label: track.label,
          id: track.id,
        });
      });
      
      // Determine best available audio codec for MediaRecorder
      // Try opus first (best for speech), fallback to vorbis, then generic webm
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=vorbis')) {
        mimeType = 'audio/webm;codecs=vorbis';
      } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
        mimeType = 'audio/ogg;codecs=opus';
      }
      console.log('[RECORDING] Using audio codec:', mimeType);
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
      });
      
      // DIAGNOSTIC: Log MediaRecorder state
      console.log('[PTT DIAGNOSTIC] MediaRecorder created:', {
        mimeType: mediaRecorder.mimeType,
        state: mediaRecorder.state,
        audioBitsPerSecond: mediaRecorder.audioBitsPerSecond,
      });
      
      // Isolated state for this recording session
      const recordingChunks: Blob[] = [];
      const sessionStream = stream; // Capture in closure
      const sessionRecorder = mediaRecorder; // Capture in closure
      let chunkCount = 0; // DIAGNOSTIC: Track chunk count
      
      mediaRecorder.ondataavailable = (event) => {
        chunkCount++;
        console.log(`[PTT DIAGNOSTIC] ondataavailable #${chunkCount}: size=${event.data.size} bytes, type=${event.data.type}`);
        if (event.data.size > 0) {
          recordingChunks.push(event.data);
        } else {
          console.warn('[PTT DIAGNOSTIC] WARNING: Received empty chunk!');
        }
      };
      
      mediaRecorder.onstop = async () => {
        // DIAGNOSTIC: Log final chunk stats
        const totalChunkBytes = recordingChunks.reduce((sum, chunk) => sum + chunk.size, 0);
        const trackStatesOnStop = sessionStream.getAudioTracks().map(t => ({
          readyState: t.readyState,
          enabled: t.enabled,
          muted: t.muted,
        }));
        console.log('[PTT DIAGNOSTIC] Recording stopped:', {
          chunkCount,
          totalChunkBytes,
          trackStatesOnStop,
          recorderState: sessionRecorder.state,
        });
        
        console.log('[PUSH-TO-TALK] Stopped, processing audio...');
        
        // IMMEDIATELY reset subtitles to prevent phantom subtitle flash
        // This must happen FIRST, before any other state changes
        // The ref-based isWaitingForContent flag ensures subtitles hide synchronously
        if (streamingConnectedRef.current) {
          console.log('[PUSH-TO-TALK] Resetting subtitles immediately');
          streamingVoice.subtitles.reset();
        }
        
        // Check if this is still the active session
        const isActiveSession = mediaRecorderRef.current === sessionRecorder;
        
        // Session-safe cleanup: only touch resources that belong to THIS session
        sessionStream.getTracks().forEach(track => track.stop());
        
        // Only touch shared state if this is still the active session
        if (isActiveSession) {
          mediaRecorderRef.current = null;
          streamRef.current = null;
          // CRITICAL: Set both isRecording=false AND isProcessing=true in the SAME sync batch
          // This prevents a render gap where neither guard is active (causing phantom subtitles)
          // The phantom appears as black text when isRecording=false but isProcessing hasn't been set yet
          setIsRecording(false);
          setIsProcessing(true); // Set immediately - no gap between recording and processing
          isRecordingRef.current = false;
          isProcessingRef.current = true; // Update ref immediately for sync checks
          // DON'T set avatarState to 'idle' here - let processRecording manage it
          // This prevents flickering between listening → idle → speaking
          
        } else {
          console.log('[PUSH-TO-TALK] Session superseded - new recording already started');
        }
        
        // Re-warm microphone for next instant recording (don't await - do in background)
        if (!cachedStreamRef.current) {
          navigator.mediaDevices.getUserMedia({ audio: true })
            .then(newStream => {
              cachedStreamRef.current = newStream;
              console.log('[MIC WARMUP] Re-warmed for next recording');
            })
            .catch(err => {
              console.log('[MIC WARMUP] Failed to re-warm:', err);
            });
        }
        
        // Build audio blob from this session's chunks
        const audioBlob = new Blob(recordingChunks, { type: 'audio/webm' });
        
        // DIAGNOSTIC: Log final blob details
        console.log('[PTT DIAGNOSTIC] Final blob:', {
          size: audioBlob.size,
          type: audioBlob.type,
          chunksUsed: recordingChunks.length,
        });
        
        // Check if conversation changed by comparing to current ref value
        const currentConv = currentConversationRef.current;
        
        // CRITICAL FIX: Skip audio blob processing if ptt_release was already sent
        // This prevents double AI response (one from transcript, one from audio blob)
        if (pttReleaseSentRef.current) {
          console.log('[PUSH-TO-TALK] SKIP audio blob - ptt_release already sent transcript to server');
          pttReleaseSentRef.current = false; // Reset for next turn
          // DON'T reset isProcessing here - let onResponseComplete handle it
          // This ensures the "thinking" animation shows while waiting for AI response
          // The server will send sentence_ready/audio_chunk which triggers playback,
          // and onResponseComplete will reset isProcessing when the response is done
          console.log('[PUSH-TO-TALK] Keeping isProcessing=true for thinking animation');
          return;
        }
        
        if (recordingConversationId === currentConv && recordingConversationId && isActiveSession) {
          console.log('[PUSH-TO-TALK] Processing audio for conversation:', recordingConversationId);
          await processRecording(audioBlob, recordingConversationId);
        } else {
          console.log('[PUSH-TO-TALK] Discarding audio - conversation changed or session superseded');
          // Only set idle when discarding - processRecording handles its own state
          setAvatarState('idle');
        }
      };
      
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      
      // Notify server that user is actively recording (prevents idle timeout)
      // This is important because push-to-talk doesn't send audio until release
      streamingVoice.sendUserActivity();
      
      // SPECULATIVE PTT: Also set up real-time PCM streaming for faster response
      // This streams audio to Deepgram in parallel with MediaRecorder
      // Server will use the interim transcript to prepare AI response
      try {
        const pttAudioContext = new AudioContext({ sampleRate: 16000 });
        pttStreamingAudioContextRef.current = pttAudioContext;
        
        const actualSampleRate = pttAudioContext.sampleRate;
        const targetSampleRate = 16000;
        const needsResampling = actualSampleRate !== targetSampleRate;
        
        console.log(`[SpeculativePTT] AudioContext sample rate: ${actualSampleRate}Hz (target: ${targetSampleRate}Hz, resampling: ${needsResampling})`);
        
        const source = pttAudioContext.createMediaStreamSource(stream);
        const processor = pttAudioContext.createScriptProcessor(4096, 1, 1);
        pttStreamingProcessorRef.current = processor;
        pttStreamingActiveRef.current = true;
        pttStreamingSequenceIdRef.current = 0;
        pttInterimTranscriptRef.current = '';
        pttReleaseSentRef.current = false; // Reset for new PTT session
        
        processor.onaudioprocess = (event) => {
          if (!pttStreamingActiveRef.current) return;
          
          let inputBuffer = event.inputBuffer.getChannelData(0);
          
          // Resample to 16kHz if needed
          if (needsResampling) {
            inputBuffer = resampleAudio(inputBuffer, actualSampleRate, targetSampleRate);
          }
          
          // Convert Float32Array to Int16Array (linear16 PCM)
          const pcm16 = new Int16Array(inputBuffer.length);
          for (let i = 0; i < inputBuffer.length; i++) {
            const s = Math.max(-1, Math.min(1, inputBuffer[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          const sequenceId = pttStreamingSequenceIdRef.current++;
          streamingVoice.sendStreamingChunk(pcm16.buffer, sequenceId);
        };
        
        source.connect(processor);
        processor.connect(pttAudioContext.destination);
        
        console.log('[SpeculativePTT] Real-time streaming started');
      } catch (pttErr) {
        console.warn('[SpeculativePTT] Failed to set up streaming (fallback to normal PTT):', pttErr);
        // Continue without streaming - normal PTT will still work
      }
      
      // PHASE 2: Mic is ready - transition to actual recording state
      // NOW the user can start speaking (they'll see "Release to send")
      setIsMicPreparing(false);
      setIsRecording(true);
      isRecordingRef.current = true;
      setAvatarState('listening');
      
      console.log('[PUSH-TO-TALK] Recording started - release to stop');
    } catch (err: any) {
      console.error('Failed to start push-to-talk recording:', err);
      setError(err.message || 'Failed to access microphone');
      setIsMicPreparing(false);
      cleanupRecording();
    }
  };

  const stopPushToTalkRecording = (inputType?: 'mouse' | 'touch' | 'keyboard' | 'force') => {
    console.log('[PTT-STOP-DEBUG] Stop requested, inputType:', inputType, 'activeInputType:', activeInputTypeRef.current, 'isHeld:', isPttButtonHeldRef.current);
    
    // Guard: If an input type is specified, it must match the active input type
    // This prevents mouse events from stopping touch recording, etc.
    // 'force' bypasses the guard for cleanup scenarios
    if (inputType && inputType !== 'force' && activeInputTypeRef.current !== inputType) {
      console.log('[PTT-STOP-DEBUG] BLOCKED - input type mismatch (expected:', activeInputTypeRef.current, 'got:', inputType, ')');
      return;
    }
    console.log('[PTT-STOP-DEBUG] Guard passed, proceeding...');
    
    // Guard: Don't stop if the button is still held (prevents speculative AI from clearing state)
    // This check uses the ref for synchronous access
    if (inputType !== 'force' && !isPttButtonHeldRef.current && !isMicPreparing) {
      console.log('[PUSH-TO-TALK] Ignoring stop - button not held and not preparing');
      return;
    }
    
    console.log('[PUSH-TO-TALK] Releasing button, stopping recording...');
    
    // Track that button is released (for stable instruction text)
    // Update both state and ref
    console.log('[PTT-STATE-DEBUG] Setting isPttButtonHeld=FALSE at', new Date().toISOString(), 'call stack:', new Error().stack);
    setIsPttButtonHeld(false);
    isPttButtonHeldRef.current = false;
    activeInputTypeRef.current = null;
    
    // Cancel any pending recording start (for race condition prevention)
    recordingRequestedRef.current = false;
    
    // Clear preparing state if still waiting for mic
    setIsMicPreparing(false);
    
    // FIX: Send ptt_release FIRST, THEN stop audio after a short delay
    // This ensures all in-flight audio reaches the server before we cut the stream
    // Without this delay, the final words of short phrases can get cut off
    pttReleaseSentRef.current = true;
    streamingVoice.sendPttRelease();
    console.log('[SpeculativePTT] Sent ptt_release - audio will stop after 100ms drain delay');
    
    // Stop streaming flag immediately to prevent new chunks, but keep processor alive briefly
    pttStreamingActiveRef.current = false;
    
    // Delay audio processor disconnect to allow final chunks to transmit
    // 100ms is enough for any queued audio buffers to flush to WebSocket
    const processor = pttStreamingProcessorRef.current;
    const audioContext = pttStreamingAudioContextRef.current;
    pttStreamingProcessorRef.current = null;
    pttStreamingAudioContextRef.current = null;
    
    setTimeout(() => {
      if (processor) {
        try { processor.disconnect(); } catch (e) { /* already disconnected */ }
      }
      if (audioContext) {
        audioContext.close().catch(() => { /* already closed */ });
      }
      console.log('[SpeculativePTT] Audio processor disconnected after drain delay');
    }, 100);
    
    // IMMEDIATELY reset subtitles to prevent phantom flash during the gap
    // between stop() being called and onstop callback firing
    // This must happen SYNCHRONOUSLY before any other async operations
    if (streamingConnectedRef.current) {
      console.log('[PUSH-TO-TALK] Resetting subtitles immediately on button release');
      streamingVoice.subtitles.reset();
    }
    
    // CRITICAL: Set isProcessing=true BEFORE cleanup for BOTH streaming and legacy paths
    // In streaming mode, there's no MediaRecorder onstop callback to set this.
    // Without this, ImmersiveTutor never shows the "thinking" state.
    setIsRecording(false);
    isRecordingRef.current = false;
    setIsProcessing(true);
    isProcessingRef.current = true;
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupRecording();
    }
  };
  
  // Open mic mode refs
  const openMicSequenceIdRef = useRef(0);
  const openMicStreamRef = useRef<MediaStream | null>(null);
  const openMicAudioContextRef = useRef<AudioContext | null>(null);
  const openMicProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const openMicActiveRef = useRef(false);
  
  // Speculative PTT streaming refs - stream audio in real-time during PTT for faster response
  const pttStreamingSequenceIdRef = useRef(0);
  const pttStreamingAudioContextRef = useRef<AudioContext | null>(null);
  const pttStreamingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pttStreamingActiveRef = useRef(false);
  const pttInterimTranscriptRef = useRef('');
  // Flag to track if ptt_release was sent - prevents double response from audio_data blob
  const pttReleaseSentRef = useRef(false);
  
  // Refs for open mic functions - used by callbacks that can't access the functions directly
  const startOpenMicRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const stopOpenMicRecordingRef = useRef<(() => void) | null>(null);
  
  /**
   * Resample Float32 audio from source rate to target rate using linear interpolation
   */
  const resampleAudio = (input: Float32Array, fromRate: number, toRate: number): Float32Array => {
    if (fromRate === toRate) return input;
    
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const t = srcIndex - srcIndexFloor;
      
      output[i] = input[srcIndexFloor] * (1 - t) + input[srcIndexCeil] * t;
    }
    
    return output;
  };

  /**
   * Start continuous recording for open mic mode.
   * Uses AudioContext for raw PCM capture (linear16) instead of MediaRecorder.
   * This avoids WebM header issues with continuous streaming.
   */
  const startOpenMicRecording = async () => {
    // Only check the ref - the actual source of truth for audio processing
    // isRecording state can be stale after cleanup
    if (openMicActiveRef.current) {
      console.log('[OPEN MIC] Already active (ref check), ignoring');
      return;
    }
    
    // Block recording if credits are exhausted
    if (isExhausted) {
      console.log('[OPEN MIC] Blocked - credits exhausted');
      if (onInsufficientCredits) {
        onInsufficientCredits();
      }
      return;
    }
    
    try {
      setError(null);
      console.log('[OPEN MIC] Starting continuous PCM recording...');
      
      // Notify server of input mode change
      streamingVoice.setInputMode('open-mic');
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });
      openMicStreamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: 16000 });
      openMicAudioContextRef.current = audioContext;
      
      if (audioContext.state === 'suspended') {
        console.warn(`[OPEN MIC] AudioContext started SUSPENDED — attempting resume (may need user gesture)`);
        try {
          await audioContext.resume();
          console.log(`[OPEN MIC] AudioContext resumed successfully, state: ${audioContext.state}`);
        } catch (resumeErr) {
          console.error('[OPEN MIC] Failed to resume AudioContext:', resumeErr);
        }
      }
      
      if (audioContext.state !== 'running') {
        console.error(`[OPEN MIC] AudioContext state is "${audioContext.state}" — mic audio will be SILENT. Needs user gesture to unlock.`);
      }
      
      const actualSampleRate = audioContext.sampleRate;
      const targetSampleRate = 16000;
      const needsResampling = actualSampleRate !== targetSampleRate;
      
      console.log(`[OPEN MIC] AudioContext state: ${audioContext.state}, sample rate: ${actualSampleRate}Hz (target: ${targetSampleRate}Hz, resampling: ${needsResampling})`);
      
      const source = audioContext.createMediaStreamSource(stream);
      
      // Use ScriptProcessorNode to capture raw PCM (deprecated but widely supported)
      // Buffer size of 4096 samples
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      openMicProcessorRef.current = processor;
      openMicActiveRef.current = true;
      
      processor.onaudioprocess = (event) => {
        if (!openMicActiveRef.current) {
          // Only log occasionally to avoid spam
          if (Math.random() < 0.01) console.log('[OPEN MIC] Audio blocked - openMicActiveRef is false');
          return;
        }
        
        // TRUE DUPLEX MODE: Keep streaming audio even while Daniela speaks
        // Echo cancellation + server-side VAD will filter out TTS feedback
        // This enables real-time barge-in and continuous conversation
        
        let inputBuffer = event.inputBuffer.getChannelData(0);
        
        if (needsResampling) {
          inputBuffer = resampleAudio(inputBuffer, actualSampleRate, targetSampleRate);
        }
        
        const sequenceId = openMicSequenceIdRef.current++;
        
        if (sequenceId === 10 || sequenceId === 50 || sequenceId === 200) {
          let sum = 0;
          for (let i = 0; i < inputBuffer.length; i++) sum += inputBuffer[i] * inputBuffer[i];
          const rmsDb = 10 * Math.log10(sum / inputBuffer.length + 1e-10);
          const ctxState = openMicAudioContextRef.current?.state || 'unknown';
          console.log(`[OPEN MIC DIAG] chunk#${sequenceId} RMS=${rmsDb.toFixed(1)}dB, ctxState=${ctxState}`);
          if (rmsDb < -60) {
            console.warn(`[OPEN MIC DIAG] ⚠️ Very low audio level at chunk#${sequenceId} — mic may not be capturing. Check AudioContext state and permissions.`);
          }
        }
        
        const pcm16 = new Int16Array(inputBuffer.length);
        for (let i = 0; i < inputBuffer.length; i++) {
          const s = Math.max(-1, Math.min(1, inputBuffer[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const sent = streamingVoice.sendStreamingChunk(pcm16.buffer, sequenceId);
        
        // Track consecutive failures for logging (but don't stop recording)
        if (!sent) {
          // Only log occasionally to avoid spam (every 100 failed chunks)
          if (sequenceId % 100 === 0) {
            console.warn('[OPEN MIC] Failed to send chunk, WebSocket may be reconnecting');
          }
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      setOpenMicState('idle');
      setIsRecording(true);
      isRecordingRef.current = true;
      console.log(`[OPEN MIC] Continuous PCM recording started (${actualSampleRate}Hz → ${targetSampleRate}Hz linear16)`);
    } catch (err: any) {
      console.error('[OPEN MIC] Failed to start recording:', err);
      setError(err.message || 'Failed to access microphone');
      setOpenMicState('idle');
      openMicActiveRef.current = false;
    }
  };
  
  /**
   * Stop open mic continuous recording.
   */
  const stopOpenMicRecording = () => {
    console.log('[OPEN MIC] Stopping continuous PCM recording...');
    
    // Notify server to stop streaming
    streamingVoice.stopStreaming();
    
    // Notify server of input mode change back to push-to-talk
    streamingVoice.setInputMode('push-to-talk');
    
    // Stop the ScriptProcessorNode
    openMicActiveRef.current = false;
    if (openMicProcessorRef.current) {
      openMicProcessorRef.current.disconnect();
      openMicProcessorRef.current = null;
    }
    
    // Close AudioContext
    if (openMicAudioContextRef.current) {
      openMicAudioContextRef.current.close().catch(console.error);
      openMicAudioContextRef.current = null;
    }
    
    // Stop media stream
    if (openMicStreamRef.current) {
      openMicStreamRef.current.getTracks().forEach(track => track.stop());
      openMicStreamRef.current = null;
    }
    
    openMicSequenceIdRef.current = 0;
    setOpenMicState('idle');
    setIsRecording(false);
    isRecordingRef.current = false;
  };
  
  /**
   * Handle open mic button tap - only starts if not already active
   * Once Open Mic is running, tapping does nothing (continuous listening)
   */
  const handleOpenMicTap = () => {
    if (openMicActiveRef.current) {
      // Already listening - ignore tap (no toggle behavior)
      console.log('[OPEN MIC] Already active, ignoring tap (no toggle)');
      return;
    }
    // Not active - start recording
    startOpenMicRecording();
  };
  
  // Assign functions to refs so callbacks can access them
  startOpenMicRecordingRef.current = startOpenMicRecording;
  stopOpenMicRecordingRef.current = stopOpenMicRecording;
  
  // Wire up the mode change cleanup ref
  handleModeChangeCleanupRef.current = () => {
    // Stop any active open mic recording when switching modes
    if (openMicActiveRef.current) {
      openMicActiveRef.current = false;
      
      if (openMicProcessorRef.current) {
        openMicProcessorRef.current.disconnect();
        openMicProcessorRef.current = null;
      }
      
      if (openMicAudioContextRef.current) {
        openMicAudioContextRef.current.close().catch(console.error);
        openMicAudioContextRef.current = null;
      }
      
      if (openMicStreamRef.current) {
        openMicStreamRef.current.getTracks().forEach(track => track.stop());
        openMicStreamRef.current = null;
      }
      
      openMicSequenceIdRef.current = 0;
    }
  };

  const handleToggleIncognito = () => {
    // Send the request to the server; state updates via the confirmed onIncognitoChanged callback
    // (no optimistic update — we wait for the server's authoritative incognito_changed signal)
    streamingVoice.sendToggleIncognito(!isIncognito);
  };

  const handleSubmitReport = async () => {
    if (isSubmittingReport || reportSubmitted) return;
    setIsSubmittingReport(true);
    try {
      const tutorName = tutorGender === 'male' ? tutorNames.male : tutorNames.female;
      await apiRequest('POST', '/api/sessions/submit-report', {
        conversationId,
        language,
        tutorName,
      });
      setReportSubmitted(true);
      toast({ title: 'Session flagged', description: 'The team has been notified and will review this session.' });
      setTimeout(() => setReportSubmitted(false), 8000);
    } catch (err: any) {
      toast({ title: 'Could not submit report', description: err.message || 'Please try again.', variant: 'destructive' });
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const handleEndCall = () => {
    console.log('[END CALL] User requested to end voice session');
    
    // Clear greeting lock so reconnecting to the same conversation can get a fresh greeting
    greetingRequestedRef.current = null;
    clearGreetingLock();
    try {
      sessionStorage.removeItem(GREETING_MESSAGE_KEY);
    } catch { /* ignore */ }
    
    // Disconnect streaming voice FIRST - this is synchronous and immediately:
    // 1. Sets intentionalDisconnect = true (prevents auto-reconnect)
    // 2. Clears any pending reconnect timer
    // 3. Sends end_session message and closes WebSocket
    streamingVoice.disconnect();
    streamingConnectedRef.current = false;
    setIsIncognito(false);
    
    // Stop open mic recording if active
    if (openMicActiveRef.current) {
      console.log('[END CALL] Stopping open mic PCM recording');
      openMicActiveRef.current = false;
      if (openMicProcessorRef.current) {
        openMicProcessorRef.current.disconnect();
        openMicProcessorRef.current = null;
      }
      if (openMicAudioContextRef.current) {
        openMicAudioContextRef.current.close().catch(console.error);
        openMicAudioContextRef.current = null;
      }
      if (openMicStreamRef.current) {
        openMicStreamRef.current.getTracks().forEach(track => track.stop());
        openMicStreamRef.current = null;
      }
      openMicSequenceIdRef.current = 0;
    }
    
    // Stop any ongoing recording - the stop() callback will trigger cleanupRecording()
    // Only call cleanupRecording() directly if recorder isn't active
    const recorderWasActive = mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording';
    if (recorderWasActive) {
      try {
        mediaRecorderRef.current!.stop();
        // The onstop callback will handle cleanup
      } catch (e) {
        console.log('[END CALL] MediaRecorder stop error, cleaning up directly');
        cleanupRecording();
      }
    } else {
      // Recorder not active, cleanup state directly
      cleanupRecording();
    }
    
    // Stop any audio playback
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    
    // Reset all UI state
    setAvatarState('idle');
    setIsProcessing(false);
    isProcessingRef.current = false;
    setProcessingStage(null);
    setIsRecording(false);
    setIsMicPreparing(false);
    setCurrentPlayingMessageId(null);
    setError(null);
    
    // Clear whiteboard
    whiteboard.clear();
    
    // Reset subtitles
    streamingVoice.subtitles.reset();
    
    console.log('[END CALL] Voice session ended cleanly');
    
    // Navigate back to dashboard/language hub
    navigate('/');
  };

  const processRecording = async (audioBlob: Blob, targetConversationId: string) => {
    if (!targetConversationId) {
      console.log('[PROCESS] Skipping - no conversation');
      setAvatarState('idle');
      return;
    }

    setIsProcessing(true);
    isProcessingRef.current = true; // Update ref immediately
    setAvatarState('idle');

    // Try streaming mode first for low-latency responses
    // Check both the ref AND the client's actual state (not React state which may be stale)
    const isStreamingReady = streamingConnectedRef.current && streamingVoice.isReady();
    
    console.log('[STREAMING CHECK]', {
      streamingConnectedRef: streamingConnectedRef.current,
      isReady: streamingVoice.isReady(),
      isStreamingReady,
    });
    
    if (isStreamingReady) {
      try {
        console.log('[STREAMING] Using streaming mode for low-latency response');
        
        // Reset subtitles immediately to hide stale content from previous response
        // This prevents old target words from showing during the processing window
        streamingVoice.subtitles.reset();
        
        setProcessingStage('Processing...');
        // Keep avatar idle during processing - it will switch to 'speaking' 
        // when audio actually starts playing (handled by useEffect watching playbackState)
        setAvatarState('idle');
        setError(null); // Clear any previous errors
        
        // Clear previous audio for replay (new response will set these)
        setLastMessageId(null);
        // Note: lastAudioBlob will be set by onResponseComplete callback
        
        // Convert blob to ArrayBuffer
        const audioData = await audioBlob.arrayBuffer();
        
        // Send audio via streaming WebSocket
        await streamingVoice.sendAudio(audioData);
        
        // Streaming audio playback is handled by useStreamingVoice hook
        // The hook handles:
        // - Progressive audio playback
        // - Subtitle word timing
        // - State management
        
        // Wait for response to complete
        // The hook will update state as audio plays
        console.log('[STREAMING] Audio sent, awaiting progressive response...');
        
        // Refetch messages after response completes (messages are saved server-side)
        setTimeout(async () => {
          await queryClient.refetchQueries({
            queryKey: ["/api/conversations", targetConversationId, "messages"],
          });
        }, 500);
        
        return; // Exit early - streaming mode handles everything
      } catch (streamErr: any) {
        console.error('[STREAMING] Streaming failed:', streamErr.message);
        streamingConnectedRef.current = false;
        // Reset state and show error
        setIsProcessing(false);
        isProcessingRef.current = false;
        setAvatarState('idle');
        setProcessingStage(null);
        setError('Voice streaming failed. Please try again.');
        
        // Attempt to reconnect streaming
        setTimeout(async () => {
          try {
            console.log('[STREAMING] Attempting to reconnect...');
            await streamingVoice.connect({
              conversationId: targetConversationId,
              targetLanguage: targetLanguageOverride ?? language,
              nativeLanguage: user?.nativeLanguage || 'english',
              difficultyLevel: difficulty,
              subtitleMode,
              tutorPersonality: user?.tutorPersonality || 'warm',
              tutorExpressiveness: user?.tutorExpressiveness || 3,
              tutorGender,  // Pass current tutor gender from context
              rawHonestyMode: isHonestyMode,  // Minimal prompting for authentic conversation
              onWhiteboardUpdate: (items, shouldClear) => {
                const imageItems = items.filter((item: any) => item.type === 'image' && item.data?.imageUrl);
                const otherItems = items.filter((item: any) => !(item.type === 'image' && item.data?.imageUrl));
                imageItems.forEach((img: any) => {
                  onStudioImage?.({
                    word: img.data.word || img.content,
                    description: img.data.description || img.content,
                    imageUrl: img.data.imageUrl,
                    context: img.data.context,
                    slot: img.data.slot,
                    category: img.data.category,
                  });
                });
                if (otherItems.length > 0 || shouldClear) {
                  whiteboard.addOrUpdateItems(otherItems, shouldClear);
                }
              },
              onScenarioLoaded: (scenario) => {
                onScenarioLoaded?.(scenario);
              },
              onScenarioEnded: (data) => {
                onScenarioEnded?.(data);
              },
              onSceneZoneAdvanced: (data) => {
                onSceneZoneAdvanced?.(data);
              },
              onPropUpdate: (data) => {
                onPropUpdate?.(data);
              },
              onImmersiveModeChange: (active) => {
                onImmersiveModeChange?.(active);
              },
              onVadSpeechStarted: () => {
                // TRUE DUPLEX: Always handle VAD speech events for visual feedback
                // NOTE: We no longer interrupt on VAD alone - echo/feedback can trigger false VAD
                // Interrupt is now handled in onInterimTranscript when we have ACTUAL user speech
                console.log('[OPEN MIC] VAD speech started (reconnect) - avatarState=', avatarStateRef.current, 'hasDanielaSpokeOnce=', hasDanielaSpokeOnceRef.current);
                
                // PHONE CALL MODEL: Only show green light if Daniela has "answered the call" (spoken at least once)
                if (hasDanielaSpokeOnceRef.current) {
                  setOpenMicState('listening');
                } else {
                  console.log('[OPEN MIC] Daniela hasnt spoken yet - keeping mic blue (reconnect)');
                }
              },
              onVadUtteranceEnd: (transcript, empty) => {
                console.log('[OPEN MIC] VAD utterance end (reconnect), transcript:', transcript, 'empty:', empty);
                if (empty) {
                  console.log('[OPEN MIC] Empty transcript (reconnect) - resetting to listening');
                  setOpenMicState('ready');
                  setIsProcessing(false);
                  isProcessingRef.current = false;
                  isAwaitingResponseRef.current = false;
                  return;
                }
                setOpenMicState('processing');
                isAwaitingResponseRef.current = true;
                // Show thinking avatar immediately (same reasoning as primary path above)
                if (getGlobalPlaybackState() !== 'playing' && getGlobalPlaybackState() !== 'buffering') {
                  setGlobalPlaybackState('thinking');
                }
                
                // SAFETY: Start failsafe timer for reconnect path too
                if (openMicProcessingTimeoutRef.current) clearTimeout(openMicProcessingTimeoutRef.current);
                openMicProcessingTimeoutRef.current = setTimeout(() => {
                  const currentState = openMicStateRef.current;
                  if (currentState === 'processing') {
                    console.warn(`[OPEN MIC SAFETY] Processing stuck for ${OPEN_MIC_PROCESSING_TIMEOUT_MS}ms (reconnect) — force-recovering`);
                    setOpenMicState('ready');
                    setIsProcessing(false);
                    isProcessingRef.current = false;
                    isAwaitingResponseRef.current = false;
                    setAvatarState('listening');
                  }
                  openMicProcessingTimeoutRef.current = null;
                }, OPEN_MIC_PROCESSING_TIMEOUT_MS);
              },
              onInterimTranscript: (transcript) => {
                console.log('[OPEN MIC] Interim transcript:', transcript);
                
                // Reinforce 'listening' state when we get actual transcribed words (reconnect path)
                if (transcript && transcript.trim().length > 0) {
                  const currentOMState = openMicStateRef.current;
                  if (currentOMState !== 'listening' && currentOMState !== 'processing') {
                    console.log('[OPEN MIC] Interim transcript with words (reconnect) - forcing listening state (was:', currentOMState, ')');
                    setOpenMicState('listening');
                  }
                  
                  // BARGE-IN: Interrupt tutor when we have ACTUAL transcribed speech.
                  // Require ≥3 words to filter mic echo (tutor audio bleeding into mic).
                  const wordCount = transcript.trim().split(/\s+/).filter((w: string) => w.length > 0).length;
                  if ((avatarStateRef.current === 'speaking' || isAwaitingResponseRef.current) && wordCount >= 3) {
                    console.log('[BARGE-IN] User speaking with transcript (' + wordCount + ' words) - stopping audio and sending interrupt');
                    // CRITICAL: Stop audio playback immediately on client side
                    streamingVoice.stop();
                    // Also notify server to stop generating
                    streamingVoice.sendInterrupt();
                    isAwaitingResponseRef.current = false;
                    // Update avatar state immediately
                    setAvatarState('listening');
                  }
                }
              },
              onOpenMicSessionClosed: () => {
                console.log('[OPEN MIC] Server session closed (reconnect context)');
                if (!isAwaitingResponseRef.current) {
                  setOpenMicState('idle');
                }
              },
              onOpenMicSilenceLoop: (emptyCount, msSinceLast) => {
                console.warn(`[OPEN MIC] Silence loop (reconnect): ${emptyCount} empties`);
                if (emptyCount >= 8 && inputModeRef.current === 'open-mic') {
                  setOpenMicState('silence_issue');
                }
              },
              onGlReconnected: () => {
                // GL-only reconnect (reconnect context): socket intact, GL session rebuilt
                // server-side with Context Bridge. Clear stale error UI only.
                console.log('[StreamingVoice] GL session restored (socket intact, reconnect context) — clearing error state');
                setError(null);
                setAvatarState('idle');
                isAwaitingResponseRef.current = false;
                isProcessingRef.current = false;
                setIsProcessing(false);
                // Restore open-mic readiness so the mic loop resumes listening immediately.
                if (inputModeRef.current === 'open-mic') {
                  setOpenMicState('idle');
                }
              },
              onReconnected: () => {
                console.log('[StreamingVoice] Connection restored after drop (reconnect context) — resetting UI state');

                // AUTOSCALE RECOVERY: Same stale-state clear as the primary callback
                setGlobalPlaybackState('idle');
                setAvatarState('idle');
                setIsRecording(false);
                isRecordingRef.current = false;
                isAwaitingResponseRef.current = false;
                isProcessingRef.current = false;
                // No toast — routine infrastructure reconnect, fully invisible to user.

                // GREETING LOCK RESET: Clear the greeting lock and flag that a greeting is needed.
                // GL is always a fresh WebSocket after reconnect — without a greeting Daniela
                // waits silently and never responds to the user's first utterance.
                // The greeting effect fires when connectionState becomes 'ready' (after GL init).
                greetingRequestedRef.current = null;
                clearGreetingLock();
                needsGreetingAfterReconnectRef.current = true;

                if (inputModeRef.current === 'open-mic') {
                  setOpenMicState('idle');
                  let retries = 0;
                  const tryRestart = () => {
                    const state = connectionStateRef.current;
                    if ((state === 'ready' || state === 'processing') && startOpenMicRecordingRef.current) {
                      console.log('[RECONNECT] Auto-restarting open mic after reconnect (reconnect context)');
                      startOpenMicRecordingRef.current().catch((err: any) => {
                        console.error('[RECONNECT] Failed to restart open mic (reconnect context):', err);
                        setOpenMicState('idle');
                      });
                    } else if (retries < 20 && inputModeRef.current === 'open-mic') {
                      retries++;
                      setTimeout(tryRestart, 250);
                    }
                  };
                  setTimeout(tryRestart, 300);
                }
              },
              onTutorHandoff: (handoff) => {
                const { targetGender, targetLanguage, tutorName, isLanguageSwitch, isAssistant } = handoff;
                
                if (isAssistant) {
                  console.log(`[TUTOR HANDOFF] Assistant handoff to ${tutorName} - navigating to practice page (reconnect context)`);
                  streamingVoice.disconnect();
                  streamingConnectedRef.current = false;
                  window.location.href = '/practice';
                  return;
                }
                
                if (isLanguageSwitch && targetLanguage) {
                  console.log(`[TUTOR HANDOFF] Cross-language switch to ${tutorName} (${targetGender}) in ${targetLanguage} (reconnect context)`);
                  // CRITICAL: Clear greeting lock so new tutor can greet
                  greetingRequestedRef.current = null;
                  clearGreetingLock();
                  try {
                    sessionStorage.removeItem(GREETING_MESSAGE_KEY);
                  } catch {
                    // Ignore storage errors
                  }
                  console.log('[TUTOR HANDOFF] Cleared greeting lock for new tutor (reconnect)');
                  // Update language context - this triggers tutorVoices refetch for new language
                  setLanguage(targetLanguage);
                } else {
                  console.log(`[TUTOR HANDOFF] Switching to ${tutorName || targetGender} tutor (reconnect context)`);
                }
                setTutorGender(targetGender);
              },
              // Handle server-initiated subtitle mode change (tutor [SUBTITLE on/off/target] command)
              onSubtitleModeChange: (mode) => {
                console.log('[SUBTITLE] Server command to change subtitle mode to:', mode, '(reconnect context)');
                // Update whiteboard's regularSubtitleMode (used by FloatingSubtitleOverlay)
                whiteboard.setRegularSubtitleMode(mode);
                // Also update context for persistence
                setSubtitleMode(mode);
              },
              // Handle server-initiated custom overlay (tutor [SHOW: text] / [HIDE] commands)
              onCustomOverlay: (action, text) => {
                console.log('[OVERLAY] Server command:', action, text?.substring(0, 50), '(reconnect context)');
                whiteboard.setCustomOverlayText(action === 'show' ? (text || null) : null);
              },
            });
            streamingConnectedRef.current = true;
            setError(null);
            console.log('[STREAMING] Reconnected successfully');
          } catch (reconnectErr: any) {
            console.error('[STREAMING] Reconnection failed:', reconnectErr.message);
          }
        }, 1000);
        
        return; // Don't fall through to REST mode
      }
    } else if (STREAMING_ONLY_MODE) {
      // Streaming mode required but not connected - show error
      const currentState = streamingVoice.state.connectionState;
      console.warn('[STREAMING] Not connected, state:', currentState);
      
      // Give appropriate feedback based on connection state
      if (currentState === 'reconnecting') {
        setError('Reconnecting to voice session. Please wait...');
      } else {
        setError('Voice streaming is connecting. Please try again in a moment.');
      }
      setIsProcessing(false);
      isProcessingRef.current = false;
      setAvatarState('idle');
      setProcessingStage(null);
      return; // Don't fall through to REST mode
    }

    // ========================================================================
    // ⚠️ DEAD CODE - REST FALLBACK (PRESERVED BUT NEVER EXECUTED) ⚠️
    // ========================================================================
    // This REST code is ONLY reached when STREAMING_ONLY_MODE = false
    // Currently STREAMING_ONLY_MODE = true, so this code NEVER runs.
    // 
    // This code is preserved as an emergency fallback in case streaming
    // has critical issues. To enable:
    //   1. Set STREAMING_ONLY_MODE = false at the top of this file
    //   2. Test thoroughly before deploying
    //
    // DO NOT DELETE - This is our backup pipeline.
    // ========================================================================

    try {
      // REST mode (only used when STREAMING_ONLY_MODE is false)
      // Step 1: Transcribe
      setProcessingStage('Transcribing...');
      console.log('[REST VOICE] Transcribing audio...');
      
      // Step 2: Get response
      setProcessingStage('Getting response...');
      console.log('[REST VOICE] Sending to GPT...');
      
      // Step 3: Synthesize speech
      setProcessingStage('Synthesizing speech...');
      // KARAOKE ENABLED: Cartesia Sonic-3 provides estimated word timings for highlighting
      const needTimings = subtitleMode !== "off";
      console.log(`[REST VOICE] Generating speech... (karaoke: ${needTimings})`);
      
      const result = await processVoiceMessage(audioBlob, targetConversationId, language, needTimings);
      
      console.log('[REST VOICE] ✓ Transcript:', result.userTranscript);
      console.log('[REST VOICE] ✓ Response:', result.aiResponse);
      if (result.wordTimings) {
        console.log('[REST VOICE] ✓ Word timings received:', result.wordTimings.length, 'words');
      }
      
      // Handle conversation updates (language switch, onboarding, etc.)
      if (result.conversationUpdated) {
        const updated = result.conversationUpdated;
        console.log('[VOICE] Conversation updated:', updated);
        
        // Update language context if language changed
        if (updated.language && updated.language !== language) {
          console.log('[VOICE] Updating language context:', language, '->', updated.language);
          setLanguage(updated.language);
        }
        
        // Update onboarding status
        if (updated.isOnboarding !== undefined) {
          setCurrentConversationOnboarding(updated.isOnboarding);
        }
      }
      
      // Refetch messages to get the new assistant message (waits for fetch to complete)
      await queryClient.refetchQueries({
        queryKey: ["/api/conversations", targetConversationId, "messages"],
      });
      
      // Get the latest assistant message ID for subtitle display
      const updatedMessages = queryClient.getQueryData<Message[]>(["/api/conversations", targetConversationId, "messages"]);
      const latestAssistantMessage = updatedMessages?.filter(m => m.role === 'assistant').pop();
      
      console.log('[REST VOICE] Latest assistant message for highlighting:', latestAssistantMessage?.id);
      
      // Step 4: Play response
      setProcessingStage('Playing response...');
      setAvatarState('speaking');
      
      if (audioPlayerRef.current && result.audioBlob) {
        console.log('[REST VOICE] Audio blob size:', result.audioBlob.size, 'bytes');
        console.log('[REST VOICE] Audio blob type:', result.audioBlob.type);
        
        // Store audio for replay functionality
        setLastAudioBlob(result.audioBlob);
        if (latestAssistantMessage) {
          setLastMessageId(latestAssistantMessage.id);
        }
        
        const audioUrl = URL.createObjectURL(result.audioBlob);
        audioPlayerRef.current.src = audioUrl;
        
        // Use loadedmetadata to rescale word timings to actual audio duration for precise sync
        audioPlayerRef.current.onloadedmetadata = () => {
          if (result.wordTimings && result.wordTimings.length > 0 && latestAssistantMessage && audioPlayerRef.current) {
            const actualDuration = audioPlayerRef.current.duration;
            const estimatedDuration = result.wordTimings[result.wordTimings.length - 1].endTime;
            
            if (actualDuration && estimatedDuration && Math.abs(actualDuration - estimatedDuration) > 0.1) {
              // Rescale timings proportionally to match actual audio duration
              const scale = actualDuration / estimatedDuration;
              const rescaledTimings = result.wordTimings.map(timing => ({
                word: timing.word,
                startTime: timing.startTime * scale,
                endTime: Math.min(timing.endTime * scale, actualDuration),
              }));
              wordTimingsMapRef.current.set(latestAssistantMessage.id, rescaledTimings);
              console.log(`[SUBTITLES] Rescaled timings: ${estimatedDuration.toFixed(2)}s → ${actualDuration.toFixed(2)}s (scale: ${scale.toFixed(3)})`);
            } else if (subtitleMode !== "off") {
              // No rescaling needed, store as-is
              wordTimingsMapRef.current.set(latestAssistantMessage.id, result.wordTimings);
              console.log('[SUBTITLES] Stored word timings for message:', latestAssistantMessage.id);
            }
          }
        };
        
        // Set the currently playing message ID before playing
        if (latestAssistantMessage) {
          setCurrentPlayingMessageId(latestAssistantMessage.id);
        }
        
        audioPlayerRef.current.onended = () => {
          console.log('[REST VOICE] Audio playback ended');
          URL.revokeObjectURL(audioUrl);
          setAvatarState('idle');
          setCurrentPlayingMessageId(null);
          setProcessingStage(null);
        };
        
        audioPlayerRef.current.onerror = (e) => {
          console.error('[REST VOICE] Audio playback error:', e);
          setError('Failed to play audio. The text response is still saved.');
          URL.revokeObjectURL(audioUrl);
          setAvatarState('idle');
          setCurrentPlayingMessageId(null);
          setProcessingStage(null);
        };
        
        try {
          console.log('[REST VOICE] Starting audio playback...');
          await audioPlayerRef.current.play();
          console.log('[REST VOICE] ✓ Audio playback started successfully');
        } catch (playError: any) {
          console.error('[REST VOICE] Failed to play audio:', playError);
          setError(`Audio playback blocked: ${playError.message}. Check browser autoplay settings.`);
          URL.revokeObjectURL(audioUrl);
          setAvatarState('idle');
          setCurrentPlayingMessageId(null);
          setProcessingStage(null);
        }
      } else {
        console.warn('[REST VOICE] No audio blob or audio player unavailable');
        setProcessingStage(null);
        setAvatarState('idle');
      }
      
    } catch (err: any) {
      console.error('[REST VOICE] Error:', err);
      
      // Provide helpful recovery guidance based on error type
      let errorMessage = err.message || 'Voice processing failed';
      let allowRetry = true;
      
      if (err.message?.includes('limit reached') || err.message?.includes('quota')) {
        errorMessage = 'Monthly voice limit reached. Please upgrade your plan or switch to text mode below.';
        allowRetry = false; // Quota errors can't be retried
      } else if (err.message?.includes('401') || err.message?.includes('API key') || err.message?.includes('authentication')) {
        errorMessage = 'Invalid OpenAI API key. Please update your OPENAI_API_KEY in the Secrets tab or switch to text mode.';
        allowRetry = false; // Auth errors need manual intervention
      } else if (err.message?.includes('transcribe') || err.message?.includes('Whisper')) {
        errorMessage = 'Failed to transcribe audio. Try speaking more clearly or switch to text mode.';
      } else if (err.message?.includes('synthesize') || err.message?.includes('TTS')) {
        errorMessage = 'Failed to generate speech. The text response is still saved. Try refreshing or switch to text mode.';
      } else {
        errorMessage += ' Please try again or switch to text mode.';
      }
      
      setError(errorMessage);
      setAvatarState('idle');
    } finally {
      setIsProcessing(false);
      isProcessingRef.current = false; // Update ref immediately
      setProcessingStage(null);
    }
  };

  // Replay function for last audio
  const replayLastAudio = () => {
    if (!lastAudioBlob || !audioPlayerRef.current) {
      console.log('[REPLAY] No audio available to replay');
      return;
    }
    
    // Don't replay if already playing or processing
    if (avatarState === 'speaking' || isProcessing) {
      console.log('[REPLAY] Skipping - already playing or processing');
      return;
    }
    
    console.log('[REPLAY] Replaying last audio');
    setAvatarState('speaking');
    if (lastMessageId) {
      setCurrentPlayingMessageId(lastMessageId);
    }
    
    const audioUrl = URL.createObjectURL(lastAudioBlob);
    audioPlayerRef.current.src = audioUrl;
    
    audioPlayerRef.current.onended = () => {
      URL.revokeObjectURL(audioUrl);
      setAvatarState('idle');
      setCurrentPlayingMessageId(null);
    };
    
    audioPlayerRef.current.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      setAvatarState('idle');
      setCurrentPlayingMessageId(null);
    };
    
    audioPlayerRef.current.play()
      .catch(err => {
        console.error('[REPLAY] Failed to play:', err);
        URL.revokeObjectURL(audioUrl);
        setAvatarState('idle');
        setCurrentPlayingMessageId(null);
      });
  };

  // Slow repeat: Ask AI to simplify and speak slowly
  // Caches the audio so subsequent presses just replay
  const handleSlowRepeat = async () => {
    if (!conversationId || !audioPlayerRef.current) {
      console.log('[SLOW REPEAT] No conversation or audio player');
      return;
    }
    
    // Don't start if already playing or processing
    if (avatarState === 'speaking' || isProcessing || isSlowRepeatLoading) {
      console.log('[SLOW REPEAT] Skipping - already busy');
      return;
    }
    
    setError(null);
    
    // Check if we have a cached slow repeat for the current message
    if (slowRepeatCacheRef.current && slowRepeatCacheRef.current.messageId === lastMessageId) {
      console.log('[SLOW REPEAT] Using cached audio (replay)');
      
      // Play cached audio
      setAvatarState('speaking');
      const audioUrl = URL.createObjectURL(slowRepeatCacheRef.current.audioBlob);
      audioPlayerRef.current.src = audioUrl;
      
      audioPlayerRef.current.onended = () => {
        URL.revokeObjectURL(audioUrl);
        setAvatarState('idle');
        setCurrentPlayingMessageId(null);
      };
      
      audioPlayerRef.current.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        setAvatarState('idle');
        setCurrentPlayingMessageId(null);
      };
      
      try {
        await audioPlayerRef.current.play();
      } catch (err) {
        console.error('[SLOW REPEAT] Failed to play cached audio:', err);
        setAvatarState('idle');
      }
      return;
    }
    
    // No cache - fetch from API
    console.log('[SLOW REPEAT] Requesting simplified slow repeat');
    setIsSlowRepeatLoading(true);
    
    try {
      const result = await requestSlowRepeat(conversationId);
      console.log('[SLOW REPEAT] Got simplified response:', result.simplifiedText);
      
      // Cache the audio for subsequent presses
      if (lastMessageId) {
        slowRepeatCacheRef.current = {
          messageId: lastMessageId,
          audioBlob: result.audioBlob,
        };
        console.log('[SLOW REPEAT] Cached audio for message:', lastMessageId);
      }
      
      // Play the slow audio
      setAvatarState('speaking');
      const audioUrl = URL.createObjectURL(result.audioBlob);
      audioPlayerRef.current.src = audioUrl;
      
      audioPlayerRef.current.onended = () => {
        URL.revokeObjectURL(audioUrl);
        setAvatarState('idle');
        setCurrentPlayingMessageId(null);
      };
      
      audioPlayerRef.current.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        setAvatarState('idle');
        setCurrentPlayingMessageId(null);
        setError('Failed to play slow repeat audio');
      };
      
      await audioPlayerRef.current.play();
    } catch (err: any) {
      console.error('[SLOW REPEAT] Error:', err);
      setError(err.message || 'Failed to get slow repeat');
      setAvatarState('idle');
    } finally {
      setIsSlowRepeatLoading(false);
    }
  };

  const isUsersTurnComputed = (streamingVoice.state.connectionState === 'ready' || streamingVoice.state.connectionState === 'connected' || streamingVoice.state.connectionState === 'streaming') &&
    !streamingVoice.state.isSwitchingTutor &&
    (isPttButtonHeld || (!isProcessing && !streamingVoice.state.isProcessing && globalPlaybackState === 'idle') || (!!streamingVoice.state.error && !streamingVoice.state.isProcessing && globalPlaybackState === 'idle'));

  const voiceInputContextValue = {
    inputMode,
    setInputMode: setInputMode as (mode: VoiceInputMode) => void,
    isRecording,
    isMicPreparing,
    isUsersTurn: isUsersTurnComputed,
    playbackState: globalPlaybackState as 'idle' | 'buffering' | 'playing' | 'paused',
    onRecordingStart: inputMode === 'open-mic' ? handleOpenMicTap : startPushToTalkRecording,
    onRecordingStop: inputMode === 'open-mic' ? (() => {}) : stopPushToTalkRecording,
    onInterrupt: () => {
      streamingVoice.stop();
      streamingVoice.sendInterrupt();
    },
  };

  // Sync voice input state to global store so ImmersiveOverlay (outside this Provider) can read it
  useEffect(() => {
    setGlobalVoiceInput({
      inputMode,
      setInputMode,
      isRecording,
      isMicPreparing,
      isUsersTurn: isUsersTurnComputed,
      playbackState: globalPlaybackState as 'idle' | 'buffering' | 'playing' | 'paused',
      onRecordingStart: inputMode === 'open-mic' ? handleOpenMicTap : startPushToTalkRecording,
      onRecordingStop: inputMode === 'open-mic' ? (() => {}) : stopPushToTalkRecording,
      onInterrupt: () => {
        streamingVoice.stop();
        streamingVoice.sendInterrupt();
      },
    });
  }, [inputMode, isRecording, isMicPreparing, isUsersTurnComputed, globalPlaybackState]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <VoiceInputContext.Provider value={voiceInputContextValue}>
    <div
      className={`h-full flex flex-col overflow-hidden${backdropImageUrl ? '' : ' bg-background'}`}
      data-testid="rest-voice-chat"
      style={backdropImageUrl ? {
        backgroundImage: `linear-gradient(rgba(0,0,0,0.22), rgba(0,0,0,0.38)), url(${backdropImageUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      } : undefined}
    >
      {/* Incognito Mode Toggle - Founder/Honesty mode only */}
      {(isDeveloper || isAdmin) && (learningContext === 'founder-mode' || learningContext === 'honesty-mode') && (['connected', 'ready', 'processing', 'streaming', 'reconnecting'] as const).includes(streamingVoice.state.connectionState as any) && (
        <div className="absolute top-3 left-3 z-50">
          <Button
            size="sm"
            variant={isIncognito ? "destructive" : "outline"}
            onClick={handleToggleIncognito}
            className="gap-1.5 opacity-80 hover:opacity-100"
            data-testid="button-toggle-incognito"
          >
            <EyeOff className="w-3.5 h-3.5" />
            {isIncognito ? "Incognito ON" : "Incognito"}
          </Button>
        </div>
      )}
      {/* Top-right controls: Submit Report + Micro-Ack Toggle */}
      {useStreamingMode && (
        <div className="absolute top-3 right-3 z-50 flex items-center gap-1">
          <Button
            size="sm"
            variant={reportSubmitted ? "default" : "ghost"}
            onClick={handleSubmitReport}
            disabled={isSubmittingReport || reportSubmitted}
            className="gap-1.5 opacity-70 hover:opacity-100"
            data-testid="button-submit-report"
            title="Flag an issue with this session"
          >
            {isSubmittingReport
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Flag className="w-3.5 h-3.5" />}
          </Button>
        </div>
      )}
      {/* TTS Unavailable Banner — suppressed from user view; fallback to text mode happens silently */}
      {/* STT Degraded Banner — shown when Deepgram voice recognition has an error, auto-clears in 6s */}
      {useStreamingMode && streamingVoice.state.sttDegraded && (
        <div
          className="absolute top-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-muted-foreground text-xs border"
          data-testid="status-stt-degraded"
        >
          <MicOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{streamingVoice.state.sttDegradedMessage || 'Having trouble hearing you — please try again.'}</span>
          {streamingVoice.state.sttSuggestPtt && inputMode !== 'push-to-talk' && (
            <button
              className="ml-1 underline underline-offset-2 text-foreground font-medium hover:text-foreground/80 transition-colors"
              data-testid="button-switch-to-ptt"
              onClick={() => setInputMode('push-to-talk')}
            >
              Switch to Push-to-Talk
            </button>
          )}
        </div>
      )}
      {/* Active character indicator — shown when a secondary character is speaking */}
      {useStreamingMode && streamingVoice.state.activeCharacter && (
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3 py-1.5 rounded-md bg-card text-card-foreground text-xs border shadow-sm"
          data-testid="status-active-character"
        >
          <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="font-medium">{streamingVoice.state.activeCharacter.displayName}</span>
          <span className="text-muted-foreground">{streamingVoice.state.activeCharacter.role}</span>
        </div>
      )}
      {/* Immersive Voice Chat with View Manager - Full Screen */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {/* Lesson Notes Panel — accumulates vocab/grammar/culture notes during the session */}
        {lessonNotes.length > 0 && (
          <div className="absolute bottom-3 right-3 z-40 w-72 max-w-[calc(100vw-1.5rem)]">
            {lessonNotesOpen ? (
              <div className="bg-card border rounded-md shadow-md flex flex-col max-h-96">
                <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                  <BookOpen className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="text-xs font-semibold flex-1">Session Notes ({lessonNotes.length})</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    data-testid="button-lesson-notes-export"
                    onClick={() => {
                      const lines = lessonNotes.map(n => {
                        const label = n.type.charAt(0).toUpperCase() + n.type.slice(1);
                        return n.detail ? `[${label}] ${n.content} — ${n.detail}` : `[${label}] ${n.content}`;
                      });
                      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'lesson-notes.txt';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    data-testid="button-lesson-notes-close"
                    onClick={() => setLessonNotesOpen(false)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <ul className="overflow-y-auto p-2 space-y-1.5">
                  {lessonNotes.map((note) => (
                    <li
                      key={note.id}
                      className="text-xs rounded-md px-2 py-1.5 bg-muted/60"
                      data-testid={`lesson-note-item-${note.id}`}
                    >
                      <span className={`inline-block mr-1.5 font-semibold ${
                        note.type === 'vocab' ? 'text-blue-500' :
                        note.type === 'grammar' ? 'text-amber-500' :
                        note.type === 'culture' ? 'text-emerald-500' : 'text-muted-foreground'
                      }`}>
                        {note.type.charAt(0).toUpperCase() + note.type.slice(1)}
                      </span>
                      <span className="text-foreground">{note.content}</span>
                      {note.detail && (
                        <span className="text-muted-foreground"> — {note.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="shadow-md gap-1.5"
                data-testid="button-lesson-notes-open"
                onClick={() => setLessonNotesOpen(true)}
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="text-xs">Notes ({lessonNotes.length})</span>
              </Button>
            )}
          </div>
        )}

        {/* Pronunciation Score — temporary word-by-word feedback overlay */}
        {pronunciationScore && (
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 w-80 max-w-[calc(100vw-1.5rem)]">
            <div className="bg-card border rounded-md shadow-md p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold flex-1 truncate">{pronunciationScore.phrase}</span>
                <span className={`text-xs font-bold shrink-0 ${pronunciationScore.overallScore >= 80 ? 'text-emerald-500' : pronunciationScore.overallScore >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                  {pronunciationScore.overallScore}%
                </span>
                <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0" data-testid="button-pronunciation-dismiss" onClick={() => { if (pronunciationScoreTimerRef.current) clearTimeout(pronunciationScoreTimerRef.current); setPronunciationScore(null); }}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pronunciationScore.wordScores.map((ws, i) => (
                  <div
                    key={i}
                    title={ws.tip}
                    data-testid={`pronunciation-word-${i}`}
                    className={`flex flex-col items-center px-2 py-1 rounded text-xs ${ws.score >= 80 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : ws.score >= 50 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-red-500/15 text-red-600 dark:text-red-400'}`}
                  >
                    <span className="font-medium">{ws.word}</span>
                    <span className="text-[10px] opacity-70">{ws.score}%</span>
                  </div>
                ))}
              </div>
              {pronunciationScore.encouragement && (
                <p className="text-xs text-muted-foreground mt-2">{pronunciationScore.encouragement}</p>
              )}
            </div>
          </div>
        )}

        {/* Grammar Flag — temporary correction card */}
        {grammarFlag && (
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 w-80 max-w-[calc(100vw-1.5rem)]">
            <div className="bg-card border rounded-md shadow-md p-3">
              <div className="flex items-center gap-1.5 mb-2">
                {grammarFlag.ruleLabel && (
                  <span className="text-[10px] font-semibold text-amber-500 uppercase tracking-wide">{grammarFlag.ruleLabel}</span>
                )}
                <Button size="icon" variant="ghost" className="h-5 w-5 ml-auto" data-testid="button-grammar-flag-dismiss" onClick={() => { if (grammarFlagTimerRef.current) clearTimeout(grammarFlagTimerRef.current); setGrammarFlag(null); }}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground line-through">{grammarFlag.original}</p>
                <p className="text-sm font-semibold text-foreground">{grammarFlag.corrected}</p>
                <p className="text-xs text-muted-foreground">{grammarFlag.explanation}</p>
              </div>
            </div>
          </div>
        )}

        {/* Quiz Pop-in — interactive multiple-choice overlay */}
        {/* Render-side guard: never mount the overlay with blank or malformed data */}
        {activeQuiz &&
          typeof activeQuiz.question === 'string' && activeQuiz.question.trim().length > 0 &&
          Array.isArray(activeQuiz.options) && activeQuiz.options.length > 0 && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" data-testid="quiz-overlay">
            <div className="bg-card border rounded-md shadow-xl p-4 w-80 max-w-[calc(100vw-2rem)] mx-4">
              <p className="text-sm font-semibold mb-3" data-testid="quiz-question">{activeQuiz.question}</p>
              <div className="space-y-2">
                {activeQuiz.options.map((option, i) => {
                  const isSelected = activeQuiz.selectedIndex === i;
                  const isCorrect = i === activeQuiz.correctIndex;
                  const showResult = activeQuiz.showResult;
                  return (
                    <button
                      key={i}
                      data-testid={`quiz-option-${i}`}
                      disabled={showResult}
                      onClick={() => {
                        if (showResult) return;
                        setActiveQuiz(prev => prev ? { ...prev, selectedIndex: i, showResult: true } : null);
                        setTimeout(() => setActiveQuiz(null), 3000);
                      }}
                      className={`w-full text-left text-xs px-3 py-2.5 rounded-md border transition-colors ${
                        showResult
                          ? isCorrect
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-600 dark:text-emerald-400'
                            : isSelected
                              ? 'bg-red-500/20 border-red-500 text-red-600 dark:text-red-400'
                              : 'bg-muted/30 border-transparent text-muted-foreground'
                          : 'bg-muted/40 border-muted hover:bg-muted cursor-pointer'
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {activeQuiz.showResult && activeQuiz.explanation && (
                <p className="text-xs text-muted-foreground mt-3 pt-2 border-t">{activeQuiz.explanation}</p>
              )}
              {!activeQuiz.showResult && (
                <Button size="sm" variant="ghost" className="w-full mt-3 text-xs text-muted-foreground" data-testid="button-quiz-skip" onClick={() => setActiveQuiz(null)}>
                  Skip
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Cultural Context — persistent floating card (top-left, opposite side from notes) */}
        {culturalContext && (
          <div className="absolute top-3 left-3 z-40 w-72 max-w-[calc(50vw-1rem)]" data-testid="cultural-context-panel">
            <div className="bg-card border rounded-md shadow-md p-3">
              <div className="flex items-start gap-2">
                <Globe className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold leading-tight">{culturalContext.title}</p>
                  {culturalContext.category && (
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-0.5">{culturalContext.category}</p>
                  )}
                </div>
                <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0" data-testid="button-cultural-context-dismiss" onClick={() => setCulturalContext(null)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{culturalContext.text}</p>
              {culturalContext.sourceUrl && (
                <a
                  href={culturalContext.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-blue-500 hover:underline mt-1.5 block truncate"
                  data-testid="cultural-context-source-link"
                >
                  {culturalContext.sourceUrl}
                </a>
              )}
            </div>
          </div>
        )}

        {/* Gap D — Shared Mission: Daniela holds activeMission internally for session guidance,
            but we don't render it in the student UI — it's confusing and not student-initiated. */}

        {/* Sofia student support widget — appears when Daniela flags a technical incident */}
        {streamingVoice.state.sofiaIncident && (
          <SofiaWidget
            incident={streamingVoice.state.sofiaIncident}
            onResolved={() => {/* all_clear WS event hides the widget via state */}}
          />
        )}

        {/* Spotlight — full-screen dimmed overlay with message bubble */}
        {spotlight && (
          <div
            className="absolute inset-0 z-50 bg-black/65 flex items-center justify-center"
            onClick={() => { if (spotlightTimerRef.current) clearTimeout(spotlightTimerRef.current); setSpotlight(null); }}
            data-testid="spotlight-overlay"
          >
            <div className="bg-card border rounded-md shadow-xl px-6 py-5 max-w-xs mx-4 text-center" onClick={e => e.stopPropagation()}>
              <Sparkles className="h-6 w-6 text-blue-400 mx-auto mb-3" />
              <p className="text-sm font-medium leading-snug">{spotlight.message}</p>
              {spotlight.zone !== 'screen' && (
                <p className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wide">{spotlight.zone}</p>
              )}
              <Button size="sm" variant="ghost" className="mt-3 text-xs text-muted-foreground" data-testid="button-spotlight-dismiss" onClick={() => { if (spotlightTimerRef.current) clearTimeout(spotlightTimerRef.current); setSpotlight(null); }}>
                Got it
              </Button>
            </div>
          </div>
        )}

        {/* Vision toggles — opt-in webcam + screen share for Daniela */}
        {useStreamingMode && vision.isVisionSupported &&
          (visionPhase === 'live' || vision.webcamActive || vision.screenActive) && (
          <div className="absolute bottom-24 right-3 z-50 flex flex-col gap-1.5 items-end">
            <Button
              size="icon"
              variant={vision.webcamActive ? 'default' : 'ghost'}
              onClick={vision.toggleWebcam}
              className="opacity-70 hover:opacity-100"
              data-testid="button-vision-webcam"
              title={vision.webcamActive ? 'Stop sharing camera with Daniela' : 'Share your camera with Daniela'}
            >
              <Camera className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant={vision.screenActive ? 'default' : 'ghost'}
              onClick={vision.toggleScreen}
              className="opacity-70 hover:opacity-100"
              data-testid="button-vision-screen"
              title={vision.screenActive ? 'Stop sharing screen with Daniela' : 'Share your screen with Daniela'}
            >
              <Monitor className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Start-hint fallback: shown when greeting hasn't arrived after 5s */}
        {showStartHint && (
          <div
            className="absolute inset-x-0 bottom-24 flex justify-center pointer-events-none z-50"
            data-testid="text-greeting-start-hint"
          >
            <div className="bg-background/80 backdrop-blur-sm border border-border rounded-lg px-4 py-2 text-sm text-muted-foreground animate-in fade-in duration-500">
              She&apos;s ready — say hello to begin
            </div>
          </div>
        )}

        <VoiceChatViewManager
          conversationId={conversationId}
          voiceSessionId={streamingVoice.state.voiceSessionId}
          connectionState={streamingVoice.state.connectionState}
          messages={messages}
          onRecordingStart={inputMode === 'open-mic' ? handleOpenMicTap : startPushToTalkRecording}
          onRecordingStop={inputMode === 'open-mic' ? () => {} : stopPushToTalkRecording}
          isRecording={isRecording}
          isMicPreparing={isMicPreparing}
          isProcessing={isProcessing}
          isPlaying={globalPlaybackState === 'playing' || globalPlaybackState === 'buffering' || streamingVoice.microAckPlaying}
          isConnecting={useStreamingMode && (streamingVoice.state.connectionState === 'connecting' || streamingVoice.state.connectionState === 'reconnecting')}
          isReconnecting={useStreamingMode && streamingVoice.state.connectionState === 'reconnecting'}
          reconnectMessage={
            // Surface a reconnect message for all WS drops so the user knows why Daniela is silent.
            // Fast reconnects (~1-3s): generic "Reconnecting..." keeps users informed without alarm.
            // Prolonged restarts (attempt >3): show the specific server restart message.
            useStreamingMode && streamingVoice.state.connectionState === 'reconnecting'
              ? (streamingVoice.state.error?.includes('Server is restarting')
                  ? streamingVoice.state.error
                  : 'Reconnecting...')
              : undefined
          }
          isUsersTurn={
            // Mic is ONLY unlocked when ALL of these are true:
            // 1. Connection is 'ready' OR 'connected' OR 'streaming' (all valid working states)
            // 2. Not processing (not waiting for AI response)
            // 3. Not playing/speaking (AI not talking) - use globalPlaybackState for reliable immediate response
            // 4. Not connecting/reconnecting
            // 5. NOT switching tutors (mic stays locked during handoff)
            // 
            // CRITICAL: Use globalPlaybackState from the global store instead of hook's internal state
            // The global store is reliable during HMR whereas hook state may have stale closures
            // 
            // SPECIAL CASE: If user is HOLDING PTT (isPttButtonHeld), keep mic active!
            // This allows speculative PTT to play audio while user still has control.
            // 
            // ALSO unlock if there's an error but connection is valid (recoverable state)
            (streamingVoice.state.connectionState === 'ready' || streamingVoice.state.connectionState === 'connected' || streamingVoice.state.connectionState === 'streaming') &&
            !streamingVoice.state.isSwitchingTutor &&  // Mic locked during tutor handoff
            (
              // PTT ACTIVE: If user is holding PTT button, keep mic active regardless of audio state
              // This is critical for speculative PTT - user maintains control while holding
              isPttButtonHeld ||
              // Normal case: not processing and playback is idle (using globalPlaybackState for reliability)
              (!isProcessing && !streamingVoice.state.isProcessing && globalPlaybackState === 'idle') ||
              // Error recovery: server says not processing even if local state got stuck
              (!!streamingVoice.state.error && !streamingVoice.state.isProcessing && globalPlaybackState === 'idle')
            )
          }
          onEndCall={handleEndCall}
          tutorGender={tutorGender}
          voiceSpeed={voiceSpeed}
          setTutorGender={(gender) => {
            setTutorGender(gender);
            if (useStreamingMode) {
              streamingVoice.updateVoice(gender);
            }
          }}
          setVoiceSpeed={setVoiceSpeed}
          femaleVoiceName={tutorNames.female}
          maleVoiceName={tutorNames.male}
          baseSpeakingRate={tutorGender === 'male' 
            ? (tutorVoices?.male?.speakingRate ?? 1.0) 
            : (tutorVoices?.female?.speakingRate ?? 1.0)}
          isDeveloper={isDeveloper || isAdmin}
          classId={classId}
          onReloadCredits={() => reloadCreditsMutation.mutate()}
          onResetData={() => resetDataMutation.mutate()}
          isReloadingCredits={reloadCreditsMutation.isPending}
          isResettingData={resetDataMutation.isPending}
          whiteboardItems={useDesktopWhiteboard ? [] : whiteboard.items}
          onClearWhiteboard={whiteboard.clear}
          onDrillComplete={(drillId, drillType, isCorrect, responseTimeMs, toolContent) => {
            if (useStreamingMode) {
              streamingVoice.sendDrillResult(drillId, drillType, isCorrect, responseTimeMs, toolContent);
            }
          }}
          onTextInputSubmit={(itemId, response) => {
            if (useStreamingMode) {
              streamingVoice.sendTextInput(itemId, response);
            }
          }}
          subtitleState={streamingVoice.subtitles.state}
          regularSubtitleMode={whiteboard.regularSubtitleMode}
          customOverlayText={whiteboard.customOverlayText}
          inputMode={inputMode}
          setInputMode={setInputMode}
          openMicState={openMicState}
          showListeningPatience={showListeningPatience}
          isPttButtonHeld={isPttButtonHeld}
          playbackState={globalPlaybackState as 'idle' | 'buffering' | 'playing' | 'paused'}
          onInterrupt={() => {
            streamingVoice.stop();
            streamingVoice.sendInterrupt();
          }}
          voiceOverride={voiceOverride}
          onVoiceOverrideChange={setVoiceOverride}
          onHelpClick={() => setIsSupportModalOpen(true)}
          microAckPlaying={streamingVoice.microAckPlaying}
          backdropImageUrl={backdropImageUrl}
        />
      </div>
      
      {/* Support modal - triggered by help button in controls */}
      <SupportAssistModal
        isOpen={isSupportModalOpen}
        onClose={() => setIsSupportModalOpen(false)}
        ticketId={null}
        category="technical"
        reason="Help request during voice chat"
        priority="normal"
        mode="support"
      />
    </div>
    </VoiceInputContext.Provider>
  );
}
