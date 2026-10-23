import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  resolveCoordinationTaskMetadataWithArtifact,
  DEFAULT_COORDINATION_TASK_METADATA_REGISTRY,
  CoordinationTaskMetadataError,
  type CoordinationTaskMetadataRegistry,
} from '../services/coordination-task-metadata-service';
import { buildCoordinationV2PublicConfig } from '../services/coordination-v2-public-config';
import { computeCoordinationPublicMaterialDigest } from './coordination-windows-prepare';
import { PolicyValidationError } from '../services/coordination-policy-canonicalization';

/**
 * Founder-facing offline helper: compute the exact
 * `hostConstraints.windowsPublicMaterialDigest` value for a policy before
 * submitting it for approval, instead of guessing and reading
 * `V2_PREPARATION_PUBLIC_DIGEST_MISMATCH` off server logs.
 *
 * This reuses the *same* public-config hashing
 * (`buildCoordinationV2PublicConfig` + `computeCoordinationPublicMaterialDigest`)
 * that `issueCoordinationV2PreparationEnvelope` applies at preparation time.
 * The task artifact itself is resolved locally via the default,
 * filesystem+git registry (`resolveCoordinationTaskMetadataWithArtifact` with
 * `DEFAULT_COORDINATION_TASK_METADATA_REGISTRY` -- no database) -- the same
 * bytes `coordination-v2-publish-task-artifact.ts` reads to publish into the
 * shared database. A production launch resolves the task artifact from that
 * published Postgres row instead of this local file (see
 * `coordination-task-metadata-postgres-registry.ts`), so the digest printed
 * here is exactly the value the server will require *provided the task
 * artifact has already been published with these same bytes* -- publish
 * first (or republish after editing the task file) if you want this digest
 * to match what production actually enforces.
 *
 * `promotedCommitSha` and `exactTreeSha` identify the published source
 * promotion (`coordinationV2SourcePromotions`, state `published`) this policy
 * will run against. They are not derivable from a local checkout alone, so
 * they remain required, explicit inputs here.
 */

const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const TREE_SHA = /^[0-9a-f]{40}$/;
const TASK_REF = /^[1-9][0-9]*$/;

export type CoordinationV2DigestCliFormat = 'text' | 'json';

export type CoordinationV2DigestCliInput = Readonly<{
  taskRef: string;
  promotedCommitSha: string;
  exactTreeSha: string;
  policyPath: string;
  format: CoordinationV2DigestCliFormat;
}>;

export class CoordinationV2DigestCliUsageError extends Error {}

const OPTION_NAMES = ['task-ref', 'promoted-commit-sha', 'exact-tree-sha', 'policy', 'format'] as const;
type OptionName = (typeof OPTION_NAMES)[number];
const SAFE_FORMATS = new Set<CoordinationV2DigestCliFormat>(['text', 'json']);

