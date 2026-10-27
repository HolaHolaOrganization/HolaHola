// The broker's only authority source: broker/policy.json on main, which is
// founder-owned through CODEOWNERS. Founder authentication is GitHub's own --
// changing policy means a founder-approved PR. The broker never accepts policy
// from a caller, an env var or a database.
//
// Policy epoch = the git blob SHA of the file on main. Every signed request
// names the epoch its client saw, and is rejected if it is not the current
// one, so a policy change invalidates every outstanding request.
//
// Every failure here is fail-closed: an unreadable, unverifiable or invalid
// file means no policy, and no policy means every request is denied.

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

export const REPOSITORY_ID = 1170208766;
export const POLICY_STATES = ['closed', 'qualification', 'routine'] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

export type SigningKey = { id: string; publicKey: KeyObject };
export type ActorPolicy = {
  appId: number;
  installationId: number;
  host: string;
  signingKeys: SigningKey[];
};
export type QualificationEntry = { pr: number; headSha: string };
export type Policy = {
  version: 1;
  state: PolicyState;
  repositoryId: number;
  actors: Map<string, ActorPolicy>;
  qualification: QualificationEntry[];
  epoch: string;
};

export class PolicyError extends Error {}

const ACTOR_ID = /^[a-z][a-z0-9-]{1,62}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;

/** git's blob object id: sha1("blob <byteLength>\0" + bytes). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function fail(message: string): never {
  throw new PolicyError(message);
}

function exactKeys(value: unknown, where: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${where} has unknown field ${key}`);
  }
  for (const key of required) if (!(key in record)) fail(`${where} is missing ${key}`);
  return record;
}

function positiveInt(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${where} must be a positive integer`);
  return value as number;
}

function parseSigningKey(value: unknown, where: string): SigningKey {
  const record = exactKeys(value, where, ['id', 'publicKeyPem']);
  if (typeof record.id !== 'string' || !KEY_ID.test(record.id)) fail(`${where}.id is invalid`);
  if (typeof record.publicKeyPem !== 'string') fail(`${where}.publicKeyPem must be a string`);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(record.publicKeyPem);
  } catch {
    fail(`${where}.publicKeyPem is not a public key`);
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail(`${where}.publicKeyPem must be Ed25519`);
  return { id: record.id, publicKey };
}

/**
 * `repositoryId` is the instance's configured target: the production broker's
 * fixed main repository by default, or a sandbox instance's immutable target
 * (stage 1, decision F4-a). A policy naming any other repository is invalid.
 */
export function parsePolicy(bytes: Uint8Array, repositoryId: number = REPOSITORY_ID): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('policy is not valid UTF-8 JSON');
  }
  const root = exactKeys(raw, 'policy', ['version', 'state', 'repositoryId', 'actors', 'qualification']);
  if (root.version !== 1) fail('policy.version must be 1');
  if (!POLICY_STATES.includes(root.state as PolicyState)) fail('policy.state is not a known state');
  if (root.repositoryId !== repositoryId) fail('policy.repositoryId does not name this repository');

  if (typeof root.actors !== 'object' || root.actors === null || Array.isArray(root.actors)) fail('policy.actors must be an object');
  const actors = new Map<string, ActorPolicy>();
  for (const [actorId, entry] of Object.entries(root.actors as Record<string, unknown>)) {
    if (!ACTOR_ID.test(actorId)) fail(`policy.actors has an invalid actor id`);
    const where = `policy.actors.${actorId}`;
    const actor = exactKeys(entry, where, ['appId', 'installationId', 'host', 'signingKeys']);
    if (typeof actor.host !== 'string' || !actor.host.trim()) fail(`${where}.host must be a non-empty string`);
    if (!Array.isArray(actor.signingKeys) || actor.signingKeys.length === 0) fail(`${where}.signingKeys must be a non-empty array`);
    const signingKeys = actor.signingKeys.map((key, index) => parseSigningKey(key, `${where}.signingKeys[${index}]`));
    if (new Set(signingKeys.map((key) => key.id)).size !== signingKeys.length) fail(`${where}.signingKeys has duplicate ids`);
    actors.set(actorId, {
      appId: positiveInt(actor.appId, `${where}.appId`),
      installationId: positiveInt(actor.installationId, `${where}.installationId`),
      host: actor.host,
      signingKeys,
    });
  }

  const installations = [...actors.values()].map((actor) => actor.installationId);
  if (new Set(installations).size !== installations.length) fail('policy.actors share an installation id');

  if (!Array.isArray(root.qualification)) fail('policy.qualification must be an array');
  const qualification = root.qualification.map((entry, index) => {
    const where = `policy.qualification[${index}]`;
    const record = exactKeys(entry, where, ['pr', 'headSha']);
    if (typeof record.headSha !== 'string' || !SHA1_HEX.test(record.headSha)) fail(`${where}.headSha must be a 40-char lowercase hex sha`);
    return { pr: positiveInt(record.pr, `${where}.pr`), headSha: record.headSha };
  });
  if (root.state !== 'qualification' && qualification.length > 0) fail('policy.qualification must be empty outside the qualification state');

  return {
    version: 1,
    state: root.state as PolicyState,
    repositoryId,
    actors,
    qualification,
    epoch: gitBlobSha(bytes),
  };
}

