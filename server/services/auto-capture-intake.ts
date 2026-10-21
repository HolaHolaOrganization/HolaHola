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
import { WORKSPACE } from './transcript-parser';

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
export function processAutoCaptureIntake(
  dir = AUTO_CAPTURE_INTAKE_DIR,
  options: { capturePath?: string; ingressLockPath?: string } = {},
): IntakeOutcome[] {
  if (!existsSync(dir)) return [];
  const outcomes: IntakeOutcome[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const record = join(dir, name);
    let parsed: { turnId?: unknown; david?: unknown; luca?: unknown };
    try {
      parsed = JSON.parse(readFileSync(record, 'utf-8'));
    } catch {
      outcomes.push({ record, status: 'pending', reason: 'unparseable intake record; kept for operator review' });
      continue;
    }
    const turnId = parsed.turnId;
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(turnId)) {
      outcomes.push({ record, status: 'pending', reason: 'missing or invalid turnId: kept pending; an id is never invented' });
      continue;
    }
    const result = appendAutoCaptureExchange({
      turnId,
      david: typeof parsed.david === 'string' ? parsed.david : undefined,
      luca: typeof parsed.luca === 'string' ? parsed.luca : undefined,
      capturePath: options.capturePath,
      ingressLockPath: options.ingressLockPath,
    });
    if (result.kind === 'conflict') {
      outcomes.push({ record, status: 'pending', turnId, reason: result.reason });
      continue;
    }
    // Durable in the canonical log: the canonical pipeline now owns projection.
    unlinkSync(record);
    outcomes.push({ record, status: result.kind === 'appended' ? 'recorded' : 'exact-retry', turnId });
  }
  return outcomes;
}
