/**
 * Writer 3 (attribution design f5d77712 section 3.5): durable auto-capture
 * intake and its canonical append, on isolated temporary files only.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { moveTriggerIntoIntake, processAutoCaptureIntake, publishTriggerExclusive } from './auto-capture-intake';
import { parseChatCaptureFromOffset } from './transcript-parser';
import { buildCanonicalEpisodeEvent } from './turn-attribution-writer';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'auto-capture-intake-'));
  const dir = join(root, 'intake');
  const capturePath = join(root, '.chat_capture');
  const ingressLockPath = join(root, '.ingress.lock');
  const trigger = join(root, '.luca_auto_capture');
  let n = 0;
  const put = (body: unknown) => {
    publishTriggerExclusive(trigger, typeof body === 'string' ? body : JSON.stringify(body));
    const moved = moveTriggerIntoIntake(trigger, dir);
    assert.ok(moved, `record ${++n} moved into intake`);
    return moved!;
  };
  const run = () => processAutoCaptureIntake(dir, { capturePath, ingressLockPath });
  const turns = () => (existsSync(capturePath) ? parseChatCaptureFromOffset(capturePath, 0).turns : []);
  const bytes = () => (existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '');
  const pending = () => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []);
  return { root, dir, trigger, put, run, turns, bytes, pending };
}

const DAVID = '¿Y ahora qué? —\ncon dos líneas';
const LUCA = 'Luca: una respuesta ✓\n\nen párrafos';

describe('writer 3: durable intake and canonical append', () => {
  test('a valid exchange lands once as canonical replit turns that writer 1 can frame', () => {
    const s = sandbox();
    const record = s.put({ turnId: 'ac-turn-1', david: DAVID, luca: LUCA });
    assert.deepEqual(s.run().map(o => o.status), ['recorded']);
    assert.equal(existsSync(record), false, 'deleted only after the canonical append');
    const turns = s.turns();
    assert.deepEqual(turns.map(t => [t.speaker, t.text, t.captureId, t.source]), [
      ['DAVID', DAVID, 'ac-turn-1', 'replit'],
      ['LUCA', LUCA, 'ac-turn-1', 'replit'],
    ]);
    const event = buildCanonicalEpisodeEvent(turns);
    assert.ok(event, 'writer 1 frames it');
    assert.deepEqual([event.source, event.sourceEventId, event.frames.map(f => f.frameKey)], ['replit', 'ac-turn-1', ['david', 'luca']]);
  });

  test('an exact retry appends nothing; a conflicting retry stays pending and appends nothing', () => {
    const s = sandbox();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    s.run();
    const before = s.bytes();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    assert.deepEqual(s.run().map(o => o.status), ['exact-retry']);
    assert.equal(s.bytes(), before);
    const conflicting = s.put({ turnId: 'ac-turn-2', david: DAVID, luca: 'different' });
    const [outcome] = s.run();
    assert.equal(outcome.status, 'pending');
    assert.match(outcome.reason!, /different Luca Replit text/);
    assert.ok(existsSync(conflicting), 'the conflicting record is kept');
    assert.equal(s.bytes(), before);
  });

  test('partial roles: a one-sided exchange lands; a late second side under the same id is refused, never merged', () => {
    const s = sandbox();
    s.put({ turnId: 'ac-turn-3', david: DAVID });
    assert.deepEqual(s.run().map(o => o.status), ['recorded']);
    const before = s.bytes();
    const late = s.put({ turnId: 'ac-turn-3', david: DAVID, luca: LUCA });
    const [outcome] = s.run();
    assert.equal(outcome.status, 'pending');
    assert.match(outcome.reason!, /different set of sides/);
    assert.ok(existsSync(late));
    assert.equal(s.bytes(), before);
    assert.deepEqual(s.turns().map(t => t.speaker), ['DAVID'], 'no role was dropped or duplicated');
  });

  test('a missing or invalid id stays pending across restarts; no id is invented', () => {
    const s = sandbox();
    const missing = s.put({ david: DAVID, luca: LUCA });
    const invalid = s.put({ turnId: 'has spaces', luca: LUCA });
    const junk = s.put('{not json');
    for (let restart = 0; restart < 2; restart++) {
      const outcomes = s.run();
      assert.deepEqual(outcomes.map(o => o.status), ['pending', 'pending', 'pending']);
      assert.ok(outcomes.every(o => o.reason));
    }
    for (const record of [missing, invalid, junk]) assert.ok(existsSync(record));
    assert.equal(s.bytes(), '', 'nothing reached the canonical log');
    // A caller re-captures with an explicit id: that lands, the pending ones stay visible.
    s.put({ turnId: 'ac-turn-4', david: DAVID, luca: LUCA });
    assert.deepEqual(s.run().map(o => o.status), ['pending', 'pending', 'pending', 'recorded']);
  });

  test('fresh input can never overwrite a pending trigger or pending intake', () => {
    const s = sandbox();
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-first-1', luca: 'first' })), true);
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-second', luca: 'second' })), false, 'refused, not overwritten');
    assert.match(readFileSync(s.trigger, 'utf8'), /first/);
    const first = moveTriggerIntoIntake(s.trigger, s.dir)!;
    assert.equal(existsSync(s.trigger), false, 'the trigger path is free again');
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-second', luca: 'second' })), true);
    const second = moveTriggerIntoIntake(s.trigger, s.dir)!;
    assert.notEqual(first, second);
    assert.match(readFileSync(first, 'utf8'), /first/, 'the pending record is untouched');
    assert.deepEqual(s.run().map(o => [o.turnId, o.status]), [['ac-first-1', 'recorded'], ['ac-second', 'recorded']]);
  });

  test('a record survives an interrupted run and is processed on the next one', () => {
    const s = sandbox();
    const record = s.put({ turnId: 'ac-turn-5', luca: LUCA });
    // Interrupted before processing: the record is the durable state.
    assert.deepEqual(s.pending(), [record.split(/[\\/]/).pop()]);
    writeFileSync(join(s.root, 'unrelated'), 'x');
    assert.deepEqual(s.run().map(o => o.status), ['recorded']);
    assert.deepEqual(s.pending(), []);
  });
});
