/**
 * Gemini sends goAway ahead of ending a session at its time limit. If we don't close and
 * reconnect ourselves, it aborts the connection (1008) whenever the time runs out, which can land
 * mid-sentence. This waits for a moment between turns and reconnects first. Live test 2, G8.
 */

/** Used when goAway gives no usable time. Short, so a wrong guess only means reconnecting sooner. */
const DEFAULT_TIME_LEFT_MS = 10_000;

/** Stop waiting this long before the deadline: past that, a close might race Gemini's own abort. */
const DEADLINE_MARGIN_MS = 2_000;

const CHECK_EVERY_MS = 250;

/** The API gives a duration string such as "30s" or "1.5s". */
export function parseGoAwayTimeLeftMs(timeLeft: unknown): number {
  if (typeof timeLeft !== 'string') return DEFAULT_TIME_LEFT_MS;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(timeLeft.trim());
  return match ? Math.round(Number(match[1]) * 1000) : DEFAULT_TIME_LEFT_MS;
}

export interface GoAwayTurnState {
  tutorSpeaking: boolean;
  generationStarted: boolean;
  pendingToolCalls: number;
  pendingStudentTranscript: string;
}

/** Between turns: she isn't speaking or generating, no tool is running, and the student isn't mid-sentence. */
export function isSafeToReconnect(state: GoAwayTurnState): boolean {
  return !state.tutorSpeaking
    && !state.generationStarted
    && state.pendingToolCalls === 0
    && state.pendingStudentTranscript.trim() === '';
}

export interface GoAwayWatchDeps {
  /** False once the session has stopped, closed, or begun another reconnect. */
  isCurrent(): boolean;
  turnState(): GoAwayTurnState;
  reconnect(): void;
  log(outcome: 'reconnected' | 'no_safe_moment', detail: { timeLeftMs: number; waitedMs: number }): void;
}

/**
 * Reconnect at the first moment between turns. If none comes before the deadline, do nothing: the
 * abort then reaches the normal retry path. Returns a function that stops watching.
 */
export function watchGoAway(timeLeft: unknown, deps: GoAwayWatchDeps): () => void {
  const timeLeftMs = parseGoAwayTimeLeftMs(timeLeft);
  const receivedAt = Date.now();
  const deadline = receivedAt + Math.max(timeLeftMs - DEADLINE_MARGIN_MS, 0);
  let timer: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  const stop = () => {
    finished = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const check = () => {
    if (finished) return;
    if (!deps.isCurrent()) {
      stop();
    } else if (isSafeToReconnect(deps.turnState())) {
      stop();
      deps.log('reconnected', { timeLeftMs, waitedMs: Date.now() - receivedAt });
      deps.reconnect();
    } else if (Date.now() >= deadline) {
      stop();
      deps.log('no_safe_moment', { timeLeftMs, waitedMs: Date.now() - receivedAt });
    }
  };
  check();
  if (!finished) timer = setInterval(check, CHECK_EVERY_MS);
  return stop;
}
