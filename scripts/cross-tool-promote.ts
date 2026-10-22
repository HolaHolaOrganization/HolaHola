/**
 * Cross-tool "get a committed branch onto main safely" — for any external
 * tool/caller (Claude Code, Cursor, Antigravity, a human) that isn't Replit's
 * own persistent dev checkout. Design: docs/superpowers/specs/2026-08-26-unified-source-promote-endpoint-design.md
 *
 * Renamed from source-promote.ts 2026-08-31: Replit independently built its
 * own git-promotion entry point (server/services/source-control-service.ts,
 * "source-promotion") for its own dev checkout specifically — different
 * caller, different constraints, not a duplicate. Two entry points into main
 * is the right shape here, not a conflict to resolve into one; a future
 * platform with its own host-specific requirements (Antigravity, say) could
 * reasonably add a third. What they share: fast-forward-only, no automatic
 * reconciliation of a diverged branch, and the deploy key never held by the
 * calling agent/tool. See the "Two entry points" note in the design doc.
 *
 * Talks to the GitHub Actions API directly — no HolaHola server involved.
 * An earlier version proxied through POST /api/internal/source-promote, but
 * that endpoint would only ever be as reachable as whichever Replit process
 * hosted it (dev restarts constantly and isn't meant to have uptime
 * guarantees; production is the live-traffic process this was always meant
 * to stay off of). The actual credential this needs to protect —
 * HOLAHOLA_GITHUB_DEPLOY_KEY — never leaves GitHub Actions secrets in either
 * design, so the server-hosted proxy added a reachability dependency without
 * adding real security. GitHub's own API is already the always-on service
 * here; there was nothing to proxy.
 *
 * Usage:
 *   npx tsx scripts/cross-tool-promote.ts push <branch> --task-ref <ref> [--source <label>]
 *   npx tsx scripts/cross-tool-promote.ts status <jobId>
 *
 * `push` dispatches a GitHub Actions workflow on behalf of a task, so it
 * requires --task-ref and is refused (no dispatch attempted) when ownership
 * cannot be proven (see server/services/infra-mutation-guard.ts).
 *
 * Caller responsibility before calling `push`: commit locally, then
 * `git push origin <branch>` normally — pushing a non-main branch needs no
 * special credential. This script only asks GitHub Actions to validate and
 * fast-forward main; it never touches the deploy key itself.
 *
 * Added 2026-09-28 — auto-freshen before dispatch: `push` now fetches
 * `origin/main` and merges it into the candidate branch locally
 * (`git merge --no-edit`, never rebase — the branch's existing commit SHAs
 * must not be rewritten, since coordination-evidence/provenance records may
 * reference them) before asking the workflow to validate it, then pushes
 * the merged branch back to its own ref with a normal, non-force push. This
 * is the fix for the recurring "two hats land from a stale base and main
 * diverges" failure mode: previously a candidate built from a base that
 * fell behind main only found out at dispatch time (or, worse, passed the
 * workflow's early ancestry check and failed only after the slow
 * typecheck/build/Neon-gate steps), with no automatic path to catch up. A
 * real content conflict aborts the merge and throws with a manual-
 * resolution message — this never auto-resolves a conflict. See
 * `freshenBranchAgainstMain` below. The workflow's own ancestry checks are
 * unchanged and remain the actual enforcement; this is a low-privilege
 * client-side convenience layered in front of them, not a replacement.
 * Design + review: docs/shared-agent-instructions.md's "Keeping a
 * cross-tool promotion candidate fresh" section.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDirectCliInvocation } from '../server/scripts/lib/cli-entrypoint';
import { assertOwnershipForInfraMutation, type OwnershipProbe } from '../server/services/infra-mutation-guard';
import { createPromotionOwnershipProbe } from '../server/services/promotion-ownership-probe';
import { isCommitSha, type PromotionMerge } from '../server/services/promotion-candidate';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const OWNER = 'HolaHolaOrganization';
const REPO = 'HolaHola';
const WORKFLOW_FILE = 'cross-tool-promote.yml';
const GITHUB_API = 'https://api.github.com';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} — add it to .env before running scripts/cross-tool-promote.ts`);
  }
  return value;
}

export function isValidBranchName(branch: string): boolean {
  return (
    typeof branch === 'string' &&
    branch.length > 0 &&
    branch.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.startsWith('-') &&
    !branch.includes('..')
  );
}

/**
 * Fetches `origin/main` and merges it into the currently checked-out branch
 * (`git merge --no-edit`), then pushes the result back to the same branch
 * ref with a normal, non-force push. Merge, not rebase, so the branch's
 * existing commit SHAs are never rewritten — coordination-evidence and
 * provenance records may reference them.
 *
 * Exported and directly testable, following the `isValidBranchName`
 * pattern above — see server/scripts/test-cross-tool-promote-auto-freshen.ts
 * for real-git-repo positive (clean merge) and negative (real conflict
 * aborts loudly) cases.
 *
 * Preconditions this enforces itself rather than assuming:
 *  - HEAD must already be on `branch` — this never switches branches out
 *    from under the caller.
 *  - The working tree must be clean — an uncommitted change could otherwise
 *    produce a confusing partial merge state.
 *
 * On a real content conflict, the merge is aborted (leaving the working
 * tree exactly as it was) and this throws with a manual-resolution message.
 * It never auto-resolves a conflict by picking a side.
 *
 * Returns `merged: false` when the branch already contained `origin/main`
 * (the common case for a branch that was just freshly branched, or a
 * caller re-running `push` after an earlier successful freshen) — nothing
 * to merge, nothing to push.
 */
