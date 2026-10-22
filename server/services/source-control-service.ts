import { execFile as nodeExecFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  normalizeCoordinationRepositoryIdentity,
  sameCoordinationRepositoryIdentity,
} from './coordination-repository-identity';
import { parseReleaseIdentity } from './release-identity';
import { encodeGithubAppGitCredential, fetchGithubInstallationToken } from './github-app-auth';
import { coordinationV2SourcePromotions } from '@shared/schema';
import { protectedSnapshotGitErrorCode } from './protected-snapshot-git-diagnostic';
import { hashGitCommitSourceContext } from '../../scripts/source-context-digest.mjs';
import { checkEpisodeContentLoss } from './episode-content-loss-guard';

const execFile = promisify(nodeExecFile);

export const SOURCE_CONTROL_VALIDATION_MANIFEST_VERSION = 3;
export const SOURCE_CONTROL_REQUIRED_CHECKS = [
  'typecheck',
  'build',
  'ciUnit',
  'ciGuards',
  'ciEpisodes',
  'sourceBridgeSafety',
  'githubReleaseSafety',
  'githubSyncShellGuards',
] as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RENDER_RELEASE_REFERENCE_PATTERN = /^render-release:([0-9a-f]{40}):([0-9a-f]{64})$/;

// A freshly prepared candidate must never inherit a prior candidate
// generation's promotion-completion evidence. writeStatus() otherwise
// carries promotedSha (and related promotion metadata) forward from the
// previous status so it survives incidental synced/dirty/failed writes;
// pass this alongside every ready_to_promote write that starts a new
// candidate window so validPreparedCandidate() cannot mistake a brand-new
// candidate for one already recorded as promoted.
const FRESH_CANDIDATE_STATUS_EXTRA = {
  promotedSha: undefined,
  promotedBy: undefined,
  promotionRequestId: undefined,
  promotionVerificationMode: undefined,
  publicationReference: undefined,
} as const;
const DEFAULT_LOCK_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RELEASE_HEALTH_TIMEOUT_MS = 10_000;
const MAX_RELEASE_HEALTH_BYTES = 64 * 1024;
const PROTECTED_SNAPSHOT_MAX_PATHS = 16;
const PROTECTED_SNAPSHOT_MAX_BLOB_BYTES = 2 * 1024 * 1024;
const PROTECTED_SNAPSHOT_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export type ProtectedRemoteSnapshot = {
  sha: string;
  treeSha: string;
  blobs: Record<string, Buffer>;
};

export type ProtectedSnapshotGitRunner = (
  args: string[],
  cwd: string,
  maxBuffer: number,
) => Promise<Buffer>;

function validProtectedSnapshotPaths(fixedPaths: readonly string[]): boolean {
  return Array.isArray(fixedPaths)
    && fixedPaths.length >= 1
    && fixedPaths.length <= PROTECTED_SNAPSHOT_MAX_PATHS
    && new Set(fixedPaths).size === fixedPaths.length
    && fixedPaths.every((path) =>
      typeof path === 'string'
      && path.length <= 512
      && PROTECTED_SNAPSHOT_PATH.test(path)
      && !path.includes('..')
      && !path.includes('\\')
      && !path.includes(':'));
}

/**
 * Materializes one exact commit into a temporary bare repository using a Git
 * runner whose authentication and host verification are supplied by the
 * authority-owning caller.
 */
export async function materializeProtectedGitSnapshot(input: {
  repoUrl: string;
  sha: string;
  fixedPaths: readonly string[];
  runGit: ProtectedSnapshotGitRunner;
  tempParent?: string;
}): Promise<ProtectedRemoteSnapshot> {
  if (!SHA_PATTERN.test(input.sha)
    || typeof input.repoUrl !== 'string'
    || input.repoUrl.length < 1
    || !validProtectedSnapshotPaths(input.fixedPaths)) {
    throw new Error('protected_remote_snapshot_request_invalid');
  }
  const root = await mkdtemp(join(input.tempParent ?? '/tmp', 'holahola-protected-snapshot-'));
  const run = (args: string[], maxBuffer = 2 * 1024 * 1024) =>
    input.runGit(args, root, maxBuffer);
  try {
    await run(['init', '--bare']);
    await run(['remote', 'add', 'origin', input.repoUrl]);
    await run(['config', 'remote.origin.promisor', 'true']);
    await run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    await run([
      '-c', 'protocol.version=2',
      'fetch', '--no-tags', '--depth=1', '--filter=blob:none', 'origin', input.sha,
    ]);
    const received = (await run(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], 1024))
      .toString('utf8').trim();
    const treeSha = (await run(['rev-parse', '--verify', `${received}^{tree}`], 1024))
      .toString('utf8').trim();
    assertAuthenticatedRemoteCommitProof(input.sha, { sha: received, treeSha });
    const blobs: Record<string, Buffer> = {};
    for (const path of [...input.fixedPaths].sort()) {
      const object = `${received}:${path}`;
      const sizeText = (await run(['cat-file', '-s', object], 1024))
        .toString('utf8').trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size)
        || size < 1
        || size > PROTECTED_SNAPSHOT_MAX_BLOB_BYTES) {
        throw new Error('protected_remote_snapshot_blob_invalid');
      }
      const bytes = await run(
        ['cat-file', 'blob', object],
        PROTECTED_SNAPSHOT_MAX_BLOB_BYTES + 1,
      );
      if (bytes.length !== size) throw new Error('protected_remote_snapshot_blob_invalid');
      blobs[path] = bytes;
    }
    return { sha: received, treeSha, blobs };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function assertAuthenticatedRemoteCommitProof(
  expectedSha: string,
  proof: { sha: string; treeSha: string },
  expectedTreeSha?: string,
): void {
  if (!SHA_PATTERN.test(expectedSha) || proof.sha !== expectedSha || !SHA_PATTERN.test(proof.treeSha)
    || (expectedTreeSha !== undefined && proof.treeSha !== expectedTreeSha)) {
    throw new Error('remote_commit_proof_mismatch');
  }
}

export type SourceControlState =
  | 'disabled'
  | 'synced'
  | 'replit_ahead'
  | 'github_ahead'
  | 'ready_to_promote'
  | 'dirty'
  | 'diverged'
  | 'history_incomplete'
  | 'retrying'
  | 'failed';

export interface SourceControlStatus {
  schemaVersion: 3;
  state: SourceControlState;
  origin: string;
  replitSha?: string;
  githubSha?: string;
  candidateSha?: string;
  candidatePreparedAt?: string;
  candidateExpiresAt?: string;
  /** Set to 'auto_sync' only when this candidateSha was produced by
   * syncLocked()'s "GitHub ahead of local" auto-merge-and-revalidate branch
   * (the scheduler receiving and validating a new commit on its own),
   * never by an explicit prepareLocked() run. Absent/undefined means the
   * current candidate was validated by an explicit `prepare` call --
   * prepareLocked() always clears this back to undefined so a fresh,
   * explicitly-prepared candidate is never mistaken for the auto-sync
   * case. An auto-revalidated candidate looks identical to an explicitly
   * prepared one in every other field (same manifest shape, same
   * ready_to_promote state), so without this tag a human/API caller
   * recording the current candidateSha could silently promote code
   * nobody deliberately reviewed via `prepare`. See recordLocked() and
   * checkCandidateDrift(). */
  candidateSource?: 'auto_sync';
  promotedSha?: string;
  promotedBy?: string;
  promotionRequestId?: string;
  promotionVerificationMode?: string;
  publicationReference?: string;
  validation?: Record<string, unknown>;
  validationManifestVersion?: number;
  validationId?: string;
  error?: string;
  lastSuccessfulSyncAt?: string;
  consecutiveFailures: number;
  lastHeartbeatAt: string;
  updatedAt: string;
  /** Set only once a stalled-sync alert's DURABLE (founder-inbox) delivery
   * has been CONFIRMED for the current failure streak, so repeated polls
   * don't spam the founder inbox. Deliberately never set optimistically
   * before delivery succeeds: if it were, a transient outage in the very
   * channel used to raise the alarm (the database being down the moment
   * the threshold is first crossed, say) would permanently suppress the
   * alert for the rest of the episode -- the exact silent failure this
   * exists to prevent. Cleared on the next successful sync so a future
   * stall can alert again. */
  stalledSyncAlertActive?: boolean;
  stalledSyncAlertSentAt?: string;
  /** Same confirmed-delivery contract as stalledSyncAlertActive above, but
   * tracked separately for Team Room: the two channels can fail
   * independently, and a retry aimed at the channel still failing must not
   * re-post to a channel that already succeeded. */
  stalledSyncAlertTeamRoomDeliveredAt?: string;
  /** Tracks the post-push validation that runs synchronously, still inside
   * the sync lock, immediately after syncLocked()'s local-ahead branch
   * fast-forwards a push onto GitHub main. Unlike `validation` above --
   * which is prepareLocked()'s / the auto-sync receive-branch's "is this
   * SHA a reviewed, ready-to-promote candidate" signal -- this answers an
   * orthogonal question: did the commit that is *already* on GitHub main
   * turn out to pass the same manifest. `state` stays 'synced' regardless
   * of the outcome (the git push did succeed and heads are equal), so this
   * field -- and the dedicated one-shot alert fired on failure -- is the
   * only signal a failure happened. Preserved across incidental writes the
   * same way candidateSource is, and only ever reset by a fresh push
   * starting this cycle again (see PushValidationFailedContext). */
  pushValidationStatus?: 'pending' | 'passed' | 'failed';
  /** Which pushed SHA the above status refers to, so a stale in-flight
   * result from a since-superseded push is never mistaken for current. */
  pushValidationSha?: string;
  pushValidationError?: string;
  pushValidationCompletedAt?: string;
}

/** Thresholds that decide when a run of sync trouble stops being "normal
 * transient noise" (a brief dirty tree, momentary lock contention) and
 * becomes something a human should be told about. Both are env-overridable
 * so an operator can tune them without a code change, the same way
 * SOURCE_CONTROL_POLL_MS is. */
export interface SourceControlStallThresholds {
  consecutiveFailureThreshold: number;
  staleSuccessAgeMs: number;
}

const DEFAULT_STALL_FAILURE_THRESHOLD = 6;
const DEFAULT_STALL_AGE_MS = 3 * 60 * 60 * 1000;

export function resolveSourceControlStallThresholds(
  env: NodeJS.ProcessEnv = process.env,
): SourceControlStallThresholds {
  const consecutiveFailureThreshold = Number(env.SOURCE_CONTROL_STALL_FAILURE_THRESHOLD);
  const staleSuccessAgeMs = Number(env.SOURCE_CONTROL_STALL_AGE_MS);
  return {
    consecutiveFailureThreshold: Number.isFinite(consecutiveFailureThreshold) && consecutiveFailureThreshold > 0
      ? consecutiveFailureThreshold
      : DEFAULT_STALL_FAILURE_THRESHOLD,
    staleSuccessAgeMs: Number.isFinite(staleSuccessAgeMs) && staleSuccessAgeMs > 0
      ? staleSuccessAgeMs
      : DEFAULT_STALL_AGE_MS,
  };
}

/**
 * Pure decision of whether a status snapshot represents a genuine stall,
 * deliberately blind to *which* state is currently failing: dirty trees,
 * lock contention ('retrying'), divergence, and plain Git failures all
 * increment the same consecutiveFailures counter in writeStatus(). A single
 * bad poll -- or the "clears within a poll or two" dirty / lock-contention
 * cases this exists to avoid alerting on -- must never cross this on its
 * own; the defaults in resolveSourceControlStallThresholds sit comfortably
 * above that noise floor. Exported so the threshold truth table can be
 * tested directly without exercising sync()/writeStatus() or a fake Team
 * Room/DB.
 */
export function isSourceControlSyncStalled(
  status: Pick<SourceControlStatus, 'consecutiveFailures' | 'lastSuccessfulSyncAt'>,
  thresholds: SourceControlStallThresholds,
  nowMs: number,
): boolean {
  if (status.consecutiveFailures >= thresholds.consecutiveFailureThreshold) return true;
  if (!status.lastSuccessfulSyncAt) return false;
  const lastSuccessMs = new Date(status.lastSuccessfulSyncAt).getTime();
  if (!Number.isFinite(lastSuccessMs)) return false;
  return nowMs - lastSuccessMs >= thresholds.staleSuccessAgeMs;
}

/** Minimal, stable facts a stalled-sync alert needs to describe the
 * situation -- deliberately narrower than SourceControlStatus so the
 * notify hook can be called with the alert-relevant facts *before* the
 * alert-delivery outcome fields (stalledSyncAlertActive et al) are known.
 * Those fields are this call's own eventual output, never an input to it --
 * passing the full status in would recreate the ordering bug this design
 * fixes (persisting "delivered" before delivery is confirmed). */
