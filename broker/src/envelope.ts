// Signed request envelope (costed plan ff04f70e, section B.2).
//
// The client signs canonicalJson(envelope) with its own Ed25519 key. The
// envelope binds audience, protocol, repository, actor, signing key, operation,
// PR, exact head, payload digest, policy epoch, a <= 60 s validity window and a
// unique operation id. The broker never trusts a caller-asserted actor: the
// actor is accepted only if the signature verifies against a key listed for
// that actor in the current policy.

import { createHash, verify } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { type Policy } from './policy.ts';

export const AUDIENCE = 'holahola-broker/v1';
export const PROTOCOL = 1;
export const MAX_VALIDITY_MS = 60_000;
export const MAX_CLOCK_SKEW_MS = 5_000;

/**
 * Named own-App operations (plan section B, operation gateway). No passthrough
 * exists. Source publication is the stage-1 Git data pipeline (blob.put,
 * tree.create, commit.create, ref.create, ref.update). The earlier
 * branch.create and commit.write were retired with it, so ref.update is the
 * single gate for publishing source (stage-1 design revision 4). Completion
 * is pr.enqueue into the merge queue at the exact approved head; a direct
 * merge is a founder or manual exception (design section 2), so pr.merge was
 * retired.
 */
export const OPERATIONS = [
  'blob.put',
  'tree.create',
  'commit.create',
  'ref.create',
  'ref.update',
  'branch.delete',
  'pr.open',
  'pr.edit',
  'pr.close',
  'pr.comment',
  'pr.review',
  'pr.update-branch',
  'pr.enqueue',
  'read',
  'status',
] as const;
export type Operation = (typeof OPERATIONS)[number];

export type Envelope = {
  audience: string;
  protocol: number;
  repositoryId: number;
  actor: string;
  keyId: string;
  operation: Operation;
  pr: number | null;
  headSha: string | null;
  payloadSha256: string;
  policyEpoch: string;
  issuedAt: number;
  expiresAt: number;
  operationId: string;
};

export type SignedRequest = { envelope: Envelope; signature: string; payload: unknown };

export type EnvelopeRejection =
  | 'malformed'
  | 'wrong_audience'
  | 'wrong_protocol'
  | 'wrong_repository'
  | 'unknown_actor'
  | 'unknown_key'
  | 'bad_signature'
  | 'not_yet_valid'
  | 'expired'
  | 'validity_too_long'
  | 'stale_policy_epoch'
  | 'payload_mismatch';

export type EnvelopeResult =
  | { ok: true; envelope: Envelope; digest: string }
  | { ok: false; reason: EnvelopeRejection };

const ENVELOPE_FIELDS = [
  'audience', 'protocol', 'repositoryId', 'actor', 'keyId', 'operation', 'pr', 'headSha',
  'payloadSha256', 'policyEpoch', 'issuedAt', 'expiresAt', 'operationId',
] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function payloadDigest(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict shape check: exact field set and per-field types. */
export function parseSignedRequest(body: unknown): SignedRequest | null {
  if (!isPlainRecord(body)) return null;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'envelope,payload,signature') return null;
  const { envelope, signature, payload } = body;
  if (typeof signature !== 'string' || !BASE64.test(signature) || signature.length > 128) return null;
  if (!isPlainRecord(envelope)) return null;
  const fields = Object.keys(envelope);
  if (fields.length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((field) => fields.includes(field))) return null;
  const e = envelope as Record<string, unknown>;
  const ok =
    typeof e.audience === 'string' &&
    Number.isSafeInteger(e.protocol) &&
    Number.isSafeInteger(e.repositoryId) &&
    typeof e.actor === 'string' &&
    typeof e.keyId === 'string' &&
    typeof e.operation === 'string' && (OPERATIONS as readonly string[]).includes(e.operation) &&
    (e.pr === null || (Number.isSafeInteger(e.pr) && (e.pr as number) > 0)) &&
    (e.headSha === null || (typeof e.headSha === 'string' && SHA1_HEX.test(e.headSha))) &&
    typeof e.payloadSha256 === 'string' && SHA256_HEX.test(e.payloadSha256) &&
    typeof e.policyEpoch === 'string' && SHA1_HEX.test(e.policyEpoch) &&
    Number.isSafeInteger(e.issuedAt) &&
    Number.isSafeInteger(e.expiresAt) &&
    typeof e.operationId === 'string' && OPERATION_ID.test(e.operationId);
  if (!ok) return null;
  try {
    canonicalJson(payload);
  } catch {
    return null;
  }
  return { envelope: envelope as unknown as Envelope, signature, payload };
}

