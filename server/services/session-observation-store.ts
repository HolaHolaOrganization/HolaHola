import type { GuardianAttemptTrace } from './guardian-attempt-trace';
import {
  getContextLineageAvailability,
  isContextLineageCaptureEnabled,
  type ContextLineageAvailability,
} from './context-lineage-service';

const EXPIRY_MS = 4 * 60 * 60 * 1000;

export interface ToolCallRecord {
  name: string;
  ts: number;
  note?: string;
  /** The call's arguments as JSON, clipped to OBSERVED_PAYLOAD_CHARS. */
  args?: string;
}

/** What went back to Gemini Live for one function call, clipped to OBSERVED_PAYLOAD_CHARS. */
export interface ToolResultRecord {
  name: string;
  ts: number;
  callId: string | null;
  response: string;
}

/** An image Daniela put on the student's screen (whiteboard, scene, vocabulary card, ...). */
export interface ShownVisualRecord {
  ts: number;
  /** The client message type that carried it, e.g. 'whiteboard_update'. */
  messageType: string;
  imageUrl: string;
  label: string | null;
}

/**
 * The newest frame of what Daniela is shown through the student's webcam or
 * screen share. Held in memory only, for the live session: never written to
 * the database, and dropped when the session ends.
 */
export interface VisionFrame {
  source: 'webcam' | 'screen';
  ts: number;
  base64Jpeg: string;
}

/** Bound on each observed payload, so one large tool result cannot bloat the snapshot. */
export const OBSERVED_PAYLOAD_CHARS = 4000;

function clipJson(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > OBSERVED_PAYLOAD_CHARS
    ? `${text.slice(0, OBSERVED_PAYLOAD_CHARS)}… [clipped, ${text.length} chars]`
    : text;
}

export interface GuardianFireRecord {
  ts: string;
  path: 'pre-turn' | 'post-turn-phrase' | 'friction-signal' | 'hard-wall' | 'carry-forward-buffered' | 'carry-forward-injected';
  phrase: string;
  charsInjected: number | null;
  channel: 'concat' | 'dedicated' | 'pre-turn-sendclientcontent' | null;
  outcome: 'heard' | 'missed' | null;
  groundingPreview: string | null;
  /** Optional link to the evidence-chain attempt; legacy rows may omit it. */
  attemptId?: string;
}

export interface MemorySearchRecord {
  ts: number;
  query: string;
  tool: string;               // 'memory_lookup' | 'search_my_teaching_wisdom' | 'recall' etc.
  resultCount: number;
  durationMs: number;
  domainsSearched: string[];
  formattedChars: number;
}

export interface TurnSummary {
  /** sessionStudentTurnCount at the time the turn completed */
  turn: number;
  /** All tool names called during this turn */
  tools: string[];
  /** Did any tool belong to the Archive set (recall, grounding_query, etc.)? */
  hasArchiveCall: boolean;
  ts: number;
}

export interface FrictionRecord {
  /** sessionStudentTurnCount when friction was measured */
  turn: number;
  /** 'CLEAN' | 'LOW' | 'MODERATE' | 'HIGH' */
  label: string;
  totalScore: number;
  archiveAccess: boolean;
  /** Inverted-threshold: Guardian-primed turn came back smooth → slide ran unimpeded */
  smoothSlide: boolean;
  unverifiedAssertionCount: number;
  /** Preview of the first unverified assertion phrase, if any */
  firstUnverifiedAssertion: string | null;
  ts: number;
}

/**
 * Deliberately bounded, payload-free projection of the immutable context
 * ledger. The canonical source remains context_lineage_events; this exists so
 * the Observation Bench can show a currently active trace without waiting for
 * a forensic database query.
 */
export interface ContextLineageObservationEvent {
  id: string;
  traceId: string;
  sequenceNumber: number;
  sourceRoute: string;
  eventType: string;
  deliveryChannel: string | null;
  deliveryStatus: string;
  studentTurnEpoch: number | null;
  payloadSha256: string | null;
  observedAt: string;
}

