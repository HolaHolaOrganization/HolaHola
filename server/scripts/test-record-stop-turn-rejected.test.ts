/**
 * A version the canonical record permanently rejects (it already holds
 * different text under that turn id) is kept aside, never retried, and
 * reported where the founder sees it. Every other failure stays pending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM hook script without type declarations
import { deliverOutbox, queueExchange, rejectedStatusMessage } from '../../.claude/hooks/record-stop-turn.mjs';
import { CHANGED_CONTENT_REJECTION_EXIT, isChangedContentRejection } from './record-exchange';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/record-stop-turn.mjs', import.meta.url));
const REASON = 'already has different assistant text';
const item = (turnId: string, assistantText: string) => ({ turnId, userText: 'U', assistantText });

function box() {
  const root = mkdtempSync(join(tmpdir(), 'stop-rejected-'));
  return { root, outbox: join(root, 'outbox'), rejected: join(root, 'rejected'), done: () => rmSync(root, { recursive: true, force: true }) };
}
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : []);

test('only the exact changed-content 409 is permanent', () => {
  assert.equal(CHANGED_CONTENT_REJECTION_EXIT, 3);
  assert.equal(isChangedContentRejection(409, 'canonical conversation turn cc-s-1 already has different assistant text'), true);
  assert.equal(isChangedContentRejection(409, 'canonical conversation turn cc-s-1 already has different user text'), true);
  assert.equal(isChangedContentRejection(409, 'canonical conversation capture is busy'), false);
  assert.equal(isChangedContentRejection(409, 'canonical conversation turn cc-s-1 already belongs to a different or legacy source'), false);
  assert.equal(isChangedContentRejection(500, 'canonical conversation turn cc-s-1 already has different assistant text'), false);
  assert.equal(isChangedContentRejection(409, 'prefix canonical conversation turn cc-s-1 already has different assistant text'), false);
  assert.equal(isChangedContentRejection(409, undefined), false);
});

test('a rejected version is kept complete with its reason, leaves the outbox, and is not retried', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    let calls = 0;
    const reject = () => { calls++; return { rejected: REASON }; };
    assert.deepEqual(deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: reject }), { sent: 0, left: 0, rejected: 1 });
    const [kept] = list(b.rejected);
    const saved = JSON.parse(readFileSync(join(b.rejected, kept), 'utf8'));
    assert.equal(saved.turnId, 'cc-s-1');
    assert.equal(saved.userText, 'U');
    assert.equal(saved.assistantText, 'changed');
    assert.equal(saved.reason, REASON);
    assert.match(saved.rejectedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: reject }), { sent: 0, left: 0, rejected: 0 });
    assert.equal(calls, 1);
  } finally { b.done(); }
});

// LR review 5635795040: main() queues every exchange it sees before each drain.
test('across repeated Stops (queue, then drain), a rejected version is sent once and never requeued', () => {
  const b = box();
  try {
    let calls = 0;
    const reject = () => { calls++; return { rejected: REASON }; };
    for (let stop = 0; stop < 3; stop++) {
      queueExchange(b.outbox, item('cc-s-1', 'changed'));
      deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: reject });
    }
    assert.equal(calls, 1);
    assert.deepEqual(list(b.outbox), []);
    assert.equal(list(b.rejected).length, 1);
  } finally { b.done(); }
});

test('an outbox copy of an already retained version, queued concurrently, is dropped without being sent', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => ({ rejected: REASON }) });
    // another hook process queues the same version without having seen the
    // rejection yet (its check ran before the retained copy appeared)
    queueExchange(b.outbox, item('cc-s-1', 'changed'), undefined, join(b.root, 'not-yet-visible'));
    assert.equal(list(b.outbox).length, 1);
    let calls = 0;
    const r = deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => { calls++; return true; } });
    assert.equal(calls, 0);
    assert.deepEqual(r, { sent: 0, left: 0, rejected: 0 });
    assert.equal(list(b.rejected).length, 1, 'the retained copy is kept');
  } finally { b.done(); }
});

test('a different version of a rejected turn is still queued and sent', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => ({ rejected: REASON }) });
    queueExchange(b.outbox, item('cc-s-1', 'changed again'));
    const sent: string[] = [];
    const r = deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: (i: { assistantText: string }) => { sent.push(i.assistantText); return true; } });
    assert.deepEqual(sent, ['changed again']);
    assert.deepEqual(r, { sent: 1, left: 0, rejected: 0 });
  } finally { b.done(); }
});

test('when retention failed, the next Stop still queues and retries the pending original', () => {
  const b = box();
  try {
    const failingIo = { writeFileSync: () => { throw new Error('ENOSPC'); }, renameSync: () => { throw new Error('unreachable'); } };
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => ({ rejected: REASON }), io: failingIo });
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    let calls = 0;
    deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => { calls++; return { rejected: REASON }; } });
    assert.equal(calls, 1);
    assert.equal(list(b.rejected).length, 1, 'retained on the attempt that could write it');
    assert.deepEqual(list(b.outbox), []);
  } finally { b.done(); }
});

test('if the rejected copy cannot be written, the original stays pending', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'changed'));
    const failingIo = { writeFileSync: () => { throw new Error('ENOSPC'); }, renameSync: () => { throw new Error('unreachable'); } };
    const r = deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => ({ rejected: REASON }), io: failingIo });
    assert.deepEqual(r, { sent: 0, left: 1, rejected: 0 });
    assert.deepEqual(readdirSync(b.rejected), [], 'no rejected copy and no temporary file is left behind');
  } finally { b.done(); }
});

test('a transient failure stays pending and is never moved aside', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'x'));
    assert.deepEqual(deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: () => false }), { sent: 0, left: 1, rejected: 0 });
    assert.deepEqual(list(b.rejected), []);
  } finally { b.done(); }
});

test('rejecting the newest version leaves older versions of that turn queued', () => {
  const b = box();
  try {
    queueExchange(b.outbox, item('cc-s-1', 'older'));
    const t = Date.now() / 1000;
    for (const n of list(b.outbox)) utimesSync(join(b.outbox, n), t - 10, t - 10);
    queueExchange(b.outbox, item('cc-s-1', 'newer'));
    const r = deliverOutbox({ outboxDir: b.outbox, rejectedDir: b.rejected, send: (i: { assistantText: string }) => (i.assistantText === 'newer' ? { rejected: REASON } : true) });
    assert.deepEqual(r, { sent: 0, left: 1, rejected: 1 });
    assert.equal(JSON.parse(readFileSync(join(b.outbox, list(b.outbox)[0]), 'utf8')).assistantText, 'older');
  } finally { b.done(); }
});

test('the founder-visible status names the unresolved count, and is silent when there is none', () => {
  const rejectedDir = mkdtempSync(join(tmpdir(), 'stop-rejected-status-'));
  try {
    assert.equal(rejectedStatusMessage(join(rejectedDir, 'absent')), null);
    assert.equal(rejectedStatusMessage(rejectedDir), null);
    writeFileSync(join(rejectedDir, 'cc-s-1.0000000000000000.json'), '{}');
    writeFileSync(join(rejectedDir, 'cc-s-2.0000000000000000.json'), '{}');
    assert.match(rejectedStatusMessage(rejectedDir) ?? '', /^Turn recorder: 2 exchange version\(s\) were rejected/);
  } finally { rmSync(rejectedDir, { recursive: true, force: true }); }
});

/**
 * Run the real hook with a fake npx (POSIX and Windows) first on PATH that
 * answers like record-exchange with the given exit code. The transcript and
 * the fake live in their own temporary directory, removed afterwards.
 */
