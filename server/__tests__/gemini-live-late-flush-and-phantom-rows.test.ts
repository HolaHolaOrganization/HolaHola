import assert from "node:assert/strict";
import test from "node:test";

// Unref module-level housekeeping intervals (db pool keepalive, telemetry flush, etc.)
// so the test runner exits cleanly once all assertions finish.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) =>
  realSetInterval(...args).unref()) as typeof setInterval;

// Force an unreachable local dummy URL before importing modules that load server/db.ts,
// ensuring unit tests never connect to Neon or write rolling episode triggers.
process.env.NEON_SHARED_DATABASE_URL =
  "postgresql://unit-test:unit-test@127.0.0.1:1/unit_test_no_db";
process.env.DEEPGRAM_API_KEY ||= "unit-test-dummy-deepgram-key";
delete process.env.CI_DATABASE_URL;
delete process.env.DATABASE_URL;

const { GeminiLiveSession } = await import("../services/gemini-live-session");
const { voiceTelemetry } = await import("../services/voice-pipeline-telemetry");

interface PersistedRow {
  role: "user" | "assistant";
  content: string;
  thoughtContent: string | null;
}

function createHarness() {
  const wsMessages: any[] = [];
  const persisted: PersistedRow[] = [];
  const telemetryEvents: Array<{
    sessionId: string;
    userId: string;
    eventType: string;
    eventData: Record<string, any>;
  }> = [];
  const episodeAppends: string[] = [];

  const fakeSession: any = {
    id: "stream_test_session",
    dbSessionId: "db-session-123",
    userId: "user-123",
    conversationId: "conv-123",
    targetLanguage: "spanish",
    tutorName: "Daniela",
    isIncognito: false,
    ws: {},
    currentTurnId: 0,
  };

  const gl = new GeminiLiveSession(fakeSession, (_ws, message) => {
    wsMessages.push(message);
  });

  // Stub liveSession so sendAudioChunk / sendTextTurn / interrupt work in-memory.
  (gl as any).liveSession = {
    sendRealtimeInput: () => {},
    sendClientContent: () => {},
    sendToolResponse: () => {},
  };

  // Stub DB persistence and background enrichment.
  (gl as any).persistMessage = async (
    role: "user" | "assistant",
    content: string,
    thoughtContent: string | null = null,
  ) => {
    persisted.push({ role, content, thoughtContent });
    return `msg-${persisted.length}`;
  };
  (gl as any).enrichment = {
    processBackgroundEnrichment: async () => {},
  };
  (gl as any).appendExchangeToRollingEpisode = async (exchange: string) => {
    episodeAppends.push(exchange);
  };

  const origTelemetryLog = voiceTelemetry.log.bind(voiceTelemetry);
  (voiceTelemetry as any).log = (
    sessionId: string,
    userId: string,
    eventType: string,
    eventData: Record<string, any> = {},
  ) => {
    telemetryEvents.push({ sessionId, userId, eventType, eventData });
  };

  const cleanup = () => {
    if ((gl as any).transcriptFlushTimer) {
      clearTimeout((gl as any).transcriptFlushTimer);
      (gl as any).transcriptFlushTimer = null;
    }
    if ((gl as any).generationCompleteSealTimer) {
      clearTimeout((gl as any).generationCompleteSealTimer);
      (gl as any).generationCompleteSealTimer = null;
    }
    if ((gl as any).generationCompleteWatchdogTimer) {
      clearTimeout((gl as any).generationCompleteWatchdogTimer);
      (gl as any).generationCompleteWatchdogTimer = null;
    }
    if ((gl as any).playbackGateSafetyTimeout) {
      clearTimeout((gl as any).playbackGateSafetyTimeout);
      (gl as any).playbackGateSafetyTimeout = null;
    }
    (voiceTelemetry as any).log = origTelemetryLog;
  };

  return { gl, fakeSession, wsMessages, persisted, telemetryEvents, episodeAppends, cleanup };
}

