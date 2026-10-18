// Unique-executor operation claims (costed plan ff04f70e revision 4, section
// B.2 "Replay and idempotency").
//
// The audit repository is the claim ledger. Every write is a compare-and-swap
// on the single ledger branch head (createCommitOnBranch with expectedHeadOid
// in production), and existence is checked at that exact head, so at most one
// broker instance ever creates a given claim. Only the claim winner executes.
//
//   claims/<actor>/<operationId>.json    write-ahead entry, status "claimed"
//   outcomes/<actor>/<operationId>.json  written once, after execution or reconciliation
//
// A claim with no outcome is "pending" until its execution deadline and
// "uncertain" after it. An uncertain operation is never re-executed: it is
// reconciled against GitHub's actual state, and if that is ambiguous it stays
// uncertain and is surfaced, not retried. Retrying needs a new operation id.

import { canonicalJson } from './canonical.ts';

export interface Ledger {
  /** Current head commit of the ledger branch. */
  head(): Promise<string>;
  /** File content at exactly `head`, or null if absent. */
  read(head: string, path: string): Promise<string | null>;
  /** Atomic: adds `files` only if the branch head is still `expectedHead`. Never overwrites. */
  commit(expectedHead: string, files: Record<string, string>, message: string): Promise<{ ok: true; head: string } | { ok: false }>;
}

export type ClaimEntry = {
  actor: string;
  operationId: string;
  digest: string;
  operation: string;
  pr: number | null;
  headSha: string | null;
  policyEpoch: string;
};

export type ClaimRecord = ClaimEntry & { decision: 'allow'; status: 'claimed'; claimedAt: number };

export type OutcomeStatus = 'succeeded' | 'failed' | 'applied' | 'not_applied';
export type OutcomeRecord = {
  actor: string;
  operationId: string;
  digest: string;
  status: OutcomeStatus;
  /** Non-secret GitHub response identifiers (review id, merge sha, ...). */
  result: Record<string, string | number | null>;
  reconciled: boolean;
  recordedAt: number;
};

export type ExecutionOutcome =
  | { kind: 'executed'; outcome: OutcomeRecord }
  | { kind: 'recorded'; outcome: OutcomeRecord }
  | { kind: 'pending' }
  | { kind: 'uncertain' }
  | { kind: 'digest_conflict' };

export class LedgerContendedError extends Error {}

/** How long a claim winner has to record an outcome before the claim counts as uncertain. */
export const EXECUTION_DEADLINE_MS = 120_000;
export const MAX_CAS_ATTEMPTS = 16;

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function claimPath(actor: string, operationId: string): string {
  if (!SEGMENT.test(actor) || !SEGMENT.test(operationId)) throw new TypeError('invalid ledger path segment');
  return `claims/${actor}/${operationId}.json`;
}

export function outcomePath(actor: string, operationId: string): string {
  if (!SEGMENT.test(actor) || !SEGMENT.test(operationId)) throw new TypeError('invalid ledger path segment');
  return `outcomes/${actor}/${operationId}.json`;
}

function serialize(record: ClaimRecord | OutcomeRecord): string {
  return canonicalJson(record) + '\n';
}

type ClaimResult =
  | { kind: 'won' }
  | { kind: 'exists'; claim: ClaimRecord; outcome: OutcomeRecord | null }
  | { kind: 'digest_conflict' };

async function claim(ledger: Ledger, entry: ClaimEntry, now: number): Promise<ClaimResult> {
  if (!DIGEST.test(entry.digest)) throw new TypeError('claim digest must be a sha256 hex string');
  const path = claimPath(entry.actor, entry.operationId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const head = await ledger.head();
    const existing = await ledger.read(head, path);
    if (existing !== null) {
      const record = JSON.parse(existing) as ClaimRecord;
      if (record.digest !== entry.digest) return { kind: 'digest_conflict' };
      const outcome = await ledger.read(head, outcomePath(entry.actor, entry.operationId));
      return { kind: 'exists', claim: record, outcome: outcome === null ? null : (JSON.parse(outcome) as OutcomeRecord) };
    }
    const record: ClaimRecord = { ...entry, decision: 'allow', status: 'claimed', claimedAt: now };
    const written = await ledger.commit(head, { [path]: serialize(record) }, `claim ${entry.actor}/${entry.operationId} ${entry.operation}`);
    if (written.ok) return { kind: 'won' };
  }
  throw new LedgerContendedError('ledger head kept moving; denying');
}

/** Writes the outcome once. Returns the outcome actually on the ledger (which may be another writer's). */
async function recordOutcome(ledger: Ledger, outcome: OutcomeRecord): Promise<OutcomeRecord> {
  const path = outcomePath(outcome.actor, outcome.operationId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const head = await ledger.head();
    const existing = await ledger.read(head, path);
    if (existing !== null) return JSON.parse(existing) as OutcomeRecord;
    const written = await ledger.commit(head, { [path]: serialize(outcome) }, `outcome ${outcome.actor}/${outcome.operationId} ${outcome.status}`);
    if (written.ok) return outcome;
  }
  throw new LedgerContendedError('ledger head kept moving while recording an outcome');
}

export type EffectResult = { status: 'succeeded' | 'failed'; result: Record<string, string | number | null> };
/** Inspects GitHub for this operation's specific effect. */
export type Reconciler = () => Promise<
  { status: 'applied' | 'not_applied'; result: Record<string, string | number | null> } | { status: 'ambiguous' }
>;

/**
 * Runs `effect` at most once per (actor, operationId) across every broker
 * instance. `effect` should throw only when the outcome is unknown (for
 * example a network error after sending); a definite GitHub rejection is
 * returned as status "failed".
 */
export async function executeOnce(
  ledger: Ledger,
  entry: ClaimEntry,
  effect: () => Promise<EffectResult>,
  reconcile: Reconciler,
  now: () => number = Date.now,
): Promise<ExecutionOutcome> {
  const claimed = await claim(ledger, entry, now());
  if (claimed.kind === 'digest_conflict') return { kind: 'digest_conflict' };

  if (claimed.kind === 'exists') {
    if (claimed.outcome) return { kind: 'recorded', outcome: claimed.outcome };
    if (now() - claimed.claim.claimedAt < EXECUTION_DEADLINE_MS) return { kind: 'pending' };
    const found = await reconcile();
    if (found.status === 'ambiguous') return { kind: 'uncertain' };
    const outcome = await recordOutcome(ledger, {
      actor: entry.actor, operationId: entry.operationId, digest: entry.digest,
      status: found.status, result: found.result, reconciled: true, recordedAt: now(),
    });
    return { kind: 'recorded', outcome };
  }

  let done: EffectResult;
  try {
    done = await effect();
  } catch {
    // The effect may or may not have happened. Leave the claim without an
    // outcome; after the deadline a later request reconciles it.
    return { kind: 'uncertain' };
  }
  try {
    const outcome = await recordOutcome(ledger, {
      actor: entry.actor, operationId: entry.operationId, digest: entry.digest,
      status: done.status, result: done.result, reconciled: false, recordedAt: now(),
    });
    return { kind: 'executed', outcome };
  } catch {
    return { kind: 'uncertain' };
  }
}
