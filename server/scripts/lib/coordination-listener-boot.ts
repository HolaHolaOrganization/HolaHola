import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileCoordinationCliCredentialCache } from '../../services/coordination-cli-credential-cache';
import { ListenerStore, normalizeScope } from './coordination-listener';
import { parentState, readProcessIdentity, type ProcessIdentity } from './coordination-listener-identity';
import { publishOwnershipRecord, withOwnershipGuard } from './coordination-listener-ownership';

export interface BootConfig {
  root: string;
  actor: string;
  runtimeId: string;
  apiUrl: string;
  stateDir: string;
  cacheDir: string;
  listenerEntry: string;
}
export type IdentityReader = (pid: number) => Promise<ProcessIdentity>;
type Owner = { actor: string; apiUrl: string; runtimeId: string; pid: number; created: string; owner: string };
export type BootStatus = { state: string; at: string; pid?: number; created?: string; childPid?: number };
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export function workspaceBootConfig(root: string): BootConfig {
  root = resolve(root);
  return {
    root, actor: 'luca-replit', runtimeId: 'luca-replit-primary', apiUrl: 'https://getholahola.com',
    stateDir: join(root, '.local/coordination-listeners/luca-replit'),
    cacheDir: join(root, '.local/coordination-cli-credentials'),
    listenerEntry: join(root, 'server/scripts/coordination-listener.ts'),
  };
}

/** Deliberate allowlist: no database, provider, bootstrap, legacy or SSH credentials. */
export function bootChildEnvironment(c: BootConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (env[key] !== undefined) next[key] = env[key];
  }
  return { ...next, NODE_ENV: 'development', HOLAHOLA_INSTANCE_ROLE: 'dev',
    COORDINATION_ACTOR: c.actor, COORDINATION_RUNTIME_ID: c.runtimeId,
    COORDINATION_CLI_CREDENTIAL_CACHE_DIR: c.cacheDir };
}

async function exists(path: string) {
  try { await readFile(path); return true; } catch (e) { if (absent(e)) return false; throw e; }
}
export async function operatorStopped(c: BootConfig) {
  return await exists(join(c.stateDir, 'boot.disabled')) || await exists(join(c.stateDir, 'stop'));
}
export async function bootPreflight(c: BootConfig, now = Date.now()): Promise<'disabled' | 'eligible'> {
  if (await operatorStopped(c)) return 'disabled';
  const credential = await new FileCoordinationCliCredentialCache(c.cacheDir).load(c.actor, c.runtimeId);
  if (!credential || !Number.isFinite(Date.parse(credential.expiresAt))
      || Date.parse(credential.expiresAt) <= now) throw new Error('boot_recovery_required');
  // A new/unscoped installation requires deliberate onboarding, not a replay from cursor zero.
  const store = new ListenerStore(c.stateDir, c);
  await store.assertScope();
  await store.cursor();
  return 'eligible';
}
export async function writeBootStatus(c: BootConfig, state: string, fields: Omit<BootStatus, 'state' | 'at'> = {}) {
  const directory = join(c.stateDir, 'boot');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'status.json');
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ state, at: new Date().toISOString(), ...fields }), { mode: 0o600 });
    await rename(tmp, target);
  } finally { await unlink(tmp).catch(e => { if (!absent(e)) throw e; }); }
}

export async function writeBootFailure(c: BootConfig) {
  const directory = join(c.stateDir, 'boot');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `failure-${process.pid}.json`),
    JSON.stringify({ state: 'recovery-required', at: new Date().toISOString() }), { mode: 0o600 });
}

export async function postBootReady(c: BootConfig, childPid: number, started: number,
  reader: IdentityReader = readProcessIdentity) {
  const heartbeat = JSON.parse(await readFile(join(c.stateDir, 'heartbeat.json'), 'utf8'));
  if (heartbeat.state !== 'listening' || heartbeat.pid !== childPid
      || heartbeat.actor !== c.actor || heartbeat.apiUrl !== c.apiUrl
      || !Number.isFinite(Date.parse(heartbeat.at)) || Date.parse(heartbeat.at) < started) return false;
  const lock = JSON.parse(await readFile(join(c.stateDir, 'watch.lock'), 'utf8'));
  return lock.actor === c.actor && lock.apiUrl === c.apiUrl && lock.pid === childPid
    && typeof lock.created === 'string' && !!lock.created && await parentState(lock, reader) === 'present';
}

