// Agent client for the broker (costed plan ff04f70e, phase 3).
//
// Each hat signs with its OWN Ed25519 key, held in its own host store; the
// client never sees another hat's key and the broker never sees any. Every
// signed request is written to a local journal BEFORE it is sent, because an
// uncertain result can later be settled only by a status request that
// carries that exact original (luca-replit phase 2b review, finding 1).
// Nothing here retries a mutation: a new attempt needs a new operation id
// and is a deliberate decision.
//
// One immutable snapshot (luca-replit phase 3 review, finding 1): the payload
// is serialised ONCE at the signing boundary into canonical JSON and parsed
// back into a deep-frozen plain value. Hashing, journaling and sending all
// use that single snapshot, so the journaled original always verifies
// against the same digest as the request that was sent, whatever the caller
// does to its own objects afterwards.

import { randomBytes, type KeyObject, sign } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ADMISSION_DOMAIN, ADMISSION_HEADER, encodedLength, newAdmissionId, signAdmission, STANDARD_BODY_LIMIT } from './admission.ts';
import { canonicalJson } from './canonical.ts';
import { AUDIENCE, type Envelope, type Operation, payloadDigest, PROTOCOL } from './envelope.ts';
import { REPOSITORY_ID } from './policy.ts';

export const VALIDITY_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export type SignedRequest = { readonly envelope: Envelope; readonly signature: string; readonly payload: unknown };

export type Signer = { actor: string; keyId: string; privateKey: KeyObject };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Reads the caller's value exactly once and returns a detached, frozen, JSON-safe copy. */
export function snapshot<T = unknown>(value: unknown): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

export function newOperationId(): string {
  return `op-${randomBytes(12).toString('hex')}`;
}