test("G4: late turnComplete after turn already flushed does not arm 8s fallback; sub-turn and dropped generationComplete still arm it", async () => {
  const { gl, persisted, cleanup } = createHarness();
  try {
    // 1. Simulate a completed and flushed response (Turn 0 -> flushed via generationComplete).
    (gl as any).greetingPhaseActive = false;
    (gl as any).isGreetingTurn = false;
    (gl as any).hasStudentInputSinceLastResponse = false;
    (gl as any).currentSentenceIndex = 1;
    (gl as any).pendingOutputTranscript = "¡Hola! ¿Cómo estás?";
    await (gl as any)._doFlushTranscripts();

    assert.equal((gl as any).responseFlushedToClient, true, "turn flush sets responseFlushedToClient");
    assert.equal(persisted.length, 1, "initial assistant response persisted once");

    // Even if client playback_ended arrived and open-mic silence sent a PCM chunk
    // before the late turnComplete arrived (inferred 6–16s after generationComplete from
    // +14–24s flush timing in Live Test 2 dbSession 151ccc83-50e8-4516-9d88-65d98918f358),
    // no new model response has started, so responseFlushedToClient is still true.
    gl.sendAudioChunk(Buffer.alloc(320));
    assert.equal((gl as any).hasStudentInputSinceLastResponse, true);
    assert.equal((gl as any).responseFlushedToClient, true);

    // Late turnComplete arrives for the already-flushed turn: must NOT arm the 8s fallback.
    await (gl as any).handleServerMessage({
      serverContent: { turnComplete: true },
    });
    assert.equal(
      (gl as any).transcriptFlushTimer,
      null,
      "late turnComplete after turn already flushed must not arm 8s transcriptFlushTimer",
    );

    // 2. Also verify turnComplete arriving while generationCompleteSealTimer is pending does not arm 8s fallback.
    (gl as any).responseFlushedToClient = false;
    (gl as any).generationCompleteSealTimer = setTimeout(() => {}, 60_000);
    await (gl as any).handleServerMessage({
      serverContent: { turnComplete: true },
    });
    assert.equal(
      (gl as any).transcriptFlushTimer,
      null,
      "turnComplete while generationCompleteSealTimer is active must not arm 8s transcriptFlushTimer",
    );
    clearTimeout((gl as any).generationCompleteSealTimer);
    (gl as any).generationCompleteSealTimer = null;

    // 3. Now start a genuine next audio response (sub-turn 1): responseFlushedToClient resets to false.
    (gl as any).responseFlushedToClient = true;
    (gl as any).isTutorGeneratingAudio = false;
    (gl as any).afterGenerationComplete = true;
    (gl as any).hasStudentInputSinceLastResponse = true;

    const pcmBase64 = Buffer.alloc(640).toString("base64");
    await (gl as any).handleServerMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcmBase64 } }],
        },
        outputTranscription: { text: "Primera frase." },
      },
    });
    assert.equal(
      (gl as any).responseFlushedToClient,
      false,
      "genuine new model audio response clears responseFlushedToClient",
    );

    // Sub-turn 1 turnComplete arrives (before generationComplete): MUST arm the 8s fallback timer,
    // and must NOT flush immediately between sub-turns.
    await (gl as any).handleServerMessage({
      serverContent: { turnComplete: true },
    });
    const firstSubturnTimer = (gl as any).transcriptFlushTimer;
    assert.notEqual(
      firstSubturnTimer,
      null,
      "sub-turn turnComplete before generationComplete must arm 8s fallback timer",
    );
    assert.equal(persisted.length, 1, "must not flush immediately between sub-turns");

    // Sub-turn 2 arrives and emits turnComplete: resets the 8s fallback timer; if generationComplete is dropped,
    // the fallback timer protects the response.
    await (gl as any).handleServerMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcmBase64 } }],
        },
        outputTranscription: { text: " Segunda frase." },
        turnComplete: true,
      },
    });
    assert.notEqual((gl as any).transcriptFlushTimer, null, "sub-turn 2 turnComplete keeps 8s fallback armed");
    assert.notEqual(
      (gl as any).transcriptFlushTimer,
      firstSubturnTimer,
      "sub-turn 2 turnComplete resets the 8s fallback timer",
    );
    clearTimeout((gl as any).transcriptFlushTimer);
    (gl as any).transcriptFlushTimer = null;

    // 4. Verify a genuine text-only next response (hadAudio: false, student spoke) also clears
    // responseFlushedToClient so a dropped generationComplete is still protected by turnComplete.
    await (gl as any)._doFlushTranscripts();
    assert.equal((gl as any).responseFlushedToClient, true);
    (gl as any).isTutorGeneratingAudio = false;

    gl.sendAudioChunk(Buffer.alloc(320));
    assert.equal((gl as any).hasStudentInputSinceLastResponse, true);
    await (gl as any).handleServerMessage({
      serverContent: {
        modelTurn: { parts: [] },
        outputTranscription: { text: "Respuesta solo texto." },
        turnComplete: true,
      },
    });
    assert.equal(
      (gl as any).responseFlushedToClient,
      false,
      "genuine text-only response with student input clears responseFlushedToClient",
    );
    assert.notEqual(
      (gl as any).transcriptFlushTimer,
      null,
      "genuine text-only response with dropped generationComplete arms 8s fallback on turnComplete",
    );
  } finally {
    cleanup();
  }
});

