// Agent client for the broker (costed plan ff04f70e, phase 3).
//
// Each hat signs with its OWN Ed25519 key, held in its own host store; the
// client never sees another hat's key and the broker never sees any. Every
// signed request is written to a local journal BEFORE it is sent, because an
// uncertain result can later be settled only by a status request that
// carries that exact original (luca-replit phase 2b review, finding 1).
// Nothing here retries a mutation: a new attempt needs a new operation id
// and is a deliberate decision.

import { randomBytes, type KeyObject, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from './canonical.ts';
import { AUDIENCE, type Envelope, type Operation, payloadDigest, PROTOCOL } from './envelope.ts';
import { REPOSITORY_ID } from './policy.ts';

export const VALIDITY_MS = 30_000;

export type SignedRequest = { envelope: Envelope; signature: string; payload: unknown };

export type Signer = { actor: string; keyId: string; privateKey: KeyObject };

export function newOperationId(): string {
  return `op-${randomBytes(12).toString('hex')}`;
}

export function signRequest(
  signer: Signer,
  request: { operation: Operation; pr: number | null; headSha: string | null; payload: unknown; policyEpoch: string; operationId?: string },
  now: number,
): SignedRequest {
  if (signer.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('signing key must be Ed25519');
  const envelope: Envelope = {
    audience: AUDIENCE, protocol: PROTOCOL, repositoryId: REPOSITORY_ID,
    actor: signer.actor, keyId: signer.keyId, operation: request.operation,
    pr: request.pr, headSha: request.headSha, payloadSha256: payloadDigest(request.payload),
    policyEpoch: request.policyEpoch, issuedAt: now, expiresAt: now + VALIDITY_MS,
    operationId: request.operationId ?? newOperationId(),
  };
  const signature = sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signer.privateKey).toString('base64');
  return { envelope, signature, payload: request.payload };
}

/** A status request for an earlier signed request: fresh envelope, the original carried verbatim. */
export function signStatus(signer: Signer, original: SignedRequest, policyEpoch: string, now: number): SignedRequest {
  return signRequest(signer, { operation: 'status', pr: null, headSha: null, payload: { original }, policyEpoch }, now);
}

/** Local journal of every signed mutating request, keyed by operation id. Written before sending. */
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
    // 'wx': never overwrite an existing journal entry for the same operation id.
    await writeFile(this.path(request.envelope.operationId), canonicalJson(request) + '\n', { flag: 'wx', mode: 0o600 });
  }
  async load(operationId: string): Promise<SignedRequest> {
    return JSON.parse(await readFile(this.path(operationId), 'utf8')) as SignedRequest;
  }
}

export type BrokerResponse = { status: number; body: Record<string, unknown> };

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly signer: Signer;
  private readonly journal: Journal;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(options: { baseUrl: string; signer: Signer; journal: Journal; fetchImpl?: typeof fetch; now?: () => number }) {
    const url = new URL(options.baseUrl);
    // Plan P3: callers pin the broker's own onrender.com host over TLS; no custom domain, no plain HTTP.
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new TypeError('broker URL must be https');
    this.baseUrl = url.origin;
    this.signer = options.signer;
    this.journal = options.journal;
    this.fetch = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async policyEpoch(): Promise<string> {
    const res = await this.fetch(`${this.baseUrl}/healthz`, { redirect: 'error' });
    const body = await res.json() as { ok?: boolean; epoch?: unknown };
    if (!res.ok || body.ok !== true || typeof body.epoch !== 'string') throw new Error('broker policy unavailable');
    return body.epoch;
  }

  private async post(request: SignedRequest): Promise<BrokerResponse> {
    const res = await this.fetch(`${this.baseUrl}/v1/operations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error',
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /** Signs, journals, then sends exactly once. A transport failure leaves the journal entry for `status`. */
  async execute(operation: Operation, pr: number | null, headSha: string | null, payload: unknown): Promise<BrokerResponse & { operationId: string }> {
    if (operation === 'status') throw new TypeError('use status()');
    const request = signRequest(this.signer, { operation, pr, headSha, payload, policyEpoch: await this.policyEpoch() }, this.now());
    if (operation !== 'read') await this.journal.record(request);
    const response = await this.post(request);
    return { ...response, operationId: request.envelope.operationId };
  }

  /** Settles an earlier operation from its journal entry; never executes anything. */
  async status(operationId: string): Promise<BrokerResponse> {
    const original = await this.journal.load(operationId);
    return this.post(signStatus(this.signer, original, await this.policyEpoch(), this.now()));
  }
}
