import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain ESM hook script without type declarations
import { deliverOutbox, exchangesForStop, queueExchange } from '../../.claude/hooks/record-stop-turn.mjs';

// A message David sends while a turn is running is absorbed as a queued_command
// attachment, not a user entry. Before this change the Stop hook folded it into
// the earlier exchange and never recorded its text.

const human = (text: unknown) => ({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { content: text } });
const reply = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolCall = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } });
const absorbed = (prompt: unknown) => ({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', prompt } });
const notice = (text: string) => ({ type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { content: text } });
const queuedNotice = (prompt: string) => ({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'task-notification' }, commandMode: 'task-notification', prompt } });

test('a plain turn is one exchange, unchanged: the last user message and all assistant text after it', () => {
  const out = exchangesForStop([human('U0'), reply('A0'), human('U1'), reply('A1'), toolCall(), toolResult(), reply('A2')]);
  assert.deepEqual(out, [{ index: 2, userText: 'U1', assistantText: 'A1\n\nA2' }]);
});

test('an absorbed mid-turn message starts its own exchange at its own position', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), toolCall(), toolResult(), absorbed('U2'), reply('A2'), reply('A3')]);
  assert.deepEqual(out, [
    { index: 0, userText: 'U1', assistantText: 'A1' },
    { index: 4, userText: 'U2', assistantText: 'A2\n\nA3' },
  ]);
});

test('several absorbed messages each get an exchange', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2'), reply('A2'), absorbed('U3'), reply('A3')]);
  assert.deepEqual(out.map((e: { index: number; userText: string }) => [e.index, e.userText]), [[0, 'U1'], [2, 'U2'], [4, 'U3']]);
});

test('an absorbed prompt with image and text blocks records only its text', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed([{ type: 'image', source: {} }, { type: 'text', text: 'look at this' }]), reply('A2')]);
  assert.deepEqual(out[1], { index: 2, userText: 'look at this', assistantText: 'A2' });
});

test('an absorbed message with no reply after it yet is skipped until a later Stop', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2')]);
  assert.deepEqual(out, [{ index: 0, userText: 'U1', assistantText: 'A1' }]);
});

test('back-to-back absorbed messages with no reply between them are one exchange, both texts kept in order', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2'), toolCall(), toolResult(), absorbed('U3'), reply('A23')]);
  assert.deepEqual(out, [
    { index: 0, userText: 'U1', assistantText: 'A1' },
    { index: 2, userText: 'U2\n\nU3', assistantText: 'A23' },
  ]);
});

test('a real user message followed at once by an absorbed one, before any reply, is one exchange under the first position', () => {
  const out = exchangesForStop([human('U1'), absorbed('U2'), reply('A12')]);
  assert.deepEqual(out, [{ index: 0, userText: 'U1\n\nU2', assistantText: 'A12' }]);
});

test('a queued task notification is not a start: the text after it stays with the open exchange', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), queuedNotice('<task-notification>done</task-notification>'), reply('A2')]);
  assert.deepEqual(out, [{ index: 0, userText: 'U1', assistantText: 'A1\n\nA2' }]);
});

test('an absorbed message before the last real user message is not re-recorded by this Stop', () => {
  const out = exchangesForStop([human('U0'), reply('A0'), absorbed('X'), reply('AX'), human('U1'), reply('A1')]);
  assert.deepEqual(out, [{ index: 4, userText: 'U1', assistantText: 'A1' }]);
});

test('nothing to record without a real user message', () => {
  assert.deepEqual(exchangesForStop([reply('A0'), absorbed('U2'), reply('A2')]), []);
});

// --- PR #96 review (LR 5633183222): textless boundaries, anchor advance, delivery deadline ---

test('an absorbed entry without text (empty, whitespace, missing, image only) is not a start: no reply text is lost', () => {
  for (const prompt of ['', '   ', undefined, [{ type: 'image', source: {} }]]) {
    const out = exchangesForStop([human('U1'), reply('A1'), absorbed(prompt), reply('A2')]);
    assert.deepEqual(out, [{ index: 0, userText: 'U1', assistantText: 'A1\n\nA2' }], JSON.stringify(prompt));
  }
});

test('a textless absorbed entry next to a valid one changes nothing for the valid one', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed(''), absorbed('U2'), reply('A2')]);
  assert.deepEqual(out, [
    { index: 0, userText: 'U1', assistantText: 'A1' },
    { index: 3, userText: 'U2', assistantText: 'A2' },
  ]);
});

