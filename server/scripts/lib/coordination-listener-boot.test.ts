import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FileCoordinationCliCredentialCache } from '../../services/coordination-cli-credential-cache';
import { readProcessIdentity, parentState } from './coordination-listener-identity';
import { bootChildEnvironment, bootPreflight, launchBootSupervisor, listenerCommand, postBootReady,
  prepareListener, supervisorLease, workspaceBootConfig, type BootConfig } from './coordination-listener-boot';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'listener-boot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = workspaceBootConfig(root);
  assert.ok(c.stateDir.startsWith(root + '/'));
  await mkdir(join(c.stateDir, 'pending'), { recursive: true });
  await writeFile(join(c.stateDir, 'scope.json'), JSON.stringify({ actor: c.actor, apiUrl: c.apiUrl }));
  await writeFile(join(c.stateDir, 'cursor.json'), JSON.stringify({ after: 0 }));
  await save(c, new Date(Date.now() + 3600_000).toISOString());
  return c;
}
async function save(c: BootConfig, expiresAt: string) {
  await new FileCoordinationCliCredentialCache(c.cacheDir).save({
    actor: c.actor, runtimeId: c.runtimeId, expiresAt, accessToken: 'synthetic-not-a-real-credential',
  });
}
async function lock(c: BootConfig, pid: number, created: string) {
  await writeFile(join(c.stateDir, 'watch.lock'), JSON.stringify({ actor: c.actor, apiUrl: c.apiUrl, pid, created }));
}
test('preflight accepts only valid scoped cache and initialized cursor', async t => {
  const c = await fixture(t);
  assert.equal(await bootPreflight(c), 'eligible');
  await writeFile(join(c.stateDir, 'scope.json'), JSON.stringify({ actor: 'other', apiUrl: c.apiUrl }));
  await assert.rejects(bootPreflight(c), /scope_mismatch/);
});
test('explicit stop and disable win even with no cache', async t => {
  const c = await fixture(t);
  await rm(c.cacheDir, { recursive: true });
  for (const marker of ['stop', 'boot.disabled']) {
    await writeFile(join(c.stateDir, marker), '');
    assert.equal(await bootPreflight(c), 'disabled');
    await rm(join(c.stateDir, marker));
  }
  await assert.rejects(bootPreflight(c), /recovery_required/);
});
test('expired, invalid, mismatched and corrupt caches fail closed', async t => {
  const c = await fixture(t);
  for (const expiry of ['invalid', new Date(Date.now() - 1).toISOString()]) {
    await save(c, expiry);
    await assert.rejects(bootPreflight(c), /recovery_required/);
  }
  await save(c, new Date(Date.now() + 3600_000).toISOString());
  const path = join(c.cacheDir, (await readdir(c.cacheDir))[0]);
  const entry = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...entry, runtimeId: 'wrong' }));
  await assert.rejects(bootPreflight(c), /recovery_required/);
  await writeFile(path, '{');
  await assert.rejects(bootPreflight(c), /recovery_required/);
});
test('child environment allowlist and supervisor-parent command have no fallback or held service', async t => {
  const c = await fixture(t);
  const excluded = ['COORDINATION_RUNTIME_BOOTSTRAP_TOKEN', 'COORDINATION_LUCA_REPLIT_TOKEN',
    'DATABASE_URL', 'NEON_SHARED_DATABASE_URL', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'GIT_SSH_COMMAND', 'GH_TOKEN'];
  const env = bootChildEnvironment(c, { PATH: '/bin', ...Object.fromEntries(excluded.map(k => [k, 'fixture'])) });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.COORDINATION_RUNTIME_ID, c.runtimeId);
  for (const key of excluded) assert.equal(env[key], undefined);
  const command = listenerCommand(c, 123);
  assert.equal(command.at(-1), '123');
  assert.equal(command.includes('--resume'), false);
  assert.equal(command.some(s => /server\/index|npm|validation|capture/.test(s)), false);
});
test('live listener retained; unknown owner fails closed; proven stale lock recovered', async t => {
  const c = await fixture(t), self = await readProcessIdentity(process.pid);
  if (self.state !== 'present') throw Error('identity unavailable');
  await lock(c, process.pid, self.created);
  assert.equal(await prepareListener(c), 'existing');
  await assert.rejects(prepareListener(c, async () => ({ state: 'unknown' })), /unproven/);
  assert.equal(JSON.parse(await readFile(join(c.stateDir, 'watch.lock'), 'utf8')).pid, process.pid);
  await lock(c, 987654321, 'old-boot:0');
  assert.equal(await prepareListener(c), 'start');
  await assert.rejects(readFile(join(c.stateDir, 'watch.lock')), { code: 'ENOENT' });
});
test('supervisor singleton refuses duplicates, unknown owners and held guards', async t => {
  const c = await fixture(t), lease = await supervisorLease(c);
  assert.ok(lease);
  assert.equal(await supervisorLease(c), null);
  await assert.rejects(supervisorLease(c, async () => ({ state: 'unknown' })), /unproven/);
  await lease.release();
  const guard = join(c.stateDir, 'boot/ownership.guard');
  await writeFile(guard, '{}');
  await assert.rejects(supervisorLease(c), /guard_present/);
  assert.equal(await readFile(guard, 'utf8'), '{}');
});
test('only identity-matched post-start listening heartbeat proves readiness', async t => {
  const c = await fixture(t), self = await readProcessIdentity(process.pid);
  if (self.state !== 'present') throw Error('identity unavailable');
  await lock(c, process.pid, self.created);
  const started = Date.now();
  const beat = { actor: c.actor, apiUrl: c.apiUrl, pid: process.pid, state: 'listening',
    at: new Date(started).toISOString() };
  for (const change of [{ state: 'READY' }, { at: new Date(started - 1).toISOString() },
    { pid: process.pid + 1 }, { actor: 'other' }]) {
    await writeFile(join(c.stateDir, 'heartbeat.json'), JSON.stringify({ ...beat, ...change }));
    assert.equal(await postBootReady(c, process.pid, started), false);
  }
  await writeFile(join(c.stateDir, 'heartbeat.json'), JSON.stringify(beat));
  assert.equal(await postBootReady(c, process.pid, started), true);
  assert.equal(await postBootReady(c, process.pid, started, async () => ({ state: 'unknown' })), false);
});
async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('fixture deadline');
}
test('detached supervisor survives launcher, owns child, deduplicates and honors stop', async t => {
  const c = await fixture(t);
  const helper = pathToFileURL(resolve('server/scripts/lib/coordination-listener-boot.ts')).href;
  const identity = pathToFileURL(resolve('server/scripts/lib/coordination-listener-identity.ts')).href;
  c.root = process.cwd(); // Only package-resolution cwd changes; all cache/state remains disposable.
  c.listenerEntry = join(c.stateDir, 'fake-listener.mjs');
  await writeFile(c.listenerEntry, `
    import {writeFile,unlink,access} from 'node:fs/promises';
    import {readProcessIdentity} from ${JSON.stringify(identity)};
    const dir=${JSON.stringify(c.stateDir)},id=await readProcessIdentity(process.pid);
    const parent=Number(process.argv[process.argv.indexOf('--parent-pid')+1]);
    if(parent===process.pid || process.env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN
      || process.env.COORDINATION_LUCA_REPLIT_TOKEN || process.env.NEON_SHARED_DATABASE_URL)process.exit(90);
    await writeFile(dir+'/watch.lock',JSON.stringify({actor:${JSON.stringify(c.actor)},
      apiUrl:${JSON.stringify(c.apiUrl)},pid:process.pid,created:id.created,parent}));
    await writeFile(dir+'/heartbeat.json',JSON.stringify({actor:${JSON.stringify(c.actor)},
      apiUrl:${JSON.stringify(c.apiUrl)},pid:process.pid,state:'listening',at:new Date().toISOString()}));
    setInterval(async()=>{try{await access(dir+'/stop');await unlink(dir+'/watch.lock');process.exit(72);}catch{}},50);
  `);
  const entry = join(c.stateDir, 'fixture-launcher.mjs');
  await writeFile(entry, `
    import {launchBootSupervisor,superviseBootListener} from ${JSON.stringify(helper)};
    const c=${JSON.stringify(c)};
    if(process.argv[2]==='supervise')await superviseBootListener(c);
    else await launchBootSupervisor(c,${JSON.stringify(entry)});
  `);
  let owner: { pid: number; created: string } | undefined;
  t.after(async () => {
    if (owner && await parentState(owner) === 'present') {
      process.kill(owner.pid, 'SIGTERM');
      await until(async () => await parentState(owner!) === 'absent' ? true : undefined);
    }
  });
  const launch = () => spawnSync(process.execPath, ['--import', 'tsx', entry],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  const launched = launch();
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /readiness=unverified/);
  const status = await until(async () => {
    const d = JSON.parse(await readFile(join(c.stateDir, 'boot/status.json'), 'utf8'));
    return d.state === 'listening' ? d : undefined;
  });
  owner = status;
  assert.notEqual(status.pid, status.childPid);
  assert.notEqual(status.pid, launched.pid);
  assert.equal(await parentState(status), 'present');
  assert.equal(launch().status, 0);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(JSON.parse(await readFile(join(c.stateDir, 'boot/supervisor.lock'), 'utf8')).pid, status.pid);
  await writeFile(join(c.stateDir, 'stop'), '');
  await until(async () => await parentState(status) === 'absent' ? true : undefined);
  const before = JSON.parse(await readFile(join(c.stateDir, 'boot/status.json'), 'utf8'));
  assert.ok(['stopped', 'operator-stopped'].includes(before.state));
  await launchBootSupervisor(c, entry);
  assert.equal(JSON.parse(await readFile(join(c.stateDir, 'boot/status.json'), 'utf8')).state, 'disabled');
});
