import { resetDebugTimingState, logEmptyChunkProcessed, logSentenceTransition, logScheduleEvent, updateDebugTimingState, getDebugTimingState, registerPlayerInstance, type SentenceScheduleEntry, type SentenceMatchInfo } from './debugTimingState';
import type { ClientTelemetryEventType } from '../../../shared/streaming-voice-types';
import { getClientTelemetryEmitter } from './streamingVoiceClient';
import { setGlobalPlaybackState } from './playbackStateStore';
import { diagMarkMismatchRecovery, diagEvent } from './lockoutDiagnostics';
import { ClientPlaybackLedger } from '../../../shared/playback-ledger';

// One per page: what the player did with each turn of Daniela's Gemini Live audio,
// sent as a single summary per finalized turn (design note 135fe51b rev 2).
const playbackLedger = new ClientPlaybackLedger(summary => {
  getTelemetryEmitter()?.emit('playback_turn_summary', { playbackSummary: summary });
});
export function getPlaybackLedger(): ClientPlaybackLedger {
  return playbackLedger;
}

// Wrapper for telemetry emitter
function getTelemetryEmitter() {
  try {
    return getClientTelemetryEmitter();
  } catch (e) {
    console.warn('[AUDIO UTILS] Failed to get telemetry emitter:', e);
    return null;
  }
}

/**
 * WORD TIMING DIAGNOSTICS FEATURE FLAGS
 * 
 * ENABLE_WORD_TIMING_DIAGNOSTICS (true):
 *   - Enables full word-level timing in the 60fps loop (required for karaoke)
 *   - Updates debug panel state for timing visualization
 *   - Per-frame word schedule scanning (findActiveWord)
 *   
 * VERBOSE_TIMING_LOGS (false - DEFAULT OFF for clean architecture):
 *   - Per-frame console.log/error output for deep debugging
 *   - Word match logs, schedule dumps, timing loop frames
 *   - Turn ON only when actively debugging timing issues
 * 
 * ARCHITECTURE: Works with buffered streaming (PROGRESSIVE_AUDIO_STREAMING: false)
 * to guarantee all word timings are available before playback starts.
 * AudioContext.currentTime is the single source of truth for synchronization.
 * 
 * RUNTIME TOGGLE via DevTools:
 *   window.__enableWordTimingDiagnostics = true/false  (timing loop behavior)
 *   window.__verboseTimingLogs = true/false            (console output)
 */
const ENABLE_WORD_TIMING_DIAGNOSTICS = true;
const VERBOSE_TIMING_LOGS = false;  // OFF by default for clean/fast architecture

// Allow runtime override via DevTools console
declare global {
  interface Window {
    __enableWordTimingDiagnostics?: boolean;
    __verboseTimingLogs?: boolean;
  }
}

function isWordTimingEnabled(): boolean {
  return window.__enableWordTimingDiagnostics ?? ENABLE_WORD_TIMING_DIAGNOSTICS;
}

export function isVerboseLoggingEnabled(): boolean {
  return window.__verboseTimingLogs ?? VERBOSE_TIMING_LOGS;
}

/**
 * CRITICAL: Store StreamingAudioPlayer singleton on window to prevent Vite bundler
 * duplicate module issue. Without this, Vite may create multiple module copies,
 * each with its own instance - one receives audio chunks while another runs the
 * timing loop, causing subtitle synchronization to fail.
 * 
 * Pattern: Same as documented for StreamingVoiceClient in replit.md
 */
declare global {
  interface Window {
    __streamingAudioPlayer?: StreamingAudioPlayer;
  }
}

/**
 * Get or create the singleton StreamingAudioPlayer instance.
 * MUST be used instead of `new StreamingAudioPlayer()` to prevent duplicate instances.
 */
export function getStreamingAudioPlayer(): StreamingAudioPlayer {
  if (!window.__streamingAudioPlayer) {
    const instanceId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    window.__streamingAudioPlayer = new StreamingAudioPlayer();
    
    // Register instance for debug panel visibility
    registerPlayerInstance(instanceId);
  }
  return window.__streamingAudioPlayer;
}

/**
 * Helper to immediately update debug state with current schedule
 * Called when schedule entries are added/modified
 */
function updateDebugSchedule(sentenceSchedule: Map<number, {
  startCtxTime: number;
  totalDuration: number;
  endCtxTime?: number;
  started: boolean;
  ended: boolean;
}>) {
  const scheduleArray: SentenceScheduleEntry[] = Array.from(sentenceSchedule.entries()).map(([idx, e]) => ({
    sentenceIndex: idx,
    startCtxTime: e.startCtxTime,
    totalDuration: e.totalDuration,
    endCtxTime: e.endCtxTime,
    started: e.started,
    ended: e.ended
  }));
  
  updateDebugTimingState({ sentenceSchedule: scheduleArray });
}

