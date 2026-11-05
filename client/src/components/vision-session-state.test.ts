/**
 * Vision (webcam / screen share) must survive every normal turn.
 *
 * Live test 1 (2026-11-05): vision switched itself off the moment the student finished
 * speaking. StreamingVoiceChat treated only connected/ready/streaming as connected, so the
 * 'processing' state every turn passes through looked like a disconnect and stopped both
 * streams. The client also dropped every frame while Daniela spoke, because isReady()
 * excludes 'streaming'.
 *
 * Run with:
 *   npx tsx --test client/src/components/vision-session-state.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canSendVideoFrame, visionSessionPhase } from '../lib/vision-session-state.js';

describe('visionSessionPhase', () => {
  it('keeps vision live through a whole turn', () => {
    for (const state of ['connected', 'ready', 'processing', 'streaming'] as const) {
      assert.equal(visionSessionPhase(state), 'live', state);
    }
  });
  it('pauses, without releasing the camera, while (re)connecting', () => {
    assert.equal(visionSessionPhase('connecting'), 'paused');
    assert.equal(visionSessionPhase('reconnecting'), 'paused');
  });
  it('releases the camera only when the session ends or fails', () => {
    assert.equal(visionSessionPhase('disconnected'), 'ended');
    assert.equal(visionSessionPhase('error'), 'ended');
  });
});

describe('canSendVideoFrame', () => {
  it('sends while the student talks and while Daniela speaks', () => {
    assert.equal(canSendVideoFrame('processing', true), true);
    assert.equal(canSendVideoFrame('streaming', true), true);
  });
  it('never sends without an open socket or outside a live session', () => {
    assert.equal(canSendVideoFrame('ready', false), false);
    assert.equal(canSendVideoFrame('reconnecting', true), false);
    assert.equal(canSendVideoFrame('disconnected', true), false);
  });
});

describe('wiring', () => {
  const chat = readFileSync(new URL('./StreamingVoiceChat.tsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../lib/streamingVoiceClient.ts', import.meta.url), 'utf8');

  it('StreamingVoiceChat stops vision only when the phase is ended', () => {
    assert.match(chat, /useVisionCapture\(streamingVoice\.sendVideoFrame, visionPhase !== 'ended'\)/);
    assert.doesNotMatch(chat, /\['connected', 'ready', 'streaming'\]/);
  });
  it('the client gates frames on canSendVideoFrame, not isReady()', () => {
    const body = client.slice(client.indexOf('sendVideoFrame(base64Jpeg'), client.indexOf("type: 'video_frame'"));
    assert.match(body, /canSendVideoFrame\(this\.state/);
    assert.doesNotMatch(body, /this\.isReady\(\)/);
  });
});