export interface ContextLineageObservationLink {
  id: string;
  traceId: string;
  fromEventId: string;
  toEventId: string;
  linkType: string;
  observedAt: string;
}

export interface ContextLineageObservationHealth {
  state: "healthy" | "degraded";
  pendingWrites: number;
  failedWrites: number;
  firstUnrecordedSequenceNumber: number | null;
  lastError: string | null;
}

export interface ContextLineageObservation {
  activeTraceId: string | null;
  events: ContextLineageObservationEvent[];
  links: ContextLineageObservationLink[];
  health: ContextLineageObservationHealth;
}

/**
 * Compute availability at read time so a config change cannot leave a stale
 * "healthy" default that looks like evidence was captured.
 */
export function getContextLineageObservationAvailability(
  lineage: ContextLineageObservation | undefined,
): ContextLineageAvailability {
  return getContextLineageAvailability({
    captureEnabled: isContextLineageCaptureEnabled(),
    eventCount: lineage?.events?.length ?? 0,
    linkCount: lineage?.links?.length ?? 0,
    persistenceState: lineage?.health?.state ?? "healthy",
  });
}

export interface SessionObservation {
  conversationId: string;
  /** Exact persistent voice_sessions UUID for this live observation. */
  dbSessionId: string | null;
  /** Provider/runtime session ID used by very-early pipeline events. */
  transientSessionId: string | null;
  userId: string;
  language: string | null;
  actflLevel: string | null;
  exchangeCount: number;
  scenarioSlug: string | null;
  sceneEnvironment: string | null;
  sceneImageUrl: string | null;
  sceneProps: string[];
  recentToolCalls: ToolCallRecord[];
  /** Function responses sent back to Gemini Live (last 20). */
  recentToolResults: ToolResultRecord[];
  /** Images Daniela showed the student (last 20). */
  shownVisuals: ShownVisualRecord[];
  /** When each vision source last delivered a frame; the frames themselves are held apart from the snapshot. */
  visionSources: { source: 'webcam' | 'screen'; lastFrameMs: number; frames: number }[];
  /** The Gemini Live model this session connected with. */
  model: string | null;
  /** The newest usageMetadata Gemini Live reported (token counts). */
  latestUsage: Record<string, unknown> | null;
  lastUpdatedMs: number;
  sessionStartedMs: number;
  // Archive Guardian A/B state
  guardianChannel: 'concat' | 'dedicated';
  guardianFireLog: GuardianFireRecord[];
  /** Append-only evidence chain for Guardian attempts, newest attempt last. */
  guardianAttempts: GuardianAttemptTrace[];
  // Neural net memory searches (last 20)
  recentMemorySearches: MemorySearchRecord[];
  // Per-turn tool-call summaries (last 15 turns)
  turnSummaries: TurnSummary[];
  // Friction history from analyzeFriction (last 20 records)
  frictionHistory: FrictionRecord[];
  // Live projection of immutable context lineage. Payloads stay in the durable
  // ledger and are fetched separately for authorized raw inspection.
  contextLineage: ContextLineageObservation;
}

const store = new Map<string, SessionObservation>();
/** Latest frame per source, per conversation. Kept out of SessionObservation so a snapshot never carries image bytes. */
const visionFrames = new Map<string, Partial<Record<VisionFrame['source'], VisionFrame>> & { latest?: VisionFrame['source'] }>();

function touch(conversationId: string): SessionObservation | undefined {
  return store.get(conversationId);
}

function now(): number {
  return Date.now();
}

