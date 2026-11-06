/**
 * F3 (live-test-1 debrief, design note 135fe51b rev 2): a dropped voice connection
 * must leave a recorded cause. Unit-tests the cause classifier and guards the three
 * wiring points (adapter, session close handler, Gemini Live close handler).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeDisconnect } from '../services/voice-disconnect-cause';

test('a server-initiated close names the server and keeps its code and reason', () => {
  assert.deepEqual(describeDisconnect({ code: 4000, reason: 'Replaced by new connection' }, 'server namespace disconnect'), {
    initiator: 'server',
    serverCode: 4000,
    serverReason: 'Replaced by new connection',
    socketReason: 'server namespace disconnect',
  });
});

test('otherwise the socket reason names the client or network side', () => {
  for (const reason of ['transport close', 'ping timeout', 'client namespace disconnect', 'transport error']) {
    assert.equal(describeDisconnect(null, reason).initiator, 'client_or_network');
  }
});

test('with nothing known the cause stays explicitly unknown', () => {
  assert.deepEqual(describeDisconnect(null, null), {
    initiator: 'unknown', serverCode: null, serverReason: null, socketReason: null,
  });
});

test('reasons are bounded and stripped of control characters', () => {
  const cause = describeDisconnect({ code: 1011, reason: 'a\nb\u0000' + 'x'.repeat(500) }, null);
  assert.equal(cause.serverReason!.length, 200);
  assert.doesNotMatch(cause.serverReason!, /[\u0000-\u001f]/);
});

test('wiring: adapter records both sides, both close paths persist an event', () => {
  const ws = readFileSync(new URL('../unified-ws-handler.ts', import.meta.url), 'utf8');
  assert.match(ws, /socket\.on\('disconnect', \(reason: string\) => \{\s*this\.socketDisconnectReason =/);
  assert.match(ws, /close\(code\?: number, reason\?: string\): void \{\s*this\.serverClose = \{/);
  assert.match(ws, /'client_socket_disconnected'/);
  const gl = readFileSync(new URL('../services/gemini-live-session.ts', import.meta.url), 'utf8');
  const onclose = gl.slice(gl.indexOf('onclose: async (event: any) => {'), gl.indexOf('const isQuotaError'));
  assert.match(onclose, /'gl_session_closed'/);
});
