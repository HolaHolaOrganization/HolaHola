/**
 * Shared Neon branch lifecycle tool — the one place every interface (Claude
 * Code, Replit, Cursor, Antigravity, or a human) creates/uses/deletes Neon
 * branches, so the procedure is identical everywhere instead of each tool
 * growing its own habit. Design: docs/superpowers/specs/2026-08-30-neon-branch-migration-workflow-design.md
 *
 * Subcommands:
 *   create <name> [--parent <name|id>] [--expires-at <duration|ISO>] [--schema-only] --task-ref <ref>
 *   connection-string <name|id> [--pooled]
 *   list
 *   delete <name|id> [--hard] --task-ref <ref>
 *   gate [--expires-at <duration|ISO>] [--keep-on-failure]
 *
 * `create` and `delete` mutate billed Neon infrastructure on behalf of a
 * task, so each requires --task-ref and is refused (no Neon API call
 * attempted) when ownership cannot be proven (see
 * server/services/infra-mutation-guard.ts).
 *
 * `gate` is deliberately NOT gated the same way. Its only sanctioned real
 * trigger is `scripts/cross-tool-promote.ts push` (via
 * .github/workflows/cross-tool-promote.yml running `npm run db:branch --
 * gate`), which is itself already gated by
 * `dispatchCrossToolPromote`/`assertOwnershipForInfraMutation` before the
 * workflow is ever dispatched. A GitHub Actions checkout has no
 * `.local/tasks/task-*.md` file (that directory is gitignored and never
 * committed), so requiring --task-ref on `gate` itself would make every
 * real CI invocation fail closed unconditionally, not just unauthorized
 * ones -- discovered as a code-review finding on task #1470, 2026-09-19.
 * The branch `gate` creates is also short-lived (default 6h expiry,
 * self-deleted on both pass and fail), unlike `create`'s longer-lived
 * branches, so the residual risk of an unsanctioned direct local `gate`
 * invocation is bounded.
 *
 * Talks to the Neon Management API directly (not the `neon` CLI) so it has
 * nothing to install across Windows, Codespace Linux, and Replit's container
 * alike — same reasoning that already led scripts/neon-schema-push.ts to call
 * @neondatabase/serverless directly instead of wrapping a CLI.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertOwnershipForInfraMutation, type OwnershipProbe } from '../server/services/infra-mutation-guard';

// Replit/Codespace inject secrets directly into the process environment, no
// .env file involved. A local checkout (this repo's own convention, see
// .env.template) needs one loaded explicitly. loadEnvFile never overrides a
// variable that's already set, so this is a safe no-op wherever ambient env
// vars are already present.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const API_BASE = 'https://console.neon.tech/api/v2';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} — add it to .env (see .env.template) before running scripts/neon-branch.ts`);
  }
  return value;
}

function assertCoordinatorV2DatabaseGateGuard(): void {
  const source = readFileSync('server/scripts/test-coordination-transport-lease.test.ts', 'utf8');
  const runtimeBootstrapSource = readFileSync(
    'server/scripts/test-coordination-v2-runtime-bootstrap-postgres.test.ts',
    'utf8',
  );
  const hostReauthorizationSource = readFileSync(
    'server/scripts/test-coordinator-v2-host-reauthorization-postgres.test.ts',
    'utf8',
  );
  const requiredGuard = "COORDINATOR_V2_REQUIRE_DATABASE_TESTS === '1'";
  const forbiddenProof = 'COORDINATOR_V2_FORBIDDEN_SHARED_URL';
  const skipPath = "context.skip('run through the Neon migration gate')";
  if (!source.includes(requiredGuard) || !source.includes(forbiddenProof) || !source.includes(skipPath)) {
    throw new Error('Coordinator V2 transport test is missing the disposable-gate hard-fail guard');
  }
  if (!runtimeBootstrapSource.includes('COORDINATOR_V2_REQUIRE_DATABASE_TESTS')
    || !runtimeBootstrapSource.includes('=== "1"')
    || !runtimeBootstrapSource.includes(forbiddenProof)
    || !runtimeBootstrapSource.includes('run through the Neon migration gate')) {
    throw new Error('Coordinator V2 runtime-bootstrap test is missing the disposable-gate hard-fail guard');
  }
  if (!hostReauthorizationSource.includes('COORDINATOR_V2_REQUIRE_DATABASE_TESTS')
    || !hostReauthorizationSource.includes('=== "1"')
    || !hostReauthorizationSource.includes(forbiddenProof)
    || !hostReauthorizationSource.includes('run through the Neon migration gate')) {
    throw new Error('Coordinator V2 host-reauthorization test is missing the disposable-gate hard-fail guard');
  }
}

// The database and role names are never assumed. A past incident (see the
// Claude Code test environment design doc) had a generated connection string
// silently point at the wrong database within the right branch. Every
// connection string this tool hands out is resolved from the branch's own
// database list, matched against the real app database name — never guessed.
function appDatabaseName(): string {
  const sharedUrl = requireEnv('NEON_SHARED_DATABASE_URL');
  const parsed = new URL(sharedUrl);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) {
    throw new Error(`Could not parse a database name out of NEON_SHARED_DATABASE_URL (${sharedUrl})`);
  }
  return name;
}

async function neonApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = requireEnv('NEON_API_KEY');
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Neon API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string;
  default: boolean;
  protected: boolean;
  current_state: 'init' | 'creating' | 'ready' | 'archived' | string;
  init_source?: string;
  expires_at?: string;
}

interface NeonDatabase {
  id: number;
  name: string;
  owner_name: string;
  branch_id: string;
}

export async function listBranches(): Promise<NeonBranch[]> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const data = await neonApi<{ branches: NeonBranch[]; pagination?: { next?: unknown } }>(`/projects/${projectId}/branches`);
  if (data.pagination?.next != null && data.pagination.next !== '') {
    throw new Error('Incomplete Neon branch listing; refusing absence or identity inference');
  }
  return data.branches;
}

export async function resolveBranch(nameOrId: string): Promise<NeonBranch> {
  const branches = await listBranches();
  const byId = branches.find((b) => b.id === nameOrId);
  if (byId) return byId;
  const byName = branches.find((b) => b.name === nameOrId);
  if (byName) return byName;
  throw new Error(`No branch found matching "${nameOrId}"`);
}

async function resolveParentBranchId(nameOrId: string): Promise<string> {
  const branches = await listBranches();
  const byId = branches.find((b) => b.id === nameOrId);
  if (byId) return byId.id;
  const byName = branches.find((b) => b.name === nameOrId);
  if (byName) return byName.id;
  if (nameOrId === 'production') {
    const def = branches.find((b) => b.default);
    if (def) return def.id;
  }
  throw new Error(`No parent branch found matching "${nameOrId}"`);
}

function parseExpiresAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const shorthand = /^(\d+)(m|h|d)$/.exec(value);
  if (!shorthand) {
    // Assume it's already an ISO 8601 timestamp; let the API reject it if not.
    return value;
  }
  const amount = Number(shorthand[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[shorthand[2] as 'm' | 'h' | 'd'];
  return new Date(Date.now() + amount * unitMs).toISOString();
}

async function waitUntilReady(branchId: string, timeoutMs = 60_000): Promise<void> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { branch } = await neonApi<{ branch: NeonBranch }>(`/projects/${projectId}/branches/${branchId}`);
    if (branch.current_state === 'ready') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Branch ${branchId} did not become ready within ${timeoutMs}ms`);
}

async function resolveDatabaseAndRole(branchId: string): Promise<{ database: string; role: string }> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const target = appDatabaseName();
  const { databases } = await neonApi<{ databases: NeonDatabase[] }>(
    `/projects/${projectId}/branches/${branchId}/databases`,
  );
  const match = databases.find((db) => db.name === target);
  if (!match) {
    throw new Error(
      `Branch ${branchId} has no database named "${target}" (found: ${databases.map((d) => d.name).join(', ') || 'none'}) — refusing to guess`,
    );
  }
  return { database: match.name, role: match.owner_name };
}

export async function fetchConnectionUri(branchId: string, pooled: boolean): Promise<string> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const { database, role } = await resolveDatabaseAndRole(branchId);
  const params = new URLSearchParams({
    database_name: database,
    role_name: role,
    branch_id: branchId,
    pooled: String(pooled),
  });
  const { uri } = await neonApi<{ uri: string }>(`/projects/${projectId}/connection_uri?${params}`);
  return uri;
}

interface CreateBranchOpts {
  name: string;
  parent: string;
  expiresAt?: string;
  schemaOnly: boolean;
  /** Durable cleanup bookkeeping before readiness polling can fail. */
  onCreated?: (branch: NeonBranch) => Promise<void>;
}
export async function createBranch(opts: CreateBranchOpts & {
  taskRef: string;
  probeOwnership?: OwnershipProbe;
}): Promise<NeonBranch> {
  // Same fail-closed gate as the Cloudflare DNS path: refuse to create a
  // Neon branch (a real, billed, credentialed mutation against the Neon
  // control plane) unless task ownership can be proven. See
  // server/services/infra-mutation-guard.ts and
  // .agents/memory/task-ownership-guard-scope.md.
  await assertOwnershipForInfraMutation(
    opts.taskRef,
    `neon:create_branch:${opts.name}`,
    opts.probeOwnership,
  );
  return createBranchCore(opts);
}

