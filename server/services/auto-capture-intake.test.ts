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
  test('a complete enveloped exchange lands once, the consumer accepts it, and writer 1 can frame it', async () => {
    const s = sandbox();
    const record = s.put({ turnId: 'ac-turn-1', david: DAVID, luca: LUCA });
    assert.deepEqual((await s.run()).map(o => o.status), ['recorded']);
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
    test(`${name} stays pending: nothing committed, the consumer is never blocked or made to quarantine`, async () => {
      const s = sandbox();
      const record = s.put(body);
      const [outcome] = (await s.run());
      assert.equal(outcome.status, 'pending');
      assert.match(outcome.reason!, why);
      assert.ok(existsSync(record), 'kept for an operator; never acknowledged as handed off');
      assert.equal(s.bytes(), '', 'nothing reached the canonical log');
      // A later good exchange still lands and the consumer accepts the whole log.
      s.put({ turnId: 'ac-good-1', david: DAVID, luca: LUCA });
      assert.deepEqual((await s.run()).map(o => o.status), ['pending', 'recorded']);
      assert.equal(consumerAccepts(s.turns()), true);
    });
  }

  test('an exact retry appends nothing; a conflicting retry stays pending and appends nothing', async () => {
    const s = sandbox();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    (await s.run());
    const before = s.bytes();
    s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA });
    assert.deepEqual((await s.run()).map(o => o.status), ['exact-retry']);
    assert.equal(s.bytes(), before);
    const conflicting = s.put({ turnId: 'ac-turn-2', david: DAVID, luca: LUCA.replace('ahora', 'luego') });
    const [outcome] = (await s.run());
    assert.equal(outcome.status, 'pending');
    assert.match(outcome.reason!, /different Luca Replit text/);
    assert.ok(existsSync(conflicting));
    assert.equal(s.bytes(), before);
  });

  test('a missing or invalid id stays pending across restarts; no id is invented', async () => {
    const s = sandbox();
    const missing = s.put({ david: DAVID, luca: LUCA });
    const invalid = s.put({ turnId: 'has spaces', david: DAVID, luca: LUCA });
    const junk = s.put('{not json');
    for (let restart = 0; restart < 2; restart++) {
      const outcomes = (await s.run());
      assert.deepEqual(outcomes.map(o => o.status), ['pending', 'pending', 'pending']);
      assert.ok(outcomes.every(o => o.reason));
    }
    for (const record of [missing, invalid, junk]) assert.ok(existsSync(record));
    assert.equal(s.bytes(), '');
  });

  test('fresh input can never overwrite a pending trigger or pending intake', async () => {
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
    assert.deepEqual((await s.run()).map(o => [o.turnId, o.status]), [['ac-first-1', 'recorded'], ['ac-second', 'recorded']]);
  });
});

