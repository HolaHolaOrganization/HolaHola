import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TASK_APPROVAL_DEFAULT_MS, TASK_APPROVAL_MAX_MS } from '../../shared/task-ownership-policy';
import { saveOwnershipChallengeHandle } from './task-ownership-discovery';
import { promotionContextDigest, type PromotionCandidate } from './promotion-candidate';

type Binding = {
  taskRef: string;
  actor: string;
  artifactSha256: string;
  publicKey: string;
  keyFingerprint: string;
  promotion?: PromotionCandidate;
};
type Payload = {
  taskRef: string; intendedActor: string; artifactSha256: string;
  publicKey: string; keyFingerprint: string; idempotencyKey: string; ttlMs: number;
  contextDigest?: string;
};
type Attempt = {
  version: 1; endpoint: string; previousChallengeId: string | null; payload: Payload;
};
export type AttemptClient = {
  challenge(payload: Payload): Promise<unknown>;
  status(id: string): Promise<unknown>;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const uuid = (text: unknown): text is string =>
  typeof text === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text);

export function validateTaskRef(ref: string): void {
  if (!/^[1-9][0-9]*$/.test(ref)) throw new Error('Task ref must be positive decimal digits.');
}

export function ownershipEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('Ownership URL must be an HTTP(S) server origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export function approvalWindow(value?: string): number {
  if (value === undefined) return TASK_APPROVAL_MAX_MS;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('--approval-minutes must be a positive whole number.');
  const ms = Number(value) * 60_000;
  if (!Number.isSafeInteger(ms) || ms > TASK_APPROVAL_MAX_MS) {
    throw new Error(`--approval-minutes cannot exceed ${TASK_APPROVAL_MAX_MS / 60_000}.`);
  }
  return ms;
}

function boundStatus(raw: unknown, id: string, binding: Binding) {
  if (!raw || typeof raw !== 'object') throw new Error('Malformed ownership status.');
  const status = raw as Record<string, unknown>;
  if (status.id !== id || status.taskRef !== binding.taskRef ||
      status.intendedActor !== binding.actor || status.artifactSha256 !== binding.artifactSha256 ||
      status.keyFingerprint !== binding.keyFingerprint) {
    throw new Error('Ownership status is missing or mismatches actor/artifact/key binding; update the server if it uses the older status contract.');
  }
  if (!['pending', 'approved', 'rejected', 'expired'].includes(String(status.status)) ||
      typeof status.expiresAt !== 'string' || !Number.isFinite(Date.parse(status.expiresAt))) {
    throw new Error('Malformed ownership lifecycle status.');
  }
  return status;
}

/** Publish a complete immutable record before the network request, never overwrite. */
async function saveAttempt(path: string, candidate: Attempt): Promise<Attempt> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw new Error('Saved ownership attempt is unreadable; refusing replacement.'); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(candidate)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, path); }
  catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Saved ownership attempt is unreadable; refusing replacement.'); }
}