/**
 * Unguarded Neon API call for deleting a branch by its already-resolved ID.
 * Not exported -- every real caller outside this module must go through
 * `deleteBranch` or `deleteBranchByNameOrId`, both of which add the
 * ownership gate. The one exception inside this module is `cmdGate`'s own
 * disposable migration-test branch; see the module header comment for why.
 */
async function deleteBranchCore(branchId: string, hard: boolean): Promise<void> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const params = hard ? '?hard_delete=true' : '';
  await neonApi(`/projects/${projectId}/branches/${branchId}${params}`, { method: 'DELETE' });
}
export async function deleteBranch(
  branchId: string,
  hard: boolean,
  taskRef: string,
  probeOwnership?: OwnershipProbe,
): Promise<void> {
  await assertOwnershipForInfraMutation(taskRef, `neon:delete_branch:${branchId}`, probeOwnership);
  await deleteBranchCore(branchId, hard);
}

/**
 * CLI entry point for `delete <name|id>`. Resolving a name to a branch ID is
 * itself a Neon API call (a list/GET) -- ownership must be proven before
 * that lookup runs too, not just before the final DELETE, or an
 * `unknown_stop` task could still cause a credentialed request against the
 * Neon control plane. (Fixed as part of task #1470's review: the original
 * `cmdDelete` called `resolveBranch` before the gate in `deleteBranch` ever
 * ran.)
 */