export function freshenBranchAgainstMain(
  branch: string, cwd: string = process.cwd(),
  options: {
    deferPush?: boolean; candidateCommit?: string;
    onPromotionMerge?: (merge: PromotionMerge) => void;
  } = {},
): { merged: boolean } {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (currentBranch !== branch) {
    throw new Error(
      `Refusing to freshen — checked-out branch is "${currentBranch}" but push was asked to promote "${branch}". ` +
        `Check out "${branch}" first.`,
    );
  }

  const status = git(['status', '--porcelain']);
  if (status.trim().length > 0) {
    throw new Error(
      `Refusing to freshen "${branch}" — the working tree has uncommitted changes. Commit or stash them first, then re-run push.`,
    );
  }

  // A process-private ref avoids another fetch changing global FETCH_HEAD
  // between retrieval and recording the approved merge's second parent.
  const mainRef = options.onPromotionMerge ? `refs/promotion-freshen/${randomUUID()}` : undefined;
  let mainSha: string;
  if (mainRef) {
    try {
      git(['fetch', 'origin', `refs/heads/main:${mainRef}`, '--no-tags']);
      mainSha = git(['rev-parse', '--verify', `${mainRef}^{commit}`]).trim();
    } finally { git(['update-ref', '-d', mainRef]); }
  } else {
    git(['fetch', 'origin', 'main', '--no-tags']);
    mainSha = git(['rev-parse', 'FETCH_HEAD']).trim();
  }
  const headSha = git(['rev-parse', 'HEAD']).trim();
  if (options.candidateCommit !== undefined && headSha !== options.candidateCommit) {
    throw new Error('Candidate changed after approval; refusing to freshen.');
  }

  let mainAlreadyIncluded = true;
  try {
    git(['merge-base', '--is-ancestor', mainSha, headSha]);
  } catch {
    mainAlreadyIncluded = false;
  }
  if (mainAlreadyIncluded) {
    return { merged: false };
  }

  try {
    git(['merge', ...(options.onPromotionMerge ? ['--no-ff'] : []), '--no-edit', mainSha]);
  } catch (err) {
    try {
      git(['merge', '--abort']);
    } catch {
      // Nothing to abort, or abort itself failed — surface the original
      // merge error either way rather than masking it.
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not automatically merge the latest main into "${branch}" — a real conflict needs manual resolution. ` +
        `Run "git fetch origin main && git merge origin/main" locally, resolve the conflict, commit, and re-run push. ` +
        `Original error: ${detail}`,
    );
  }

  if (options.onPromotionMerge) {
    const commitSha = git(['rev-parse', 'HEAD']).trim();
    if (!isCommitSha(commitSha) ||
        git(['rev-list', '--parents', '-n', '1', commitSha]).trim() !== `${commitSha} ${headSha} ${mainSha}`) {
      throw new Error('Freshening did not create the exact approved two-parent merge.');
    }
    options.onPromotionMerge(Object.freeze({ candidateCommit: headSha, mainCommit: mainSha, commitSha }));
  }
  if (!options.deferPush) git(['push', 'origin', branch]);
  return { merged: true };
}

async function githubApi<T>(
  apiPath: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const token = requireEnv('GITHUB_ACTIONS_DISPATCH_TOKEN');
  const res = await fetchImpl(`${GITHUB_API}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${apiPath} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

interface GithubWorkflowRun {
  id: number;
  name?: string;
  display_title?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

// workflow_dispatch's own response never includes the run it created, so the
// run is found by matching run-name (set from the jobId) among recent
// dispatch-triggered runs — the standard workaround for this GitHub API gap.
// Stateless by design: any later `status <jobId>` call resolves this fresh,
// no local bookkeeping needed.
async function resolveRun(jobId: string): Promise<GithubWorkflowRun | undefined> {
  const { workflow_runs } = await githubApi<{ workflow_runs: GithubWorkflowRun[] }>(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`,
  );
  return workflow_runs.find((run) => (run.display_title ?? run.name ?? '').includes(jobId));
}

export function requireTaskRef(flags: Record<string, string | boolean>): string {
  const taskRef = flags['task-ref'];
  if (!taskRef || typeof taskRef !== 'string') {
    throw new Error(
      'Missing --task-ref <ref> -- required so the ownership guard can verify this promotion '
      + 'is authorized (see server/services/infra-mutation-guard.ts).',
    );
  }
  return taskRef;
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

async function cmdPush(positional: string[], flags: Record<string, string | boolean>) {
  const branch = positional[0];
  if (!branch) {
    throw new Error('Usage: cross-tool-promote.ts push <branch> [--source <label>] --task-ref <ref>');
  }
  if (!isValidBranchName(branch)) {
    throw new Error(`Not a valid branch name: ${branch}`);
  }
  const taskRef = requireTaskRef(flags);
  for (const name of ['actor', 'app-url', 'receipt-id']) {
    if (flags[name] !== undefined && (typeof flags[name] !== 'string' || !flags[name])) {
      throw new Error(`--${name} requires a value.`);
    }
  }
  let merge: PromotionMerge | undefined;
  let phase: 'upload' | 'dispatch' = 'dispatch';
  const probeOwnership = createPromotionOwnershipProbe({
    actor: typeof flags.actor === 'string' ? flags.actor : undefined,
    appUrl: typeof flags['app-url'] === 'string' ? flags['app-url'] : undefined,
    receiptId: typeof flags['receipt-id'] === 'string' ? flags['receipt-id'] : undefined,
    branch, merge: () => merge, phase: () => phase,
  });
  // Freshening can push a merge commit, so check before it as well as dispatch.
  await assertOwnershipForInfraMutation(taskRef, `github:cross_tool_promote_push:${branch}`, probeOwnership);
  const source = (flags.source as string) ?? 'claude-code';
  const jobId = randomUUID();

  console.log(`[cross-tool-promote] Freshening "${branch}" against the latest origin/main...`);
  const candidateCommit = probeOwnership.candidate()?.candidateCommit;
  if (!candidateCommit) throw new Error('Missing verified promotion candidate.');
  const { merged } = freshenBranchAgainstMain(branch, process.cwd(), {
    deferPush: true, candidateCommit,
    onPromotionMerge: value => { merge = value; },
  });
  if (merged) {
    // A merge may take long enough for approval to expire or be revoked.
    // Reprove immediately before uploading the merge, not only at dispatch.
    phase = 'upload';
    await assertOwnershipForInfraMutation(taskRef, `github:cross_tool_promote_merge_push:${branch}`, probeOwnership);
    const sha = probeOwnership.verifiedCommit();
    if (!isCommitSha(sha)) throw new Error('Missing verified merge SHA.');
    execFileSync('git', ['push', 'origin', `${sha}:refs/heads/${branch}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    phase = 'dispatch';
  }
  console.log(
    merged
      ? `[cross-tool-promote] Merged the latest main into "${branch}" and pushed the merge commit.`
      : `[cross-tool-promote] "${branch}" already includes the latest main — nothing to merge.`,
  );

  await dispatchCrossToolPromote(branch, taskRef, jobId, { probeOwnership });
  console.log(`[cross-tool-promote] Approved candidate ${candidateCommit}; dispatched ${probeOwnership.verifiedCommit()}`);
  console.log(`[cross-tool-promote] Dispatched by ${source} — job ${jobId}`);

  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const run = await resolveRun(jobId);
    if (!run) {
      console.log('[cross-tool-promote] queued — waiting for the run to appear...');
      continue;
    }
    if (run.status !== 'completed') {
      console.log(`[cross-tool-promote] ${run.status} — ${run.html_url}`);
      continue;
    }
    if (run.conclusion === 'success') {
      console.log(`[cross-tool-promote] SYNCED — main now includes this branch. ${run.html_url}`);
    } else {
      console.error(`[cross-tool-promote] FAILED (${run.conclusion}) — ${run.html_url}`);
      process.exitCode = 1;
    }
    return;
  }
}

async function cmdStatus(positional: string[]) {
  const jobId = positional[0];
  if (!jobId) {
    throw new Error('Usage: cross-tool-promote.ts status <jobId>');
  }
  const run = await resolveRun(jobId);
  if (!run) {
    console.log('No run found yet for that jobId — it may not have started, or may be older than the last 20 dispatch runs.');
    return;
  }
  console.log(JSON.stringify(run, null, 2));
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (subcommand) {
    case 'push':
      return cmdPush(positional, flags);
    case 'status':
      return cmdStatus(positional);
    default:
      console.error('Usage: cross-tool-promote.ts <push|status> [options]');
      process.exitCode = 1;
  }
}

if (isDirectCliInvocation('cross-tool-promote.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

/**
 * The actual live-codebase mutation: asking GitHub Actions to fast-forward
 * `main` to `branch`. Gated the same way the Cloudflare DNS path is --
 * refuse (InfraMutationBlockedError, no dispatch call attempted) when task
 * ownership resolves to `unknown_stop`. See
 * .agents/memory/task-ownership-guard-scope.md for why this exists.
 */
export async function dispatchCrossToolPromote(
  branch: string,
  taskRef: string,
  jobId: string,
  options: { probeOwnership?: OwnershipProbe; fetchImpl?: typeof fetch; expectedSha?: string } = {},
): Promise<void> {
  const probe = options.probeOwnership ?? createPromotionOwnershipProbe({ branch });
  await assertOwnershipForInfraMutation(
    taskRef,
    `github:cross_tool_promote_push:${branch}`,
    probe,
  );
  if ('candidate' in probe &&
      (probe as ReturnType<typeof createPromotionOwnershipProbe>).candidate()?.branch !== branch) {
    throw new Error('Dispatch branch differs from the approved candidate.');
  }
  const expectedSha = 'verifiedCommit' in probe
    ? (probe as ReturnType<typeof createPromotionOwnershipProbe>).verifiedCommit()
    : options.expectedSha;
  if (!isCommitSha(expectedSha)) throw new Error('A freshly verified promotion SHA is required.');
  await githubApi(
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { branch, jobId, expectedSha } }) },
    options.fetchImpl,
  );
}
