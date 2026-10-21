/**
 * Writer 3 (attribution design f5d77712 section 3.5): durable auto-capture
 * intake, its canonical append and operator correction, on isolated
 * temporary files only. Revised for luca-replit's PR71 review: intake commits
 * only exchanges the canonical consumer accepts (R2), and the intake lock is
 * never visible without its owner record (R3).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { assignIntakeTurnId, listAutoCaptureIntake, moveTriggerIntoIntake, processAutoCaptureIntake, publishTriggerExclusive } from './auto-capture-intake';
import { appendAutoCaptureExchange, isCompleteCanonicalCaptureBatch, selectCanonicalCaptureBatch } from './canonical-conversation-capture';
import { isCanonicalFourChannelLucaTurn } from './inner-life-capture';
import { appendChatCaptureTurnsAtomic, parseChatCaptureFromOffset } from './transcript-parser';
import { buildCanonicalEpisodeEvent } from './turn-attribution-writer';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'auto-capture-intake-'));
  const dir = join(root, 'intake');
  const capturePath = join(root, '.chat_capture');
  const ingressLockPath = join(root, '.ingress.lock');
  const trigger = join(root, '.luca_auto_capture');
  const put = (body: unknown) => {
    assert.equal(publishTriggerExclusive(trigger, typeof body === 'string' ? body : JSON.stringify(body)), true);
    const moved = moveTriggerIntoIntake(trigger, dir);
    assert.ok(moved, 'record moved into intake');
    return moved!;
  };
  const run = () => processAutoCaptureIntake(dir, { capturePath, ingressLockPath });
  const assign = (record: string, turnId: string) => assignIntakeTurnId(basename(record), turnId, dir, { capturePath, ingressLockPath });
  const turns = () => (existsSync(capturePath) ? parseChatCaptureFromOffset(capturePath, 0).turns : []);
  const bytes = () => (existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '');
  const pending = () => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []);
  return { root, dir, trigger, capturePath, ingressLockPath, put, run, assign, turns, bytes, pending };
}

/**
 * Apply the canonical consumer's OWN acceptance predicates (checkChatCapture:
 * the pre-DB envelope gate, then per-capture completeness) to everything in
 * the log. True only if the consumer would accept every exchange.
 */
function consumerAccepts(turns: ReturnType<typeof parseChatCaptureFromOffset>['turns']): boolean {
  if (turns.some(t => t.speaker === 'LUCA' && t.source !== 'claude-code' && !isCanonicalFourChannelLucaTurn(t.text))) return false;
  let rest = turns;
  while (rest.length > 0) {
    const batch = selectCanonicalCaptureBatch(rest);
    if (!isCompleteCanonicalCaptureBatch(batch)) return false;
    rest = rest.slice(batch.length);
  }
  return true;
}

const DAVID = '¿Y ahora qué? —\ncon dos líneas';
const LUCA = '[felt]: algo ✓\n\n[thinking]: pensando\n\n[moment]: ahora\n\nuna respuesta\n\nen párrafos';
const PLAIN_LUCA = 'a reply without the felt/thinking/moment envelope';