test("G3: phantom 0-sentence turn with no student input and non-empty pendingInputTranscript does not fire Guardian, persist rows, or append episode, and logs discarded length", async () => {
  const { gl, persisted, telemetryEvents, episodeAppends, cleanup } = createHarness();
  try {
    // Session after a completed real turn: no new student input has arrived.
    (gl as any).greetingPhaseActive = false;
    (gl as any).isGreetingTurn = false;
    (gl as any).hasStudentInputSinceLastResponse = false;
    (gl as any).isTutorGeneratingAudio = false;
    (gl as any).currentSentenceIndex = 0;
    (gl as any).lastUserText = "Prior real student turn";

    const phantomInput = "Let's count in Spanish from one to ten, I remember what you told me yesterday";
    const phantomOutput =
      "Uno, dos, tres, cuatro, cinco, seis, siete, ocho, nueve, diez! " +
      "I remember you told me last time we practiced counting together in Madrid that you loved numbers " +
      "and we discussed how Spanish pronunciation feels natural when counting.";

    // Upstream GL emits phantom inputTranscription + outputTranscription + generationComplete
    // with 0 audio sentences and hasStudentInputSinceLastResponse === false.
    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: phantomInput, finished: true },
        outputTranscription: { text: phantomOutput },
        generationComplete: true,
      },
    });

    // Cancel the 800ms seal timer and run _doFlushTranscripts immediately.
    if ((gl as any).generationCompleteSealTimer) {
      clearTimeout((gl as any).generationCompleteSealTimer);
      (gl as any).generationCompleteSealTimer = null;
    }
    await (gl as any)._doFlushTranscripts();

    // 1. Guardian must NOT have fired (neither pre-turn, hard-wall, post-turn-phrase, nor friction-signal).
    assert.equal((gl as any).preTurnGroundingFired, false, "Pre-Turn Guardian must not fire on phantom input");
    assert.equal((gl as any).hardWallTriggered, false, "HardWall must not fire on phantom output");
    assert.equal(
      (gl as any).guardianFireLog.length,
      0,
      `Guardian fire log must remain empty on phantom turn, got: ${JSON.stringify((gl as any).guardianFireLog)}`,
    );

    // 2. Zero DB rows persisted (neither user nor assistant).
    assert.equal(
      persisted.length,
      0,
      `Phantom 0-sentence turn must not persist any messages, got: ${JSON.stringify(persisted)}`,
    );

    // 3. .episode_append / sessionExchangeLog must NOT be written.
    assert.equal((gl as any).sessionExchangeLog.length, 0, "Phantom turn must not push to sessionExchangeLog");
    assert.equal(episodeAppends.length, 0, "Phantom turn must not write to .episode_append");

    // 4. Both pending transcripts must be discarded so they cannot bleed into the next real turn.
    assert.equal((gl as any).pendingInputTranscript, "", "pendingInputTranscript must be cleared");
    assert.equal((gl as any).pendingOutputTranscript, "", "pendingOutputTranscript must be cleared");

    // 5. Observer telemetry (gl_ghost_turn_suppressed) must log the discarded lengths.
    const suppressedEvent = telemetryEvents.find(e => e.eventType === "gl_ghost_turn_suppressed");
    assert.ok(suppressedEvent, "gl_ghost_turn_suppressed telemetry event must be emitted");
    assert.equal(
      suppressedEvent.eventData.discardedInputChars,
      phantomInput.length,
      "gl_ghost_turn_suppressed must log discardedInputChars for the observer",
    );
    assert.equal(
      suppressedEvent.eventData.discardedOutputChars,
      phantomOutput.length,
      "gl_ghost_turn_suppressed must log discardedOutputChars for the observer",
    );
  } finally {
    cleanup();
  }
});

