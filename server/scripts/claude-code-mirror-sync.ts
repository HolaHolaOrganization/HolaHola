/**
 * Claude Code transcript mirror: sync client (recording-gap design R6.5, stage R-P3).
 *
 *   npx tsx server/scripts/claude-code-mirror-sync.ts --transcript <path> --session <id> --runtime-id <id> [--remote URL] [--budget-ms N]
 *
 * Preservation only. It filters the local transcript with the shared core, asks
 * the server which 256-position blocks differ from its confirmed digests, sends
 * the exact tuples for those blocks, and uploads only the entries the server
 * lacks, oldest first, in bounded batches. It never publishes canonical dialogue.
 *
 * - Positions are the index among truthy parsed, non-empty lines: the existing
 *   Stop recorder's coordinate, so capture ids stay compatible.
 * - An entry above the server's per-entry limit is never clipped, dropped or
 *   claimed as preserved: it is listed in the local status file as unaccepted,
 *   its block stays unconfirmed, and the run reports complete:false while every
 *   other entry still syncs.
 * - One sync per session at a time: an exclusive local lock whose token names its
 *   owner. A live owner's lock is never moved or deleted by anyone else; a dead
 *   owner's lock is taken over only under an exclusive takeover claim. The lock
 *   is an efficiency guard; the server is idempotent and serializes per session.
 * - One shared deadline bounds every request of the run; an expired run returns
 *   partial progress (complete:false) and the next hook event resumes.
 * - Authentication is the actor's own runtime credential (RuntimeOnboardingClient
 *   for luca-claude-code), never a raw legacy token.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  blockDigest,
  blockIndexOf,
  canonicalJson,
  contentSha256,
  filterEntry,
  type MirrorTuple,
} from '@shared/claude-code-mirror-core.mjs';

/** Must equal the server's MIRROR_LIMITS.maxEntryBytes (a test pins it). */
export const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_REQUEST_MS = 30_000;

export interface LocalEntry { position: number; uuid: string; entry: Record<string, unknown>; sha256: string; bytes: number }

const UUID = /^[A-Za-z0-9-]{1,64}$/;

/** Parses transcript text into filtered, positioned entries. Pure. */
export function readTranscript(text: string): LocalEntry[] {
  const out: LocalEntry[] = [];
  let position = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    // The recorder keeps every truthy parsed value (filter(Boolean)), so positions count exactly those.
    if (!raw) continue;
    const rawUuid = (raw as { uuid?: unknown }).uuid;
    const entry = filterEntry(raw);
    out.push({
      position, uuid: typeof rawUuid === 'string' && UUID.test(rawUuid) ? rawUuid : '', entry,
      sha256: contentSha256(entry), bytes: Buffer.byteLength(canonicalJson(entry), 'utf8'),
    });
    position++;
  }
  return out;
}

/** Groups entries into blocks with their local digests. Pure. */
export function localBlocks(sessionId: string, entries: LocalEntry[]): Array<{ index: number; digest: string; tuples: MirrorTuple[] }> {
  const groups = new Map<number, MirrorTuple[]>();
  for (const e of entries) {
    const i = blockIndexOf(e.position);
    if (!groups.has(i)) groups.set(i, []);
    groups.get(i)!.push({ position: e.position, uuid: e.uuid, sha256: e.sha256 });
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([index, tuples]) => ({ index, digest: blockDigest(sessionId, tuples), tuples }));
}

