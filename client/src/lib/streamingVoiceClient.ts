/**
 * Streaming Voice Client
 * 
 * Manages WebSocket connection for streaming voice mode.
 * Handles: audio recording → server → AI → TTS → progressive playback
 * 
 * Target: < 1 second time to first audio byte
 */

// GLOBAL DEBUG: Track message counts (check via window._wsDebug in browser console)
declare global {
  interface Window {
    _wsDebug: {
      messageCount: number;
      byType: Record<string, number>;
      lastMessage: any;
      lastError: string | null;
      wsState: number | null;
    };
    __streamingVoiceClient: StreamingVoiceClient | null;
    __svcInstanceId: number;
  }
}

// Initialize debug tracking (access via window._wsDebug in browser console)
if (typeof window !== 'undefined') {
  window._wsDebug = {
    messageCount: 0,
    byType: {},
    lastMessage: null,
    lastError: null,
    wsState: null
  };
}

import { io, Socket } from 'socket.io-client';
import {
  StreamingMessage,
  StreamingConnectedMessage,
  StreamingProcessingMessage,
  StreamingSentenceStartMessage,
  StreamingSentenceReadyMessage,
  StreamingAudioChunkMessage,
  StreamingWordTimingMessage,
  StreamingWordTimingDeltaMessage,
  StreamingWordTimingFinalMessage,
  StreamingSentenceEndMessage,
  StreamingResponseCompleteMessage,
  StreamingWhiteboardMessage,
  StreamingErrorMessage,
  ClientStartSessionMessage,
  WordTiming,
  AUDIO_STREAMING_CONFIG,
  ClientTelemetryEvent,
  ClientTelemetryEventType,
} from '../../../shared/streaming-voice-types';
import { isVerboseLoggingEnabled } from './audioUtils';
import { getGlobalPlaybackState } from './playbackStateStore';
import { canSendVideoFrame } from './vision-session-state';

// ============================================================================
// CLIENT TELEMETRY EMITTER (End-to-End Voice Diagnostics)
// ============================================================================

/**
 * Client-side telemetry emitter for voice diagnostics
 * Sends events to server via Socket.io for end-to-end correlation
 */
class ClientTelemetryEmitter {
  private socket: Socket | null = null;
  private sessionId: string = '';
  private enabled: boolean = true;
  private eventBuffer: ClientTelemetryEvent[] = [];
  private bufferSize: number = 50;
  
  setSocket(socket: Socket | null): void {
    this.socket = socket;
    // Flush any buffered events when socket becomes available
    if (socket && socket.connected && this.eventBuffer.length > 0) {
      this.flush();
    }
  }
  
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }
  
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  
  emit(
    type: ClientTelemetryEventType,
    data?: ClientTelemetryEvent['data'],
    sentenceIndex?: number,
    chunkIndex?: number
  ): void {
    if (!this.enabled) return;
    
    const event: ClientTelemetryEvent = {
      type,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      sentenceIndex,
      chunkIndex,
      data,
    };
    
    // Log locally for debugging
    console.log(`[TELEMETRY] ${type}`, data);
    
    // Send to server if socket is available and connected
    if (this.socket?.connected) {
      this.socket.emit('client_telemetry', event);
    } else {
      // Buffer for later sending
      this.eventBuffer.push(event);
      if (this.eventBuffer.length > this.bufferSize) {
        this.eventBuffer.shift(); // Remove oldest
      }
    }
  }
  
  private flush(): void {
    if (!this.socket?.connected || this.eventBuffer.length === 0) return;
    
    // Send buffered events in batch
    this.socket.emit('client_telemetry_batch', this.eventBuffer);
    this.eventBuffer = [];
  }
}

// Global singleton telemetry emitter
const telemetryEmitter = new ClientTelemetryEmitter();

/**
 * Get the global telemetry emitter for use in other modules (e.g., audioUtils.ts)
 */
export function getClientTelemetryEmitter(): ClientTelemetryEmitter {
  return telemetryEmitter;
}

/**
 * Connection states
 */
export type StreamingConnectionState = 
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'ready'       // Session established, ready to send audio
  | 'processing'
  | 'streaming'
  | 'reconnecting' // Auto-reconnecting after unexpected disconnect
  | 'error';

/**
 * Callbacks for streaming events
 */
export interface StreamingVoiceCallbacks {
  onConnectionStateChange: (state: StreamingConnectionState) => void;
  onSessionStart: (sessionId: string, voiceSessionId: string | null) => void;
  onProcessing: (transcript: string) => void;
  onSentenceStart: (index: number, text: string, targetLanguageText?: string) => void;
  onAudioReady: (sentenceIndex: number, audio: ArrayBuffer, duration: number) => void;
  onWordTimings: (sentenceIndex: number, timings: WordTiming[]) => void;
  onSentenceEnd: (index: number, duration: number) => void;
  onResponseComplete: (fullText: string, sentenceCount: number) => void;
  onError: (code: string, message: string, recoverable: boolean) => void;
}

/**
 * Session configuration
 */
export interface StreamingSessionConfig {
  conversationId: string;  // UUID string
  targetLanguage: string;
  nativeLanguage: string;
  difficultyLevel: string;
  subtitleMode: 'off' | 'target';
  tutorPersonality?: string;
  tutorExpressiveness?: number;
  tutorGender?: 'male' | 'female';
  voiceSpeed?: 'normal' | 'slow';
  rawHonestyMode?: boolean;  // Minimal prompting for authentic conversation with Daniela
  founderMode?: boolean;  // Explicit founder mode - only true when user selects "Founder Mode" context
  isReconnect?: boolean;  // True when reconnecting after a drop — prevents duplicate audio/greetings
  inputMode?: string;  // Voice input mode (ptt, open-mic, etc.)
}

/**
 * Event listener type
 */
type EventListener<T = any> = (data: T) => void;

/**
 * Event types for the streaming client
 */
type StreamingEventType = 
  | 'stateChange'
  | 'sessionStart'
  | 'processing'
  | 'processing_pending'  // Immediate thinking signal on PTT release
  | 'functionExecuting'  // Server-side tool call in progress — re-arms thinking avatar
  | 'sentenceStart'
  | 'sentenceReady'      // NEW: Atomic first audio + first timing (prevents timing race)
  | 'audioChunk'
  | 'wordTiming'
  | 'wordTimingDelta'    // Progressive streaming: incremental word timing
  | 'wordTimingFinal'    // Progressive streaming: final reconciliation
  | 'sentenceEnd'
  | 'vadSpeechStarted'   // Open mic: VAD detected speech start
  | 'vadUtteranceEnd'    // Open mic: VAD detected utterance end
  | 'interimTranscript'  // Open mic: Real-time interim transcript
  | 'openMicSessionClosed' // Open mic: Server session closed (e.g., Deepgram timeout)
  | 'openMicSilenceLoop'  // Open mic: Consecutive empty transcripts detected
  | 'reconnected'         // Successfully reconnected after a drop
  | 'glAudioReset'        // GL mid-turn reconnect — client must stop() + resetForNewTurn()
  | 'proactive_reconnect' // Intentional 4.5-min WS cycle before Replit proxy 5-min kill
  | 'inputModeChanged'   // Input mode switched
  | 'responseComplete'
  | 'feedback'
  | 'pronunciationCoaching' // Live pronunciation coaching feedback
  | 'voiceUpdated'
  | 'whiteboardUpdate'   // Visual teaching aids from tutor
  | 'tutorHandoff'       // Voice-initiated tutor switch
  | 'subtitleModeChange' // Server command to change subtitle mode
  | 'customOverlay'      // Server command to show/hide custom overlay
  | 'textInputRequest'   // Server command to request text input
  | 'scenarioLoaded'     // Immersive scenario loaded from library
  | 'scenarioEnded'      // Active scenario ended
  | 'propUpdate'         // Scenario prop updated
  | 'immersiveMode'      // Enter/exit immersive fullscreen mode
  | 'zoneAdvanced'       // Scenario zone advanced to next zone
  | 'zoneImageReady'     // Lazy-generated zone image is now available
  | 'incognitoChanged'   // Server confirmed incognito toggle
  | 'expectedSentenceCount'
  | 'ttsError'
  | 'sttDegraded'
  | 'noSpeechDetected'
  | 'transcript'
  | 'danielaTranscript'
  | 'characterChange'
  | 'idleTimeout'
  | 'creditWarning'
  | 'sessionConflict'
  | 'server_restarting'  // Server SIGTERM — deploy rotation, drain window in progress
  | 'greetingRetry'      // Server auto-retrying silent greeting — client resets 15s watchdog
  | 'glReconnecting'
  | 'glReconnected'
  | 'voiceError'
  | 'lessonNoteAdded'
  | 'pronunciationScoreShown'
  | 'grammarFlagShown'
  | 'quizPresented'
  | 'culturalContextShown'
  | 'spotlightShown'
  | 'missionSet'
  | 'sofiaIncidentCreated'     // Daniela called escalate_to_support — incident logged
  | 'sofiaSupportMessage'      // Sofia worker sent guidance to student
  | 'sofiaAllClear'            // Sofia resolved the incident
  | 'error';