test("G3 real-0-audio: student input via sendAudioChunk, interrupt, or sendTextTurn({ isStudentInput: true }) with 0 audio sentences still persists and resets hasStudentInputSinceLastResponse", async () => {
  const { gl, persisted, episodeAppends, cleanup } = createHarness();
  try {
    (gl as any).greetingPhaseActive = false;
    (gl as any).isGreetingTurn = false;
    (gl as any).hasStudentInputSinceLastResponse = false;
    (gl as any).isTutorGeneratingAudio = false;
    (gl as any).currentSentenceIndex = 0;

    // Path A: Spoken student input (sendAudioChunk sets hasStudentInputSinceLastResponse = true at line 1845),
    // followed by inputTranscription and a 0-audio text response from GL.
    // Pre-mark preTurnGroundingFired so this persistence test does not launch a background DB lookup.
    (gl as any).preTurnGroundingFired = true;
    gl.sendAudioChunk(Buffer.alloc(320));
    assert.equal((gl as any).hasStudentInputSinceLastResponse, true, "sendAudioChunk sets hasStudentInputSinceLastResponse");

    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: "Hola Daniela, ¿me escuchas?", finished: true },
        outputTranscription: { text: "Sí, te escucho perfectamente." },
      },
    });
    await (gl as any)._doFlushTranscripts();

    assert.equal(persisted.length, 2, "real 0-audio turn after sendAudioChunk must persist user + assistant rows");
    assert.equal(persisted[0]?.role, "user");
    assert.equal(persisted[0]?.content, "Hola Daniela, ¿me escuchas?");
    assert.equal(persisted[1]?.role, "assistant");
    assert.equal(persisted[1]?.content, "Sí, te escucho perfectamente.");
    assert.equal((gl as any).sessionExchangeLog.length, 1, "real 0-audio turn records exchange");
    // Wait a tick for setImmediate episode hook if applicable
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(episodeAppends.length, 1, "real 0-audio turn appends to rolling episode");
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      false,
      "real 0-audio flush must reset hasStudentInputSinceLastResponse so a subsequent phantom turn is suppressed",
    );

    // Path B: interrupt() sets hasStudentInputSinceLastResponse = true (line 1995).
    gl.interrupt();
    (gl as any).preTurnGroundingFired = true;
    assert.equal((gl as any).hasStudentInputSinceLastResponse, true, "interrupt() sets hasStudentInputSinceLastResponse");
    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: "Perdón, una pregunta rápida.", finished: true },
        outputTranscription: { text: "Claro, dime." },
      },
    });
    await (gl as any)._doFlushTranscripts();
    assert.equal(persisted.length, 4, "real 0-audio turn after interrupt() must persist user + assistant rows");
    assert.equal((gl as any).hasStudentInputSinceLastResponse, false);

    // Path C: sendTextTurn(..., { isStudentInput: true }) sets hasStudentInputSinceLastResponse = true (line 2426),
    // whereas directive sendTextTurn without isStudentInput leaves it false.
    gl.sendTextTurn("[SYSTEM directive]", { label: "heartbeat_directive" });
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      false,
      "non-student sendTextTurn must leave hasStudentInputSinceLastResponse false",
    );

    gl.sendTextTurn("*(the student examines the menu)*", { label: "prop-tap", isStudentInput: true });
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      true,
      "sendTextTurn({ isStudentInput: true }) sets hasStudentInputSinceLastResponse",
    );
    (gl as any). transcriptClosed = false;
    await (gl as any).handleServerMessage({
      serverContent: {
        outputTranscription: { text: "¿Qué te gustaría pedir del menú?" },
      },
    });
    await (gl as any)._doFlushTranscripts();
    assert.equal(persisted.length, 5, "real 0-audio turn after student sendTextTurn persists assistant response");
    assert.equal(persisted[4]?.role, "assistant");
    assert.equal(persisted[4]?.content, "¿Qué te gustaría pedir del menú?");
    assert.equal((gl as any).hasStudentInputSinceLastResponse, false);

    // Path D: Push-to-talk held-key chunks arriving (1) during the 800ms generationComplete seal
    // window before _doFlushTranscripts() runs, and (2) after _doFlushTranscripts() resets the flag.
    gl.sendAudioChunk(Buffer.alloc(320));
    (gl as any).preTurnGroundingFired = true;
    (gl as any).transcriptClosed = false;
    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: "Primera parte con PTT.", finished: true },
        outputTranscription: { text: "Entendido." },
        generationComplete: true,
      },
    });
    if ((gl as any).generationCompleteSealTimer) {
      clearTimeout((gl as any).generationCompleteSealTimer);
      (gl as any).generationCompleteSealTimer = null;
    }
    // Student holds PTT key during the 800ms seal window before _doFlushTranscripts() runs:
    gl.sendAudioChunk(Buffer.alloc(320));
    await (gl as any)._doFlushTranscripts();
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      true,
      "PTT chunk arriving after generationComplete and before _doFlushTranscripts() must keep hasStudentInputSinceLastResponse true",
    );

    // And if _doFlushTranscripts() resets hasStudentInputSinceLastResponse = false when no chunk
    // arrived during the seal window, a held PTT key's next 85ms chunk immediately sets it true again:
    (gl as any).preTurnGroundingFired = true;
    (gl as any).transcriptClosed = false;
    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: "Segunda parte con PTT.", finished: true },
        outputTranscription: { text: "Perfecto." },
        generationComplete: true,
      },
    });
    if ((gl as any).generationCompleteSealTimer) {
      clearTimeout((gl as any).generationCompleteSealTimer);
      (gl as any).generationCompleteSealTimer = null;
    }
    await (gl as any)._doFlushTranscripts();
    assert.equal((gl as any).hasStudentInputSinceLastResponse, false);
    // Next held-key chunk arrives after the flush reset (isTutorGeneratingAudio is false on 0-audio turns):
    gl.sendAudioChunk(Buffer.alloc(320));
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      true,
      "held PTT key chunk arriving after 0-audio flush reset immediately re-opens hasStudentInputSinceLastResponse",
    );
  } finally {
    cleanup();
  }
});

