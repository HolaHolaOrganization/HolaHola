/**
 * Writer 3 durable intake (attribution design f5d77712 section 3.5,
 * luca-replit seq 529): auto-capture triggers under ATTRIBUTION_WRITERS_V1.
 *
 * A trigger is first moved, by one atomic rename, out of the trigger path into
 * a uniquely named intake record. The trigger path is then free, so fresh
 * input can never overwrite pending input. A record is deleted only after its
 * exchange is durably in the canonical capture log under its caller turn id;
 * from there the canonical pipeline (cursor, canonical row, writer 1's
 * outbox) owns the episode projection and its retries. A record with a
 * missing or invalid id, an unparseable body, or a conflicting retry stays
 * pending and is reported. It is never unlinked, and no id is ever invented.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAutoCaptureExchange } from './canonical-conversation-capture';
import { CHAT_CAPTURE_PATH, parseChatCaptureFromOffset, WORKSPACE } from './transcript-parser';

export const AUTO_CAPTURE_INTAKE_DIR = join(WORKSPACE, '.local/auto-capture-intake');

// Arrival order: wall-clock milliseconds, then a monotonic in-process
// counter (two records in the same millisecond keep their order), then a
// random suffix so names never collide across processes.
let sequence = 0;
const recordName = () =>
  `${String(Date.now()).padStart(15, '0')}-${String(++sequence).padStart(9, '0')}-${randomUUID()}.json`;

/** Move a legacy trigger file into the intake directory (atomic). Returns the record path, or null. */
export function moveTriggerIntoIntake(triggerPath: string, dir = AUTO_CAPTURE_INTAKE_DIR): string | null {
  if (!existsSync(triggerPath)) return null;
  mkdirSync(dir, { recursive: true });
  const target = join(dir, recordName());
  try {
    renameSync(triggerPath, target);
    return target;
  } catch {
    return null; // Another consumer moved it first, or it vanished: nothing lost here.
  }
}

/**
 * Publish a trigger WITHOUT ever overwriting a pending one: the bytes are
 * written to a temporary file, then hard-linked to the trigger path, which
 * fails if the path already exists. Returns false when a trigger is pending.
 */