/**
 * Streaming Voice Client
 * Manages WebSocket connection for ultra-low-latency voice chat
 */
export class StreamingVoiceClient {
  private socket: Socket | null = null;
  private sessionId: string | null = null;
  private voiceSessionId: string | null = null;
  private callbacks: Partial<StreamingVoiceCallbacks> = {};
  private state: StreamingConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 12; // Covers server restarts (fast: 3 tries ~3s, slow: 9 tries ~3 min)
  private pendingBinaryData: ArrayBuffer | null = null;
  private currentSentenceIndex = -1;
  private eventListeners: Map<StreamingEventType, Set<EventListener>> = new Map();
  
  // Connection ID to prevent race conditions when reconnecting
  // Events from old sockets are ignored if connectionId doesn't match
  private connectionId = 0;
  
  // Auto-reconnect state
  private lastConversationId: string | null = null;
  private lastSessionConfig: StreamingSessionConfig | null = null;  // Store for reconnect
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttemptInFlight = false;  // A failed attempt is not terminal: the retry loop owns the state
  private intentionalDisconnect = false;  // Track if disconnect was user-initiated
  private consecutiveSessionErrors = 0;
  private readonly MAX_SESSION_ERRORS = 5;
  private _isReconnectedSession = false;  // True after reconnect — prevents greeting re-trigger
  // A startup greeting belongs to one server session.  Keep this separate from
  // retry bookkeeping so a ready event (or an eager UI caller) cannot double-send it.
  private startupGreetingRequested = false;
  private _lastKnownInputMode: 'push-to-talk' | 'open-mic' = 'push-to-talk';  // Restored on reconnect
  private _pendingChunks: Array<{audioData: ArrayBuffer, sequenceId: number}> = [];  // Buffer for reconnect gap
  private readonly _PENDING_CHUNK_MAX = 100;  // ~1s of audio at 10ms chunks; prevents unbounded growth
  
  // Heartbeat state for fast drop detection
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private readonly HEARTBEAT_INTERVAL_MS = 1000;  // Send ping every 1s
  private readonly MAX_MISSED_HEARTBEATS = 3;     // 3 missed = ~3s detection

  // Proactive reconnect — Replit's proxy enforces a hard 5-minute WebSocket lifetime.
  // Measured precisely: drops happen at 301–302s after connect regardless of activity.
  // We reconnect at 270s (4.5 min) so the handoff happens cleanly between turns
  // rather than being force-killed mid-sentence by the proxy.
  private proactiveReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly PROACTIVE_RECONNECT_MS = 270000;  // 4.5 minutes (30s before proxy's 5-min kill)

  // Warm-up state
  private isWarmedUp = false;  // Socket connected but no session started
  
