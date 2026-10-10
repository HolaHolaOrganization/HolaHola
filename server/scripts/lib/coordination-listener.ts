import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parentState, readProcessIdentity, type ParentIdentity, type ProcessIdentity } from './coordination-listener-identity';
import { ownershipStatus, recoverOwnershipGuard, withOwnershipGuard } from './coordination-listener-ownership';

export interface ListenerScope { actor: string; apiUrl: string }
export interface Receipt { eventId: string; sequence: number; threadId: string; sender: string; state?: 'pending' | 'observed' }
export const LISTENER_EXIT = { available: 0, invalid: 64, failure: 70, parentGone: 71, stopped: 72, locked: 73, guardBlocked: 74 } as const;
export interface InboxPage {
  actor: string;
  items: { inboxItem: { recipientActor: string; eventGlobalSequence: number; senderActor: string };
    event: { id: string }; thread: { id: string } }[];
  window: { through: number; complete: boolean; nextToken?: string | null };
  core?: { complete?: boolean };
  adapterOverlay?: { complete?: boolean };
  linkedState?: { complete?: boolean };
  legacyCoverage?: { complete?: boolean };
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validSequence = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

export function normalizeScope(scope: ListenerScope): ListenerScope {
  if (!/^[a-z][a-z0-9-]*$/.test(scope.actor)) throw new Error('invalid_actor');
  const url = new URL(scope.apiUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('invalid_api_origin');
  return { actor: scope.actor, apiUrl: url.origin };
}

export function pageReceipts(page: InboxPage, actor: string, after: number): Receipt[] {
  if (page?.actor !== actor || !Array.isArray(page.items) ||
      !validSequence(page.window?.through) || page.window.through < after ||
      typeof page.window.complete !== 'boolean' ||
      (!page.window.complete && (typeof page.window.nextToken !== 'string' || !page.window.nextToken))) {
    throw new Error('invalid_inbox_page');
  }
  return page.items.map(({ inboxItem: item, event, thread }) => {
    if (item?.recipientActor !== actor || !validSequence(item.eventGlobalSequence) ||
        item.eventGlobalSequence <= after || item.eventGlobalSequence > page.window.through ||
        !UUID.test(event?.id ?? '') || !UUID.test(thread?.id ?? '') ||
        typeof item.senderActor !== 'string') throw new Error('invalid_inbox_item');
    return { eventId: event.id, sequence: item.eventGlobalSequence,
      threadId: thread.id, sender: item.senderActor };
  });
}

export class ListenerStore {
  readonly directory: string;
  readonly scope: ListenerScope;
  private owner: string | null = null;
  constructor(directory: string, scope: ListenerScope,
    private readonly replace = rename, private readonly pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
    this.directory = resolve(directory);
    this.scope = normalizeScope(scope);
  }
  private file(name: string) { return join(this.directory, name); }
  private async json(name: string): Promise<any> {
    return JSON.parse(await readFile(this.file(name), 'utf8'));
  }
  private async atomic(name: string, value: unknown) {
    const temp = this.file(`${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await this.replace(temp, this.file(name)); break; }
        catch (e) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw e;
          await this.pause(25 * 2 ** attempt);
        }
      }
    } finally { await unlink(temp).catch(e => { if (!missing(e)) throw e; }); }
  }
  private async ownershipChange<T>(action: () => Promise<T>): Promise<T> {
    return withOwnershipGuard(this.directory, this.scope, action);
  }
  async assertScope() {
    const scope = await this.json('scope.json');
    if (scope.actor !== this.scope.actor || scope.apiUrl !== this.scope.apiUrl) throw new Error('scope_mismatch');
  }
  async acquire(initialAfter?: number, resume = false, ownerIdentity?: string, parent?: ParentIdentity) {
    await mkdir(this.file('pending'), { recursive: true, mode: 0o700 });
    await this.ownershipChange(async () => {
      const lock = await open(this.file('watch.lock'), 'wx', 0o600);
      this.owner = randomUUID();
      try {
        await lock.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid, created: ownerIdentity, parent, ...this.scope }));
      } finally { await lock.close(); }
    });
    try {
      try { await this.assertScope(); } catch (e) {
        if (!missing(e)) throw e;
        // Never silently adopt unscoped historical state.
        const names = await readdir(this.directory);
        if (names.includes('cursor.json') || (await readdir(this.file('pending'))).length) {
          throw new Error('unscoped_state_requires_explicit_migration');
        }
        if (!validSequence(initialAfter)) throw new Error('initial_cursor_required');
        await this.atomic('scope.json', this.scope);
        await this.atomic('cursor.json', { after: initialAfter });
      }
      if (resume) await unlink(this.file('stop')).catch(e => { if (!missing(e)) throw e; });
      await this.cursor();
    } catch (e) { await this.release(); throw e; }
  }
  async release() {
    if (!this.owner) return;
    const lock = await this.json('watch.lock');
    if (lock.owner !== this.owner) throw new Error('lock_owner_changed');
    await unlink(this.file('watch.lock'));
    this.owner = null;
  }
  async recoverLock(reader = readProcessIdentity) {
    await this.assertScope();
    await this.ownershipChange(async () => {
      const lock = await this.json('watch.lock');
      if (lock.actor !== this.scope.actor || lock.apiUrl !== this.scope.apiUrl ||
          !validSequence(lock.pid) || lock.pid < 1 || typeof lock.created !== 'string' || !lock.created) {
        throw new Error('lock_identity_unproven');
      }
      if (await parentState({ pid: lock.pid, created: lock.created }, reader) !== 'absent') {
        throw new Error('lock_owner_live_or_unknown');
      }
      await unlink(this.file('watch.lock'));
    });
  }
  async recoverGuard(reader = readProcessIdentity) {
    try { await this.assertScope(); } catch (e) { if (!missing(e)) throw e; }
    await recoverOwnershipGuard(this.directory, this.scope, reader);
  }
  async cursor(): Promise<number> {
    const state = await this.json('cursor.json');
    if (!validSequence(state.after)) throw new Error('invalid_cursor');
    return state.after;
  }
  async advance(after: number) {
    if (!validSequence(after) || after < await this.cursor()) throw new Error('cursor_regression');
    await this.atomic('cursor.json', { after });
  }
  async save(receipt: Receipt) {
    const file = `pending/${receipt.eventId}.json`;
    try {
      const old = await this.json(file);
      const { state: _oldState, ...oldFields } = old;
      const { state: _newState, ...newFields } = receipt;
      if (JSON.stringify(oldFields) !== JSON.stringify(newFields)) throw new Error('receipt_conflict');
      return;
    } catch (e) { if (!missing(e)) throw e; }
    if ((await readdir(this.file('pending'))).length >= 10_000) throw new Error('pending_limit');
    await this.atomic(file, receipt);
  }
  async pending(): Promise<Receipt[]> {
    await this.assertScope();
    const receipts: Receipt[] = [];
    for (const name of await readdir(this.file('pending'))) {
      if (!name.endsWith('.json')) continue;
      const receipt = await this.json(`pending/${name}`);
      if (!UUID.test(receipt.eventId ?? '') || name !== `${receipt.eventId}.json` ||
          !UUID.test(receipt.threadId ?? '') || !validSequence(receipt.sequence) ||
          typeof receipt.sender !== 'string' || (receipt.state !== undefined && !['pending', 'observed'].includes(receipt.state))) {
        throw new Error('invalid_pending_receipt');
      }
      receipts.push(receipt);
    }
    return receipts.sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
  }
  async processed(eventId: string) {
    await this.assertScope();
    if (!UUID.test(eventId)) throw new Error('invalid_event_id');
    // This is local receipt removal, not remote acknowledgement or authority.
    await unlink(this.file(`pending/${eventId}.json`));
  }
  async observed(eventId: string) {
    await this.assertScope();
    if (!UUID.test(eventId)) throw new Error('invalid_event_id');
    const receipts = await this.pending();
    const receipt = receipts.find(r => r.eventId === eventId);
    if (!receipt) throw new Error('receipt_missing');
    await this.atomic(`pending/${eventId}.json`, { ...receipt, state: 'observed' });
  }
  async reportArming(armed: boolean, taskId: string) {
    await this.assertScope();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('invalid_runtime_task_id');
    await this.atomic('arming.json', { state: armed ? 'reported-armed' : 'reported-unarmed',
      taskId, at: new Date().toISOString(), proof: 'runtime-report-only-not-confirmed-awareness' });
  }
  async stopped() {
    try { await readFile(this.file('stop')); return true; }
    catch (e) { if (missing(e)) return false; throw e; }
  }
  async stop() { await this.assertScope(); await this.atomic('stop', { requestedAt: new Date().toISOString() }); }
  async heartbeat(state: string, extra: Record<string, unknown> = {}) {
    let previous: Record<string, unknown> = {};
    try { previous = await this.json('heartbeat.json'); } catch (e) { if (!missing(e)) throw e; }
    await this.atomic('heartbeat.json', { ...previous, ...extra, ...this.scope, state, at: new Date().toISOString(),
      pid: process.pid, pending: (await this.pending()).length,
      notificationArming: 'unknown-runtime-owned', lifetime: 'active-session-until-explicit-stop' });
  }
  async status(now = Date.now()) {
    const ownership = await ownershipStatus(this.directory);
    try { await this.assertScope(); } catch (e) {
      if (!missing(e)) throw e;
      return { ...this.scope, ...ownership, health: 'uninitialized', notificationArming: 'unknown-runtime-owned',
        pending: [], after: null, coverage: {}, reportedArming: { state: 'unknown' } };
    }
    const heartbeat = await this.json('heartbeat.json');
    const ageMs = now - Date.parse(heartbeat.at);
    let lockPresent = true;
    try { await readFile(this.file('watch.lock')); } catch (e) { if (!missing(e)) throw e; lockPresent = false; }
    let reportedArming: unknown = { state: 'unknown' };
    try { reportedArming = await this.json('arming.json'); } catch (e) { if (!missing(e)) throw e; }
    return { ...heartbeat, ...ownership, ageMs, lockPresent, reportedArming,
      health: !lockPresent ? 'stopped' : (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 90_000 ? 'stale' : 'recent-heartbeat'),
      pending: await this.pending(), after: await this.cursor(),
      notificationArming: 'unknown-runtime-owned' };
  }
}

export interface ListenerOptions {
  store: ListenerStore; mode: 'continuous' | 'once'; initialAfter?: number; resume?: boolean;
  signal: AbortSignal; inbox: (after: number, token?: string) => Promise<InboxPage>;
  emit: (line: string) => void; sleep?: (ms: number) => Promise<void>; intervalMs?: number;
  parent?: ParentIdentity; ownerIdentity?: string; readIdentity?: (pid: number) => Promise<ProcessIdentity>;
}

export async function runListener(options: ListenerOptions) {
  const { store, signal, emit } = options;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  }));
  await store.acquire(options.initialAfter, options.resume, options.ownerIdentity, options.parent);
  let failures = 0;
  try {
    emit(`LUCAMSG_READY actor=${store.scope.actor} mode=${options.mode} lifetime=active-session`);
    while (!signal.aborted && !await store.stopped()) {
      if (options.parent) {
        const state = await parentState(options.parent, options.readIdentity);
        await store.heartbeat('checking-parent', { parentIdentity: state });
        if (state === 'absent') {
          emit(`LUCAMSG_PARENT_GONE actor=${store.scope.actor}`);
          return LISTENER_EXIT.parentGone;
        }
        if (state === 'unknown') emit(`LUCAMSG_PARENT_UNKNOWN actor=${store.scope.actor} action=retain-ownership`);
      }
      const pending = (await store.pending()).filter(r => r.state !== 'observed' && r.sender !== store.scope.actor);
      if (pending.length) {
        await store.heartbeat('notification-available');
        emit(`LUCAMSG_ALERT actor=${store.scope.actor} pending=${pending.length} after=${await store.cursor()}`);
      }
      if (pending.length && options.mode === 'once') {
        return LISTENER_EXIT.available;
      }
      try {
        const after = await store.cursor();
        let token: string | undefined;
        let through: number | undefined;
        let pages = 0;
        const tokens = new Set<string>();
        let coverage: Record<string, unknown> = {};
        do {
          if (signal.aborted || await store.stopped()) return LISTENER_EXIT.stopped;
          const page = await options.inbox(after, token);
          const receipts = pageReceipts(page, store.scope.actor, after);
          if (through !== undefined && page.window.through !== through) throw new Error('window_changed');
          through = page.window.through;
          for (const receipt of receipts) await store.save(receipt);
          const pageCoverage = { core: page.core?.complete, adapter: page.adapterOverlay?.complete,
            linked: page.linkedState?.complete, legacy: page.legacyCoverage?.complete };
          for (const [name, complete] of Object.entries(pageCoverage)) {
            coverage[name] = coverage[name] === false || complete === false ? false
              : coverage[name] === 'unknown' || complete === undefined ? 'unknown' : true;
          }
          await store.heartbeat('reading-window', { coverage, page: pages + 1, windowThrough: through });
          token = page.window.complete ? undefined : page.window.nextToken!;
          if (++pages > 100 || (token && tokens.has(token))) throw new Error('continuation_loop');
          if (token) tokens.add(token);
        } while (token);
        if (signal.aborted || await store.stopped()) return LISTENER_EXIT.stopped;
        await store.advance(through!);
        failures = 0;
        await store.heartbeat('listening', { coverage });
        const count = (await store.pending()).filter(r => r.state !== 'observed' && r.sender !== store.scope.actor).length;
        if (count) {
          emit(`LUCAMSG_ALERT actor=${store.scope.actor} pending=${count} after=${through}`);
          if (options.mode === 'once') return LISTENER_EXIT.available;
        }
      } catch {
        if (signal.aborted) return LISTENER_EXIT.stopped;
        failures++;
        await store.heartbeat('fetch-failed', { failures });
        emit(`LUCAMSG_ERROR actor=${store.scope.actor} failures=${failures}`);
        if (failures >= 6) throw new Error('repeated_inbox_failure');
      }
      await sleep(options.intervalMs ?? 20_000);
    }
    return LISTENER_EXIT.stopped;
  } finally {
    try { await store.heartbeat('stopped'); } finally { await store.release(); }
    emit(`LUCAMSG_STOP actor=${store.scope.actor}`);
  }
}