test('an absorbed message unanswered at one Stop opens the next turn\'s exchange, under that turn\'s id', () => {
  const stop1 = [human('U1'), reply('A1'), absorbed('U2')];
  assert.deepEqual(exchangesForStop(stop1), [{ index: 0, userText: 'U1', assistantText: 'A1' }]);
  const stop2 = [...stop1, human('U3'), reply('A3')];
  assert.deepEqual(exchangesForStop(stop2), [{ index: 3, userText: 'U2\n\nU3', assistantText: 'A3' }]);
  // Union across both Stops: every source message appears exactly once.
  const all = [...exchangesForStop(stop1), ...exchangesForStop(stop2)].flatMap((e: { userText: string }) => e.userText.split('\n\n'));
  assert.deepEqual(all.sort(), ['U1', 'U2', 'U3']);
});

test('an absorbed message that was answered is never carried into a later turn', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2'), reply('A2'), human('U3'), reply('A3')]);
  assert.deepEqual(out, [{ index: 4, userText: 'U3', assistantText: 'A3' }]);
});

test('repeated anchor advances: every unanswered message is carried once, in order', () => {
  const s1 = [human('U1'), reply('A1'), absorbed('U2')];
  const s2 = [...s1, toolCall(), toolResult(), human('U3')];
  const s3 = [...s2, human('U4'), reply('A4')];
  assert.deepEqual(exchangesForStop(s1), [{ index: 0, userText: 'U1', assistantText: 'A1' }]);
  assert.deepEqual(exchangesForStop(s2), []);
  assert.deepEqual(exchangesForStop(s3), [{ index: 6, userText: 'U2\n\nU3\n\nU4', assistantText: 'A4' }]);
  const union = [s1, s2, s3].flatMap((s) => exchangesForStop(s)).flatMap((e: { userText: string }) => e.userText.split('\n\n'));
  assert.deepEqual(union.sort(), ['U1', 'U2', 'U3', 'U4']);
});

test('a runtime notice in the unanswered run is never carried into the founder text', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2'), notice('<task-notification>x</task-notification>'), human('U3'), reply('A3')]);
  assert.deepEqual(out, [{ index: 4, userText: 'U2\n\nU3', assistantText: 'A3' }]);
});

function outbox() {
  const dir = mkdtempSync(join(tmpdir(), 'stop-outbox-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const files = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
const item = (turnId: string, assistantText: string) => ({ turnId, userText: 'U', assistantText });

test('delivery stays within one deadline; what is not sent stays queued and goes at the next Stop', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'A1'));
    queueExchange(box.dir, item('cc-s-2', 'A2'));
    let clock = 0;
    const first = deliverOutbox({ outboxDir: box.dir, send: () => { clock += 18000; return true; }, now: () => clock, budgetMs: 21000 });
    assert.deepEqual(first, { sent: 1, left: 1 });
    clock = 0;
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: () => true, now: () => clock, budgetMs: 21000 }), { sent: 1, left: 0 });
    assert.deepEqual(files(box.dir), []);
  } finally { box.done(); }
});

test('a failed send keeps the exchange queued, the next one is still attempted, and a later success removes it', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'A1'));
    queueExchange(box.dir, item('cc-s-2', 'A2'));
    const seen: string[] = [];
    const flaky = (i: { turnId: string }) => { seen.push(i.turnId); return i.turnId !== 'cc-s-1'; };
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: flaky }), { sent: 1, left: 1 });
    assert.deepEqual(seen.sort(), ['cc-s-1', 'cc-s-2']);
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: () => true }), { sent: 1, left: 0 });
  } finally { box.done(); }
});

test('an interrupted replacement write keeps the earlier valid version intact and deliverable', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'old'));
    const failing = {
      writeFileSync: (p: string) => { writeFileSync(p, '{"partial":'); throw new Error('EIO'); },
      renameSync: () => { throw new Error('unreachable'); },
    };
    assert.throws(() => queueExchange(box.dir, item('cc-s-1', 'new'), failing), /EIO/);
    assert.equal(files(box.dir).length, 1); // the old version, no partial file, no leftover temp
    assert.deepEqual(readdirSync(box.dir).filter((n) => n.endsWith('.tmp')), []);
    const sent: string[] = [];
    deliverOutbox({ outboxDir: box.dir, send: (i: { assistantText: string }) => { sent.push(i.assistantText); return true; } });
    assert.deepEqual(sent, ['old']);
  } finally { box.done(); }
});

test('a newer version queued during an in-flight send survives that send', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'old'));
    const sent: string[] = [];
    const send = (i: { assistantText: string }) => {
      sent.push(i.assistantText);
      if (i.assistantText === 'old') queueExchange(box.dir, item('cc-s-1', 'new unsent'));
      return true;
    };
    deliverOutbox({ outboxDir: box.dir, send });
    assert.deepEqual(sent, ['old']);
    assert.equal(files(box.dir).length, 1); // the new version remains queued
    deliverOutbox({ outboxDir: box.dir, send });
    assert.deepEqual(sent, ['old', 'new unsent']);
    assert.deepEqual(files(box.dir), []);
  } finally { box.done(); }
});