describe('writer 3: intake commits only what the canonical consumer accepts (R2)', () => {
  test('a complete enveloped exchange lands once, the consumer accepts it, and writer 1 can frame it', () => {
    const s = sandbox();
    const record = s.put({ turnId: 'ac-turn-1', david: DAVID, luca: LUCA });
    assert.deepEqual(s.run().map(o => o.status), ['recorded']);
    assert.equal(existsSync(record), false, 'deleted only after an accepted canonical append');
    const turns = s.turns();
    assert.deepEqual(turns.map(t => [t.speaker, t.text, t.captureId, t.source]), [
      ['DAVID', DAVID, 'ac-turn-1', 'replit'],
      ['LUCA', LUCA, 'ac-turn-1', 'replit'],
    ]);
    assert.equal(consumerAccepts(turns), true, 'the real consumer predicates accept it');
    const event = buildCanonicalEpisodeEvent(turns);
    assert.ok(event);
    assert.deepEqual([event.source, event.sourceEventId, event.frames.map(f => f.frameKey)], ['replit', 'ac-turn-1', ['david', 'luca']]);
  });

  for (const [name, body, why] of [
    ['a David-only exchange', { turnId: 'ac-one-d', david: DAVID }, /two-sided/],
    ['a Luca-only exchange', { turnId: 'ac-one-l', luca: LUCA }, /two-sided/],
    ['a Luca reply without the four-channel envelope', { turnId: 'ac-plain-1', david: DAVID, luca: PLAIN_LUCA }, /envelope/],
  ] as const) {
    test(`${name} stays pending: nothing committed, the consumer is never blocked or made to quarantine`, () => {
      const s = sandbox();
      const record = s.put(body);
      const [outcome] = s.run();
      assert.equal(outcome.status, 'pending');
      assert.match(outcome.reason!, why);
      assert.ok(existsSync(record), 'kept for an operator; never acknowledged as handed off');
      assert.equal(s.bytes(), '', 'nothing reached the canonical log');
      // A later good exchange still lands and the consumer accepts the whole log.
      s.put({ turnId: 'ac-good-1', david: DAVID, luca: LUCA });
      assert.deepEqual(s.run().map(o => o.status), ['pending', 'recorded']);
      assert.equal(consumerAccepts(s.turns()), true);
    });
  }

  test('an exact retry appends nothing; a conflicting retry stays pending and appends nothing', () => {
    const s = sandbox();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    s.run();
    const before = s.bytes();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    assert.deepEqual(s.run().map(o => o.status), ['exact-retry']);
    assert.equal(s.bytes(), before);
    const conflicting = s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA.replace('ahora', 'luego') });
    const [outcome] = s.run();
    assert.equal(outcome.status, 'pending');
    assert.match(outcome.reason!, /different Luca Replit text/);
    assert.ok(existsSync(conflicting));
    assert.equal(s.bytes(), before);
  });

  test('a missing or invalid id stays pending across restarts; no id is invented', () => {
    const s = sandbox();
    const missing = s.put({ david: DAVID, luca: LUCA });
    const invalid = s.put({ turnId: 'has spaces', david: DAVID, luca: LUCA });
    const junk = s.put('{not json');
    for (let restart = 0; restart < 2; restart++) {
      const outcomes = s.run();
      assert.deepEqual(outcomes.map(o => o.status), ['pending', 'pending', 'pending']);
      assert.ok(outcomes.every(o => o.reason));
    }
    for (const record of [missing, invalid, junk]) assert.ok(existsSync(record));
    assert.equal(s.bytes(), '');
  });

  test('fresh input can never overwrite a pending trigger or pending intake', () => {
    const s = sandbox();
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-first-1', david: DAVID, luca: LUCA })), true);
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-second', david: 'q2', luca: LUCA })), false, 'refused, not overwritten');
    assert.match(readFileSync(s.trigger, 'utf8'), /ac-first-1/);
    const first = moveTriggerIntoIntake(s.trigger, s.dir)!;
    assert.equal(existsSync(s.trigger), false);
    assert.equal(publishTriggerExclusive(s.trigger, JSON.stringify({ turnId: 'ac-second', david: 'q2', luca: LUCA })), true);
    const second = moveTriggerIntoIntake(s.trigger, s.dir)!;
    assert.notEqual(first, second);
    assert.match(readFileSync(first, 'utf8'), /ac-first-1/);
    assert.deepEqual(s.run().map(o => [o.turnId, o.status]), [['ac-first-1', 'recorded'], ['ac-second', 'recorded']]);
  });
});