export interface StalledSyncAlertContext {
  state: SourceControlState;
  consecutiveFailures: number;
  lastSuccessfulSyncAt?: string;
  error?: string;
}

/** Per-channel confirmation of whether a stalled-sync alert attempt
 * actually reached each destination. Each field is true only when that
 * specific post/insert is known to have succeeded -- never optimistically
 * -- so a caller can safely gate retry/dedup state on the result instead
 * of on the mere fact that delivery was attempted. */
export interface StalledSyncAlertDeliveryResult {
  teamRoomDelivered: boolean;
  founderInboxDelivered: boolean;
}

/** Minimal facts a candidate-superseded alert needs: an explicitly
 * prepared, still-current `ready_to_promote` candidate was just replaced
 * by a different commit that syncLocked()'s own auto-merge-and-revalidate
 * branch received from GitHub and validated on its own, with no explicit
 * `prepare` run against it. */
export interface CandidateSupersededContext {
  supersededCandidateSha: string;
  supersededPreparedAt?: string;
  newCandidateSha: string;
  actor: string;
}
/** Minimal facts a post-push-validation-failed alert needs: a commit
 * already reached GitHub main via syncLocked()'s local-ahead fast-forward
 * push, and the same validation manifest a `prepare` run would have used
 * then failed against it. The push itself already succeeded and is never
 * undone -- this only reports that nobody has confirmed the content is
 * actually good. */
export interface PushValidationFailedContext {
  sha: string;
  error: string;
  actor: string;
}
export interface SourceControlOperation {
  schemaVersion: 1;
  operationId: string;
  action: 'sync' | 'prepare' | 'record';
  actor: string;
  status: 'running' | 'succeeded' | 'failed';
  createdAt: string;
  completedAt?: string;
  requestedSha?: string;
  candidateSha?: string;
  error?: string;
}

export interface SourceControlResult {
  ok: boolean;
  state: SourceControlState;
  replitSha?: string;
  githubSha?: string;
  candidateSha?: string;
  /** Mirrors SourceControlStatus.candidateSource -- see there for what
   * 'auto_sync' means and why it matters. */
  candidateSource?: 'auto_sync';
  validation?: Record<string, unknown>;
  error?: string;
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface SourceControlServiceOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  uuid?: () => string;
  runCommand?: CommandRunner;
  validateCandidate?: (sha: string) => Promise<Record<string, unknown>>;
  recordSourcePromotion?: (input: SourcePromotionRecordInput) => Promise<void>;
  /** Protected remote proof hook. Production uses authenticated GitHub fetch. */
  resolveRemoteCommit?: (sha: string) => Promise<{ sha: string; treeSha: string; parentSha?: string }>;
  /** Protected immutable snapshot hook. Production uses one authenticated bare-repository fetch. */
  resolveRemoteSnapshot?: (
    sha: string,
    fixedPaths: readonly string[],
  ) => Promise<ProtectedRemoteSnapshot>;
  /** Protected Render release proof hook. Production resolves one pinned HTTPS health document. */
  resolveRenderReleaseEvidence?: (
    expectedSha: string,
    expectedSourceContextSha256: string,
  ) => Promise<RenderReleaseEvidence>;
  /** Protected candidate source-context hook. Production hashes the exact local Git commit tree. */
  resolveCandidateSourceContext?: (
    sha: string,
  ) => Promise<{ sourceContextSha256: string; sourceFileCount: number }>;
  /** GitHub App installation-token hook. Production mints a fresh RS256 JWT and exchanges it. */
  fetchInstallationToken?: () => Promise<{ token: string }>;
  /** Stalled-sync alert dispatch hook. Production posts to Team Room and the
   * founder's aldenNotifications inbox (see dispatchStalledSyncAlert).
   * Receives which channels a prior attempt already confirmed delivered
   * for this same episode, so a retry only re-attempts channels still
   * outstanding, and must return which channels this attempt actually
   * confirmed -- callers rely on that returned result, never on the
   * attempt merely having been made, to decide whether to stop retrying.
   * Injectable so tests can assert on firing/retry behavior without
   * touching Team Room or the database. */
  notifyStalledSync?: (
    context: StalledSyncAlertContext,
    alreadyDelivered: StalledSyncAlertDeliveryResult,
  ) => Promise<StalledSyncAlertDeliveryResult>;
  /** Candidate-superseded alert dispatch hook. Production posts to Team
   * Room and the founder's aldenNotifications inbox (see
   * dispatchCandidateSupersededAlert). Fired once, best-effort, exactly
   * when syncLocked()'s auto-merge-and-revalidate branch silently replaces
   * a still-current, explicitly-prepared ready_to_promote candidate --
   * unlike the stalled-sync alert this is a one-shot state transition, not
   * an ongoing condition, so it carries no cross-tick retry/dedup
   * bookkeeping. Injectable so tests can assert on firing without
   * touching Team Room or the database. */
  notifyCandidateSuperseded?: (context: CandidateSupersededContext) => Promise<void>;
  /** Post-push-validation-failed alert dispatch hook. Production posts to
   * Team Room and the founder's aldenNotifications inbox (see
   * dispatchPushValidationFailedAlert). Fired once, best-effort, exactly
   * when syncLocked()'s local-ahead branch pushes to GitHub main and the
   * synchronous validation of that same commit then fails. Unlike
   * notifyCandidateSuperseded this is not about candidate bookkeeping --
   * it means code already on the shared remote turned out to be broken.
   * Injectable so tests can assert on firing without touching Team Room or
   * the database. */
  notifyPushValidationFailed?: (context: PushValidationFailedContext) => Promise<void>;
}

export interface SourcePromotionRecordInput {
  repositoryIdentity: string;
  promotedCommitSha: string;
  exactTreeSha: string;
  publicationReference: string;
  protectedValidationId: string;
  publishTriggerSha?: string;
  parentSha?: string;
  canonicalRecordDigest: string;
  operationReceiptDigest: string;
  operationReceiptReference: string;
}

type LocalPublicationMarkerProof = {
  sha: string;
  treeSha: string;
  parentSha: string;
  subject: string;
};

export type RenderReleaseEvidence = {
  schemaVersion: 1;
  authority: 'build';
  promotable: true;
  commitSha: string;
  sourceContextSha256: string;
  sourceContextAlgorithm: 'sha256(path-nul-kind-nul-bytes-nul-v1)';
  sourceFileCount: number;
  dirtyWorktree: boolean | null;
};

export function validateRenderReleaseEvidence(
  raw: unknown,
  expectedSha: string,
  expectedSourceContextSha256: string,
): RenderReleaseEvidence {
  if (!SHA_PATTERN.test(expectedSha) || !SHA256_PATTERN.test(expectedSourceContextSha256)) {
    throw new Error('render_release_expectation_invalid');
  }
  const identity = parseReleaseIdentity(raw);
  if (
    identity.authority !== 'build'
    || identity.promotable !== true
    || identity.commitSha !== expectedSha
    || identity.sourceContextSha256 !== expectedSourceContextSha256
  ) {
    throw new Error('render_release_identity_mismatch');
  }
  return {
    schemaVersion: 1,
    authority: 'build',
    promotable: true,
    commitSha: identity.commitSha,
    sourceContextSha256: identity.sourceContextSha256,
    sourceContextAlgorithm: 'sha256(path-nul-kind-nul-bytes-nul-v1)',
    sourceFileCount: identity.sourceFileCount,
    dirtyWorktree: identity.dirtyWorktree,
  };
}

export async function resolveRenderReleaseEvidenceFromHealth(
  env: NodeJS.ProcessEnv,
  expectedSha: string,
  expectedSourceContextSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RenderReleaseEvidence> {
  if (!SHA_PATTERN.test(expectedSha) || !SHA256_PATTERN.test(expectedSourceContextSha256)) {
    throw new Error('render_release_expectation_invalid');
  }
  const configured = env.SOURCE_RELEASE_HEALTH_URL;
  if (!configured) throw new Error('render_release_health_url_missing');
  const url = new URL(configured);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/health/release'
  ) {
    throw new Error('render_release_health_url_invalid');
  }
  const configuredTimeout = Number(env.SOURCE_RELEASE_HEALTH_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 30_000)
    : DEFAULT_RELEASE_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) throw new Error('render_release_health_status_invalid');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_HEALTH_BYTES) {
      throw new Error('render_release_health_body_too_large');
    }
    if (!response.body) throw new Error('render_release_health_body_missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RELEASE_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error('render_release_health_body_too_large');
      }
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    return validateRenderReleaseEvidence(
      JSON.parse(body),
      expectedSha,
      expectedSourceContextSha256,
    );
  } finally {
    clearTimeout(timeout);
  }
}

type PreparedCandidateEvidence = {
  candidateSha: string;
  candidatePreparedAt: string;
  candidateExpiresAt: string;
  validation: Record<string, unknown>;
};

