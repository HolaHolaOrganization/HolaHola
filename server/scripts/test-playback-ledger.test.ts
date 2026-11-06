/**
 * Playback ledger (F1–F2, design note 135fe51b rev 2): the client's per-turn summary,
 * the verdict rules, the server's sent ledger, and the wiring that connects them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import {
  ClientPlaybackLedger,
  playbackVerdict,
  sanitizePlaybackSummary,
  type PlaybackTurnSummary,
} from '@shared/playback-ledger';
import {
  getPlaybackObservation,
  observeAudioSent,
  observeBargeIn,
  observePlaybackSummary,
  resetPlaybackObservationForTests,
} from '../services/playback-observation';

function harness() {
  const sent: PlaybackTurnSummary[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  let id = 0;
  const ledger = new ClientPlaybackLedger(s => sent.push(s), () => `inst${++id}`, {
    set: ((fn: () => void) => { const h = next++; timers.set(h, fn); return h; }) as any,
    clear: ((h: number) => { timers.delete(h); }) as any,
  });
  const fireAll = () => { for (const [h, fn] of [...timers]) { timers.delete(h); fn(); } };
  return { ledger, sent, fireAll };
}

const summary = (over: Partial<PlaybackTurnSummary> = {}): PlaybackTurnSummary => ({
  turnId: 3, instanceId: 'a1', scheduledChunks: 4, endedChunks: 4, stoppedChunks: 0, rescheduledChunks: 0,
  dropped: {}, maxGapMs: 40, audioContextStates: ['running'], hiddenDuringTurn: false, finalizedBy: 'grace', ...over,
});

test('client ledger: one summary per turn, finalized by grace, with gaps and reschedules', () => {
  const { ledger, sent, fireAll } = harness();
  ledger.scheduled(3, 0, 0, 10.0, 0.5, 'running', false);
  ledger.scheduled(3, 0, 1, 10.5, 0.5, 'running', false);
  ledger.scheduled(3, 0, 2, 13.0, 0.5, 'running', true);   // 2.0 s underrun gap
  ledger.scheduled(3, 0, 1, 13.5, 0.5, 'running', false);  // same chunk again
  ledger.ended(3); ledger.ended(3); ledger.ended(3, false);
  assert.equal(sent.length, 0, 'nothing is sent before the turn is finalized');
  fireAll();
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0], instanceId: 'x' }, {
    turnId: 3, instanceId: 'x', scheduledChunks: 4, endedChunks: 2, stoppedChunks: 1, rescheduledChunks: 1,
    dropped: {}, maxGapMs: 2000, audioContextStates: ['running'], hiddenDuringTurn: true, finalizedBy: 'grace',
  });
});

test('client ledger: a newer turn closes older ones; late events never reopen or close turns', () => {
  const { ledger, sent } = harness();
  ledger.scheduled(1, 0, 0, 1, 0.5, 'running', false);
  ledger.scheduled(2, 0, 0, 2, 0.5, 'suspended', false);
  assert.deepEqual(sent.map(s => [s.turnId, s.finalizedBy]), [[1, 'next_turn']]);
  ledger.scheduled(1, 0, 1, 3, 0.5, 'running', false);   // late chunk of turn 1
  ledger.ended(1);
  assert.equal(sent.length, 1, 'turn 2 stays open and turn 1 is not reopened');
  assert.equal(ledger.lateEvents, 2);
  ledger.dropped(undefined, 'content_hash_dedup');           // no turn id: counts against the current turn
  ledger.finalizeAll();
  assert.deepEqual(sent[1].dropped, { content_hash_dedup: 1 });
  assert.deepEqual(sent[1].audioContextStates, ['suspended']);
  assert.equal(sent[1].finalizedBy, 'session_end');
});

test('verdicts name what the player reported, with evidence', () => {
  assert.deepEqual(playbackVerdict({ chunks: 4, bargeIn: false }, [summary()]).flags, []);
  assert.deepEqual(playbackVerdict({ chunks: 4, bargeIn: false }, []).flags, ['unknown']);
  assert.deepEqual(playbackVerdict(null, []).flags, []);
  assert.deepEqual(
    playbackVerdict({ chunks: 4, bargeIn: false }, [summary({ endedChunks: 0, audioContextStates: ['suspended'] })]).flags,
    ['no_playback_reported'],
  );
  assert.deepEqual(playbackVerdict({ chunks: 6, bargeIn: false }, [summary()]).flags, ['partial_playback'], 'sent more than reached the player');
  assert.deepEqual(playbackVerdict({ chunks: 4, bargeIn: false }, [summary({ endedChunks: 2, stoppedChunks: 2 })]).flags, ['partial_playback']);
  assert.deepEqual(playbackVerdict({ chunks: 4, bargeIn: true }, [summary({ endedChunks: 2, stoppedChunks: 2 })]).flags, ['interrupted_by_barge_in']);
  assert.deepEqual(playbackVerdict({ chunks: 4, bargeIn: false }, [summary({ maxGapMs: 6000 })]).flags, ['stalled']);
  assert.deepEqual(
    playbackVerdict({ chunks: 4, bargeIn: false }, [summary(), summary({ instanceId: 'b2' })]).flags,
    ['replayed_playback'],
    'two player instances for one turn',
  );
  const v = playbackVerdict({ chunks: 4, bargeIn: false }, [summary({ dropped: { index_dedup: 1 } })]);
  assert.equal(v.evidence.droppedChunks, 1);
  assert.equal(v.thresholdVersion, 'pb-1-provisional');
});

test('untrusted summaries are validated and clamped', () => {
  assert.equal(sanitizePlaybackSummary(null), null);
  assert.equal(sanitizePlaybackSummary(summary({ instanceId: '../x' })), null);
  assert.equal(sanitizePlaybackSummary(summary({ turnId: -1 })), null);
  const s = sanitizePlaybackSummary({ ...summary(), scheduledChunks: -5, maxGapMs: 1e12, audioContextStates: ['running', 'NOPE', 7], extra: 'x' })!;
  assert.equal(s.scheduledChunks, 0);
  assert.equal(s.maxGapMs, 3_600_000);
  assert.deepEqual(s.audioContextStates, ['running']);
  assert.equal('extra' in s, false);
});

beforeEach(() => resetPlaybackObservationForTests());

test('server ledger: counts only non-empty audio, resets per session, records summaries idempotently', () => {
  observeAudioSent('c1', 'db1', 't1', { type: 'audio_chunk', turnId: 3, audio: 'AAAA' });
  observeAudioSent('c1', 'db1', 't1', { type: 'audio_chunk', turnId: 3, audio: 'AAAA' });
  observeAudioSent('c1', 'db1', 't1', { type: 'audio_chunk', turnId: 3, audio: '', isLast: true });  // seal marker
  observeAudioSent('c1', 'db1', 't1', { type: 'word_timing', turnId: 3 });
  const first = observePlaybackSummary('c1', 't1', summary({ scheduledChunks: 2, endedChunks: 2 }))!;
  assert.deepEqual(first.verdict.flags, []);
  assert.equal(first.duplicate, false);
  assert.equal(observePlaybackSummary('c1', 't1', summary({ scheduledChunks: 2, endedChunks: 2 }))!.duplicate, true);
  assert.equal(getPlaybackObservation('c1', 'db1', 't1')!.turns[0].summaries, 1, 'a retransmitted summary is not counted twice');

  observeBargeIn('c1', 'db1', 't1', 4);
  assert.deepEqual(getPlaybackObservation('c1', 'db1', 't1')!.turns.map(t => [t.turnId, t.sentChunks, t.verdict.flags]),
    [[3, 2, []], [4, 0, ['interrupted_by_barge_in']]]);

  observeAudioSent('c1', 'db2', 't2', { type: 'audio_chunk', turnId: 3, audio: 'AAAA' });
  assert.equal(getPlaybackObservation('c1', 'db1', 't1'), null, 'the observer only sees its exact session');
  const fresh = getPlaybackObservation('c1', 'db2', 't2')!;
  assert.deepEqual(fresh.turns.map(t => [t.turnId, t.verdict.flags]), [[3, ['unknown']]]);
  assert.equal(observePlaybackSummary('c1', 't1', summary({ instanceId: 'late1' })), null,
    'a delayed summary from the previous session never lands on the new session\'s reused turn id');
  assert.equal(observePlaybackSummary('c1', undefined, summary()), null);
  for (let i = 100; i < 140; i++) {
    assert.equal(observePlaybackSummary('c1', 't2', summary({ turnId: i })), null, 'a turn the server never sent is rejected');
  }
  assert.deepEqual(getPlaybackObservation('c1', 'db2', 't2')!.turns.map(t => t.turnId), [3], 'and evicts nothing');
  assert.equal(observePlaybackSummary('nobody', 't1', summary()), null);
});

test('server ledger: bounded per turn and across conversations', () => {
  observeAudioSent('c1', 'db1', 't1', { type: 'audio_chunk', turnId: 1, audio: 'A' });
  const results = [...Array(9)].map((_, i) => observePlaybackSummary('c1', 't1', summary({ turnId: 1, instanceId: `i${i}` }))!);
  assert.deepEqual(results.map(r => r.accepted), [true, true, true, true, true, false, false, false, false],
    'overflow past the cap is not accepted, so the caller never persists it');
  assert.equal(observePlaybackSummary('c1', 't1', summary({ turnId: 1, instanceId: 'i0' }))!.accepted, false, 'duplicates are not accepted');
  assert.equal(getPlaybackObservation('c1', 'db1', 't1')!.turns[0].summaries, 5);
  for (let i = 0; i < 205; i++) observeAudioSent(`conv${i}`, 'db', 't', { type: 'audio_chunk', turnId: 1, audio: 'A' }, 1_000 + i);
  assert.equal(getPlaybackObservation('conv0', 'db', 't', 2_000), null, 'least recently touched conversations are evicted');
  assert.ok(getPlaybackObservation('conv204', 'db', 't', 2_000));
  assert.equal(getPlaybackObservation('conv204', 'db', 'other', 2_000), null, 'both ids must match');
  const later = 1_000 + 3 * 60 * 60 * 1000;
  assert.equal(getPlaybackObservation('conv204', 'db', 't', later), null, 'an idle ledger has expired at read time');
  assert.equal(observePlaybackSummary('conv203', 't', summary({ turnId: 1 }), later), null, 'and at summary time');
});

test('wiring: GL audio feeds the client ledger; the server taps, judges and exposes it', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const audio = read('../../client/src/lib/audioUtils.ts');
  assert.match(audio, /playbackLedger\.scheduled\(turnId, sentenceIndex, chunkIndex, playTime, chunkDuration, ctx\.state,/);
  assert.match(audio, /source\.onended = \(\) => playbackLedger\.ended\(turnId, ctx\.currentTime >= scheduledEnd - 0\.02\)/);
  assert.match(audio, /playbackLedger\.dropped\(turnId, 'index_dedup'\)/);
  assert.match(audio, /playbackLedger\.dropped\(turnId, 'content_hash_dedup'\)/);
  const hook = read('../../client/src/hooks/useStreamingVoice.ts');
  assert.match(hook, /getPlaybackLedger\(\)\.dropped\(msg\.turnId, 'no_player'\)/);
  assert.match(hook, /sampleRate,\s*msg\.turnId\s*\)/);
  const gl = read('../services/gemini-live-session.ts');
  assert.match(gl, /observeAudioSent\(this\.session\.conversationId, this\.session\.dbSessionId \?\? null, this\.session\.id \?\? null, message\)/);
  assert.match(gl, /observeBargeIn\(this\.session\.conversationId, this\.session\.dbSessionId \?\? null, this\.session\.id \?\? null, this\.currentTurnId\)/);
  const ws = read('../unified-ws-handler.ts');
  assert.match(ws, /'client_playback_summary'/);
  assert.equal((ws.match(/recordPlaybackSummary\(event\);/g) ?? []).length, 2, 'single and batched telemetry');
  assert.match(ws, /observePlaybackSummary\(conversationId \?\? undefined, event\.sessionId, event\.data\?\.playbackSummary\)/);
  const route = read('../routes/luca-observer-route.ts');
  assert.match(route, /AND event_type <> 'client_playback_summary'/);
  assert.match(route, /playback: getPlaybackObservation\(convId, observation\.dbSessionId \?\? null, observation\.transientSessionId \?\? null\)/);
  assert.match(ws, /if \(recorded && recorded\.accepted && recorded\.dbSessionId\)/);
});

test('client ledger: default timers work when the host rejects detached setTimeout (browsers)', async () => {
  // Browsers throw "Illegal invocation" when setTimeout runs with `this` bound to another
  // object. Live, that was swallowed by the caller's try/catch, so no summary was ever sent.
  const realSet = globalThis.setTimeout;
  const strict = function (this: unknown, fn: () => void, ms?: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return realSet(fn, ms);
  } as unknown as typeof setTimeout;
  globalThis.setTimeout = strict;
  try {
    const sent: PlaybackTurnSummary[] = [];
    const ledger = new ClientPlaybackLedger(s => sent.push(s));
    assert.doesNotThrow(() => ledger.scheduled(9, 0, 0, 1, 0.2, 'running', false));
    ledger.ended(9);
    ledger.finalizeAll();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endedChunks, 1);
  } finally {
    globalThis.setTimeout = realSet;
  }
});