/** Separate singleton for supervisors; the listener retains its own existing ownership guard. */
export async function supervisorLease(c: BootConfig, reader: IdentityReader = readProcessIdentity) {
  const directory = join(c.stateDir, 'boot');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const scope = normalizeScope(c);
  const target = join(directory, 'supervisor.lock');
  let mine: Owner | undefined;
  await withOwnershipGuard(directory, scope, async () => {
    let previous: Owner | undefined;
    try { previous = JSON.parse(await readFile(target, 'utf8')); }
    catch (e) { if (!absent(e)) throw e; }
    if (previous) {
      if (previous.actor !== c.actor || previous.apiUrl !== scope.apiUrl || previous.runtimeId !== c.runtimeId
          || !Number.isSafeInteger(previous.pid) || previous.pid < 1
          || typeof previous.created !== 'string' || !previous.created || typeof previous.owner !== 'string') {
        throw new Error('boot_owner_unproven');
      }
      const state = await parentState(previous, reader);
      if (state === 'present') return;
      if (state !== 'absent') throw new Error('boot_owner_unproven');
      await unlink(target);
    }
    const identity = await reader(process.pid);
    if (identity.state !== 'present') throw new Error('boot_self_unproven');
    mine = { ...scope, runtimeId: c.runtimeId, pid: process.pid, created: identity.created, owner: randomUUID() };
    await publishOwnershipRecord(target, mine);
  });
  if (!mine) return null;
  const owner = mine;
  return { owner, release: async () => {
    await withOwnershipGuard(directory, scope, async () => {
      const current: Owner = JSON.parse(await readFile(target, 'utf8'));
      if (current.owner !== owner.owner) throw new Error('boot_owner_changed');
      await unlink(target);
    });
  } };
}

export async function prepareListener(c: BootConfig, reader: IdentityReader = readProcessIdentity) {
  const store = new ListenerStore(c.stateDir, c);
  let lock: Owner;
  try { lock = JSON.parse(await readFile(join(c.stateDir, 'watch.lock'), 'utf8')); }
  catch (e) { if (absent(e)) return 'start' as const; throw e; }
  if (lock.actor !== c.actor || lock.apiUrl !== normalizeScope(c).apiUrl || !Number.isSafeInteger(lock.pid)
      || lock.pid < 1 || typeof lock.created !== 'string' || !lock.created) throw new Error('listener_owner_unproven');
  const state = await parentState(lock, reader);
  if (state === 'present') return 'existing' as const;
  if (state !== 'absent') throw new Error('listener_owner_unproven');
  await store.recoverLock(reader);
  return 'start' as const;
}

export function listenerCommand(c: BootConfig, parentPid: number) {
  return ['--import', 'tsx', c.listenerEntry, 'listen', '--actor', c.actor, '--url', c.apiUrl,
    '--state-dir', c.stateDir, '--mode', 'continuous', '--parent-pid', String(parentPid)];
}

export async function superviseBootListener(c: BootConfig, env: NodeJS.ProcessEnv = process.env) {
  if (await bootPreflight(c) === 'disabled') { await writeBootStatus(c, 'disabled'); return; }
  const lease = await supervisorLease(c);
  if (!lease) { console.log('LUCABOOT existing-supervisor'); return; }
  const fields = { pid: lease.owner.pid, created: lease.owner.created };
  let timer: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (await operatorStopped(c)) { await writeBootStatus(c, 'disabled', fields); return; }
    if (await prepareListener(c) === 'existing') { await writeBootStatus(c, 'existing-listener', fields); return; }
    const started = Date.now();
    child = spawn(process.execPath, listenerCommand(c, process.pid), {
      cwd: c.root, env: bootChildEnvironment(c, env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = new Promise<number | null>((resolveExit, reject) => {
      child!.once('error', reject);
      child!.once('exit', code => resolveExit(code));
    });
    void completion.catch(() => {}); // Attach immediately, even while status is being persisted.
    // CLI output is a fixed safe protocol. Never forward arbitrary subprocess output.
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', () => {});
    await writeBootStatus(c, 'starting', { ...fields, childPid: child.pid });
    let inspection: Promise<void> | undefined;
    let ready = false;
    timer = setInterval(() => {
      if (inspection) return;
      inspection = (async () => {
        if (await operatorStopped(c)) { stop(); return; }
        if (!ready && child?.pid && await postBootReady(c, child.pid, started)) {
          ready = true;
          await writeBootStatus(c, 'listening', { ...fields, childPid: child?.pid });
          console.log('LUCABOOT post-boot-inbox-fetch-confirmed');
        }
      })().catch(() => { /* Missing/partial heartbeat is not readiness. Child failure remains terminal. */ })
        .finally(() => { inspection = undefined; });
    }, 1000);
    const result = await completion;
    clearInterval(timer);
    await inspection;
    await writeBootStatus(c, interrupted ? 'stopped' : result === 72 ? 'operator-stopped' : 'listener-exited', fields);
    if (!interrupted && result !== 72) throw new Error('listener_exited');
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    child?.kill('SIGTERM');
    await lease.release();
  }
}

export async function launchBootSupervisor(c: BootConfig, entry: string, env: NodeJS.ProcessEnv = process.env) {
  if (await bootPreflight(c) === 'disabled') { await writeBootStatus(c, 'disabled'); return; }
  const directory = join(c.stateDir, 'boot');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = await open(join(directory, 'supervisor.log'), 'a', 0o600);
  await chmod(join(directory, 'supervisor.log'), 0o600);
  try {
    const supervisor = spawn(process.execPath, ['--import', 'tsx', entry, 'supervise'], {
      cwd: c.root, detached: true, env: bootChildEnvironment(c, env), stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolveSpawn, reject) => {
      supervisor.once('spawn', resolveSpawn);
      supervisor.once('error', reject);
    });
    supervisor.unref();
    console.log('LUCABOOT supervisor-launched readiness=unverified');
  } finally { await log.close(); }
}
