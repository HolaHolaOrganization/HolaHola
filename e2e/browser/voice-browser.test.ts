/**
 * Phase 1 of the shared browser test lane: the real voice client in real Chromium,
 * with fake camera and microphone devices and a mock voice server. No secrets, no
 * Gemini, no database. Run: npm run test:browser (builds the harness first).
 *
 * Covers what unit tests could not see in live test 1:
 * - vision keeps sending frames through a student turn ('processing'), F4;
 * - Gemini Live audio played by the browser is reported in one playback summary
 *   per turn, with every chunk played through (the F1–F2 ledger).
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startMockVoiceServer, type MockVoiceServer } from './mock-voice-server';

const ROOT = resolve(import.meta.dirname, '..', '..', 'dist-e2e');
let server: MockVoiceServer;
let browser: Browser;

before(async () => {
  server = await startMockVoiceServer(ROOT);
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

after(async () => {
  await browser?.close();
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

test('played Gemini Live audio is reported as one playback summary for the turn', async () => {
  const page = await connectedPage();
  const turnId = 1;
  const chunkSamples = 4_800; // 200 ms at 24 kHz
  for (let chunk = 0; chunk < 3; chunk++) {
    server.send({
      type: 'audio_chunk', turnId, sentenceIndex: 0, chunkIndex: chunk, isLast: false,
      durationMs: 200, audioFormat: 'pcm_f32le', sampleRate: 24_000, audio: pcmChunk(chunkSamples, chunk * chunkSamples),
    });
  }
  server.send({ type: 'audio_chunk', turnId, sentenceIndex: 0, chunkIndex: 3, isLast: true, durationMs: 0, audioFormat: 'pcm_f32le', audio: '' });
  server.send({ type: 'response_complete', turnId, totalSentences: 1 });

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
  await page.context().close();
});
