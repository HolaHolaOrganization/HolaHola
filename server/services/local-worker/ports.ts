/**
 * Local Read-only Worker v1 — production ports for the supervisor.
 *  - HTTP ledger port: 5 s bounded reads, error codes preserved (design §5.6).
 *  - Host port: git, harness resolution, staging, Job Object launcher.
 *  - File state store under %LOCALAPPDATA%\HolaHola\worker (design §5.1, §5.7).
 * The model process never receives the coordination token (buildHarnessEnv).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../../shared/worker-contracts';
import { pickNewestExecutable, sha256File } from './adapter';
import type { CharterRecord } from './authority';
import { startJobLauncher } from './job-launcher';
import type { LedgerAppendResult, OutboxEntry, RemoteRead } from './lifecycle';
import { parseLsTreeZ } from './paths';
import { removeStaging, stageFiles, validateHarnessOutput, verifyStagedTree } from './staging';
import type { HostPort, JobsPage, LaunchHandle, LedgerPort, StateStore, ThreadView } from './supervisor';

// ---------------------------------------------------------------------------
// HTTP ledger port
// ---------------------------------------------------------------------------

export function createHttpLedgerPort(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): LedgerPort {
  const base = baseUrl.replace(/\/+$/, '');
  async function call(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string, timeoutMs = 5000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method, signal: ctl.signal,
        headers: { accept: 'application/json', 'x-coordination-token': token,
          ...(body ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: Record<string, any> = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
      return { status: res.status, json };
    } catch (e) {
      return { status: 0, json: { code: (e as Error).name === 'AbortError' ? 'timeout' : 'network_error' } };
    } finally { clearTimeout(t); }
  }
  const readErr = (status: number, json: Record<string, any>): RemoteRead<never> => {
    if (status === 0) return { ok: false, error: json.code === 'timeout' ? 'timeout' : 'network' };
    if (status === 403 && (json.code === 'not_participant' || /participant/i.test(String(json.error ?? '')))) return { ok: false, error: 'not_participant' };
    return { ok: false, error: status >= 500 ? 'http_5xx' : 'http_4xx' };
  };
  return {
    async getCharter(id, version): Promise<RemoteRead<CharterRecord>> {
      const r = await call('GET', `/api/worker-charters/${encodeURIComponent(id)}/versions/${version}`);
      if (r.status !== 200) return readErr(r.status, r.json);
      const j = r.json;
      return { ok: true, value: { id: j.id, version: j.version, body: j.body, bodyDigest: j.bodyDigest, approvalState: j.approvalState, approvedAt: j.approvedAt } };
    },
    async listJobs(q): Promise<RemoteRead<JobsPage>> {
      const qs = new URLSearchParams({ charterId: q.charterId, charterVersion: String(q.charterVersion), after: String(q.after), limit: String(q.limit) });
      const r = await call('GET', `/api/worker/jobs?${qs}`);
      if (r.status !== 200) return readErr(r.status, r.json);
      return { ok: true, value: { jobs: r.json.jobs, nextAfter: r.json.nextAfter, complete: r.json.complete === true, acceptedInWindow: Number(r.json.acceptedInWindow) } };
    },
    async showThread(threadId): Promise<RemoteRead<ThreadView>> {
      const r = await call('GET', `/api/coordination/threads/${encodeURIComponent(threadId)}`);
      if (r.status !== 200) return readErr(r.status, r.json);
      const t = r.json.thread;
      return {
        ok: true,
        value: {
          thread: { id: t.id, state: t.state, originActor: t.originActor, intendedRecipient: t.intendedRecipient, currentOwner: t.currentOwner ?? null,
            latestSequence: t.latestSequence, sourceReference: t.sourceReference ?? null },
          events: (r.json.events ?? []).map((e: Record<string, any>) => ({
            // Missing fields stay undefined (unknown); they are never defaulted into a match.
            idempotencyKey: e.idempotencyKey, eventType: e.eventType, payload: e.payload,
            evidence: Array.isArray(e.evidence) ? e.evidence : undefined,
            content: typeof e.content === 'string' ? e.content : undefined,
            recipientActor: e.recipientActor === null || typeof e.recipientActor === 'string' ? e.recipientActor : undefined,
            sequence: e.sequence, actor: e.actor, createdAt: e.createdAt,
          })),
        },
      };
    },
    async append(threadId, eventType, input): Promise<LedgerAppendResult> {
      const r = await call('POST', `/api/coordination/threads/${encodeURIComponent(threadId)}/events`, {
        eventType, content: input.content, expectedSequence: input.expectedSequence,
        ...(input.recipientActor ? { recipientActor: input.recipientActor } : {}),
        ...(input.evidence && input.evidence.length ? { evidence: input.evidence } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
      }, input.idempotencyKey, 15_000);
      if (r.status === 200 || r.status === 201) {
        const ev = r.json.event ?? {};
        return {
          ok: true, deduplicated: r.json.deduplicated === true,
          event: {
            eventType: ev.eventType, payload: ev.payload,
            ...(Array.isArray(ev.evidence) ? { evidence: ev.evidence } : {}),
            ...(typeof ev.content === 'string' ? { content: ev.content } : {}),
            ...(ev.recipientActor === null || typeof ev.recipientActor === 'string' ? { recipientActor: ev.recipientActor } : {}),
          },
        };
      }
      if (r.status === 0) return { ok: false, errorCode: r.json.code === 'timeout' ? 'timeout' : 'network_error' };
      return { ok: false, errorCode: String(r.json.code ?? 'unknown'), httpStatus: r.status };
    },
  };
}

// ---------------------------------------------------------------------------
// Host port
// ---------------------------------------------------------------------------

export function createHostPort(input: { repoRoot: string; stagingRoot: string }): HostPort {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: input.repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }),
    async fetchOrigin() { try { git('fetch', '--quiet', 'origin', 'main'); return true; } catch { return false; } },
    commitExists(c) { try { git('cat-file', '-e', `${c}^{commit}`); return true; } catch { return false; } },
    isAncestorOfOriginMain(c) { try { git('merge-base', '--is-ancestor', c, 'origin/main'); return true; } catch { return false; } },
    lsTree(c) { try { return parseLsTreeZ(git('ls-tree', '-r', '-l', '-z', c)); } catch { return null; } },
    async resolveHarness() {
      const packages = join(process.env.LOCALAPPDATA ?? '', 'Packages');
      if (!existsSync(packages)) return null;
      const candidates: { version: string; path: string }[] = [];
      for (const pkg of readdirSync(packages).filter((n) => /^Claude_[a-z0-9]+$/i.test(n))) {
        const root = join(packages, pkg, 'LocalCache', 'Roaming', 'Claude', 'claude-code');
        if (!existsSync(root)) continue;
        for (const version of readdirSync(root)) {
          const vdir = join(root, version);
          for (const hash of existsSync(vdir) ? readdirSync(vdir) : []) {
            const exe = join(vdir, hash, 'claude.exe');
            if (existsSync(exe)) candidates.push({ version, path: exe });
          }
        }
      }
      const pick = pickNewestExecutable(candidates);
      return pick ? { ...pick, sha256: await sha256File(pick.path) } : null;
    },
    stage(commit, files) {
      const dir = join(input.stagingRoot, randomBytes(4).toString('hex'), 'in');
      return stageFiles({ repoRoot: input.repoRoot, commit, files, stagingDir: dir });
    },
    removeStaging: (dir) => removeStaging(join(dir, '..')),
    verifyStaged: verifyStagedTree,
    validate: validateHarnessOutput,
    launch(cfg): LaunchHandle {
      const h = startJobLauncher({ exe: cfg.exe, args: cfg.args, cwd: cfg.cwd, env: cfg.env });
      return {
        terminate: h.terminate,
        killLauncher: h.killLauncher,
        listMembers: h.listMembers,
        exited: h.exited.then((e) => ({ code: e.code, spawnFailed: e.spawnFailed })),
        stdout: () => ({ text: Buffer.concat(h.harnessStdout).toString('utf8'), overflow: h.overflow.stdout }),
      };
    },
    env: () => ({ ...process.env }),
  };
}

// ---------------------------------------------------------------------------
// File state store
// ---------------------------------------------------------------------------

/**
 * F6: a process identity read is tri-state. `absent` is returned ONLY when the
 * query itself succeeded and found no such process; any query failure is
 * `unknown`, which never counts as proof that a lock is stale.
 */
