import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ListenerStore } from './coordination-listener';
import { observeListenerLifecycle } from './coordination-listener-lifecycle';
import { readProcessIdentity, closeProcessIdentityReader } from './coordination-listener-identity';
import { lifecycleProbeCli } from '../coordination-listener-lifecycle-probe';

const scope = { actor: 'luca-replit', apiUrl: 'https://example.com' };
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'listener-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ListenerStore(dir, scope);
  await store.acquire(1, false, 'listener-created', { pid: 321, created: 'parent-created' });
  await store.save({ eventId: '10000000-0000-4000-8000-000000000001', sequence: 2,
    threadId: '20000000-0000-4000-8000-000000000001', sender: 'luca-claude-code', state: 'observed' });
  return { store, actionFile: join(dir, 'action.json') };
}
test('reported archival with surviving parent is recorded as retained, not shutdown proof', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now();
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 3, intervalMs: 1,
    now: () => clock, reader: async pid => ({ state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' }),
    ready: () => { /* action is written in the next simulated tick */ },
    sleep: async () => { clock++; await writeFile(actionFile, JSON.stringify({
      action: 'archived', at: new Date(clock).toISOString(), provenance: 'operator-reported' })); },
  });
  assert.equal(result.outcome, 'listener-retained-after-reported-action');
  assert.equal(result.actionIndependentlyVerified, false);
  assert.equal(result.finalPendingCount, 1); assert.equal(result.finalCursor, 1);
});
test('cleanup requires absent parent AND owner, exact missing lock, and no stranded guard', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), gone = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 3, intervalMs: 1,
    now: () => clock, reader: async pid => gone ? { state: 'absent' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => {
      clock++; gone = true;
      await writeFile(actionFile, JSON.stringify({ action: 'closed', at: new Date(clock).toISOString(), provenance: 'operator-reported' }));
      await unlink(join(store.directory, 'watch.lock'));
    },
  });
  assert.equal(result.outcome, 'parent-gone-listener-clean');
  assert.equal(result.finalPendingCount, result.initialPendingCount);
});
test('unknown identity after closure never becomes successful cleanup', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), changed = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => changed ? { state: 'unknown' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => { clock++; changed = true; await writeFile(actionFile, JSON.stringify({
      action: 'closed', at: new Date(clock).toISOString(), provenance: 'operator-reported' })); },
  });
  assert.equal(result.outcome, 'inconclusive-identity-or-state');
});
test('preexisting action or unproven parent cannot manufacture a baseline', async t => {
  const { store, actionFile } = await fixture(t);
  await writeFile(actionFile, '{}');
  await assert.rejects(observeListenerLifecycle({ store, actionFile }), /action_file_already_exists/);
  await unlink(actionFile);
  await assert.rejects(observeListenerLifecycle({ store, actionFile, reader: async () => ({ state: 'unknown' }) }),
    /baseline_not_live_and_proven/);
});
test('no closure report stays no-action, even if processes later vanish', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), gone = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => gone ? { state: 'absent' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => { clock++; gone = true; },
  });
  assert.equal(result.outcome, 'no-action-observed'); assert.equal(result.action, null);
});
test('future action timestamps are refused instead of attributed to a session close', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now();
  await assert.rejects(observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => ({ state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' }),
    sleep: async () => { clock++; await writeFile(actionFile, JSON.stringify({
      action: 'closed', at: new Date(clock + 1000).toISOString(), provenance: 'operator-reported' })); },
  }), /invalid_action_evidence/);
});
test('stranded guard prevents a clean-shutdown claim despite absent processes', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), gone = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => gone ? { state: 'absent' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => {
      clock++; gone = true; await unlink(join(store.directory, 'watch.lock')).catch(() => {});
      await writeFile(join(store.directory, 'ownership.guard'), '{}');
      await writeFile(actionFile, JSON.stringify({ action: 'closed', at: new Date(clock).toISOString(), provenance: 'operator-reported' }));
    },
  });
  assert.equal(result.outcome, 'inconclusive-cleanup');
  assert.equal((await readFile(join(store.directory, 'ownership.guard'), 'utf8')), '{}');
});
test('a replacement owner cannot be reported as cleanup of the captured listener', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), changed = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => changed ? { state: 'absent' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => {
      clock++; changed = true;
      await writeFile(join(store.directory, 'watch.lock'), JSON.stringify({ owner: 'replacement' }));
      await writeFile(actionFile, JSON.stringify({ action: 'closed', at: new Date(clock).toISOString(), provenance: 'operator-reported' }));
    },
  });
  assert.equal(result.outcome, 'inconclusive-owner-changed');
});
test('cursor regression is reported even when process and lock cleanup succeeded', async t => {
  const { store, actionFile } = await fixture(t);
  let clock = Date.now(), gone = false;
  const result = await observeListenerLifecycle({ store, actionFile, timeoutMs: 2, intervalMs: 1,
    now: () => clock, reader: async pid => gone ? { state: 'absent' }
      : { state: 'present', created: pid === 321 ? 'parent-created' : 'listener-created' },
    sleep: async () => {
      clock++; gone = true; await unlink(join(store.directory, 'watch.lock'));
      await writeFile(join(store.directory, 'cursor.json'), '{"after":0}');
      await writeFile(actionFile, JSON.stringify({ action: 'closed', at: new Date(clock).toISOString(), provenance: 'operator-reported' }));
    },
  });
  assert.equal(result.outcome, 'inconclusive-state-regression');
});
test('action CLI publishes a complete report once and refuses overwrite or paths outside local', async t => {
  await mkdir(resolve('.local'), { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'listener-action-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const actionFile = join(directory, 'closed.json');
  await lifecycleProbeCli(['mark', '--action', 'closed', '--action-file', actionFile]);
  const first = await readFile(actionFile, 'utf8');
  assert.equal(JSON.parse(first).provenance, 'operator-reported');
  await assert.rejects(lifecycleProbeCli(['mark', '--action', 'archived', '--action-file', actionFile]), { code: 'EEXIST' });
  assert.equal(await readFile(actionFile, 'utf8'), first);
  assert.deepEqual(await readdir(directory), ['closed.json']);
  await assert.rejects(lifecycleProbeCli(['mark', '--action', 'closed', '--action-file', '/tmp/outside.json']),
    /evidence_path_must_be_under_local/);
});
test('actual disposable parent termination ends listener71 and releases only its own lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'listener-parent-proof-'));
  const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let listener: ReturnType<typeof spawn> | undefined;
  t.after(async () => { parent.kill(); listener?.kill(); closeProcessIdentityReader(); await rm(dir, { recursive: true, force: true }); });
  const parentIdentity = await readProcessIdentity(parent.pid!);
  assert.equal(parentIdentity.state, 'present');
  if (parentIdentity.state !== 'present') throw Error('parent_identity_unproven');
  const driver = `
    import { ListenerStore, runListener } from './server/scripts/lib/coordination-listener.ts';
    import { readProcessIdentity, closeProcessIdentityReader } from './server/scripts/lib/coordination-listener-identity.ts';
    const owner=await readProcessIdentity(process.pid);
    if(owner.state!=='present')throw Error('owner-unproven');
    const store=new ListenerStore(process.argv[1],${JSON.stringify(scope)});
    try { process.exitCode=await runListener({store,mode:'once',initialAfter:0,intervalMs:20,
      signal:new AbortController().signal,ownerIdentity:owner.created,
      parent:${JSON.stringify({ pid: parent.pid, created: parentIdentity.created })},
      inbox:async after=>({actor:'luca-replit',items:[],window:{through:after,complete:true}}),
      emit:line=>console.log(line)}); }finally{closeProcessIdentityReader()}
  `;
  listener = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, dir],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(listener, 'exit');
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('listener_ready_deadline')), 120_000);
    listener!.stdout!.on('data', chunk => { output += chunk; if (output.includes('LUCAMSG_READY')) { clearTimeout(timer); resolve(); } });
    listener!.once('error', error => { clearTimeout(timer); reject(error); });
    listener!.once('exit', () => { clearTimeout(timer); reject(Error('listener_exited_before_ready')); });
  });
  parent.kill();
  const deadline = setTimeout(() => listener!.kill(), 120_000);
  const [code] = await exited;
  clearTimeout(deadline);
  assert.equal(code, 71); assert.match(output, /LUCAMSG_PARENT_GONE/);
  await assert.rejects(readFile(join(dir, 'watch.lock')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(dir, 'cursor.json'), 'utf8')).after, 0);
  assert.equal((await new ListenerStore(dir, scope).pending()).length, 0);
});