/**
 * Verifies a signed request against the current policy. Order: shape, fixed
 * bindings, actor and key lookup, signature, then time, epoch and payload --
 * so nothing past the signature check is evaluated for an unauthenticated
 * caller. `digest` is the sha256 of the canonical envelope (the operation
 * claim's request digest in phase 2).
 */
export function verifySignedRequest(body: unknown, policy: Policy, now: number): EnvelopeResult {
  const request = parseSignedRequest(body);
  if (!request) return { ok: false, reason: 'malformed' };
  const { envelope, signature, payload } = request;
  if (envelope.audience !== AUDIENCE) return { ok: false, reason: 'wrong_audience' };
  if (envelope.protocol !== PROTOCOL) return { ok: false, reason: 'wrong_protocol' };
  // The policy is already bound to this instance's configured target repository.
  if (envelope.repositoryId !== policy.repositoryId) return { ok: false, reason: 'wrong_repository' };

  const actor = policy.actors.get(envelope.actor);
  if (!actor) return { ok: false, reason: 'unknown_actor' };
  const key = actor.signingKeys.find((candidate) => candidate.id === envelope.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };

  const signed = canonicalJson(envelope);
  let valid = false;
  try {
    valid = verify(null, Buffer.from(signed, 'utf8'), key.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  if (envelope.expiresAt - envelope.issuedAt > MAX_VALIDITY_MS || envelope.expiresAt <= envelope.issuedAt) {
    return { ok: false, reason: 'validity_too_long' };
  }
  if (now + MAX_CLOCK_SKEW_MS < envelope.issuedAt) return { ok: false, reason: 'not_yet_valid' };
  if (now >= envelope.expiresAt) return { ok: false, reason: 'expired' };
  if (envelope.policyEpoch !== policy.epoch) return { ok: false, reason: 'stale_policy_epoch' };
  if (payloadDigest(payload) !== envelope.payloadSha256) return { ok: false, reason: 'payload_mismatch' };

  return { ok: true, envelope, digest: sha256Hex(signed) };
}

/**
 * Authenticates an ORIGINAL request carried inside a status request
 * (luca-replit phase 2b review, finding 1). It checks shape, fixed
 * bindings, the actor's key in the current policy, the signature, the
 * validity-window structure and the payload digest -- but NOT expiry or
 * policy epoch, because a status check arrives after the original expired.
 * It therefore authenticates who signed which exact request; it never
 * authorizes executing it. The returned digest must match the stored claim.
 */
export function verifyOriginalSignature(body: unknown, policy: Policy): EnvelopeResult {
  const request = parseSignedRequest(body);
  if (!request) return { ok: false, reason: 'malformed' };
  const { envelope, signature, payload } = request;
  if (envelope.audience !== AUDIENCE) return { ok: false, reason: 'wrong_audience' };
  if (envelope.protocol !== PROTOCOL) return { ok: false, reason: 'wrong_protocol' };
  if (envelope.repositoryId !== policy.repositoryId) return { ok: false, reason: 'wrong_repository' };
  const actor = policy.actors.get(envelope.actor);
  if (!actor) return { ok: false, reason: 'unknown_actor' };
  const key = actor.signingKeys.find((candidate) => candidate.id === envelope.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  const signed = canonicalJson(envelope);
  let valid = false;
  try {
    valid = verify(null, Buffer.from(signed, 'utf8'), key.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (envelope.expiresAt - envelope.issuedAt > MAX_VALIDITY_MS || envelope.expiresAt <= envelope.issuedAt) {
    return { ok: false, reason: 'validity_too_long' };
  }
  if (payloadDigest(payload) !== envelope.payloadSha256) return { ok: false, reason: 'payload_mismatch' };
  return { ok: true, envelope, digest: sha256Hex(signed) };
}
