// What the hats can see of a live session (session-observation-store.ts): tool
// arguments and results, the images Daniela shows, the webcam or screen frame
// she is sent (memory only, never in the snapshot), and the model and usage.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getObservation,
  getVisionFrame,
  OBSERVED_PAYLOAD_CHARS,
  observeModelAndUsage,
  observeOutboundVisuals,
  observeSessionEnd,
  observeSessionStart,
  observeToolCall,
  observeToolResults,
  observeVisionFrame,
} from './session-observation-store';

let n = 0;
function start() {
  const conversationId = `visibility-test-${++n}`;
  observeSessionStart({ conversationId, dbSessionId: `db-${n}`, transientSessionId: `t-${n}`, userId: 'u', language: 'en', actflLevel: null });
  return conversationId;
}

test('tool calls carry their arguments, and a huge argument is clipped, not dropped', () => {
  const id = start();
  observeToolCall(id, 'show_image', undefined, { query: 'a cat', caption: 'Mi gato' });
  observeToolCall(id, 'big_tool', undefined, { blob: 'x'.repeat(OBSERVED_PAYLOAD_CHARS * 2) });
  const [big, small] = getObservation(id)!.recentToolCalls;
  assert.equal(small.args, '{"query":"a cat","caption":"Mi gato"}');
  assert.ok(big.args!.length < OBSERVED_PAYLOAD_CHARS + 60);
  assert.match(big.args!, /\[clipped, \d+ chars\]$/);
});

test('tool results record what went back to Daniela, per call, newest first', () => {
  const id = start();
  observeToolResults(id, [
    { id: 'c1', name: 'recall', response: { output: 'She mentioned Wayne [ARCHIVE GUARDIAN: ...]' } },
    { id: 'c2', name: 'show_image', response: { ok: true } },
  ]);
  const results = getObservation(id)!.recentToolResults;
  assert.deepEqual(results.map((r) => [r.callId, r.name]), [['c2', 'show_image'], ['c1', 'recall']]);
  assert.match(results[1].response, /ARCHIVE GUARDIAN/);
});

test('images Daniela shows are found anywhere in an outbound message, with a label, and repeats are not re-recorded', () => {
  const id = start();
  const message = { type: 'whiteboard_update', items: [{ type: 'image', content: 'gato', data: { word: 'gato', imageUrl: 'https://img.example/cat.jpg' } }] };
  observeOutboundVisuals(id, message);
  observeOutboundVisuals(id, message);
  observeOutboundVisuals(id, { type: 'scene_canvas', environmentImageUrl: 'https://img.example/cafe.jpg', environmentLabel: 'Café' });
  observeOutboundVisuals(id, { type: 'audio_chunk', data: 'AAAA' });
  const visuals = getObservation(id)!.shownVisuals;
  assert.deepEqual(visuals.map((v) => [v.messageType, v.imageUrl, v.label]), [
    ['scene_canvas', 'https://img.example/cafe.jpg', 'Café'],
    ['whiteboard_update', 'https://img.example/cat.jpg', 'gato'],
  ]);
});

test('the newest webcam and screen frames are served from memory, never carried in the snapshot, and dropped at session end', () => {
  const id = start();
  observeVisionFrame(id, 'webcam', 'd2ViY2FtLTE=');
  observeVisionFrame(id, 'webcam', 'd2ViY2FtLTI=');
  observeVisionFrame(id, 'screen', 'c2NyZWVu');
  assert.equal(getVisionFrame(id, 'webcam')!.base64Jpeg, 'd2ViY2FtLTI=');
  assert.equal(getVisionFrame(id)!.source, 'screen', 'default is whichever source sent last');
  const snapshot = JSON.stringify(getObservation(id));
  assert.ok(!snapshot.includes('d2ViY2Ft') && !snapshot.includes('c2NyZWVu'), 'no image bytes in the observation');
  assert.deepEqual(getObservation(id)!.visionSources.map((v) => [v.source, v.frames]), [['screen', 1], ['webcam', 2]]);
  observeSessionEnd(id);
  assert.equal(getVisionFrame(id), null);
});

test('a new session on the same conversation starts with no frames, results or visuals from the old one', () => {
  const id = start();
  observeVisionFrame(id, 'webcam', 'b2xk');
  observeOutboundVisuals(id, { type: 'x', imageUrl: 'https://img.example/old.jpg' });
  observeSessionStart({ conversationId: id, dbSessionId: 'another', transientSessionId: 'other', userId: 'u', language: 'en', actflLevel: null });
  assert.equal(getVisionFrame(id), null);
  assert.deepEqual(getObservation(id)!.shownVisuals, []);
});

test('the model and the latest token usage are observed', () => {
  const id = start();
  observeModelAndUsage(id, { model: 'gemini-3.1-flash-live-preview' });
  observeModelAndUsage(id, { usage: { promptTokenCount: 12000, totalTokenCount: 12500 } });
  const o = getObservation(id)!;
  assert.equal(o.model, 'gemini-3.1-flash-live-preview');
  assert.deepEqual(o.latestUsage, { promptTokenCount: 12000, totalTokenCount: 12500 });
});

test('nothing is recorded for a conversation that is not being observed', () => {
  observeToolResults('not-observed', [{ id: 'c', name: 'x', response: {} }]);
  observeVisionFrame('not-observed', 'webcam', 'eA==');
  observeOutboundVisuals('not-observed', { imageUrl: 'https://img.example/x.jpg' });
  assert.equal(getObservation('not-observed'), null);
  assert.equal(getVisionFrame('not-observed'), null);
});