function runRealHook(b: ReturnType<typeof box>, exitCode: number, stderr: string) {
  const work = mkdtempSync(join(tmpdir(), 'stop-rejected-hook-'));
  writeFileSync(join(work, 'npx'), `#!/bin/sh\necho ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`, { mode: 0o755 });
  writeFileSync(join(work, 'npx.cmd'), `@echo off\r\necho ${stderr} 1>&2\r\nexit /b ${exitCode}\r\n`);
  writeFileSync(join(work, 'transcript.jsonl'), [
    { type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { content: 'hello' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  try {
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ transcript_path: join(work, 'transcript.jsonl'), session_id: '11111111-1111-4111-8111-111111111111' }),
      env: { ...process.env, PATH: `${work}${delimiter}${process.env.PATH ?? ''}`, HOLAHOLA_STOP_HOOK_URL: 'http://127.0.0.1:9', HOLAHOLA_STOP_HOOK_OUTBOX: b.outbox },
      encoding: 'utf8', timeout: 60_000,
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test('through the real hook: an exit-3 rejection is kept aside and reported in a systemMessage', () => {
  const b = box();
  try {
    const r = runRealHook(b, 3, '[record-exchange] ERROR: Remote endpoint rejected the exchange (409): canonical conversation turn cc-x already has different assistant text');
    assert.equal(r.status, 0);
    assert.deepEqual(list(b.outbox), []);
    assert.equal(list(b.rejected).length, 1);
    assert.equal(JSON.parse(readFileSync(join(b.rejected, list(b.rejected)[0]), 'utf8')).reason, REASON);
    assert.match(JSON.parse(r.stdout).systemMessage, /1 exchange version\(s\) were rejected/);
  } finally { b.done(); }
});

test('through the real hook: an ordinary failure stays queued, with no systemMessage', () => {
  const b = box();
  try {
    const r = runRealHook(b, 1, '[record-exchange] ERROR: Remote POST failed: fetch failed');
    assert.equal(r.status, 0);
    assert.equal(list(b.outbox).length, 1);
    assert.deepEqual(list(b.rejected), []);
    assert.equal(r.stdout, '');
  } finally { b.done(); }
});