  constructor() {
    // Timers keep retrying during an outage; this only cuts the wait once the network is back.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.retryNowIfWaiting());
    }
  }
  
  /**
   * Add event listener
   */
  on<T = any>(event: StreamingEventType, listener: EventListener<T>): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }
  
  /**
   * Remove event listener
   */
  off<T = any>(event: StreamingEventType, listener: EventListener<T>): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }
  
  /**
   * Emit event to all listeners
   */
  private emit<T = any>(event: StreamingEventType, data: T): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(data);
        } catch (e) {
          if (isVerboseLoggingEnabled()) {
            console.error(`[StreamingVoiceClient] Error in ${event} listener:`, e);
          }
        }
      });
    }
  }
  
  /**
   * Set event callbacks
   */
  setCallbacks(callbacks: Partial<StreamingVoiceCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }
  
  /**
   * Get current connection state
   */
  getState(): StreamingConnectionState {
    return this.state;
  }
  
  /**
   * Get client-side telemetry snapshot for debugging
   * Used by Sofia issue reports to capture state at moment of issue report
   */
  getClientDiagnostics(): Record<string, any> {
    return {
      connectionState: this.state,
      socketConnected: this.socket?.connected ?? false,
      socketId: this.socket?.id ?? null,
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      hasActiveSession: !!this.sessionId,
      hasStoredSessionConfig: !!this.lastSessionConfig,  // For reconnect diagnostics
      reconnectCount: this.reconnectAttempts,
      intentionalDisconnect: this.intentionalDisconnect,
      lastConversationId: this.lastConversationId,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    };
  }
  
  get isReconnectedSession(): boolean {
    return this._isReconnectedSession;
  }

  /**
   * Check if connected and ready
   */
  isReady(): boolean {
    // State can be 'connected' (socket open) or 'ready' (session started) or 'processing' (handling audio)
    const validStates: StreamingConnectionState[] = ['connected', 'ready', 'processing'];
    return validStates.includes(this.state) && (this.socket?.connected ?? false);
  }
  
  /**
   * Check if socket is already warmed up (connected but no session)
   */
  isSocketWarmedUp(): boolean {
    return this.isWarmedUp && (this.socket?.connected ?? false);
  }
  
  /**
   * Pre-connect Socket.io without starting a session.
   * Called when student navigates to a conversation page so the socket
   * is ready by the time they tap "Start voice". If socket is already
   * connected for this conversationId, this is a no-op.
   */
  async warmUp(conversationId: string): Promise<void> {
    if (this.socket?.connected && this.lastConversationId === conversationId) {
      return;
    }
    
    if (this.socket?.connected && this.lastConversationId !== conversationId) {
      this.socket.disconnect();
      this.socket = null;
      this.stopHeartbeat();
    }
    
    this.lastConversationId = conversationId;
    this.intentionalDisconnect = false;
    this.isWarmedUp = false;
    
    try {
      await this.connectSocket(conversationId);
      this.isWarmedUp = true;
      console.log('[StreamingVoice] Warm-up complete — socket ready for', conversationId.substring(0, 8));
    } catch (err: any) {
      console.warn('[StreamingVoice] Warm-up failed (non-blocking):', err.message);
    }
  }
  
  /**
   * Connect to streaming voice via Socket.io
   * Socket.io handles transport negotiation (WebSocket → polling fallback)
   * This works reliably through Replit's proxy
   */
  async connect(conversationId: string): Promise<void> {
    if (this.socket?.connected && this.lastConversationId === conversationId) {
      return;
    }
    
    this.lastConversationId = conversationId;
    this.intentionalDisconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (!this.socket?.connected) {
      await this.connectSocket(conversationId);
    }
    
    this.isWarmedUp = false;
  }
  
  /**
   * Internal: establish Socket.io connection (shared by warmUp and connect)
   */
  private async connectSocket(conversationId: string): Promise<void> {
    this.connectionId++;
    const currentConnectionId = this.connectionId;
    
    this.setState('connecting');
    
    try {
      console.log('[StreamingVoice] Creating Socket.io connection to /voice namespace...');
      
      this.socket = io('/voice', {
        query: { conversationId },
        transports: ['websocket'],
        upgrade: false,
        reconnection: false,
      });
      
      telemetryEmitter.setSocket(this.socket);
      
      const connectionPromise = new Promise<void>((resolve, reject) => {
        const socket = this.socket!;
        let resolved = false;
        let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
        
        const completeConnection = (source: string) => {
          if (resolved) return;
          resolved = true;
          console.log('[StreamingVoice] Connection complete via:', source);
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
          }
          if (this.connectionId !== currentConnectionId) {
            console.log('[StreamingVoice] Connection ID mismatch, ignoring');
            return;
          }
          this.reconnectAttempts = 0;
          this.intentionalDisconnect = false;
          this.setState('connected');
          this.startHeartbeat();
          this.startProactiveReconnect();
          resolve();
        };
        
        socket.on('connect', () => {
          console.log('[StreamingVoice] Socket.io connect event fired!');
          completeConnection('connect');
        });
        
        socket.onAny((eventName: string, ...args: any[]) => {
          if (eventName === 'message') {
            const data = args[0];
            const msgType = data?.type || 'unknown';
            if (msgType === 'processing' || msgType === 'processing_pending') {
              console.log('[SOCKET.IO CONTROL MSG] ★★★ Received:', msgType, JSON.stringify(data));
            } else if (msgType === 'audio_chunk_part' || msgType === 'word_timing_delta') {
              // Reduce noise
            } else {
              console.log('[SOCKET.IO onAny] EVENT:', eventName, 'TYPE:', msgType, 'HAS AUDIO:', !!data?.audio);
            }
          } else if (eventName !== 'heartbeat_ack') {
            console.log('[SOCKET.IO onAny] EVENT:', eventName);
          }
        });
        
        socket.on('connect_error', (err) => {
          console.log('[StreamingVoice] Socket.io connect_error:', err.message);
          if (!resolved) {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
            reject(new Error('Socket.io connection failed: ' + err.message));
          }
        });
        
        socket.on('message', (data: any) => {
          this.missedHeartbeats = 0;
          console.log('[WS SOCKET ON MESSAGE] Received:', data?.type || 'unknown', 'data:', JSON.stringify(data).slice(0, 100));
          
          if (!resolved) {
            console.log('[StreamingVoice] First message received (connection confirmed)');
            completeConnection('first-message');
          }
          if (this.connectionId === currentConnectionId) {
            this.handleSocketMessage(data);
          }
        });
        
        socket.on('heartbeat_ack', () => {
          this.missedHeartbeats = 0;
        });

        // GRACEFUL SHUTDOWN: Server sends this on SIGTERM (deploy rotation).
        // The server now holds a 25s drain window before exiting, so we have time
        // to let buffered audio finish playing before starting the reconnect.
        socket.on('server_restarting', () => {
          console.log('[StreamingVoice] Server shutdown imminent — letting audio drain, then reconnecting');
          this.stopHeartbeat();
          // Notify the UI immediately so a toast can be shown
          this.emit('server_restarting', { drainSeconds: 25 });
          // Wait 5s to let any buffered TTS audio finish playing, then disconnect.
          // The server's 25s drain window gives us ample time.
          setTimeout(() => {
            console.log('[StreamingVoice] Drain delay elapsed — disconnecting to reconnect to new server');
            socket.disconnect();
          }, 5000);
        });

        socket.on('binary', (data: ArrayBuffer) => {
          this.missedHeartbeats = 0;
          if (this.connectionId === currentConnectionId) {
            this.handleBinaryData(data);
          }
        });
        
        socket.on('disconnect', (reason) => {
          console.log('[StreamingVoice] Socket.io disconnect:', reason);
          this.stopHeartbeat();
          if (!resolved) {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
            reject(new Error('Socket.io disconnected before connection complete'));
          }
          if (this.connectionId === currentConnectionId) {
            this.handleDisconnect();
          }
        });
        
        if (socket.connected) {
          console.log('[StreamingVoice] Socket.io already connected!');
          completeConnection('already-connected');
          return;
        }
        
        connectionTimeout = setTimeout(() => {
          if (resolved) return;
          console.log('[StreamingVoice] Socket.io connection timeout');
          reject(new Error('Socket.io connection timeout'));
        }, 30000);
      });
      
      await connectionPromise;
      
    } catch (error: any) {
      if (isVerboseLoggingEnabled()) {
        console.error('[StreamingVoiceClient] Connection failed:', error);
      }
      // A socket that never connected must not linger: it could still connect later,
      // after this attempt was given up on.
      if (this.socket && this.connectionId === currentConnectionId) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      if (!this.reconnectAttemptInFlight) {
        this.setState('error');
      }
      throw error;
    }
  }
  
  /**
   * Start application-level heartbeat for fast drop detection.
   * Sends ping every 1s; if 3 consecutive pings go unacknowledged (~3s),
   * triggers disconnect → auto-reconnect flow.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;
    
    this.heartbeatInterval = setInterval(() => {
      if (!this.socket?.connected) {
        this.stopHeartbeat();
        return;
      }
      
      this.missedHeartbeats++;
      
      if (this.missedHeartbeats > this.MAX_MISSED_HEARTBEATS) {
        console.warn(`[StreamingVoice] Heartbeat: ${this.missedHeartbeats} missed — connection stale, forcing reconnect`);
        this.stopHeartbeat();
        this.socket?.disconnect();
        return;
      }
      
      this.socket.emit('heartbeat', { ts: Date.now() });
    }, this.HEARTBEAT_INTERVAL_MS);
  }
  
  /**
   * Stop the heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.missedHeartbeats = 0;
    // Always cancel proactive reconnect alongside heartbeat — same lifecycle
    this.stopProactiveReconnect();
  }

  /**
   * Schedule a proactive reconnect targeting 4.5 minutes after connection established.
   * Replit's proxy kills WebSocket connections at exactly 5 minutes regardless of
   * activity. We aim to reconnect between turns (when state is 'ready'), polling
   * every 500ms if a turn is in-flight. An absolute deadline at 4min 55s ensures
   * we still beat the proxy's hard kill even if a very long turn is active.
   */
  private startProactiveReconnect(): void {
    this.stopProactiveReconnect();
    // Absolute deadline: we MUST reconnect by 4min 55s to beat Replit proxy's 5-min hard kill.
    // We target 4.5min (270s) but defer if a turn is in-flight, retrying every 500ms.
    const ABSOLUTE_DEADLINE_MS = 295000; // 4min 55s
    const scheduledAt = Date.now();

    const attemptReconnect = () => {
      this.proactiveReconnectTimer = null;
      if (!this.socket?.connected || this.intentionalDisconnect) return;
      if (!this.lastSessionConfig) return;

      const elapsed = Date.now() - scheduledAt;
      const isPastDeadline = elapsed >= ABSOLUTE_DEADLINE_MS;

      // Defer if mid-turn (state === 'processing') OR audio is actively playing/buffering,
      // UNLESS we've hit the absolute deadline. Connection state flips back to 'ready' as
      // soon as response_complete arrives (all sentence audio has been SENT), but playback
      // in the browser can still be ongoing for several more seconds — disconnecting then
      // kills the socket mid-sentence for the listener even though the connection layer
      // thinks the turn is over. This is the primary suspected cause of the chronic
      // "cut off mid-sentence" / code-1000 drop pattern.
      const audioActive = getGlobalPlaybackState() === 'playing' || getGlobalPlaybackState() === 'buffering';
      if ((this.state === 'processing' || audioActive) && !isPastDeadline) {
        console.log(
          `[StreamingVoice] Proactive reconnect deferred — turn in-flight or audio playing (state=${this.state}, audio=${getGlobalPlaybackState()}), will retry in 500ms`
        );
        this.proactiveReconnectTimer = setTimeout(attemptReconnect, 500);
        return;
      }

      console.log(
        '[StreamingVoice] Proactive reconnect — cycling WS before proxy 5-min hard kill. State:',
        this.state,
        `(elapsed=${Math.round(elapsed / 1000)}s, pastDeadline=${isPastDeadline})`
      );
      this.emit('proactive_reconnect', { timestamp: Date.now(), state: this.state });
      this.socket.disconnect();
    };

    this.proactiveReconnectTimer = setTimeout(attemptReconnect, this.PROACTIVE_RECONNECT_MS);
  }

  /**
   * Cancel any pending proactive reconnect timer
   */
  private stopProactiveReconnect(): void {
    if (this.proactiveReconnectTimer) {
      clearTimeout(this.proactiveReconnectTimer);
      this.proactiveReconnectTimer = null;
    }
  }
  
  /**
   * Start a streaming session
   */
  startSession(config: StreamingSessionConfig): void {
    if (!this.isReady()) {
      throw new Error('Socket.io not connected');
    }
    
    // Store config for potential reconnection (exclude isReconnect flag from stored config)
    const { isReconnect, ...storedConfig } = config;
    this.lastSessionConfig = storedConfig;
    
    // Clear reconnect flag and pending chunk buffer on fresh sessions
    if (!isReconnect) {
      this.voiceSessionId = null;
      this._isReconnectedSession = false;
      this.startupGreetingRequested = false;
      this._pendingChunks = [];  // Discard any stale buffered chunks from a previous session
    }
    
    const message = {
      type: 'start_session',
      ...config,
    } as ClientStartSessionMessage;
    
    this.socket!.emit('message', message);
  }
  
  /**
   * Send recorded audio for processing
   */
  sendAudio(audioData: ArrayBuffer, format: 'webm' | 'wav' | 'mp3' = 'webm'): void {
    if (!this.isReady()) {
      throw new Error('Socket.io not connected');
    }
    this.setState('processing');
    
    // Send binary audio data via 'binary' event
    this.socket!.emit('binary', audioData);
  }
  
  /**
   * Send streaming audio chunk for open mic mode
   * Returns true if chunk was sent, false if socket not ready
   * @param audioData - Audio chunk to stream
   * @param sequenceId - Sequence number for ordering
   */
  sendStreamingChunk(audioData: ArrayBuffer, sequenceId: number): boolean {
    if (!this.isReady()) {
      // Buffer chunks during reconnect gap so they can be replayed after reconnect.
      // Cap at _PENDING_CHUNK_MAX to prevent unbounded memory growth during long outages.
      if (this._pendingChunks.length < this._PENDING_CHUNK_MAX) {
        this._pendingChunks.push({ audioData: audioData.slice(0), sequenceId });
      }
      return false;
    }
    
    try {
      // Convert to base64 for JSON transport
      const base64Audio = this.arrayBufferToBase64(audioData);
      this.socket!.emit('message', {
        type: 'stream_audio_chunk',
        audio: base64Audio,
        format: 'pcm16',  // Linear16 PCM at 16kHz from AudioContext
        sequenceId,
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Flush buffered chunks that accumulated during a reconnect gap.
   * Called immediately after restoring open-mic mode on reconnect.
   */
  private _flushPendingChunks(): void {
    if (this._pendingChunks.length === 0) return;
    const chunks = this._pendingChunks.splice(0);
    console.log(`[StreamingVoice] Flushing ${chunks.length} buffered chunk(s) from reconnect gap`);
    for (const chunk of chunks) {
      if (this.isReady()) {
        this.sendStreamingChunk(chunk.audioData, chunk.sequenceId);
      }
    }
  }
  
  /**
   * Stop streaming audio (open mic mode)
   */
  stopStreaming(): void {
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'stop_streaming' });
    }
  }

  /**
   * Student-initiated one-tap retry after all GL auto-reconnect attempts are exhausted.
   * Sends gl_retry_start to the server which resets the attempt counter and re-establishes
   * the GL session with a fresh Context Bridge so Daniela resumes naturally.
   * Clears intentionalDisconnect so the session can recover fully.
   */
  retryGlSession(): void {
    if (!this.socket?.connected) {
      console.warn('[StreamingVoice] retryGlSession: socket not connected — cannot retry');
      return;
    }
    console.log('[StreamingVoice] retryGlSession — sending gl_retry_start to server');
    // Allow future reconnect attempts again (this flag was set when the error arrived).
    this.intentionalDisconnect = false;
    this.setState('reconnecting');
    this.socket.emit('message', { type: 'gl_retry_start' });
  }
  
  /**
   * Set input mode (push-to-talk or open-mic)
   */
  setInputMode(mode: 'push-to-talk' | 'open-mic'): void {
    this._lastKnownInputMode = mode;  // Track for reconnect restoration
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'set_input_mode', inputMode: mode });
    }
  }
  
  /**
   * Send interrupt signal (user started speaking - stop TTS)
   */
  sendInterrupt(): void {
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'interrupt' });
    }
  }
  
  /**
   * Send user activity signal to prevent idle timeout
   * Called when user is actively engaged (e.g., recording audio)
   * This prevents the session from timing out while the user is holding
   * the push-to-talk button but hasn't released it yet
   */
  sendUserActivity(): void {
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'user_activity' });
    }
  }
  
  /**
   * Send PTT release signal to finalize speculative transcript
   * Called when user releases the push-to-talk button
   * Server will close the speculative Deepgram session and return final transcript
   */
  sendPttRelease(): void {
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'ptt_release' });
    }
  }

  sendToggleIncognito(enabled: boolean): void {
    if (this.socket?.connected) {
      this.socket.emit('message', { type: 'toggle_incognito', enabled });
    }
  }
  
  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  private greetingTimer: ReturnType<typeof setTimeout> | null = null;
  private greetingRetried = false;
  private lastGreetingParams: { userName?: string; isResumed?: boolean; scenarioSlug?: string } | null = null;
  private isGeminiLiveSession = false;

  /**
   * Request AI-generated personalized greeting
   * Called when starting a new conversation or resuming a previous one
   * @param userName - Optional student name for personalization
   * @param isResumed - True if resuming a previous conversation (triggers context-aware welcome back)
   */
  requestGreeting(userName?: string, isResumed?: boolean, scenarioSlug?: string): void {
    if (!this.isReady()) {
      throw new Error('Socket.io not ready for greeting');
    }
    
    // A resumed request is the sanctioned GL reconnect orientation turn. Only
    // collapse duplicate *fresh* startup requests; never turn that reconnect
    // path into a permanently blocked retry.
    if (this.startupGreetingRequested && !isResumed) {
      console.log('[StreamingVoice] Duplicate startup greeting request ignored');
      return;
    }
    if (!isResumed) this.startupGreetingRequested = true;
    this.lastGreetingParams = { userName, isResumed, scenarioSlug };
    this.socket!.emit('message', { 
      type: 'request_greeting',
      userName,
      isResumed,
      scenarioSlug,
    });

    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingRetried = false;
    // GL sessions: the server-side one-shot guard (geminiLiveGreetingSent) already blocks duplicate
    // request_greeting, and the server's own silent-greeting auto-retry (max 2) is the sanctioned
    // recovery path.  Firing a client retry only adds blocked duplicate requests and log noise.
    if (!this.isGeminiLiveSession) {
      this.greetingTimer = setTimeout(() => {
        if (this.greetingRetried) return;
        this.greetingRetried = true;
        console.warn('[StreamingVoice] Greeting delivery timeout (8s) — re-requesting greeting');
        if (this.isReady()) {
          this.socket!.emit('message', {
            type: 'request_greeting',
            userName,
            isResumed,
            scenarioSlug,
            isRetry: true,
          });
        }
      }, 8000);
    }
  }

  private clearGreetingTimer(): void {
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
  }
  
  /**
   * Send drill result for pedagogical tracking
   * @param drillId - Unique identifier for the drill
   * @param drillType - Type of drill (repeat, translate, match, fill_blank, sentence_order)
   * @param isCorrect - Whether the student answered correctly
   * @param responseTimeMs - Time taken to respond in milliseconds
   * @param toolContent - Optional content that was displayed for the drill
   */
  sendDrillResult(drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string): void {
    if (this.socket?.connected) {
      this.socket.emit('message', {
        type: 'drill_result',
        drillId,
        drillType,
        isCorrect,
        responseTimeMs,
        toolContent,
      });
    }
  }
  
  /**
   * Send a text input response (from TEXT_INPUT whiteboard tool)
   * This sends the student's written response as input to the voice conversation
   * @param itemId - The whiteboard item ID
   * @param response - The student's typed response
   */
  sendTextInput(itemId: string, response: string): void {
    if (this.socket?.connected) {
      this.socket.emit('message', {
        type: 'text_input',
        itemId,
        response,
      });
    }
  }

  /**
   * Notify the server that the student tapped a scene prop.
   * The server injects a context signal so Daniela reacts naturally to the object.
   */
  sendPropTap(prop: { propName: string; propLabel: string; nativeLabel?: string }): void {
    if (this.socket?.connected) {
      this.socket.emit('message', {
        type: 'prop_tap',
        propName: prop.propName,
        propLabel: prop.propLabel,
        nativeLabel: prop.nativeLabel,
      });
    }
  }

  /**
   * Update the voice mid-session (when user changes tutor)
   */
  updateVoice(tutorGender: 'male' | 'female'): void {
    if (this.isReady()) {
      this.socket!.emit('message', { 
        type: 'update_voice',
        tutorGender,
      });
    }
  }
  
  /**
   * Send voice override settings (Voice Lab)
   * These session-level overrides apply to the next TTS call
   */
  sendVoiceOverride(override: {
    speakingRate?: number;
    personality?: string;
    expressiveness?: number;
    emotion?: string;
    geminiLanguageCode?: string;
    glModel?: string;
  } | null): void {
    if (this.isReady()) {
      this.socket!.emit('message', { 
        type: 'voice_override',
        override,
      });
    }
  }
  
  /**
   * Send a video frame to Daniela's GL session (webcam or screen share).
   * Called at ~0.5fps by the useVisionCapture hook.
   */
  sendVideoFrame(base64Jpeg: string, source: 'webcam' | 'screen'): void {
    // Not isReady(): that excludes 'streaming', which dropped every frame while Daniela was speaking.
    if (canSendVideoFrame(this.state, this.socket?.connected ?? false)) {
      this.socket!.emit('message', {
        type: 'video_frame',
        data: base64Jpeg,
        source,
      });
    }
  }

  /**
   * Request a voice handoff - current tutor says goodbye, then new tutor introduces themselves
   * This provides a natural transition between tutors
   */
  requestVoiceHandoff(newTutorGender: 'male' | 'female', currentTutorName: string, newTutorName: string): void {
    if (this.isReady()) {
      this.socket!.emit('message', { 
        type: 'request_voice_handoff',
        newTutorGender,
        currentTutorName,
        newTutorName,
      });
    }
  }
  
  /**
   * Disconnect and cleanup (user-initiated)
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.isWarmedUp = false;
    this._isReconnectedSession = false;  // Clear reconnect flag so next session gets a greeting
    
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.lastSessionConfig = null;
    
    if (this.socket) {
      if (this.socket.connected) {
        this.socket.emit('message', { type: 'end_session' });
      }
      this.socket.disconnect();
      this.socket = null;
    }
    this.sessionId = null;
    this.voiceSessionId = null;
    this.setState('disconnected');
  }
  
  // Pending audio metadata for binary message association
  private pendingAudioMeta: {
    sentenceIndex: number;
    chunkIndex: number;
    isLast: boolean;
    byteLength: number;
    timestamp: number;
    turnId: number;
    durationMs: number;
    audioFormat: string;
    sampleRate: number;
  } | null = null;
  
  // Sub-chunk reassembly buffer for large audio messages split by server
  private pendingSubChunks: Map<string, {
    chunks: string[];
    totalSubChunks: number;
    baseMessage: any;
  }> = new Map();
  
  /**
   * Handle binary data from Socket.io 'binary' event
   * This receives raw PCM audio data that follows an audio_chunk_meta message
   */
  private handleBinaryData(data: ArrayBuffer): void {
    // GLOBAL DEBUG: Track binary messages
    if (typeof window !== 'undefined') {
      const win = window as any;
      win._wsDebug = win._wsDebug || { messageCount: 0, byType: {} };
      win._wsDebug.messageCount++;
      win._wsDebug.byType['binary'] = (win._wsDebug.byType['binary'] || 0) + 1;
    }
    
    console.log('[WS CLIENT] Received binary audio data:', data.byteLength, 'bytes');
    
    // Use pending metadata if available, otherwise fall back to current sentence index
    const meta = this.pendingAudioMeta;
    const sentenceIndex = meta?.sentenceIndex ?? this.currentSentenceIndex;
    const isLast = meta?.isLast ?? true;
    
    // Clear pending metadata
    this.pendingAudioMeta = null;
    
    // Convert ArrayBuffer to base64 for compatibility with existing audio player
    // Use chunked approach to avoid call stack overflow with large buffers
    const uint8Array = new Uint8Array(data);
    let base64 = '';
    const chunkSize = 32768; // 32KB chunks to stay within call stack limits
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
      base64 += String.fromCharCode.apply(null, Array.from(chunk));
    }
    base64 = btoa(base64);
    
    // Create audio chunk message format expected by existing handlers
    const audioMessage: StreamingAudioChunkMessage = {
      type: 'audio_chunk',
      timestamp: meta?.timestamp ?? Date.now(),
      turnId: meta?.turnId ?? 0,
      sentenceIndex,
      chunkIndex: meta?.chunkIndex ?? 0,
      audio: base64,
      durationMs: meta?.durationMs ?? 0,
      audioFormat: (meta?.audioFormat as 'mp3' | 'pcm_f32le') ?? 'pcm_f32le',
      sampleRate: meta?.sampleRate ?? 24000,
      isLast,
    };
    
    this.handleAudioChunk(audioMessage);
  }
  
  /**
   * Handle incoming Socket.io message (JSON data)
   */
  private handleSocketMessage(data: any): void {
    // GLOBAL DEBUG: Track all messages with persistent counter
    if (typeof window !== 'undefined') {
      const win = window as any;
      win._wsDebug = win._wsDebug || { messageCount: 0, byType: {} };
      win._wsDebug.messageCount++;
    }
    
    // JSON message - minimal processing on hot path
    try {
      // Socket.io delivers parsed objects directly (no need to JSON.parse)
      const message = (typeof data === 'string') ? JSON.parse(data) : data as { type: string; [key: string]: any };
      const win = window as any;
      
      // Single lightweight counter update
      win._wsDebug.byType[message.type] = (win._wsDebug.byType[message.type] || 0) + 1;
      
      switch (message.type) {
        case 'connected':
          // Initial connection confirmed (no session yet)
          break;
          
        case 'session_started':
          this.handleSessionStarted(message as { type: string; sessionId: string; voiceSessionId?: string; timestamp: number });
          break;
          
        case 'processing':
          this.handleProcessing(message as StreamingProcessingMessage);
          break;
          
        case 'processing_pending':
          // IMMEDIATE thinking signal - fired on PTT release before Deepgram finalizes
          // This ensures the thinking avatar shows immediately when user stops speaking
          this.handleProcessingPending(message as { type: string; timestamp: number; interimTranscript: string });
          break;
          
        case 'function_executing':
          // Server-side tool call in progress — refresh thinking avatar so it stays
          // visible during long searches (memory recall, image generation, etc.)
          this.emit('functionExecuting', message);
          break;
          
        case 'gl_audio_reset':
          // DOUBLE-AUDIO FIX: GL reconnected mid-turn (goAway→1007).
          // Pre-reconnect AudioContext sources are still scheduled — player.stop()
          // cancels them. resetForNewTurn() resets dedup so post-reconnect audio
          // plays cleanly without duplication.
          console.log('[WS CLIENT] gl_audio_reset received — clearing client audio buffer for reconnect');
          this.emit('glAudioReset', message);
          break;

        case 'sentence_start':
          this.handleSentenceStart(message as StreamingSentenceStartMessage);
          break;
          
        case 'sentence_ready':
          // Atomic first audio + first timing (prevents timing race)
          this.handleSentenceReady(message as StreamingSentenceReadyMessage);
          break;
          
        case 'audio_chunk':
          // Direct playback - no logging on hot path
          this.handleAudioChunk(message as StreamingAudioChunkMessage);
          break;
          
        case 'audio_chunk_part':
          // Chunked audio for large messages (proxy-safe)
          this.handleAudioChunkPart(message);
          break;
          
        case 'audio_chunk_meta':
          // New binary path - metadata arrives first, then binary data follows
          console.log('[WS CLIENT] Received audio_chunk_meta, awaiting binary data:', message.byteLength, 'bytes, format:', message.audioFormat);
          this.pendingAudioMeta = {
            sentenceIndex: message.sentenceIndex,
            chunkIndex: message.chunkIndex,
            isLast: message.isLast,
            byteLength: message.byteLength,
            timestamp: message.timestamp,
            turnId: message.turnId,
            durationMs: message.durationMs || 0,
            audioFormat: message.audioFormat || 'pcm_f32le',
            sampleRate: message.sampleRate || 24000,
          };
          break;
          
        case 'word_timing':
          this.handleWordTiming(message as StreamingWordTimingMessage);
          break;
          
        case 'word_timing_delta':
          this.handleWordTimingDelta(message as StreamingWordTimingDeltaMessage);
          break;
          
        case 'word_timing_final':
          this.handleWordTimingFinal(message as StreamingWordTimingFinalMessage);
          break;
          
        case 'sentence_end':
          this.handleSentenceEnd(message as StreamingSentenceEndMessage);
          break;
          
        case 'response_complete':
          this.handleResponseComplete(message as StreamingResponseCompleteMessage);
          break;
          
        case 'no_speech_detected':
          console.log('[WS CLIENT] No speech detected - resetting to idle');
          this.emit('noSpeechDetected', message);
          break;
          
        case 'error':
          this.handleError(message as StreamingErrorMessage);
          break;
          
        case 'credits_exhausted':
          console.warn('[WS CLIENT] Credits exhausted message received');
          this.emit('error', new Error(message.message || 'Your session credits have been used up. Visit your Account page to add more hours.'));
          this.setState('error');
          this.intentionalDisconnect = true;
          break;

        case 'session_idle_timeout':
          console.warn('[WS CLIENT] Session ended due to inactivity');
          this.emit('idleTimeout', { idleMinutes: message.idleMinutes ?? 5 });
          this.intentionalDisconnect = true;
          break;

        case 'credit_warning':
          // Mid-session credit balance warning emitted by periodic server sync
          this.emit('creditWarning', {
            level: message.level as 'low' | 'critical' | 'exhausted',
            remainingSeconds: message.remainingSeconds as number,
            percentRemaining: message.percentRemaining as number,
          });
          break;

        case 'session_conflict':
          // Server rejected this connection because user already has an active session elsewhere
          console.warn('[WS CLIENT] Session conflict — already active in another tab/device');
          this.emit('sessionConflict', {
            message: message.message as string,
            existingSessionId: message.existingSessionId as string | undefined,
          });
          this.intentionalDisconnect = true;
          break;
          
        case 'feedback':
          // Pedagogical feedback (one-word rule, pronunciation tips, etc.)
          this.emit('feedback', message as { type: string; feedbackType: string; message: string });
          break;
          
        case 'pronunciation_coaching':
          // Live pronunciation coaching feedback with word-level analysis
          this.emit('pronunciationCoaching', message as {
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
          });
          break;
          
        case 'gl_reconnecting':
          // GL API WebSocket to Google closed unexpectedly; server is auto-reconnecting
          console.log(`[WS CLIENT] GL reconnecting (attempt ${(message as any).attempt}/${(message as any).maxAttempts})`);
          this.setState('reconnecting');
          this.emit('glReconnecting', message as { type: string; attempt: number; maxAttempts: number; delayMs: number });
          break;

        case 'gl_reconnected':
          // GL API WebSocket successfully re-established
          console.log('[WS CLIENT] GL reconnected');
          this.setState('ready');
          this.emit('glReconnected', message);
          break;

        case 'voice_error': {
          const veCode = (message as any).code as string;
          const veMsg = (message as any).message as string;
          const veRecoverable = (message as any).recoverable !== false; // default true
          console.error('[WS CLIENT] Voice error:', veCode, veMsg, 'recoverable:', veRecoverable);
          this.emit('voiceError', { code: veCode, message: veMsg, recoverable: veRecoverable });
          this.emit('error', new Error(veMsg || 'Voice connection encountered an error. Please try again.'));
          if (veRecoverable) {
            // Recoverable = GL is reconnecting server-side; keep intentionalDisconnect false
            // so any subsequent socket.io drop still triggers auto-reconnect.
            // Set state to 'reconnecting' so the UI shows a spinner, not a hard error.
            this.setState('reconnecting');
          } else {
            // Unrecoverable — block reconnect so we don't loop forever.
            this.setState('error');
            this.intentionalDisconnect = true;
          }
          break;
        }

        case 'voice_updated':
          // Voice switch confirmation
          this.emit('voiceUpdated', message as { type: string; gender: string; voiceName: string; timestamp: number });
          break;
          
        case 'tutor_handoff':
          // Tutor handoff - current tutor said goodbye, switch to new tutor
          // Supports both intra-language (gender only) and cross-language (gender + language) handoffs
          // Also supports assistant handoff (role="assistant") for practice partner switches
          this.emit('tutorHandoff', message as { 
            type: string; 
            targetGender: 'male' | 'female'; 
            targetLanguage?: string;  // For cross-language handoffs
            tutorName?: string;       // New tutor's name (e.g., "Sayuri")
            isLanguageSwitch: boolean;
            requiresGreeting?: boolean; // True if client should request greeting after reconnecting
            isAssistant?: boolean;     // True if switching to assistant tutor (navigate to practice page)
            mode?: 'tutor_mode' | 'founder_mode' | 'honesty_mode'; // Session mode for new tutor
            timestamp: number;
          });
          break;
          
        case 'whiteboard_update':
          // Whiteboard content from tutor
          this.emit('whiteboardUpdate', message as StreamingWhiteboardMessage);
          break;

        case 'greeting_retry':
          // Server detected silent greeting and is auto-retrying — tell client to reset watchdog
          this.emit('greetingRetry', message as { type: string; attempt: number });
          break;

        case 'lesson_note_added':
          // Lesson note added by Daniela — accumulates in session notes panel
          this.emit('lessonNoteAdded', message as { type: string; timestamp: number; note: any });
          break;

        case 'pronunciation_score_shown':
          this.emit('pronunciationScoreShown', message as { type: string; timestamp: number; data: any });
          break;

        case 'grammar_flag_shown':
          this.emit('grammarFlagShown', message as { type: string; timestamp: number; data: any });
          break;

        case 'quiz_presented':
          this.emit('quizPresented', message as { type: string; timestamp: number; data: any });
          break;

        case 'cultural_context_shown':
          this.emit('culturalContextShown', message as { type: string; timestamp: number; data: any });
          break;

        case 'spotlight_shown':
          this.emit('spotlightShown', message as { type: string; timestamp: number; data: any });
          break;

        case 'voice_mission_set':
          // Gap D: Daniela set a shared session mission — show persistent badge in UI
          this.emit('missionSet', message as { type: string; mission: string; timestamp: number });
          break;
          
        case 'vad_speech_started':
          this.emit('vadSpeechStarted', message);
          break;
          
        case 'vad_utterance_end':
          this.emit('vadUtteranceEnd', message);
          break;
          
        case 'interim_transcript':
          this.emit('interimTranscript', message);
          break;

        case 'transcript':
          // Final user speech transcript from Gemini Live VAD
          this.emit('transcript', message as { type: string; text: string; isFinal: boolean; source: string });
          break;

        case 'daniela_transcript':
          // Daniela's spoken response transcription from Gemini Live
          this.emit('danielaTranscript', message as { type: string; text: string; turnId: number });
          break;

        case 'incognito_changed':
          // Server confirmed incognito toggle — drives authoritative client state
          this.emit('incognitoChanged', message as { type: string; enabled: boolean; timestamp: number });
          break;
          
        case 'input_mode_changed':
          this.emit('inputModeChanged', message);
          break;
          
        case 'open_mic_session_closed':
          this.emit('openMicSessionClosed', message);
          break;
          
        case 'stt_degraded':
          this.emit('sttDegraded', { userMessage: (message as any).userMessage });
          break;
          
        case 'open_mic_silence_loop':
          console.warn(`[StreamingVoice] Silence loop detected: ${message.consecutiveEmptyCount} consecutive empty transcripts`);
          this.emit('openMicSilenceLoop', message);
          break;
          
        case 'subtitle_mode_change':
          // Server command to change subtitle mode (from tutor [SUBTITLE on/off/target] command)
          console.log('[StreamingVoice] Subtitle mode change from server:', message.mode);
          this.emit('subtitleModeChange', message as { type: string; mode: 'off' | 'target'; timestamp: number });
          break;
          
        case 'custom_overlay':
          // Server command to show/hide custom overlay (from tutor [SHOW: text] / [HIDE] commands)
          console.log('[StreamingVoice] Custom overlay from server:', message.action, message.text?.substring(0, 50));
          this.emit('customOverlay', message as { type: string; action: 'show' | 'hide'; text?: string; timestamp: number });
          break;
          
        case 'text_input_request':
          console.log('[StreamingVoice] Text input request from server:', message.prompt?.substring(0, 50));
          this.emit('textInputRequest', message as { type: string; prompt: string; timestamp: number });
          break;

        case 'character_change':
          console.log('[StreamingVoice] Character change:', message.character?.displayName ?? 'tutor resumed');
          this.emit('characterChange', message as { type: string; character: { id: string; displayName: string; role: string; gender: 'male' | 'female' } | null; timestamp: number });
          break;

        case 'sofia_incident_created':
          console.log('[StreamingVoice] Sofia incident created:', message.incidentId, message.category);
          this.emit('sofiaIncidentCreated', message as { type: string; incidentId: string; category: string; priority: string; issueDescription: string; status: string; timestamp: number });
          break;

        case 'sofia_support_message':
          console.log('[StreamingVoice] Sofia support message for incident:', message.incidentId);
          this.emit('sofiaSupportMessage', message as { type: string; incidentId: string; category: string; priority: string; message: string; timestamp: number });
          break;

        case 'sofia_all_clear':
          console.log('[StreamingVoice] Sofia all_clear for incident:', message.incidentId);
          this.emit('sofiaAllClear', message as { type: string; incidentId: string; timestamp: number });
          break;

        case 'scenario_loaded':
          console.log('[StreamingVoice] Scenario loaded:', message.scenario?.title, message.scenario?.zones?.length ? `(${message.scenario.zones.length} zones)` : '');
          this.emit('scenarioLoaded', message);
          break;

        case 'scene_zone_advanced':
          console.log('[StreamingVoice] Scene zone advanced → zone', message.zoneIndex, message.zoneName ?? '(complete)');
          this.emit('zoneAdvanced', message);
          break;

        case 'scene_zone_image_ready':
          console.log('[StreamingVoice] Zone image ready for zone', message.zoneId);
          this.emit('zoneImageReady', message);
          break;

        case 'scenario_ended':
          console.log('[StreamingVoice] Scenario ended:', message.scenarioSlug);
          this.emit('scenarioEnded', message);
          break;

        case 'prop_update':
          console.log('[StreamingVoice] Prop updated:', message.propTitle);
          this.emit('propUpdate', message);
          break;

        case 'immersive_mode':
          console.log('[StreamingVoice] Immersive mode:', message.active ? 'entering' : 'exiting');
          this.emit('immersiveMode', message);
          break;

        case 'activity':
          // Keep-alive message from server during speculative PTT suppression
          // Intentionally ignored - just prevents heartbeat timeout
          break;
          
        default:
          // Unknown message types - no logging on hot path
      }
    } catch (error) {
      if (isVerboseLoggingEnabled()) {
        console.error('[StreamingVoiceClient] Failed to parse message:', error);
      }
      // Track parse errors at window level for debugging
      if (typeof window !== 'undefined') {
        const win = window as any;
        win._parseErrors = win._parseErrors || [];
        win._parseErrors.push({ error: String(error), time: Date.now() });
      }
    }
  }
  
  private handleSessionStarted(message: { type: string; sessionId: string; voiceSessionId?: string; timestamp: number; isGeminiLive?: boolean }): void {
    this.sessionId = message.sessionId;
    this.voiceSessionId = message.voiceSessionId ?? null;
    this.isGeminiLiveSession = !!message.isGeminiLive;
    
    // Wire up telemetry emitter with session ID
    telemetryEmitter.setSessionId(message.sessionId);
    
    this.setState('ready');
    this.callbacks.onSessionStart?.(message.sessionId, this.voiceSessionId);
    this.emit('sessionStart', {
      sessionId: message.sessionId,
      voiceSessionId: this.voiceSessionId,
    });
    // StreamingVoiceChat observes this ready transition and issues the single
    // startup request with student/scenario context. Its reconnect request has
    // isResumed=true, which remains allowed above for Gemini Live's fresh socket.
  }
  
  private handleProcessing(message: StreamingProcessingMessage): void {
    console.log('[PROCESSING RECEIVED] ★ processing message received at', Date.now());
    telemetryEmitter.emit('processing_signal_received', { signalType: 'processing' });
    this.setState('processing');
    this.callbacks.onProcessing?.(message.userTranscript);
    this.emit('processing', message);
  }
  
  private handleProcessingPending(message: { type: string; timestamp: number; interimTranscript: string }): void {
    console.log('[PROCESSING RECEIVED] ★ processing_pending message received at', Date.now());
    telemetryEmitter.emit('processing_signal_received', { signalType: 'processing_pending' });
    this.setState('processing');
    this.callbacks.onProcessing?.(message.interimTranscript);
    this.emit('processing_pending', message);
  }
  
  private handleSentenceStart(message: StreamingSentenceStartMessage): void {
    this.clearGreetingTimer();
    this.currentSentenceIndex = message.sentenceIndex;
    this.setState('streaming');
    if (message.totalSentences !== undefined) {
      this.emit('expectedSentenceCount', { count: message.totalSentences });
    }
    this.callbacks.onSentenceStart?.(message.sentenceIndex, message.text, message.targetLanguageText);
    this.emit('sentenceStart', message);
  }
  
  /**
   * NEW: Handle atomic sentence_ready message
   * Server sends this when BOTH first audio chunk AND first word timing are ready.
   * This prevents the timing race condition where playback starts before timings arrive.
   * 
   * The message contains:
   * - firstAudioChunk: The first audio chunk (can start playback)
   * - firstWordTimings: All word timings received so far (at least 1)
   * 
   * Client should use this as the signal to start playback - guaranteed to have timing data.
   */
  private handleSentenceReady(message: StreamingSentenceReadyMessage): void {
    const { sentenceIndex, firstWordTimings } = message;
    const audioStripped = (message as any).firstAudioChunk?.audioStripped === true;
    const hasAudio = message.firstAudioChunk?.audio && message.firstAudioChunk.audio.length > 0;
    
    console.log(`[WS CLIENT] sentence_ready received: sentence=${sentenceIndex}, timings=${firstWordTimings?.length || 0}, hasAudio=${hasAudio}, audioStripped=${audioStripped}`);
    
    // Audio is arriving — greeting was delivered, cancel any pending retry timer
    this.clearGreetingTimer();
    this.currentSentenceIndex = sentenceIndex;
    this.setState('streaming');
    
    this.emit('sentenceReady', message);
  }
  
  private handleAudioChunk(message: StreamingAudioChunkMessage): void {
    // Audio is arriving — greeting was delivered, cancel any pending retry timer.
    // GL sessions send audio_chunk (not sentence_start), so this is the primary clear path for GL.
    this.clearGreetingTimer();
    // Store metadata for the upcoming binary frame
    this.currentSentenceIndex = message.sentenceIndex;
    
    // Telemetry: track audio chunk received
    telemetryEmitter.emit(
      'audio_chunk_received',
      {
        audioLength: message.audio?.length ?? 0,
        isChunked: false,
        serverEmitTime: message.timestamp,
      },
      message.sentenceIndex,
      message.chunkIndex
    );
    
    // Emit audio chunk with embedded base64 data (no logging on hot path)
    this.emit('audioChunk', message);
  }
  
  /**
   * Handle chunked audio parts for large messages
   * Server splits large audio_chunk messages into smaller parts (50KB each)
   * to avoid Replit proxy dropping large Socket.io messages
   */
  private handleAudioChunkPart(message: any): void {
    const { sentenceIndex, chunkIndex, partIndex, totalParts, audio, isFinalPart } = message;
    const key = `${sentenceIndex}-${chunkIndex}`;
    
    console.log(`[AUDIO CHUNK PART] sentence=${sentenceIndex}, chunk=${chunkIndex}, part=${partIndex}/${totalParts}`);
    
    // Get or create reassembly buffer
    let buffer = this.pendingSubChunks.get(key);
    if (!buffer) {
      buffer = {
        chunks: new Array(totalParts).fill(''),
        totalSubChunks: totalParts,
        baseMessage: partIndex === 0 ? {
          timestamp: message.timestamp,
          turnId: message.turnId,
          durationMs: message.durationMs,
          audioFormat: message.audioFormat,
          sampleRate: message.sampleRate,
          isLast: message.isLast,
        } : null,
      };
      this.pendingSubChunks.set(key, buffer);
    }
    
    // Store this part
    buffer.chunks[partIndex] = audio;
    
    // If first chunk has metadata, save it
    if (partIndex === 0 && message.timestamp) {
      buffer.baseMessage = {
        timestamp: message.timestamp,
        turnId: message.turnId,
        durationMs: message.durationMs,
        audioFormat: message.audioFormat,
        sampleRate: message.sampleRate,
        isLast: message.isLast,
      };
    }
    
    // Check if all parts received
    const receivedCount = buffer.chunks.filter(c => c !== '').length;
    if (receivedCount === totalParts) {
      // Reassemble and emit as full audio_chunk
      const fullAudio = buffer.chunks.join('');
      console.log(`[AUDIO CHUNK PART] REASSEMBLED: ${fullAudio.length} bytes from ${totalParts} parts`);
      
      // Telemetry: track reassembly completion
      telemetryEmitter.emit(
        'audio_chunk_reassembled',
        {
          audioLength: fullAudio.length,
          totalParts,
          serverEmitTime: buffer.baseMessage?.timestamp,
        },
        sentenceIndex,
        chunkIndex
      );
      
      const fullMessage: StreamingAudioChunkMessage = {
        type: 'audio_chunk',
        timestamp: buffer.baseMessage?.timestamp ?? Date.now(),
        turnId: buffer.baseMessage?.turnId ?? 0,
        sentenceIndex,
        chunkIndex,
        audio: fullAudio,
        durationMs: buffer.baseMessage?.durationMs ?? 0,
        audioFormat: (buffer.baseMessage?.audioFormat as 'mp3' | 'pcm_f32le') ?? 'pcm_f32le',
        sampleRate: buffer.baseMessage?.sampleRate ?? 24000,
        isLast: buffer.baseMessage?.isLast ?? true,
      };
      
      // Clean up and process
      this.pendingSubChunks.delete(key);
      this.handleAudioChunk(fullMessage);
    }
  }
  
  private handleWordTiming(message: StreamingWordTimingMessage): void {
    this.callbacks.onWordTimings?.(message.sentenceIndex, message.words);
    this.emit('wordTiming', message);
  }
  
  /**
   * PROGRESSIVE STREAMING: Handle incremental word timing update
   * These arrive as words are timestamped during progressive TTS
   */
  private handleWordTimingDelta(message: StreamingWordTimingDeltaMessage): void {
    // Emit immediately - no logging or tracking on hot path
    this.emit('wordTimingDelta', message);
  }
  
  /**
   * PROGRESSIVE STREAMING: Handle final word timing reconciliation
   * Sent when sentence synthesis completes with authoritative timings
   */
  private handleWordTimingFinal(message: StreamingWordTimingFinalMessage): void {
    // Emit immediately - no logging on hot path
    this.emit('wordTimingFinal', message);
  }
  
  private handleSentenceEnd(message: StreamingSentenceEndMessage): void {
    this.callbacks.onSentenceEnd?.(message.sentenceIndex, message.totalDurationMs);
    this.emit('sentenceEnd', message);
  }
  
  private handleResponseComplete(message: StreamingResponseCompleteMessage): void {
    this.consecutiveSessionErrors = 0;
    // Transition back to 'ready' so client can send more audio
    this.setState('ready');

    // GREETING FAST-RETRY (legacy pipeline only): If the orchestrator returns a silent empty
    // turn (sentences=0) while we're still in the greeting window (greetingTimer is active,
    // retry not yet fired), don't wait the full 8 seconds — retry after 1.5s.
    // GL sessions skip this: the server-side one-shot guard blocks duplicate request_greeting
    // and the server's own silent-greeting auto-retry (max 2) is the sanctioned recovery path.
    if (!this.isGeminiLiveSession && message.totalSentences === 0 && this.greetingTimer && !this.greetingRetried) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
      this.greetingRetried = true;
      const params = this.lastGreetingParams;
      console.warn('[StreamingVoice] Empty greeting turn (sentences=0) — fast retry in 1.5s');
      setTimeout(() => {
        if (this.isReady() && params) {
          this.socket!.emit('message', {
            type: 'request_greeting',
            userName: params.userName,
            isResumed: params.isResumed,
            scenarioSlug: params.scenarioSlug,
            isRetry: true,
          });
        }
      }, 1500);
    }

    this.callbacks.onResponseComplete?.(message.fullText ?? '', message.totalSentences);
    this.emit('responseComplete', message);
  }
  
  private handleError(message: StreamingErrorMessage): void {
    this.callbacks.onError?.(message.code, message.message, message.recoverable);

    if (message.code === 'TTS_ERROR' && message.recoverable) {
      this.emit('ttsError', { code: message.code, message: message.message });
      console.warn(`[StreamingVoice] TTS error (recoverable, session continues): ${message.message}`);
      return;
    }

    if (message.message?.includes('Session not ready')) {
      this.consecutiveSessionErrors++;
      console.warn(`[StreamingVoice] Session not ready error #${this.consecutiveSessionErrors}/${this.MAX_SESSION_ERRORS}`);
      if (this.consecutiveSessionErrors >= this.MAX_SESSION_ERRORS) {
        console.error(`[StreamingVoice] Too many session errors — ending zombie reconnection loop`);
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.reconnectAttempts = this.maxReconnectAttempts;
        if (this.socket) {
          this.socket.disconnect();
          this.socket = null;
          this.sessionId = null;
        }
        this.setState('disconnected');
        this.emit('error', { 
          code: 'SESSION_EXPIRED', 
          message: 'This session has ended. Please start a new conversation.',
          recoverable: false 
        });
        return;
      }
    }

    this.emit('error', new Error(message.message));
    
    if (!message.recoverable) {
      // 1. First transition to 'error' state so UI can show error message
      this.setState('error');
      
      // 2. Clear any pending reconnection timers to prevent stale reconnects
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;  // Reset reconnect counter
      
      // 3. Mark as intentional disconnect to skip auto-reconnect in handleDisconnect
      this.intentionalDisconnect = true;
      
      // 4. Close socket cleanly
      if (this.socket) {
        this.socket.disconnect();
        this.socket = null;
        this.sessionId = null;
      }
      
      // 5. Allow a brief moment for UI to observe error state before transitioning
      // This ensures error messages can be displayed before the "start new session" state
      setTimeout(() => {
        // Transition to 'disconnected' so user can start fresh
        this.setState('disconnected');
      }, 100);  // 100ms is enough for React to re-render with error message
    } else {
      // RECOVERABLE ERROR (e.g., EMPTY_TRANSCRIPT): Go back to 'ready' state
      // This unlocks the mic so user can try speaking again
      this.setState('ready');
    }
  }
  
  private setState(state: StreamingConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onConnectionStateChange?.(state);
      this.emit('stateChange', state);
    }
  }
  
  private handleDisconnect(): void {
    this.socket = null;
    this.sessionId = null;
    this.clearGreetingTimer();
    
    // Skip auto-reconnect if disconnect was user-initiated
    if (this.intentionalDisconnect) {
      this.setState('disconnected');
      return;
    }
    
    // Skip if no conversationId to reconnect to
    if (!this.lastConversationId) {
      this.setState('disconnected');
      return;
    }
    
    // Two-phase auto-reconnect:
    // Phase 1 (attempts 1-3): Fast — covers brief drops / tab backgrounding (200ms, 1s, 2s)
    // Phase 2 (attempts 4-12): Slow — covers server restarts / deployments (10s, 15s, 20s … 30s)
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const isServerRestartPhase = this.reconnectAttempts > 3;
      const delay = this.reconnectAttempts === 1
        ? 200
        : this.reconnectAttempts <= 3
          ? Math.pow(2, this.reconnectAttempts - 2) * 1000  // 1s, 2s
          : Math.min((this.reconnectAttempts - 3) * 5000 + 10000, 30000); // 15s, 20s, 25s … 30s
      
      this.setState('reconnecting');
      
      // Use distinct code so UI can show the right message
      const code = isServerRestartPhase ? 'SERVER_RESTARTING' : 'RECONNECTING';
      const slowAttempt = this.reconnectAttempts - 3;
      const slowMax = this.maxReconnectAttempts - 3;
      this.emit('error', { 
        code,
        message: isServerRestartPhase
          ? `Server is restarting. Reconnecting automatically... (${slowAttempt}/${slowMax})`
          : `Connection lost. Reconnecting... (${this.reconnectAttempts}/3)`,
        recoverable: true 
      });
      
      this.reconnectTimer = setTimeout(() => this.runReconnectAttempt(), delay);
    } else {
      this.reconnectAttempts = 0;
      this.setState('disconnected');
      
      // Emit final error to UI
      this.emit('error', { 
        code: 'CONNECTION_FAILED', 
        message: 'Connection lost. Please restart the voice chat.',
        recoverable: false 
      });
    }
  }

  /** The network is back: run the attempt now rather than waiting out the backoff. */
  private retryNowIfWaiting(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.runReconnectAttempt();
  }

  private async runReconnectAttempt(): Promise<void> {
    this.reconnectTimer = null;
    this.reconnectAttemptInFlight = true;
    try {
      await this.connect(this.lastConversationId!);
      this.reconnectAttempts = 0;
      this.consecutiveSessionErrors = 0;
      this.intentionalDisconnect = false;

      // CRITICAL: Reinitialize the server-side session after reconnection
      // Without this, audio chunks are rejected with "Session not ready for streaming"
      // Mark as reconnect so server skips greeting and avoids duplicate audio streams
      if (this.lastSessionConfig) {
        console.log('[StreamingVoice] Reconnected - reinitializing session (isReconnect=true)');
        this._isReconnectedSession = true;
        this.startSession({ ...this.lastSessionConfig, isReconnect: true });

        // RECONNECT FIX: Restore input mode immediately after start_session.
        // The server always defaults to push-to-talk on a new WS connection.
        // set_input_mode requires no auth so it takes effect before session creation
        // completes — ensuring open-mic audio chunks route to the correct handler.
        if (this._lastKnownInputMode === 'open-mic') {
          console.log('[StreamingVoice] Restoring open-mic mode after reconnect');
          this.socket!.emit('message', { type: 'set_input_mode', inputMode: 'open-mic' });
          // Replay any audio chunks buffered during the reconnect gap so the
          // student's in-flight utterance reaches the server instead of being silently dropped.
          this._flushPendingChunks();
        }
      }

      this.emit('reconnected', { timestamp: Date.now() });
    } catch (err) {
      // A socket that drops after connecting fires 'disconnect', which already scheduled the
      // next attempt or gave up. One that never connected (no network) fires only
      // 'connect_error', so nothing else will continue the loop: it must continue here.
      if (!this.reconnectTimer && this.state !== 'disconnected') {
        this.handleDisconnect();
      }
    } finally {
      this.reconnectAttemptInFlight = false;
    }
  }
}

