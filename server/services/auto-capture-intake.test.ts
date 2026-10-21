/**
 * Writer 3 (attribution design f5d77712 section 3.5): durable auto-capture
 * intake and its canonical append, on isolated temporary files only.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { assignIntakeTurnId, listAutoCaptureIntake, moveTriggerIntoIntake, processAutoCaptureIntake, publishTriggerExclusive } from './auto-capture-intake';
import { appendAutoCaptureExchange } from './canonical-conversation-capture';
import { basename } from 'node:path';
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
  const assign = (record: string, turnId: string) => assignIntakeTurnId(basename(record), turnId, dir, { capturePath, ingressLockPath });
  return { root, dir, trigger, capturePath, ingressLockPath, put, run, assign, turns, bytes, pending };
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

describe('writer 3: operator correction of a missing-id record (luca-replit seq 543)', () => {
  test('assign commits the exact bytes and roles under the explicit id, then deletes only that record', () => {
    const s = sandbox();
    const target = s.put({ david: DAVID, luca: LUCA });
    const other = s.put({ luca: 'another pending entry' });
    assert.deepEqual(s.assign(target, 'op-fix-1'), { kind: 'recorded', turnId: 'op-fix-1' });
    assert.deepEqual(s.turns().map(t => [t.speaker, t.text, t.captureId, t.source]), [
      ['DAVID', DAVID, 'op-fix-1', 'replit'], ['LUCA', LUCA, 'op-fix-1', 'replit'],
    ]);
    assert.equal(existsSync(target), false);
    assert.ok(existsSync(other), 'another record is never touched');
    assert.deepEqual(listAutoCaptureIntake(s.dir).map(r => [r.turnId, r.roles]), [[null, ['luca']]]);
  });

  test('exact retry after success, and after a crash between commit and delete, is safe', () => {
    const s = sandbox();
    const done = s.put({ luca: LUCA });
    s.assign(done, 'op-fix-2');
    assert.deepEqual(s.assign(done, 'op-fix-2'), { kind: 'not-pending', canonicalHasTurnId: true });
    // Crash after the canonical append, before the record was deleted:
    const crashed = s.put({ david: DAVID, luca: LUCA });
    appendAutoCaptureExchange({ turnId: 'op-fix-3', david: DAVID, luca: LUCA, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const before = s.bytes();
    assert.deepEqual(s.assign(crashed, 'op-fix-3'), { kind: 'exact-retry', turnId: 'op-fix-3' });
    assert.equal(s.bytes(), before, 'nothing appended twice');
    assert.equal(existsSync(crashed), false);
  });

  test('a conflicting correction leaves the record exactly as it was', () => {
    const s = sandbox();
    appendAutoCaptureExchange({ turnId: 'op-used-1', luca: 'already committed', capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const record = s.put({ luca: LUCA });
    const original = readFileSync(record, 'utf8');
    const result = s.assign(record, 'op-used-1');
    assert.equal(result.kind, 'pending');
    assert.equal(readFileSync(record, 'utf8'), original, 'the record is never rewritten');
    assert.equal(s.assign(record, 'op-fix-4').kind, 'recorded', 'a correct id still resolves it');
  });

  test('refused: a record that already carries a different id, an unparseable record, and names outside the intake', () => {
    const s = sandbox();
    const carries = s.put({ turnId: 'ac-own-id', luca: LUCA });
    assert.equal(s.assign(carries, 'op-other').kind, 'refused');
    const junk = s.put('{oops');
    assert.equal(s.assign(junk, 'op-fix-5').kind, 'refused');
    for (const name of ['../.chat_capture', '.intake.lock', 'x.json']) {
      assert.equal(assignIntakeTurnId(name, 'op-fix-6', s.dir, { capturePath: s.capturePath, ingressLockPath: s.ingressLockPath }).kind, 'refused', name);
    }
    assert.equal(s.bytes(), '');
  });

  test('a one-sided record stays one-sided; a torn two-sided commit is reported, never completed', () => {
    const s = sandbox();
    const oneSided = s.put({ luca: LUCA });
    assert.equal(s.assign(oneSided, 'op-one-1').kind, 'recorded');
    assert.deepEqual(s.turns().filter(t => t.captureId === 'op-one-1').map(t => t.speaker), ['LUCA'], 'no side invented');
    // An earlier two-sided commit that only got its David side down:
    appendAutoCaptureExchange({ turnId: 'op-torn-1', david: DAVID, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const torn = s.put({ david: DAVID, luca: LUCA });
    const result = s.assign(torn, 'op-torn-1');
    assert.equal(result.kind, 'pending');
    assert.match((result as { reason: string }).reason, /different set of sides/);
    assert.ok(existsSync(torn), 'the full exchange stays pending, both roles intact');
    assert.deepEqual(s.turns().filter(t => t.captureId === 'op-torn-1').map(t => t.speaker), ['DAVID']);
  });

  test('a live lock holder makes correction and processing wait; a dead holder is taken over', () => {
    const s = sandbox();
    const record = s.put({ luca: LUCA });
    const lock = join(s.dir, '.intake.lock');
    writeFileSync(lock, String(process.pid)); // a live holder
    assert.deepEqual(s.assign(record, 'op-fix-7'), { kind: 'busy' });
    assert.deepEqual(s.run(), [], 'the watcher waits too');
    assert.ok(existsSync(record));
    writeFileSync(lock, '2147483646'); // a holder that no longer exists (restart)
    assert.equal(s.assign(record, 'op-fix-7').kind, 'recorded');
    assert.equal(existsSync(lock), false, 'the lock is released');
  });
});

describe('writer 3: canonical-log commit to projection obligation (source order)', () => {
  const src = readFileSync(new URL('./agent-session-autosave.ts', import.meta.url), 'utf8');
  test('the canonical cursor advances only after the row insert and the mirror enqueue', () => {
    const insert = src.indexOf('INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name, attribution)');
    const enqueue = src.indexOf('enqueueEpisodeMirror({', insert);
    const advance = src.indexOf('saveChatCaptureCursor({', enqueue);
    assert.ok(insert > 0 && enqueue > insert && advance > enqueue,
      'bytes past the canonical cursor are replayed after a crash until both the row and the outbox item exist');
  });
});