export type ProcessIdentityRead =
  | { state: 'present'; creationDate: string; executablePath: string }
  | { state: 'absent' }
  | { state: 'unknown' };

export function readProcessIdentity(pid: number): ProcessIdentityRead {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  try {
    const out = execFileSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; $p = @(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"); if ($p.Count -eq 0) { 'ABSENT' } elseif ($p.Count -eq 1 -and $p[0].CreationDate -and $p[0].ExecutablePath) { 'PRESENT|' + $p[0].CreationDate.ToUniversalTime().ToString('o') + '|' + $p[0].ExecutablePath } else { 'UNKNOWN' }`],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
    if (out === 'ABSENT') return { state: 'absent' };
    const m = /^PRESENT\|([^|]+)\|(.+)$/.exec(out);
    return m ? { state: 'present', creationDate: m[1], executablePath: m[2] } : { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}

type LockRecord = { pid: number; creationDate: string; executablePath: string; runNonce: string };

function parseLock(raw: string): LockRecord | null {
  try {
    const j = JSON.parse(raw) as Partial<LockRecord>;
    if (!Number.isSafeInteger(j.pid) || typeof j.creationDate !== 'string' || typeof j.executablePath !== 'string' || typeof j.runNonce !== 'string') return null;
    return j as LockRecord;
  } catch { return null; }
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { flag: 'wx' });
  renameSync(tmp, path);
}

export function defaultStateDir(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'HolaHola', 'worker');
}

export type FileStateStoreOptions = {
  /** Identity reader (tests inject failures); defaults to the CIM query above. */
  identity?: (pid: number) => ProcessIdentityRead;
  /** Test seam: runs inside the reclaim mutex, after the stale record is re-verified and before it is replaced. */
  beforeReclaimReplace?: () => void;
};

export function createFileStateStore(dir: string = defaultStateDir(), opts: FileStateStoreOptions = {}): StateStore {
  if (/^\\\\/.test(dir) || !/^[A-Za-z]:\\/.test(dir)) throw new Error('state_dir_must_be_local_drive');
  for (const d of [dir, join(dir, 'outbox'), join(dir, 'receipts'), join(dir, 'launched')]) mkdirSync(d, { recursive: true });
  const identity = opts.identity ?? readProcessIdentity;
  const lockPath = join(dir, 'supervisor.lock');
  const reclaimPath = join(dir, 'supervisor.lock.reclaim');
  const instPath = join(dir, 'instance.json');
  const scanPath = join(dir, 'scan.json');
  let ownRecord: string | null = null;

  const createLock = (record: string): boolean => {
    let fd: number;
    try { fd = openSync(lockPath, 'wx'); } catch { return false; }
    try { writeSync(fd, record); } finally { closeSync(fd); }
    return true;
  };

  return {
    instanceId() {
      if (!existsSync(instPath)) {
        try { writeFileSync(instPath, JSON.stringify({ instanceId: randomUUID(), createdAt: new Date().toISOString() }), { flag: 'wx' }); } catch { /* raced: read below */ }
      }
      return JSON.parse(readFileSync(instPath, 'utf8')).instanceId as string;
    },
    acquireLock(runNonce, reclaimStale) {
      // A lock we cannot later prove is ours (no confirmed own identity) is never created.
      const me = identity(process.pid);
      if (me.state !== 'present') return { ok: false, reason: 'own_identity_unknown' };
      const record = JSON.stringify({ pid: process.pid, creationDate: me.creationDate, executablePath: me.executablePath, runNonce } satisfies LockRecord);
      if (createLock(record)) { ownRecord = record; return { ok: true }; }
      if (!reclaimStale) return { ok: false, reason: 'held' };

      let raw: string;
      try { raw = readFileSync(lockPath, 'utf8'); } catch { return { ok: false, reason: 'lock_unreadable' }; }
      const held = parseLock(raw);
      if (!held) return { ok: false, reason: 'lock_unreadable' };
      const live = identity(held.pid);
      if (live.state === 'unknown') return { ok: false, reason: 'holder_identity_unknown' };
      if (live.state === 'present' && live.creationDate === held.creationDate && live.executablePath === held.executablePath) {
        return { ok: false, reason: 'held_by_live_process' };
      }
      // Confirmed stale: no process, or the pid now belongs to a different process (PID reuse).
      let mutex: number;
      try { mutex = openSync(reclaimPath, 'wx'); } catch { return { ok: false, reason: 'reclaim_in_progress' }; }
      try {
        writeSync(mutex, record);
        let again: string;
        try { again = readFileSync(lockPath, 'utf8'); } catch { again = ''; }
        if (again !== raw) return { ok: false, reason: 'lock_changed' };
        opts.beforeReclaimReplace?.();
        // Preserve the stale record as evidence; rename is atomic and never touches a replaced lock's bytes.
        try { renameSync(lockPath, `${lockPath}.stale.${sha256Hex(raw).slice(0, 16)}`); } catch { return { ok: false, reason: 'lock_changed' }; }
        if (!createLock(record)) return { ok: false, reason: 'held' };
        ownRecord = record;
        return { ok: true };
      } finally {
        closeSync(mutex);
        try { unlinkSync(reclaimPath); } catch { /* best effort; a leftover mutex makes the next reclaim refuse */ }
      }
    },
    releaseLock() {
      if (ownRecord === null) return { released: false, reason: 'not_acquired' };
      let raw: string;
      try { raw = readFileSync(lockPath, 'utf8'); } catch { ownRecord = null; return { released: false, reason: 'lock_missing' }; }
      if (raw !== ownRecord) return { released: false, reason: 'lock_owned_by_another_record' };
      try { unlinkSync(lockPath); } catch { return { released: false, reason: 'unlink_failed' }; }
      ownRecord = null;
      return { released: true };
    },
    outbox() {
      return readdirSync(join(dir, 'outbox')).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(readFileSync(join(dir, 'outbox', f), 'utf8')) as unknown; } catch { return { corrupt: f }; }
      });
    },
    saveOutbox(entry: OutboxEntry) { atomicWrite(join(dir, 'outbox', `${sha256Hex(entry.key).slice(0, 24)}.json`), JSON.stringify(entry)); },
    receipt(threadId, kind, data) {
      atomicWrite(join(dir, 'receipts', `${threadId}.${kind}.${Date.now()}.${randomBytes(2).toString('hex')}.json`), JSON.stringify({ threadId, kind, at: new Date().toISOString(), data }));
    },
    launched: (key) => existsSync(join(dir, 'launched', sha256Hex(key).slice(0, 32))),
    markLaunched: (key) => { writeFileSync(join(dir, 'launched', sha256Hex(key).slice(0, 32)), key, { flag: 'w' }); },
    scanAfter(charterId, version) {
      try { return Number(JSON.parse(readFileSync(scanPath, 'utf8'))[`${charterId}:${version}`] ?? 0); } catch { return 0; }
    },
    saveScanAfter(charterId, version, after) {
      let m: Record<string, number> = {};
      try { m = JSON.parse(readFileSync(scanPath, 'utf8')); } catch { m = {}; }
      m[`${charterId}:${version}`] = after;
      atomicWrite(scanPath, JSON.stringify(m));
    },
  };
}
