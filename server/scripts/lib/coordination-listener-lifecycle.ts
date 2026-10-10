import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ListenerStore } from './coordination-listener';
import { parentState, readProcessIdentity, type ParentIdentity, type ProcessIdentity } from './coordination-listener-identity';

type State = 'present' | 'absent' | 'unknown';
type LockState = 'same' | 'missing' | 'changed' | 'unknown';
export interface LifecycleSnapshot {
  at: string; parent: State; owner: State; lock: LockState;
  ownershipArtifacts: 'clear' | 'present' | 'unknown';
}
export interface LifecycleOptions {
  store: ListenerStore;
  actionFile: string;
  timeoutMs?: number;
  intervalMs?: number;
  reader?: (pid: number) => Promise<ProcessIdentity>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ready?: () => void;
}
const absentFile = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const validIdentity = (v: any): v is ParentIdentity =>
  Number.isSafeInteger(v?.pid) && v.pid > 0 && typeof v.created === 'string' && !!v.created;

/** Read-only observer. A user-reported action is not an independently verified Desktop event. */
export async function observeListenerLifecycle(options: LifecycleOptions) {
  const { store, actionFile } = options;
  const reader = options.reader ?? readProcessIdentity;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const timeout = options.timeoutMs ?? 120_000;
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000 ||
      !Number.isSafeInteger(interval) || interval < 1 || interval > 5000) throw Error('invalid_observation_budget');
  await store.assertScope();
  const readLock = async () => JSON.parse(await readFile(join(store.directory, 'watch.lock'), 'utf8'));
  const lock: ParentIdentity & { owner: string; parent: ParentIdentity; actor: string; apiUrl: string } = await readLock();
  if (lock.actor !== store.scope.actor || lock.apiUrl !== store.scope.apiUrl ||
      typeof lock.owner !== 'string' || !lock.owner || !validIdentity(lock) ||
      !validIdentity(lock.parent)) throw Error('unproven_listener_binding');
  try { await readFile(actionFile); throw Error('action_file_already_exists'); }
  catch (e) { if (!absentFile(e)) throw e; }
  const identity = async (value: ParentIdentity): Promise<State> => {
    try { return await parentState(value, reader); } catch { return 'unknown'; }
  };
  const snapshot = async (): Promise<LifecycleSnapshot> => {
    const parent = await identity(lock.parent);
    const owner = await identity(lock);
    let current: LockState;
    try {
      const next = await readLock();
      current = next.owner === lock.owner && next.pid === lock.pid && next.created === lock.created &&
        next.parent?.pid === lock.parent.pid && next.parent?.created === lock.parent.created &&
        next.actor === lock.actor && next.apiUrl === lock.apiUrl ? 'same' : 'changed';
    }
    catch (e) { current = absentFile(e) ? 'missing' : 'unknown'; }
    let artifacts: LifecycleSnapshot['ownershipArtifacts'] = 'unknown';
    try {
      const names = await readdir(store.directory);
      artifacts = names.some(n => n === 'ownership.guard' || /^guard-recovery-.*\.json$/.test(n)) ? 'present' : 'clear';
    } catch {}
    return { at: new Date(now()).toISOString(), parent, owner, lock: current, ownershipArtifacts: artifacts };
  };
  const baseline = await snapshot();
  if (baseline.parent !== 'present' || baseline.owner !== 'present' || baseline.lock !== 'same' ||
      baseline.ownershipArtifacts !== 'clear') throw Error('baseline_not_live_and_proven');
  const startedAt = now();
  const initialCursor = await store.cursor();
  const initialPendingCount = (await store.pending()).length;
  const samples: LifecycleSnapshot[] = [baseline];
  let action: { action: 'closed' | 'archived'; at: string; provenance: 'operator-reported' } | undefined;
  let outcome = 'no-action-observed';
  options.ready?.();
  do {
    if (samples.length >= 512) throw Error('observation_sample_limit');
    if (!action) {
      try {
        const value = JSON.parse(await readFile(actionFile, 'utf8'));
        const time = Date.parse(value?.at);
        if (!['closed', 'archived'].includes(value?.action) || value?.provenance !== 'operator-reported' ||
            !Number.isFinite(time) || time < startedAt || time > now()) throw Error('invalid_action_evidence');
        action = { action: value.action, at: value.at, provenance: 'operator-reported' };
      } catch (e) { if (!absentFile(e)) throw e; }
    }
    const current = await snapshot();
    samples.push(current);
    if (action) {
      if ([current.parent, current.owner].includes('unknown') || current.lock === 'unknown' ||
          current.ownershipArtifacts === 'unknown') outcome = 'inconclusive-identity-or-state';
      else if (current.parent === 'absent' && current.owner === 'absent' && current.lock === 'missing' &&
          current.ownershipArtifacts === 'clear') {
        outcome = 'parent-gone-listener-clean';
        break;
      } else if (current.lock === 'changed') outcome = 'inconclusive-owner-changed';
      else if (current.owner === 'present' && current.lock === 'same') outcome = 'listener-retained-after-reported-action';
      else outcome = 'inconclusive-cleanup';
    }
    if (now() - startedAt >= timeout) break;
    await sleep(Math.min(interval, timeout - (now() - startedAt)));
  } while (now() - startedAt <= timeout);
  const finalCursor = await store.cursor();
  if (finalCursor < initialCursor) outcome = 'inconclusive-state-regression';
  return {
    version: 1, platform: process.platform, scope: store.scope,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(now()).toISOString(),
    action: action ?? null, actionIndependentlyVerified: false, outcome,
    observationBudgetMs: timeout, queryOverrunPossible: true,
    binding: { owner: lock.owner, parent: lock.parent, listener: { pid: lock.pid, created: lock.created } },
    initialCursor, finalCursor,
    initialPendingCount, finalPendingCount: (await store.pending()).length, samples,
  };
}