test("G3 late inputTranscription: real student transcription arriving after Daniela's first audio chunk still starts student turn and fires Guardian", async () => {
  const { gl, persisted, cleanup } = createHarness();
  try {
    (gl as any).greetingPhaseActive = false;
    (gl as any).isGreetingTurn = false;
    (gl as any).isTutorGeneratingAudio = false;
    (gl as any).hasStudentInputSinceLastResponse = false;
    (gl as any).startNewStudentTurnOnNextInputTranscription = true;
    const initialEpoch = (gl as any).activeStudentTurnEpoch;

    // 1. Student speaks short reply; audio chunk reaches GL before inputTranscription arrives.
    gl.sendAudioChunk(Buffer.alloc(320));
    assert.equal((gl as any).hasStudentInputSinceLastResponse, true);

    // 2. Daniela's first audio chunk arrives BEFORE the student's inputTranscription chunk.
    // Line 3001 sets hasStudentInputSinceLastResponse = false and isTutorGeneratingAudio = true.
    const pcmBase64 = Buffer.alloc(640).toString("base64");
    await (gl as any).handleServerMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcmBase64 } }],
        },
      },
    });
    assert.equal((gl as any).isTutorGeneratingAudio, true, "first audio chunk sets isTutorGeneratingAudio = true");
    assert.equal(
      (gl as any).hasStudentInputSinceLastResponse,
      false,
      "first audio chunk resets hasStudentInputSinceLastResponse = false at line 3001",
    );

    // 3. Now the student's lagging inputTranscription arrives while Daniela's audio is generating
    // (short emotional disclosure "I froze" = 7 chars, plus a second chunk pushing >10 chars).
    await (gl as any).handleServerMessage({
      serverContent: {
        inputTranscription: { text: "I froze when speaking", finished: true },
        outputTranscription: { text: "It is completely normal to freeze up at first." },
      },
    });

    assert.equal(
      (gl as any).activeStudentTurnEpoch,
      initialEpoch + 1,
      "late inputTranscription while isTutorGeneratingAudio is true must still start the student turn",
    );
    assert.equal(
      (gl as any).preTurnGroundingFired,
      true,
      "late inputTranscription while isTutorGeneratingAudio is true must still fire Pre-Turn Archive Guardian",
    );

    // 4. Flush the turn and verify both the late student transcript and assistant response persist.
    (gl as any).sealCurrentAudioSubturn("test-seal", false);
    await (gl as any)._doFlushTranscripts();
    assert.equal(persisted.length, 2, "late student transcript and assistant response must both persist");
    assert.equal(persisted[0]?.role, "user");
    assert.equal(persisted[0]?.content, "I froze when speaking");
    assert.equal(persisted[1]?.role, "assistant");
  } finally {
    cleanup();
  }
});
