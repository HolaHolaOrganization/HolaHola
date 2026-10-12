import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { WindowsIdentityReader, WINDOWS_IDENTITY_SCRIPT } from './coordination-listener-windows-reader';
import { parentState } from './coordination-listener-identity';

const created = '2026-10-10T01:02:03.1234560Z';
function fixture(t: any, options: { startupMs?: number; queryMs?: number; readyMs?: number;
  answer?: (query: any, child: any) => void } = {}) {
  const children: any[] = [], calls: any[] = [];
  const spawnImpl = ((...args: any[]) => {
    calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.requests = [];
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const [id, pid] = String(chunk).trim().split('|').map(Number);
      const q = { id, pid }; child.requests.push(q);
      callback();
      options.answer?.(q, child);
    } });
    child.killCount = 0; child.kill = () => { child.killCount++; return true; }; child.unref = () => {};
    children.push(child);
    if (options.readyMs !== undefined) setTimeout(() => child.stdout.write('{"ready":true}\n'), options.readyMs);
    else setImmediate(() => child.stdout.write('{"ready":true}\n'));
    return child;
  }) as typeof spawn;
  const reader = new WindowsIdentityReader('powershell.exe', {
    spawnImpl, startupMs: options.startupMs ?? 100, queryMs: options.queryMs ?? 100,
  });
  t.after(() => reader.close());
  return { reader, children, calls };
}
const answer = (q: any, child: any) => child.stdout.write(JSON.stringify({ id: q.id, state: 'present', created }) + '\n');

test('cold startup uses its own budget, then warm requests reuse one worker', async t => {
  const { reader, children, calls } = fixture(t, { readyMs: 20, startupMs: 100, queryMs: 5, answer });
  assert.deepEqual(await reader.query(123), { state: 'present', created });
  assert.deepEqual(await reader.query(124), { state: 'present', created });
  assert.equal(children.length, 1); assert.equal(children[0].requests.length, 2);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][1].includes('-ExecutionPolicy'), false);
  assert.match(WINDOWS_IDENTITY_SCRIPT, /GetProcessById/);
  assert.doesNotMatch(WINDOWS_IDENTITY_SCRIPT, /Get-CimInstance|Bypass|Stop-Process/);
  assert.match(WINDOWS_IDENTITY_SCRIPT, /Ticks % 10/);
});
test('concurrent queries are serialized and never cross-attribute PID responses', async t => {
  const { reader, children } = fixture(t, { answer: (q, child) =>
    setTimeout(() => child.stdout.write(JSON.stringify({ id: q.id, state: q.pid === 123 ? 'absent' : 'unknown' }) + '\n'), 5) });
  assert.deepEqual(await Promise.all([reader.query(123), reader.query(124)]), [{ state: 'absent' }, { state: 'unknown' }]);
  assert.deepEqual(children[0].requests.map((q: any) => q.pid), [123, 124]);
});
test('startup timeout stays unknown and stops only its owned helper', async t => {
  const { reader, children } = fixture(t, { readyMs: 25, startupMs: 5 });
  assert.deepEqual(await reader.query(123), { state: 'unknown' });
  assert.equal(children[0].killCount, 1);
});
test('request timeout kills the helper, and a later query restarts cleanly', async t => {
  let answers = false;
  const { reader, children } = fixture(t, { queryMs: 5, answer: (q, child) => { if (answers) answer(q, child); } });
  assert.deepEqual(await reader.query(123), { state: 'unknown' });
  answers = true;
  assert.deepEqual(await reader.query(123), { state: 'present', created });
  assert.equal(children.length, 2); assert.equal(children[0].killCount, 1);
});
test('repeated unknown responses never establish absence and do not cache PID identity', async t => {
  let count = 0;
  const { reader } = fixture(t, { answer: (q, child) => child.stdout.write(JSON.stringify({
    id: q.id, state: ++count < 3 ? 'unknown' : 'present', created: created.replace('123456', '654321'),
  }) + '\n') });
  const parent = { pid: 123, created };
  assert.equal(await parentState(parent, pid => reader.query(pid)), 'unknown');
  assert.equal(await parentState(parent, pid => reader.query(pid)), 'unknown');
  assert.equal(await parentState(parent, pid => reader.query(pid)), 'absent');
});
test('wrong correlation, malformed JSON, invalid dates and oversize output fail closed', async t => {
  for (const response of ['not-json\n', '{"id":999,"state":"absent"}\n',
    '{"id":1,"state":"present","created":"2026-99-10T01:02:03.1234560Z"}\n', 'x'.repeat(5000)]) {
    const { reader, children } = fixture(t, { answer: (_q, child) => child.stdout.write(response) });
    assert.deepEqual(await reader.query(123), { state: 'unknown' });
    assert.equal(children[0].killCount, 1);
  }
});
test('stderr and spawn errors are bounded, sanitized unknown results', async t => {
  const noisy = fixture(t, { answer: (_q, child) => child.stderr.write('PRIVATE'.repeat(1000)) });
  assert.deepEqual(await noisy.reader.query(123), { state: 'unknown' });
  const broken = new WindowsIdentityReader('missing', { spawnImpl: (() => { throw Error('PRIVATE'); }) as typeof spawn });
  assert.deepEqual(await broken.query(123), { state: 'unknown' });
  broken.close();
});
test('invalid PID, queue overflow and explicit close do not launch more helpers', async t => {
  const { reader, children } = fixture(t);
  assert.deepEqual(await reader.query(-1), { state: 'unknown' });
  assert.deepEqual(await reader.query(2 ** 40), { state: 'unknown' });
  assert.equal(children.length, 0);
  const pending = Array.from({ length: 32 }, () => reader.query(123));
  assert.deepEqual(await reader.query(123), { state: 'unknown' });
  reader.close();
  assert.equal((await Promise.all(pending)).every(x => x.state === 'unknown'), true);
  assert.deepEqual(await reader.query(123), { state: 'unknown' });
});