export async function requestOwnershipAttempt(input: {
  command: 'begin' | 'renew';
  workspace: string;
  endpoint: string;
  binding: Binding;
  client: AttemptClient;
  previousChallengeId?: string;
  ttlMs?: number;
}) {
  const { command, binding, client } = input;
  validateTaskRef(binding.taskRef);
  const endpoint = ownershipEndpoint(input.endpoint);
  const contextDigest = binding.promotion ? promotionContextDigest(binding.promotion) : undefined;
  if (!/^[a-f0-9]{64}$/.test(binding.artifactSha256) || !/^[a-f0-9]{64}$/.test(binding.keyFingerprint) ||
      !/^luca-[a-z0-9-]+$/.test(binding.actor) || !binding.publicKey) {
    throw new Error('Invalid ownership attempt binding.');
  }
  let previousChallengeId: string | null = null;
  const ttlMs = input.ttlMs ?? (command === 'begin' ? TASK_APPROVAL_DEFAULT_MS : TASK_APPROVAL_MAX_MS);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > TASK_APPROVAL_MAX_MS ||
      (command === 'begin' && ttlMs !== TASK_APPROVAL_DEFAULT_MS)) {
    throw new Error('Invalid approval window; begin retains its original ten-minute request contract.');
  }
  if (command === 'renew') {
    if (!uuid(input.previousChallengeId)) throw new Error('renew requires a valid --challenge-id for the expired request.');
    previousChallengeId = input.previousChallengeId.toLowerCase();
    const previous = boundStatus(await client.status(previousChallengeId), previousChallengeId, binding);
    if (previous.status !== 'expired' || Date.parse(previous.expiresAt as string) > Date.now() || previous.receipt) {
      throw new Error(`Cannot renew ${previous.status} request or a request with a receipt. Pending, approved and rejected decisions are never silently replaced.`);
    }
  } else if (input.previousChallengeId !== undefined) {
    throw new Error('--challenge-id is only supported by renew.');
  }
  const directory = join(input.workspace, '.local', 'task-ownership-attempts',
    hash(JSON.stringify([endpoint, binding.actor, binding.taskRef])));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, previousChallengeId ? `renew-${previousChallengeId}${contextDigest ? `-${contextDigest}` : ''}.json`
    : contextDigest ? `begin-${contextDigest}.json` : 'begin.json');
  const payload: Payload = {
    taskRef: binding.taskRef, intendedActor: binding.actor,
    artifactSha256: binding.artifactSha256, publicKey: binding.publicKey,
    keyFingerprint: binding.keyFingerprint, ttlMs,
    idempotencyKey: previousChallengeId ? `renew:${binding.taskRef}:${randomUUID()}`
      // The server caps idempotency keys at 128 characters, which the fingerprint plus a
      // promotion digest would exceed; hash them together into one fixed-length suffix.
      : contextDigest ? `${binding.taskRef}:promotion:${hash(`${binding.keyFingerprint}:${contextDigest}`)}`
        : `${binding.taskRef}:${binding.keyFingerprint}`,
    ...(contextDigest ? { contextDigest } : {}),
  };
  const saved = await saveAttempt(statePath, { version: 1, endpoint, previousChallengeId, payload });
  if (saved?.version !== 1 || saved.endpoint !== endpoint || saved.previousChallengeId !== previousChallengeId ||
      !saved.payload || Object.keys(saved.payload).sort().join(',') !== Object.keys(payload).sort().join(',') ||
      Object.entries(payload).some(([field, value]) => field !== 'idempotencyKey' &&
        saved.payload[field as keyof Payload] !== value) ||
      (previousChallengeId
        ? !saved.payload.idempotencyKey.startsWith(`renew:${binding.taskRef}:`) ||
          !uuid(saved.payload.idempotencyKey.slice(`renew:${binding.taskRef}:`.length))
        : saved.payload.idempotencyKey !== payload.idempotencyKey)) {
    throw new Error('Saved attempt differs from this endpoint, scope, key or approval window; refusing replacement.');
  }
  const response = await client.challenge(saved.payload);
  if (!response || typeof response !== 'object') throw new Error('Malformed challenge response.');
  const result = response as Record<string, unknown>;
  if (!uuid(result.challengeId) || typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) ||
      result.challengeId === previousChallengeId) throw new Error('Malformed challenge response.');
  const status = command === 'renew'
    ? boundStatus(await client.status(result.challengeId), result.challengeId, binding)
    : undefined;
  await saveOwnershipChallengeHandle(input.workspace, {
    version: 1, endpoint, actor: binding.actor, taskRef: binding.taskRef,
    artifactSha256: binding.artifactSha256, keyFingerprint: binding.keyFingerprint,
    challengeId: result.challengeId,
    ...(binding.promotion ? { promotion: binding.promotion } : {}),
  });
  return {
    challengeId: result.challengeId, taskRef: binding.taskRef, fingerprint: binding.keyFingerprint,
    expiresAt: result.expiresAt, ...(status ? { status: status.status, receipt: status.receipt ?? null } : {}),
    approvalPath: 'HolaHola → Command Center (/admin) → System → Ownership',
    retry: previousChallengeId ? `renew --challenge-id ${previousChallengeId}` : 'begin',
    ...(binding.promotion ? { promotion: binding.promotion, contextDigest } : {}),
  };
}
