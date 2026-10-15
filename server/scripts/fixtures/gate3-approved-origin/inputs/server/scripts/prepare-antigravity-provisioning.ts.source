import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTaskAgentKey } from '../services/task-ownership-key-custody';
import {
  GATE3, createPublicProvisioningBundle, type PublicProvisioningBundle,
} from '../services/antigravity-provisioning-bundle';
import {
  Gate3TaskArtifactMaterializationError,
  materializeGate3TaskArtifact,
} from '../services/gate3-task-artifact-materializer';

const execFile = promisify(nodeExecFile);
const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../templates/task-1448.md');
const FIXED_TOKEN_VARS = [
  'COORDINATION_LUCA_GEMINI_CODE_TOKEN',
  'COORDINATION_LUCA_GEMINI_TOKEN',
];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const safe = (message: unknown) => String(message).replace(/(?:cb|ct)_[A-Za-z0-9_-]+/g, '[redacted]');

export type PreparationOptions = {
  root?: string;
  startingCommit: string;
  env?: NodeJS.ProcessEnv;
  templatePath?: string;
};

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd: root, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

export async function prepareAntigravityProvisioning(options: PreparationOptions): Promise<PublicProvisioningBundle> {
  const env = options.env || process.env;
  for (const variable of FIXED_TOKEN_VARS) {
    if (Object.prototype.hasOwnProperty.call(env, variable)) throw new Error('fixed_actor_token');
  }
  const bootstrap = env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN;
  if (!bootstrap || !/^cb_[A-Za-z0-9_-]{43}$/.test(bootstrap)) throw new Error('bootstrap_format');
  if (env === process.env) delete process.env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN;

  const root = await realpath(options.root || process.cwd());
  // The production path is intentionally explicit; tests must opt into their temporary root.
  const normalizePath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (!options.root && normalizePath(root) !== normalizePath('C:\\Users\\David\\HolaHola-antigravity')) {
    throw new Error('worktree_path');
  }
  if (!/^[0-9a-f]{40,64}$/.test(options.startingCommit)) throw new Error('starting_commit');
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if ((await realpath(top)) !== root) throw new Error('worktree_root');
  const branch = await git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== GATE3.branch) throw new Error('branch');
  if ((await git(root, ['status', '--porcelain'])).length) throw new Error('dirty_worktree');
  if ((await git(root, ['rev-parse', 'HEAD'])).toLowerCase() !== options.startingCommit.toLowerCase()) throw new Error('head');
  let remoteHead: string;
  try { remoteHead = await git(root, ['rev-parse', 'origin/main']); } catch { throw new Error('remote_head'); }
  if (remoteHead.toLowerCase() !== options.startingCommit.toLowerCase()) throw new Error('remote_head');
  const worktrees = await git(root, ['worktree', 'list', '--porcelain']);
  const entry = worktrees.split(/\n\n/).find((item) => {
    const lines = item.split('\n');
    return normalizePath(lines[0]?.replace(/^worktree /, '') || '') === normalizePath(root) &&
      lines.includes(`branch refs/heads/${GATE3.branch}`);
  });
  if (!entry || !entry.split('\n').includes(`branch refs/heads/${GATE3.branch}`)) throw new Error('linked_worktree');

  let artifact: ReturnType<typeof materializeGate3TaskArtifact>;
  try {
    artifact = materializeGate3TaskArtifact(
      await readFile(options.templatePath || TEMPLATE),
      options.startingCommit.toLowerCase(),
    );
  } catch (error) {
    if (error instanceof Gate3TaskArtifactMaterializationError) {
      if (error.code === 'artifact_template_invalid') throw new Error('template_placeholder');
      if (error.code === 'artifact_line_endings_invalid') throw new Error('template_line_endings');
      throw new Error('template_invalid');
    }
    throw error;
  }
  const artifactPath = resolve(root, '.local/tasks/task-1448.md');
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, artifact.bytes, { flag: 'wx' }).catch(async (error: any) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(artifactPath);
    if (!existing.equals(Buffer.from(artifact.bytes))) throw new Error('artifact_conflict');
  });
  const key = await ensureTaskAgentKey(GATE3.taskRef);
  const bundleInput = {
    ...GATE3,
    credentialCapabilities: [...GATE3.credentialCapabilities],
    runtimeCapabilities: [...GATE3.runtimeCapabilities],
    artifactSha256: artifact.sha256,
    publicKey: key.publicKey,
    keyFingerprint: key.fingerprint,
    bootstrapSha256: sha(bootstrap),
    worktreeRealpathDigest: sha(root.replaceAll('\\', '/').toLowerCase()),
    startingCommit: options.startingCommit.toLowerCase(),
  };
  return createPublicProvisioningBundle(bundleInput);
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const startingCommit = option('--starting-commit');
  if (!startingCommit) throw new Error('missing_starting_commit');
  const bundle = await prepareAntigravityProvisioning({ startingCommit });
  process.stdout.write(`${JSON.stringify(bundle)}\n`);
}

if (process.argv[1]?.endsWith('prepare-antigravity-provisioning.ts')) {
  main().catch((error) => { process.stderr.write(`${safe(error instanceof Error ? error.message : error)}\n`); process.exitCode = 1; });
}