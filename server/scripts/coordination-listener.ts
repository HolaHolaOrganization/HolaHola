import { resolve } from 'node:path';
import { LISTENER_EXIT, ListenerStore, normalizeScope, runListener } from './lib/coordination-listener';
import { fetchListenerInbox } from './lib/coordination-listener-transport';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { isSupportedCoordinationActor } from './coordination-cli';
import { closeProcessIdentityReader, readProcessIdentity } from './lib/coordination-listener-identity';

export async function listenerCli(argv = process.argv.slice(2)) {
  const command = argv.shift();
  if (!['listen', 'status', 'stop', 'observed', 'processed', 'arming', 'recover-lock', 'recover-guard'].includes(command ?? '')) throw new Error('invalid_command');
  const options: Record<string, string | boolean> = {};
  const allowed = new Set(['actor', 'url', 'state-dir', 'mode', 'after', 'resume', 'event-id', 'parent-pid', 'state', 'task-id']);
  while (argv.length) {
    const key = argv.shift()!;
    if (!key.startsWith('--') || !allowed.has(key.slice(2)) || key.slice(2) in options) throw new Error('invalid_option');
    options[key.slice(2)] = key === '--resume' ? true : argv.shift() ?? '';
  }
  const required = (key: string) => {
    const value = options[key];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`required_${key}`);
    return value;
  };
  const scope = normalizeScope({ actor: required('actor'), apiUrl: required('url') });
  if (!isSupportedCoordinationActor(scope.actor)) throw new Error('unsupported_actor');
  const store = new ListenerStore(resolve(required('state-dir')), scope);
  if (command === 'status') return console.log(JSON.stringify(await store.status(), null, 2));
  if (command === 'recover-guard') {
    await store.recoverGuard();
    return console.log('LUCAMSG_GUARD_RECOVERED confirmed_absent_only=true');
  }
  if (command === 'recover-lock') {
    await store.recoverLock();
    return console.log('LUCAMSG_LOCK_RECOVERED confirmed_absent=true');
  }
  if (command === 'arming') {
    const state = required('state');
    if (!['armed', 'unarmed'].includes(state)) throw new Error('invalid_arming_state');
    await store.reportArming(state === 'armed', required('task-id'));
    return console.log('LUCAMSG_ARMING_REPORTED proof=runtime-report-only');
  }
  if (command === 'stop') { await store.stop(); return console.log('LUCAMSG_STOP_REQUESTED'); }
  if (command === 'observed') {
    await store.observed(required('event-id'));
    return console.log('LUCAMSG_LOCAL_OBSERVED open=true remote_ack=false');
  }
  if (command === 'processed') {
    await store.processed(required('event-id'));
    return console.log('LUCAMSG_LOCAL_RECEIPT_REMOVED remote_ack=false');
  }
  const mode = options.mode ?? 'continuous';
  if (mode !== 'continuous' && mode !== 'once') throw new Error('invalid_mode');
  let initialAfter: number | undefined;
  if (options.after !== undefined) {
    const value = required('after');
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid_initial_cursor');
    initialAfter = Number(value);
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const parentPid = Number(required('parent-pid'));
    const parent = await readProcessIdentity(parentPid);
    const owner = await readProcessIdentity(process.pid);
    if (parent.state !== 'present' || owner.state !== 'present') throw new Error('process_identity_unproven');
    const exit = await runListener({ store, mode, initialAfter, resume: options.resume === true, signal: controller.signal,
      parent: { pid: parentPid, created: parent.created }, ownerIdentity: owner.created,
      inbox: (after, token) => fetchListenerInbox(scope, after, token, controller.signal),
      emit: line => console.log(line) });
    console.log(`LUCAMSG_RESULT code=${exit} outcome=${exit === 0 ? 'pending-available' : exit === 71 ? 'parent-gone' : 'stopped'}`);
    process.exitCode = exit;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
export function listenerErrorCode(error: unknown): number {
  if ((error as NodeJS.ErrnoException)?.code === 'GUARD_BLOCKED') return LISTENER_EXIT.guardBlocked;
  if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return LISTENER_EXIT.locked;
  if ((error as Error)?.message === 'repeated_inbox_failure') return LISTENER_EXIT.failure;
  return LISTENER_EXIT.invalid;
}
if (isDirectCliInvocation('coordination-listener.ts')) {
  listenerCli().catch(error => {
    // Never echo underlying remote payloads, credentials, or message bodies.
    const code = listenerErrorCode(error);
    console.error(`LUCAMSG_FATAL code=${code} outcome=${code === 74 ? 'guard-blocked' : code === 73 ? 'ownership-held' : code === 70 ? 'repeated-failure' : 'invalid-state-or-input'}`);
    process.exitCode = code;
  }).finally(closeProcessIdentityReader);
}
