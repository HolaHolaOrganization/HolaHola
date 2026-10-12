import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ListenerStore, normalizeScope, pageReceipts, runListener, type InboxPage } from './coordination-listener';
import { parentState, readProcessIdentity } from './coordination-listener-identity';
import { listenerErrorCode } from '../coordination-listener';
import { randomUUID } from 'node:crypto';

const scope = { actor: 'luca-replit', apiUrl: 'https://example.com' };
const event = '10000000-0000-4000-8000-000000000001';
const thread = '20000000-0000-4000-8000-000000000001';
const receipt = { eventId: event, sequence: 2, threadId: thread, sender: 'luca-claude-code' };
function page(id = event, sequence = 2): InboxPage {
  return { actor: scope.actor, items: [{ inboxItem: { recipientActor: scope.actor,
    eventGlobalSequence: sequence, senderActor: receipt.sender }, event: { id }, thread: { id: thread } }],
  window: { through: 3, complete: true }, core: { complete: true }, legacyCoverage: { complete: false } };
}
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'luca-listener-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new ListenerStore(dir, scope);
}
async function once(store: ListenerStore, inbox: (after: number, token?: string) => Promise<InboxPage>,
  extra: Partial<Parameters<typeof runListener>[0]> = {}) {
  const lines: string[] = [];
  await runListener({ store, mode: 'once', initialAfter: 1, signal: new AbortController().signal,
    inbox, emit: line => lines.push(line), sleep: async () => {}, ...extra });
  return lines;
}

