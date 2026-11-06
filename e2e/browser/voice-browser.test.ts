/**
 * Phase 1 of the shared browser test lane: the real voice client in real Chromium,
 * with fake camera and microphone devices and a mock voice server. No secrets, no
 * Gemini, no database. Run: npm run test:browser (builds the harness first).
 *
 * Covers what unit tests could not see in live test 1:
 * - vision keeps sending frames through a student turn ('processing'), F4;
 * - Gemini Live audio played by the browser is reported in one playback summary
 *   per turn, with every chunk played through (the F1–F2 ledger);
 * - the session comes back after a network outage, and vision resumes (live test 2, G1).
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startMockVoiceServer, type MockVoiceServer } from './mock-voice-server';

const ROOT = resolve(import.meta.dirname, '..', '..', 'dist-e2e');
let server: MockVoiceServer;
let browser: Browser;

before(async () => {
  server = await startMockVoiceServer(ROOT);
});

// A browser per test: once one context has used Chromium's fake camera, later contexts in
// the same browser get NotFoundError from getUserMedia.
beforeEach(async () => {
  browser = await chromium.launch({
    // Locally, point at an installed Chromium when Playwright's own build is absent.
    ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

afterEach(async () => {
  await browser?.close();
});

after(async () => {
  await server?.close();
});

async function connectedPage(): Promise<Page> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean((window as any).harness), null, { timeout: 15_000 })
    .catch(() => { throw new Error(`harness never mounted; page errors: ${errors.join(' | ') || 'none'}`); });
  await page.evaluate(() => (window as any).harness.connect());
  await page.waitForFunction(() => (window as any).harness.state() === 'ready', null, { timeout: 15_000 });
  return page;
}

/** Base64 of `samples` float32 samples of a quiet tone. */
function pcmChunk(samples: number, phase: number): string {
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i++) data[i] = 0.05 * Math.sin((phase + i) * 2 * Math.PI * 233.3 / 24_000);  // not a whole number of periods per chunk, so no two chunks are identical (content-hash dedup)
  return Buffer.from(data.buffer).toString('base64');
}

test('vision keeps sending frames while the student turn is processing', async () => {
  const page = await connectedPage();
  await page.evaluate(() => (window as any).harness.toggleWebcam());
  await server.waitFor(() => server.messages('video_frame').length >= 2, 15_000, 'first webcam frames');

  const before = server.messages('video_frame').length;
  const processingAt = Date.now();
  server.send({ type: 'processing_pending', interimTranscript: 'hola' });
  await page.waitForFunction(() => (window as any).harness.state() === 'processing', null, { timeout: 5_000 });
  await new Promise(r => setTimeout(r, 5_000));

  const during = server.messages('video_frame').filter(m => m.at > processingAt).length;
  assert.ok(during >= 2, `expected frames to keep flowing during 'processing', got ${during} (had ${before} before)`);
  assert.equal(await page.evaluate(() => (window as any).harness.webcamActive()), true, 'the camera stays on');
  assert.ok(server.messages('video_frame').every(m => m.body.source === 'webcam'));
  await page.context().close();
});

test('played Gemini Live audio is reported as one playback summary for the turn', { timeout: 60_000 }, async () => {
  const page = await connectedPage();
  const turnId = 1;
  const chunkSamples = 4_800; // 200 ms at 24 kHz
  const sendTurn = (id: number) => {
    for (let chunk = 0; chunk < 3; chunk++) {
      server.send({
        type: 'audio_chunk', turnId: id, sentenceIndex: 0, chunkIndex: chunk, isLast: false,
        durationMs: 200, audioFormat: 'pcm_f32le', sampleRate: 24_000, audio: pcmChunk(chunkSamples, (id * 10 + chunk) * chunkSamples),
      });
    }
    server.send({ type: 'audio_chunk', turnId: id, sentenceIndex: 0, chunkIndex: 3, isLast: true, durationMs: 0, audioFormat: 'pcm_f32le', audio: '' });
    server.send({ type: 'response_complete', turnId: id, totalSentences: 1 });
  };
  sendTurn(turnId);

  // 0.6 s of audio, then the ledger's 5 s finalize grace.
  await server.waitFor(() => server.telemetry('playback_turn_summary').length > 0, 15_000, 'a playback_turn_summary');
  const summary = server.telemetry('playback_turn_summary')[0].data.playbackSummary;
  assert.equal(summary.turnId, turnId, JSON.stringify(summary));
  assert.equal(summary.scheduledChunks, 3, 'the empty seal marker is not a chunk');
  assert.equal(summary.endedChunks, 3, 'every chunk played through on the AudioContext clock');
  assert.equal(summary.stoppedChunks, 0);
  assert.equal(summary.rescheduledChunks, 0);
  assert.deepEqual(summary.dropped, {});
  assert.ok(summary.maxGapMs <= 50, `chunks were scheduled back to back (max gap ${summary.maxGapMs} ms)`);
  assert.ok(summary.audioContextStates.includes('running'), `AudioContext states: ${summary.audioContextStates}`);

  // A newer turn is a second finalize trigger: once its own summary arrives, the first turn
  // must still have exactly one.
  sendTurn(turnId + 1);
  const summariesFor = (id: number) => server.telemetry('playback_turn_summary').filter(e => e.data.playbackSummary.turnId === id);
  await server.waitFor(() => summariesFor(turnId + 1).length > 0, 15_000, 'a summary for the newer turn');
  assert.equal(summariesFor(turnId).length, 1, 'finalizing is once per turn');
  await page.context().close();
});