test('only the newest version of a turn is sent; superseded versions are removed after that send', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'v1'));
    const t = Date.now() / 1000;
    utimesSync(join(box.dir, files(box.dir)[0]), t - 10, t - 10);
    queueExchange(box.dir, item('cc-s-1', 'v2'));
    assert.equal(files(box.dir).length, 2); // a producer never deletes
    const sent: string[] = [];
    deliverOutbox({ outboxDir: box.dir, send: (i: { assistantText: string }) => { sent.push(i.assistantText); return true; } });
    assert.deepEqual(sent, ['v2']);
    assert.deepEqual(files(box.dir), []);
  } finally { box.done(); }
});

test('two producers interleaved (publish A, publish B, A resumes) leave both versions; the newest is sent', () => {
  const box = outbox();
  try {
    let resumeA: (() => void) | null = null;
    const pausingIo = {
      writeFileSync,
      renameSync: (from: string, to: string) => { renameSync(from, to); resumeA = () => {}; },
    };
    queueExchange(box.dir, item('cc-s-1', 'A'), pausingIo); // A published; any cleanup would run now
    queueExchange(box.dir, item('cc-s-1', 'B')); // B published
    assert.ok(resumeA);
    queueExchange(box.dir, item('cc-s-1', 'A')); // A again (resumed or retried): an existing version is a no-op
    assert.equal(files(box.dir).length, 2); // nothing pruned by producers
    const sent: string[] = [];
    deliverOutbox({ outboxDir: box.dir, send: (i: { assistantText: string }) => { sent.push(i.assistantText); return true; } });
    assert.equal(sent.length, 1);
    assert.deepEqual(files(box.dir), []);
  } finally { box.done(); }
});

test('a version that keeps failing does not starve newer exchanges and stays for inspection', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-old', 'rejected'));
    const t = Date.now() / 1000;
    utimesSync(join(box.dir, files(box.dir)[0]), t - 60, t - 60);
    queueExchange(box.dir, item('cc-s-new', 'fresh'));
    let clock = 0;
    const sent: string[] = [];
    const send = (i: { turnId: string }) => { clock += 18000; if (i.turnId === 'cc-s-old') return false; sent.push(i.turnId); return true; };
    deliverOutbox({ outboxDir: box.dir, send, now: () => clock, budgetMs: 21000 });
    assert.deepEqual(sent, ['cc-s-new']); // newest first: the stuck one could not use the budget first
    assert.equal(files(box.dir).length, 1); // the failing version remains on disk
  } finally { box.done(); }
});

test('an unreadable superseded version is not deleted when a newer one is sent', () => {
  const box = outbox();
  try {
    writeFileSync(join(box.dir, 'cc-s-1.0000000000000000.json'), '{bad');
    const t = Date.now() / 1000;
    utimesSync(join(box.dir, 'cc-s-1.0000000000000000.json'), t - 10, t - 10);
    queueExchange(box.dir, item('cc-s-1', 'good'));
    deliverOutbox({ outboxDir: box.dir, send: () => true });
    assert.deepEqual(files(box.dir), ['cc-s-1.0000000000000000.json']);
  } finally { box.done(); }
});

test('a concurrent drainer removing files mid-drain causes no failure', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'A1'));
    queueExchange(box.dir, item('cc-s-2', 'A2'));
    const other = files(box.dir);
    const send = () => { for (const n of other) rmSync(join(box.dir, n), { force: true }); return true; };
    assert.doesNotThrow(() => deliverOutbox({ outboxDir: box.dir, send }));
    assert.deepEqual(files(box.dir), []);
  } finally { box.done(); }
});

test('queueing the same version twice is a no-op', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, item('cc-s-1', 'A1'));
    queueExchange(box.dir, item('cc-s-1', 'A1'));
    assert.equal(files(box.dir).length, 1);
  } finally { box.done(); }
});

test('an unreadable outbox file is left in place, never deleted unseen', () => {
  const box = outbox();
  try {
    writeFileSync(join(box.dir, 'cc-s-bad.0000000000000000.json'), '{not json');
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: () => true }), { sent: 0, left: 1 });
    assert.ok(existsSync(join(box.dir, 'cc-s-bad.0000000000000000.json')));
  } finally { box.done(); }
});

test('a missing outbox directory is nothing to deliver', () => {
  assert.deepEqual(deliverOutbox({ outboxDir: join(tmpdir(), 'no-such-outbox-dir-xyz'), send: () => true }), { sent: 0, left: 0 });
});