test('scope is actor/origin bound and rejects credential-bearing URLs', () => {
  assert.deepEqual(normalizeScope({ ...scope, apiUrl: 'https://example.com/' }), scope);
  for (const url of ['https://x:y@example.com', 'https://example.com/path', 'file:///x', 'https://example.com?q=token']) {
    assert.throws(() => normalizeScope({ ...scope, apiUrl: url }));
  }
});
test('metadata-only receipts exclude arbitrary message bodies', () => {
  const p = page() as any;
  p.items[0].event.content = 'PRIVATE';
  p.items[0].thread.description = 'PRIVATE';
  assert.deepEqual(pageReceipts(p, scope.actor, 1), [receipt]);
  assert.equal(JSON.stringify(pageReceipts(p, scope.actor, 1)).includes('PRIVATE'), false);
});
test('reject wrong actor, malformed continuation, bounds, IDs and recipient', () => {
  const mutations = [
    (p: any) => { p.actor = 'alden'; },
    (p: any) => { p.window.through = 0; },
    (p: any) => { p.window.complete = false; },
    (p: any) => { p.items[0].inboxItem.recipientActor = 'alden'; },
    (p: any) => { p.items[0].inboxItem.eventGlobalSequence = 1; },
    (p: any) => { p.items[0].inboxItem.eventGlobalSequence = 4; },
    (p: any) => { p.items[0].event.id = '../x'; },
    (p: any) => { p.items[0].thread.id = 'x'; },
  ];
  for (const mutate of mutations) { const p = page(); mutate(p); assert.throws(() => pageReceipts(p, scope.actor, 1)); }
});
test('initial cursor required; failed initialization releases lock', async t => {
  const store = await fixture(t);
  await assert.rejects(store.acquire(), /initial_cursor_required/);
  assert.equal((await readdir(store.directory)).includes('watch.lock'), false);
});
test('exclusive ownership; release cannot remove another owner lock', async t => {
  const store = await fixture(t);
  await store.acquire(1);
  const other = new ListenerStore(store.directory, scope);
  await assert.rejects(other.acquire(1), /EEXIST/);
  const old = await readFile(join(store.directory, 'watch.lock'), 'utf8');
  await writeFile(join(store.directory, 'watch.lock'), '{"owner":"different"}');
  await assert.rejects(store.release(), /lock_owner_changed/);
  await writeFile(join(store.directory, 'watch.lock'), old);
  await store.release();
});
test('saved state cannot be read or adopted by another actor or origin', async t => {
  const store = await fixture(t); await store.acquire(1); await store.release();
  for (const otherScope of [{ ...scope, actor: 'alden' }, { ...scope, apiUrl: 'https://other.example' }]) {
    const other = new ListenerStore(store.directory, otherScope);
    await assert.rejects(other.acquire(1), /scope_mismatch/);
    await assert.rejects(other.pending(), /scope_mismatch/);
  }
});
test('legacy unscoped cursor is never silently adopted', async t => {
  const store = await fixture(t);
  await writeFile(join(store.directory, 'cursor.json'), '{"after":1491}');
  await assert.rejects(store.acquire(1491), /explicit_migration/);
});
test('receipts are idempotent, sorted and conflicting duplicates fail', async t => {
  const store = await fixture(t); await store.acquire(1);
  await store.save({ ...receipt, eventId: '10000000-0000-4000-8000-000000000002', sequence: 3 });
  await store.save(receipt); await store.save(receipt);
  assert.deepEqual((await store.pending()).map(r => r.sequence), [2, 3]);
  await assert.rejects(store.save({ ...receipt, sequence: 9 }), /receipt_conflict/);
  await store.release();
});
test('fixed-window pagination writes receipts before cursor and conservatively reports coverage', async t => {
  const store = await fixture(t); let calls = 0;
  const lines = await once(store, async (after, token) => {
    assert.equal(after, 1);
    if (++calls === 1) return { ...page(), window: { through: 3, complete: false, nextToken: 'page2' } };
    assert.equal(token, 'page2'); assert.equal(await store.cursor(), 1);
    assert.equal((await store.pending()).length, 1);
    return { ...page('10000000-0000-4000-8000-000000000002', 3), legacyCoverage: { complete: true } };
  });
  assert.equal(calls, 2); assert.equal(await store.cursor(), 3);
  assert.equal((await store.pending()).length, 2); assert.match(lines.join('\n'), /ALERT/);
  assert.equal((await store.status()).coverage.legacy, false);
});
test('once-mode replays durable pending immediately without remote call', async t => {
  const store = await fixture(t); await store.acquire(1); await store.save(receipt); await store.release();
  await once(store, async () => { throw new Error('must not fetch'); });
  assert.equal(await store.cursor(), 1); assert.equal((await store.pending()).length, 1);
});
test('partial pagination interruption leaves receipt and original cursor for replay', async t => {
  const store = await fixture(t); const controller = new AbortController();
  await once(store, async () => {
    controller.abort();
    return { ...page(), window: { through: 3, complete: false, nextToken: 'next' } };
  }, { signal: controller.signal });
  assert.equal(await store.cursor(), 1);
  assert.equal((await store.pending()).length, 1);
  await once(store, async () => { throw new Error('must replay'); });
});
test('window drift and cyclic continuation never advance cursor', async t => {
  for (const drift of [true, false]) {
    const store = await fixture(t); let calls = 0;
    await assert.rejects(once(store, async () => {
      calls++;
      return { ...page(), items: [], window: { through: drift && calls % 2 === 0 ? 4 : 3,
        complete: false, nextToken: 'same' } };
    }), /repeated_inbox_failure/);
    assert.equal(await store.cursor(), 1);
    assert.ok(calls >= 6); assert.equal((await readdir(store.directory)).includes('watch.lock'), false);
  }
});
test('six failures are visible and release lock without advancing cursor', async t => {
  const store = await fixture(t); let calls = 0; const lines: string[] = [];
  await assert.rejects(once(store, async () => { calls++; throw Error('PRIVATE'); },
    { emit: line => lines.push(line) }), /repeated_inbox_failure/);
  assert.equal(calls, 6); assert.equal(await store.cursor(), 1);
  assert.equal(lines.some(l => l.includes('PRIVATE')), false);
  assert.match(lines.join('\n'), /failures=6/);
});
test('continuous mode alerts pending even when remote fetch fails', async t => {
  const store = await fixture(t); await store.acquire(1); await store.save(receipt); await store.release();
  const lines: string[] = [];
  await assert.rejects(once(store, async () => { throw Error('offline'); },
    { mode: 'continuous', emit: line => lines.push(line) }), /repeated_inbox_failure/);
  assert.match(lines.join('\n'), /LUCAMSG_ALERT/);
});
test('processed removes exactly named receipt, rejects paths and leaves cursor unchanged', async t => {
  const store = await fixture(t); await store.acquire(1); await store.save(receipt);
  await store.save({ ...receipt, eventId: '10000000-0000-4000-8000-000000000002' }); await store.release();
  await assert.rejects(store.processed('../cursor'), /invalid_event_id/);
  await store.processed(event);
  assert.equal((await store.pending()).length, 1); assert.equal(await store.cursor(), 1);
});
test('explicit stop persists until explicit resume; resume uses saved cursor', async t => {
  const store = await fixture(t); await store.acquire(1); await store.advance(3); await store.release();
  await store.stop();
  await once(store, async () => { throw Error('must not fetch'); });
  let afterRead = 0;
  await once(store, async after => { afterRead = after; return page('10000000-0000-4000-8000-000000000004', 4); },
    { resume: true, inbox: async after => { afterRead = after; return { ...page('10000000-0000-4000-8000-000000000004', 4), window: { through: 4, complete: true } }; } });
  assert.equal(afterRead, 3); assert.equal(await store.cursor(), 4);
});
test('status distinguishes stopped/stale health from platform arming and awareness', async t => {
  const store = await fixture(t); await store.acquire(1); await store.heartbeat('listening');
  const recent = await store.status();
  assert.equal(recent.health, 'recent-heartbeat'); assert.equal(recent.notificationArming, 'unknown-runtime-owned');
  assert.equal((await store.status(Date.now() + 100_000)).health, 'stale');
  await store.release(); assert.equal((await store.status()).health, 'stopped');
});
test('no lifetime expiry: continuous session can outlast two hours and stop explicitly', async t => {
  const store = await fixture(t); let polls = 0, elapsed = 0;
  await once(store, async () => { polls++; return { ...page(), items: [] }; }, {
    mode: 'continuous', sleep: async ms => { elapsed += ms; if (elapsed > 7_200_000) await store.stop(); },
  });
  assert.ok(elapsed > 7_200_000); assert.ok(polls > 360); assert.equal(await store.stopped(), true);
});
test('observed open receipts persist without refiring when once-wait re-arms', async t => {
  const store = await fixture(t); await store.acquire(1); await store.save(receipt); await store.release();
  await store.observed(event);
  const controller = new AbortController(); let fetched = false;
  const lines = await once(store, async () => {
    fetched = true; controller.abort(); return { ...page(), items: [] };
  }, { signal: controller.signal });
  assert.equal(fetched, true); assert.equal(lines.some(l => l.startsWith('LUCAMSG_ALERT')), false);
  assert.equal((await store.status()).pending[0].state, 'observed');
  await store.acquire(); await store.save(receipt); await store.release();
  assert.equal((await store.pending())[0].state, 'observed');
});
test('self-authored receipts do not wake once-wait but are retained', async t => {
  const store = await fixture(t); const controller = new AbortController();
  const lines = await once(store, async () => ({ ...page(),
    items: [{ ...page().items[0], inboxItem: { ...page().items[0].inboxItem, senderActor: scope.actor } }] }),
  { signal: controller.signal, sleep: async () => controller.abort() });
  assert.equal(lines.some(l => l.startsWith('LUCAMSG_ALERT')), false);
  assert.equal((await store.pending()).length, 1);
});
test('parent creation mismatch is absence; unknown is not absence', async () => {
  const parent = { pid: 123, created: 'original' };
  assert.equal(await parentState(parent, async () => ({ state: 'present', created: 'original' })), 'present');
  assert.equal(await parentState(parent, async () => ({ state: 'present', created: 'reused' })), 'absent');
  assert.equal(await parentState(parent, async () => ({ state: 'unknown' })), 'unknown');
});
test('confirmed parent absence stops with distinct outcome and releases own lock', async t => {
  const store = await fixture(t); let calls = 0;
  const result = await runListener({ store, mode: 'once', initialAfter: 1,
    parent: { pid: 123, created: 'original' }, readIdentity: async () => ({ state: 'absent' }),
    signal: new AbortController().signal, inbox: async () => { calls++; return page(); }, emit: () => {} });
  assert.equal(result, 71); assert.equal(calls, 0);
  assert.equal((await readdir(store.directory)).includes('watch.lock'), false);
});
test('unknown parent retains ownership and fetches rather than falsely orphaning', async t => {
  const store = await fixture(t);
  const lines = await once(store, async () => {
    assert.equal((await readdir(store.directory)).includes('watch.lock'), true); return page();
  }, { parent: { pid: 123, created: 'original' }, readIdentity: async () => ({ state: 'unknown' }) });
  assert.match(lines.join('\n'), /PARENT_UNKNOWN/); assert.match(lines.join('\n'), /ALERT/);
});
test('native current-process creation identity is available; invalid PID is unknown', async () => {
  if (!['linux', 'win32'].includes(process.platform)) return;
  assert.equal((await readProcessIdentity(process.pid)).state, 'present');
  assert.equal((await readProcessIdentity(-1)).state, 'unknown');
});
test('bounded atomic rename retries Windows contention without rewriting cursor early', async t => {
  const base = await fixture(t); let retries = 0; const delays: number[] = [];
  const { rename } = await import('node:fs/promises');
  const store = new ListenerStore(base.directory, scope, async (a, b) => {
    if (String(b).endsWith('cursor.json') && retries++ < 2) throw Object.assign(Error('busy'), { code: 'EPERM' });
    return rename(a, b);
  }, async ms => { delays.push(ms); });
  await store.acquire(1);
  assert.deepEqual(delays, [25, 50]); assert.equal(await store.cursor(), 1);
  await store.release();
});
test('exhausted cursor replacement counts failures and preserves original cursor', async t => {
  const base = await fixture(t); await base.acquire(1); await base.release();
  const { rename } = await import('node:fs/promises');
  let attempts = 0;
  const store = new ListenerStore(base.directory, scope, async (a, b) => {
    if (String(b).endsWith('cursor.json')) { attempts++; throw Object.assign(Error('busy'), { code: 'EBUSY' }); }
    return rename(a, b);
  }, async () => {});
  await assert.rejects(once(store, async () => ({ ...page(), items: [] })), /repeated_inbox_failure/);
  assert.equal(attempts, 30); assert.equal(await store.cursor(), 1);
});
test('error exit codes never conflate failures and notifications', () => {
  assert.equal(listenerErrorCode(Object.assign(Error('locked'), { code: 'EEXIST' })), 73);
  assert.equal(listenerErrorCode(Error('repeated_inbox_failure')), 70);
  assert.equal(listenerErrorCode(Error('invalid_cursor')), 64);
});
test('operator recovery refuses live/unknown ownership; confirmed absence permits recovery', async t => {
  const store = await fixture(t); await store.acquire(1, false, 'creation-proof'); await store.release();
  const lock = { owner: 'gone', pid: 123, created: 'creation-proof', ...scope };
  await writeFile(join(store.directory, 'watch.lock'), JSON.stringify(lock));
  await assert.rejects(store.recoverLock(async () => ({ state: 'unknown' })), /live_or_unknown/);
  await assert.rejects(store.recoverLock(async () => ({ state: 'present', created: 'creation-proof' })), /live_or_unknown/);
  await store.recoverLock(async () => ({ state: 'absent' }));
  assert.equal((await readdir(store.directory)).includes('watch.lock'), false);
});
test('runtime arming report is visible but never presented as confirmed awareness', async t => {
  const store = await fixture(t); await store.acquire(1); await store.heartbeat('listening');
  await store.reportArming(true, 'fixture-task');
  const status = await store.status();
  assert.equal(status.reportedArming.state, 'reported-armed');
  assert.equal(status.notificationArming, 'unknown-runtime-owned');
  await store.release();
});
test('stranded identity-bearing guard is distinct from listener ownership and explicitly recoverable', async t => {
  const store = await fixture(t);
  await writeFile(join(store.directory, 'ownership.guard'), JSON.stringify({ ...scope,
    pid: 123, created: 'gone', owner: randomUUID() }));
  assert.equal((await store.status()).guardPresent, true);
  await assert.rejects(store.acquire(1), e => listenerErrorCode(e) === 74);
  await store.recoverGuard(async () => ({ state: 'absent' }));
  assert.equal((await store.status()).guardPresent, false);
  await store.acquire(1); await store.heartbeat('listening'); await store.release();
  assert.equal((await store.status()).guardPresent, false);
});
test('guard recovery refuses live, unknown and identity-free legacy guards', async t => {
  const store = await fixture(t);
  await writeFile(join(store.directory, 'ownership.guard'), JSON.stringify({ ...scope,
    pid: 123, created: 'original', owner: randomUUID() }));
  await assert.rejects(store.recoverGuard(async () => ({ state: 'present', created: 'original' })),
    e => listenerErrorCode(e) === 74);
  await assert.rejects(store.recoverGuard(async () => ({ state: 'unknown' })),
    e => listenerErrorCode(e) === 74);
  await writeFile(join(store.directory, 'ownership.guard'), '');
  await assert.rejects(store.recoverGuard(async () => ({ state: 'absent' })),
    e => listenerErrorCode(e) === 74);
  assert.equal((await store.status()).guardPresent, true);
});
test('abandoned unique recovery markers are explicit-recovery safe, live markers refuse', async t => {
  const store = await fixture(t); const name = `guard-recovery-${randomUUID()}.json`;
  await writeFile(join(store.directory, name), JSON.stringify({ ...scope,
    pid: 123, created: 'original', owner: randomUUID() }));
  await assert.rejects(store.acquire(1), e => listenerErrorCode(e) === 74);
  await assert.rejects(store.recoverGuard(async () => ({ state: 'unknown' })),
    e => listenerErrorCode(e) === 74);
  assert.ok((await readdir(store.directory)).includes(name));
  await store.recoverGuard(async () => ({ state: 'absent' }));
  assert.deepEqual((await store.status()).recoveryMarkers, []);
});
test('concurrent recovery refuses active recoverer and cannot delete newly acquired guard', async t => {
  const store = await fixture(t);
  await writeFile(join(store.directory, 'ownership.guard'), JSON.stringify({ ...scope,
    pid: 123, created: 'gone', owner: randomUUID() }));
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const first = store.recoverGuard(async pid => {
    if (pid === 123) { entered(); await gate; return { state: 'absent' }; }
    return readProcessIdentity(pid);
  });
  await started;
  await assert.rejects(store.recoverGuard(readProcessIdentity), e => listenerErrorCode(e) === 74);
  await assert.rejects(store.acquire(1), e => listenerErrorCode(e) === 74);
  release(); await first;
  await store.acquire(1); await store.release();
});