/** Splits uploadable entries into batches within the server's count and byte limits. Pure. */
export function batches(entries: LocalEntry[], maxCount = 200, maxBytes = 4 * 1024 * 1024): LocalEntry[][] {
  const out: LocalEntry[][] = [];
  let cur: LocalEntry[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = e.bytes + 128;
    if (cur.length && (cur.length >= maxCount || bytes + size > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(e);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- Lock: compare-and-swap on an owner token -------------------------------------------

type KillFn = (pid: number, signal: 0) => void;

/** 'dead' only when the OS says the process does not exist; any other error is not evidence of death. */
export function ownerState(pid: number, kill: KillFn = (p, s) => { process.kill(p, s); }): 'alive' | 'dead' | 'unknown' {
  try { kill(pid, 0); return 'alive'; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function createExclusive(path: string, content: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try { writeSync(fd, content); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** Releases a lock only if it still holds this owner's token. A live owner's lock is never replaced by anyone else, so read-then-unlink is safe here. */
export function releaseIfOwned(path: string, token: string): boolean {
  if (readOrNull(path) !== token) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

/**
 * Exclusive per-session lock; returns a release function, or null when another,
 * an unknown, or a contended owner holds it.
 *
 * Taking over a dead owner's lock requires an exclusive takeover claim
 * (<lock>.takeover, created with 'wx'). Only the claimant may delete the lock,
 * and only after re-reading it as the same dead owner's token. Nobody ever moves
 * or deletes a live owner's lock, so a third contender can only win by creating
 * the lock after the stale one is gone, in which case the claimant's own
 * exclusive create fails and it backs off. A leftover claim (a claimant that
 * died inside this window) fails closed: no automatic takeover.
 * `hooks.afterStaleRemoved` exists only for tests to inject a contender.
 */
export function acquireLock(dir: string, sessionId: string, kill?: KillFn, hooks: { afterStaleRemoved?: () => void } = {}): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.lock`);
  const token = `${process.pid}:${randomUUID()}`;
  if (createExclusive(path, token)) return () => { releaseIfOwned(path, token); };
  const seen = readOrNull(path);
  if (seen === null) return createExclusive(path, token) ? () => { releaseIfOwned(path, token) } : null;
  const pid = Number(seen.split(':')[0]);
  if (!Number.isSafeInteger(pid) || ownerState(pid, kill) !== 'dead') return null;
  const claimPath = `${path}.takeover`;
  if (!createExclusive(claimPath, token)) return null;
  try {
    if (readOrNull(path) !== seen) return null; // changed since inspected: not ours to touch
    try { unlinkSync(path); } catch { return null; }
    hooks.afterStaleRemoved?.();
    return createExclusive(path, token) ? () => { releaseIfOwned(path, token); } : null;
  } finally {
    releaseIfOwned(claimPath, token);
  }
}

// ---- Sync ----------------------------------------------------------------------------

export type Transport = (path: string, body: unknown, signal: AbortSignal) => Promise<any>;

export interface SyncResult {
  sent: number;
  blocksDiffering: number;
  complete: boolean;
  reason: 'complete' | 'budget' | 'unaccepted-entries';
  unaccepted: Array<{ position: number; bytes: number }>;
}

export async function syncSession(opts: {
  text: string; sessionId: string; budgetMs: number; transport: Transport; now?: () => number;
}): Promise<SyncResult> {
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs <= 0) throw new Error('budget must be a finite positive number of milliseconds');
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const call = async (path: string, body: unknown) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new BudgetExpired();
    return opts.transport(path, body, AbortSignal.timeout(Math.min(MAX_REQUEST_MS, remaining)));
  };
  /** Checked after every awaited request, once its confirmed progress is counted. */
  const checkDeadline = () => { if (now() > deadline) throw new BudgetExpired(); };
  const entries = readTranscript(opts.text);
  const blocks = localBlocks(opts.sessionId, entries);
  const byPosition = new Map(entries.map((e) => [e.position, e]));
  const unaccepted = entries.filter((e) => e.bytes > MAX_ENTRY_BYTES).map((e) => ({ position: e.position, bytes: e.bytes }));
  const unacceptedAt = new Set(unaccepted.map((u) => u.position));
  let sent = 0;
  let differing: number[] = [];
  try {
    const coverage = await call('coverage', { sessionId: opts.sessionId, blocks: blocks.map(({ index, digest }) => ({ index, digest })) });
    differing = coverage.differing as number[];
    checkDeadline();
    for (const index of differing) {
      const block = blocks.find((b) => b.index === index)!;
      const check = await call('block-tuples', { sessionId: opts.sessionId, blockIndex: index, localDigest: block.digest, tuples: block.tuples });
      checkDeadline();
      const missing = (check.missing as MirrorTuple[]).map((t) => byPosition.get(t.position)).filter((e): e is LocalEntry => Boolean(e));
      const uploadable = missing.filter((e) => !unacceptedAt.has(e.position));
      for (const batch of batches(uploadable)) {
        await call('entries', { sessionId: opts.sessionId, entries: batch.map((e) => ({ position: e.position, uuid: e.uuid, entry: e.entry })) });
        sent += batch.length;
        checkDeadline();
      }
      // Re-confirm only when every missing tuple of this block was uploadable.
      if (uploadable.length && uploadable.length === missing.length) {
        await call('block-tuples', { sessionId: opts.sessionId, blockIndex: index, localDigest: block.digest, tuples: block.tuples });
        checkDeadline();
      }
    }
    checkDeadline();
  } catch (e) {
    if (e instanceof BudgetExpired || (e as Error)?.name === 'TimeoutError') {
      return { sent, blocksDiffering: differing.length, complete: false, reason: 'budget', unaccepted };
    }
    throw e;
  }
  if (unaccepted.length) return { sent, blocksDiffering: differing.length, complete: false, reason: 'unaccepted-entries', unaccepted };
  return { sent, blocksDiffering: differing.length, complete: true, reason: 'complete', unaccepted };
}

class BudgetExpired extends Error {}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const transcript = arg(args, 'transcript');
  const sessionId = arg(args, 'session');
  const runtimeId = arg(args, 'runtime-id') ?? process.env.HOLAHOLA_RUNTIME_ID;
  const remote = arg(args, 'remote') ?? 'https://getholahola.com';
  const budgetMs = Number(arg(args, 'budget-ms') ?? 60_000);
  if (!transcript || !sessionId || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) throw new Error('usage: --transcript <path> --session <id> --runtime-id <id> [--remote URL] [--budget-ms N]');
  if (!runtimeId) throw new Error('a runtime id is required (--runtime-id or HOLAHOLA_RUNTIME_ID): the sync uses the actor\'s own runtime credential');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(remote)) throw new Error('--remote must be an https origin');
  const { RuntimeOnboardingClient } = await import('../services/runtime-onboarding-client');
  const { createNativeRuntimeOnboardingStore } = await import('../services/runtime-onboarding-store');
  const client = new RuntimeOnboardingClient({ endpoint: remote, actor: 'luca-claude-code', runtimeId, store: createNativeRuntimeOnboardingStore() });
  const transport: Transport = async (path, body, signal) => {
    const res = await client.authenticatedFetch(`${remote}/api/coordination/claude-code-mirror/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const dir = resolve('.local/claude-code-mirror');
  const release = acquireLock(dir, sessionId);
  if (!release) { console.log('[mirror-sync] another sync for this session holds the lock; skipping'); return; }
  try {
    const result = await syncSession({ text: readFileSync(transcript, 'utf8'), sessionId, budgetMs, transport });
    writeFileSync(join(dir, `${sessionId}.status.json`), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
    console.log(`[mirror-sync] session ${sessionId}: sent ${result.sent}, differing blocks ${result.blocksDiffering}, ${result.reason}` +
      (result.unaccepted.length ? `; ${result.unaccepted.length} entr${result.unaccepted.length === 1 ? 'y' : 'ies'} above the per-entry limit NOT preserved remotely (see status file)` : ''));
  } finally {
    release();
  }
}

if (process.argv[1] && /claude-code-mirror-sync\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`[mirror-sync] failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}

