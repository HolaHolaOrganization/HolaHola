/** Agent feed F-P3 client: ordering, budget and fail-open behavior against a fake transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptNotice, renderBootstrap, renderItem, sessionStart, type Transport } from './agent-feed-client';
// @ts-expect-error -- plain ESM hook script without type declarations
import { feedCommand } from '../../.claude/hooks/agent-feed.mjs';

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, sha256: 'a'.repeat(64), source: ['source-replit'], createdAt: '2026-10-23T18:00:00.000Z',
  excerpt: `excerpt ${id}`, clipped: null, changed: false, ...extra,
});

/** A fake transport that records every call, in order, alongside what was printed. */
function fake(responses: Record<string, Record<string, unknown> | Error>) {
  const log: string[] = [];
  const transport: Transport = async (path, body) => {
    log.push(`call:${path}:${JSON.stringify(body)}`);
    const r = responses[path];
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  const print = (text: string) => { log.push(`print:${text}`); };
  return { log, transport, print };
}

test('renderItem states source, time, row id and clipping', () => {
  const text = renderItem(item('r1', { clipped: { shown: 400, total: 2000 }, changed: true }) as never);
  assert.match(text, /Luca \[Replit\], 2026-10-23T18:00Z, row r1 \(changed since you last saw it\)/);
  assert.match(text, /\[clipped at 400 of 2000 chars\]$/);
});

test('renderBootstrap is empty with nothing to show, and says when more is pending', () => {
  assert.equal(renderBootstrap({ items: [] }), '');
  assert.match(renderBootstrap({ items: [item('r1') as never], morePending: true }), /More is pending/);
});

test('session start prints the bootstrap, then acknowledges exactly the served items', async () => {
  const f = fake({
    register: { registrationId: 'reg1' },
    bootstrap: { servedId: 's1', items: [item('r1'), item('r2')], morePending: false },
    ack: { acknowledged: 2 },
  });
  await sessionStart(f.transport, 'sess', f.print);
  const order = f.log.map((l) => l.split(':')[0] + ':' + l.split(':')[1]);
  assert.deepEqual(order, ['call:register', 'call:bootstrap', 'print:Agent feed', 'call:ack']);
  assert.match(f.log[3], /"servedId":"s1"/);
  assert.match(f.log[3], /"id":"r1".*"id":"r2"/);
});

test('session start with nothing pending prints nothing and acknowledges nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, bootstrap: { servedId: 's1', items: [] } });
  await sessionStart(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('print:') || l.startsWith('call:ack')));
});

test('a refused bootstrap (already used this epoch) prints nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, bootstrap: new Error('bootstrap returned 409') });
  await assert.rejects(() => sessionStart(f.transport, 'sess', f.print), /409/);
  assert.ok(!f.log.some((l) => l.startsWith('print:')));
});

test('prompt: an empty peek takes no notice and prints nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [], more: 0, attemptsLeft: 12 } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.deepEqual(f.log.map((l) => l.split(':').slice(0, 2).join(':')), ['call:register', 'call:peek']);
});

test('prompt: with the allowance used up, no notice is attempted', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [{ id: 'r1' }], more: 0, attemptsLeft: 0 } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('call:notice')));
});

test('prompt: the notice is debited, printed, and only then recorded seen', async () => {
  const f = fake({
    register: { registrationId: 'reg1' },
    peek: { manifest: [{ id: 'r1' }], more: 0, attemptsLeft: 3 },
    notice: { attemptId: 'n1', body: 'Other hats: 1 new exchange(s). Fetch by id.' },
    'notice-seen': { recorded: 1 },
  });
  await promptNotice(f.transport, 'sess', f.print);
  assert.deepEqual(f.log.map((l) => l.split(':').slice(0, 2).join(':')),
    ['call:register', 'call:peek', 'call:notice', 'print:Other hats', 'call:notice-seen']);
});

test('prompt: a notice that returns no body prints nothing and records nothing', async () => {
  const f = fake({ register: { registrationId: 'reg1' }, peek: { manifest: [{ id: 'r1' }], attemptsLeft: 3 }, notice: { attemptId: null, body: null } });
  await promptNotice(f.transport, 'sess', f.print);
  assert.ok(!f.log.some((l) => l.startsWith('print:') || l.startsWith('call:notice-seen')));
});

test('hook maps only SessionStart and UserPromptSubmit, with a valid session id', () => {
  assert.equal(feedCommand({ hook_event_name: 'SessionStart', session_id: 'abc-123' }, '/r').args.at(-3), 'session-start');
  assert.equal(feedCommand({ hook_event_name: 'UserPromptSubmit', session_id: 'abc-123' }, '/r').args.at(-3), 'prompt');
  assert.equal(feedCommand({ hook_event_name: 'Stop', session_id: 'abc-123' }, '/r'), null);
  assert.equal(feedCommand({ hook_event_name: 'SessionStart', session_id: 'bad id!' }, '/r'), null);
  assert.equal(feedCommand(null, '/r'), null);
});