export async function deleteBranchByNameOrId(
  nameOrId: string,
  hard: boolean,
  taskRef: string,
  probeOwnership?: OwnershipProbe,
): Promise<NeonBranch> {
  await assertOwnershipForInfraMutation(taskRef, `neon:delete_branch:${nameOrId}`, probeOwnership);
  const branch = await resolveBranch(nameOrId);
  if (branch.default) {
    throw new Error(`Refusing to delete "${branch.name}" — it is the project's default branch`);
  }
  if (branch.protected) {
    throw new Error(`Refusing to delete "${branch.name}" — it is marked protected in Neon`);
  }
  await deleteBranchCore(branch.id, hard);
  return branch;
}
/**
 * `create` and `delete` must attribute their mutation to a task so
 * `assertOwnershipForInfraMutation` can verify it before touching the Neon
 * API. `gate` does not use this -- see the module header comment.
 */
export function requireTaskRef(flags: Record<string, string | boolean>): string {
  const taskRef = flags['task-ref'];
  if (!taskRef || typeof taskRef !== 'string') {
    throw new Error(
      'Missing --task-ref <ref> -- required so the ownership guard can verify this Neon branch '
      + 'mutation is authorized (see server/services/infra-mutation-guard.ts).',
    );
  }
  return taskRef;
}
function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env,
    });
    child.on('error', () => resolve({ code: 1 }));
    child.on('close', (code) => resolve({ code }));
  });
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=');
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function cmdCreate(positional: string[], flags: Record<string, string | boolean>) {
  const name = positional[0] ?? flags.name;
  if (!name || typeof name !== 'string') {
    throw new Error('Usage: neon-branch.ts create <name> [--parent <name|id>] [--expires-at <duration>] [--schema-only] --task-ref <ref>');
  }
  const taskRef = requireTaskRef(flags);
  const parent = (flags.parent as string) ?? 'production';
  const expiresAt = parseExpiresAt((flags['expires-at'] as string) ?? '14d');
  const branch = await createBranch({ name, parent, expiresAt, schemaOnly: Boolean(flags['schema-only']), taskRef });
  const pooled = await fetchConnectionUri(branch.id, true);
  const direct = await fetchConnectionUri(branch.id, false);
  console.log(`Created branch "${branch.name}" (${branch.id}), expires ${expiresAt ?? 'never'}`);
  console.log(`Pooled connection string (general app/dev-server use):\n  ${pooled}`);
  console.log(`Direct connection string (migrations, drizzle-kit):\n  ${direct}`);
  console.log(`\nPoint your environment's NEON_SHARED_DATABASE_URL at the pooled string above to use this branch.`);
  console.log(`Delete it when done: npx tsx scripts/neon-branch.ts delete ${branch.name} --task-ref ${taskRef}`);
}

