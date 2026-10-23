import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function outbox() {
  const dir = mkdtempSync(join(tmpdir(), 'stop-outbox-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('delivery stays within one deadline; what is not sent stays queued and goes at the next Stop', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, { turnId: 'cc-s-1', userText: 'U1', assistantText: 'A1' });
    queueExchange(box.dir, { turnId: 'cc-s-2', userText: 'U2', assistantText: 'A2' });
    let clock = 0;
    const slowSend = () => { clock += 18000; return true; }; // each send takes 18 s
    const first = deliverOutbox({ outboxDir: box.dir, send: slowSend, now: () => clock, budgetMs: 21000 });
    assert.deepEqual(first, { sent: 1, left: 1 });
    assert.equal(readdirSync(box.dir).length, 1);
    clock = 0;
    const second = deliverOutbox({ outboxDir: box.dir, send: () => true, now: () => clock, budgetMs: 21000 });
    assert.deepEqual(second, { sent: 1, left: 0 });
    assert.equal(readdirSync(box.dir).length, 0);
  } finally { box.done(); }
});

test('a failed send keeps the exchange queued; a later success removes it', () => {
  const box = outbox();
  try {
    queueExchange(box.dir, { turnId: 'cc-s-1', userText: 'U1', assistantText: 'A1' });
    queueExchange(box.dir, { turnId: 'cc-s-2', userText: 'U2', assistantText: 'A2' });
    const seen: string[] = [];
    const flaky = (item: { turnId: string }) => { seen.push(item.turnId); return item.turnId !== 'cc-s-1'; };
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: flaky }), { sent: 1, left: 1 });
    assert.deepEqual(seen.sort(), ['cc-s-1', 'cc-s-2']); // the failure did not stop the next send
    assert.ok(existsSync(join(box.dir, 'cc-s-1.json')));
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: () => true }), { sent: 1, left: 0 });
  } finally { box.done(); }
});

test('an unreadable outbox file is left in place, never deleted unseen', () => {
  const box = outbox();
  try {
    writeFileSync(join(box.dir, 'cc-s-bad.json'), '{not json');
    assert.deepEqual(deliverOutbox({ outboxDir: box.dir, send: () => true }), { sent: 0, left: 1 });
    assert.ok(existsSync(join(box.dir, 'cc-s-bad.json')));
  } finally { box.done(); }
});

test('a missing outbox directory is nothing to deliver', () => {
  assert.deepEqual(deliverOutbox({ outboxDir: join(tmpdir(), 'no-such-outbox-dir-xyz'), send: () => true }), { sent: 0, left: 0 });
});
