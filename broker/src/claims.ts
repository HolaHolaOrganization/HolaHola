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
// "uncertain" after it. An uncertain operation is never re-executed. It may be
// reconciled to "applied" when GitHub shows the effect; otherwise it stays
// uncertain and is surfaced. Retrying under a new operation id is a deliberate
// decision, never automatic, because the original may still apply.

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

/** "applied" is the only status reconciliation writes; there is deliberately no negative one. */
export type OutcomeStatus = 'succeeded' | 'failed' | 'applied';
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
/**
 * Inspects GitHub for this operation's specific effect. Only "applied" is
 * evidence: "not_observed" means the effect was not seen YET, which cannot
 * prove a slow winner will not still apply it.
 */
export type Reconciler = () => Promise<
  { status: 'applied'; result: Record<string, string | number | null> } | { status: 'not_observed' | 'ambiguous' }
>;

/**
 * A claim winner may START its effect only this long after claiming; past it,
 * the winner does not act. This bounds how late a winner can begin, but it
 * cannot bound a request already in flight, so reconciliation never records a
 * negative outcome (see executeOnce).
 */
export const EFFECT_START_BUDGET_MS = 10_000;

/**
 * Runs `effect` at most once per (actor, operationId) across every broker
 * instance. `effect` should throw only when the outcome is unknown (for
 * example a network error after sending); a definite GitHub rejection is
 * returned as status "failed".
 *
 * Reconciliation is positive-only (luca-replit review 5566472383): a deadline
 * is not proof that the original winner has stopped, so "not observed" is
 * never written as a durable negative outcome. The operation stays uncertain
 * and is surfaced; retrying it under a NEW operation id is a deliberate
 * decision, because the original may still apply.
 */
export async function executeOnce(
  ledger: Ledger,
  entry: ClaimEntry,
  effect: () => Promise<EffectResult>,
  reconcile: Reconciler,
  now: () => number = Date.now,
): Promise<ExecutionOutcome> {
  const claimedAt = now();
  const claimed = await claim(ledger, entry, claimedAt);
  if (claimed.kind === 'digest_conflict') return { kind: 'digest_conflict' };

  if (claimed.kind === 'exists') {
    if (claimed.outcome) return { kind: 'recorded', outcome: claimed.outcome };
    if (now() - claimed.claim.claimedAt < EXECUTION_DEADLINE_MS) return { kind: 'pending' };
    const found = await reconcile();
    if (found.status !== 'applied') {
      // Not seeing the effect proves nothing; another caller may have recorded one meanwhile.
      const head = await ledger.head();
      const existing = await ledger.read(head, outcomePath(entry.actor, entry.operationId));
      return existing === null ? { kind: 'uncertain' } : { kind: 'recorded', outcome: JSON.parse(existing) as OutcomeRecord };
    }
    const outcome = await recordOutcome(ledger, {
      actor: entry.actor, operationId: entry.operationId, digest: entry.digest,
      status: 'applied', result: found.result, reconciled: true, recordedAt: now(),
    });
    return { kind: 'recorded', outcome };
  }

  // Fence: a winner that reaches this point too late does not start the effect.
  if (now() - claimedAt >= EFFECT_START_BUDGET_MS) return { kind: 'uncertain' };

  let done: EffectResult;
  try {
    done = await effect();
  } catch {
    // The effect may or may not have happened. Leave the claim without an
    // outcome; after the deadline a later request can reconcile it if applied.
    return { kind: 'uncertain' };
  }
  const own: OutcomeRecord = {
    actor: entry.actor, operationId: entry.operationId, digest: entry.digest,
    status: done.status, result: done.result, reconciled: false, recordedAt: now(),
  };
  let onLedger: OutcomeRecord;
  try {
    onLedger = await recordOutcome(ledger, own);
  } catch {
    return { kind: 'uncertain' };
  }
  if (onLedger === own) return { kind: 'executed', outcome: own };
  // Someone reconciled first. Only "applied" can be on the ledger, which agrees
  // with our success; a failure contradicting it is surfaced, not relabelled.
  return done.status === 'succeeded' && onLedger.status === 'applied'
    ? { kind: 'recorded', outcome: onLedger }
    : { kind: 'uncertain' };
}