test('the session comes back after a network outage, and vision resumes', { timeout: 60_000 }, async () => {
  const page = await connectedPage();
  const framesBefore = server.messages('video_frame').length;
  await page.evaluate(() => (window as any).harness.toggleWebcam());
  await server.waitFor(() => server.messages('video_frame').length > framesBefore, 15_000, 'first webcam frame');
  const startsBefore = server.messages('start_session').length;
  const historyBefore: number = await page.evaluate(() => (window as any).harness.stateHistory().length);

  await page.context().setOffline(true);
  server.dropClients();

  // Longer than the fast retries, so attempts really do fail while offline.
  await new Promise(r => setTimeout(r, 6_000));
  const states: string[] = await page.evaluate(n => (window as any).harness.stateHistory().slice(n), historyBefore);
  assert.ok(states.includes('reconnecting'), `states during the outage: ${states}`);
  assert.ok(!states.includes('error') && !states.includes('disconnected'),
    `a failed attempt is not terminal, and 'error' would release the camera: ${states}`);
  assert.equal(await page.evaluate(() => (window as any).harness.webcamActive()), true, 'the camera stays on through the outage');

  await page.context().setOffline(false);
  await server.waitFor(() => server.messages('start_session').length > startsBefore, 35_000, 'a new start_session after the outage');
  const restart = server.messages('start_session').at(-1)!;
  assert.equal(restart.body.isReconnect, true, 'it resumes the session rather than starting a new one');
  await page.waitForFunction(() => (window as any).harness.state() === 'ready', null, { timeout: 10_000 });

  const resumedAt = Date.now();
  await server.waitFor(() => server.messages('video_frame').some(m => m.at > resumedAt), 15_000, 'webcam frames after the reconnect');
  await page.context().close();
});

test('a retry still in its handshake cannot disturb a session started after End Call', { timeout: 75_000 }, async () => {
  const page = await connectedPage();
  server.holdHandshakes(true);
  try {
    server.dropClients();
    // The first retry runs after 200 ms, and now sits unanswered in its handshake.
    await page.waitForFunction(() => (window as any).harness.state() === 'connecting', null, { timeout: 5_000 });
    await page.evaluate(() => (window as any).harness.disconnect());
    await page.waitForFunction(() => (window as any).harness.state() === 'disconnected', null, { timeout: 5_000 });
  } finally {
    server.holdHandshakes(false);
  }

  const startsBefore = server.messages('start_session').length;
  await page.evaluate(() => (window as any).harness.connect('e2e-second-conversation'));
  await page.waitForFunction(() => (window as any).harness.state() === 'ready', null, { timeout: 15_000 });
  const historyBefore: number = await page.evaluate(() => (window as any).harness.stateHistory().length);

  // The old attempt's own timeout is 30 s; outlast it.
  await new Promise(r => setTimeout(r, 32_000));
  const after: string[] = await page.evaluate(n => (window as any).harness.stateHistory().slice(n), historyBefore);
  assert.deepEqual(after, [], 'the new session sees no state changes from the old attempt');
  assert.equal(await page.evaluate(() => (window as any).harness.state()), 'ready');
  assert.equal(server.messages('start_session').length - startsBefore, 1, 'one start_session for the one new connection');
  assert.equal(server.connectedClients(), 1, 'the abandoned attempt left no second connection');
  await page.context().close();
});

test('End Call during a retry stays ended', { timeout: 60_000 }, async () => {
  const page = await connectedPage();
  server.holdHandshakes(true);
  try {
    server.dropClients();
    await page.waitForFunction(() => (window as any).harness.state() === 'connecting', null, { timeout: 5_000 });
    await page.evaluate(() => (window as any).harness.disconnect());
    await page.waitForFunction(() => (window as any).harness.state() === 'disconnected', null, { timeout: 5_000 });
    const historyBefore: number = await page.evaluate(() => (window as any).harness.stateHistory().length);

    // The old attempt's own timeout is 30 s; outlast it, with no new call to mask what it does.
    await new Promise(r => setTimeout(r, 32_000));
    const after: string[] = await page.evaluate(n => (window as any).harness.stateHistory().slice(n), historyBefore);
    assert.deepEqual(after, [], 'nothing announces an error or restarts after End Call');
  } finally {
    server.holdHandshakes(false);
  }
  await page.context().close();
});
