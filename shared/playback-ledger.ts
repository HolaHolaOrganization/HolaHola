/**
 * What the student's player did with Daniela's audio (F1–F2, live-test-1 debrief;
 * design note 135fe51b rev 2). The client folds Web Audio scheduling into one summary
 * per turn; the server compares it with what it sent and names what it can show.
 *
 * Verdicts describe what the player reported, never what reached the speakers:
 * a scheduled-and-ended chunk proves the Web Audio clock ran through it, nothing more.
 * Missing reports make a turn `unknown`, never "unheard".
 */

export const PLAYBACK_THRESHOLDS = {
  version: 'pb-1-provisional',
  /** Silence between consecutive chunks of one turn that counts as a stall. */
  stalledGapMs: 1500,
  /** How long after a turn's last audio the client waits before finalizing it. */
  finalizeGraceMs: 5000,
} as const;

export type PlaybackDropReason = 'index_dedup' | 'content_hash_dedup' | 'no_player';

export interface PlaybackTurnSummary {
  turnId: number;
  /** One id per player turn; a second id for the same turn means the turn played twice. */
  instanceId: string;
  scheduledChunks: number;
  /** Chunks the AudioContext clock ran all the way through. */
  endedChunks: number;
  /** Chunks stopped before their scheduled end (barge-in, reset, teardown). */
  stoppedChunks: number;
  /** The same (sentence, chunk) scheduled again within this turn. */
  rescheduledChunks: number;
  dropped: Partial<Record<PlaybackDropReason, number>>;
  /** Largest silence between one chunk's scheduled end and the next chunk's start (AudioContext clock). */
  maxGapMs: number;
  /** AudioContext states seen while scheduling (e.g. 'running', 'suspended'). */
  audioContextStates: string[];
  hiddenDuringTurn: boolean;
  finalizedBy: 'next_turn' | 'grace' | 'session_end';
}

export type PlaybackFlag =
  | 'no_playback_reported'
  | 'partial_playback'
  | 'stalled'
  | 'replayed_playback'
  | 'interrupted_by_barge_in'
  | 'unknown';

export interface SentTurn { chunks: number; bargeIn: boolean }

export interface PlaybackVerdict {
  flags: PlaybackFlag[];
  thresholdVersion: string;
  evidence: {
    sentChunks: number | null;
    scheduledChunks: number;
    endedChunks: number;
    stoppedChunks: number;
    droppedChunks: number;
    maxGapMs: number;
    instances: number;
    audioContextStates: string[];
    hiddenDuringTurn: boolean;
  };
}

/** Overlapping flags, each backed by the evidence returned alongside it. */
export function playbackVerdict(sent: SentTurn | null, summaries: PlaybackTurnSummary[]): PlaybackVerdict {
  const sum = (pick: (s: PlaybackTurnSummary) => number) => summaries.reduce((n, s) => n + pick(s), 0);
  const scheduled = sum(s => s.scheduledChunks);
  const ended = sum(s => s.endedChunks);
  const stopped = sum(s => s.stoppedChunks);
  const dropped = sum(s => Object.values(s.dropped).reduce((a, b) => a + (b ?? 0), 0));
  const maxGapMs = summaries.reduce((m, s) => Math.max(m, s.maxGapMs), 0);
  const instances = new Set(summaries.map(s => s.instanceId)).size;
  const flags: PlaybackFlag[] = [];
  if (summaries.length === 0) {
    if (sent && sent.chunks > 0) flags.push('unknown');
  } else {
    const nothingPlayed = sent !== null && sent.chunks > 0 && ended === 0;
    const short = ended < scheduled || (sent !== null && scheduled + dropped < sent.chunks);
    if (sent?.bargeIn) {
      if (short || nothingPlayed) flags.push('interrupted_by_barge_in');
    } else if (nothingPlayed) {
      flags.push('no_playback_reported');
    } else if (short) {
      flags.push('partial_playback');
    }
    if (maxGapMs > PLAYBACK_THRESHOLDS.stalledGapMs) flags.push('stalled');
    if (instances > 1 || summaries.some(s => s.rescheduledChunks > 0)) flags.push('replayed_playback');
  }
  if (sent?.bargeIn && !flags.includes('interrupted_by_barge_in')) flags.push('interrupted_by_barge_in');
  return {
    flags,
    thresholdVersion: PLAYBACK_THRESHOLDS.version,
    evidence: {
      sentChunks: sent ? sent.chunks : null,
      scheduledChunks: scheduled,
      endedChunks: ended,
      stoppedChunks: stopped,
      droppedChunks: dropped,
      maxGapMs,
      instances,
      audioContextStates: [...new Set(summaries.flatMap(s => s.audioContextStates))],
      hiddenDuringTurn: summaries.some(s => s.hiddenDuringTurn),
    },
  };
}

const finite = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);

