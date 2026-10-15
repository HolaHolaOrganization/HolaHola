import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type TaskOwnershipState = 'main_session' | 'isolated_agent' | 'unknown_stop';
export type CheckoutKind = 'primary_worktree' | 'linked_worktree' | 'not_a_git_worktree' | 'malformed_git_metadata';

export interface TaskOwnershipEvidence {
  taskRef: string;
  taskArtifact: {
    path: string;
    exists: boolean;
    regularFile: boolean;
    sha256?: string;
    size?: number;
  };
  checkout: {
    kind: CheckoutKind;
    gitMetadataPath: string;
  };
  verifiedActiveMainReceipt: boolean;
  /** A server-verified, fresh proof for the founder-attested receipt. */
  verifiedActiveIsolatedProof?: boolean;
  /** Compatibility name for callers that inject a verified receipt result. */
  verifiedActiveIsolatedReceipt?: boolean;
}

export interface TaskOwnershipResult {
  ok: boolean;
  state: TaskOwnershipState;
  taskRef: string;
  evidence: TaskOwnershipEvidence;
  contradictions: string[];
  explanation: string;
}

export interface TaskOwnershipServiceOptions {
  rootDir?: string;
  verifyActiveMainReceipt?: (taskRef: string) => Promise<boolean>;
  verifyActiveIsolatedProof?: (taskRef: string, artifactSha256?: string) => Promise<boolean>;
  verifyActiveIsolatedReceipt?: (taskRef: string, artifactSha256?: string) => Promise<boolean>;
}

const TASK_REF = /^[1-9][0-9]*$/;
const MAX_TASK_ARTIFACT_BYTES = 256 * 1024;

/**
 * Reads whether `rootDir` is the primary Git checkout or a linked worktree,
 * without requiring a task ref. Exported standalone (not just the
 * `TaskOwnershipService.probe()` path) because some callers need to
 * distinguish "am I the primary checkout" before they even have a task ref
 * to probe with -- see server/scripts/source-control-cli.ts's conditional
 * gate on `sync`, which lets the already-trusted primary-worktree caller
 * (Alden Build Guardian, `npm run source-control:sync`) through unchanged
 * while requiring a proven task ref from any other checkout.
 *
 * This is a much weaker signal than a verified ownership receipt --
 * `.git` file contents are local and not tamper-proof -- but it costs
 * nothing to check and closes the realistic case this project's task
 * ownership model targets (a task continuing work it should have stopped),
 * not a fully adversarial sandbox escape.
 */
export async function readCheckoutKind(rootDir: string): Promise<CheckoutKind> {
  const gitMetadataPath = join(rootDir, '.git');
  try {
    const info = await lstat(gitMetadataPath);
    if (info.isDirectory()) return 'primary_worktree';
    if (!info.isFile()) return 'malformed_git_metadata';
    const content = await readFile(gitMetadataPath, 'utf8');
    return /^gitdir:\s+\S+/m.test(content) ? 'linked_worktree' : 'malformed_git_metadata';
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'not_a_git_worktree';
    throw error;
  }
}

