import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroundingTiming } from './auto-grounding-timing';

test('lookup timing preserves values and counts total time including gaps', async () => {
  let now = 100;
  const timing = createGroundingTiming('synthetic-attempt', () => now);
  const value = { summary: 'synthetic-private-content' };
  assert.equal(await timing.measure('semantic_search', async () => {
    now += 20;
    return value;
  }), value);
  now += 9;
  assert.deepEqual(timing.snapshot(), {
    attemptId: 'synthetic-attempt', totalMs: 29,
    stages: [{ stage: 'semantic_search', elapsedMs: 20, outcome: 'completed' }],
  });
  assert(!JSON.stringify(timing.snapshot()).includes(value.summary));
});

test('lookup timing rethrows the original error without recording its content', async () => {
  let now = 0;
  const timing = createGroundingTiming(undefined, () => now);
  const error = new Error('synthetic-sensitive-error');
  await assert.rejects(timing.measure('felt_history', async () => {
    now += 17;
    throw error;
  }), actual => actual === error);
  assert.deepEqual(timing.snapshot(), { totalMs: 17,
    stages: [{ stage: 'felt_history', elapsedMs: 17, outcome: 'failed' }] });
  assert(!JSON.stringify(timing.snapshot()).includes(error.message));
});

test('skipped stages are absent; snapshots cannot mutate collected timing state', async () => {
  let now = 0;
  const timing = createGroundingTiming(undefined, () => now);
  await timing.measure('north_star', async () => { now += 3; return []; });
  const snapshot = timing.snapshot();
  snapshot.stages[0].elapsedMs = 9999;
  assert.equal(timing.snapshot().stages[0].elapsedMs, 3);
  assert.equal(timing.snapshot().stages.length, 1);
});
