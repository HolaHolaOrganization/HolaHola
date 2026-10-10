import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { fetchListenerInbox } from './coordination-listener-transport';
const scope = { actor: 'luca-replit', apiUrl: 'https://example.com' };

function fakeChild(action: (child: any) => void) {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.killedCount = 0;
  child.kill = () => { child.killedCount++; return true; };
  const calls: any[] = [];
  const spawnImpl = ((...args: any[]) => {
    calls.push(args);
    setImmediate(() => action(child));
    return child;
  }) as typeof spawn;
  return { child, calls, spawnImpl };
}
test('direct Node transport has no shell, actor is explicit, no body logging', async () => {
  const { calls, child, spawnImpl } = fakeChild(child => {
    child.stdout.write('{"actor":"luca-replit","items":[]}'); child.emit('close', 0);
  });
  const result = await fetchListenerInbox(scope, 5, undefined, new AbortController().signal, { spawnImpl });
  assert.equal(result.actor, scope.actor);
  const [exe, args, options] = calls[0];
  assert.equal(exe, process.execPath); assert.deepEqual(args.slice(0, 2), ['--import', 'tsx']);
  assert.deepEqual(args.slice(-2), ['--after', '5']);
  assert.equal(options.shell, false); assert.equal(options.env.COORDINATION_ACTOR, scope.actor);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']); assert.equal(child.killedCount, 1);
});
test('continuation token replaces after, without shell interpretation', async () => {
  const { calls, spawnImpl } = fakeChild(child => { child.stdout.write('{}'); child.emit('close', 0); });
  await fetchListenerInbox(scope, 5, 'opaque&token', new AbortController().signal, { spawnImpl });
  assert.deepEqual(calls[0][1].slice(-2), ['--token', 'opaque&token']);
  assert.equal(calls[0][1].includes('--after'), false);
});
test('nonzero, malformed JSON, oversize and spawn errors are sanitized failures', async () => {
  const cases: [(child: any) => void, string][] = [
    [child => { child.stdout.write('PRIVATE'); child.emit('close', 1); }, 'request_failed'],
    [child => { child.stdout.write('PRIVATE'); child.emit('close', 0); }, 'invalid_json'],
    [child => { child.stdout.write('PRIVATE'.repeat(100)); }, 'output_limit'],
    [child => { child.emit('error', Error('PRIVATE')); }, 'spawn_failed'],
  ];
  for (const [action, expected] of cases) {
    const { spawnImpl, child } = fakeChild(action);
    await assert.rejects(fetchListenerInbox(scope, 5, undefined, new AbortController().signal,
      { spawnImpl, maxOutputBytes: 100 }), new RegExp(expected));
    assert.equal(child.killedCount, 1);
  }
});
test('timeout and signal abort terminate only the owned subprocess', async () => {
  const timeout = fakeChild(() => {});
  await assert.rejects(fetchListenerInbox(scope, 5, undefined, new AbortController().signal,
    { spawnImpl: timeout.spawnImpl, timeoutMs: 1 }), /inbox_timeout/);
  assert.equal(timeout.child.killedCount, 1);
  const controller = new AbortController();
  const abort = fakeChild(() => controller.abort());
  await assert.rejects(fetchListenerInbox(scope, 5, undefined, controller.signal,
    { spawnImpl: abort.spawnImpl }), /inbox_aborted/);
  assert.equal(abort.child.killedCount, 1);
});
test('already aborted signal does not spawn anything', async () => {
  const controller = new AbortController(); controller.abort();
  const { spawnImpl, calls } = fakeChild(() => {});
  await assert.rejects(fetchListenerInbox(scope, 5, undefined, controller.signal, { spawnImpl }), /inbox_aborted/);
  assert.equal(calls.length, 0);
});
