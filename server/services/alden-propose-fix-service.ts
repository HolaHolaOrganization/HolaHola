/**
 * propose_fix storage and notification (gated-fixes design e4f8e988, P1
 * steps 5–6): the proposal is stored through queue_build_proposal's route
 * (proposedBy 'alden', isSafeZone false, status 'pending'), durable first;
 * the review-thread post and founder notice follow and are retried from
 * notify_state. The proposal id is the fingerprint, so a retry can neither
 * duplicate nor lose them.
 */
import { and, eq, inArray, lt } from 'drizzle-orm';
import { aldenNotifications, buildQueue } from '@shared/schema';
import { getUserDb } from '../db';
import { createCoordinationThread } from './coordination-ledger-service';
import {
  buildPinnedChange, describeUnpinnedEdits, groupEditsByResolvedPath, parseConfidence, parseEdits,
  pinSourceForRole, recheckPin, type PinnedChange, type PinSource, type ProposeFixConfidence,
} from './alden-propose-fix';

/** The hat a stored proposal's review thread is addressed to. */
export const PROPOSE_FIX_REVIEWER = 'luca-replit' as const;
export const PROPOSE_FIX_MAX_NOTIFY_ATTEMPTS = 10;

type Db = ReturnType<typeof getUserDb>;
type Row = typeof buildQueue.$inferSelect;

export interface ProposeFixDeps {
  db?: Db;
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to this instance's role. */
  pinSource?: () => PinSource;
  notify?: (row: Row) => Promise<void>;
}