type CanonicalSourcePromotionFields = {
  repositoryIdentity: string;
  promotedCommitSha: string;
  exactTreeSha: string;
  publicationReference: string;
  protectedValidationId: string;
  publishTriggerSha: string | null;
  parentSha: string | null;
  canonicalRecordDigest: string;
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bounded(value: string): string {
  return value.length <= 8192 ? value : `${value.slice(0, 8192)}\n[truncated]`;
}

function defaultRunner(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CommandResult> {
  return execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({
    exitCode: 0,
    stdout: String(stdout || ''),
    stderr: String(stderr || ''),
  })).catch((error: any) => ({
    exitCode: typeof error?.code === 'number' ? error.code : 1,
    stdout: String(error?.stdout || ''),
    stderr: String(error?.stderr || error?.message || ''),
  }));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sourceControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.SOURCE_CONTROL_ENABLED !== 'false';
}

export function hasValidSourceControlManifest(
  validation: Record<string, unknown> | undefined,
  expectedSha: string,
): boolean {
  const checks = validation?.checks as Record<string, unknown> | undefined;
  const sourceContextSha256 = validation?.sourceContextSha256;
  const sourceFileCount = validation?.sourceFileCount;
  const sourceContextAlgorithm = validation?.sourceContextAlgorithm;
  if (
    validation?.manifestVersion !== SOURCE_CONTROL_VALIDATION_MANIFEST_VERSION
    || validation?.candidateSha !== expectedSha
    || !checks
    || typeof sourceContextSha256 !== 'string'
    || !SHA256_PATTERN.test(sourceContextSha256)
    || sourceContextAlgorithm !== 'sha256(path-nul-kind-nul-bytes-nul-v1)'
    || !Number.isInteger(sourceFileCount)
    || Number(sourceFileCount) < 1
    || Object.keys(checks).length !== SOURCE_CONTROL_REQUIRED_CHECKS.length
    || SOURCE_CONTROL_REQUIRED_CHECKS.some((name) => checks[name] !== 'passed')
  ) return false;
  const canonicalChecks = Object.fromEntries(
    SOURCE_CONTROL_REQUIRED_CHECKS.map((name) => [name, 'passed']),
  );
  const expectedId = digest(JSON.stringify({
    manifestVersion: SOURCE_CONTROL_VALIDATION_MANIFEST_VERSION,
    candidateSha: expectedSha,
    sourceContextSha256,
    sourceContextAlgorithm,
    sourceFileCount,
    checks: canonicalChecks,
  }));
  return validation.validationId === expectedId;
}

export type CandidateDriftReason =
  | 'no_candidate'
  | 'match'
  | 'auto_promoted_candidate'
  | 'candidate_invalid'
  | 'head_moved_past_candidate'
  | 'unknown';
export class SourceControlService {
  private readonly rootDir: string;

  private readonly env: NodeJS.ProcessEnv;

  private readonly now: () => Date;

  private readonly resolveRemoteCommit: (sha: string) => Promise<{ sha: string; treeSha: string; parentSha?: string }>;

  private readonly resolveRemoteSnapshot: (
    sha: string,
    fixedPaths: readonly string[],
  ) => Promise<ProtectedRemoteSnapshot>;

  private readonly resolveRenderReleaseEvidence: (
    expectedSha: string,
    expectedSourceContextSha256: string,
  ) => Promise<RenderReleaseEvidence>;

  private readonly resolveCandidateSourceContext: (
    sha: string,
  ) => Promise<{ sourceContextSha256: string; sourceFileCount: number }>;

  private readonly uuid: () => string;

  private readonly runCommand: CommandRunner;

  private readonly validateCandidate: (sha: string) => Promise<Record<string, unknown>>;

  private readonly branch: string;

  private readonly repoUrl: string;

  private readonly repositoryIdentity: string;

  private readonly statusPath: string;

  private readonly summaryPath: string;

  private readonly lockPath: string;

  private readonly operationsDir: string;

  private readonly leaseMs: number;

  private readonly recordSourcePromotion: (input: SourcePromotionRecordInput) => Promise<void>;

  private readonly fetchInstallationToken: () => Promise<{ token: string }>;

  private readonly notifyStalledSync: (
    context: StalledSyncAlertContext,
    alreadyDelivered: StalledSyncAlertDeliveryResult,
  ) => Promise<StalledSyncAlertDeliveryResult>;

  private readonly notifyCandidateSuperseded: (context: CandidateSupersededContext) => Promise<void>;

  private readonly notifyPushValidationFailed: (context: PushValidationFailedContext) => Promise<void>;

  /** In-process retry/dedup state for checkStalled()'s standalone timer
   * path only. writeStatus() has its own durable dedup via
   * stalledSyncAlertActive/stalledSyncAlertTeamRoomDeliveredAt in the
   * status file; this one guards the read-only backstop so it never writes
   * to disk (see checkStalled() for why that matters). Keyed on the
   * failure snapshot identity so a genuinely new snapshot always gets a
   * fresh attempt, while a repeat check against the *same* unchanging
   * snapshot (a wedged sync()) retries only whichever channel's last
   * attempt did not yet succeed. */
  private lastStandaloneStallNotify?: {
    key: string;
    delivered: StalledSyncAlertDeliveryResult;
  };

  /** Wall-clock backstop for a sync() that wedges on its very first-ever
   * attempt (stuck lock, hung Git subprocess) before writeStatus() has run
   * even once. isSourceControlSyncStalled() alone cannot see that case: it
   * needs either consecutiveFailures (only incremented by a completed
   * writeStatus call) or lastSuccessfulSyncAt (only ever set by one), and a
   * sync that never finishes never touches either. Recorded once, here, at
   * construction time -- independent of the status file -- so checkStalled()
   * still has a clock to measure against when getStatus() returns null. */
  private readonly startedAtMs: number;

  constructor(options: SourceControlServiceOptions = {}) {
    this.rootDir = options.rootDir || process.cwd();
    this.env = options.env || process.env;
    this.now = options.now || (() => new Date());
    this.startedAtMs = this.now().getTime();
    this.uuid = options.uuid || randomUUID;
    this.runCommand = options.runCommand || defaultRunner;
    this.branch = this.env.SOURCE_BRIDGE_BRANCH || 'main';
    this.repoUrl = this.env.GITHUB_REPO_URL || 'https://github.com/HolaHolaOrganization/HolaHola.git';
    this.repositoryIdentity = normalizeCoordinationRepositoryIdentity(this.repoUrl);
    this.resolveRemoteCommit = options.resolveRemoteCommit ?? ((sha) => this.fetchRemoteCommitProof(sha));
    this.resolveRemoteSnapshot = options.resolveRemoteSnapshot
      ?? ((sha, fixedPaths) => this.fetchProtectedRemoteSnapshot(sha, fixedPaths));
    this.resolveRenderReleaseEvidence = options.resolveRenderReleaseEvidence
      ?? ((sha, sourceContextSha256) => resolveRenderReleaseEvidenceFromHealth(
        this.env,
        sha,
        sourceContextSha256,
      ));
    this.resolveCandidateSourceContext = options.resolveCandidateSourceContext
      ?? (async (sha) => {
        const source = await hashGitCommitSourceContext(this.rootDir, sha);
        return {
          sourceContextSha256: source.digest,
          sourceFileCount: source.fileCount,
        };
      });
    this.statusPath = this.resolvePath(this.env.SOURCE_BRIDGE_STATUS_FILE, '.local/source-bridge-status.json');
    this.summaryPath = this.resolvePath(this.env.SOURCE_BRIDGE_SUMMARY_FILE, '.local/source-bridge-status.md');
    this.lockPath = this.resolvePath(this.env.SOURCE_CONTROL_LOCK_FILE, '.local/source-control.lock');
    this.operationsDir = this.resolvePath(this.env.SOURCE_CONTROL_OPERATIONS_DIR, '.local/source-control-operations');
    this.leaseMs = Number(this.env.SOURCE_CONTROL_LOCK_LEASE_MS || DEFAULT_LOCK_LEASE_MS);
    this.validateCandidate = options.validateCandidate || ((sha) => this.runValidationManifest(sha));
    this.recordSourcePromotion = options.recordSourcePromotion || ((input) => this.appendSourcePromotion(input));
    this.fetchInstallationToken = options.fetchInstallationToken ?? (() => {
      const appId = this.env.HOLAHOLA_GITHUB_APP_ID;
      const installationId = this.env.HOLAHOLA_GITHUB_APP_INSTALLATION_ID;
      const privateKey = this.env.HOLAHOLA_GITHUB_APP_PRIVATE_KEY;
      if (!appId) throw new Error('HOLAHOLA_GITHUB_APP_ID is unavailable.');
      if (!installationId) throw new Error('HOLAHOLA_GITHUB_APP_INSTALLATION_ID is unavailable.');
      if (!privateKey) throw new Error('HOLAHOLA_GITHUB_APP_PRIVATE_KEY is unavailable.');
      return fetchGithubInstallationToken({ appId, installationId, privateKey, now: this.now });
    });
    this.notifyStalledSync = options.notifyStalledSync
      ?? ((context, alreadyDelivered) => this.dispatchStalledSyncAlert(context, alreadyDelivered));
    this.notifyCandidateSuperseded = options.notifyCandidateSuperseded
      ?? ((context) => this.dispatchCandidateSupersededAlert(context));
    this.notifyPushValidationFailed = options.notifyPushValidationFailed
      ?? ((context) => this.dispatchPushValidationFailedAlert(context));
  }

  async getStatus(): Promise<SourceControlStatus | null> {
    try {
      return JSON.parse(await readFile(this.statusPath, 'utf8')) as SourceControlStatus;
    } catch {
      return null;
    }
  }

  /**
   * Independent, read-only staleness check meant to be driven by the
   * scheduler's own timer rather than by a sync() outcome. writeStatus()
   * already raises the same alert on every real sync attempt -- the pattern
   * the original ~2.5-day incident actually followed, since the scheduler
   * kept retrying and recording failures the whole time -- but that path
   * only runs if sync() itself keeps returning. This method reads the
   * on-disk status directly so a wedged sync() (stuck lock, hung Git
   * subprocess) can still be surfaced from wall-clock time alone.
   *
   * Deliberately never writes to statusPath: it runs on a timer independent
   * of writeStatus's own read-modify-write, so doing a read-modify-write
   * here too could race a concurrent writeStatus() and clobber a fresher
   * status with a stale copy. Instead it keeps its own in-memory per-
   * channel delivery record for this exact snapshot -- safe because if
   * sync() is truly wedged, consecutiveFailures/lastSuccessfulSyncAt aren't
   * changing either, so there is nothing new to alert about until
   * something (a real sync, or a process restart) changes the snapshot. A
   * channel whose last attempt failed is retried on the next poll rather
   * than being silently and permanently given up on; a channel already
   * confirmed delivered is never re-attempted -- but confirmation of ONE
   * channel (say founder-inbox, tracked durably via stalledSyncAlertActive)
   * must never be treated as a reason to stop checking the OTHER channel
   * (Team Room): each is read independently from the status file below, and
   * either one being outstanding is enough to keep going.
   *
   * Also covers the first-ever sync attempt wedging before writeStatus() has
   * run even once: getStatus() returns null in that case, and
   * isSourceControlSyncStalled() has neither consecutiveFailures nor
   * lastSuccessfulSyncAt to compare against. Wall-clock time since this
   * service instance was constructed (startedAtMs) stands in for the status
   * file in that narrow case so the backstop still fires.
   */
  async checkStalled(): Promise<void> {
    const status = await this.getStatus();
    if (status?.state === 'disabled') return;
    const thresholds = resolveSourceControlStallThresholds(this.env);
    const nowMs = this.now().getTime();
    const stalled = status
      ? isSourceControlSyncStalled(status, thresholds, nowMs)
      : nowMs - this.startedAtMs >= thresholds.staleSuccessAgeMs;
    if (!stalled) return;
    const key = status
      ? `${status.consecutiveFailures}:${status.lastSuccessfulSyncAt || ''}`
      : 'pending-first-sync';
    const remembered = this.lastStandaloneStallNotify?.key === key
      ? this.lastStandaloneStallNotify.delivered
      : undefined;
    const already: StalledSyncAlertDeliveryResult = {
      teamRoomDelivered: Boolean(status?.stalledSyncAlertTeamRoomDeliveredAt) || Boolean(remembered?.teamRoomDelivered),
      founderInboxDelivered: Boolean(status?.stalledSyncAlertActive) || Boolean(remembered?.founderInboxDelivered),
    };
    if (already.teamRoomDelivered && already.founderInboxDelivered) return;
    const delivered = await this.notifyStalledSync(
      {
        state: status?.state ?? 'retrying',
        consecutiveFailures: status?.consecutiveFailures ?? 0,
        lastSuccessfulSyncAt: status?.lastSuccessfulSyncAt,
        error: status?.error
          ?? 'No sync attempt has completed since the scheduler started; the process may be wedged before writing its first status.',
      },
      already,
    ).catch((err: any): StalledSyncAlertDeliveryResult => {
      console.warn('[SourceControl] Stalled-sync check failed to notify:', err?.message || err);
      return already;
    });
    this.lastStandaloneStallNotify = {
      key,
      delivered: {
        teamRoomDelivered: already.teamRoomDelivered || delivered.teamRoomDelivered,
        founderInboxDelivered: already.founderInboxDelivered || delivered.founderInboxDelivered,
      },
    };
  }

  /**
   * On-demand, read-only comparison between the exact commit the last
   * `prepare` (or auto-promotion) validated and whatever Git resolves HEAD
   * to right now -- independent of whatever the scheduler's own last
   * sync/prepare/record tick happened to observe. Exists so a human can
   * check "is it still safe to click Publish?" at any moment, including
   * inside the window between an auto-promotion silently superseding a
   * validated candidate and the next scheduled sync tick noticing it (the
   * exact gap the 2026-09 e0ffe6c7 incident fell through). Never mutates
   * state and never takes the shared lock: this is a read, not an
   * operation. Deliberately kept off getStatus() itself, which other
   * callers rely on staying fast and side-effect-free -- this method's
   * live currentHead() git call is intentionally opt-in.
   */
  async checkCandidateDrift(): Promise<CandidateDriftReport> {
    const status = await this.getStatus();
    if (!status || status.state !== 'ready_to_promote' || !status.candidateSha) {
      return {
        driftDetected: false,
        reason: 'no_candidate',
        state: status?.state,
        message: 'No candidate is currently ready to promote. Run `prepare` before publishing.',
      };
    }
    if (status.candidateSource === 'auto_sync') {
      return {
        driftDetected: true,
        reason: 'auto_promoted_candidate',
        state: status.state,
        candidateSha: status.candidateSha,
        candidateSource: status.candidateSource,
        candidatePreparedAt: status.candidatePreparedAt,
        message: `The ready-to-promote candidate ${status.candidateSha} was auto-validated by the sync scheduler receiving a new commit from GitHub, not by an explicit "prepare" run. Re-run \`npm run source-control:prepare\` before publishing.`,
      };
    }
    // Mirrors recordLocked()'s own inline gate exactly: a candidateSha that
    // is otherwise the right shape (matches HEAD, explicit source) must
    // still not read as "safe to publish" once its validation window has
    // expired or its manifest no longer checks out. Without this, a stale
    // ready_to_promote left over from hours/days ago -- expired but never
    // overwritten by a newer sync tick -- would report `match` right up
    // until the moment `record` itself refuses it.
    const candidateExpiresAt = Date.parse(status.candidateExpiresAt || '');
    if (
      !Number.isFinite(candidateExpiresAt)
      || candidateExpiresAt <= this.now().getTime()
      || !hasValidSourceControlManifest(status.validation, status.candidateSha)
    ) {
      return {
        driftDetected: true,
        reason: 'candidate_invalid',
        state: status.state,
        candidateSha: status.candidateSha,
        candidatePreparedAt: status.candidatePreparedAt,
        message: `The ready-to-promote candidate ${status.candidateSha} has expired or its validation record is no longer current -- the same check \`record\` itself applies. Re-run \`npm run source-control:prepare\` before publishing.`,
      };
    }
    let currentHeadSha: string;
    try {
      currentHeadSha = await this.currentHead();
    } catch (error) {
      return {
        driftDetected: false,
        reason: 'unknown',
        state: status.state,
        candidateSha: status.candidateSha,
        message: `Could not read the current HEAD commit to check for drift (${error instanceof Error ? error.message : 'unknown error'}). Treat the last known status with caution.`,
      };
    }
    if (currentHeadSha === status.candidateSha) {
      return {
        driftDetected: false,
        reason: 'match',
        state: status.state,
        candidateSha: status.candidateSha,
        currentHeadSha,
        message: 'HEAD matches the last commit validated by `prepare`. Safe to publish.',
      };
    }
    let isLegitimateMarker = false;
    try {
      const marker = await this.resolveLocalPublicationMarker(currentHeadSha);
      if (marker.parentSha === status.candidateSha && marker.subject === 'Published your App') {
        // A matching parent + subject alone isn't enough -- that only proves
        // this commit *claims* to be a publish marker for the candidate. The
        // marker must also carry the *same tree* as the candidate itself
        // (proving it added no content of its own), the same way record's
        // own marker check does against the authenticated remote tree. This
        // stays a local-only comparison (no network fetch) since this
        // method is an advisory, read-only, pre-publish sanity check, not
        // the authoritative gate -- record() still performs the full
        // authenticated remote verification before ever writing a receipt.
        const candidateTree = await this.runGit(['rev-parse', '--verify', `${status.candidateSha}^{tree}`]);
        isLegitimateMarker = candidateTree.exitCode === 0
          && candidateTree.stdout.trim() === marker.treeSha;
      }
    } catch {
      isLegitimateMarker = false;
    }
    if (isLegitimateMarker) {
      return {
        driftDetected: false,
        reason: 'match',
        state: status.state,
        candidateSha: status.candidateSha,
        currentHeadSha,
        message: 'HEAD is exactly one Replit publish marker ahead of the last validated candidate, with no content change. Safe to record.',
      };
    }
    return {
      driftDetected: true,
      reason: 'head_moved_past_candidate',
      state: status.state,
      candidateSha: status.candidateSha,
      candidatePreparedAt: status.candidatePreparedAt,
      currentHeadSha,
      message: `HEAD (${currentHeadSha}) no longer matches the last validated candidate (${status.candidateSha}). Re-run \`npm run source-control:prepare\` against current HEAD before publishing.`,
    };
  }

  async sync(actor = 'scheduler', operationId = this.uuid()): Promise<SourceControlResult> {
    if (!sourceControlEnabled(this.env)) {
      return { ok: false, state: 'disabled', error: 'Development source control is disabled in production.' };
    }
    return this.withLock(operationId, 'sync', actor, () => this.syncLocked(actor, operationId));
  }

  async preparePromotion(actor = 'api', operationId = this.uuid()): Promise<SourceControlResult> {
    if (!sourceControlEnabled(this.env)) {
      return { ok: false, state: 'disabled', error: 'Development source control is disabled in production.' };
    }
    return this.withLock(operationId, 'prepare', actor, () => this.prepareLocked(actor, operationId));
  }

  async recordPromotion(
    sha: string,
    actor = 'api',
    operationId = this.uuid(),
    publicationReference?: string,
  ): Promise<SourceControlResult> {
    if (!SHA_PATTERN.test(sha)) {
      return { ok: false, state: 'failed', error: 'Promotion recording requires an exact lowercase 40-character SHA.' };
    }
    if (!sourceControlEnabled(this.env)) {
      return { ok: false, state: 'disabled', error: 'Development source control is disabled in production.' };
    }
    return this.withLock(operationId, 'record', actor, () =>
      this.recordLocked(sha, actor, operationId, publicationReference));
  }

  /** Narrow lease surface for isolated reconciliation; it grants no Git actions. */
  async acquireReconciliationLease(): Promise<{ release: () => Promise<void> } | null> {
    return this.acquireLease();
  }

  /** Protected Git transport only; reconciliation receives no credential material. */
  async runReconciliationGit(
    args: string[],
    cwd = this.rootDir,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await this.withGithubAppAuth((env) => this.runCommand('git', args, { cwd, env }));
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private resolvePath(configured: string | undefined, fallback: string): string {
    const selected = configured || fallback;
    return isAbsolute(selected) ? selected : resolve(this.rootDir, selected);
  }

  private async withLock<T>(
    operationId: string,
    action: SourceControlOperation['action'],
    actor: string,
    operation: () => Promise<SourceControlResult>,
  ): Promise<SourceControlResult> {
    const operationRecord: SourceControlOperation = {
      schemaVersion: 1,
      operationId,
      action,
      actor,
      status: 'running',
      createdAt: this.now().toISOString(),
    };
    await this.writeOperation(operationRecord);

    const lock = await this.acquireLease();
    if (!lock) {
      const result = { ok: false, state: 'retrying' as const, error: 'Another source-control operation holds the shared lock.' };
      await this.writeOperation({
        ...operationRecord,
        status: 'failed',
        completedAt: this.now().toISOString(),
        error: result.error,
      });
      await this.writeStatus('retrying', result.error, actor);
      return result;
    }

    try {
      const result = await operation();
      await this.writeOperation({
        ...operationRecord,
        status: result.ok ? 'succeeded' : 'failed',
        completedAt: this.now().toISOString(),
        candidateSha: result.candidateSha,
        error: result.error,
      });
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unexpected source-control failure.';
      await this.writeOperation({
        ...operationRecord,
        status: 'failed',
        completedAt: this.now().toISOString(),
        error: message,
      });
      await this.writeStatus('failed', message, actor);
      return { ok: false, state: 'failed', error: message };
    } finally {
      await lock.release();
    }
  }

  private async syncLocked(actor: string, operationId: string): Promise<SourceControlResult> {
    await this.ensureBranch();
    const heads = await this.fetchHeads();
    if (!(await this.isTrackedTreeClean())) {
      const error = 'Uncommitted tracked files prevent automatic source synchronization.';
      await this.writeStatus('dirty', error, actor, heads.local, heads.github);
      return { ok: false, state: 'dirty', ...heads, error };
    }

    const ancestry = await this.ensureAncestry(heads.local, heads.github);
    if (ancestry === 'incomplete') {
      const error = 'Common ancestry is unavailable within the configured shallow-history limit.';
      await this.writeStatus('history_incomplete', error, actor, heads.local, heads.github);
      return { ok: false, state: 'history_incomplete', ...heads, error };
    }
    if (!ancestry) {
      const error = 'Replit and GitHub histories diverged; explicit reconciliation is required.';
      await this.writeStatus('diverged', error, actor, heads.local, heads.github);
      return { ok: false, state: 'diverged', ...heads, error };
    }

    if (heads.local === heads.github) {
      const previous = await this.getStatus();
      const prepared = this.validPreparedCandidate(previous);
      if (prepared?.candidateSha === heads.local && previous?.state === 'ready_to_promote') {
        await this.writePreservedReadyStatus(actor, heads, prepared, 'Awaiting explicit Render publication and matching live release evidence.');
        return {
          ok: true,
          state: 'ready_to_promote',
          ...heads,
          candidateSha: prepared.candidateSha,
          validation: prepared.validation,
        };
      }
      if (prepared && prepared.candidateSha !== heads.local
        && await this.isExactPublishedMarker(heads.local, prepared.candidateSha)) {
        const finalHeads = await this.fetchHeads();
        const markerStillExact = finalHeads.local === heads.local
          && finalHeads.github === heads.github
          && await this.isExactPublishedMarker(finalHeads.local, prepared.candidateSha);
        if (markerStillExact && await this.isTrackedTreeClean()) {
          await this.writePreservedReadyStatus(
            actor,
            finalHeads,
            prepared,
            'Validated candidate remains ready under an exact Replit publication marker.',
          );
          return {
            ok: true,
            state: 'ready_to_promote',
            ...finalHeads,
            candidateSha: prepared.candidateSha,
            validation: prepared.validation,
          };
        }
      }
      await this.writeStatus('synced', '', actor, heads.local, heads.github);
      return { ok: true, state: 'synced', ...heads };
    }

    if (await this.isAncestor(heads.github, heads.local)) {
      let contentLoss: Awaited<ReturnType<typeof checkEpisodeContentLoss>>;
      try {
        contentLoss = await checkEpisodeContentLoss(
          (args) => this.runGit(args),
          heads.github,
          heads.local,
        );
      } catch (contentLossError: unknown) {
        const message = contentLossError instanceof Error
          ? contentLossError.message
          : 'Episode content-loss verification could not run.';
        const error = bounded(`EPISODE_CONTENT_LOSS_BLOCKED: guard failed to run — refusing to push. ${message}`);
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      if (contentLoss.blocked) {
        const summary = Object.entries(contentLoss.violations)
          .map(([file, lines]) => `${file} (${lines.length} line${lines.length === 1 ? '' : 's'} removed)`)
          .join('; ');
        const error = bounded(
          `EPISODE_CONTENT_LOSS_BLOCKED: this push would remove real episode content with no ` +
          `docs/episode-content-loss-override-*.md present — ${summary}.`,
        );
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      const pushed = await this.runGit(['push', this.repoUrl, `${heads.local}:refs/heads/${this.branch}`]);
      if (pushed.exitCode !== 0) {
        const error = bounded(pushed.stderr || 'Fast-forward push failed.');
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      const verified = await this.fetchHeads();
      if (verified.local !== verified.github || verified.local !== heads.local) {
        const error = 'Push completed without proving exact Replit/GitHub equality.';
        await this.writeStatus('failed', error, actor, verified.local, verified.github);
        return { ok: false, state: 'failed', ...verified, error };
      }
      // The push above already made this commit visible to every other
      // hat pulling from GitHub main -- convergence must never wait on the
      // full validation manifest (that is the entire point of this fast
      // path over a pre-push gate). Instead, confirm the content here,
      // still inside the sync lock so nothing else can mutate this
      // checkout mid-run (the same isolation validateCandidate() already
      // relies on in the receive branch below), and alert immediately on
      // failure rather than only discovering it at the next explicit
      // `prepare`. Recorded as 'pending' first so a status check during
      // the run sees an honest in-progress signal instead of stale data
      // left over from the previous cycle.
      await this.writeStatus('synced', '', actor, verified.local, verified.github, undefined, undefined, {
        pushValidationStatus: 'pending',
        pushValidationSha: verified.local,
        pushValidationError: undefined,
        pushValidationCompletedAt: undefined,
      });
      let pushValidation: Record<string, unknown> | undefined;
      let pushValidationError: string | undefined;
      try {
        pushValidation = await this.validateCandidate(verified.local);
      } catch (validationError: unknown) {
        pushValidationError = validationError instanceof Error
          ? validationError.message
          : 'Post-push validation could not complete.';
      }
      if (pushValidationError) {
        // `state` stays 'synced' -- the git push did succeed and heads are
        // still equal -- so this is deliberately surfaced through `error`
        // plus the dedicated pushValidationStatus field and one-shot alert
        // below, never by claiming the sync operation itself failed (which
        // would suggest retrying sync() could fix it; it cannot -- the
        // fix is to the pushed content, not to this operation).
        const error = bounded(
          `POST_PUSH_VALIDATION_FAILED: ${verified.local} reached GitHub main via the fast sync path and then ` +
          `failed validation: ${pushValidationError}. The push already completed and does not need to be redone ` +
          `-- investigate and fix forward.`,
        );
        void this.notifyPushValidationFailed({ sha: verified.local, error: pushValidationError, actor }).catch((err: any) => {
          console.warn('[SourceControl] Post-push validation-failed notification failed:', err?.message || err);
        });
        await this.writeStatus('synced', error, actor, verified.local, verified.github, undefined, undefined, {
          pushValidationStatus: 'failed',
          pushValidationSha: verified.local,
          pushValidationError,
          pushValidationCompletedAt: this.now().toISOString(),
        });
        return { ok: true, state: 'synced', ...verified, error };
      }
      await this.writeStatus('synced', '', actor, verified.local, verified.github, undefined, undefined, {
        pushValidationStatus: 'passed',
        pushValidationSha: verified.local,
        pushValidationError: undefined,
        pushValidationCompletedAt: this.now().toISOString(),
      });
      return { ok: true, state: 'synced', ...verified, validation: pushValidation };
    }

    if (await this.isAncestor(heads.local, heads.github)) {
      // Captured before the merge/overwrite below so we can tell whether
      // this auto-promotion is about to silently replace a still-current
      // candidate a human explicitly validated via `prepare` -- the exact
      // gap that let an unvalidated commit reach Publish in the 2026-09
      // e0ffe6c7 incident this guards against.
      const previousBeforeAutoPromotion = await this.getStatus();
      const merged = await this.runGit(['merge', '--ff-only', 'FETCH_HEAD']);
      if (merged.exitCode !== 0) {
        const error = bounded(merged.stderr || 'Fast-forward receive failed.');
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      const received = await this.currentHead();
      const validation = await this.validateCandidate(received);
      const verified = await this.fetchHeads();
      if (verified.local !== received || verified.local !== verified.github) {
        const error = 'Checkout changed during validation; candidate is not promotion-ready.';
        await this.writeStatus('failed', error, actor, verified.local, verified.github);
        return { ok: false, state: 'failed', ...verified, error };
      }
      await this.writeStatus(
        'ready_to_promote',
        'Received GitHub source passed validation; publish remains explicit.',
        actor,
        verified.local,
        verified.github,
        received,
        validation,
        // Tagged 'auto_sync', never left to inherit: this candidate came
        // from the scheduler receiving and validating a new commit on its
        // own, not from an explicit `prepare` run. recordLocked() refuses
        // to record while this tag is set (see SourceControlStatus.
        // candidateSource for why that distinction matters).
        { ...FRESH_CANDIDATE_STATUS_EXTRA, candidateSource: 'auto_sync' },
      );
      // A still-current, explicitly-prepared candidate just got silently
      // replaced -- surface it now instead of only on the next status
      // check, a failed `record`, or a wrong deploy. Fire-and-forget: a
      // notification hiccup must never affect sync()'s own completion
      // (same contract as notifyDirtyTreeBlock above).
      if (
        previousBeforeAutoPromotion?.state === 'ready_to_promote'
        && previousBeforeAutoPromotion.candidateSha
        && previousBeforeAutoPromotion.candidateSha !== received
        && previousBeforeAutoPromotion.candidateSource !== 'auto_sync'
      ) {
        void this.notifyCandidateSuperseded({
          supersededCandidateSha: previousBeforeAutoPromotion.candidateSha,
          supersededPreparedAt: previousBeforeAutoPromotion.candidatePreparedAt,
          newCandidateSha: received,
          actor,
        }).catch((err: any) => {
          console.warn('[SourceControl] Candidate-superseded notification failed:', err?.message || err);
        });
      }
      return {
        ok: true,
        state: 'ready_to_promote',
        ...verified,
        candidateSha: received,
        candidateSource: 'auto_sync',
        validation,
      };
    }

    const error = 'Replit and GitHub histories diverged; explicit reconciliation is required.';
    await this.writeStatus('diverged', error, actor, heads.local, heads.github);
    return { ok: false, state: 'diverged', ...heads, error };
  }

  private async prepareLocked(actor: string, _operationId: string): Promise<SourceControlResult> {
    await this.ensureBranch();
    const heads = await this.fetchHeads();
    if (!(await this.isTrackedTreeClean())) {
      const error = 'Promotion preparation refused because the worktree is dirty.';
      await this.writeStatus('dirty', error, actor, heads.local, heads.github);
      return { ok: false, state: 'dirty', ...heads, error };
    }
    if (heads.local !== heads.github) {
      const error = 'Promotion preparation requires exact Replit/GitHub commit equality.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    const validation = await this.validateCandidate(heads.local);
    const verified = await this.fetchHeads();
    if (verified.local !== heads.local || verified.local !== verified.github) {
      const error = 'Validated candidate is no longer the current equal Replit/GitHub commit.';
      await this.writeStatus('failed', error, actor, verified.local, verified.github);
      return { ok: false, state: 'failed', ...verified, error };
    }
    await this.writeStatus(
      'ready_to_promote',
      'Validation passed. Publish the exact candidate to Render explicitly, then record its matching live release identity.',
      actor,
      verified.local,
      verified.github,
      verified.local,
      validation,
      // Explicit prepare always clears any stale 'auto_sync' tag inherited
      // from a prior candidate window: this candidate WAS just validated
      // by a deliberate, explicit prepare call, so recordLocked()'s
      // auto_sync gate must never block it.
      { ...FRESH_CANDIDATE_STATUS_EXTRA, candidateSource: undefined },
    );
    return { ok: true, state: 'ready_to_promote', ...verified, candidateSha: verified.local, validation };
  }

  private async recordLocked(
    sha: string,
    actor: string,
    operationId: string,
    publicationReference?: string,
  ): Promise<SourceControlResult> {
    await this.ensureBranch();
    const heads = await this.fetchHeads();
    if (!(await this.isTrackedTreeClean())) {
      const error = 'Promotion recording refused because the worktree is dirty.';
      await this.writeStatus('dirty', error, actor, heads.local, heads.github);
      return { ok: false, state: 'dirty', ...heads, error };
    }
    const status = await this.getStatus();
    const expiry = Date.parse(status?.candidateExpiresAt || '');
    if (
      status?.state !== 'ready_to_promote'
      || status.candidateSha !== sha
      || !Number.isFinite(expiry)
      || expiry <= this.now().getTime()
      || !hasValidSourceControlManifest(status.validation, sha)
    ) {
      const error = 'Promotion recording refused: the matching validated candidate is missing, stale, or no longer current. Re-run `prepare` against the current commit before publishing.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    if (status.candidateSource === 'auto_sync') {
      // This candidate passed every check above (matching sha, unexpired,
      // valid manifest) -- it was just never actually reviewed by a
      // human/automation running `prepare`. It reached ready_to_promote as
      // a side effect of the sync scheduler receiving and auto-validating
      // a new commit from GitHub. Recording it here would let Publish
      // deploy code nobody deliberately validated.
      const error = `Promotion recording refused: candidate ${sha} was auto-validated by the sync scheduler receiving a new commit from GitHub, not by an explicit "prepare" run. Re-run \`npm run source-control:prepare\` against the current commit before publishing.`;
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    if (!publicationReference) {
      const error = 'Promotion recording requires a protected publication reference.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    const renderReference = RENDER_RELEASE_REFERENCE_PATTERN.exec(publicationReference);
    if (publicationReference.startsWith('render-release:') && !renderReference) {
      const error = 'Promotion recording refused because the Render publication reference is malformed.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    if (!renderReference) {
      const error = 'Production promotion requires verified Render release evidence. A Replit publication marker alone does not publish production. Use render-release:<commit-sha>:<source-context-sha256> for the explicitly prepared candidate.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    if (renderReference && renderReference[1] !== sha) {
      const error = 'Promotion recording refused because the Render publication reference names a different commit.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    if (
      renderReference
      && renderReference[2] !== status.validation?.sourceContextSha256
    ) {
      const error = 'Promotion recording refused because Render evidence does not match the protected candidate source context.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    try { await this.verifyConfiguredRepositoryIdentity(); } catch {
      const error = 'Promotion recording refused because the configured and actual GitHub remotes differ.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    let remoteProof: { sha: string; treeSha: string; parentSha?: string };
    try {
      remoteProof = await this.resolveRemoteCommit(sha);
    } catch {
      const error = 'Promotion recording refused because the exact commit tree could not be resolved.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    try { assertAuthenticatedRemoteCommitProof(sha, remoteProof); } catch {
      const error = 'Promotion recording refused because authenticated GitHub commit proof did not match the requested SHA/tree.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    let publicationMarker: LocalPublicationMarkerProof | undefined;
    let remotePublicationMarker: LocalPublicationMarkerProof | undefined;
    if (heads.local !== sha || heads.github !== sha) {
      const markerHeads = [...new Set([heads.local, heads.github].filter((head) => head !== sha))];
      if (markerHeads.length !== 1) {
        const error = 'Promotion recording refused because source heads do not identify one publication marker.';
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      const markerSha = markerHeads[0];
      try {
        publicationMarker = await this.resolveLocalPublicationMarker(markerSha);
      } catch {
        const error = 'Promotion recording refused because the local publication marker could not be verified.';
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      const markerMatches = publicationMarker.parentSha === sha
        && publicationMarker.treeSha === remoteProof.treeSha
        && publicationMarker.subject === 'Published your App'
        && renderReference[1] === sha;
      if (!markerMatches) {
        const error = 'Promotion recording refused because the local publication marker does not exactly match the validated candidate.';
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
      if (heads.github === markerSha) {
        try {
          const proof = await this.resolveRemoteCommit(markerSha);
          assertAuthenticatedRemoteCommitProof(markerSha, proof, remoteProof.treeSha);
          if (proof.parentSha !== sha) throw new Error('remote_publication_marker_parent_mismatch');
          remotePublicationMarker = publicationMarker;
        } catch {
          const error = 'Promotion recording refused because the authenticated GitHub publication marker did not match the validated candidate.';
          await this.writeStatus('failed', error, actor, heads.local, heads.github);
          return { ok: false, state: 'failed', ...heads, error };
        }
      }
    }
    let renderReleaseEvidence: RenderReleaseEvidence | undefined;
    if (renderReference) {
      try {
        renderReleaseEvidence = await this.resolveRenderReleaseEvidence(sha, renderReference[2]);
      } catch {
        const error = 'Promotion recording refused because Render release evidence could not be verified.';
        await this.writeStatus('failed', error, actor, heads.local, heads.github);
        return { ok: false, state: 'failed', ...heads, error };
      }
    }
    const validationId = String(status.validation?.validationId || '');
    if (!/^[0-9a-f]{64}$/.test(validationId)) {
      const error = 'Promotion recording refused because protected validation identity is missing.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    const receiptReference = join(this.operationsDir, `promotion-${digest(operationId)}.json`);
    const receipt = `${JSON.stringify({
      operationId,
      actor,
      repositoryIdentity: this.repositoryIdentity,
      sha,
      treeSha: remoteProof.treeSha,
      publicationReference,
      validationId,
      ...(renderReleaseEvidence ? { renderReleaseEvidence } : {}),
      ...(publicationMarker ? { publicationMarker } : {}),
      ...(remotePublicationMarker ? { remotePublicationMarker } : {}),
      createdAt: this.now().toISOString(),
    })}\n`;
    try {
      await this.writeImmutablePromotionReceipt(receiptReference, receipt);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Promotion receipt could not be preserved.';
      await this.writeStatus('failed', message, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error: message };
    }
    let finalHeads: { local: string; github: string };
    let finalMarker: LocalPublicationMarkerProof | undefined;
    let finalRemoteMarker: LocalPublicationMarkerProof | undefined;
    let finalRenderReleaseEvidence: RenderReleaseEvidence | undefined;
    try {
      finalHeads = await this.fetchHeads();
      await this.verifyConfiguredRepositoryIdentity();
      if (publicationMarker) finalMarker = await this.resolveLocalPublicationMarker(publicationMarker.sha);
      if (remotePublicationMarker) {
        const proof = await this.resolveRemoteCommit(remotePublicationMarker.sha);
        assertAuthenticatedRemoteCommitProof(
          remotePublicationMarker.sha,
          proof,
          remotePublicationMarker.treeSha,
        );
        if (proof.parentSha !== remotePublicationMarker.parentSha) {
          throw new Error('remote_publication_marker_parent_mismatch');
        }
        finalRemoteMarker = remotePublicationMarker;
      }
    } catch {
      const error = 'Promotion recording refused because final publication state could not be verified.';
      await this.writeStatus('failed', error, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error };
    }
    const markerUnchanged = publicationMarker
      ? finalMarker?.sha === publicationMarker.sha
        && finalMarker.treeSha === publicationMarker.treeSha
        && finalMarker.parentSha === publicationMarker.parentSha
        && finalMarker.subject === publicationMarker.subject
      : finalMarker === undefined;
    const remoteMarkerUnchanged = remotePublicationMarker
      ? finalRemoteMarker?.sha === remotePublicationMarker.sha
        && finalRemoteMarker.treeSha === remotePublicationMarker.treeSha
        && finalRemoteMarker.parentSha === remotePublicationMarker.parentSha
        && finalRemoteMarker.subject === remotePublicationMarker.subject
      : finalRemoteMarker === undefined;
    if (finalHeads.local !== heads.local
      || finalHeads.github !== heads.github
      || expiry <= this.now().getTime()
      || !(await this.isTrackedTreeClean())
      || !markerUnchanged
      || !remoteMarkerUnchanged) {
      const error = 'Promotion recording refused because source or publication evidence changed before the authority append.';
      await this.writeStatus('failed', error, actor, finalHeads.local, finalHeads.github);
      return { ok: false, state: 'failed', ...finalHeads, error };
    }
    if (renderReleaseEvidence && renderReference) {
      try {
        finalRenderReleaseEvidence = await this.resolveRenderReleaseEvidence(sha, renderReference[2]);
      } catch {
        const error = 'Promotion recording refused because final Render release evidence could not be verified.';
        await this.writeStatus('failed', error, actor, finalHeads.local, finalHeads.github);
        return { ok: false, state: 'failed', ...finalHeads, error };
      }
      if (JSON.stringify(finalRenderReleaseEvidence) !== JSON.stringify(renderReleaseEvidence)) {
        const error = 'Promotion recording refused because Render release evidence changed before the authority append.';
        await this.writeStatus('failed', error, actor, finalHeads.local, finalHeads.github);
        return { ok: false, state: 'failed', ...finalHeads, error };
      }
    }
    const canonicalRecord = {
      repositoryIdentity: this.repositoryIdentity,
      promotedCommitSha: sha,
      exactTreeSha: remoteProof.treeSha,
      publicationReference,
      protectedValidationId: validationId,
      ...(publicationMarker
        ? {
            publishTriggerSha: publicationMarker.sha,
            publicationMarker,
            ...(remotePublicationMarker ? { remotePublicationMarker } : {}),
          }
        : {}),
      ...(renderReleaseEvidence ? { renderReleaseEvidence } : {}),
    };
    try {
      await this.recordSourcePromotion({
        repositoryIdentity: this.repositoryIdentity,
        promotedCommitSha: sha,
        exactTreeSha: remoteProof.treeSha,
        publicationReference,
        protectedValidationId: validationId,
        publishTriggerSha: publicationMarker?.sha,
        parentSha: remoteProof.parentSha,
        canonicalRecordDigest: digest(JSON.stringify(canonicalRecord)),
        operationReceiptDigest: digest(receipt),
        operationReceiptReference: receiptReference,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'V2 source promotion authority append failed.';
      await this.writeStatus('failed', message, actor, heads.local, heads.github);
      return { ok: false, state: 'failed', ...heads, error: message };
    }
    await this.writeStatus(
      'synced',
      'Verified Render release identity recorded for the current validated candidate.',
      actor,
      heads.local,
      heads.github,
      sha,
      status.validation,
      {
      promotedSha: sha,
      promotedBy: actor,
      promotionRequestId: operationId,
      promotionVerificationMode: publicationMarker
        ? 'render_release_health_with_replit_publication_marker'
        : 'render_release_health',
      publicationReference,
      },
    );
    return { ok: true, state: 'synced', ...heads, candidateSha: sha };
  }

  private validPreparedCandidate(
    status: SourceControlStatus | null,
  ): PreparedCandidateEvidence | undefined {
    const candidateSha = status?.candidateSha;
    const candidatePreparedAt = status?.candidatePreparedAt;
    const candidateExpiresAt = status?.candidateExpiresAt;
    const preparedAt = Date.parse(candidatePreparedAt || '');
    const expiresAt = Date.parse(candidateExpiresAt || '');
    if (!candidateSha
      || !candidatePreparedAt
      || !candidateExpiresAt
      || !SHA_PATTERN.test(candidateSha)
      || !Number.isFinite(preparedAt)
      || !Number.isFinite(expiresAt)
      || preparedAt > this.now().getTime()
      || expiresAt <= this.now().getTime()
      || expiresAt <= preparedAt
      || !hasValidSourceControlManifest(status?.validation, candidateSha)
      || status?.promotedSha === candidateSha) {
      return undefined;
    }
    return {
      candidateSha,
      candidatePreparedAt,
      candidateExpiresAt,
      validation: status!.validation!,
    };
  }

  private async isExactPublishedMarker(markerSha: string, candidateSha: string): Promise<boolean> {
    try {
      const localMarker = await this.resolveLocalPublicationMarker(markerSha);
      if (localMarker.sha !== markerSha
        || localMarker.parentSha !== candidateSha
        || localMarker.subject !== 'Published your App') return false;
      // The production resolver authenticates each immutable commit through
      // Git's shared FETCH_HEAD. Keep these fetches sequential so one proof
      // cannot overwrite the other's fetched commit before it is inspected.
      const candidateProof = await this.resolveRemoteCommit(candidateSha);
      const markerProof = await this.resolveRemoteCommit(markerSha);
      assertAuthenticatedRemoteCommitProof(candidateSha, candidateProof);
      assertAuthenticatedRemoteCommitProof(markerSha, markerProof, candidateProof.treeSha);
      return localMarker.treeSha === candidateProof.treeSha
        && markerProof.parentSha === candidateSha;
    } catch {
      return false;
    }
  }

  private async writePreservedReadyStatus(
    actor: string,
    heads: { local: string; github: string },
    prepared: PreparedCandidateEvidence,
    message: string,
  ): Promise<void> {
    await this.writeStatus(
      'ready_to_promote',
      message,
      actor,
      heads.local,
      heads.github,
      prepared.candidateSha,
      prepared.validation,
      {
        candidatePreparedAt: prepared.candidatePreparedAt,
        candidateExpiresAt: prepared.candidateExpiresAt,
      },
    );
  }

  private async writeImmutablePromotionReceipt(path: string, contents: string): Promise<void> {
    try {
      const existing = await readFile(path, 'utf8');
      if (existing !== contents) throw new Error('Promotion receipt path already contains different bytes.');
      return;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const temp = `${path}.${this.uuid()}.tmp`;
    await writeFile(temp, contents, { mode: 0o600 });
    await rename(temp, path);
  }

  private async appendSourcePromotion(input: SourcePromotionRecordInput): Promise<void> {
    const selection = {
      id: coordinationV2SourcePromotions.id,
      repositoryIdentity: coordinationV2SourcePromotions.repositoryIdentity,
      promotedCommitSha: coordinationV2SourcePromotions.promotedCommitSha,
      exactTreeSha: coordinationV2SourcePromotions.exactTreeSha,
      publicationReference: coordinationV2SourcePromotions.publicationReference,
      protectedValidationId: coordinationV2SourcePromotions.protectedValidationId,
      publishTriggerSha: coordinationV2SourcePromotions.publishTriggerSha,
      parentSha: coordinationV2SourcePromotions.parentSha,
      canonicalRecordDigest: coordinationV2SourcePromotions.canonicalRecordDigest,
    };
    const matchesInput = (existing: CanonicalSourcePromotionFields) =>
      existing.repositoryIdentity === input.repositoryIdentity
      && existing.promotedCommitSha === input.promotedCommitSha
      && existing.exactTreeSha === input.exactTreeSha
      && existing.publicationReference === input.publicationReference
      && existing.protectedValidationId === input.protectedValidationId
      && existing.publishTriggerSha === (input.publishTriggerSha ?? null)
      && existing.parentSha === (input.parentSha ?? null)
      && existing.canonicalRecordDigest === input.canonicalRecordDigest;
    const existing = await db.select(selection).from(coordinationV2SourcePromotions).where(and(
      eq(coordinationV2SourcePromotions.promotedCommitSha, input.promotedCommitSha),
      eq(coordinationV2SourcePromotions.exactTreeSha, input.exactTreeSha),
      eq(coordinationV2SourcePromotions.publicationReference, input.publicationReference),
      eq(coordinationV2SourcePromotions.protectedValidationId, input.protectedValidationId),
    )).limit(1);
    if (existing.length) {
      if (!matchesInput(existing[0])) throw new Error('Existing source promotion does not match the complete canonical record.');
      return;
    }
    try {
      await db.insert(coordinationV2SourcePromotions).values({
        repositoryIdentity: input.repositoryIdentity,
        promotedCommitSha: input.promotedCommitSha,
        exactTreeSha: input.exactTreeSha,
        publicationReference: input.publicationReference,
        protectedValidationId: input.protectedValidationId,
        publishTriggerSha: input.publishTriggerSha,
        parentSha: input.parentSha,
        canonicalRecordDigest: input.canonicalRecordDigest,
        state: 'published',
        operationReceiptDigest: input.operationReceiptDigest,
        operationReceiptReference: input.operationReceiptReference,
      });
    } catch (error: any) {
      // A concurrent retry may have won the exact idempotency key.
      const concurrent = await db.select(selection).from(coordinationV2SourcePromotions).where(and(
        eq(coordinationV2SourcePromotions.promotedCommitSha, input.promotedCommitSha),
        eq(coordinationV2SourcePromotions.exactTreeSha, input.exactTreeSha),
        eq(coordinationV2SourcePromotions.publicationReference, input.publicationReference),
        eq(coordinationV2SourcePromotions.protectedValidationId, input.protectedValidationId),
      )).limit(1);
      if (!concurrent.length || !matchesInput(concurrent[0])) throw error;
    }
  }

  private async runValidationManifest(sha: string): Promise<Record<string, unknown>> {
    const commands: Array<[string, string[]]> = [
      ['npm', ['run', 'check']],
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test:ci:unit']],
      ['npm', ['run', 'test:ci:guards']],
      ['npm', ['run', 'test:ci:episodes']],
      ['npm', ['run', 'test:source-bridge']],
      ['npm', ['run', 'test:github-release-safety']],
      ['bash', ['scripts/test-github-sync-guards.sh']],
    ];
    for (const [command, args] of commands) {
      const result = await this.runCommand(command, args, { cwd: this.rootDir, env: this.commandEnv() });
      if (result.exitCode !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed validation: ${bounded(result.stderr || result.stdout)}`);
      }
    }
    const sourceContext = await this.resolveCandidateSourceContext(sha);
    if (
      !SHA256_PATTERN.test(sourceContext.sourceContextSha256)
      || !Number.isInteger(sourceContext.sourceFileCount)
      || sourceContext.sourceFileCount < 1
    ) {
      throw new Error('Protected candidate source context is invalid.');
    }
    const checks = Object.fromEntries(SOURCE_CONTROL_REQUIRED_CHECKS.map((name) => [name, 'passed']));
    const sourceContextAlgorithm = 'sha256(path-nul-kind-nul-bytes-nul-v1)';
    return {
      manifestVersion: SOURCE_CONTROL_VALIDATION_MANIFEST_VERSION,
      validationId: digest(JSON.stringify({
        manifestVersion: SOURCE_CONTROL_VALIDATION_MANIFEST_VERSION,
        candidateSha: sha,
        sourceContextSha256: sourceContext.sourceContextSha256,
        sourceContextAlgorithm,
        sourceFileCount: sourceContext.sourceFileCount,
        checks,
      })),
      candidateSha: sha,
      sourceContextSha256: sourceContext.sourceContextSha256,
      sourceContextAlgorithm,
      sourceFileCount: sourceContext.sourceFileCount,
      checks,
    };
  }

  private commandEnv(): NodeJS.ProcessEnv {
    return { ...this.env, GIT_TERMINAL_PROMPT: '0' };
  }

  private async ensureBranch(): Promise<void> {
    const branch = await this.runGit(['branch', '--show-current']);
    if (branch.exitCode !== 0 || branch.stdout.trim() !== this.branch) {
      throw new Error(`Source control requires ${this.branch}; current branch is ${branch.stdout.trim() || 'detached HEAD'}.`);
    }
  }

  private async currentHead(): Promise<string> {
    const result = await this.runGit(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (result.exitCode !== 0 || !SHA_PATTERN.test(result.stdout.trim())) {
      throw new Error('Could not resolve the current exact commit SHA.');
    }
    return result.stdout.trim();
  }

  private async resolveLocalPublicationMarker(sha: string): Promise<LocalPublicationMarkerProof> {
    if (!SHA_PATTERN.test(sha)) throw new Error('local_publication_marker_invalid');
    const result = await this.runGit(['show', '-s', '--format=%H%n%T%n%P%n%s', sha]);
    if (result.exitCode !== 0) throw new Error('local_publication_marker_unresolved');
    const [resolvedSha, treeSha, parentsText, subject, ...extra] = result.stdout.trimEnd().split('\n');
    const parents = parentsText?.split(' ').filter(Boolean) ?? [];
    if (extra.length
      || resolvedSha !== sha
      || !SHA_PATTERN.test(treeSha || '')
      || parents.length !== 1
      || !SHA_PATTERN.test(parents[0] || '')
      || typeof subject !== 'string') {
      throw new Error('local_publication_marker_invalid');
    }
    return { sha: resolvedSha, treeSha, parentSha: parents[0], subject };
  }

  private async fetchRemoteCommitProof(sha: string): Promise<{ sha: string; treeSha: string; parentSha?: string }> {
    if (!SHA_PATTERN.test(sha)) throw new Error('invalid_remote_commit_sha');
    // Fetch the immutable object by SHA, never a branch/ref. The pinned SSH
    // host keys and protected deploy key are enforced by the existing runner.
    const fetched = await this.runGit(['fetch', '--no-tags', '--filter=blob:none', this.repoUrl, sha]);
    if (fetched.exitCode !== 0) throw new Error(`GitHub commit fetch failed: ${bounded(fetched.stderr || fetched.stdout)}`);
    const received = await this.runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (received.exitCode !== 0 || received.stdout.trim() !== sha) throw new Error('remote_commit_sha_mismatch');
    const tree = await this.runGit(['rev-parse', '--verify', `${sha}^{tree}`]);
    if (tree.exitCode !== 0 || !SHA_PATTERN.test(tree.stdout.trim())) throw new Error('remote_tree_unresolved');
    const parent = await this.runGit(['rev-parse', '--verify', `${sha}^`]);
    return {
      sha, treeSha: tree.stdout.trim(),
      ...(parent.exitCode === 0 && SHA_PATTERN.test(parent.stdout.trim()) ? { parentSha: parent.stdout.trim() } : {}),
    };
  }

  async verifyConfiguredRepositoryIdentity(): Promise<void> {
    const actual = await this.runGit(['config', '--get', 'remote.origin.url']);
    if (actual.exitCode !== 0) throw new Error('repository_remote_unavailable');
    const actualIdentity = normalizeCoordinationRepositoryIdentity(actual.stdout.trim());
    const configuredIdentity = normalizeCoordinationRepositoryIdentity(this.repoUrl);
    if (actualIdentity !== configuredIdentity) throw new Error('repository_remote_mismatch');
    const pinned = this.env.COORDINATION_V2_REPOSITORY_IDENTITY;
    if (pinned && normalizeCoordinationRepositoryIdentity(pinned) !== actualIdentity) {
      throw new Error('repository_identity_pin_mismatch');
    }
  }

  /**
   * Exposes only the authenticated immutable-object proof used by other
   * authority services. It deliberately does not expose the command runner,
   * local refs, or branch state.
   */
  async resolveProtectedRemoteCommitProof(
    sha: string,
  ): Promise<{ sha: string; treeSha: string; parentSha?: string }> {
    await this.verifyConfiguredRepositoryIdentity();
    return this.fetchRemoteCommitProof(sha);
  }

  /**
   * Reads a closed set of immutable blobs from one authenticated exact-commit
   * fetch. This works in production without a local checkout or .git directory.
   */
  async resolveProtectedRemoteSnapshot(input: {
    sha: string;
    repositoryIdentity: string;
    fixedPaths: readonly string[];
  }): Promise<ProtectedRemoteSnapshot> {
    if (!/^https:\/\/github\.com\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\.git$/.test(this.repoUrl)
      || !SHA_PATTERN.test(input.sha)
      || !sameCoordinationRepositoryIdentity(input.repositoryIdentity, this.repositoryIdentity)
      || !validProtectedSnapshotPaths(input.fixedPaths)) {
      throw new Error('protected_remote_snapshot_request_invalid');
    }
    const fixedPaths = [...input.fixedPaths].sort();
    const snapshot = await this.resolveRemoteSnapshot(input.sha, fixedPaths);
    assertAuthenticatedRemoteCommitProof(input.sha, snapshot);
    if (!snapshot.blobs || Object.keys(snapshot.blobs).sort().join('\n') !== fixedPaths.join('\n')) {
      throw new Error('protected_remote_snapshot_paths_mismatch');
    }
    const blobs: Record<string, Buffer> = {};
    for (const path of fixedPaths) {
      const value = snapshot.blobs[path];
      if (!Buffer.isBuffer(value)
        || value.length < 1
        || value.length > PROTECTED_SNAPSHOT_MAX_BLOB_BYTES) {
        throw new Error('protected_remote_snapshot_blob_invalid');
      }
      blobs[path] = Buffer.from(value);
    }
    return { sha: snapshot.sha, treeSha: snapshot.treeSha, blobs };
  }

  private async fetchHeads(): Promise<{ local: string; github: string }> {
    const fetched = await this.runGit(['fetch', '--no-tags', '--filter=blob:none', this.repoUrl, this.branch]);
    if (fetched.exitCode !== 0) {
      throw new Error(`GitHub fetch failed: ${bounded(fetched.stderr || fetched.stdout)}`);
    }
    const local = await this.currentHead();
    const remote = await this.runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (remote.exitCode !== 0 || !SHA_PATTERN.test(remote.stdout.trim())) {
      throw new Error('Could not resolve the fetched GitHub commit SHA.');
    }
    return { local, github: remote.stdout.trim() };
  }

  private async fetchProtectedRemoteSnapshot(
    sha: string,
    fixedPaths: readonly string[],
  ): Promise<ProtectedRemoteSnapshot> {
    return this.withGithubAppAuth((env) => materializeProtectedGitSnapshot({
      repoUrl: this.repoUrl,
      sha,
      fixedPaths,
      runGit: async (args, cwd, maxBuffer) => {
        try {
          const result = await execFile('git', args, {
            cwd,
            env,
            encoding: 'buffer',
            maxBuffer,
          });
          return Buffer.from(result.stdout as Buffer);
        } catch (error) {
          throw new Error(protectedSnapshotGitErrorCode(error));
        }
      },
    }));
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
    return result.exitCode === 0;
  }

  private async ensureAncestry(local: string, github: string): Promise<boolean | 'incomplete'> {
    const initial = await this.runGit(['merge-base', local, github]);
    if (initial.exitCode === 0) return true;
    const shallow = await this.runGit(['rev-parse', '--is-shallow-repository']);
    if (shallow.stdout.trim() !== 'true') return false;
    const step = Number(this.env.SOURCE_CONTROL_SHALLOW_DEEPEN_STEP || 50);
    const maximum = Number(this.env.SOURCE_CONTROL_SHALLOW_MAX_DEPTH || 500);
    if (!Number.isInteger(step) || step <= 0 || !Number.isInteger(maximum) || maximum <= 0) {
      throw new Error('Invalid shallow-history bounds.');
    }
    let deepened = 0;
    while (deepened < maximum) {
      const amount = Math.min(step, maximum - deepened);
      const result = await this.runGit(['fetch', '--no-tags', '--filter=blob:none', `--deepen=${amount}`, this.repoUrl, this.branch]);
      if (result.exitCode !== 0) throw new Error(`Shallow-history deepening failed: ${bounded(result.stderr || result.stdout)}`);
      deepened += amount;
      const check = await this.runGit(['merge-base', local, github]);
      if (check.exitCode === 0) return true;
    }
    return 'incomplete';
  }

  private async isTrackedTreeClean(): Promise<boolean> {
    const result = await this.runGit(['status', '--porcelain', '--untracked-files=normal']);
    return result.exitCode === 0 && result.stdout.trim() === '';
  }

  private async runGit(args: string[]): Promise<CommandResult> {
    return this.withGithubAppAuth((env) => this.runCommand('git', args, { cwd: this.rootDir, env }));
  }

  /**
   * Authenticates as the sole GitHub App installation permitted to bypass
   * branch protection on this repository, rather than a repo-wide SSH
   * deploy key. A fresh installation token (GitHub expires these within an
   * hour) is minted per call and passed via `http.extraheader` env vars so
   * it never appears in argv or on disk.
   */
  private async withGithubAppAuth<T>(operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const { token } = await this.fetchInstallationToken();
    return operation({
      ...this.commandEnv(),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encodeGithubAppGitCredential(token)}`,
    });
  }

  private async acquireLease(): Promise<{ release: () => Promise<void> } | null> {
    await mkdir(join(this.lockPath, '..'), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = this.uuid();
      const metadata = {
        token,
        pid: process.pid,
        acquiredAt: this.now().toISOString(),
        expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      };
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(metadata)}\n`);
        await handle.close();
        let released = false;
        const renew = setInterval(async () => {
          if (released) return;
          try {
            const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: string };
            if (current.token !== token) return;
            const renewed = {
              ...current,
              expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
            };
            await writeFile(this.lockPath, `${JSON.stringify(renewed)}\n`, { mode: 0o600 });
          } catch {
            // The operation will fail closed on its next Git command.
          }
        }, Math.max(1000, Math.floor(this.leaseMs / 3)));
        renew.unref();
        return {
          release: async () => {
            released = true;
            clearInterval(renew);
            try {
              const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: string };
              if (current.token === token) await rm(this.lockPath, { force: true });
            } catch {
              // A missing lock is already released.
            }
          },
        };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: number; expiresAt?: string };
          const expired = !current.expiresAt || Date.parse(current.expiresAt) <= this.now().getTime();
          if (expired && !isProcessAlive(Number(current.pid))) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {
          // A partially written lock is treated as contention, never stolen.
        }
        return null;
      }
    }
    return null;
  }

  private async writeOperation(operation: SourceControlOperation): Promise<void> {
    await mkdir(this.operationsDir, { recursive: true, mode: 0o700 });
    const path = join(this.operationsDir, `${digest(operation.operationId)}.json`);
    const temp = `${path}.${process.pid}.${this.uuid()}.tmp`;
    await writeFile(temp, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  }

  private async writeStatus(
    state: SourceControlState,
    error: string,
    actor: string,
    local?: string,
    github?: string,
    candidate?: string,
    validation?: Record<string, unknown>,
    extra: Partial<SourceControlStatus> = {},
  ): Promise<void> {
    const previous = await this.getStatus();
    // Dirty tracked/untracked files are the quietest failure mode in this
    // service: the scheduler deliberately excludes 'dirty' from its own
    // console.warn (see source-control-scheduler.ts) because a dirty tree is
    // common and often self-resolves within a poll or two. That silence can
    // let a genuinely stuck dirty tree block sync for hours with no one
    // told. Post once per dirty *episode* — on the transition into 'dirty',
    // not on every repeated poll while it remains dirty — so a human
    // actually sees it without being spammed.
    if (state === 'dirty' && previous?.state !== 'dirty') {
      void this.notifyDirtyTreeBlock(error, actor).catch((err: any) => {
        console.warn('[SourceControl] Dirty-tree notification failed:', err?.message || err);
      });
    }
    const now = this.now().toISOString();
    const ready = state === 'ready_to_promote';
    const successful = state === 'synced' || ready;
    const consecutiveFailures = successful ? 0 : (previous?.consecutiveFailures || 0) + 1;
    const lastSuccessfulSyncAt = successful ? now : previous?.lastSuccessfulSyncAt;
    // Stalled-sync alerting: a run of trouble -- dirty tree, lock
    // contention, divergence, a real Git failure, it doesn't matter which,
    // they all increment the same consecutiveFailures counter above -- stops
    // being normal transient noise once it crosses a threshold. The flags
    // below are only ever set from a CONFIRMED delivery result, never
    // optimistically before the attempt: if they were, a transient outage
    // in the very channel used to raise the alarm (the database being down
    // the moment the threshold is first crossed, say) would permanently
    // suppress the alert for the rest of the episode -- the exact silent
    // failure this exists to prevent. Both clear on the next success so a
    // future stall can alert again.
    let stalledSyncAlertActive = successful ? false : (previous?.stalledSyncAlertActive ?? false);
    let stalledSyncAlertSentAt = successful ? undefined : previous?.stalledSyncAlertSentAt;
    let stalledSyncAlertTeamRoomDeliveredAt = successful ? undefined : previous?.stalledSyncAlertTeamRoomDeliveredAt;
    const isStalled = !successful
      && isSourceControlSyncStalled(
        { consecutiveFailures, lastSuccessfulSyncAt },
        resolveSourceControlStallThresholds(this.env),
        this.now().getTime(),
      );
    // Retry every poll until BOTH channels confirm delivery, not just once
    // at the moment the threshold is first crossed, and not just for
    // whichever channel happens to be tracked first. The two channels fail
    // independently (a DB hiccup can block the founder-inbox insert while
    // Team Room succeeds, or vice versa); gating this whole block on only
    // one of them (as a `!stalledSyncAlertActive`-only check would) lets a
    // confirmed founder-inbox delivery permanently stop Team Room from ever
    // being retried again for the same stall episode. Awaited (unlike the
    // dirty-tree notice above) specifically because its outcome decides what
    // gets persisted below; it only runs while genuinely stalled -- an
    // already-degraded path -- so this extra latency never touches the
    // normal fast path.
    if (isStalled && (!stalledSyncAlertActive || !stalledSyncAlertTeamRoomDeliveredAt)) {
      const wasFounderInboxDelivered = stalledSyncAlertActive;
      const delivered = await this.notifyStalledSync(
        { state, error, consecutiveFailures, lastSuccessfulSyncAt },
        {
          teamRoomDelivered: Boolean(stalledSyncAlertTeamRoomDeliveredAt),
          founderInboxDelivered: stalledSyncAlertActive,
        },
      ).catch((err: any): StalledSyncAlertDeliveryResult => {
        console.warn('[SourceControl] Stalled-sync notification failed:', err?.message || err);
        return { teamRoomDelivered: false, founderInboxDelivered: false };
      });
      // Guarded by the pre-call snapshot (not the live variable) so a
      // channel already confirmed on a prior poll never has its sent-at
      // timestamp bumped again just because this poll re-confirmed it while
      // retrying the other, still-outstanding channel.
      if (delivered.founderInboxDelivered && !wasFounderInboxDelivered) {
        stalledSyncAlertActive = true;
        stalledSyncAlertSentAt = now;
      }
      if (delivered.teamRoomDelivered && !stalledSyncAlertTeamRoomDeliveredAt) {
        stalledSyncAlertTeamRoomDeliveredAt = now;
      }
    }
    const status: SourceControlStatus = {
      schemaVersion: 3,
      state,
      origin: actor,
      replitSha: local,
      githubSha: github,
      candidateSha: candidate ?? (ready ? local : previous?.candidateSha),
      candidatePreparedAt: ready ? now : previous?.candidatePreparedAt,
      candidateExpiresAt: ready
        ? new Date(this.now().getTime() + Number(this.env.SOURCE_BRIDGE_PROMOTION_TTL_SECONDS || 3600) * 1000).toISOString()
        : previous?.candidateExpiresAt,
      // Preserved across incidental writes the same way promotedSha is
      // (see the block below): only prepareLocked() and syncLocked()'s
      // auto-merge-and-revalidate branch ever set this explicitly via
      // `extra`, and both always set it (never leave it to inherit) so a
      // fresh candidate window is never left holding a stale tag from the
      // previous one.
      candidateSource: previous?.candidateSource,
      // Preserved across incidental writes for the same reason
      // candidateSource is: only the local-ahead push branch in
      // syncLocked() ever sets these explicitly via `extra` (moving
      // through pending -> passed/failed for each new pushed SHA), so
      // every other writeStatus call site (dirty, diverged, failed,
      // ready_to_promote, plain synced-with-nothing-to-push, ...) must
      // leave whatever the last push cycle recorded untouched rather than
      // clearing it back to undefined.
      pushValidationStatus: previous?.pushValidationStatus,
      pushValidationSha: previous?.pushValidationSha,
      pushValidationError: previous?.pushValidationError,
      pushValidationCompletedAt: previous?.pushValidationCompletedAt,
      validation: validation ?? previous?.validation,
      validationManifestVersion: typeof validation?.manifestVersion === 'number'
        ? validation.manifestVersion
        : previous?.validationManifestVersion,
      validationId: typeof validation?.validationId === 'string'
        ? validation.validationId
        : previous?.validationId,
      error: error || undefined,
      lastSuccessfulSyncAt,
      consecutiveFailures,
      lastHeartbeatAt: now,
      updatedAt: now,
      stalledSyncAlertActive,
      stalledSyncAlertSentAt,
      stalledSyncAlertTeamRoomDeliveredAt,
      // Promotion-completion evidence must survive incidental writes (a
      // later `dirty`/`failed`/plain `synced` sync) the same way candidate
      // evidence does. Otherwise a completed promotion's `promotedSha` marker
      // disappears after exactly one unrelated status write, and a later
      // sync tick can no longer tell a just-promoted candidate apart from
      // one still awaiting promotion. `extra` below still wins when a caller
      // explicitly sets or clears these fields.
      promotedSha: previous?.promotedSha,
      promotedBy: previous?.promotedBy,
      promotionRequestId: previous?.promotionRequestId,
      promotionVerificationMode: previous?.promotionVerificationMode,
      publicationReference: previous?.publicationReference,
      ...extra,
    };
    await mkdir(join(this.statusPath, '..'), { recursive: true });
    const statusTemp = `${this.statusPath}.${process.pid}.${this.uuid()}.tmp`;
    await writeFile(statusTemp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    await rename(statusTemp, this.statusPath);
    const summary = [
      '# Source-control status',
      '',
      `- Updated: ${now}`,
      `- State: **${status.state}**`,
      `- Actor: ${actor}`,
      `- Replit main: ${status.replitSha || 'unknown'}`,
      `- GitHub main: ${status.githubSha || 'unknown'}`,
      `- Candidate: ${status.candidateSha || 'none'}`,
      `- Candidate expires: ${status.candidateExpiresAt || 'not prepared'}`,
      `- Validation: ${status.validation ? JSON.stringify(status.validation) : 'not recorded'}`,
      `- Promoted commit: ${status.promotedSha || 'not recorded'}`,
      `- Error: ${status.error || 'none'}`,
      '',
      'This is local operational state. It does not publish production or change Git history.',
      '',
    ].join('\n');
    const summaryTemp = `${this.summaryPath}.${process.pid}.${this.uuid()}.tmp`;
    await writeFile(summaryTemp, summary, { mode: 0o600 });
    await rename(summaryTemp, this.summaryPath);
  }

  /** Posts a one-time Team Room notice when sync first becomes blocked by a
   * dirty tree, so the block is actually visible instead of sitting silently
   * in the status file. Fire-and-forget from the caller's side — a Team Room
   * hiccup must never affect writeStatus's own completion. */
  private async notifyDirtyTreeBlock(error: string, actor: string): Promise<void> {
    const { storage } = await import('../storage');
    const rooms = await storage.listTeamRooms(1);
    if (!rooms.length) return;
    const content = [
      '**Source-control sync blocked — dirty tracked files**',
      '',
      error,
      '',
      `Triggered by: ${actor}`,
      'The scheduler will keep retrying on its own schedule, but it cannot resolve this by itself — something needs to commit or discard the offending files.',
    ].join('\n');
    const message = await storage.createRoomMessage({ roomId: rooms[0].id, speaker: 'Luca', content });
    const { emitNewMessage } = await import('./team-room-ws-broker');
    emitNewMessage(rooms[0].id, message);
  }

  /**
   * Posts a stalled-sync alert, attempting only the channels not yet
   * confirmed delivered for the current episode (see `already`). This
   * pipeline gates every founder publish (source promotion, runtime
   * release), so a silent multi-day outage blocks all of them -- exactly
   * what happened when a 'diverged' state ran for ~2.5 days with only
   * notifyDirtyTreeBlock's narrower dirty-tree case wired up. Unlike that
   * Team-Room-only notice, this also writes a durable aldenNotifications
   * row: Team Room is ephemeral chat that requires the page to be open,
   * while aldenNotifications persists as an unread sidebar badge until
   * someone actually reads it -- the difference between "visible if you
   * happen to be looking" and "visible whenever you next look".
   *
   * Each channel has its own try/catch, so this method itself never
   * throws; the caller decides what to persist from the returned
   * per-channel result, never from the mere fact that an attempt was made.
   * That is what makes retrying safe: a channel already confirmed
   * delivered is skipped entirely (never re-posted/re-inserted), while a
   * channel whose last attempt failed stays false so the caller retries it
   * on the next poll instead of the alert being silently and permanently
   * dropped.
   */
  private async dispatchStalledSyncAlert(
    context: StalledSyncAlertContext,
    already: StalledSyncAlertDeliveryResult,
  ): Promise<StalledSyncAlertDeliveryResult> {
    const ageDescription = context.lastSuccessfulSyncAt
      ? `${Math.round((this.now().getTime() - new Date(context.lastSuccessfulSyncAt).getTime()) / 60000)} minutes since the last successful sync`
      : 'no successful sync has been recorded yet';
    const content = [
      '**Source-control sync is stalled**',
      '',
      `State: ${context.state}`,
      `Consecutive failed attempts: ${context.consecutiveFailures}`,
      `${ageDescription}.`,
      context.error ? `Last error: ${context.error}` : undefined,
      '',
      'This pipeline gates every founder publish (source promotion, runtime release). The scheduler will keep retrying on its own schedule, but it has not been able to resolve this by itself.',
    ].filter((line): line is string => typeof line === 'string').join('\n');

    let teamRoomDelivered = already.teamRoomDelivered;
    if (!teamRoomDelivered) {
      try {
        const { storage } = await import('../storage');
        const rooms = await storage.listTeamRooms(1);
        if (rooms.length) {
          const message = await storage.createRoomMessage({ roomId: rooms[0].id, speaker: 'Luca', content });
          const { emitNewMessage } = await import('./team-room-ws-broker');
          emitNewMessage(rooms[0].id, message);
          teamRoomDelivered = true;
        }
      } catch (err: any) {
        console.warn('[SourceControl] Stalled-sync Team Room notification failed:', err?.message || err);
      }
    }

    let founderInboxDelivered = already.founderInboxDelivered;
    if (!founderInboxDelivered) {
      try {
        const { getUserDb } = await import('../db');
        const { aldenNotifications } = await import('@shared/schema');
        await getUserDb().insert(aldenNotifications).values({
          content,
          triggeredBy: 'source-control',
          severity: 'alert',
          read: false,
          fingerprint: 'source_control_stalled_sync',
        });
        founderInboxDelivered = true;
      } catch (err: any) {
        console.warn('[SourceControl] Stalled-sync founder-inbox notification failed:', err?.message || err);
      }
    }

    return { teamRoomDelivered, founderInboxDelivered };
  }

  /**
   * Best-effort dual-channel notice that an explicitly-prepared candidate
   * was just replaced by an auto-validated one. Unlike
   * dispatchStalledSyncAlert, this fires once for a one-shot state
   * transition rather than an ongoing condition, so it carries no
   * cross-tick retry/dedup bookkeeping -- each channel is simply tried
   * once and its own failure logged, independent of the other.
   */
  private async dispatchCandidateSupersededAlert(context: CandidateSupersededContext): Promise<void> {
    const content = [
      '**Source-control candidate superseded by auto-sync**',
      '',
      `The explicitly validated candidate ${context.supersededCandidateSha}` +
        (context.supersededPreparedAt ? ` (prepared at ${context.supersededPreparedAt})` : '') +
        ' is no longer the ready-to-promote candidate.',
      `The sync scheduler received a new commit from GitHub, fast-forwarded onto it, and auto-validated ${context.newCandidateSha} as the new candidate.`,
      '',
      `Publishing now would build ${context.newCandidateSha}, which nobody explicitly ran \`prepare\` against. Re-run \`npm run source-control:prepare\` if you want to knowingly review and publish this new commit.`,
      '',
      `Triggered by: ${context.actor}`,
    ].join('\n');

    try {
      const { storage } = await import('../storage');
      const rooms = await storage.listTeamRooms(1);
      if (rooms.length) {
        const message = await storage.createRoomMessage({ roomId: rooms[0].id, speaker: 'Luca', content });
        const { emitNewMessage } = await import('./team-room-ws-broker');
        emitNewMessage(rooms[0].id, message);
      }
    } catch (err: any) {
      console.warn('[SourceControl] Candidate-superseded Team Room notification failed:', err?.message || err);
    }

    try {
      const { getUserDb } = await import('../db');
      const { aldenNotifications } = await import('@shared/schema');
      await getUserDb().insert(aldenNotifications).values({
        content,
        triggeredBy: 'source-control',
        severity: 'alert',
        read: false,
        fingerprint: 'source_control_candidate_superseded',
      });
    } catch (err: any) {
      console.warn('[SourceControl] Candidate-superseded founder-inbox notification failed:', err?.message || err);
    }
  }

  /**
   * Best-effort dual-channel notice that a commit already pushed to GitHub
   * main (via syncLocked()'s local-ahead fast path) failed the same
   * validation manifest a `prepare` run would have used beforehand. Fires
   * once for a one-shot state transition -- the same contract as
   * dispatchCandidateSupersededAlert -- each channel is simply tried once
   * and its own failure logged, independent of the other. This is the
   * highest-urgency of the three alert templates in this file: unlike a
   * stalled sync or a superseded candidate, the broken commit is already
   * live on the shared remote other hats pull from.
   */
  private async dispatchPushValidationFailedAlert(context: PushValidationFailedContext): Promise<void> {
    const content = [
      '**Source-control push failed post-push validation**',
      '',
      `Commit ${context.sha} was already fast-forward pushed to GitHub main, then failed validation:`,
      '',
      context.error,
      '',
      'The push is not undone and does not need to be redone -- the commit is already on the shared remote and ' +
        'other hats may already be building on it. Investigate and fix forward, then let sync/prepare confirm a ' +
        'later commit is clean.',
      '',
      `Triggered by: ${context.actor}`,
    ].join('\n');

    try {
      const { storage } = await import('../storage');
      const rooms = await storage.listTeamRooms(1);
      if (rooms.length) {
        const message = await storage.createRoomMessage({ roomId: rooms[0].id, speaker: 'Luca', content });
        const { emitNewMessage } = await import('./team-room-ws-broker');
        emitNewMessage(rooms[0].id, message);
      }
    } catch (err: any) {
      console.warn('[SourceControl] Push-validation-failed Team Room notification failed:', err?.message || err);
    }

    try {
      const { getUserDb } = await import('../db');
      const { aldenNotifications } = await import('@shared/schema');
      await getUserDb().insert(aldenNotifications).values({
        content,
        triggeredBy: 'source-control',
        severity: 'alert',
        read: false,
        fingerprint: 'source_control_push_validation_failed',
      });
    } catch (err: any) {
      console.warn('[SourceControl] Push-validation-failed founder-inbox notification failed:', err?.message || err);
    }
  }
}

/** Result of an on-demand, read-only comparison between the current exact
 * HEAD commit and the last commit an explicit `prepare` (or an
 * auto-promotion) marked `ready_to_promote`. See
 * SourceControlService.checkCandidateDrift(). */
export interface CandidateDriftReport {
  driftDetected: boolean;
  reason: CandidateDriftReason;
  state?: SourceControlState;
  candidateSha?: string;
  candidateSource?: 'auto_sync';
  candidatePreparedAt?: string;
  currentHeadSha?: string;
  message: string;
}
