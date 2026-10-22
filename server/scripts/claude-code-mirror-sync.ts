/**
 * Claude Code transcript mirror: sync client (recording-gap design R6.5, stage R-P3).
 *
 *   npx tsx server/scripts/claude-code-mirror-sync.ts --transcript <path> --session <id> [--remote URL] [--budget-ms N]
 *
 * Preservation only. It filters the local transcript with the shared core, asks
 * the server which 256-position blocks differ from its confirmed digests, sends
 * the exact tuples for those blocks, and uploads only the entries the server
 * lacks, oldest first, in bounded batches. It never publishes canonical dialogue.
 *
 * Positions are the index among successfully parsed, non-empty lines: the same
 * coordinate the existing Stop recorder uses, so capture ids stay compatible.
 * One sync per session at a time (an exclusive local lock with the owner pid;
 * a stale lock is taken over only when that pid is gone). Every failure exits
 * non-zero with a reason and is retried by the next hook event or sweep.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  blockDigest,
  blockIndexOf,
  contentSha256,
  filterEntry,
  type MirrorTuple,
} from '@shared/claude-code-mirror-core.mjs';
import { getAgentAuthHeaders } from '../services/agent-auth';

export interface LocalEntry { position: number; uuid: string; entry: Record<string, unknown>; sha256: string }

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
    out.push({ position, uuid: typeof rawUuid === 'string' && UUID.test(rawUuid) ? rawUuid : '', entry, sha256: contentSha256(entry) });
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

/** Splits entries into upload batches within the server's count and byte limits. Pure. */
export function batches(entries: LocalEntry[], maxCount = 200, maxBytes = 4 * 1024 * 1024): LocalEntry[][] {
  const out: LocalEntry[][] = [];
  let cur: LocalEntry[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = Buffer.byteLength(JSON.stringify(e.entry), 'utf8') + 128;
    if (cur.length && (cur.length >= maxCount || bytes + size > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(e);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Exclusive per-session lock; returns a release function, or null when another live sync holds it. */
export function acquireLock(dir: string, sessionId: string): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already gone */ } };
    } catch {
      const owner = Number(existsSync(path) ? readFileSync(path, 'utf8') : NaN);
      if (Number.isSafeInteger(owner) && pidAlive(owner)) return null;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return null;
}

async function post(remote: string, path: string, body: unknown, headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${remote}/api/internal/claude-code-mirror/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export async function syncSession(opts: { transcript: string; sessionId: string; remote: string; budgetMs: number; headers: Record<string, string> }): Promise<{ sent: number; blocksDiffering: number; complete: boolean }> {
  const started = Date.now();
  const entries = readTranscript(readFileSync(opts.transcript, 'utf8'));
  const blocks = localBlocks(opts.sessionId, entries);
  const coverage = await post(opts.remote, 'coverage', { sessionId: opts.sessionId, blocks: blocks.map(({ index, digest }) => ({ index, digest })) }, opts.headers);
  const byPosition = new Map(entries.map((e) => [e.position, e]));
  let sent = 0;
  for (const index of coverage.differing as number[]) {
    if (Date.now() - started > opts.budgetMs) return { sent, blocksDiffering: coverage.differing.length, complete: false };
    const block = blocks.find((b) => b.index === index)!;
    const check = await post(opts.remote, 'block-tuples', { sessionId: opts.sessionId, blockIndex: index, localDigest: block.digest, tuples: block.tuples }, opts.headers);
    const missing = (check.missing as MirrorTuple[]).map((t) => byPosition.get(t.position)!).filter(Boolean);
    for (const batch of batches(missing)) {
      await post(opts.remote, 'entries', { sessionId: opts.sessionId, entries: batch.map((e) => ({ position: e.position, uuid: e.uuid, entry: e.entry })) }, opts.headers);
      sent += batch.length;
    }
    if (missing.length) await post(opts.remote, 'block-tuples', { sessionId: opts.sessionId, blockIndex: index, localDigest: block.digest, tuples: block.tuples }, opts.headers);
  }
  return { sent, blocksDiffering: coverage.differing.length, complete: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const transcript = arg(args, 'transcript');
  const sessionId = arg(args, 'session');
  const remote = arg(args, 'remote') ?? 'https://getholahola.com';
  const budgetMs = Number(arg(args, 'budget-ms') ?? 60_000);
  if (!transcript || !sessionId || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) throw new Error('usage: --transcript <path> --session <id> [--remote URL] [--budget-ms N]');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(remote)) throw new Error('--remote must be an https origin');
  const headers = getAgentAuthHeaders('luca-claude-code');
  if (!headers) throw new Error('Luca [Claude Code] coordination credential is not set');
  const release = acquireLock(resolve('.local/claude-code-mirror'), sessionId);
  if (!release) { console.log('[mirror-sync] another sync for this session is running; skipping'); return; }
  try {
    const result = await syncSession({ transcript, sessionId, remote, budgetMs, headers });
    console.log(`[mirror-sync] session ${sessionId}: sent ${result.sent}, differing blocks ${result.blocksDiffering}, ${result.complete ? 'complete' : 'budget reached; resumes next run'}`);
  } finally {
    release();
  }
}

if (process.argv[1] && /claude-code-mirror-sync\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`[mirror-sync] failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}