export interface ProposeFixArgs {
  edits: unknown;
  rationale: unknown;
  evidence: unknown;
  verify: unknown;
  confidence: unknown;
  pattern_id?: unknown;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function describe(args: { rationale: string; evidence: string; verify: string; confidence: ProposeFixConfidence }, extra?: string): string {
  return [
    `Rationale:\n${args.rationale}`,
    `Evidence:\n${args.evidence}`,
    `How to verify:\n${args.verify}`,
    `Confidence (Alden's own): ${args.confidence}`,
    extra,
  ].filter(Boolean).join('\n\n');
}

/**
 * Validate, pin and store one proposal. Returns the stored row, or throws a
 * ProposeFixRefusal / Error with the reason; nothing is stored on refusal.
 */
export async function proposeFix(args: ProposeFixArgs, deps: ProposeFixDeps): Promise<{ row: Row; change: PinnedChange | null }> {
  const confidence = parseConfidence(args.confidence);
  const edits = parseEdits(args.edits);
  const rationale = text(args.rationale, 'rationale');
  const evidence = text(args.evidence, 'evidence');
  const verify = text(args.verify, 'verify');
  const patternId = typeof args.pattern_id === 'string' && args.pattern_id.trim() ? args.pattern_id.trim() : null;
  const title = `Alden fix proposal: ${rationale.split('\n')[0].slice(0, 120)}`;
  const db = deps.db ?? getUserDb();
  const pinSource = deps.pinSource ?? (() => pinSourceForRole(deps.root, deps.env));

  let row: Row;
  let change: PinnedChange | null = null;
  if (confidence === 'high') {
    const groups = groupEditsByResolvedPath(edits, deps.root);
    change = buildPinnedChange(groups, pinSource());
    const pinned = change;
    row = await db.transaction(async (tx) => {
      // Re-verify the pin from a fresh source inside the request, before the row commits.
      recheckPin(pinned.pin, pinSource());
      const [inserted] = await tx.insert(buildQueue).values({
        proposedBy: 'alden', title, isSafeZone: false, status: 'pending', priority: 5,
        description: describe({ rationale, evidence, verify, confidence }),
        filesAffected: pinned.pin.files.map((f) => f.path),
        diff: pinned.diff,
        confidence,
        pinKind: pinned.pin.kind,
        pinCommit: pinned.pin.commit,
        pinSourceDigest: pinned.pin.sourceDigest,
        pinFiles: pinned.pin.files,
        patternId,
        notifyState: 'pending',
      }).returning();
      return inserted;
    });
  } else {
    // low / medium: one description-only proposal, no pinned diff, never convertible.
    [row] = await db.insert(buildQueue).values({
      proposedBy: 'alden', title, isSafeZone: false, status: 'pending', priority: 5,
      description: describe({ rationale, evidence, verify, confidence }, `Requested edits (description only, not pinned, not eligible for PR conversion):\n\n${describeUnpinnedEdits(edits)}`),
      filesAffected: [...new Set(edits.map((e) => e.path))],
      confidence,
      patternId,
      notifyState: 'pending',
    }).returning();
  }

  await notifyStoredProposal(row, { db, notify: deps.notify });
  const [current] = await db.select().from(buildQueue).where(eq(buildQueue.id, row.id));
  return { row: current ?? row, change };
}

/** The review-thread post and the founder notice for a stored proposal. Idempotent by proposal id. */
export async function sendProposalNotice(row: Row, db: Db = getUserDb()): Promise<void> {
  const pin = row.pinKind ? `${row.pinKind} @ ${row.pinCommit}` : 'none (description only)';
  const body = [
    `Alden stored a fix proposal for review: build_queue ${row.id}.`,
    `Confidence: ${row.confidence}. Pin: ${pin}. Files: ${(row.filesAffected ?? []).join(', ') || 'none'}.`,
    row.patternId ? `Support pattern: ${row.patternId}.` : null,
    '',
    row.description,
    row.diff ? `\nDiff:\n${row.diff.length > 12_000 ? `${row.diff.slice(0, 12_000)}\n… [truncated; the full diff is on the build_queue row]` : row.diff}` : null,
  ].filter((part) => part !== null).join('\n');
  await createCoordinationThread({
    actor: 'alden',
    intendedRecipient: PROPOSE_FIX_REVIEWER,
    title: row.title.slice(0, 300),
    description: body.slice(0, 20_000),
    priority: 'normal',
    idempotencyKey: `alden-propose-fix-${row.id}`,
  });
  const fingerprint = `propose_fix:${row.id}`;
  const [existing] = await db.select({ id: aldenNotifications.id }).from(aldenNotifications).where(eq(aldenNotifications.fingerprint, fingerprint)).limit(1);
  if (!existing) {
    await db.insert(aldenNotifications).values({
      content: `Fix proposal stored for review (${row.confidence} confidence): ${row.title}. It waits in the build queue; nothing was changed.`,
      triggeredBy: 'tool',
      severity: 'info',
      read: false,
      fingerprint,
    });
  }
}

/** Notify after the row is durable; a failure is recorded on the row for retry, never thrown. */
export async function notifyStoredProposal(row: Row, deps: { db?: Db; notify?: (row: Row) => Promise<void> } = {}): Promise<void> {
  const db = deps.db ?? getUserDb();
  try {
    await (deps.notify ?? ((r) => sendProposalNotice(r, db)))(row);
    await db.update(buildQueue).set({ notifyState: 'delivered', notifyError: null, notifyAttempts: row.notifyAttempts + 1 }).where(eq(buildQueue.id, row.id));
  } catch (err: any) {
    await db.update(buildQueue).set({
      notifyState: 'failed',
      notifyError: String(err?.message ?? err).slice(0, 2000),
      notifyAttempts: row.notifyAttempts + 1,
    }).where(eq(buildQueue.id, row.id));
  }
}

/** Retry undelivered proposal notices (called from Alden's watch cycle). */
export async function retryProposalNotices(deps: { db?: Db; notify?: (row: Row) => Promise<void> } = {}): Promise<number> {
  const db = deps.db ?? getUserDb();
  const rows = await db.select().from(buildQueue).where(and(
    eq(buildQueue.proposedBy, 'alden'),
    inArray(buildQueue.notifyState, ['pending', 'failed']),
    lt(buildQueue.notifyAttempts, PROPOSE_FIX_MAX_NOTIFY_ATTEMPTS),
  ));
  for (const row of rows) await notifyStoredProposal(row, { db, notify: deps.notify });
  return rows.length;
}