export function observeSessionStart(opts: {
  conversationId: string;
  dbSessionId?: string | null;
  transientSessionId?: string | null;
  userId: string;
  language: string | null;
  actflLevel: string | null;
}): void {
  const existing = store.get(opts.conversationId);
  const sameSession = Boolean(
    existing
    && existing.dbSessionId === (opts.dbSessionId ?? null)
    && existing.transientSessionId === (opts.transientSessionId ?? null),
  );
  store.set(opts.conversationId, {
    conversationId: opts.conversationId,
    dbSessionId: opts.dbSessionId ?? null,
    transientSessionId: opts.transientSessionId ?? null,
    userId: opts.userId,
    language: opts.language,
    actflLevel: opts.actflLevel,
    exchangeCount: sameSession ? existing?.exchangeCount ?? 0 : 0,
    scenarioSlug: sameSession ? existing?.scenarioSlug ?? null : null,
    sceneEnvironment: sameSession ? existing?.sceneEnvironment ?? null : null,
    sceneImageUrl: sameSession ? existing?.sceneImageUrl ?? null : null,
    sceneProps: sameSession ? existing?.sceneProps ?? [] : [],
    recentToolCalls: sameSession ? existing?.recentToolCalls ?? [] : [],
    recentToolResults: sameSession ? existing?.recentToolResults ?? [] : [],
    shownVisuals: sameSession ? existing?.shownVisuals ?? [] : [],
    visionSources: sameSession ? existing?.visionSources ?? [] : [],
    model: sameSession ? existing?.model ?? null : null,
    latestUsage: sameSession ? existing?.latestUsage ?? null : null,
    lastUpdatedMs: now(),
    sessionStartedMs: sameSession ? existing?.sessionStartedMs ?? now() : now(),
    guardianChannel: sameSession ? existing?.guardianChannel ?? 'concat' : 'concat',
    guardianFireLog: sameSession ? existing?.guardianFireLog ?? [] : [],
    guardianAttempts: sameSession ? existing?.guardianAttempts ?? [] : [],
    recentMemorySearches: sameSession ? existing?.recentMemorySearches ?? [] : [],
    turnSummaries: sameSession ? existing?.turnSummaries ?? [] : [],
    frictionHistory: sameSession ? existing?.frictionHistory ?? [] : [],
    contextLineage: sameSession ? existing?.contextLineage ?? {
      activeTraceId: null,
      events: [],
      links: [],
      health: {
        state: "healthy",
        pendingWrites: 0,
        failedWrites: 0,
        firstUnrecordedSequenceNumber: null,
        lastError: null,
      },
    } : {
      activeTraceId: null,
      events: [],
      links: [],
      health: {
        state: "healthy",
        pendingWrites: 0,
        failedWrites: 0,
        firstUnrecordedSequenceNumber: null,
        lastError: null,
      },
    },
  });
  if (!sameSession) visionFrames.delete(opts.conversationId);
}

export function observeActflUpdate(conversationId: string, level: string | null): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.actflLevel = level;
  entry.lastUpdatedMs = now();
}

export function observeExchangeCount(conversationId: string, count: number): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.exchangeCount = count;
  entry.lastUpdatedMs = now();
}

export function observeToolCall(conversationId: string, toolName: string, note?: string, args?: unknown): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.recentToolCalls = [
    { name: toolName, ts: now(), note, ...(args === undefined ? {} : { args: clipJson(args) }) },
    ...entry.recentToolCalls,
  ].slice(0, 15);
  entry.lastUpdatedMs = now();
}

/** Record the function responses one sendToolResponse carried back to Gemini Live. */
export function observeToolResults(
  conversationId: string | undefined,
  responses: readonly { id?: string; name?: string; response?: unknown }[],
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry || responses.length === 0) return;
  const ts = now();
  const records = responses.map((r): ToolResultRecord => ({
    name: r.name ?? 'unknown', ts, callId: r.id ?? null, response: clipJson(r.response ?? null),
  }));
  entry.recentToolResults = [...records.reverse(), ...entry.recentToolResults].slice(0, 20);
  entry.lastUpdatedMs = ts;
}

const IMAGE_URL_KEYS = new Set(['imageUrl', 'environmentImageUrl', 'propImageUrl', 'image_url']);
const LABEL_KEYS = ['word', 'label', 'environmentLabel', 'title', 'description', 'content'];

/**
 * Record every image URL in a message sent to the student's client, so the hats
 * see what Daniela put on screen. The message is only read, never changed.
 */