export function signRequest(
  signer: Signer,
  request: { operation: Operation; pr: number | null; headSha: string | null; payload: unknown; policyEpoch: string; operationId?: string; repositoryId?: number },
  now: number,
): SignedRequest {
  if (signer.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('signing key must be Ed25519');
  const payload = snapshot(request.payload);
  const envelope: Envelope = Object.freeze({
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: request.repositoryId ?? REPOSITORY_ID,
    actor: signer.actor, keyId: signer.keyId, operation: request.operation,
    pr: request.pr, headSha: request.headSha, payloadSha256: payloadDigest(payload),
    policyEpoch: request.policyEpoch, issuedAt: now, expiresAt: now + VALIDITY_MS,
    operationId: request.operationId ?? newOperationId(),
  });
  const signature = sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64');
  return Object.freeze({ envelope, signature, payload });
}

/** A status request for an earlier signed request: fresh envelope, the original carried verbatim. */
export function signStatus(signer: Signer, original: SignedRequest, policyEpoch: string, now: number): SignedRequest {
  // A status check names the same target repository as the request it settles.
  return signRequest(signer, { operation: 'status', pr: null, headSha: null, payload: { original: snapshot(original) }, policyEpoch, repositoryId: original.envelope.repositoryId }, now);
}

/**
 * Local journal of every signed mutating request, keyed by operation id,
 * written and fsync'd before sending. Guarantees: survives a process crash or
 * restart after record() returns; never overwrites an entry. NOT guaranteed:
 * survival of host or power loss beyond what the OS and disk honour for fsync
 * (the directory entry itself is not separately fsync'd, which Windows does
 * not support), or loss of the host's disk.
 */
export class Journal {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) throw new TypeError('invalid operation id');
    return join(this.dir, `${operationId}.json`);
  }
  async record(request: SignedRequest): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = await open(this.path(request.envelope.operationId), 'wx', 0o600);
    try {
      await file.writeFile(canonicalJson(request) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async load(operationId: string): Promise<SignedRequest> {
    return snapshot<SignedRequest>(JSON.parse(await readFile(this.path(operationId), 'utf8')));
  }
}

/**
 * The request was journaled and may or may not have reached the broker or
 * taken effect. Carries the operation id for status(); never the payload,
 * signature or key. The effect is NOT failed and is never resent.
 */
export class BrokerTransportError extends Error {
  readonly operationId: string;
  readonly outcome = 'uncertain' as const;
  constructor(operationId: string, cause: unknown) {
    super(`broker request ${operationId} has an unknown result; settle it with status()`, { cause });
    this.operationId = operationId;
  }
}

export type BrokerResponse = { status: number; body: Record<string, unknown> };

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly signer: Signer;
  private readonly journal: Journal;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly repositoryId: number;

  /** `repositoryId`: the broker instance's target; the production main repository unless a sandbox instance is named. */
  constructor(options: { baseUrl: string; signer: Signer; journal: Journal; fetchImpl?: typeof fetch; now?: () => number; repositoryId?: number }) {
    const url = new URL(options.baseUrl);
    // Plan P3: callers pin the broker's own onrender.com host over TLS; no custom domain, no plain HTTP.
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new TypeError('broker URL must be https');
    this.baseUrl = url.origin;
    this.signer = options.signer;
    this.journal = options.journal;
    this.fetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.repositoryId = options.repositoryId ?? REPOSITORY_ID;
  }

  async policyEpoch(): Promise<string> {
    const res = await this.fetch(`${this.baseUrl}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await res.json() as { ok?: boolean; epoch?: unknown };
    if (!res.ok || body.ok !== true || typeof body.epoch !== 'string') throw new Error('broker policy unavailable');
    return body.epoch;
  }

  /**
   * A blob.put body above the standard cap carries a signed admission
   * manifest (stage-1 design section 8) naming its exact sizes and payload
   * digest. Every other request, and every request that fits, is unchanged.
   * A large blob.put's original cannot fit inside a status request, so an
   * uncertain large blob.put is settled by a fresh blob.put under a new
   * operation id: blobs are content-addressed, and the fresh one reports
   * already_present if the first one landed.
   */
  private admissionFor(request: SignedRequest, body: string): Record<string, string> {
    const bodySize = Buffer.byteLength(body, 'utf8');
    if (bodySize <= STANDARD_BODY_LIMIT || request.envelope.operation !== 'blob.put') return {};
    const payload = request.payload as { rawSize: number; contentBase64: string };
    const issuedAt = this.now();
    return {
      [ADMISSION_HEADER]: signAdmission(this.signer.privateKey, {
        domain: ADMISSION_DOMAIN, actor: this.signer.actor, keyId: this.signer.keyId, operation: 'blob.put',
        repositoryId: request.envelope.repositoryId, rawSize: payload.rawSize, encodedSize: encodedLength(payload.rawSize),
        bodySize, payloadDigest: request.envelope.payloadSha256, admissionId: newAdmissionId(),
        issuedAt, expiresAt: issuedAt + VALIDITY_MS,
      }),
    };
  }

  private async post(request: SignedRequest): Promise<BrokerResponse> {
    const body = JSON.stringify(request);
    const res = await this.fetch(`${this.baseUrl}/v1/operations`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...this.admissionFor(request, body) }, body,
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /**
   * Signs one snapshot, journals it, then sends it exactly once. Any failure
   * after journaling (reset, timeout, unreadable response) throws
   * BrokerTransportError carrying the operation id; the caller settles it
   * with status(operationId).
   */
  async execute(operation: Operation, pr: number | null, headSha: string | null, payload: unknown): Promise<BrokerResponse & { operationId: string }> {
    if (operation === 'status') throw new TypeError('use status()');
    const request = signRequest(this.signer, { operation, pr, headSha, payload, policyEpoch: await this.policyEpoch(), repositoryId: this.repositoryId }, this.now());
    const operationId = request.envelope.operationId;
    if (operation === 'read') return { ...(await this.post(request)), operationId };
    await this.journal.record(request);
    let response: BrokerResponse;
    try {
      response = await this.post(request);
    } catch (error) {
      throw new BrokerTransportError(operationId, error);
    }
    return { ...response, operationId };
  }

  /** Settles an earlier operation from its journal entry; never executes anything. */
  async status(operationId: string): Promise<BrokerResponse> {
    const original = await this.journal.load(operationId);
    return this.post(signStatus(this.signer, original, await this.policyEpoch(), this.now()));
  }
}
