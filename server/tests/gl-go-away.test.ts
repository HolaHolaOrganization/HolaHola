/**
 * Live test 2, G8: Gemini closed the session with 1008 because we received goAway and didn't
 * close, so a close could land mid-sentence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { isSafeToReconnect, parseGoAwayTimeLeftMs, watchGoAway, type GoAwayTurnState } from '../services/gl-go-away';

const idle: GoAwayTurnState = { tutorSpeaking: false, generationStarted: false, pendingToolCalls: 0, pendingStudentTranscript: '' };

function harness(initial: Partial<GoAwayTurnState> = {}) {
  const h = {
    state: { ...idle, ...initial },
    current: true,
    reconnects: 0,
    logs: [] as Array<{ outcome: string; timeLeftMs: number; waitedMs: number }>,
  };
  return {
    h,
    deps: {
      isCurrent: () => h.current,
      turnState: () => h.state,
      reconnect: () => { h.reconnects++; },
      log: (outcome: 'reconnected' | 'no_safe_moment', detail: { timeLeftMs: number; waitedMs: number }) => { h.logs.push({ outcome, ...detail }); },
    },
  };
}

describe('parseGoAwayTimeLeftMs', () => {
  it('reads the API duration format', () => {
    assert.equal(parseGoAwayTimeLeftMs('30s'), 30_000);
    assert.equal(parseGoAwayTimeLeftMs('1.5s'), 1_500);
  });
  it('falls back when the time is absent or unreadable', () => {
    assert.equal(parseGoAwayTimeLeftMs(undefined), 10_000);
    assert.equal(parseGoAwayTimeLeftMs('soon'), 10_000);
  });
});

describe('isSafeToReconnect', () => {
  it('is safe only between turns', () => {
    assert.equal(isSafeToReconnect(idle), true);
    assert.equal(isSafeToReconnect({ ...idle, tutorSpeaking: true }), false);
    assert.equal(isSafeToReconnect({ ...idle, generationStarted: true }), false);
    assert.equal(isSafeToReconnect({ ...idle, pendingToolCalls: 1 }), false);
    assert.equal(isSafeToReconnect({ ...idle, pendingStudentTranscript: 'hola' }), false);
    assert.equal(isSafeToReconnect({ ...idle, pendingStudentTranscript: '  ' }), true);
  });
});

describe('watchGoAway', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'Date'] }));
  afterEach(() => mock.timers.reset());

  it('reconnects at once when between turns', () => {
    const { h, deps } = harness();
    watchGoAway('30s', deps);
    assert.equal(h.reconnects, 1);
    assert.deepEqual(h.logs, [{ outcome: 'reconnected', timeLeftMs: 30_000, waitedMs: 0 }]);
    mock.timers.tick(5_000);
    assert.equal(h.reconnects, 1, 'only once');
  });

  it('waits out her speech, then reconnects', () => {
    const { h, deps } = harness({ tutorSpeaking: true });
    watchGoAway('30s', deps);
    mock.timers.tick(5_000);
    assert.equal(h.reconnects, 0, 'not while she is speaking');
    h.state.tutorSpeaking = false;
    mock.timers.tick(250);
    assert.equal(h.reconnects, 1);
    assert.equal(h.logs[0].waitedMs, 5_250);
  });

  it('waits for the student to finish a sentence', () => {
    const { h, deps } = harness({ pendingStudentTranscript: 'quiero decir' });
    watchGoAway('30s', deps);
    mock.timers.tick(1_000);
    assert.equal(h.reconnects, 0);
    h.state.pendingStudentTranscript = '';
    mock.timers.tick(250);
    assert.equal(h.reconnects, 1);
  });

  it('gives up before the deadline and leaves the abort to the retry path', () => {
    const { h, deps } = harness({ tutorSpeaking: true });
    watchGoAway('10s', deps);
    mock.timers.tick(8_000);
    assert.deepEqual(h.logs.map(l => l.outcome), ['no_safe_moment']);
    h.state.tutorSpeaking = false;
    mock.timers.tick(5_000);
    assert.equal(h.reconnects, 0, 'never closes after giving up');
  });

  it('does nothing once the session is no longer current', () => {
    const { h, deps } = harness({ tutorSpeaking: true });
    watchGoAway('30s', deps);
    h.current = false;
    h.state.tutorSpeaking = false;
    mock.timers.tick(250);
    assert.equal(h.reconnects, 0);
    assert.deepEqual(h.logs, []);
  });

  it('stops when told to', () => {
    const { h, deps } = harness({ tutorSpeaking: true });
    const stop = watchGoAway('30s', deps);
    stop();
    h.state.tutorSpeaking = false;
    mock.timers.tick(1_000);
    assert.equal(h.reconnects, 0);
  });
});

describe('session wiring', () => {
  const source = readFileSync(new URL('../services/gemini-live-session.ts', import.meta.url), 'utf8');

  it('acts on goAway rather than only recording it', () => {
    const at = source.indexOf('(msg as any).goAway != null');
    assert.ok(at > 0);
    assert.match(source.slice(at, at + 200), /this\.handleGoAway\(/);
  });

  it('stops watching as soon as the connection closes', () => {
    const at = source.indexOf('onclose: async (event: any) => {');
    assert.ok(at > 0);
    assert.match(source.slice(at, at + 120), /this\.stopGoAwayWatch\?\.\(\)/);
  });

  it('reconnects through the path onclose treats as deliberate', () => {
    const at = source.indexOf('private closeForReconnect(): void');
    assert.ok(at > 0);
    assert.match(source.slice(at, at + 200), /this\.isProactiveReconnecting = true/);
  });

  it('a deliberate close gets the same resets and context bridge as an unexpected one', () => {
    const at = source.indexOf('const deliberateClose = ');
    assert.ok(at > 0);
    const end = source.indexOf('private ', at);
    const path = source.slice(at, end);
    assert.match(path, /if \(deliberateClose \|\| \(/);
    const resets = path.indexOf('this.isSetupComplete = false');
    const bridge = path.indexOf('this.buildContextBridge()');
    assert.ok(resets > 0, 'resets setup state, so setupComplete runs on the new connection');
    assert.ok(path.includes('this.transcriptClosed = false'), 'reopens the transcript gate');
    assert.ok(bridge > resets, 'starts with the bridge after resetting');
    assert.doesNotMatch(source, /await this\.start\(this\.lastSystemPrompt, this\.lastTools\)/, 'no thinner path remains');
  });
});