export function observeOutboundVisuals(conversationId: string | undefined, message: unknown): void {
  if (!conversationId || !message || typeof message !== 'object') return;
  const entry = touch(conversationId);
  if (!entry) return;
  const messageType = String((message as Record<string, unknown>).type ?? 'unknown');
  const found: ShownVisualRecord[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6 || found.length >= 10) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (IMAGE_URL_KEYS.has(key) && typeof value === 'string' && value && !seen.has(value)) {
        seen.add(value);
        const labelKey = LABEL_KEYS.find((k) => typeof record[k] === 'string' && record[k]);
        found.push({ ts: now(), messageType, imageUrl: value, label: labelKey ? String(record[labelKey]).slice(0, 200) : null });
      } else if (value && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(message, 0);
  if (found.length === 0) return;
  // A full-scene update repeats every image already on screen; record only what is new.
  const known = new Set(entry.shownVisuals.map((v) => v.imageUrl));
  const fresh = found.filter((v) => !known.has(v.imageUrl));
  if (fresh.length === 0) return;
  entry.shownVisuals = [...fresh.reverse(), ...entry.shownVisuals].slice(0, 20);
  entry.lastUpdatedMs = now();
}

/** Keep the newest webcam or screen-share frame Daniela was sent (memory only). */
export function observeVisionFrame(conversationId: string | undefined, source: VisionFrame['source'], base64Jpeg: string): void {
  if (!conversationId || !base64Jpeg) return;
  const entry = touch(conversationId);
  if (!entry) return;
  const ts = now();
  const frames = visionFrames.get(conversationId) ?? {};
  frames[source] = { source, ts, base64Jpeg };
  frames.latest = source;
  visionFrames.set(conversationId, frames);
  const prior = entry.visionSources.find((v) => v.source === source);
  entry.visionSources = [
    { source, lastFrameMs: ts, frames: (prior?.frames ?? 0) + 1 },
    ...entry.visionSources.filter((v) => v.source !== source),
  ];
  entry.lastUpdatedMs = ts;
}

/** The newest frame for a source, or for whichever source sent last. */
export function getVisionFrame(conversationId: string, source?: VisionFrame['source']): VisionFrame | null {
  if (!getObservation(conversationId)) return null;
  const frames = visionFrames.get(conversationId);
  if (!frames) return null;
  const pick = source ?? frames.latest;
  return pick ? frames[pick] ?? null : null;
}

export function observeModelAndUsage(
  conversationId: string | undefined,
  update: { model?: string | null; usage?: Record<string, unknown> | null },
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry) return;
  if (update.model !== undefined) entry.model = update.model;
  if (update.usage !== undefined) entry.latestUsage = update.usage;
  entry.lastUpdatedMs = now();
}

export function observeSceneOpen(conversationId: string, environment: string, imageUrl?: string): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.sceneEnvironment = environment;
  entry.sceneImageUrl = imageUrl ?? null;
  entry.sceneProps = [];
  entry.scenarioSlug = null;
  entry.lastUpdatedMs = now();
}

export function observeScenePropChange(conversationId: string, props: string[]): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.sceneProps = props;
  entry.lastUpdatedMs = now();
}

export function observeScenarioLoad(conversationId: string, slug: string): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.scenarioSlug = slug;
  entry.sceneEnvironment = null;
  entry.sceneProps = [];
  entry.lastUpdatedMs = now();
}

/**
 * Record a neural-net memory or teaching-knowledge search into the observation
 * store so it surfaces in real-time at GET /api/admin/luca/observe.
 * Called from native-fc-handlers whenever searchTeachingKnowledge completes.
 */
export function observeMemorySearch(
  conversationId: string | undefined,
  record: Omit<MemorySearchRecord, 'ts'>,
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry) return;
  entry.recentMemorySearches = [
    { ...record, ts: now() },
    ...entry.recentMemorySearches,
  ].slice(0, 20);
  entry.lastUpdatedMs = now();
}

/**
 * Push the latest Archive Guardian state into the observation store.
 * Called after every guardianFireLog mutation in GeminiLiveSession.
 * The observe endpoint will surface this so Luca can watch fires in real-time.
 */