// Convert Int16Array PCM to base64 string
export function pcm16ToBase64(pcm16: Int16Array): string {
  const uint8Array = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;

  async startRecording(onDataAvailable: (audioData: ArrayBuffer) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } 
      });

      this.audioContext = new AudioContext({ sampleRate: 24000 });
      const source = this.audioContext.createMediaStreamSource(this.stream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(this.audioContext.destination);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32Array to Int16Array (PCM16)
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        onDataAvailable(pcm16.buffer);
      };
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }

  stopRecording(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

export class AudioPlayer {
  private audioContext: AudioContext;
  private gainNode: GainNode;
  private queue: AudioBuffer[] = [];
  private isPlaying = false;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
  }

  // Public method to resume AudioContext (called on user interaction)
  async resume(): Promise<void> {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async playAudio(base64Audio: string): Promise<void> {
    try {
      // CRITICAL: Resume AudioContext if suspended (browser autoplay policy)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      const audioData = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
      const pcm16 = new Int16Array(audioData.buffer);
      
      // Convert PCM16 to Float32
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      this.queue.push(audioBuffer);
      
      if (!this.isPlaying) {
        this.playNext();
      }
    } catch (error) {
      // Keep unguarded - essential operational error
      console.error('[AUDIO PLAYER] Error playing audio:', error);
    }
  }

  private playNext(): void {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const buffer = this.queue.shift()!;
    
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    
    source.onended = () => {
      this.playNext();
    };

    try {
      source.start();
    } catch (error) {
      // Keep unguarded - essential operational error
      console.error('[AUDIO PLAYER] Error calling source.start():', error);
      this.playNext();
    }
  }

  stop(): void {
    this.queue = [];
    this.isPlaying = false;
  }
}

/**
 * Streaming Audio Player
 * 
 * Optimized for progressive playback of streaming audio chunks.
 * Supports:
 * - MP3 playback via HTMLAudioElement (better browser support)
 * - Raw PCM playback via Web Audio API (lower latency, native timestamps)
 */
export interface StreamingAudioChunk {
  sentenceIndex: number;
  audio: ArrayBuffer;
  durationMs: number;
  isLast: boolean;
  audioFormat?: 'mp3' | 'pcm_f32le';  // Audio format (default: 'mp3')
  sampleRate?: number;  // Sample rate for PCM (default: 24000)
  chunkIndex?: number;  // For progressive PCM chunks (hold/release playback)
  turnId?: number;      // Server turn id, for the playback ledger
}

export type StreamingPlaybackState = 'idle' | 'buffering' | 'playing' | 'paused';

export interface StreamingPlaybackCallbacks {
  onStateChange?: (state: StreamingPlaybackState) => void;
  onProgress?: (currentTime: number, duration: number) => void;
  onSentenceStart?: (sentenceIndex: number) => void;
  onSentenceEnd?: (sentenceIndex: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  onPendingAudioChange?: (count: number) => void;
}

export class StreamingAudioPlayer {
  private queue: StreamingAudioChunk[] = [];
  private currentAudio: HTMLAudioElement | null = null;
  private currentSentenceIndex = -1;
  private state: StreamingPlaybackState = 'idle';
  
  // MULTI-SUBSCRIBER PATTERN: Registry of all active callback subscribers
  // This survives Vite HMR by allowing multiple component instances to register/unregister
  private subscribers: Map<string, StreamingPlaybackCallbacks> = new Map();
  
  // Legacy single callback (deprecated - kept for compatibility during transition)
  private callbacks: StreamingPlaybackCallbacks = {};
  private objectUrls: string[] = [];
  private isPlaying = false;
  private pendingAudioCount = 0;
  
  // Store all audio chunks for replay functionality
  private allAudioChunks: ArrayBuffer[] = [];
  private combinedAudioBlob: Blob | null = null;
  
  // High-precision timing using performance.now()
  private playbackStartTime: number | null = null;
  private rafId: number | null = null;
  private currentDuration = 0;
  
  // Web Audio API for raw PCM playback
  private audioContext: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private currentPcmSource: AudioBufferSourceNode | null = null;
  private currentAudioFormat: 'mp3' | 'pcm_f32le' = 'mp3';
  
  // PROGRESSIVE STREAMING: Accumulator for progressive PCM chunks
  private progressiveSentenceIndex = -1;
  private progressiveChunks: Float32Array[] = [];
  private progressiveScheduledTime = 0; // Next scheduled play time in AudioContext
  private progressiveSources: AudioBufferSourceNode[] = []; // Track active sources for cleanup
  private progressiveFirstChunkStarted = false;
  private progressivePlaybackStartCtxTime = 0; // AudioContext.currentTime when first chunk started
  private progressiveTotalDuration = 0; // Total accumulated duration of all chunks
  
  // SENTENCE SCHEDULE: Track all sentences with their scheduled times
  // This allows a unified timing loop to determine which sentence is active
  private sentenceSchedule: Map<number, {
    startCtxTime: number;      // AudioContext time when this sentence starts
    totalDuration: number;     // Accumulated duration of all chunks
    endCtxTime?: number;       // Computed end time (set when last chunk arrives)
    started: boolean;          // Whether onSentenceStart has been fired
    ended: boolean;            // Whether onSentenceEnd has been fired
  }> = new Map();
  
  // WORD SCHEDULE: Track all words with ABSOLUTE AudioContext times
  // This enables direct word matching without needing sentence duration calculations
  private wordSchedule: Map<string, {
    sentenceIndex: number;
    wordIndex: number;
    word: string;
    absoluteStartTime: number;  // AudioContext time when word starts
    absoluteEndTime: number;    // AudioContext time when word ends
  }> = new Map();  // Key: "s{sentenceIndex}_w{wordIndex}"
  
  // Track which sentence the timing loop is currently reporting on
  private activeSentenceInLoop = -1;
  
  // Counter for word matches (for throttled logging)
  private wordMatchCount = 0;
  
  // TURN COMPLETION: Expected sentence count from response_complete message
  // Prevents premature loop termination when not all sentences have arrived yet
  private expectedSentenceCount: number | null = null;
  
  // HOLD PLAYBACK: When true, audio is buffered but playback is deferred until released
  // Used during PTT recording to prevent AI speaking while user is still holding the button
  private playbackHeld = false;
  private heldChunks: StreamingAudioChunk[] = [];
  
  // DEDUPLICATION: Track processed audio chunks to prevent double playback
  // Key format: "s${sentenceIndex}_c${chunkIndex}"
  // PRODUCTION FIX: In production, the Replit proxy or network conditions can cause
  // the same audio chunk to be delivered twice (via sentence_ready + audio_chunk, or retransmission)
  private processedChunks: Set<string> = new Set();
  
  // Time of the last successfully enqueued chunk (ms). Used as a fallback new-turn
  // detector: if a new turn's s0_c* arrives more than 20s after the last chunk, we
  // force-clear the dedup set even if progressiveFirstChunkStarted is still true.
  // This guards against the race where a `processing` WS message was dropped during
  // reconnect (so resetForNewTurn was never called), leaving stale keys that block
  // the first chunk of the genuinely-new turn.
  private lastChunkEnqueuedAt = 0;
  
  // CONTENT-HASH DEDUP: Last-resort dedup that catches same audio content
  // regardless of chunk/sentence index. Hashes first+last 64 floats of PCM data.
  // Cleared on new turn. Catches: transport retransmissions, proxy duplicates,
  // double TTS calls for same text, or any unknown path that re-delivers audio.
  private scheduledAudioHashes: Set<string> = new Set();
  
  // PER-TURN DIAGNOSTICS: Track source.start() calls for debugging double audio
  private turnScheduleCount = 0;
  private turnScheduleLog: Array<{ sentence: number; chunk: number; playTime: number; bytes: number; hash: string }> = [];
  
  // Per-sentence chunk counter for monotonic fallback when chunkIndex is missing
  // This prevents collision when multiple chunks have undefined chunkIndex
  private sentenceChunkCounters: Map<number, number> = new Map();
  
  // MOBILE FIX: Fallback timer in case onended doesn't fire
  // On mobile/Safari, the onended event sometimes fails to fire, leaving state stuck
  private chunkFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChunkEnded = false; // Flag to prevent double-firing from timer + onended
  
  constructor() {
    // Initialization - no logging needed
  }
  
  /**
   * Hold playback - audio will be buffered but not played
   * Call this when PTT recording starts
   */
  holdPlayback(): void {
    this.playbackHeld = true;
    console.log('[StreamingAudioPlayer] Playback held - buffering audio');
  }
  
  /**
   * Release playback - start playing any buffered audio
   * Call this when PTT recording stops
   */
  async releasePlayback(): Promise<void> {
    this.playbackHeld = false;
    console.log(`[StreamingAudioPlayer] Playback released - processing ${this.heldChunks.length} buffered chunks`);
    
    // Process all held chunks
    for (const chunk of this.heldChunks) {
      if (chunk.audioFormat === 'pcm_f32le') {
        // PCM chunks need progressive enqueue
        await this.enqueueProgressivePcmChunk(
          chunk.sentenceIndex,
          chunk.chunkIndex ?? 0,
          chunk.audio,
          chunk.durationMs,
          chunk.isLast,
          chunk.sampleRate || 24000,
          chunk.turnId
        );
      } else {
        this.enqueue(chunk);
      }
    }
    this.heldChunks = [];
  }
  
  /**
   * Check if playback is currently held
   */
  isPlaybackHeld(): boolean {
    return this.playbackHeld;
  }
  
  /**
   * Set expected sentence count from response_complete message
   * This signals that no more sentences will arrive for this turn.
   * The timing loop will only stop when all expected sentences have ended.
   */
  setExpectedSentenceCount(count: number): void {
    this.expectedSentenceCount = count;
    
    // Update debug panel
    updateDebugTimingState({
      expectedSentenceCount: count,
      sentencesReceived: this.sentenceSchedule.size,
    });
  }
  
  /**
   * Get or create AudioContext for PCM playback
   * Lazy initialization to comply with autoplay policies
   */
  private getAudioContext(): AudioContext {
    if (this.audioContext && this.audioContext.state === 'closed') {
      console.warn('[AudioPlayer] AudioContext was closed — creating fresh one');
      this.audioContext = null;
      this.masterGainNode = null;
    }
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      (this.audioContext as any).__debugId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
      
      this.masterGainNode = this.audioContext.createGain();
      this.masterGainNode.gain.value = 1.0;
      this.masterGainNode.connect(this.audioContext.destination);
      
      this.audioContext.addEventListener('statechange', () => {
        const state = this.audioContext?.state;
        console.log(`[AudioPlayer] AudioContext statechange → ${state}`);
        if (state === 'suspended') {
          console.log('[AudioPlayer] AudioContext suspended by OS — attempting auto-resume');
          this.audioContext?.resume().catch(err => {
            console.warn('[AudioPlayer] Auto-resume failed (will retry on user gesture):', err);
          });
        }
      });
    }
    return this.audioContext;
  }
  
  /**
   * Get the master gain node (audio output point)
   * All audio sources should connect to this instead of directly to destination
   */
  private getMasterGain(): GainNode {
    const ctx = this.getAudioContext();
    if (!this.masterGainNode) {
      this.masterGainNode = ctx.createGain();
      this.masterGainNode.gain.value = 1.0;
      this.masterGainNode.connect(ctx.destination);
    }
    return this.masterGainNode;
  }
  
  async resumeAudioContext(): Promise<void> {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      console.log('[AudioPlayer] Resuming suspended AudioContext');
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await ctx.resume();
          if ((ctx.state as string) === 'running') {
            console.log(`[AudioPlayer] AudioContext resumed → running (attempt ${attempt})`);
            return;
          }
          console.warn(`[AudioPlayer] AudioContext resume attempt ${attempt}: state=${ctx.state}, retrying...`);
        } catch (err) {
          console.warn(`[AudioPlayer] AudioContext resume attempt ${attempt} failed:`, err);
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 100 * attempt));
        }
      }
      console.warn(`[AudioPlayer] AudioContext still ${ctx.state} after ${maxRetries} retries`);
    }
  }
  
  /**
   * Get the current AudioContext state for external monitoring (e.g., mobile recovery)
   */
  getAudioContextState(): AudioContextState | 'uninitialized' {
    return this.audioContext ? this.audioContext.state : 'uninitialized';
  }
  
  /**
   * Get the combined audio blob for replay
   * Returns null if no audio has been played yet
   */
  getCombinedAudioBlob(): Blob | null {
    if (this.combinedAudioBlob) {
      return this.combinedAudioBlob;
    }
    
    // Combine all chunks into a single blob if not already done
    if (this.allAudioChunks.length > 0) {
      this.combinedAudioBlob = new Blob(this.allAudioChunks, { type: 'audio/mpeg' });
      return this.combinedAudioBlob;
    }
    
    return null;
  }
  
  /**
   * Clear stored audio chunks (call when starting a new response)
   */
  clearStoredAudio(): void {
    this.allAudioChunks = [];
    this.combinedAudioBlob = null;
  }
  
  /**
   * Reset player state for a new turn (response)
   * CRITICAL: Must be called when a new 'processing' message arrives
   * This clears the sentence/word schedule from the previous turn,
   * preventing stale callbacks from firing on the new turn's audio.
   */
  resetForNewTurn(): void {
    
    // Clear progressive playback state
    this.progressiveFirstChunkStarted = false;
    this.sentenceSchedule.clear();
    this.wordSchedule.clear();
    this.processedChunks.clear();  // DEDUPLICATION: Reset for new turn
    this.scheduledAudioHashes.clear();  // CONTENT-HASH DEDUP: Reset for new turn
    this.turnScheduleCount = 0;  // DIAGNOSTICS: Reset schedule counter
    this.turnScheduleLog = [];  // DIAGNOSTICS: Reset schedule log
    this.sentenceChunkCounters.clear();  // DEDUPLICATION: Reset counters for new turn
    this.pendingWordTimings.clear();  // CRITICAL: Also clear pending word timings
    this.activeSentenceInLoop = -1;
    this.progressiveSentenceIndex = -1;
    this.progressiveChunks = [];
    this.progressiveTotalDuration = 0;
    
    // CRITICAL: Reset expected sentence count - will be set when response_complete arrives
    this.expectedSentenceCount = null;
    
    // Reset debug panel sentence tracking
    updateDebugTimingState({
      expectedSentenceCount: null,
      sentencesReceived: 0,
      sentencesEnded: 0,
      sentencesStarted: 0,
      allSentencesEnded: false,
    });
    
    // Reset timing anchors
    const ctx = this.audioContext;
    if (ctx) {
      // Use 0.4s prebuffer to reduce stuttering from network jitter
      this.progressiveScheduledTime = ctx.currentTime + 0.4;
      this.progressivePlaybackStartCtxTime = 0;
    }
    
    // Clear stored audio for replay
    this.allAudioChunks = [];
    this.combinedAudioBlob = null;
    
    // Log to debug panel
    logScheduleEvent('clear', [], undefined, 0);
  }
  
  /**
   * Get the number of pending audio chunks (queued + currently playing)
   */
  getPendingAudioCount(): number {
    return this.pendingAudioCount;
  }
  
  private updatePendingCount(count: number): void {
    this.pendingAudioCount = count;
    this.callbacks.onPendingAudioChange?.(count);
    this.notifyPendingAudioChange(count);
  }
  
  /**
   * Subscribe to playback callbacks with a unique ID
   * CRITICAL: This multi-subscriber pattern survives Vite HMR because each
   * component instance registers with a unique ID and unregisters on cleanup.
   * Unlike the single-callback pattern, stale closures are automatically cleaned up.
   */
  subscribe(subscriberId: string, callbacks: StreamingPlaybackCallbacks): void {
    console.log(`[AUDIO PLAYER] subscribe: ${subscriberId} (total: ${this.subscribers.size + 1})`);
    this.subscribers.set(subscriberId, callbacks);
    
    // Immediately notify new subscriber of current state (so they sync up)
    callbacks.onStateChange?.(this.state);
  }
  
  /**
   * Unsubscribe from playback callbacks
   * Called in useEffect cleanup to remove stale callbacks
   */
  unsubscribe(subscriberId: string): void {
    console.log(`[AUDIO PLAYER] unsubscribe: ${subscriberId} (remaining: ${this.subscribers.size - 1})`);
    this.subscribers.delete(subscriberId);
    
    // Warn if no subscribers remain (could indicate a bug)
    if (this.subscribers.size === 0) {
      console.warn('[AUDIO PLAYER] WARNING: No subscribers remaining - state changes will not reach UI');
    }
  }
  
  /**
   * Set playback callbacks (LEGACY - use subscribe/unsubscribe instead)
   * Kept for backward compatibility but also registers as a subscriber
   */
  setCallbacks(callbacks: StreamingPlaybackCallbacks): void {
    // CRITICAL: Fully replace callbacks to ensure fresh closures from remounted hooks
    // The singleton pattern means old closures can become stale when hooks remount
    console.log('[AUDIO PLAYER] setCallbacks called - replacing all callbacks');
    this.callbacks = { ...callbacks };
    
    // Also add to subscriber registry with a fixed ID
    // This ensures the multi-subscriber system works even with legacy code
    this.subscribers.set('legacy_setCallbacks', callbacks);
  }
  
  /**
   * Dispatch DOM CustomEvent for playback state changes
   * This is the RELIABLE fallback that always works, even during HMR when callbacks become stale
   */
  private dispatchDomEvent(state: StreamingPlaybackState, subscriberCount: number): void {
    try {
      window.dispatchEvent(new CustomEvent('streaming-playback-state', {
        detail: { state, timestamp: Date.now(), subscriberCount }
      }));
      console.log(`[DOM EVENT DISPATCH] ${state} (subscribers: ${subscriberCount})`);
    } catch (err) {
      console.error('[AUDIO PLAYER] DOM event dispatch failed:', err);
    }
  }
  
  /**
   * Notify all subscribers of a state change via callbacks
   * NOTE: DOM event is dispatched separately via dispatchDomEvent()
   */
  private notifyStateChange(state: StreamingPlaybackState): void {
    const subscriberIds = Array.from(this.subscribers.keys());
    console.log(`[AUDIO PLAYER] notifyStateChange: ${state} to ${this.subscribers.size} subscribers: [${subscriberIds.join(', ')}]`);
    
    // Subscriber callbacks (may have stale closures during HMR)
    Array.from(this.subscribers.entries()).forEach(([id, callbacks]) => {
      try {
        callbacks.onStateChange?.(state);
      } catch (err) {
        console.error(`[AUDIO PLAYER] Error in subscriber ${id} onStateChange:`, err);
      }
    });
  }
  
  /**
   * Notify all subscribers of pending audio count change
   */
  private notifyPendingAudioChange(count: number): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onPendingAudioChange?.(count);
    });
  }
  
  /**
   * Notify all subscribers of sentence start
   */
  private notifySentenceStart(sentenceIndex: number): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onSentenceStart?.(sentenceIndex);
    });
  }
  
  /**
   * Notify all subscribers of sentence end
   */
  private notifySentenceEnd(sentenceIndex: number): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onSentenceEnd?.(sentenceIndex);
    });
  }
  
  /**
   * Notify all subscribers of playback complete
   */
  private notifyComplete(): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onComplete?.();
    });
  }
  
  /**
   * Notify all subscribers of an error
   */
  private notifyError(error: Error): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onError?.(error);
    });
  }
  
  /**
   * Notify all subscribers of progress
   */
  private notifyProgress(currentTime: number, duration: number): void {
    Array.from(this.subscribers.values()).forEach(callbacks => {
      callbacks.onProgress?.(currentTime, duration);
    });
  }
  
  /**
   * Get current playback state
   */
  getState(): StreamingPlaybackState {
    return this.state;
  }
  
  /**
   * Enqueue an audio chunk for playback
   * Will start playing immediately if not already playing
   */
  enqueue(chunk: StreamingAudioChunk): void {
    console.log(`[AUDIO PLAYER] enqueue: sentence=${chunk.sentenceIndex}, isPlaying=${this.isPlaying}, held=${this.playbackHeld}`);
    
    // HOLD PLAYBACK: If held, buffer the chunk for later
    if (this.playbackHeld) {
      console.log(`[AUDIO PLAYER] Chunk held for later playback`);
      this.heldChunks.push(chunk);
      return;
    }
    
    // Store chunk for replay functionality
    this.allAudioChunks.push(chunk.audio);
    // Invalidate combined blob so it will be regenerated on next getCombinedAudioBlob()
    this.combinedAudioBlob = null;
    
    this.queue.push(chunk);
    this.updatePendingCount(this.pendingAudioCount + 1);
    
    // TELEMETRY: Track enqueue for production duplicate audio debugging
    try {
      const emitter = getTelemetryEmitter();
      if (emitter) {
        emitter.emit('audio_enqueued', {
          queueDepth: this.queue.length,
          audioLength: chunk.audio instanceof ArrayBuffer ? chunk.audio.byteLength : 0,
          format: chunk.audioFormat || 'unknown',
        }, chunk.sentenceIndex, chunk.chunkIndex);
        
        // Emit queue_status on every enqueue for backlog tracking
        emitter.emit('queue_status', {
          queueDepth: this.queue.length,
          pendingAudioCount: this.pendingAudioCount,
          event: 'ENQUEUE',
          isPlaying: this.isPlaying,
          warning: this.queue.length > 3 ? 'QUEUE_BACKLOG' : undefined,
        });
      }
    } catch (e) { /* telemetry failure shouldn't break audio */ }
    
    // Start playback if not already playing
    if (!this.isPlaying) {
      console.log(`[AUDIO PLAYER] Not playing, calling playNext()`);
      this.playNext();
    }
  }
  
  /**
   * PROGRESSIVE STREAMING: Enqueue a progressive PCM chunk for immediate playback
   * 
   * Unlike enqueue() which buffers entire sentences, this method schedules
   * PCM chunks for gapless playback as they arrive from the server.
   * 
   * Benefits:
   * - Audio starts playing as soon as first chunk arrives (~200ms after TTS start)
   * - No waiting for full sentence synthesis
   * 
   * @param sentenceIndex - Which sentence this chunk belongs to
   * @param chunkIndex - Index of this chunk within the sentence
   * @param audio - Raw PCM audio data (f32le, 24kHz mono)
   * @param durationMs - Duration of this chunk in milliseconds
   * @param isLast - Whether this is the final chunk for the sentence
   * @param sampleRate - Audio sample rate (default: 24000)
   */
  async enqueueProgressivePcmChunk(
    sentenceIndex: number,
    chunkIndex: number,
    audio: ArrayBuffer,
    durationMs: number,
    isLast: boolean,
    sampleRate: number = 24000,
    turnId?: number
  ): Promise<void> {
    // CRITICAL FIX (Jan 3/9, 2026): Detect new turn BEFORE deduplication check
    // Previously, the order was: check dedup → add to set → detect new turn → clear set
    // This caused double audio: first chunk was added then immediately cleared, allowing duplicate through
    // 
    // Updated (Jan 9): Now checks sentenceIndex only, NOT chunkIndex
    // This handles edge case where Cartesia sends empty marker at chunkIndex=0, 
    // then real audio at chunkIndex=1 - we still need to detect this as new turn
    //
    // Time-based fallback (March 2026): If `processing` WS message was dropped during
    // a reconnect, resetForNewTurn is never called and progressiveFirstChunkStarted
    // stays true from the old turn. Guard against this by treating s0_c* arriving
    // 20+ seconds after the last chunk as a guaranteed new-turn start — stale dedup
    // keys from a prior turn would otherwise block the new turn's audio.
    const timeSinceLastChunk = this.lastChunkEnqueuedAt ? (Date.now() - this.lastChunkEnqueuedAt) : Infinity;
    const isNewTurnStarting = sentenceIndex === 0 && (
      !this.progressiveFirstChunkStarted || timeSinceLastChunk > 20000
    );
    
    // For new turn, clear the deduplication set BEFORE checking for duplicates
    // BUT don't set progressiveFirstChunkStarted yet - wait until we confirm this isn't an empty marker chunk
    if (isNewTurnStarting) {
      if (timeSinceLastChunk > 20000 && this.progressiveFirstChunkStarted) {
        console.log(`[AUDIO PLAYER] Time-based new-turn detected (${Math.round(timeSinceLastChunk / 1000)}s gap) - force-clearing stale dedup state`);
      } else {
        console.log(`[AUDIO PLAYER] New turn detected - clearing deduplication state`);
      }
      this.processedChunks.clear();
      this.sentenceChunkCounters.clear();
      // Also reset progressive state so the rest of the new-turn logic works normally
      this.progressiveFirstChunkStarted = false;
    }
    
    // DEDUPLICATION: Skip chunks we've already processed
    // PRODUCTION FIX: Prevents double audio when same chunk arrives via multiple paths
    // (e.g., sentence_ready + audio_chunk, or network retransmission)
    // 
    // Strategy: Track (sentenceIndex, chunkIndex) pairs. True network duplicates
    // will have the same pair. Server always sends proper chunkIndex values.
    const chunkKey = `s${sentenceIndex}_c${chunkIndex}`;
    
    // PRODUCTION TELEMETRY: Track dedup stats at window level for debugging
    if (typeof window !== 'undefined') {
      const w = window as any;
      if (!w._dedupStats) {
        w._dedupStats = { blocked: 0, passed: 0, keys: new Set(), blockedKeys: [], lastReport: 0 };
      }
      if (this.processedChunks.has(chunkKey)) {
        w._dedupStats.blocked++;
        w._dedupStats.blockedKeys.push({ key: chunkKey, time: Date.now() });
        // Keep only last 20 blocked keys for memory
        if (w._dedupStats.blockedKeys.length > 20) {
          w._dedupStats.blockedKeys = w._dedupStats.blockedKeys.slice(-20);
        }
        
        // AUTO-REPORT: Send to Sofia when duplicates are detected (throttled)
        // Only report once per 5 minutes to avoid spam
        const now = Date.now();
        if (now - w._dedupStats.lastReport > 5 * 60 * 1000 && w._dedupStats.blocked >= 2) {
          w._dedupStats.lastReport = now;
          // Fire-and-forget POST to Sofia
          fetch('/api/support/report-double-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              blockedCount: w._dedupStats.blocked,
              passedCount: w._dedupStats.passed,
              blockedKeys: w._dedupStats.blockedKeys,
              userAgent: navigator.userAgent,
            }),
          }).catch(() => { /* Silently ignore errors */ });
          console.log(`[AUDIO PLAYER] DEDUP: Auto-reported ${w._dedupStats.blocked} blocked chunks to Sofia`);
        }
      } else {
        w._dedupStats.passed++;
        w._dedupStats.keys.add(chunkKey);
      }
    }
    
    // DEDUP CHECK ONLY - don't add to set yet (wait until after empty check)
    if (this.processedChunks.has(chunkKey)) {
      console.log(`[AUDIO PLAYER] DEDUP: Skipping duplicate chunk ${chunkKey}`);
      playbackLedger.dropped(turnId, 'index_dedup');
      return;
    }
    
    // Update last-received timestamp now that this chunk has cleared dedup.
    // Used by the time-based new-turn detection above.
    this.lastChunkEnqueuedAt = Date.now();
    
    // HOLD PLAYBACK: If held, buffer the chunk for later as a StreamingAudioChunk
    // NOTE: Held chunks are NOT added to dedup set - they'll be processed later
    if (this.playbackHeld) {
      console.log(`[AUDIO PLAYER] Progressive chunk held for later playback`);
      this.heldChunks.push({
        sentenceIndex,
        chunkIndex,
        audio,
        durationMs,
        isLast,
        audioFormat: 'pcm_f32le',
        sampleRate,
        turnId,
      });
      return;
    }
    
    // Handle empty audio chunks (isLast=true marker chunks)
    // These chunks have 0 audio data but signal sentence completion
    // NOTE: Empty chunks are NOT added to dedup set - they don't block real audio
    if (audio.byteLength === 0) {
      if (isLast) {
        // TRAILING SILENCE: The server sends (audio='', isLast=true) as a marker AFTER
        // all real PCM chunks. This is where the silence must be scheduled — the fix at
        // line ~1192 is on the real-audio path and never fires for these marker chunks.
        // Without this, the AudioContext cuts hard on the final sample, clipping the
        // natural decay of the last phoneme.
        //
        // ORDERING FIX: Schedule trailing silence BEFORE setting endCtxTime so the
        // timing loop sees the correct sentence-end boundary (including the silence
        // padding) and does not fire playback_ended while silence is still in the queue.
        const trailingCtx = this.getAudioContext();
        const TRAILING_SEC = 0.3;
        if (trailingCtx.state === 'running' && this.progressiveScheduledTime > trailingCtx.currentTime) {
          const silenceSamples = Math.round(TRAILING_SEC * sampleRate);
          const silenceBuffer = trailingCtx.createBuffer(1, silenceSamples, sampleRate);
          const silenceSource = trailingCtx.createBufferSource();
          silenceSource.buffer = silenceBuffer;
          silenceSource.connect(this.getMasterGain());
          silenceSource.start(this.progressiveScheduledTime);
          this.progressiveScheduledTime += TRAILING_SEC;
        }

        // Set endCtxTime AFTER trailing silence so timing loop measures to true end
        const entry = this.sentenceSchedule.get(sentenceIndex);
        let endCtxTimeSet = false;
        if (entry) {
          entry.endCtxTime = this.progressiveScheduledTime; // includes trailing silence
          endCtxTimeSet = true;
        }

        // Update debug panel with empty chunk info
        logEmptyChunkProcessed(sentenceIndex, endCtxTimeSet);
        
        // Also call the existing finalize method
        this.finalizeProgressiveSentence(sentenceIndex);
      }
      return;
    }
    
    // === ONLY NOW add to dedup set - after confirming this is real audio ===
    // This ensures empty/marker chunks don't block subsequent real audio
    this.processedChunks.add(chunkKey);
    
    // Track chunk count per sentence for telemetry
    const currentCounter = this.sentenceChunkCounters.get(sentenceIndex) || 0;
    this.sentenceChunkCounters.set(sentenceIndex, currentCounter + 1);
    
    // Telemetry: Warn if chunkIndex suggests normalization occurred (0 when counter > 0)
    // This shouldn't happen since server sends proper indices, but log for debugging
    if (chunkIndex === 0 && currentCounter > 0) {
      console.warn(`[AUDIO PLAYER] DEDUP WARNING: chunkIndex=0 received after ${currentCounter} chunks for sentence ${sentenceIndex}`);
    }
    
    // CRITICAL FIX (Jan 9, 2026): Set flag HERE after empty chunk check
    // This prevents race condition where second chunk clears dedup set
    // The flag is set AFTER: dedup check passes AND chunk is not empty
    // This ensures only real audio chunks mark the turn as started
    if (isNewTurnStarting) {
      this.progressiveFirstChunkStarted = true;
    }
    
    const ctx = this.getAudioContext();
    
    // Resume AudioContext if suspended — aggressive retry on each chunk
    if (ctx.state === 'suspended') {
      console.log('[AudioPlayer] AudioContext suspended at chunk receive — resuming');
      try {
        await ctx.resume();
      } catch (resumeErr) {
        console.warn('[AudioPlayer] Failed to resume AudioContext at chunk:', resumeErr);
      }
      if ((ctx.state as string) !== 'running') {
        console.warn(`[AudioPlayer] AudioContext still ${ctx.state} after resume at chunk — audio may not play`);
      }
    }
    
    // Detect new sentence - DON'T stop current audio, let it finish naturally!
    // BUG FIX: Also detect new TURN by checking if sentenceIndex === 0
    // This handles the case where previous turn ended at sentence 0 (single-sentence response)
    // In that case, sentenceIndex === progressiveSentenceIndex but it's a NEW turn
    const isNewSentence = sentenceIndex !== this.progressiveSentenceIndex;
    
    // Capture isPlaying state BEFORE modifying it
    // This is needed for the restart loop logic below
    const wasPlayingBeforeThisChunk = this.isPlaying;
    
    if (isNewSentence || isNewTurnStarting) {
      // Clear arrays for new sentence (old sources will continue playing)
      this.progressiveChunks = [];
      
      // For new turn, reset timing state (dedup already cleared above)
      if (isNewTurnStarting) {
        // NOTE: progressiveFirstChunkStarted is set at line ~888 AFTER empty chunk check
        // This prevents race condition while also handling empty marker chunks correctly
        this.sentenceSchedule.clear();
        this.wordSchedule.clear();
        // NOTE: processedChunks already cleared above BEFORE dedup check
        this.activeSentenceInLoop = -1;
        // OVERLAP FIX: Preserve progressiveScheduledTime if it's still in the future.
        // processing_pending + first chunk can arrive while the previous turn's WebAudio
        // sources are still playing (they are fire-and-forget; clearing sentenceSchedule
        // doesn't stop them). Resetting to ctx.currentTime + 0.4 would schedule new-turn
        // audio into the middle of old-turn playback. Use max() so the old schedule is
        // honoured when audio is still in flight, and only reset when we're past the end.
        this.progressiveScheduledTime = Math.max(
          this.progressiveScheduledTime,
          ctx.currentTime + 0.4,
        );
        this.progressivePlaybackStartCtxTime = 0;
      }
      
      this.progressiveSentenceIndex = sentenceIndex;
      this.currentSentenceIndex = sentenceIndex;
      
      // Schedule new sentence after current audio ends (gapless playback)
      // If no audio scheduled yet, start from now + prebuffer
      if (this.progressiveScheduledTime <= ctx.currentTime) {
        this.progressiveScheduledTime = ctx.currentTime + 0.4;
      }
      
      this.progressiveTotalDuration = 0;
      this.isPlaying = true;
      this.setState('buffering');
    }
    
    // SAFETY: Ensure scheduled time is always in the future
    // If we've fallen behind, reset to current time + prebuffer
    if (this.progressiveScheduledTime < ctx.currentTime) {
      this.progressiveScheduledTime = ctx.currentTime + 0.4;
    }
    
    // Convert raw PCM bytes to Float32Array
    // SAFETY: Ensure byte length is a multiple of 4 (required for Float32Array)
    let rawAudioBytes = audio;
    if (audio.byteLength % 4 !== 0) {
      console.warn(`[AUDIO] Byte length ${audio.byteLength} not multiple of 4, truncating`);
      const truncatedLength = Math.floor(audio.byteLength / 4) * 4;
      if (truncatedLength === 0) {
        console.warn(`[AUDIO] Chunk too small to use, skipping`);
        return;
      }
      rawAudioBytes = audio.slice(0, truncatedLength);
    }
    const float32Data = new Float32Array(rawAudioBytes);
    const numSamples = float32Data.length;
    const chunkDuration = numSamples / sampleRate;
    
    // Handle empty audio chunks (isLast=true marker chunks)
    // These chunks have 0 audio data but signal sentence completion
    if (numSamples === 0) {
      if (isLast) {
        // TRAILING SILENCE: safety net for near-empty chunks (1-3 bytes, truncated to 0 samples)
        if (ctx.state === 'running' && this.progressiveScheduledTime > ctx.currentTime) {
          const TRAILING_SEC = 0.3;
          const silenceSamples = Math.round(TRAILING_SEC * sampleRate);
          const silenceBuffer = ctx.createBuffer(1, silenceSamples, sampleRate);
          const silenceSource = ctx.createBufferSource();
          silenceSource.buffer = silenceBuffer;
          silenceSource.connect(this.getMasterGain());
          silenceSource.start(this.progressiveScheduledTime);
          this.progressiveScheduledTime += TRAILING_SEC;
        }
        // Keep the timing boundary after the fallback silence just like the
        // normal empty-marker path. Otherwise playback_ended can fire 300ms
        // early and reopen the mic while the tail is still scheduled.
        const entry = this.sentenceSchedule.get(sentenceIndex);
        if (entry) {
          entry.endCtxTime = this.progressiveScheduledTime;
        }
        this.scheduleProgressiveSentenceEnd(sentenceIndex, 0);
      }
      return; // Skip audio scheduling for empty chunks
    }
    
    // CONTENT-HASH DEDUP: Hash audio content before scheduling to catch same-audio duplicates
    // This is the LAST LINE OF DEFENSE against double audio. It catches cases where:
    // - Same TTS output arrives via different message paths (sentence_ready + audio_chunk)
    // - Transport retransmission sends identical audio with different chunk indices
    // - Any unknown server-side bug produces duplicate audio for the same text
    // Hash algorithm: Strided sampling across ENTIRE buffer (not just edges)
    // Uses 3 independent accumulators combined for ~96-bit fingerprint
    // Stride ensures we touch samples from start, middle, and end
    const stride = Math.max(1, Math.floor(float32Data.length / 256));
    let h1 = 0x811c9dc5; // FNV offset basis
    let h2 = 0;
    let h3 = 0x12345678;
    for (let hi = 0; hi < float32Data.length; hi += stride) {
      const sample = float32Data[hi] * 32767 | 0;
      h1 = Math.imul(h1 ^ sample, 0x01000193) | 0;  // FNV-1a inspired
      h2 = ((h2 << 5) - h2 + sample) | 0;           // djb2
      h3 = ((h3 << 7) ^ sample ^ (h3 >>> 3)) | 0;   // rotate-xor
    }
    const contentHash = `h${h1}_${h2}_${h3}_${numSamples}`;
    
    if (this.scheduledAudioHashes.has(contentHash)) {
      console.warn(`[AUDIO PLAYER] CONTENT-HASH DEDUP: Blocking duplicate audio! hash=${contentHash}, sentence=${sentenceIndex}, chunk=${chunkIndex}, bytes=${audio.byteLength}`);
      if (typeof window !== 'undefined') {
        const w = window as any;
        if (!w._contentDedupStats) w._contentDedupStats = { blocked: 0, details: [] };
        w._contentDedupStats.blocked++;
        w._contentDedupStats.details.push({ hash: contentHash, sentence: sentenceIndex, chunk: chunkIndex, time: Date.now() });
      }
      playbackLedger.dropped(turnId, 'content_hash_dedup');
      return;
    }
    this.scheduledAudioHashes.add(contentHash);
    
    // Store for potential replay
    this.progressiveChunks.push(float32Data);
    this.allAudioChunks.push(audio);
    this.combinedAudioBlob = null;
    
    // Create AudioBuffer
    const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    audioBuffer.getChannelData(0).set(float32Data);
    
    // Create and schedule buffer source
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.getMasterGain());
    this.progressiveSources.push(source);
    
    // Schedule at next available time for gapless playback
    const playTime = this.progressiveScheduledTime;
    source.start(playTime);
    if (turnId !== undefined) {
      try {
        playbackLedger.scheduled(turnId, sentenceIndex, chunkIndex, playTime, chunkDuration, ctx.state,
          typeof document !== 'undefined' && document.visibilityState === 'hidden');
        // onended also fires when a source is stopped early (barge-in, reset), so compare
        // the clock with the chunk's scheduled end to tell played-through from cut short.
        const scheduledEnd = playTime + chunkDuration;
        source.onended = () => playbackLedger.ended(turnId, ctx.currentTime >= scheduledEnd - 0.02);
      } catch { /* observation only */ }
    }
    this.progressiveScheduledTime += chunkDuration;
    this.progressiveTotalDuration += chunkDuration;
    
    // DIAGNOSTICS: Track every source.start() call for double-audio debugging
    this.turnScheduleCount++;
    this.turnScheduleLog.push({ sentence: sentenceIndex, chunk: chunkIndex, playTime, bytes: audio.byteLength, hash: contentHash });
    if (typeof window !== 'undefined') {
      (window as any)._turnScheduleLog = this.turnScheduleLog;
      (window as any)._turnScheduleCount = this.turnScheduleCount;
    }
    
    // Auto-resume if AudioContext becomes suspended (check only, no logging)
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    
    // Register sentence in schedule if this is its first chunk
    // Capture BEFORE modifying for loop restart logic below
    const isFirstChunkForSentence = !this.sentenceSchedule.has(sentenceIndex);
    if (isFirstChunkForSentence) {
      this.sentenceSchedule.set(sentenceIndex, {
        startCtxTime: playTime,
        totalDuration: 0,
        started: false,
        ended: false,
      });
      
      // Process any queued word timings for this sentence
      this.processPendingWordTimings(sentenceIndex);
    }
    
    // Accumulate duration for this sentence
    const scheduleEntry = this.sentenceSchedule.get(sentenceIndex)!;
    scheduleEntry.totalDuration += chunkDuration;
    
    // Start or restart the timing loop when needed
    // - For first REAL audio of first sentence of a turn: always start
    // - For first chunk of any sentence after loop was stopped: restart
    // - BUG FIX (March 2026): Also start if isPlaying was just set to true but loop isn't running
    //   This catches the case where isNewSentence set isPlaying=true but neither start condition triggered
    // CRITICAL: Use wasPlayingBeforeThisChunk, NOT this.isPlaying
    // because isPlaying gets set to true earlier in this function for new sentences
    // NOTE: isNewTurnStarting is computed BEFORE progressiveFirstChunkStarted is set
    // NOTE (Jan 9): Loop starts for first real audio regardless of chunkIndex, handling empty-first scenarios
    const shouldStartLoop = isNewTurnStarting;
    const shouldRestartLoop = !wasPlayingBeforeThisChunk && isFirstChunkForSentence;
    const loopNotRunning = !this.rafId;
    
    if (shouldStartLoop || shouldRestartLoop || (this.isPlaying && loopNotRunning)) {
      this.playbackStartTime = performance.now();
      this.isPlaying = true;
      const ctxState = this.audioContext?.state;
      if (ctxState === 'suspended') {
        this.setState('buffering');
        console.log('[AudioPlayer] AudioContext suspended at play start — reporting buffering instead of playing');
      } else {
        this.setState('playing');
      }
      this.startUnifiedTimingLoop();
    }
    
    // Track progressive state for sentence 0
    if (sentenceIndex === 0 && !this.progressivePlaybackStartCtxTime) {
      this.progressivePlaybackStartCtxTime = playTime;
    }
    
    // Update current duration for progress reporting
    this.currentDuration = this.progressiveTotalDuration;
    
    // Handle last chunk - set end time in schedule
    if (isLast) {
      // TRAILING SILENCE: Schedule 300ms of zeros after the last audio chunk.
      // Without this the browser's AudioContext cuts hard at the final sample,
      // clipping the natural decay of the last phoneme ("dynamic" sounds cut off).
      // The silence adds breathing room with zero latency cost — it only fires
      // at end-of-turn, after all speech audio is already queued.
      const TRAILING_SILENCE_SEC = 0.3;
      const silenceSamples = Math.round(TRAILING_SILENCE_SEC * sampleRate);
      const silenceBuffer = ctx.createBuffer(1, silenceSamples, sampleRate);
      // createBuffer zeroes the channel data by default — no fill needed
      const silenceSource = ctx.createBufferSource();
      silenceSource.buffer = silenceBuffer;
      silenceSource.connect(this.getMasterGain());
      silenceSource.start(this.progressiveScheduledTime);
      this.progressiveScheduledTime += TRAILING_SILENCE_SEC;

      const entry = this.sentenceSchedule.get(sentenceIndex);
      if (entry) {
        entry.endCtxTime = entry.startCtxTime + entry.totalDuration;
      }
      this.scheduleProgressiveSentenceEnd(sentenceIndex, chunkDuration);
    }
  }
  
  /**
   * Reset progressive streaming state
   */
  private resetProgressiveState(): void {
    // Stop all active progressive sources
    for (const source of this.progressiveSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Ignore - source may have already ended
      }
    }
    this.progressiveSources = [];
    this.progressiveChunks = [];
    this.progressiveFirstChunkStarted = false;
    this.progressivePlaybackStartCtxTime = 0;
    this.progressiveTotalDuration = 0;
    
    // Reset sentence and word schedules
    this.sentenceSchedule.clear();
    this.wordSchedule.clear();
    this.processedChunks.clear();  // DEDUPLICATION: Reset for new turn
    this.scheduledAudioHashes.clear();  // CONTENT-HASH DEDUP: Reset for new turn
    this.turnScheduleCount = 0;
    this.turnScheduleLog = [];
    this.sentenceChunkCounters.clear();  // DEDUPLICATION: Reset counters for new turn
    this.pendingWordTimings.clear();
    this.activeSentenceInLoop = -1;
    this.wordMatchCount = 0;
    
    // Reset debug state
    resetDebugTimingState();
  }
  
  // Queue for word timings that arrive before their sentence schedule entry exists
  private pendingWordTimings: Map<number, Array<{
    wordIndex: number;
    word: string;
    relativeStartTime: number;
    relativeEndTime: number;
  }>> = new Map();

  /**
   * WORD-BASED TIMING: Register a word timing with ABSOLUTE AudioContext times
   * 
   * Called when word_timing_delta arrives. Converts relative word times
   * (within sentence) to absolute AudioContext times for direct matching.
   * 
   * If sentence schedule entry doesn't exist yet (race condition), queues the
   * word timing to be processed when the sentence entry is created.
   * 
   * @param sentenceIndex - Which sentence this word belongs to
   * @param wordIndex - Index of word within sentence
   * @param word - The actual word text
   * @param relativeStartTime - Word start time relative to sentence start (seconds)
   * @param relativeEndTime - Word end time relative to sentence start (seconds)
   */
  registerWordTiming(
    sentenceIndex: number,
    wordIndex: number,
    word: string,
    relativeStartTime: number,
    relativeEndTime: number
  ): void {
    // Get sentence start time from schedule
    const sentenceEntry = this.sentenceSchedule.get(sentenceIndex);
    if (!sentenceEntry) {
      // Queue this word timing for later processing when sentence schedule exists
      if (!this.pendingWordTimings.has(sentenceIndex)) {
        this.pendingWordTimings.set(sentenceIndex, []);
      }
      this.pendingWordTimings.get(sentenceIndex)!.push({
        wordIndex,
        word,
        relativeStartTime,
        relativeEndTime
      });
      return;
    }
    
    // Calculate absolute AudioContext times
    const absoluteStartTime = sentenceEntry.startCtxTime + relativeStartTime;
    // Clamp word end time to sentence end time to prevent words extending past audio
    const sentenceEndTime = sentenceEntry.endCtxTime ?? (sentenceEntry.startCtxTime + sentenceEntry.totalDuration);
    const rawAbsoluteEndTime = sentenceEntry.startCtxTime + relativeEndTime;
    const absoluteEndTime = sentenceEntry.totalDuration > 0 ? Math.min(rawAbsoluteEndTime, sentenceEndTime) : rawAbsoluteEndTime;
    
    // Store in word schedule
    const key = `s${sentenceIndex}_w${wordIndex}`;
    this.wordSchedule.set(key, {
      sentenceIndex,
      wordIndex,
      word,
      absoluteStartTime,
      absoluteEndTime
    });
    
    // Verbose logging for word registration
    if (isVerboseLoggingEnabled()) {
      console.error(`[WORD SCHEDULE] Registered: ${key} "${word}" abs=${absoluteStartTime.toFixed(3)}-${absoluteEndTime.toFixed(3)}s`);
    }
    
    // Update debug state with word schedule
    this.updateWordScheduleDebugState();
  }
  
  /**
   * Process any queued word timings for a sentence after its schedule entry is created
   */
  private processPendingWordTimings(sentenceIndex: number): void {
    const pending = this.pendingWordTimings.get(sentenceIndex);
    if (!pending || pending.length === 0) return;
    
    for (const wordTiming of pending) {
      this.registerWordTiming(
        sentenceIndex,
        wordTiming.wordIndex,
        wordTiming.word,
        wordTiming.relativeStartTime,
        wordTiming.relativeEndTime
      );
    }
    
    // Clear the queue for this sentence
    this.pendingWordTimings.delete(sentenceIndex);
  }
  
  /**
   * Update debug state with current word schedule
   */
  private updateWordScheduleDebugState(): void {
    const wordEntries = Array.from(this.wordSchedule.values());
    const recentWords = wordEntries.slice(0, 20).map(e => ({
      sentenceIndex: e.sentenceIndex,
      wordIndex: e.wordIndex,
      word: e.word,
      absoluteStartTime: e.absoluteStartTime,
      absoluteEndTime: e.absoluteEndTime
    }));
    updateDebugTimingState({
      wordSchedule: recentWords,
      wordScheduleSize: this.wordSchedule.size
    });
  }
  
  /**
   * WORD-BASED TIMING: Find the currently active word based on AudioContext.currentTime
   * 
   * This is the core of the new word-based matching approach.
   * Returns the active word info or null if no word is active.
   */
  findActiveWord(): { sentenceIndex: number; wordIndex: number; word: string } | null {
    const ctx = this.audioContext;
    if (!ctx) return null;
    
    const now = ctx.currentTime;
    
    // Use Array.from for broader compatibility (avoids downlevelIteration issues)
    const wordEntries = Array.from(this.wordSchedule.entries());
    
    // DEBUG: Log word schedule state periodically - only when verbose logging enabled
    if (isVerboseLoggingEnabled() && wordEntries.length > 0 && Math.floor(now * 2) % 4 === 0) {
      // Find closest word for debugging
      let closestWord = wordEntries[0];
      let closestDiff = Math.abs(now - wordEntries[0][1].absoluteStartTime);
      for (let i = 1; i < wordEntries.length; i++) {
        const diff = Math.abs(now - wordEntries[i][1].absoluteStartTime);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestWord = wordEntries[i];
        }
      }
      const first3 = wordEntries.slice(0, 3).map(([k, e]) => `${k}:${e.absoluteStartTime.toFixed(2)}-${e.absoluteEndTime.toFixed(2)}`).join(', ');
      console.error(`[findActiveWord] now=${now.toFixed(3)}, closest="${closestWord[1].word}" ${closestWord[1].absoluteStartTime.toFixed(3)}-${closestWord[1].absoluteEndTime.toFixed(3)} (diff=${closestDiff.toFixed(3)}s) | first3=[${first3}]`);
    }
    
    // Iterate through all words and find the one that matches current time
    for (let i = 0; i < wordEntries.length; i++) {
      const [key, entry] = wordEntries[i];
      if (now >= entry.absoluteStartTime && now < entry.absoluteEndTime) {
        return {
          sentenceIndex: entry.sentenceIndex,
          wordIndex: entry.wordIndex,
          word: entry.word
        };
      }
    }
    
    // Log when NO match is found - only when verbose logging enabled
    if (isVerboseLoggingEnabled() && wordEntries.length > 0 && Math.floor(now * 2) % 4 === 0) {
      let minStart = Infinity, maxEnd = -Infinity;
      for (let i = 0; i < wordEntries.length; i++) {
        if (wordEntries[i][1].absoluteStartTime < minStart) minStart = wordEntries[i][1].absoluteStartTime;
        if (wordEntries[i][1].absoluteEndTime > maxEnd) maxEnd = wordEntries[i][1].absoluteEndTime;
      }
      console.error(`[NO WORD MATCH] now=${now.toFixed(3)}s, wordRange=${minStart.toFixed(3)}-${maxEnd.toFixed(3)}s, scheduleSize=${wordEntries.length}`);
    }
    
    return null;
  }
  
  // Type for sentence schedule entry
  private getSentenceScheduleEntry(index: number) {
    return this.sentenceSchedule.get(index);
  }
  
  /**
   * UNIFIED TIMING LOOP: Schedule-based approach that determines active sentence
   * based on AudioContext.currentTime vs sentence schedule.
   * 
   * This is the NEW approach - instead of delaying callbacks, we track all sentences'
   * scheduled times and let the timing loop fire onSentenceStart exactly when
   * each sentence's audio actually starts playing.
   */
  private startUnifiedTimingLoop(): void {
    // Cancel any existing timing loop
    this.stopPrecisionTiming();
    
    let frameCount = 0;
    
    const tick = (): void => {
      frameCount++;
      
      // Exit if playback stopped
      if (!this.isPlaying) {
        return;
      }
      
      const ctx = this.audioContext;
      if (!ctx) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      
      const now = ctx.currentTime;
      const ctxState = ctx.state;
      
      // Log AudioContext ID every 60 frames - only when verbose logging enabled
      if (frameCount % 60 === 0 && isVerboseLoggingEnabled()) {
        const ctxId = (ctx as any).__debugId || 'NO_ID';
        console.log(`[TICK DEBUG] Frame ${frameCount}: ctx.currentTime=${now.toFixed(3)}, ctx.state=${ctxState}, ctxId=${ctxId}`);
      }
      
      if (ctxState === 'suspended') {
        ctx.resume().catch(() => {});
      }
      
      if (ctxState === 'running' && this.state === 'buffering') {
        console.log('[AudioPlayer] AudioContext resumed — transitioning buffering → playing');
        this.setState('playing');
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // WORD TIMING DIAGNOSTICS: Skip heavy per-frame processing when disabled
      // This reduces CPU load significantly while preserving the loop for future use.
      // Re-enable via: window.__enableWordTimingDiagnostics = true in DevTools
      // ═══════════════════════════════════════════════════════════════════════════
      if (!isWordTimingEnabled()) {
        // MINIMAL LOOP: Only check for sentence end to maintain audio scheduling
        // Check if all sentences have ended (for proper cleanup)
        let allEnded = true;
        let anyStarted = false;
        const entries = Array.from(this.sentenceSchedule.entries());
        // CRITICAL FIX: Add 150ms grace period to prevent premature "ended" detection
        // AudioContext.currentTime can slightly lead actual audio buffer playback due to buffering
        const AUDIO_END_GRACE_PERIOD = 0.15; // 150ms
        for (const [index, entry] of entries) {
          // Mark sentences as started when their time arrives
          if (!entry.started && now >= entry.startCtxTime) {
            entry.started = true;
            this.currentSentenceIndex = index;
            this.notifySentenceStart(index);
          }
          
          // Mark sentences as ended ONLY when endCtxTime is explicitly set (i.e. isLast:true arrived).
          // Do NOT use the totalDuration fallback here — during a GL inter-sub-turn pause,
          // endCtxTime is undefined and totalDuration reflects only the first sub-turn's audio.
          // Using totalDuration would fire onSentenceEnd at the natural pause point and premature
          // setState('idle'), cutting the response before the second sub-turn audio plays.
          if (entry.endCtxTime !== undefined && !entry.ended && now >= entry.endCtxTime + AUDIO_END_GRACE_PERIOD) {
            entry.ended = true;
            if (!entry.started) entry.started = true;
            this.notifySentenceEnd(index);
          }
          
          if (entry.started) anyStarted = true;
          if (!entry.ended) allEnded = false;
        }
        
        // Stop loop when all sentences complete.
        // GUARD: Only stop if response_complete has been received (wsResponseCompleteReceived)
        // or expectedSentenceCount is known and we have enough sentences.
        // Without this guard, sentence N ending before sentence N+1 arrives from the server
        // prematurely fires setState('idle'), flickering the avatar to 'listening' mid-response.
        const minLoopDebugState = window.__debugTimingState;
        const minLoopResponseComplete = minLoopDebugState?.wsResponseCompleteReceived === true;
        const minLoopExpectedKnown = this.expectedSentenceCount !== null && this.sentenceSchedule.size >= this.expectedSentenceCount;
        if (anyStarted && allEnded && entries.length > 0 && (minLoopResponseComplete || minLoopExpectedKnown)) {
          this.isPlaying = false;
          this.setState('idle');
          this.notifyComplete();
          return;
        }
        
        // Continue minimal loop
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // FULL WORD TIMING DIAGNOSTICS (below) - Only runs when enabled
      // ═══════════════════════════════════════════════════════════════════════════
      
      // Update debug state every 10 frames (~160ms) with current timing info
      if (frameCount % 10 === 0) {
        const scheduleArray = Array.from(this.sentenceSchedule.entries()).map(([idx, e]) => ({
          sentenceIndex: idx,
          startCtxTime: e.startCtxTime,
          totalDuration: e.totalDuration,
          endCtxTime: e.endCtxTime,
          started: e.started,
          ended: e.ended
        }));
        
        const debugCtxId = (ctx as any).__debugId || 'NO_ID';
        updateDebugTimingState({
          isLoopRunning: true,
          loopTickCount: frameCount,
          currentCtxTime: now,
          audioContextState: ctxState as 'suspended' | 'running' | 'closed' | 'unknown',
          audioContextId: debugCtxId,
          activeSentenceIndex: this.activeSentenceInLoop,
          sentenceSchedule: scheduleArray,
          isPlaying: true
        });
      }
      
      // Debug log every 60 frames (~1 second) to see schedule state - only when verbose
      if (frameCount % 60 === 0 && isVerboseLoggingEnabled()) {
        const scheduleInfo: string[] = [];
        const entries = Array.from(this.sentenceSchedule.entries());
        for (let j = 0; j < entries.length; j++) {
          const [idx, e] = entries[j];
          const isStreaming = e.endCtxTime === undefined;
          const endT = e.endCtxTime ?? (e.startCtxTime + e.totalDuration);
          const matchesNow = now >= e.startCtxTime && (isStreaming || now < endT);
          scheduleInfo.push(`s${idx}:[${e.startCtxTime.toFixed(2)}-${endT.toFixed(2)}${isStreaming?'~':''},started=${e.started},match=${matchesNow}]`);
        }
        console.log(`[LOOP DEBUG] frame=${frameCount}, now=${now.toFixed(3)}, schedule: ${scheduleInfo.join(' | ')}`);
      }
      
      // Find which sentence is currently active based on schedule
      // PERFORMANCE: Iterate Map directly instead of Array.from() to avoid allocation per frame
      let activeIndex = -1;
      let activeEntry: { startCtxTime: number; totalDuration: number; endCtxTime?: number; started: boolean; ended: boolean } | null = null;
      
      // DEBUG: Build match info for ALL sentences every 10 frames
      const shouldUpdateMatchInfo = frameCount % 10 === 0;
      const matchInfoArray: SentenceMatchInfo[] = [];
      
      // Use Array.from for broader compatibility (avoids downlevelIteration issues)
      const scheduleEntries = Array.from(this.sentenceSchedule.entries());
      
      // DEBUG: Log schedule size and verify consistency (every 10 frames)
      if (frameCount % 10 === 0) {
        // Real bug check: scheduleEntries snapshot should match live Map size
        const scheduleArrayFromAbove = Array.from(this.sentenceSchedule.entries());
        if (scheduleEntries.length !== scheduleArrayFromAbove.length) {
          console.error(`[BUG!] MISMATCH: scheduleEntries.length=${scheduleEntries.length} but Map.size=${scheduleArrayFromAbove.length}`);
        }
        
        // Verbose-only: log all entry endCtxTime values (fires 6x/sec — keep behind flag)
        if (isVerboseLoggingEnabled()) {
          const entryDetails = scheduleEntries.map(([i, e]) => 
            `S${i}(end=${e.endCtxTime !== undefined ? e.endCtxTime.toFixed(2) : 'UNDEF'})`
          ).join(', ');
          console.log(`[LOOP] Frame ${frameCount}: entries=[${entryDetails}] now=${now.toFixed(2)}`);
        }
      }
      
      // Watchdog: warn once per 60 frames if entries are missing endCtxTime (streaming lag)
      if (frameCount % 60 === 0) {
        const entriesWithoutEndTime = scheduleEntries.filter(([_, e]) => e.endCtxTime === undefined);
        if (entriesWithoutEndTime.length > 0) {
          console.warn(`[LOOP WATCHDOG] ${entriesWithoutEndTime.length} entries WITHOUT endCtxTime: ${entriesWithoutEndTime.map(([i, e]) => 
            `S${i}(dur=${e.totalDuration.toFixed(2)})`
          ).join(', ')}`);
        }
      }
      
      for (let i = 0; i < scheduleEntries.length; i++) {
        const [index, entry] = scheduleEntries[i];
        // FIXED: Don't treat as "streaming forever" just because endCtxTime isn't set
        // Instead, use totalDuration as the fallback end time
        // Only truly "streaming" if we have no duration data yet (first chunk still arriving)
        const hasEnoughDuration = entry.totalDuration > 0.1; // At least 100ms of audio
        const endTime = entry.endCtxTime ?? (entry.startCtxTime + entry.totalDuration);
        
        // A sentence matches if:
        // 1. now >= startCtxTime (sentence has started)
        // 2. AND either: still streaming (no duration yet) OR now < computed end time
        const isActivelyStreaming = !hasEnoughDuration && entry.endCtxTime === undefined;
        const matches = now >= entry.startCtxTime && (isActivelyStreaming || now < endTime);
        
        // Build reason string
        let reason = '';
        if (now < entry.startCtxTime) {
          reason = `NOT YET: now(${now.toFixed(2)}) < start(${entry.startCtxTime.toFixed(2)})`;
        } else if (isActivelyStreaming) {
          reason = `STREAMING: now(${now.toFixed(2)}) >= start, buffering first chunks`;
        } else if (now >= endTime) {
          reason = `ENDED: now(${now.toFixed(2)}) >= end(${endTime.toFixed(2)})`;
        } else {
          const endSource = entry.endCtxTime !== undefined ? 'endCtxTime' : 'duration';
          reason = `ACTIVE: start(${entry.startCtxTime.toFixed(2)}) <= now(${now.toFixed(2)}) < end(${endTime.toFixed(2)}) [${endSource}]`;
        }
        
        if (shouldUpdateMatchInfo) {
          matchInfoArray.push({
            sentenceIndex: index,
            startCtxTime: entry.startCtxTime,
            endCtxTime: entry.endCtxTime,
            isStreaming: isActivelyStreaming,
            computedEndTime: endTime,
            nowTime: now,
            matches,
            reason
          });
        }
        
        if (matches && activeIndex === -1) {
          activeIndex = index;
          activeEntry = entry;
          // Don't break - continue to collect match info for all sentences
        }
      }
      
      // Update debug state with match info
      if (shouldUpdateMatchInfo && matchInfoArray.length > 0) {
        updateDebugTimingState({ sentenceMatchInfo: matchInfoArray });
      }
      
      // WORD-BASED TIMING: Find active word directly using AudioContext time
      const activeWord = this.findActiveWord();
      
      // Update debug state with active word (always update for debug panel)
      if (activeWord) {
        this.wordMatchCount++;
        
        // Log word match only when verbose logging enabled
        if (isVerboseLoggingEnabled() && (this.wordMatchCount <= 50 || frameCount % 60 === 0)) {
          console.error(`[WORD-MATCH] ✓ now=${now.toFixed(3)}s matched S${activeWord.sentenceIndex}W${activeWord.wordIndex}:"${activeWord.word}" (matchCount=${this.wordMatchCount})`);
        }
        
        // Always update debug state for panel visualization
        updateDebugTimingState({
          activeWord: {
            sentenceIndex: activeWord.sentenceIndex,
            wordIndex: activeWord.wordIndex,
            word: activeWord.word
          },
          lastWordMatchTime: now
        });
      } else if (shouldUpdateMatchInfo) {
        updateDebugTimingState({ activeWord: null });
      }
      
      // Derive sentence from active word for more reliable sentence tracking
      const wordBasedSentenceIndex = activeWord?.sentenceIndex ?? -1;
      
      // Use word-based sentence detection OR fall back to sentence-based
      // CRITICAL FIX: Word timings can extend past actual audio end time.
      // When sentence-based detection says ended (activeIndex = -1) but word-based
      // still returns a match, trust the sentence schedule as authoritative source
      // of audio end time. This prevents avatar lingering in "speaking" state.
      let effectiveSentenceIndex = wordBasedSentenceIndex >= 0 ? wordBasedSentenceIndex : activeIndex;
      
      if (effectiveSentenceIndex >= 0 && activeIndex < 0 && wordBasedSentenceIndex >= 0) {
        const wordEntry = this.sentenceSchedule.get(effectiveSentenceIndex);
        if (wordEntry) {
          const audioEndTime = wordEntry.endCtxTime ?? (wordEntry.startCtxTime + wordEntry.totalDuration);
          if (now >= audioEndTime + 0.15) {
            console.log(`[TIMING FIX] Word timing extended past audio end - overriding word-based detection. now=${now.toFixed(3)}, audioEnd=${audioEndTime.toFixed(3)}, wordSentence=${wordBasedSentenceIndex}`);
            effectiveSentenceIndex = -1;
          }
        }
      }
      
      const effectiveEntry = effectiveSentenceIndex >= 0 ? this.sentenceSchedule.get(effectiveSentenceIndex) : null;
      
      // DEBUG: Log effective sentence detection every 30 frames - only when verbose
      if (isVerboseLoggingEnabled() && frameCount % 30 === 0) {
        const wordScheduleSize = this.wordSchedule.size;
        console.error(`[TIMING FRAME ${frameCount}] wordBasedIdx=${wordBasedSentenceIndex}, sentenceBasedIdx=${activeIndex}, effective=${effectiveSentenceIndex}, scheduleSize=${this.sentenceSchedule.size}, wordScheduleSize=${wordScheduleSize}`);
      }
      
      if (effectiveEntry && effectiveSentenceIndex >= 0) {
        // Fire onSentenceStart if this is a NEW active sentence
        if (!effectiveEntry.started) {
          const previousSentence = this.activeSentenceInLoop;
          effectiveEntry.started = true;
          this.currentSentenceIndex = effectiveSentenceIndex;
          this.activeSentenceInLoop = effectiveSentenceIndex;
          this.progressivePlaybackStartCtxTime = effectiveEntry.startCtxTime;
          
          // Log sentence start only when verbose logging enabled
          if (isVerboseLoggingEnabled()) {
            console.error(`[SENTENCE] ▶▶▶ STARTING S${effectiveSentenceIndex} (now=${ctx.currentTime.toFixed(3)}, scheduled=${effectiveEntry.startCtxTime.toFixed(3)}, via=${wordBasedSentenceIndex >= 0 ? 'word' : 'sentence'})`);
          }
          
          // Log sentence transition for debug panel
          logSentenceTransition(previousSentence, effectiveSentenceIndex, `started at ${ctx.currentTime.toFixed(2)}s`);
          
          // Update debug panel with sentences started count
          const startedCount = Array.from(this.sentenceSchedule.values()).filter(e => e.started).length;
          updateDebugTimingState({ sentencesStarted: startedCount });
          
          this.notifySentenceStart(effectiveSentenceIndex);
        }
        
        // Calculate elapsed time within THIS sentence
        const elapsedInSentence = now - effectiveEntry.startCtxTime;
        
        // Fire progress callback (drives subtitle word highlighting)
        this.notifyProgress(elapsedInSentence, effectiveEntry.totalDuration);
      } else {
        // No active sentence - check for sentences that have ended but haven't fired onSentenceEnd
        const endCheckEntries = Array.from(this.sentenceSchedule.entries());
        let anyEndedThisTick = false;
        for (let k = 0; k < endCheckEntries.length; k++) {
          const [index, entry] = endCheckEntries[k];
          if (entry.endCtxTime === undefined) continue;
          
          // CRITICAL FIX: Add 150ms grace period to prevent premature "ended" detection
          // AudioContext.currentTime can slightly lead actual audio buffer playback due to buffering
          // This prevents avatar returning to listening while audio is still playing
          const AUDIO_END_GRACE_PERIOD = 0.15; // 150ms
          if (now >= entry.endCtxTime + AUDIO_END_GRACE_PERIOD && !entry.ended) {
            entry.ended = true;
            if (!entry.started) entry.started = true;
            anyEndedThisTick = true;
            
            // Update debug panel with sentences ended count
            const endedCount = Array.from(this.sentenceSchedule.values()).filter(e => e.ended).length;
            updateDebugTimingState({
              sentencesEnded: endedCount,
            });
            
            this.notifySentenceEnd(index);
          }
        }
        
        if (anyEndedThisTick) {
          if (this.checkAllSentencesEnded()) {
            this.isPlaying = false;
            this.setState('idle');
            this.stopPrecisionTiming();
            this.notifyComplete();
            return;
          }
        }
      }
      
      // FALLBACK: Periodically check if we should stop (every 30 frames)
      if (frameCount % 30 === 0) {
        // ROBUST END DETECTION: Directly mark sentences as ended and check completion
        // This mirrors the minimal loop's reliable approach — doesn't depend on
        // expectedSentenceCount or the "else" branch running first
        const FALLBACK_GRACE = 0.15;
        const fallbackEntries = Array.from(this.sentenceSchedule.entries());
        let fallbackAllEnded = true;
        let fallbackAnyStarted = false;
        for (const [fbIdx, fbEntry] of fallbackEntries) {
          if (!fbEntry.started && now >= fbEntry.startCtxTime) {
            fbEntry.started = true;
          }
          // Same endCtxTime-only guard as the minimal loop — do NOT use totalDuration fallback.
          // During a GL inter-sub-turn pause, endCtxTime is undefined and totalDuration only
          // covers the first sub-turn. Using totalDuration here would prematurely fire ended
          // and trigger setState('idle') while more audio is still coming from GL.
          if (fbEntry.endCtxTime !== undefined && !fbEntry.ended && now >= fbEntry.endCtxTime + FALLBACK_GRACE) {
            fbEntry.ended = true;
            if (!fbEntry.started) fbEntry.started = true;
            this.notifySentenceEnd(fbIdx);
          }
          if (fbEntry.started) fallbackAnyStarted = true;
          if (!fbEntry.ended) fallbackAllEnded = false;
        }
        if (fallbackAnyStarted && fallbackAllEnded && fallbackEntries.length > 0) {
          // GUARD: Same as minimal loop — only stop if response_complete received or
          // expectedSentenceCount is known. Without this guard the fallback fires setState('idle')
          // mid-response during GL inter-sub-turn pauses, cutting the response at the pause point.
          const fallbackResponseComplete = (window as any).__debugTimingState?.wsResponseCompleteReceived === true;
          const fallbackExpectedKnown = this.expectedSentenceCount !== null && this.sentenceSchedule.size >= this.expectedSentenceCount;
          if (!fallbackResponseComplete && !fallbackExpectedKnown) {
            // Not done yet — don't fire completion
          } else {
            this.isPlaying = false;
            this.setState('idle');
            this.stopPrecisionTiming();
            this.notifyComplete();
            return;
          }
        }
      }
      
      // Continue the loop
      this.rafId = requestAnimationFrame(tick);
    };
    
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Start precision timing loop specifically for progressive PCM streaming
   * Uses AudioContext.currentTime for accurate tracking
   * @deprecated Use startUnifiedTimingLoop instead
   */
  private startProgressivePrecisionTiming(): void {
    this.stopPrecisionTiming();
    
    let frameCount = 0;
    const tick = () => {
      if (!this.isPlaying || this.progressiveSentenceIndex === -1) {
        return;
      }
      
      const ctx = this.audioContext;
      if (!ctx) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      
      const elapsedCtxTime = ctx.currentTime - this.progressivePlaybackStartCtxTime;
      
      if (elapsedCtxTime < 0) {
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      
      const currentTime = elapsedCtxTime;
      this.notifyProgress(currentTime, this.progressiveTotalDuration);
      
      // Verbose debug log only when enabled
      frameCount++;
      if (isVerboseLoggingEnabled() && frameCount % 10 === 0) {
        console.log(`[TIMING LOOP] frame=${frameCount}, elapsed=${currentTime.toFixed(3)}s, total=${this.progressiveTotalDuration.toFixed(3)}s, ctx.state=${ctx?.state}`);
      }
      
      this.rafId = requestAnimationFrame(tick);
    };
    
    this.rafId = requestAnimationFrame(tick);
  }
  
  /**
   * Schedule sentence end callback after last chunk finishes
   */
  private scheduleProgressiveSentenceEnd(sentenceIndex: number, lastChunkDuration: number): void {
    const ctx = this.getAudioContext();
    const delayMs = (this.progressiveScheduledTime - ctx.currentTime) * 1000;
    
    setTimeout(() => {
      this.finalizeProgressiveSentence(sentenceIndex);
    }, Math.max(0, delayMs));
  }
  
  /**
   * Finalize a progressive sentence (called when last chunk ends)
   * NOTE: With the unified timing loop, onSentenceEnd is now fired there.
   * This method NO LONGER marks sentences as ended - only the timing loop does that
   * with proper grace period to prevent premature "all sentences ended" detection.
   * 
   * CRITICAL FIX (Jan 2026): Previously this method would mark entry.ended=true
   * immediately when the setTimeout fired, racing ahead of the timing loop's
   * grace period check. This caused the avatar to return to listening state
   * 4-5 seconds before audio actually finished playing.
   */
  private finalizeProgressiveSentence(sentenceIndex: number): void {
    // Just update the debug panel with current ended count
    // DON'T mark entry.ended=true here - let the timing loop handle it
    // with proper grace period to ensure audio has actually finished
    const endedCount = Array.from(this.sentenceSchedule.values()).filter(e => e.ended).length;
    updateDebugTimingState({
      sentencesEnded: endedCount,
    });
    
    // DON'T check allSentencesEnded here - the timing loop handles this
    // with proper grace period checks
  }
  
  /**
   * Check if all sentences in the schedule have ended
   * Returns true only when:
   * 1. We know the expected sentence count (from response_complete)
   * 2. We have received all expected sentences
   * 3. Every entry has ended=true AND has endCtxTime set
   * 
   * CRITICAL FIX: Without expectedSentenceCount, we can't know if more sentences
   * are coming. This prevents premature loop termination between sentences.
   */
  private checkAllSentencesEnded(): boolean {
    // Track call count in debug state
    const currentState = window.__debugTimingState;
    const callCount = (currentState?.checkAllCallCount || 0) + 1;
    
    // Helper to update debug panel with result
    const logResult = (result: boolean, reason: string) => {
      updateDebugTimingState({
        lastCheckAllResult: result,
        lastCheckAllReason: reason,
        lastCheckAllTime: Date.now(),
        checkAllCallCount: callCount,
        allSentencesEnded: result,
      });
    };
    
    if (this.sentenceSchedule.size === 0) {
      logResult(true, 'No sentences scheduled (size=0)');
      return true;
    }
    
    // CRITICAL: If we don't know how many sentences to expect, we can't be sure all have arrived
    // FALLBACK: Check if response_complete was received via debug state (playerRef might have been null)
    if (this.expectedSentenceCount === null) {
      const allEntries = Array.from(this.sentenceSchedule.entries());
      const allHaveEnded = allEntries.length > 0 && allEntries.every(([_, entry]) => entry.ended && entry.endCtxTime !== undefined);
      
      const debugState = window.__debugTimingState;
      if (debugState?.wsResponseCompleteReceived) {
        if (allHaveEnded) {
          logResult(true, `FALLBACK: response_complete received, all ${allEntries.length} sentences ended`);
          return true;
        }
        logResult(false, `FALLBACK: response_complete received but not all sentences ended yet (${allEntries.length} in schedule)`);
        return false;
      }
      
      // DO NOT return true here — expectedSentenceCount is null, meaning response_complete
      // hasn't arrived yet. More sentences may still be on the way from the server.
      // Returning true here caused the avatar to flicker to 'listening' between sentences
      // (sentence N ends before sentence N+1 is scheduled → premature idle → avatar snaps).
      // Fall through to return false and keep the loop alive until response_complete arrives.
      logResult(false, `expectedSentenceCount=null, wsResponseCompleteReceived=false — waiting (${allEntries.length} sentences ended but response may not be complete)`);
      return false;
    }
    
    // Check if we've received all expected sentences
    if (this.sentenceSchedule.size < this.expectedSentenceCount) {
      const allReceivedEntries = Array.from(this.sentenceSchedule.entries());
      const allReceivedEnded = allReceivedEntries.length > 0 && allReceivedEntries.every(([_, entry]) => entry.ended && entry.endCtxTime !== undefined);
      const debugState = window.__debugTimingState;
      if (allReceivedEnded && debugState?.wsResponseCompleteReceived) {
        // FIX: Force-mark every entry in the schedule as ended so nothing downstream
        // (timing loop, fallback checks, isPlaying guards) thinks a sentence is still
        // playing. Without this, entries that were "ended" only via the allReceivedEnded
        // check may still have endCtxTime undefined or other stale state from the
        // interrupted/dropped audio path that could re-block completion on the next tick.
        for (const entry of this.sentenceSchedule.values()) {
          if (!entry.ended) {
            entry.ended = true;
            if (entry.endCtxTime === undefined) {
              entry.endCtxTime = this.audioContext?.currentTime ?? 0;
            }
          }
        }
        // Also immediately clear the isPlaying flag so the timing loop exits cleanly
        this.isPlaying = false;
        diagMarkMismatchRecovery(this.expectedSentenceCount!, this.sentenceSchedule.size);
        logResult(true, `MISMATCH_RECOVERY: expected ${this.expectedSentenceCount} but only ${this.sentenceSchedule.size} arrived, all ended + response_complete received`);
        return true;
      }
      logResult(false, `size(${this.sentenceSchedule.size}) < expected(${this.expectedSentenceCount})`);
      return false;
    }
    
    const allEntries = Array.from(this.sentenceSchedule.entries());
    for (let i = 0; i < allEntries.length; i++) {
      const [index, entry] = allEntries[i];
      if (entry.endCtxTime === undefined) {
        logResult(false, `S${index}: endCtxTime=undefined`);
        return false;
      }
      if (!entry.ended) {
        logResult(false, `S${index}: ended=false`);
        return false;
      }
    }
    
    logResult(true, `✓ All ${this.expectedSentenceCount} sentences complete!`);
    return true;
  }
  
  /**
   * Stop playback and clear queue
   */
  stop(): void {
    
    // Stop precision timing
    this.stopPrecisionTiming();
    
    // Clear fallback timer and reset flag
    if (this.chunkFallbackTimer) {
      clearTimeout(this.chunkFallbackTimer);
      this.chunkFallbackTimer = null;
    }
    this.hasChunkEnded = false;
    
    // Stop current MP3 audio
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    
    // Stop current PCM audio
    if (this.currentPcmSource) {
      try {
        this.currentPcmSource.stop();
      } catch (e) {
        // Ignore - source may already be stopped
      }
      this.currentPcmSource = null;
    }
    
    // Stop progressive streaming
    this.resetProgressiveState();
    this.progressiveSentenceIndex = -1;
    
    // Clear queue and pending count
    this.queue = [];
    this.isPlaying = false;
    this.updatePendingCount(0);
    
    // Cleanup object URLs
    this.cleanupUrls();
    
    this.setState('idle');
  }
  
  /**
   * Pause playback
   */
  pause(): void {
    if (this.currentAudio && this.state === 'playing') {
      this.currentAudio.pause();
      this.setState('paused');
    }
  }
  
  /**
   * Resume playback
   */
  resume(): void {
    if (this.currentAudio && this.state === 'paused') {
      this.currentAudio.play().catch(console.error);
      this.setState('playing');
    }
  }
  
  /**
   * Start high-precision timing loop using requestAnimationFrame
   * This provides ~60fps updates instead of the coarse timeupdate (~4fps)
   * 
   * CRITICAL: Uses audio.currentTime directly when available, falling back to
   * performance.now() timing when audio element is temporarily unavailable.
   * This keeps subtitles synced with actual audio while handling edge cases.
   */
  private startPrecisionTiming(): void {
    // Cancel any existing timing loop
    this.stopPrecisionTiming();
    
    let frameCount = 0;
    const tick = () => {
      // Exit only if we've explicitly stopped playback
      if (!this.isPlaying) {
        return;
      }
      
      // Use audio.currentTime when available, fall back to performance.now() timing
      // This handles edge cases where currentAudio is temporarily null (resume/stop flows)
      let currentTime: number;
      if (this.currentAudio && !this.currentAudio.paused) {
        // Primary: Use actual audio playback position for perfect sync
        currentTime = this.currentAudio.currentTime;
      } else if (this.playbackStartTime !== null) {
        // Fallback: Calculate from performance.now() when audio temporarily unavailable
        const elapsedMs = performance.now() - this.playbackStartTime;
        currentTime = elapsedMs / 1000;
      } else {
        // No timing source available, continue loop but don't fire callback
        this.rafId = requestAnimationFrame(tick);
        return;
      }
      
      // Fire progress callback with timing
      this.notifyProgress(currentTime, this.currentDuration);
      
      frameCount++;
      
      // Continue the loop
      this.rafId = requestAnimationFrame(tick);
    };
    
    this.rafId = requestAnimationFrame(tick);
  }
  
  /**
   * Stop the precision timing loop
   * NOTE: Does NOT reset playbackStartTime - that's set in onplaying handler
   */
  private stopPrecisionTiming(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    // Don't reset playbackStartTime here - it's set in onplaying handler
    // and cleared in playNext() when preparing for next chunk
  }
  
  /**
   * Play the next chunk in the queue
   * Supports both MP3 (HTMLAudioElement) and raw PCM (Web Audio API)
   */
  private async playNext(): Promise<void> {
    // Stop any existing precision timing
    this.stopPrecisionTiming();
    
    // Clear any existing fallback timer and reset flag
    if (this.chunkFallbackTimer) {
      clearTimeout(this.chunkFallbackTimer);
      this.chunkFallbackTimer = null;
    }
    this.hasChunkEnded = false;
    
    // Stop any existing PCM source
    if (this.currentPcmSource) {
      try {
        this.currentPcmSource.stop();
      } catch (e) {
        // Ignore - source may already be stopped
      }
      this.currentPcmSource = null;
    }
    
    // Get next chunk from queue
    const chunk = this.queue.shift();
    
    if (!chunk) {
      this.isPlaying = false;
      this.setState('idle');
      this.notifyComplete();
      return;
    }
    
    this.isPlaying = true;
    this.currentSentenceIndex = chunk.sentenceIndex;
    this.currentDuration = chunk.durationMs / 1000; // Convert to seconds
    this.currentAudioFormat = chunk.audioFormat || 'mp3';
    
    // Set state to buffering BEFORE firing callbacks
    // This prevents race condition where isProcessing=false but playbackState still 'idle'
    this.setState('buffering');
    
    try {
      if (this.currentAudioFormat === 'pcm_f32le') {
        // Raw PCM playback via Web Audio API
        await this.playPcmChunk(chunk);
      } else {
        // MP3 playback via HTMLAudioElement
        await this.playMp3Chunk(chunk);
      }
      
    } catch (error: any) {
      console.error('[StreamingAudioPlayer] Error playing chunk:', error);
      this.stopPrecisionTiming();
      this.notifyError(error);
      
      // Decrement pending count on error
      this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
      
      // Try next chunk
      this.playNext();
    }
  }
  
  /**
   * Play MP3 audio chunk using HTMLAudioElement
   */
  private async playMp3Chunk(chunk: StreamingAudioChunk): Promise<void> {
    // Create blob URL for the audio
    const blob = new Blob([chunk.audio], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    
    // Create audio element
    this.currentAudio = new Audio(url);
    
    // Handle audio events
    this.currentAudio.onloadedmetadata = () => {
      // Use actual duration from audio if available
      if (this.currentAudio && this.currentAudio.duration > 0 && Number.isFinite(this.currentAudio.duration)) {
        this.currentDuration = this.currentAudio.duration;
      }
    };
    
    // Use 'playing' event - fires when audio ACTUALLY starts producing sound
    this.currentAudio.onplaying = () => {
      this.setState('playing');
      this.playbackStartTime = performance.now();
      
      // TELEMETRY: Track play start for production duplicate audio debugging
      try {
        const emitter = getTelemetryEmitter();
        if (emitter) {
          emitter.emit('audio_play_start', {
            format: 'mp3',
            queueRemaining: this.queue.length,
          }, chunk.sentenceIndex, chunk.chunkIndex);
        }
      } catch (e) { /* telemetry failure shouldn't break audio */ }
      
      // Fire onSentenceStart for precise sync with subtitle timing
      this.notifySentenceStart(this.currentSentenceIndex);
      
      // Start high-precision timing loop
      this.startPrecisionTiming();
    };
    
    this.currentAudio.onended = () => {
      // MOBILE FIX: Prevent double-firing if fallback timer already handled this
      if (this.hasChunkEnded) {
        console.log('[StreamingAudioPlayer] MP3 onended skipped - already handled by fallback');
        return;
      }
      this.hasChunkEnded = true;
      
      // Clear fallback timer since onended fired normally
      if (this.chunkFallbackTimer) {
        clearTimeout(this.chunkFallbackTimer);
        this.chunkFallbackTimer = null;
      }
      
      this.stopPrecisionTiming();
      
      // TELEMETRY: Track play end for production duplicate audio debugging
      try {
        const emitter = getTelemetryEmitter();
        if (emitter) {
          emitter.emit('audio_play_end', {
            format: 'mp3',
            durationMs: performance.now() - (this.playbackStartTime ?? 0),
          }, chunk.sentenceIndex, chunk.chunkIndex);
          
          // Emit queue_status on dequeue to track queue evolution
          emitter.emit('queue_status', {
            queueDepth: this.queue.length,
            pendingAudioCount: this.pendingAudioCount - 1, // After decrement
            event: 'DEQUEUE',
          });
        }
      } catch (e) { /* telemetry failure shouldn't break audio */ }
      
      this.notifySentenceEnd(chunk.sentenceIndex);
      
      // Decrement pending count after chunk finishes
      this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
      
      // Play next chunk
      this.playNext();
    };
    
    this.currentAudio.onerror = (event) => {
      // Keep unguarded - essential operational error
      console.error('[StreamingAudioPlayer] MP3 audio error:', event);
      this.stopPrecisionTiming();
      this.notifyError(new Error('MP3 playback failed'));
      
      // Decrement pending count on error
      this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
      
      // Try next chunk
      this.playNext();
    };
    
    // Start playback
    await this.currentAudio.play();
    
    // MOBILE FIX: Start fallback timer in case onended doesn't fire
    // Calculate fallback time: expected duration + 2 second buffer
    const expectedDurationMs = (chunk.durationMs || 5000) + 2000;
    this.chunkFallbackTimer = setTimeout(() => {
      if (!this.hasChunkEnded) {
        console.warn('[StreamingAudioPlayer] MP3 fallback timer triggered - onended did not fire!');
        this.hasChunkEnded = true;
        this.stopPrecisionTiming();
        this.notifySentenceEnd(chunk.sentenceIndex);
        this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
        this.playNext();
      }
    }, expectedDurationMs);
  }
  
  /**
   * Play raw PCM audio chunk using Web Audio API
   * PCM format: 32-bit float, little-endian (f32le), 24kHz mono
   */
  private async playPcmChunk(chunk: StreamingAudioChunk): Promise<void> {
    const ctx = this.getAudioContext();
    const sampleRate = chunk.sampleRate || 24000;
    
    // Resume AudioContext if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    
    // Convert raw PCM bytes to Float32Array
    // f32le = 32-bit float, little-endian = 4 bytes per sample
    // SAFETY: Ensure byte length is a multiple of 4 (required for Float32Array)
    let rawAudioBuffer = chunk.audio;
    if (chunk.audio.byteLength % 4 !== 0) {
      console.warn(`[AUDIO playPcmChunk] Byte length ${chunk.audio.byteLength} not multiple of 4, truncating`);
      const truncatedLength = Math.floor(chunk.audio.byteLength / 4) * 4;
      if (truncatedLength === 0) {
        console.warn(`[AUDIO playPcmChunk] Chunk too small to use, skipping`);
        return;
      }
      rawAudioBuffer = chunk.audio.slice(0, truncatedLength);
    }
    const float32Data = new Float32Array(rawAudioBuffer);
    const numSamples = float32Data.length;
    
    // Create AudioBuffer
    const audioBuffer = ctx.createBuffer(1, numSamples, sampleRate);
    audioBuffer.getChannelData(0).set(float32Data);
    
    // Update actual duration from buffer
    this.currentDuration = audioBuffer.duration;
    
    // Create buffer source node
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.getMasterGain());
    this.currentPcmSource = source;
    
    // Set state and timing BEFORE starting playback
    this.setState('playing');
    this.playbackStartTime = performance.now();
    
    // TELEMETRY: Track play start for production duplicate audio debugging
    try {
      const emitter = getTelemetryEmitter();
      if (emitter) {
        emitter.emit('audio_play_start', {
          format: 'pcm_f32le',
          queueRemaining: this.queue.length,
        }, chunk.sentenceIndex, chunk.chunkIndex);
      }
    } catch (e) { /* telemetry failure shouldn't break audio */ }
    
    // Fire onSentenceStart for precise sync with subtitle timing
    this.notifySentenceStart(this.currentSentenceIndex);
    
    // Start high-precision timing loop
    this.startPrecisionTiming();
    
    // Handle playback end
    source.onended = () => {
      // MOBILE FIX: Prevent double-firing if fallback timer already handled this
      if (this.hasChunkEnded) {
        console.log('[StreamingAudioPlayer] PCM onended skipped - already handled by fallback');
        return;
      }
      this.hasChunkEnded = true;
      
      // Clear fallback timer since onended fired normally
      if (this.chunkFallbackTimer) {
        clearTimeout(this.chunkFallbackTimer);
        this.chunkFallbackTimer = null;
      }
      
      this.stopPrecisionTiming();
      
      // TELEMETRY: Track play end for production duplicate audio debugging
      try {
        const emitter = getTelemetryEmitter();
        if (emitter) {
          emitter.emit('audio_play_end', {
            format: 'pcm_f32le',
            durationMs: performance.now() - (this.playbackStartTime ?? 0),
          }, chunk.sentenceIndex, chunk.chunkIndex);
          
          // Emit queue_status on dequeue to track queue evolution
          emitter.emit('queue_status', {
            queueDepth: this.queue.length,
            pendingAudioCount: this.pendingAudioCount - 1, // After decrement
            event: 'DEQUEUE',
          });
        }
      } catch (e) { /* telemetry failure shouldn't break audio */ }
      
      this.currentPcmSource = null;
      this.notifySentenceEnd(chunk.sentenceIndex);
      
      // Decrement pending count after chunk finishes
      this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
      
      // Play next chunk
      this.playNext();
    };
    
    // Start playback
    source.start(0);
    
    // MOBILE FIX: Start fallback timer in case onended doesn't fire
    // Calculate fallback time: expected duration + 2 second buffer
    const expectedDurationMs = (chunk.durationMs || (audioBuffer.duration * 1000)) + 2000;
    this.chunkFallbackTimer = setTimeout(() => {
      if (!this.hasChunkEnded) {
        console.warn('[StreamingAudioPlayer] PCM fallback timer triggered - onended did not fire!');
        this.hasChunkEnded = true;
        this.stopPrecisionTiming();
        this.currentPcmSource = null;
        this.notifySentenceEnd(chunk.sentenceIndex);
        this.updatePendingCount(Math.max(0, this.pendingAudioCount - 1));
        this.playNext();
      }
    }, expectedDurationMs);
  }
  
  /**
   * Update state and notify all subscribers
   */
  private setState(state: StreamingPlaybackState): void {
    if (this.state !== state) {
      const prevState = this.state;
      const subscriberCount = this.subscribers.size;
      console.log(`[AUDIO PLAYER] State change: ${prevState} -> ${state} (subscribers: ${subscriberCount})`);
      this.state = state;
      
      // CRITICAL: Update global store for React components to subscribe to
      // This is the most reliable path - components use useSyncExternalStore
      setGlobalPlaybackState(state);
      
      // Telemetry: emit playback state change
      const emitter = getTelemetryEmitter();
      if (emitter) {
        emitter.emit(
          'playback_state_change' as ClientTelemetryEventType,
          { fromState: prevState, toState: state, subscriberCount },
          this.currentSentenceIndex
        );
        
        // Emit specific events for key transitions
        if (state === 'playing' && prevState === 'idle') {
          emitter.emit('playback_started' as ClientTelemetryEventType, {}, this.currentSentenceIndex);
        } else if (state === 'idle' && (prevState === 'playing' || prevState === 'buffering')) {
          // Multi-sub-turn responses: sentence 1's first chunk calls setState('buffering') while
          // sentence 0 is still playing, so the final idle transition arrives from 'buffering'
          // rather than 'playing'. Without this guard, playback_ended is never emitted for
          // two-sub-turn GL responses and the mic gate stays closed for the full 60s safety timeout.
          emitter.emit('playback_ended' as ClientTelemetryEventType, {}, this.currentSentenceIndex);
        }
      }
      
      // Always dispatch DOM event as reliable fallback (even with 0 subscribers)
      // DOM event bridge ensures React components receive state changes during HMR
      // when callback closures become stale
      this.dispatchDomEvent(state, subscriberCount);
      
      // Also notify any remaining subscribers
      if (subscriberCount > 0) {
        this.notifyStateChange(state);
      } else {
        console.warn(`[AUDIO PLAYER] NO subscribers registered! DOM event bridge is only fallback.`);
      }
    }
  }
  
  /**
   * Cleanup object URLs to prevent memory leaks
   */
  private cleanupUrls(): void {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls = [];
  }
  
  /**
   * Cleanup on destroy
   */
  destroy(): void {
    this.stopPrecisionTiming();
    this.stop();
  }

  /**
   * Nuclear reset: tear down the AudioContext and all progressive sources entirely.
   * Called when failsafe_tier2_45s fires with AudioContext in "running" state but
   * audio callbacks have silently stalled (AudioWorklet stuck state, common on Windows
   * after a WebSocket reconnect mid-sentence).
   *
   * `stop()` alone only clears the state machine — it leaves the AudioContext and its
   * worklet intact. This method closes the AudioContext completely so the next audio
   * request triggers a fresh context + worklet from scratch.
   */
  resetAudioPipeline(): void {
    console.warn('[AudioPlayer] resetAudioPipeline: tearing down AudioContext + worklet due to stuck-state recovery');

    // 1. Stop all active progressive sources (best-effort)
    for (const source of this.progressiveSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (_) {}
    }
    this.progressiveSources = [];

    // 2. Stop the PCM single-buffer source if active
    if (this.currentPcmSource) {
      try { this.currentPcmSource.stop(); } catch (_) {}
      this.currentPcmSource = null;
    }

    // 3. Disconnect and close the AudioContext — this kills the AudioWorklet
    if (this.masterGainNode) {
      try { this.masterGainNode.disconnect(); } catch (_) {}
      this.masterGainNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;

    // 4. Now do the normal stop() to clean up state machine, queue, and object URLs
    // (don't double-stop progressive sources — already handled above)
    this.stopPrecisionTiming();
    if (this.chunkFallbackTimer) {
      clearTimeout(this.chunkFallbackTimer);
      this.chunkFallbackTimer = null;
    }
    this.hasChunkEnded = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = '';
      this.currentAudio = null;
    }
    this.progressiveSentenceIndex = -1;
    this.progressiveChunks = [];
    this.progressiveTotalDuration = 0;
    this.progressiveFirstChunkStarted = false;
    this.progressivePlaybackStartCtxTime = 0;
    this.progressiveScheduledTime = 0;
    this.queue = [];
    this.isPlaying = false;
    this.updatePendingCount(0);
    this.cleanupUrls();
    this.setState('idle');

    console.log('[AudioPlayer] resetAudioPipeline: complete — fresh AudioContext will be created on next audio chunk');
  }
}