/** Where policy bytes come from. The production source reads main through the GitHub API (phase 2). */
export type PolicySnapshot = { bytes: Uint8Array; blobSha: string };
export interface PolicySource {
  fetch(): Promise<PolicySnapshot>;
}

export const MAX_POLICY_TTL_MS = 60_000;

/**
 * Caches the parsed policy for at most `ttlMs` (never more than 60 s, the
 * documented secondary-stop bound), with no stale fallback.
 *
 * Freshness is measured from when a fetch STARTED, not when it resolved, so a
 * slow fetch can never extend the bound: a result that arrives `ttlMs` or
 * more after its fetch began is discarded. Fetches are single-flight, and
 * each one carries a generation number; only the newest generation may
 * populate the cache, so a late, older result can never overwrite a newer
 * one. A fetch still pending after `ttlMs` is abandoned and superseded.
 */
/** A short, secret-free reason for a failed policy load. */
export function policyFailureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'status' in error && 'path' in error) {
    const { status, path } = error as { status: unknown; path: unknown };
    return `GitHub ${String(path)} returned ${String(status)}`;
  }
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause?.message;
  if (typeof cause === 'string' && /redirect/i.test(cause)) return 'GitHub answered with a redirect, which the broker refuses (has the repository moved? check BROKER_MAIN_REPO_OWNER)';
  if (error instanceof Error && error.name === 'TimeoutError') return 'GitHub request timed out';
  if (error instanceof SyntaxError || (error instanceof Error && /policy/i.test(error.message))) return 'policy file is invalid';
  return 'GitHub request failed';
}

export class PolicyLoader {
  private readonly source: PolicySource;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { policy: Policy; fetchedAt: number } | null = null;
  private inflight: { promise: Promise<Policy | null>; startedAt: number } | null = null;
  private generation = 0;
  private readonly log: (line: string) => void;
  private lastFailure: string | null = null;
  private readonly repositoryId: number;

  constructor(source: PolicySource, now: () => number = Date.now, ttlMs: number = MAX_POLICY_TTL_MS, log: (line: string) => void = (line) => console.error(line), repositoryId: number = REPOSITORY_ID) {
    if (!(ttlMs > 0 && ttlMs <= MAX_POLICY_TTL_MS)) throw new RangeError('policy TTL must be in (0, 60000] ms');
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new RangeError('policy repository id must be a positive integer');
    this.repositoryId = repositoryId;
    this.source = source;
    this.now = now;
    this.ttlMs = ttlMs;
    this.log = log;
  }

  /** Returns the current policy, or null when it cannot be proven. Never throws. */
  current(): Promise<Policy | null> {
    const now = this.now();
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) return Promise.resolve(this.cached.policy);
    this.cached = null;
    if (this.inflight && now - this.inflight.startedAt < this.ttlMs) return this.inflight.promise;
    const generation = ++this.generation;
    const promise = this.load(now, generation);
    this.inflight = { promise, startedAt: now };
    return promise;
  }

  private async load(startedAt: number, generation: number): Promise<Policy | null> {
    let policy: Policy | null = null;
    let failure: string | null = null;
    try {
      const snapshot = await this.source.fetch();
      if (gitBlobSha(snapshot.bytes) === snapshot.blobSha) policy = parsePolicy(snapshot.bytes, this.repositoryId);
      else failure = 'policy blob hash mismatch';
    } catch (error) {
      policy = null;
      failure = policyFailureReason(error);
    }
    // One line per change of reason, so a failing health check names its cause
    // (for example a moved repository answering with a refused redirect) without
    // flooding the log on every probe. Reasons never include tokens or bodies.
    if (failure !== this.lastFailure) {
      if (failure) this.log(`broker: policy unavailable: ${failure}`);
      else if (this.lastFailure) this.log('broker: policy available again');
      this.lastFailure = failure;
    }
    const superseded = generation !== this.generation;
    if (!superseded) this.inflight = null;
    if (superseded || policy === null) return null;
    if (this.now() - startedAt >= this.ttlMs) return null;
    this.cached = { policy, fetchedAt: startedAt };
    return policy;
  }
}