// --- Runtime-opened turns (PR #81 on top of the absorbed-message recorder) ---
// A turn the runtime opened is never recorded as David's words. Its reply goes
// with David's messages still unanswered before it (founder decision C), and
// otherwise stays in the transcript only. Absorbed messages after it are kept.

test('a turn opened by a task notice, with nothing of David unanswered, records nothing', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), notice('<task-notification>ci</task-notification>'), reply('CI passed.')]);
  assert.deepEqual(out, []);
});

test('a notice-opened reply goes with David\'s unanswered message before it, never with the notice text', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), absorbed('U2'), notice('<task-notification>ci</task-notification>'), reply('A2')]);
  assert.deepEqual(out, [{ index: 3, userText: 'U2', assistantText: 'A2' }]);
});

test('David\'s message absorbed after a notice is recorded under its own position; the notice reply before it is not', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), notice('<task-notification>ci</task-notification>'), reply('CI passed.'), absorbed('U2'), reply('A2')]);
  assert.deepEqual(out, [{ index: 4, userText: 'U2', assistantText: 'A2' }]);
});

test('David\'s message absorbed right after a notice, before any reply, takes its own id, not the notice\'s', () => {
  const out = exchangesForStop([human('U1'), reply('A1'), notice('<task-notification>ci</task-notification>'), absorbed('U2'), reply('A2')]);
  assert.deepEqual(out, [{ index: 3, userText: 'U2', assistantText: 'A2' }]);
});

test('a system-reminder turn (promptSource system, no origin) records nothing', () => {
  const reminder = { type: 'user', promptSource: 'system', message: { content: '<system-reminder>x</system-reminder>' } };
  assert.deepEqual(exchangesForStop([human('U1'), reply('A1'), reminder, reply('A2')]), []);
});

test('a peer session\'s message is not recorded as David', () => {
  const peer = { type: 'user', origin: { kind: 'peer' }, message: { content: 'Another Claude session sent a message' } };
  assert.deepEqual(exchangesForStop([human('U1'), reply('A1'), peer, reply('A2')]), []);
});

test('image metadata right after David\'s message folds back to it; an absorbed message after still gets its own exchange', () => {
  const imageMeta = { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '[Image: source: /tmp/x.png]' }] } };
  const out = exchangesForStop([human('look at this'), imageMeta, reply('I see it.'), absorbed('and this'), reply('Yes.')]);
  assert.deepEqual(out, [
    { index: 0, userText: 'look at this', assistantText: 'I see it.' },
    { index: 3, userText: 'and this', assistantText: 'Yes.' },
  ]);
});

test('a founder paste that looks like a notice is still David\'s (provenance decides, not text)', () => {
  const out = exchangesForStop([human('<task-notification>pasted</task-notification>'), reply('That is a notice.')]);
  assert.deepEqual(out, [{ index: 0, userText: '<task-notification>pasted</task-notification>', assistantText: 'That is a notice.' }]);
});

// --- PR #81 review (LR 5635424280): carried entries follow classifyUserEntry's precedence ---

const humanMeta = (text: string) => ({ ...human(text), isMeta: true });

test('runtime metadata marked origin human is never carried into a runtime-opened turn', () => {
  const out = exchangesForStop([human('prior'), reply('prior reply'), humanMeta('runtime metadata'), notice('<task-notification>n</task-notification>'), reply('runtime reply')]);
  assert.deepEqual(out, []);
});

test('runtime metadata marked origin human is never carried into David\'s next message', () => {
  const out = exchangesForStop([human('prior'), reply('prior reply'), humanMeta('runtime metadata'), human('new human'), reply('new reply')]);
  assert.deepEqual(out, [{ index: 3, userText: 'new human', assistantText: 'new reply' }]);
});

test('a genuine unanswered human message next to runtime metadata still carries, in order, under the anchor index', () => {
  const out = exchangesForStop([human('prior'), reply('prior reply'), human('unanswered'), humanMeta('runtime metadata'), absorbed('also mine'), notice('<task-notification>n</task-notification>'), reply('reply to David')]);
  assert.deepEqual(out, [{ index: 5, userText: 'unanswered\n\nalso mine', assistantText: 'reply to David' }]);
});

test('a compaction summary marked origin human is never carried', () => {
  const summary = { ...human('This session is being continued from a previous conversation...'), isCompactSummary: true };
  const out = exchangesForStop([human('prior'), reply('prior reply'), summary, human('next'), reply('next reply')]);
  assert.deepEqual(out, [{ index: 3, userText: 'next', assistantText: 'next reply' }]);
});