export function observeGuardianState(
  conversationId: string,
  channel: 'concat' | 'dedicated',
  fireLog: GuardianFireRecord[],
  attempts: GuardianAttemptTrace[] = [],
): void {
  const entry = touch(conversationId);
  if (!entry) return;
  entry.guardianChannel = channel;
  entry.guardianFireLog = [...fireLog];
  entry.guardianAttempts = attempts.map(attempt => ({
    ...attempt,
    events: [...attempt.events],
  }));
  entry.lastUpdatedMs = now();
}

/**
 * Record a completed Daniela turn — which tools were called and whether any
 * were Archive-class. Called from GeminiLiveSession right before resetting
 * currentTurnToolCalls at generationComplete.
 */
export function observeTurnComplete(
  conversationId: string,
  turn: number,
  tools: string[],
  hasArchiveCall: boolean,
): void {
  const entry = touch(conversationId);
  if (!entry) return;
  const summary: TurnSummary = { turn, tools: [...tools], hasArchiveCall, ts: now() };
  entry.turnSummaries = [summary, ...entry.turnSummaries].slice(0, 15);
  entry.lastUpdatedMs = now();
}

/**
 * Record the friction score computed by analyzeFriction() for the current turn.
 * Called from GeminiLiveSession after analyzeFriction + smoothSlide are computed.
 */
export function observeFrictionScore(
  conversationId: string,
  turn: number,
  label: string,
  score: number,
  archiveAccess: boolean,
  smoothSlide: boolean,
  unverifiedAssertions: string[],
): void {
  const entry = touch(conversationId);
  if (!entry) return;
  const record: FrictionRecord = {
    turn,
    label,
    totalScore: score,
    archiveAccess,
    smoothSlide,
    unverifiedAssertionCount: unverifiedAssertions.length,
    firstUnverifiedAssertion: unverifiedAssertions[0] ?? null,
    ts: now(),
  };
  entry.frictionHistory = [record, ...entry.frictionHistory].slice(0, 20);
  entry.lastUpdatedMs = now();
}

export function observeContextLineageEvent(
  conversationId: string | undefined,
  event: ContextLineageObservationEvent,
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry) return;
  entry.contextLineage.activeTraceId = event.traceId;
  entry.contextLineage.events = [
    ...entry.contextLineage.events,
    event,
  ].slice(-100);
  entry.lastUpdatedMs = now();
}

export function observeContextLineageLink(
  conversationId: string | undefined,
  link: ContextLineageObservationLink,
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry) return;
  entry.contextLineage.links = [
    ...entry.contextLineage.links,
    link,
  ].slice(-150);
  entry.lastUpdatedMs = now();
}

export function observeContextLineageHealth(
  conversationId: string | undefined,
  health: ContextLineageObservationHealth,
): void {
  if (!conversationId) return;
  const entry = touch(conversationId);
  if (!entry) return;
  entry.contextLineage.health = { ...health };
  entry.lastUpdatedMs = now();
}

export function observeSessionEnd(
  conversationId: string,
  options?: { preserveDegradedLineage?: boolean },
): void {
  if (options?.preserveDegradedLineage) {
    const entry = store.get(conversationId);
    if (entry) {
      // An open recorder retry is the only live evidence that a trailing
      // canonical write may be missing. Retain this bounded projection until
      // its normal expiry rather than deleting the partial-evidence signal.
      entry.lastUpdatedMs = now();
      visionFrames.delete(conversationId);
      return;
    }
  }
  store.delete(conversationId);
  visionFrames.delete(conversationId);
}

export function getObservation(conversationId: string): SessionObservation | null {
  const entry = store.get(conversationId);
  if (!entry) return null;
  if (now() - entry.lastUpdatedMs > EXPIRY_MS) {
    store.delete(conversationId);
    visionFrames.delete(conversationId);
    return null;
  }
  return entry;
}

export function getAllActiveObservations(): SessionObservation[] {
  const cutoff = now() - EXPIRY_MS;
  const active: SessionObservation[] = [];
  for (const [id, entry] of store.entries()) {
    if (entry.lastUpdatedMs < cutoff) {
      store.delete(id);
      visionFrames.delete(id);
    } else {
      active.push(entry);
    }
  }
  return active;
}
