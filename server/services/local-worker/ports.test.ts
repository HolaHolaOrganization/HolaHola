import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freezeOutboxEntry } from './lifecycle';
import { createFileStateStore, createHttpLedgerPort, readProcessIdentity, type ProcessIdentityRead } from './ports';

async function fakeApi(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test('HTTP port preserves ledger error codes and sends the token only as a header', async () => {
  let seenToken = '';
  const api = await fakeApi((req, res) => {
    seenToken = String(req.headers['x-coordination-token']);
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Sequence conflict', code: 'sequence_conflict' }));
  });
  try {
    const port = createHttpLedgerPort(api.base, 'tok');
    const r = await port.append('t1', 'accepted', { expectedSequence: 2, idempotencyKey: 'lrw.k.accept', content: 'c' });
    assert.deepEqual(r, { ok: false, errorCode: 'sequence_conflict', httpStatus: 409 });
    assert.equal(seenToken, 'tok');
  } finally { await api.close(); }
});

test('HTTP port: not_participant reads are distinguished; a hung server becomes a bounded timeout', async () => {
  const api = await fakeApi((req, res) => {
    if (req.url?.startsWith('/api/coordination/threads/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Actor is not a thread participant', code: 'not_participant' }));
      return;
    }
    // /api/worker-charters... : never respond (simulated stall)
  });
  try {
    const port = createHttpLedgerPort(api.base, 'tok');
    assert.deepEqual(await port.showThread('t1'), { ok: false, error: 'not_participant' });
    const started = Date.now();
    const c = await port.getCharter('11111111-2222-4333-8444-555555555555', 1);
    assert.deepEqual(c, { ok: false, error: 'timeout' });
    assert.ok(Date.now() - started < 8000, 'read must be bounded (~5 s)');
  } finally { await api.close(); }
});

test('HTTP port returns event content and evidence from reads and appends (exact-envelope checks)', async () => {
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST') { res.end(JSON.stringify({ deduplicated: true, event: { eventType: 'blocked', payload: { p: 1 }, evidence: [], content: 'exact' } })); return; }
    res.end(JSON.stringify({
      thread: { id: 't', state: 'accepted', originActor: 'o', intendedRecipient: 'w', currentOwner: 'w', latestSequence: 3 },
      events: [{ idempotencyKey: 'k', eventType: 'blocked', payload: { p: 1 }, evidence: [], content: 'exact', sequence: 3, actor: 'w', createdAt: 'x' }],
    }));
  });
  try {
    const port = createHttpLedgerPort(api.base, 'tok');
    const v = await port.showThread('t');
    assert.equal(v.ok && v.value.events[0].content, 'exact');
    const r = await port.append('t', 'blocked', { expectedSequence: 3, idempotencyKey: 'k', content: 'exact', payload: { p: 1 } });
    assert.deepEqual(r, { ok: true, deduplicated: true, event: { eventType: 'blocked', payload: { p: 1 }, evidence: [], content: 'exact' } });
  } finally { await api.close(); }
});

const WIN = { skip: process.platform !== 'win32' ? 'Windows state store (not run on this platform)' : false } as const;

/** Real CIM identity for this process; scripted answers for any other pid. */
function scripted(others: (pid: number) => ProcessIdentityRead) {
  return (pid: number): ProcessIdentityRead => (pid === process.pid ? readProcessIdentity(pid) : others(pid));
}
const STALE_PID = 2_147_483_644;
const staleRecord = (over: Record<string, unknown> = {}) => JSON.stringify({ pid: STALE_PID, creationDate: '2001-01-01T00:00:00.0000000Z', executablePath: 'C:\\x\\node.exe', runNonce: 'old-run', ...over });

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lrw-state-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('F6 identity read is tri-state: this process is present, an unused pid is absent, an invalid pid is unknown (native CIM)', WIN, () => {
  assert.equal(readProcessIdentity(process.pid).state, 'present');
  assert.equal(readProcessIdentity(STALE_PID).state, 'absent');
  assert.equal(readProcessIdentity(-1).state, 'unknown');
});

test('F6 live matching identity: exclusive lock, reclaim refused, owner-only release', WIN, () => withDir((dir) => {
  const a = createFileStateStore(dir);
  const b = createFileStateStore(dir);
  assert.deepEqual(a.acquireLock('n1', false), { ok: true });
  assert.deepEqual(b.acquireLock('n2', false), { ok: false, reason: 'held' });
  assert.deepEqual(b.acquireLock('n2', true), { ok: false, reason: 'held_by_live_process' });
  assert.deepEqual(b.releaseLock(), { released: false, reason: 'not_acquired' }, 'a store that never acquired cannot delete the lock');
  assert.ok(existsSync(join(dir, 'supervisor.lock')));
  assert.deepEqual(a.releaseLock(), { released: true });
  assert.deepEqual(b.acquireLock('n2', false), { ok: true });
  assert.deepEqual(b.releaseLock(), { released: true });
}));