/**
 * Singleton instance - stored on window to survive duplicate module bundling
 * This is CRITICAL: Vite/bundlers may create multiple copies of this module,
 * each with their own module-scoped variables. By storing on window, we ensure
 * ALL imports get the SAME instance, preventing the bug where:
 * - Instance #1 owns the WebSocket connection
 * - Instance #2 has the React listeners
 * - Messages never reach the UI
 */

export function getStreamingVoiceClient(): StreamingVoiceClient {
  // Use window storage to ensure single instance across all module copies
  // This is CRITICAL for preventing the dual-instance WebSocket bug where:
  // - Vite bundles may create multiple module copies
  // - Each copy would have its own module-scoped singleton variable
  // - Instance #1 owns the WebSocket, Instance #2 has React listeners
  // - By storing on window, ALL imports share the SAME instance
  if (typeof window !== 'undefined') {
    // REUSE existing instance if present
    if (window.__streamingVoiceClient) {
      return window.__streamingVoiceClient;
    }
    
    // Create new instance only when none exists
    window.__streamingVoiceClient = new StreamingVoiceClient();
    return window.__streamingVoiceClient;
  }
  
  // Fallback for SSR (shouldn't happen in this app)
  return new StreamingVoiceClient();
}

/**
 * Force create a fresh client instance - use sparingly!
 * This disconnects any existing connection and creates a new one.
 * Only use when you need to reset connection state completely.
 */
export function resetStreamingVoiceClient(): StreamingVoiceClient {
  if (typeof window !== 'undefined' && window.__streamingVoiceClient) {
    window.__streamingVoiceClient.disconnect();
    window.__streamingVoiceClient = null;
  }
  return getStreamingVoiceClient();
}

/**
 * Get client-side diagnostics for Sofia issue reports
 * Captures voice connection state, audio status, and device info at moment of issue
 */
export function getClientDiagnosticsSnapshot(): Record<string, any> {
  try {
    const client = typeof window !== 'undefined' && window.__streamingVoiceClient
      ? window.__streamingVoiceClient
      : null;
    
    return {
      // Voice connection state
      voiceClient: client?.getClientDiagnostics() || { status: 'not_initialized' },
      
      // Device info
      device: {
        browser: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        onLine: navigator.onLine,
        cookiesEnabled: navigator.cookieEnabled,
      },
      
      // Audio context state (if available)
      audioContext: typeof AudioContext !== 'undefined' ? {
        available: true,
        // AudioContext may not exist yet
        state: 'unknown',
      } : { available: false },
      
      // Capture timestamp
      capturedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      error: 'Failed to capture diagnostics',
      message: String(e),
      capturedAt: new Date().toISOString(),
    };
  }
}
