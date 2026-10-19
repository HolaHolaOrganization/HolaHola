// Authorization for a signed request (costed plan ff04f70e, phase 2b).
//
// Policy is read through the REQUESTING actor's own App (luca-replit 2b design
// point 7): the loader is chosen from trusted server configuration by the
// claimed actor name, and the signature is then verified against that policy,
// so an unknown or forged actor gets nothing. Authorization is evaluated here
// on arrival AND again by the gateway after its last preparatory await
// (point 2), through the same functions, so the two checks cannot drift.

import { type Envelope, type EnvelopeRejection, parseSignedRequest, verifySignedRequest } from './envelope.ts';
import { type Policy, type PolicyLoader } from './policy.ts';

export type StateRejection = 'policy_closed' | 'not_qualified' | 'not_implemented';

/**
 * What the policy state allows for this envelope.
 * - closed: nothing.
 * - qualification: only operations bound to an exact (repository, PR, head)
 *   listed in the policy. The repository is already fixed by the policy and
 *   envelope checks; operations with no PR (branch.create, pr.open, a
 *   commit.write without a PR) are therefore denied, never widened to routine.
 * - routine: every named operation.
 * branch.delete is denied in every state: REST DELETE /git/refs has no
 * expected-old-sha, so a read-then-delete is not a compare-and-swap.
 * status (checking an existing claim) is denied when closed like everything
 * else; in qualification it is exempt from the PR target check because it
 * names a claim, not a PR, and that claim was itself qualified when created.
 */
export function stateAllows(policy: Policy, envelope: Envelope): { ok: true } | { ok: false; reason: StateRejection } {
  if (policy.state === 'closed') return { ok: false, reason: 'policy_closed' };
  if (envelope.operation === 'branch.delete') return { ok: false, reason: 'not_implemented' };
  if (policy.state === 'qualification' && envelope.operation !== 'status') {
    const listed = envelope.pr !== null && envelope.headSha !== null
      && policy.qualification.some((entry) => entry.pr === envelope.pr && entry.headSha === envelope.headSha);
    if (!listed) return { ok: false, reason: 'not_qualified' };
  }
  return { ok: true };
}

export type Authorized = { envelope: Envelope; digest: string; payload: unknown; policy: Policy };

export type Denial = { decision: 'deny'; reason: 'no_policy' | StateRejection | EnvelopeRejection; operationId?: string };
export type Decision = Denial | { decision: 'allow'; operationId: string; authorized: Authorized };

/** Selects the policy loader for a claimed actor from trusted configuration; undefined for unknown actors. */
export type LoaderFor = (claimedActor: string) => PolicyLoader | undefined;

/**
 * Full authorization: shape, actor's loader, current policy, a clock read
 * after the policy await, signature and envelope bindings, then state.
 */
export async function decide(body: unknown, loaderFor: LoaderFor, now: () => number): Promise<Decision> {
  const shape = parseSignedRequest(body);
  if (!shape) return { decision: 'deny', reason: 'malformed' };
  const loader = loaderFor(shape.envelope.actor);
  if (!loader) return { decision: 'deny', reason: 'unknown_actor' };
  const policy = await loader.current();
  if (!policy) return { decision: 'deny', reason: 'no_policy' };
  // Time is read after the awaited policy load, so a slow load cannot let an
  // expired request through.
  const verified = verifySignedRequest(body, policy, now());
  if (!verified.ok) return { decision: 'deny', reason: verified.reason };
  const { operationId } = verified.envelope;
  const state = stateAllows(policy, verified.envelope);
  if (!state.ok) return { decision: 'deny', reason: state.reason, operationId };
  return {
    decision: 'allow',
    operationId,
    authorized: { envelope: verified.envelope, digest: verified.digest, payload: shape.payload, policy },
  };
}