/** Server-side guard: telemetry is untrusted input. Returns null for anything malformed. */
export function sanitizePlaybackSummary(raw: unknown): PlaybackTurnSummary | null {
  const s = raw as Partial<PlaybackTurnSummary> | null;
  if (!s || typeof s !== 'object') return null;
  if (!Number.isSafeInteger(s.turnId) || (s.turnId as number) < 0) return null;
  if (typeof s.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.instanceId)) return null;
  const dropped: PlaybackTurnSummary['dropped'] = {};
  for (const reason of ['index_dedup', 'content_hash_dedup', 'no_player'] as const) {
    const n = finite((s.dropped as Record<string, unknown> | undefined)?.[reason], 100_000);
    if (n) dropped[reason] = n;
  }
  return {
    turnId: s.turnId as number,
    instanceId: s.instanceId,
    scheduledChunks: finite(s.scheduledChunks, 100_000),
    endedChunks: finite(s.endedChunks, 100_000),
    stoppedChunks: finite(s.stoppedChunks, 100_000),
    rescheduledChunks: finite(s.rescheduledChunks, 100_000),
    dropped,
    maxGapMs: finite(s.maxGapMs, 3_600_000),
    audioContextStates: Array.isArray(s.audioContextStates)
      ? [...new Set(s.audioContextStates.filter((x): x is string => typeof x === 'string' && /^[a-z]{1,20}$/.test(x)))].slice(0, 5)
      : [],
    hiddenDuringTurn: s.hiddenDuringTurn === true,
    finalizedBy: s.finalizedBy === 'next_turn' || s.finalizedBy === 'session_end' ? s.finalizedBy : 'grace',
  };
}

interface OpenTurn {
  summary: PlaybackTurnSummary;
  seen: Set<string>;
  lastEndCtxSec: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Client side: one open summary per turn, sent once when the turn is finalized. */
export class ClientPlaybackLedger {
  private open = new Map<number, OpenTurn>();
  /** Turns already sent; late events for them are counted, never reopened (a reopen would look like a replay). */
  private finalized = new Set<number>();
  private currentTurnId: number | null = null;
  /** Events that arrived for a turn after it was finalized. */
  lateEvents = 0;

  constructor(
    private readonly send: (summary: PlaybackTurnSummary) => void,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2, 12),
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  private turn(turnId: number): OpenTurn | null {
    if (this.finalized.has(turnId)) { this.lateEvents++; return null; }
    let t = this.open.get(turnId);
    if (!t) {
      // A newer turn closes every older one still open; a late chunk of an older
      // turn never closes a newer one.
      for (const id of [...this.open.keys()]) if (id < turnId) this.finalize(id, 'next_turn');
      t = {
        summary: {
          turnId, instanceId: this.newId(), scheduledChunks: 0, endedChunks: 0, stoppedChunks: 0, rescheduledChunks: 0,
          dropped: {}, maxGapMs: 0, audioContextStates: [], hiddenDuringTurn: false, finalizedBy: 'grace',
        },
        seen: new Set(), lastEndCtxSec: null, timer: null,
      };
      this.open.set(turnId, t);
    }
    if (this.currentTurnId === null || turnId >= this.currentTurnId) this.currentTurnId = turnId;
    return t;
  }

  scheduled(turnId: number, sentenceIndex: number, chunkIndex: number, startCtxSec: number, durationSec: number,
    audioContextState: string, hidden: boolean): void {
    const t = this.turn(turnId);
    if (!t) return;
    const key = `${sentenceIndex}:${chunkIndex}`;
    if (t.seen.has(key)) t.summary.rescheduledChunks++;
    t.seen.add(key);
    t.summary.scheduledChunks++;
    if (t.lastEndCtxSec !== null) {
      t.summary.maxGapMs = Math.max(t.summary.maxGapMs, Math.round((startCtxSec - t.lastEndCtxSec) * 1000));
    }
    t.lastEndCtxSec = Math.max(t.lastEndCtxSec ?? 0, startCtxSec + durationSec);
    if (!t.summary.audioContextStates.includes(audioContextState)) t.summary.audioContextStates.push(audioContextState);
    if (hidden) t.summary.hiddenDuringTurn = true;
    this.armGrace(turnId, t);
  }

  /** completed: the clock reached the chunk's scheduled end; false when it was stopped early. */
  ended(turnId: number, completed = true): void {
    const t = this.open.get(turnId);
    if (!t) { if (this.finalized.has(turnId)) this.lateEvents++; return; }
    if (completed) t.summary.endedChunks++; else t.summary.stoppedChunks++;
    this.armGrace(turnId, t);
  }

  /** A chunk the client threw away. Without a turn id it counts against the current turn. */
  dropped(turnId: number | null | undefined, reason: PlaybackDropReason): void {
    const id = turnId ?? this.currentTurnId;
    if (id === null || id === undefined) return;
    const t = this.turn(id);
    if (!t) return;
    t.summary.dropped[reason] = (t.summary.dropped[reason] ?? 0) + 1;
    this.armGrace(id, t);
  }

  private armGrace(turnId: number, t: OpenTurn): void {
    if (t.timer) this.timers.clear(t.timer);
    t.timer = this.timers.set(() => this.finalize(turnId, 'grace'), PLAYBACK_THRESHOLDS.finalizeGraceMs);
  }

  finalize(turnId: number, by: PlaybackTurnSummary['finalizedBy']): void {
    const t = this.open.get(turnId);
    if (!t) return;
    if (t.timer) this.timers.clear(t.timer);
    this.open.delete(turnId);
    this.finalized.add(turnId);
    if (this.finalized.size > 200) this.finalized.delete(this.finalized.values().next().value!);
    this.send({ ...t.summary, finalizedBy: by });
  }

  finalizeAll(by: PlaybackTurnSummary['finalizedBy'] = 'session_end'): void {
    for (const id of [...this.open.keys()]) this.finalize(id, by);
  }
}