describe('writer 3: operator correction of a missing-id record', () => {
  test('assign commits the exact bytes under the explicit id, then deletes only that record', async () => {
    const s = sandbox();
    const target = s.put({ david: DAVID, luca: LUCA });
    const other = s.put({ david: 'other', luca: LUCA });
    assert.deepEqual((await s.assign(target, 'op-fix-1')), { kind: 'recorded', turnId: 'op-fix-1' });
    assert.deepEqual(s.turns().map(t => [t.speaker, t.text, t.captureId]), [['DAVID', DAVID, 'op-fix-1'], ['LUCA', LUCA, 'op-fix-1']]);
    assert.equal(existsSync(target), false);
    assert.ok(existsSync(other), 'another record is never touched');
    assert.deepEqual(listAutoCaptureIntake(s.dir).map(r => [r.turnId, r.roles]), [[null, ['david', 'luca']]]);
  });

  test('exact retry after success, and after a crash between commit and delete, is safe', async () => {
    const s = sandbox();
    const done = s.put({ david: DAVID, luca: LUCA });
    (await s.assign(done, 'op-fix-2'));
    assert.deepEqual((await s.assign(done, 'op-fix-2')), { kind: 'not-pending', canonicalHasTurnId: true });
    const crashed = s.put({ david: DAVID, luca: LUCA });
    appendAutoCaptureExchange({ turnId: 'op-fix-3', david: DAVID, luca: LUCA, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const before = s.bytes();
    assert.deepEqual((await s.assign(crashed, 'op-fix-3')), { kind: 'exact-retry', turnId: 'op-fix-3' });
    assert.equal(s.bytes(), before);
    assert.equal(existsSync(crashed), false);
  });

  test('correcting an exchange the consumer would reject keeps it pending, byte-identical', async () => {
    const s = sandbox();
    const record = s.put({ david: DAVID, luca: PLAIN_LUCA });
    const original = readFileSync(record, 'utf8');
    const result = (await s.assign(record, 'op-fix-4'));
    assert.equal(result.kind, 'pending');
    assert.match((result as { reason: string }).reason, /envelope/);
    assert.equal(readFileSync(record, 'utf8'), original);
    assert.equal(s.bytes(), '');
  });

  test('a conflicting correction leaves the record exactly as it was', async () => {
    const s = sandbox();
    appendAutoCaptureExchange({ turnId: 'op-used-1', david: 'other question', luca: LUCA, capturePath: s.capturePath, ingressLockPath: s.ingressLockPath });
    const record = s.put({ david: DAVID, luca: LUCA });
    const original = readFileSync(record, 'utf8');
    assert.equal((await s.assign(record, 'op-used-1')).kind, 'pending');
    assert.equal(readFileSync(record, 'utf8'), original);
    assert.equal((await s.assign(record, 'op-fix-5')).kind, 'recorded');
  });

  test('refused: a different carried id, an unparseable record, and names outside the intake', async () => {
    const s = sandbox();
    const carries = s.put({ turnId: 'ac-own-id', david: DAVID, luca: PLAIN_LUCA });
    assert.equal((await s.assign(carries, 'op-other')).kind, 'refused');
    const junk = s.put('{oops');
    assert.equal((await s.assign(junk, 'op-fix-6')).kind, 'refused');
    for (const name of ['../.chat_capture', '.intake.lock', 'x.json']) {
      assert.equal((await assignIntakeTurnId(name, 'op-fix-7', s.dir, { capturePath: s.capturePath, ingressLockPath: s.ingressLockPath })).kind, 'refused', name);
    }
    assert.equal(s.bytes(), '');
  });

  test('a torn two-sided commit is reported, never completed by dropping or inventing a role', async () => {
    const s = sandbox();
    // An earlier commit that only got its David side into the log:
    appendChatCaptureTurnsAtomic([{ speaker: 'David', text: DAVID, captureId: 'op-torn-1', source: 'replit' }], s.capturePath);
    const torn = s.put({ david: DAVID, luca: LUCA });
    const result = (await s.assign(torn, 'op-torn-1'));
    assert.equal(result.kind, 'pending');
    assert.match((result as { reason: string }).reason, /different set of sides/);
    assert.ok(existsSync(torn));
    assert.deepEqual(s.turns().filter(t => t.captureId === 'op-torn-1').map(t => t.speaker), ['DAVID']);
  });
});


describe('writer 3: canonical-log commit to projection obligation (source order)', () => {
  const src = readFileSync(new URL('./agent-session-autosave.ts', import.meta.url), 'utf8');
  test('the canonical cursor advances only after the row insert and the mirror enqueue', async () => {
    const insert = src.indexOf('INSERT INTO conversation_memories (id, title, summary, content, participants, tags, importance, created_at, entry_type, arc_name, attribution)');
    const enqueue = src.indexOf('enqueueEpisodeMirror({', insert);
    const advance = src.indexOf('saveChatCaptureCursor({', enqueue);
    assert.ok(insert > 0 && enqueue > insert && advance > enqueue);
  });
});

describe('writer 3: the OS-owned intake lock (luca-replit re-review of PR71)', () => {
  test('while one holder is inside, every other arrival is busy; afterwards exactly one of two racers wins', async () => {
    const { withIntakeLockForTest } = await import('./auto-capture-intake');
    const s = sandbox();
    const record = s.put({ turnId: 'lk-1', david: DAVID, luca: LUCA });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let inside = 0;
    let maxInside = 0;
    const holder = withIntakeLockForTest(s.dir, async () => { inside++; maxInside = Math.max(maxInside, inside); await gate; inside--; return 'held'; });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(await s.run(), [], 'the watcher waits');
    assert.deepEqual(await s.assign(record, 'lk-1x'), { kind: 'busy' }, 'a correction waits');
    assert.equal(await withIntakeLockForTest(s.dir, () => 'third'), 'busy', 'a third arrival waits');
    assert.ok(existsSync(record));
    release();
    assert.equal(await holder, 'held');
    const racers = await Promise.all([
      withIntakeLockForTest(s.dir, async () => { inside++; maxInside = Math.max(maxInside, inside); await new Promise(r => setTimeout(r, 20)); inside--; return 'a'; }),
      withIntakeLockForTest(s.dir, async () => { inside++; maxInside = Math.max(maxInside, inside); await new Promise(r => setTimeout(r, 20)); inside--; return 'b'; }),
    ]);
    assert.equal(racers.filter(r => r === 'busy').length, 1, 'exactly one racer wins');
    assert.equal(maxInside, 1, 'never two critical sections at once');
  });

  test('the lock is released when the critical section throws', async () => {
    const { withIntakeLockForTest } = await import('./auto-capture-intake');
    const s = sandbox();
    await assert.rejects(withIntakeLockForTest(s.dir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withIntakeLockForTest(s.dir, () => 'free'), 'free');
  });

  test('a holder process that dies releases the lock at once: nothing stale, no takeover', async () => {
    const { intakeLockAddress } = await import('./auto-capture-intake');
    const { spawn } = await import('node:child_process');
    const s = sandbox();
    const record = s.put({ turnId: 'lk-2', david: DAVID, luca: LUCA });
    const code = `require('net').createServer().listen({ path: ${JSON.stringify(intakeLockAddress(s.dir))}, exclusive: true }, () => console.log('held'))`;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => child.stdout!.once('data', r));
    assert.deepEqual(await s.run(), [], 'busy while another process holds it');
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
    assert.deepEqual((await s.run()).map(o => o.status), ['recorded'], 'free immediately after the holder died');
    assert.equal(existsSync(record), false);
    assert.deepEqual(readdirSync(s.dir).filter(f => f.startsWith('.intake')), [], 'no lock files at all');
  });

  test('aliases of the same physical directory share one lock (symlink or junction; casing on Windows)', async () => {
    const { withIntakeLockForTest, intakeLockAddress } = await import('./auto-capture-intake');
    const { mkdtempSync: mk, symlinkSync, mkdirSync: md } = await import('node:fs');
    const root = mk(join(tmpdir(), 'intake-alias-'));
    const real = join(root, 'intake');
    md(real);
    const alias = join(root, 'alias');
    symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliases = [alias, ...(process.platform === 'win32' ? [real.toUpperCase()] : [])];
    for (const other of aliases) assert.equal(intakeLockAddress(other), intakeLockAddress(real), `one address for ${other}`);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let inside = 0;
    let overlap = false;
    const holder = withIntakeLockForTest(real, async () => { inside++; await gate; inside--; return 'held'; });
    await new Promise(r => setTimeout(r, 20));
    for (const other of aliases) {
      const result = await withIntakeLockForTest(other, () => { if (inside > 0) overlap = true; return 'entered'; });
      assert.equal(result, 'busy', `an alias (${other}) cannot enter while the real path is held`);
    }
    release();
    assert.equal(await holder, 'held');
    assert.equal(overlap, false, 'never two critical sections on one directory');
    assert.equal(await withIntakeLockForTest(alias, () => 'free'), 'free', 'the alias acquires once the holder is gone');
  });

  test('the address is OS-owned per directory, never a file', async () => {
    const { intakeLockAddress } = await import('./auto-capture-intake');
    assert.match(intakeLockAddress('/a', 'linux'), /^\0holahola-intake-[0-9a-f]{32}$/);
    assert.match(intakeLockAddress('C:/a', 'win32'), /^\\\\\.\\pipe\\holahola-intake-[0-9a-f]{32}$/);
    assert.notEqual(intakeLockAddress('/a', 'linux'), intakeLockAddress('/b', 'linux'));
    assert.throws(() => intakeLockAddress('/a', 'darwin'), /unsupported_platform/);
  });
});