export function parseCoordinationV2DigestCliArgs(args: readonly string[]): CoordinationV2DigestCliInput {
  const values: Partial<Record<OptionName, string>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new CoordinationV2DigestCliUsageError(`unsupported_option:${token}`);
    const name = token.slice(2) as OptionName;
    if (!(OPTION_NAMES as readonly string[]).includes(name)) {
      throw new CoordinationV2DigestCliUsageError(`unsupported_option:${name}`);
    }
    if (values[name] !== undefined) throw new CoordinationV2DigestCliUsageError(`duplicate_option:${name}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new CoordinationV2DigestCliUsageError(`missing_value:${name}`);
    values[name] = value;
  }
  const taskRef = values['task-ref'];
  if (!taskRef || !TASK_REF.test(taskRef)) throw new CoordinationV2DigestCliUsageError('task_ref_required');
  const promotedCommitSha = values['promoted-commit-sha'];
  if (!promotedCommitSha || !COMMIT_SHA.test(promotedCommitSha)) {
    throw new CoordinationV2DigestCliUsageError('promoted_commit_sha_required');
  }
  const exactTreeSha = values['exact-tree-sha'];
  if (!exactTreeSha || !TREE_SHA.test(exactTreeSha)) {
    throw new CoordinationV2DigestCliUsageError('exact_tree_sha_required');
  }
  const policyPath = values.policy;
  if (!policyPath) throw new CoordinationV2DigestCliUsageError('policy_required');
  const format = (values.format ?? 'text') as CoordinationV2DigestCliFormat;
  if (!SAFE_FORMATS.has(format)) throw new CoordinationV2DigestCliUsageError(`invalid_format:${format}`);
  return Object.freeze({ taskRef, promotedCommitSha, exactTreeSha, policyPath, format });
}

export type CoordinationV2DigestCliResult = Readonly<{
  windowsPublicMaterialDigest: string;
  repositoryIdentity: string;
  promotedCommitSha: string;
  exactTreeSha: string;
  taskRef: string;
  taskArtifactSha256: string;
  policyDigestAsGiven: string;
}>;

/**
 * Core computation, independent of argv/file-IO framing so it can be unit
 * tested with a fake registry and an in-memory policy object.
 */
export async function computeCoordinationV2PublicMaterialDigestForPolicy(
  input: {
    taskRef: string;
    promotedCommitSha: string;
    exactTreeSha: string;
    policy: Record<string, unknown>;
  },
  registry: CoordinationTaskMetadataRegistry = DEFAULT_COORDINATION_TASK_METADATA_REGISTRY,
): Promise<CoordinationV2DigestCliResult> {
  const { metadata, artifact } = await resolveCoordinationTaskMetadataWithArtifact(input.taskRef, registry);
  const materialConfig = buildCoordinationV2PublicConfig({
    repositoryIdentity: metadata.repositoryIdentity,
    promotedCommitSha: input.promotedCommitSha,
    exactTreeSha: input.exactTreeSha,
    policy: input.policy,
  });
  const windowsPublicMaterialDigest = computeCoordinationPublicMaterialDigest({
    'task-artifact': artifact,
    'coordinator-config.json': materialConfig.config,
  });
  return Object.freeze({
    windowsPublicMaterialDigest,
    repositoryIdentity: metadata.repositoryIdentity,
    promotedCommitSha: input.promotedCommitSha,
    exactTreeSha: input.exactTreeSha,
    taskRef: metadata.taskRef,
    taskArtifactSha256: metadata.taskArtifactSha256,
    policyDigestAsGiven: materialConfig.policyDigest,
  });
}

async function readPolicyFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(resolve(path), 'utf8');
  } catch {
    throw new CoordinationV2DigestCliUsageError(`policy_file_unreadable:${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CoordinationV2DigestCliUsageError(`policy_file_invalid_json:${path}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoordinationV2DigestCliUsageError(`policy_file_not_object:${path}`);
  }
  return parsed as Record<string, unknown>;
}

export async function runCoordinationV2DigestCli(
  args: readonly string[],
  registry: CoordinationTaskMetadataRegistry = DEFAULT_COORDINATION_TASK_METADATA_REGISTRY,
): Promise<{ format: CoordinationV2DigestCliFormat; result: CoordinationV2DigestCliResult }> {
  const parsed = parseCoordinationV2DigestCliArgs(args);
  const policy = await readPolicyFile(parsed.policyPath);
  const result = await computeCoordinationV2PublicMaterialDigestForPolicy({
    taskRef: parsed.taskRef,
    promotedCommitSha: parsed.promotedCommitSha,
    exactTreeSha: parsed.exactTreeSha,
    policy,
  }, registry);
  return { format: parsed.format, result };
}

function writeResult(format: CoordinationV2DigestCliFormat, result: CoordinationV2DigestCliResult): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write([
    `windowsPublicMaterialDigest: ${result.windowsPublicMaterialDigest}`,
    '',
    `  repositoryIdentity (resolved from local git): ${result.repositoryIdentity}`,
    `  taskRef:                                      ${result.taskRef}`,
    `  taskArtifactSha256:                            ${result.taskArtifactSha256}`,
    `  promotedCommitSha (as given):                  ${result.promotedCommitSha}`,
    `  exactTreeSha (as given):                       ${result.exactTreeSha}`,
    `  policyDigest of the policy file as given:      ${result.policyDigestAsGiven}`,
    '    (informational only -- this reflects whatever value the policy file',
    '     already had at hostConstraints.windowsPublicMaterialDigest, not the',
    '     digest above; createPolicyDraft recomputes its own policyDigest',
    '     once you submit the corrected policy.)',
    '',
    'Pin windowsPublicMaterialDigest above into hostConstraints before authoring the policy.',
  ].join('\n') + '\n');
}

export const HELP_TEXT = `Compute the real windowsPublicMaterialDigest for a Coordinator V2 policy.

Usage:
  npx tsx server/scripts/coordination-v2-public-material-digest.ts \\
    --task-ref <task reference> \\
    --promoted-commit-sha <40-hex commit sha> \\
    --exact-tree-sha <40-hex tree sha> \\
    --policy <path to policy JSON file> \\
    [--format text|json]

What this does:
  Reuses the exact public-config hashing that
  issueCoordinationV2PreparationEnvelope applies at preparation time
  (coordination-v2-public-config.ts + coordination-windows-prepare.ts). No
  database connection is used: the task artifact is read from your local
  .local/tasks/task-<ref>.md, the same bytes
  coordination-v2-publish-task-artifact.ts publishes into the shared
  database for production to read from. The digest printed here is exactly
  the value the server will require provided that file has already been
  published with these bytes -- publish (or republish after editing the
  task file) before relying on this digest, or production will enforce
  whatever it last published instead.

Options:
  --task-ref             Task reference whose .local/tasks/task-<ref>.md
                          bytes are the task artifact. Resolved locally via
                          the filesystem+git registry: the local git checkout
                          must be clean and its origin remote must match the
                          configured GITHUB_REPO_URL.
  --promoted-commit-sha   The commit sha of the published source promotion
                          (coordinationV2SourcePromotions, state "published")
                          this policy will run against. Not derivable from a
                          local checkout alone -- supply it explicitly.
  --exact-tree-sha        The tree sha of that same published promotion.
  --policy                Path to a JSON file with the policy document you
                          intend to submit to createPolicyDraft. Any value
                          (or no value) already present at
                          hostConstraints.windowsPublicMaterialDigest is
                          ignored -- it is stripped before hashing, so you
                          never need to guess it first.
  --format                "text" (default) or "json".
  --help, -h              Show this text.

End-to-end sequence:
  1. Compute -- run this command with the digest placeholder removed (or left
     as any placeholder value); it prints the real windowsPublicMaterialDigest.
  2. Author -- put that value in hostConstraints.windowsPublicMaterialDigest
     and submit the policy with createPolicyDraft.
  3. Approve -- a founder approves the exact policy version.
  4. Grant -- issue an operator grant for that approved policy so an operator
     can launch a session against it.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = args.length === 0 ? 64 : 0;
    return;
  }
  try {
    const { format, result } = await runCoordinationV2DigestCli(args);
    writeResult(format, result);
  } catch (error) {
    if (error instanceof CoordinationV2DigestCliUsageError) {
      process.stderr.write(`${error.message}\n\n${HELP_TEXT}`);
      process.exitCode = 64;
      return;
    }
    if (error instanceof CoordinationTaskMetadataError || error instanceof PolicyValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 65;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliInvocation('coordination-v2-public-material-digest.ts')) {
  main();
}