export function publishTriggerExclusive(triggerPath: string, body: string): boolean {
  const tmp = `${triggerPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, body, 'utf-8');
  try {
    linkSync(tmp, triggerPath);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export interface IntakeOutcome {
  record: string;
  status: 'recorded' | 'exact-retry' | 'pending';
  turnId?: string;
  reason?: string;
}

/** Process every intake record in arrival order. Pure filesystem; no database. */
type IntakeOptions = { capturePath?: string; ingressLockPath?: string };
type IntakePayload = { turnId?: unknown; david?: unknown; luca?: unknown };
const TURN_ID = /^[A-Za-z0-9-]{1,200}$/;
const RECORD_NAME = /^\d{15}-\d{9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

const OWNER = /^(\d{1,10}):[0-9a-f-]{36}$/;

/** True unless the OS says the process does not exist (EPERM means it exists). */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code !== 'ESRCH'; }
}

/**
 * Publish `owner` as the lock in ONE step: written to a private file, then
 * hard-linked to the lock path, which fails if a lock exists. A lock file is
 * therefore never visible without its complete owner record (luca-replit
 * review of PR71, R3).
 */
function publishLock(lockPath: string, owner: string): boolean {
  const tmp = `${lockPath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, owner, 'utf-8');
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * One lock for the whole intake directory, held by the watcher's processing
 * pass and by an operator correction alike, so they never race on a record.
 * Returns 'busy' when another holder has it; the caller simply retries later.
 *
 * Only a PROVABLY dead holder is taken over: a well-formed owner record whose
 * process does not exist. An unreadable or malformed lock is treated as live
 * (busy), never as dead. The takeover renames the observed lock aside and
 * checks it was exactly the dead record; if a live lock was moved instead,
 * it is restored and the caller reports busy. Release removes the lock only
 * while it still holds this holder's own owner record.
 */
function withIntakeLock<T>(dir: string, fn: () => T): T | 'busy' {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.intake.lock');
  const owner = `${process.pid}:${randomUUID()}`;
  if (!publishLock(lockPath, owner)) {
    let observed: string;
    try { observed = readFileSync(lockPath, 'utf-8'); } catch { return 'busy'; }
    const match = OWNER.exec(observed);
    if (!match || processExists(Number(match[1]))) return 'busy';
    const aside = `${lockPath}.${randomUUID()}.stale`;
    try { renameSync(lockPath, aside); } catch { return 'busy'; }
    let moved = '';
    try { moved = readFileSync(aside, 'utf-8'); } catch { /* ignore */ }
    if (moved !== observed) {
      // A live holder replaced the dead lock in between: put it back untouched.
      try { linkSync(aside, lockPath); } catch { /* it re-acquired already */ }
      try { unlinkSync(aside); } catch { /* ignore */ }
      return 'busy';
    }
    try { unlinkSync(aside); } catch { /* ignore */ }
    if (!publishLock(lockPath, owner)) return 'busy';
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf-8') === owner) unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}

function readRecord(record: string): IntakePayload | null {
  try { return JSON.parse(readFileSync(record, 'utf-8')) as IntakePayload; } catch { return null; }
}

/** Append one record's exact bytes under `turnId`; delete the record only on success. Caller holds the lock. */
function commitRecord(record: string, payload: IntakePayload, turnId: string, options: IntakeOptions): IntakeOutcome {
  const result = appendAutoCaptureExchange({
    turnId,
    david: typeof payload.david === 'string' ? payload.david : undefined,
    luca: typeof payload.luca === 'string' ? payload.luca : undefined,
    capturePath: options.capturePath,
    ingressLockPath: options.ingressLockPath,
  });
  // Not accepted (a conflict, or an exchange the canonical consumer would
  // quarantine or block on): nothing was committed and the record stays.
  if (result.kind === 'conflict' || result.kind === 'unsupported') return { record, status: 'pending', turnId, reason: result.reason };
  // The exchange is now in the canonical log, past the canonical cursor until
  // checkChatCapture has inserted its row and enqueued writer 1's mirror (it
  // advances the cursor only after both). That replay obligation survives a
  // crash, so the record's job is done.
  unlinkSync(record);
  return { record, status: result.kind === 'appended' ? 'recorded' : 'exact-retry', turnId };
}

/** Process every intake record in arrival order. Filesystem only; no database. */
export function processAutoCaptureIntake(dir = AUTO_CAPTURE_INTAKE_DIR, options: IntakeOptions = {}): IntakeOutcome[] {
  if (!existsSync(dir)) return [];
  const outcomes = withIntakeLock(dir, () => {
    const out: IntakeOutcome[] = [];
    for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
      const record = join(dir, name);
      const payload = readRecord(record);
      if (!payload) {
        out.push({ record, status: 'pending', reason: 'unparseable intake record; kept for operator review' });
        continue;
      }
      if (typeof payload.turnId !== 'string' || !TURN_ID.test(payload.turnId)) {
        out.push({ record, status: 'pending', reason: 'missing or invalid turnId: kept pending; an id is never invented (resolve with auto-capture-intake-cli assign)' });
        continue;
      }
      out.push(commitRecord(record, payload, payload.turnId, options));
    }
    return out;
  });
  return outcomes === 'busy' ? [] : outcomes;
}

export type AssignResult =
  | { kind: 'recorded' | 'exact-retry'; turnId: string }
  /** The record stays pending, unchanged, with the reason. */
  | { kind: 'pending'; reason: string }
  /** Nothing to correct here; the canonical log is consulted only to report. */
  | { kind: 'not-pending'; canonicalHasTurnId: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'busy' };

/**
 * Operator correction for a missing- or invalid-id record (luca-replit,
 * seq 543). It names ONE existing record and supplies an explicit caller
 * turn id. The record's exact David/Luca bytes and roles are appended under
 * that id through the same locked canonical ingress; nothing else is edited.
 * The record itself is never rewritten. It is deleted only after success, so
 * a crash in between leaves it pending, and the same assignment retried
 * becomes an exact retry. A conflict leaves the record exactly as it was.
 * An intentionally one-sided record stays one-sided. A two-sided exchange
 * whose earlier commit was torn shows up as a conflict ("different set of
 * sides") and is reported, never completed by dropping or inventing a role.
 */
export function assignIntakeTurnId(recordName: string, turnId: string, dir = AUTO_CAPTURE_INTAKE_DIR, options: IntakeOptions = {}): AssignResult {
  if (!RECORD_NAME.test(recordName)) return { kind: 'refused', reason: 'not an intake record name' };
  if (!TURN_ID.test(turnId)) return { kind: 'refused', reason: 'turnId must be 1-200 letters, digits or hyphens' };
  const result = withIntakeLock(dir, (): AssignResult => {
    const record = join(dir, recordName);
    if (!existsSync(record)) {
      const capturePath = options.capturePath ?? CHAT_CAPTURE_PATH;
      const has = existsSync(capturePath) && parseChatCaptureFromOffset(capturePath, 0).turns.some(t => t.captureId === turnId);
      return { kind: 'not-pending', canonicalHasTurnId: has };
    }
    const payload = readRecord(record);
    if (!payload) return { kind: 'refused', reason: 'record is unparseable; its bytes cannot be committed' };
    if (typeof payload.turnId === 'string' && TURN_ID.test(payload.turnId) && payload.turnId !== turnId) {
      return { kind: 'refused', reason: 'record already carries a different valid turnId' };
    }
    const outcome = commitRecord(record, payload, turnId, options);
    if (outcome.status === 'pending') return { kind: 'pending', reason: outcome.reason ?? 'pending' };
    return { kind: outcome.status, turnId };
  });
  return result === 'busy' ? { kind: 'busy' } : result;
}

/** Pending records, for operators: name, id, roles and byte size only (no dialogue text). */
export function listAutoCaptureIntake(dir = AUTO_CAPTURE_INTAKE_DIR): { name: string; turnId: string | null; roles: string[]; bytes: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(name => {
    const path = join(dir, name);
    const payload = readRecord(path);
    return {
      name,
      turnId: typeof payload?.turnId === 'string' ? payload.turnId : null,
      roles: [typeof payload?.david === 'string' ? 'david' : '', typeof payload?.luca === 'string' ? 'luca' : ''].filter(Boolean),
      bytes: Buffer.byteLength(readFileSync(path, 'utf-8')),
    };
  });
}
