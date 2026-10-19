// Decision for a verified request. Phase 1 has no gateway operations, so the
// only reachable outcomes are denials: `closed` denies everything, and the
// other states deny with `not_implemented` until phase 2 adds operations.
// The policy is re-read for every request (plan section B: re-checked on every
// operation, including when a cached installation token is reused).

import { type EnvelopeRejection, verifySignedRequest } from './envelope.ts';
import { type PolicyLoader } from './policy.ts';

export type Decision =
  | { decision: 'deny'; reason: 'no_policy' | 'policy_closed' | 'not_implemented' | EnvelopeRejection; operationId?: string }
  | { decision: 'allow'; operationId: string };

export async function decide(body: unknown, loader: PolicyLoader, now: number): Promise<Decision> {
  const policy = await loader.current();
  if (!policy) return { decision: 'deny', reason: 'no_policy' };
  const verified = verifySignedRequest(body, policy, now);
  if (!verified.ok) return { decision: 'deny', reason: verified.reason };
  const { operationId } = verified.envelope;
  if (policy.state === 'closed') return { decision: 'deny', reason: 'policy_closed', operationId };
  return { decision: 'deny', reason: 'not_implemented', operationId };
}