async function cmdConnectionString(positional: string[], flags: Record<string, string | boolean>) {
  const nameOrId = positional[0];
  if (!nameOrId) {
    throw new Error('Usage: neon-branch.ts connection-string <name|id> [--pooled]');
  }
  const branch = await resolveBranch(nameOrId);
  const uri = await fetchConnectionUri(branch.id, Boolean(flags.pooled));
  console.log(uri);
}

async function cmdList() {
  const branches = await listBranches();
  for (const b of branches) {
    console.log(`${b.default ? '*' : ' '} ${b.name}\t${b.id}\t${b.current_state}${b.protected ? '\t[protected]' : ''}`);
  }
}

async function cmdDelete(positional: string[], flags: Record<string, string | boolean>) {
  const nameOrId = positional[0];
  if (!nameOrId) {
    throw new Error('Usage: neon-branch.ts delete <name|id> [--hard] --task-ref <ref>');
  }
  const taskRef = requireTaskRef(flags);
  const branch = await deleteBranchByNameOrId(nameOrId, Boolean(flags.hard), taskRef);
  console.log(`Deleted branch "${branch.name}" (${branch.id})`);
}

// Flow B: prove a pending drizzle migration on a disposable branch before it
// ever reaches NEON_SHARED_DATABASE_URL. Always deletes the branch itself on
// both pass and fail — nothing ephemeral survives past this run except
// through the --expires-at backstop, in case the process is killed mid-way.
async function cmdGate(flags: Record<string, string | boolean>) {
  assertCoordinatorV2DatabaseGateGuard();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `test/migration-${timestamp}`;
  const expiresAt = parseExpiresAt((flags['expires-at'] as string) ?? '6h');

  console.log(`[gate] Creating branch "${branchName}" from production...`);
  // Not routed through the task-ownership gate -- see the module header
  // comment for why `gate`'s own disposable branch is excluded.
  const branch = await createBranchCore({ name: branchName, parent: 'production', expiresAt, schemaOnly: false });
  const directUrl = await fetchConnectionUri(branch.id, false);

  // Deliberately never printed: unlike create/connection-string, this
  // command's stdout can end up in CI/agent logs. The child processes below
  // only ever see the URL via their own env, never via a logged argument.
  const branchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEON_SHARED_DATABASE_URL: directUrl,
    COORDINATION_INBOX_DISPOSABLE_BRANCH_ID: branch.id,
    COORDINATION_RUNTIME_TEST_DATABASE_URL: directUrl,
    COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE: '1',
    COORDINATION_RUNTIME_REQUIRE_DATABASE_TESTS: '1',
    COORDINATION_RUNTIME_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    FOUNDER_TASK_OWNERSHIP_TEST_DATABASE_URL: directUrl,
    FOUNDER_TASK_OWNERSHIP_TEST_DATABASE_DISPOSABLE: '1',
    FOUNDER_TASK_OWNERSHIP_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    FOUNDER_TASK_OWNERSHIP_REQUIRE_DATABASE_TESTS: '1',
    COORDINATOR_V2_TEST_DATABASE_URL: directUrl,
    COORDINATOR_V2_TEST_DATABASE_DISPOSABLE: '1',
    COORDINATOR_V2_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    COORDINATOR_V2_REQUIRE_DATABASE_TESTS: '1',
    RELEASE_CUTOVER_ATTESTATION_TEST_DATABASE_URL: directUrl,
    RELEASE_CUTOVER_ATTESTATION_TEST_DATABASE_DISPOSABLE: '1',
    RELEASE_CUTOVER_ATTESTATION_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    RELEASE_CUTOVER_ATTESTATION_REQUIRE_DATABASE_TESTS: '1',
    AGENT_MEMORY_TEST_DATABASE_URL: directUrl,
    AGENT_MEMORY_TEST_DATABASE_DISPOSABLE: '1',
    AGENT_MEMORY_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    AGENT_MEMORY_REQUIRE_DATABASE_TESTS: '1',
    SHARED_SPEC_TEST_DATABASE_URL: directUrl,
    SHARED_SPEC_TEST_DATABASE_DISPOSABLE: '1',
    SHARED_SPEC_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    SHARED_SPEC_REQUIRE_DATABASE_TESTS: '1',
    ALDEN_SHARED_SPEC_REVIEW_TEST_DATABASE_URL: directUrl,
    ALDEN_SHARED_SPEC_REVIEW_TEST_DATABASE_DISPOSABLE: '1',
    ALDEN_SHARED_SPEC_REVIEW_FORBIDDEN_SHARED_URL: process.env.NEON_SHARED_DATABASE_URL,
    ALDEN_SHARED_SPEC_REVIEW_REQUIRE_DATABASE_TESTS: '1',
  };
  // Never inherit CI=true here — run-ci-test-steps.mjs requires
  // CI_DATABASE_URL to be a localhost Postgres service when CI is true, and
  // this branch's URL is intentionally a real Neon host, not that service.
  delete branchEnv.CI;

  let failureReason: string | null = null;

  console.log('[gate] Applying migration to the branch...');
  const migrate = await runCommand('npx drizzle-kit migrate', branchEnv);
  if (migrate.code !== 0) {
    failureReason = `drizzle-kit migrate exited ${migrate.code}`;
  }

  if (!failureReason) {
    console.log('[gate] Running data-ops scripts against the branch...');
    const dataOps = await runCommand('npx tsx scripts/run-data-ops.ts', branchEnv);
    if (dataOps.code !== 0) {
      failureReason = `scripts/run-data-ops.ts exited ${dataOps.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Repairing and verifying active coordination inbox obligations on the branch...');
    const inboxRepair = await runCommand(
      `npx tsx server/scripts/coordination-inbox-admin.ts repair --migration-run-id gate:${branch.id}`,
      branchEnv,
    );
    if (inboxRepair.code !== 0) {
      failureReason = `coordination inbox repair exited ${inboxRepair.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running secure runtime-onboarding PostgreSQL proofs against the branch...');
    const onboardingProofs = await runCommand(
      'npx tsx --test server/services/runtime-onboarding-postgres.test.ts',
      branchEnv,
    );
    if (onboardingProofs.code !== 0) {
      failureReason = `runtime-onboarding PostgreSQL proofs exited ${onboardingProofs.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running persisted coordination-runtime parity against the branch...');
    const runtimeParity = await runCommand(
      'npx tsx --test server/scripts/test-coordination-runtime-postgres-repository.test.ts',
      branchEnv,
    );
    if (runtimeParity.code !== 0) {
      failureReason = `coordination runtime PostgreSQL parity exited ${runtimeParity.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running persisted founder task-ownership protocol parity against the branch...');
    const ownershipParity = await runCommand(
      'npx tsx --test server/scripts/test-founder-task-ownership-postgres.test.ts',
      branchEnv,
    );
    if (ownershipParity.code !== 0) {
      failureReason = `founder task-ownership PostgreSQL parity exited ${ownershipParity.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 PostgreSQL constraint parity against the branch...');
    const coordinatorV2Parity = await runCommand(
      'npx tsx --test server/scripts/test-coordinator-v2-schema-postgres.test.ts',
      branchEnv,
    );
    if (coordinatorV2Parity.code !== 0) {
      failureReason = `Coordinator V2 PostgreSQL parity exited ${coordinatorV2Parity.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 task-artifact registry PostgreSQL proofs against the branch...');
    const taskArtifactRegistryTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-task-artifact-registry-postgres.test.ts',
      branchEnv,
    );
    if (taskArtifactRegistryTests.code !== 0) {
      failureReason = `Coordinator V2 task-artifact registry PostgreSQL tests exited ${taskArtifactRegistryTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 runtime-bootstrap PostgreSQL proofs against the branch...');
    const runtimeBootstrapPostgres = await runCommand(
      'npx tsx --test server/scripts/test-coordination-v2-runtime-bootstrap-postgres.test.ts',
      branchEnv,
    );
    if (runtimeBootstrapPostgres.code !== 0) {
      failureReason = `Coordinator V2 runtime-bootstrap PostgreSQL tests exited ${runtimeBootstrapPostgres.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 host-reauthorization PostgreSQL proofs against the branch...');
    const hostReauthorizationPostgres = await runCommand(
      'npx tsx --test server/scripts/test-coordinator-v2-host-reauthorization-postgres.test.ts',
      branchEnv,
    );
    if (hostReauthorizationPostgres.code !== 0) {
      failureReason = `Coordinator V2 host-reauthorization PostgreSQL tests exited ${hostReauthorizationPostgres.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 runtime-bootstrap service and HTTP proofs...');
    const runtimeBootstrapService = await runCommand(
      'npx tsx --test server/services/coordination-v2-runtime-bootstrap-service.test.ts server/scripts/test-coordination-v2-runtime-bootstrap-http.test.ts',
      branchEnv,
    );
    if (runtimeBootstrapService.code !== 0) {
      failureReason = `Coordinator V2 runtime-bootstrap service/HTTP tests exited ${runtimeBootstrapService.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 policy service transactional tests against the branch...');
    const policyServiceTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-policy-service.test.ts',
      branchEnv,
    );
    if (policyServiceTests.code !== 0) {
      failureReason = `Coordinator V2 policy service tests exited ${policyServiceTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 policy HTTP tests against the branch...');
    const policyHttpTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-policy-http.test.ts',
      branchEnv,
    );
    if (policyHttpTests.code !== 0) {
      failureReason = `Coordinator V2 policy HTTP tests exited ${policyHttpTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 bounded session/attempt PostgreSQL tests against the branch...');
    const sessionServiceTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-session-service.test.ts',
      branchEnv,
    );
    if (sessionServiceTests.code !== 0) {
      failureReason = `Coordinator V2 session service tests exited ${sessionServiceTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 session HTTP middleware tests...');
    const sessionHttpTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-session-http.test.ts',
      branchEnv,
    );
    if (sessionHttpTests.code !== 0) {
      failureReason = `Coordinator V2 session HTTP tests exited ${sessionHttpTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 durable transport lease tests...');
    const transportLeaseTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-transport-lease.test.ts',
      branchEnv,
    );
    if (transportLeaseTests.code !== 0) {
      failureReason = `Coordinator V2 transport lease tests exited ${transportLeaseTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 host HTTP tests...');
    const hostHttpTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-host-http.test.ts',
      branchEnv,
    );
    if (hostHttpTests.code !== 0) {
      failureReason = `Coordinator V2 host HTTP tests exited ${hostHttpTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 provider contract and Gemini adapter tests...');
    const providerAdapterTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-provider-contract.test.ts server/scripts/test-coordination-provider-gemini.test.ts',
      branchEnv,
    );
    if (providerAdapterTests.code !== 0) {
      failureReason = `Coordinator V2 provider adapter tests exited ${providerAdapterTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 host protocol and authorization contract tests...');
    const hostContractTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-host-contract.test.ts server/scripts/test-coordination-host-authorization.test.ts',
      branchEnv,
    );
    if (hostContractTests.code !== 0) {
      failureReason = `Coordinator V2 host contract tests exited ${hostContractTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 Windows preflight and atomic preparation tests...');
    const windowsPreparationTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-windows-preflight.test.ts server/scripts/test-coordination-windows-preparation.test.ts server/scripts/test-coordination-windows-static-boundary.test.ts server/scripts/test-coordination-windows-generation.test.ts server/scripts/test-coordination-v2-windows-runtime-bootstrap-static.test.ts',
      branchEnv,
    );
    if (windowsPreparationTests.code !== 0) {
      failureReason = `Coordinator V2 Windows preparation tests exited ${windowsPreparationTests.code}`;
    }
  }

  if (!failureReason) {
    console.log('[gate] Running Coordinator V2 lifecycle, diagnostics, cleanup, fault, fallback, and evidence tests...');
    const windowsHostLifecycleTests = await runCommand(
      'npx tsx --test server/scripts/test-coordination-lifecycle-facade.test.ts server/scripts/test-coordination-windows-host.test.ts server/scripts/test-coordination-v2-cli.test.ts server/scripts/test-coordination-errors.test.ts server/scripts/test-coordination-session-status.test.ts server/scripts/test-coordination-cleanup.test.ts server/scripts/test-coordination-v2-e2e.test.ts server/scripts/test-coordination-v2-fault-injection.test.ts server/scripts/test-coordination-v2-provider-fallback.test.ts server/scripts/test-coordination-v2-evidence-integrity.test.ts',
      branchEnv,
    );
    if (windowsHostLifecycleTests.code !== 0) {
      failureReason = `Coordinator V2 lifecycle diagnostics cleanup fault fallback and evidence tests exited ${windowsHostLifecycleTests.code}`;
    }
  }

  if (!failureReason) {
    for (const group of ['test:ci:unit', 'test:ci:guards', 'test:ci:episodes']) {
      console.log(`[gate] Running npm run ${group} against the branch...`);
      const result = await runCommand(`npm run ${group}`, branchEnv);
      if (result.code !== 0) {
        failureReason = `npm run ${group} exited ${result.code}`;
        break;
      }
    }
  }

  if (!failureReason) {
    console.log('[gate] Running agent-memory concurrent-write and stale-version PostgreSQL tests against the branch...');
    const agentMemoryPostgresTests = await runCommand(
      'npx tsx --test server/scripts/test-agent-memory-concurrent-write-postgres.test.ts server/scripts/test-agent-memory-stale-version-postgres.test.ts',
      { ...branchEnv, AGENT_MEMORY_TEST_FILES_DIR: await mkdtemp(join(tmpdir(), 'agent-memory-gate-')) },
    );
    if (agentMemoryPostgresTests.code !== 0) {
      failureReason = `agent-memory PostgreSQL tests exited ${agentMemoryPostgresTests.code}`;
    }
  }

  if (!failureReason) {
    // Deliberately its own sequential step, never bundled with sibling
    // agent-memory test files. This file's "snapshot MEMORY.md, call
    // regenerateAll(), diff byte-for-byte" assertion checks a *global*
    // projection: regenerateAll() re-renders MEMORY.md from every topic's
    // entries in the DB, not just this file's own. If any other writer
    // (even a sibling test file racing in the same `npx tsx --test`
    // invocation under Node's default multi-file concurrency) inserts a row
    // between the snapshot and the regenerate, regenerateAll() includes it
    // and the diff false-fails -- confirmed directly against this gate. See
    // .agents/memory/agent-memory-round-trip-isolation.md.
    console.log('[gate] Running agent-memory round-trip PostgreSQL test against the branch...');
    const agentMemoryRoundTripTest = await runCommand(
      'npx tsx --test server/scripts/test-agent-memory-round-trip-postgres.test.ts',
      { ...branchEnv, AGENT_MEMORY_TEST_FILES_DIR: await mkdtemp(join(tmpdir(), 'agent-memory-gate-')) },
    );
    if (agentMemoryRoundTripTest.code !== 0) {
      failureReason = `agent-memory round-trip PostgreSQL test exited ${agentMemoryRoundTripTest.code}`;
    }
  }

  // No standalone runCommand() step for the shared-spec live-instruction-
  // document PostgreSQL tests: that file's disposableTarget() now checks
  // getVerifiedCiDatabaseUrl() first (see its own header comment), so it is
  // already exercised above by the `npm run test:ci:unit` loop -- via the
  // SHARED_SPEC_TEST_DATABASE_URL/_DISPOSABLE/_REQUIRE_DATABASE_TESTS vars
  // still set in branchEnv above, which its disposableTarget() falls
  // through to once CI is deleted from branchEnv. A separate standalone
  // call here would just run the same file against the same branch twice.
  // Mirrors server/services/release-cutover-attestation-service.test.ts,
  // which has no standalone runCommand() call here either despite its own
  // RELEASE_CUTOVER_ATTESTATION_* branchEnv vars being retained above.
  //
  // Same reasoning, same absence of a standalone step, for
  // server/scripts/test-alden-shared-spec-review-postgres.test.ts: its
  // disposableTarget() falls through to the ALDEN_SHARED_SPEC_REVIEW_*
  // branchEnv vars above once CI is deleted, so `npm run test:ci:unit`
  // already covers it.

  if (!failureReason) {
    // Gives the Postgres-backed half of the drift-guard mutation proof (Scenario
    // A's end-to-end coverage; see the script's own header) a real database --
    // without this, it can only ever run its in-process unit-test half and would
    // silently skip the end-to-end proof on every gate run.
    console.log('[gate] Running shared-spec live-instruction-document drift-guard mutation proof against the branch...');
    const sharedSpecDriftGuardMutation = await runCommand(
      'npx tsx server/scripts/test-shared-spec-live-sync-drift-guard-mutation.ts',
      branchEnv,
    );
    if (sharedSpecDriftGuardMutation.code !== 0) {
      failureReason = `shared-spec live-instruction-document drift-guard mutation proof exited ${sharedSpecDriftGuardMutation.code}`;
    }
  }

  if (!failureReason) {
    // Same reasoning as the drift-guard mutation proof above, for the
    // separate POST-COMMIT verification guard (Scenario B's end-to-end
    // coverage; see the script's own header) -- without this, it can only
    // ever run its in-process unit-test half and would silently skip the
    // end-to-end proof on every gate run.
    console.log('[gate] Running shared-spec live-instruction-document post-commit-guard mutation proof against the branch...');
    const sharedSpecPostCommitGuardMutation = await runCommand(
      'npx tsx server/scripts/test-shared-spec-live-sync-post-commit-guard-mutation.ts',
      branchEnv,
    );
    if (sharedSpecPostCommitGuardMutation.code !== 0) {
      failureReason = `shared-spec live-instruction-document post-commit-guard mutation proof exited ${sharedSpecPostCommitGuardMutation.code}`;
    }
  }

  if (!flags['keep-on-failure'] || !failureReason) {
    console.log(`[gate] Deleting branch "${branchName}"...`);
    await deleteBranchCore(branch.id, false).catch((err) =>
      console.error(`[gate] WARNING: failed to delete branch ${branch.name} (${branch.id}): ${err.message}`),
    );
  } else {
    console.log(`[gate] --keep-on-failure set: leaving "${branchName}" (${branch.id}) for inspection.`);
  }

  if (failureReason) {
    console.error(`[gate] FAILED: ${failureReason}`);
    console.error('[gate] Nothing was applied to NEON_SHARED_DATABASE_URL — migration and data-ops both stay pending.');
    process.exitCode = 1;
    return;
  }

  console.log('[gate] READY_TO_PROMOTE — migration and data-ops both passed on an isolated branch.');
  console.log('[gate] cross-tool-promote applies both to production automatically on a normal promote.');
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (subcommand) {
    case 'create':
      return cmdCreate(positional, flags);
    case 'connection-string':
      return cmdConnectionString(positional, flags);
    case 'list':
      return cmdList();
    case 'delete':
      return cmdDelete(positional, flags);
    case 'gate':
      return cmdGate(flags);
    default:
      console.error('Usage: neon-branch.ts <create|connection-string|list|delete|gate> [options]');
      process.exitCode = 1;
  }
}

// Guard CLI dispatch behind an entrypoint check -- otherwise importing this
// module (e.g. from scripts/neon-branch.test.ts) would run main() as a side
// effect of the import and misread the importer's own argv as a subcommand.
// Mirrors the same guard in scripts/reconciliation-history-object-storage.ts.
if (basename(process.argv[1] ?? '') === 'neon-branch.ts') {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

/**
 * Unguarded Neon API calls for creating a branch. Not exported -- every real
 * caller outside this module must go through `createBranch`, which adds the
 * ownership gate. The one exception inside this module is `cmdGate`'s own
 * disposable migration-test branch; see the module header comment for why
 * that specific internal lifecycle is not gated the same way.
 */
async function createBranchCore(opts: CreateBranchOpts): Promise<NeonBranch> {
  const projectId = requireEnv('NEON_PROJECT_ID');
  const parentId = await resolveParentBranchId(opts.parent);
  const { branch } = await neonApi<{ branch: NeonBranch }>(`/projects/${projectId}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: {
        name: opts.name,
        parent_id: parentId,
        expires_at: opts.expiresAt,
        ...(opts.schemaOnly ? { init_source: 'schema-only' } : {}),
      },
      endpoints: [{ type: 'read_write' }],
    }),
  });
  await opts.onCreated?.(branch);
  await waitUntilReady(branch.id);
  return branch;
}