test('F6 query failure: unknown holder identity never reclaims; unknown own identity never creates a lock', WIN, () => withDir((dir) => {
  writeFileSync(join(dir, 'supervisor.lock'), staleRecord());
  const s = createFileStateStore(dir, { identity: scripted(() => ({ state: 'unknown' })) });
  assert.deepEqual(s.acquireLock('n', true), { ok: false, reason: 'holder_identity_unknown' });
  assert.equal(readFileSync(join(dir, 'supervisor.lock'), 'utf8'), staleRecord(), 'lock untouched');
  rmSync(join(dir, 'supervisor.lock'));
  const blind = createFileStateStore(dir, { identity: () => ({ state: 'unknown' }) });
  assert.deepEqual(blind.acquireLock('n', false), { ok: false, reason: 'own_identity_unknown' });
  assert.equal(existsSync(join(dir, 'supervisor.lock')), false);
}));

test('F6 confirmed absence and PID reuse are stale; the stale record is preserved, not deleted', WIN, () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'supervisor.lock'), staleRecord());
    const s = createFileStateStore(dir, { identity: scripted(() => ({ state: 'absent' })) });
    assert.deepEqual(s.acquireLock('fresh', true), { ok: true });
    assert.equal(JSON.parse(readFileSync(join(dir, 'supervisor.lock'), 'utf8')).runNonce, 'fresh');
    const kept = readdirSync(dir).filter((f) => f.startsWith('supervisor.lock.stale.'));
    assert.equal(kept.length, 1);
    assert.equal(readFileSync(join(dir, kept[0]), 'utf8'), staleRecord());
    assert.deepEqual(s.releaseLock(), { released: true });
  });
  withDir((dir) => {
    // The recorded pid is THIS live process, but its creation time differs: the pid was reused (real CIM read).
    writeFileSync(join(dir, 'supervisor.lock'), staleRecord({ pid: process.pid }));
    const s = createFileStateStore(dir);
    assert.deepEqual(s.acquireLock('fresh', true), { ok: true });
    assert.deepEqual(s.releaseLock(), { released: true });
  });
});

test('F6 concurrent reclaimers: exactly one wins; the other refuses and never replaces the winner', WIN, () => withDir((dir) => {
  writeFileSync(join(dir, 'supervisor.lock'), staleRecord());
  const ident = scripted(() => ({ state: 'absent' }));
  const b = createFileStateStore(dir, { identity: ident });
  let during: unknown = null;
  const a = createFileStateStore(dir, { identity: ident, beforeReclaimReplace: () => { during = b.acquireLock('nB', true); } });
  assert.deepEqual(a.acquireLock('nA', true), { ok: true });
  assert.deepEqual(during, { ok: false, reason: 'reclaim_in_progress' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'supervisor.lock'), 'utf8')).runNonce, 'nA');
  assert.deepEqual(b.acquireLock('nB', true), { ok: false, reason: 'held_by_live_process' });
  assert.deepEqual(a.releaseLock(), { released: true });
}));

test("F6 another owner's replacement lock is never released by the previous holder", WIN, () => withDir((dir) => {
  const a = createFileStateStore(dir);
  assert.deepEqual(a.acquireLock('nA', false), { ok: true });
  const other = staleRecord({ runNonce: 'someone-else' });
  writeFileSync(join(dir, 'supervisor.lock'), other);
  assert.deepEqual(a.releaseLock(), { released: false, reason: 'lock_owned_by_another_record' });
  assert.equal(readFileSync(join(dir, 'supervisor.lock'), 'utf8'), other);
}));

test('state store: stable instance id, persisted v2 outbox entries and launched markers, scan positions', WIN, () => withDir((dir) => {
  const s = createFileStateStore(dir);
  const id = s.instanceId();
  assert.equal(createFileStateStore(dir).instanceId(), id);
  const e = freezeOutboxEntry({ key: 'lrw.x.t.completed.abcd1234', threadId: 't', op: 'completed', eventType: 'completed', content: 'c', recipientActor: null, claimKey: 'k', payload: { a: 1 }, evidence: [] });
  s.saveOutbox(e);
  s.saveOutbox({ ...e, state: 'sent' });
  const reopened = createFileStateStore(dir).outbox() as (typeof e)[];
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].state, 'sent');
  assert.equal(reopened[0].content, 'c');
  writeFileSync(join(dir, 'outbox', 'broken.json'), '{not json');
  assert.ok(createFileStateStore(dir).outbox().some((x) => (x as { corrupt?: string }).corrupt === 'broken.json'), 'unparsable entries surface (and are refused), never silently dropped');
  s.markLaunched('k1');
  assert.equal(createFileStateStore(dir).launched('k1'), true);
  s.saveScanAfter('c', 1, 42);
  assert.equal(createFileStateStore(dir).scanAfter('c', 1), 42);
  assert.throws(() => createFileStateStore('\\\\server\\share\\x'), /state_dir_must_be_local_drive/);
}));
