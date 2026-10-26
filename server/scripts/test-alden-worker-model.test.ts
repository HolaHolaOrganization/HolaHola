/**
 * Alden's background workers on Claude Sonnet 5.5 (founder-authorized,
 * 2026-10-25/26). Sonnet 5.5 thinks adaptively by default, so a reply can begin
 * with a thinking block; a reader that takes content[0] silently gets no text
 * and every worker falls back as if the model had found nothing. These checks
 * pin the reader, the model, the explicit effort and the price. Offline: the
 * worker files are read as source, never imported (they start timers and DB
 * work), and no provider is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALDEN_WORKER_MODEL, ALDEN_WORKER_LOW_EFFORT, ALDEN_WORKER_MEDIUM_EFFORT, aldenWorkerText } from '../services/alden-worker-model';
import { costTracker } from '../services/cost-tracker';

const WORKERS = [
  'server/services/alden-watch-worker.ts',
  'server/services/alden-auto-repair.ts',
  'server/services/alden-code-review-service.ts',
  'server/services/alden-digest-worker.ts',
];
const source = (path: string) => readFileSync(path, 'utf8');

/** Each `messages.create({ ... })` call body in a source file, up to its closing `});`. */
function createCalls(text: string): string[] {
  return [...text.matchAll(/messages\.create\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]);
}

test('the reader takes the first text block, not the first block', () => {
  assert.equal(aldenWorkerText([{ type: 'thinking', text: '' }, { type: 'text', text: '  {"eligible": false}  ' }]), '{"eligible": false}');
  assert.equal(aldenWorkerText([{ type: 'thinking' }, { type: 'text', text: 'UNRELATED' }, { type: 'text', text: 'second' }]), 'UNRELATED');
});

test('the reader returns empty, never throws, when there is no text (thinking only, refusal, missing content)', () => {
  assert.equal(aldenWorkerText([{ type: 'thinking', text: '' }]), '');
  assert.equal(aldenWorkerText([]), '');
  assert.equal(aldenWorkerText(undefined), '');
});

test('the workers run on Claude Sonnet 5.5 with an explicit effort', () => {
  assert.equal(ALDEN_WORKER_MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(ALDEN_WORKER_LOW_EFFORT, { output_config: { effort: 'low' } });
  assert.deepEqual(ALDEN_WORKER_MEDIUM_EFFORT, { output_config: { effort: 'medium' } });
});

for (const path of WORKERS) {
  test(`${path}: every call uses the shared model and an effort, and no reply is read by position`, () => {
    const text = source(path);
    assert.doesNotMatch(text, /claude-sonnet-4-5/, 'no Sonnet 4.5 model or cost label remains');
    assert.doesNotMatch(text, /\.content\[0\]/, 'replies are read by block type, not content[0]');
    const calls = createCalls(text);
    assert.ok(calls.length >= 1, 'the file makes at least one model call');
    for (const call of calls) {
      assert.match(call, /model: ALDEN_WORKER_MODEL,/);
      assert.match(call, /\.\.\.ALDEN_WORKER_(LOW|MEDIUM)_EFFORT/);
      const maxTokens = Number(/max_tokens: (\d+)/.exec(call)?.[1]);
      assert.ok(maxTokens >= 4000, `max_tokens ${maxTokens} leaves room for thinking as well as the reply`);
    }
  });
}

test('cost tracking prices Claude Sonnet 5.5 at $2 / $10 per million tokens', () => {
  assert.equal(costTracker.track(ALDEN_WORKER_MODEL, 1_000_000, 1_000_000, 'test-alden-worker-model'), 12);
});