describe('writer 3: operator correction of a missing-id record', () => {
  test('assign commits the exact bytes under the explicit id, then deletes only that record', () => {
    const s = sandbox();
    const target = s.put({ david: DAVID, luca: LUCA });
    const other = s.put({ david: 'other', luca: LUCA });
    assert.deepEqual(s.assign(target, 'op-fix-1'), { kind: 'recorded', turnId: 'op-fix-1' });
    assert.deepEqual(s.turns().map(t => [t.speaker, t.text, t.captureId]), [['DAVID', DAVID, 'op-fix-1'], ['LUCA', LUCA, 'op-fix-1']]);
    assert.equal(existsSync(target), false);
    assert.ok(existsSync(other), 'another record is never touched');
    assert.deepEqual(listAutoCaptureIntake(s.dir).map(r => [r.turnId, r.roles]), [[null, ['david', 'luca']]]);
  });

  test('exact retry after success, and after a crash between commit and delete, is safe', () => {
    const s = sandbox();
    const done = s.put({ david: DAVID, luca: LUCA });
    s.assign(done, 'op-fix-2');
    assert.deepEqual(s.assign(done, 'op-fix-2'), { kind: 'not-pending', canonicalHasTurnId: true });
    const crashed = s.put({ david: DAVID, luca: LUCA });
    appendAutoCaptureExchange({ turnId: 'op-fix-3', david: DAVID, luca: LUCA, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const before = s.bytes();
    assert.deepEqual(s.assign(crashed, 'op-fix-3'), { kind: 'exact-retry', turnId: 'op-fix-3' });
    assert.equal(s.bytes(), before);
    assert.equal(existsSync(crashed), false);
  });

  test('correcting an exchange the consumer would reject keeps it pending, byte-identical', () => {
    const s = sandbox();
    const record = s.put({ david: DAVID, luca: PLAIN_LUCA });
    const original = readFileSync(record, 'utf8');
    const result = s.assign(record, 'op-fix-4');
    assert.equal(result.kind, 'pending');
    assert.match((result as { reason: string }).reason, /envelope/);
    assert.equal(readFileSync(record, 'utf8'), original);
    assert.equal(s.bytes(), '');
  });

  test('a conflicting correction leaves the record exactly as it was', () => {
    const s = sandbox();
    appendAutoCaptureExchange({ turnId: 'op-used-1', david: 'other question', luca: LUCA, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const record = s.put({ david: DAVID, luca: LUCA });
    const original = readFileSync(record, 'utf8');
    assert.equal(s.assign(record, 'op-used-1').kind, 'pending');
    assert.equal(readFileSync(record, 'utf8'), original);
    assert.equal(s.assign(record, 'op-fix-5').kind, 'recorded');
  });

  test('refused: a different carried id, an unparseable record, and names outside the intake', () => {
    const s = sandbox();
    const carries = s.put({ turnId: 'ac-own-id', david: DAVID, luca: PLAIN_LUCA });
    assert.equal(s.assign(carries, 'op-other').kind, 'refused');
    const junk = s.put('{oops');
    assert.equal(s.assign(junk, 'op-fix-6').kind, 'refused');
    for (const name of ['../.chat_capture', '.intake.lock', 'x.json']) {
      assert.equal(assignIntakeTurnId(name, 'op-fix-7', s.dir, { capturePath: s.capturePath, ingressLockPath: s.ingressLockPath }).kind, 'refused', name);
    }
    assert.equal(s.bytes(), '');
  });

  test('a torn two-sided commit is reported, never completed by dropping or inventing a role', () => {
    const s = sandbox();
    // An earlier commit that only got its David side into the log:
    appendChatCaptureTurnsAtomic([{ speaker: 'David', text: DAVID, captureId: 'op-torn-1', source: 'replit' }], s.capturePath);
    const torn = s.put({ david: DAVID, luca: LUCA });
    const result = s.assign(torn, 'op-torn-1');
    assert.equal(result.kind, 'pending');
    assert.match((result as { reason: string }).reason, /different set of sides/);
    assert.ok(existsSync(torn));
    assert.deepEqual(s.turns().filter(t => t.captureId === 'op-torn-1').map(t => t.speaker), ['DAVID']);
  });
});

describe('writer 3: the intake lock (R3)', () => {
  const lockOf = (s: ReturnType<typeof sandbox>) => join(s.dir, '.intake.lock');
  test('a lock without a complete owner record is treated as live, never as dead', () => {
    for (const content of ['', '   ', 'not-an-owner', '12345']) {
      const s = sandbox();
      const record = s.put({ turnId: 'lk-1', david: DAVID, luca: LUCA });
      writeFileSync(lockOf(s), content); // e.g. a writer paused between create and owner publish
      assert.deepEqual(s.run(), [], `busy for ${JSON.stringify(content)}`);
      assert.deepEqual(s.assign(record, 'lk-1x'), { kind: 'busy' });
      assert.ok(existsSync(record));
      assert.equal(readFileSync(lockOf(s), 'utf8'), content, 'the other holder\'s lock is untouched');
    }
  });
  test('a live owner means busy; a provably dead owner is taken over and released', () => {
    const s = sandbox();
    const record = s.put({ turnId: 'lk-2', david: DAVID, luca: LUCA });
    writeFileSync(lockOf(s), `${process.pid}:00000000-0000-4000-8000-000000000000`);
    assert.deepEqual(s.run(), []);
    writeFileSync(lockOf(s), '2147483646:00000000-0000-4000-8000-000000000000');
    assert.deepEqual(s.run().map(o => o.status), ['recorded']);
    assert.equal(existsSync(record), false);
    assert.equal(existsSync(lockOf(s)), false, 'released');
  });
  test('a normal pass leaves no lock and no temporary owner files behind', () => {
    const s = sandbox();
    s.put({ turnId: 'lk-3', david: DAVID, luca: LUCA });
    assert.equal(s.run().length, 1);
    assert.equal(existsSync(lockOf(s)), false, 'released after the pass');
    assert.deepEqual(readdirSync(s.dir).filter(f => f.startsWith('.intake.lock.')), []);
  });
});

describe('writer 3: canonical-log commit to projection obligation (source order)', () => {
  const src = readFileSync(new URL('./agent-session-autosave.ts', import.meta.url), 'utf8');
  test('the canonical cursor advances only after the row insert and the mirror enqueue', () => {
    const insert = src.indexOf('INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name, attribution)');
    const enqueue = src.indexOf('enqueueEpisodeMirror({', insert);
    const advance = src.indexOf('saveChatCaptureCursor({', enqueue);
    assert.ok(insert > 0 && enqueue > insert && advance > enqueue);
  });
});