/** Canonical JSON used by the challenge/proof protocol. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('Canonical JSON cannot contain undefined.');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function classifyTaskOwnership(evidence: TaskOwnershipEvidence): TaskOwnershipResult {
  const contradictions: string[] = [];
  const artifactValid = evidence.taskArtifact.exists
    && evidence.taskArtifact.regularFile
    && /^[a-f0-9]{64}$/.test(evidence.taskArtifact.sha256 || '');

  if (evidence.taskArtifact.exists && !evidence.taskArtifact.regularFile) {
    contradictions.push('The exact task artifact exists but is not a regular file.');
  }
  if (evidence.verifiedActiveMainReceipt && evidence.checkout.kind !== 'primary_worktree') {
    contradictions.push('Verified main-session evidence conflicts with the current checkout.');
  }
  const isolatedVerified = evidence.verifiedActiveIsolatedProof === true
    || evidence.verifiedActiveIsolatedReceipt === true;
  if (evidence.verifiedActiveMainReceipt && isolatedVerified) {
    contradictions.push('Verified main-session and isolated-agent evidence conflict.');
  }

  if (
    contradictions.length === 0
    && artifactValid
    && evidence.verifiedActiveMainReceipt
    && evidence.checkout.kind === 'primary_worktree'
  ) {
    return {
      ok: true,
      state: 'main_session',
      taskRef: evidence.taskRef,
      evidence,
      contradictions,
      explanation: 'A verified active main-session receipt and the exact task artifact agree.',
    };
  }

  if (
    contradictions.length === 0
    && artifactValid
    && !evidence.verifiedActiveMainReceipt
    && isolatedVerified
  ) {
    return {
      ok: true,
      state: 'isolated_agent',
      taskRef: evidence.taskRef,
      evidence,
      contradictions,
      explanation: 'The exact task artifact and a fresh founder-attested key proof agree.',
    };
  }

  const explanation = evidence.checkout.kind === 'primary_worktree' && artifactValid
    ? 'A historical task artifact in the primary worktree does not prove current ownership.'
    : contradictions[0] || 'Current task ownership cannot be proven from local workspace evidence.';
  return {
    ok: false,
    state: 'unknown_stop',
    taskRef: evidence.taskRef,
    evidence,
    contradictions,
    explanation,
  };
}

export class TaskOwnershipService {
  private readonly rootDir: string;
  private readonly verifyActiveMainReceipt: (taskRef: string) => Promise<boolean>;
  private readonly verifyActiveIsolatedProof: (taskRef: string, artifactSha256?: string) => Promise<boolean>;

  constructor(options: TaskOwnershipServiceOptions = {}) {
    this.rootDir = resolve(options.rootDir || process.cwd());
    this.verifyActiveMainReceipt = options.verifyActiveMainReceipt || (async () => false);
    this.verifyActiveIsolatedProof = options.verifyActiveIsolatedProof
      || options.verifyActiveIsolatedReceipt
      || (async () => false);
  }

  async probe(taskRef: string): Promise<TaskOwnershipResult> {
    if (!TASK_REF.test(taskRef)) {
      throw new Error('Task ref must be positive decimal digits.');
    }
    const evidence: TaskOwnershipEvidence = {
      taskRef,
      taskArtifact: await this.readTaskArtifact(taskRef),
      checkout: await this.readCheckout(),
      verifiedActiveMainReceipt: await this.verifyActiveMainReceipt(taskRef),
      verifiedActiveIsolatedProof: false,
      verifiedActiveIsolatedReceipt: false,
    };
    evidence.verifiedActiveIsolatedProof = await this.verifyActiveIsolatedProof(
      taskRef,
      evidence.taskArtifact.sha256,
    );
    evidence.verifiedActiveIsolatedReceipt = evidence.verifiedActiveIsolatedProof;
    return classifyTaskOwnership(evidence);
  }

  private async readTaskArtifact(taskRef: string): Promise<TaskOwnershipEvidence['taskArtifact']> {
    const path = join(this.rootDir, '.local', 'tasks', `task-${taskRef}.md`);
    try {
      const info = await lstat(path);
      if (!info.isFile()) return { path, exists: true, regularFile: false };
      if (info.size > MAX_TASK_ARTIFACT_BYTES) {
        return { path, exists: true, regularFile: false, size: info.size };
      }
      const bytes = await readFile(path);
      return {
        path,
        exists: true,
        regularFile: true,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { path, exists: false, regularFile: false };
      throw error;
    }
  }

  private async readCheckout(): Promise<TaskOwnershipEvidence['checkout']> {
    const gitMetadataPath = join(this.rootDir, '.git');
    return { kind: await readCheckoutKind(this.rootDir), gitMetadataPath };
  }
}