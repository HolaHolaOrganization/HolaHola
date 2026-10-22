/**
 * test-github-branch-bypass-guard.ts
 *
 * CI check: verifies that NOTHING can push to `main` around required PR
 * review + status checks — no bypass actor of any kind (App, deploy key, team,
 * role or user), no weakened core ruleset protections, and no resurrected
 * legacy classic branch-protection rule.
 *
 * Update (2026-10-15): the founder removed the last bypass actor (the
 * holahola-source-promotion GitHub App, Integration 4984686) and disabled the
 * cross-tool-promote workflow that needed it. Per the approved
 * standard-integration-controls plan (shared-spec efb1e3d1), every change now
 * reaches main only as a reviewed, CI-green pull request. The expected state is
 * therefore an EMPTY bypass list; re-adding any bypass actor is drift.
 *
 * Background (Sep 17-18 2026):
 *   The source-control coordinator was migrated off a long-lived SSH deploy
 *   key onto short-lived GitHub App installation tokens
 *   (server/services/github-app-auth.ts). The repository ruleset
 *   ("HolaHola Push Rule", id 21584232) bypass_actors was narrowed from a
 *   broad, unscoped `DeployKey` entry (grants bypass to ANY deploy key ever
 *   registered on the repo, not just one) down to exactly one entry: the
 *   GitHub App's Integration id.
 *
 *   While doing that migration, a *separate*, independent legacy classic
 *   branch protection rule on `main` was discovered — it required the same
 *   status check but has no bypass-actor concept at all, so it silently
 *   rejected a correctly-configured ruleset bypass. This sat undetected
 *   until someone tested a real push by hand. See
 *   .agents/memory/github-branch-protection-layering.md for the full story.
 *
 *   This check reads the live GitHub state directly and asserts:
 *     1. The ruleset is active and its bypass_actors list is EMPTY.
 *     2. The core main protections are still present: deletion and
 *        non-fast-forward blocking, required pull request, linear history, and
 *        the required `test` status check.
 *     3. Classic branch protection has not reappeared on `main` (its
 *        `protection.enabled` flag on the branch resource).
 *
 * Credential note — why RULESET_MONITOR_TOKEN_GITHUB and not the GitHub App:
 *   The obvious choice was the coordinator's own GitHub App installation
 *   token (server/services/github-app-auth.ts) — it authenticates the same
 *   way the real push does. Verified empirically that it does NOT work here:
 *   `GET .../rulesets/{id}` returns 200 but the App's token silently gets
 *   NO `bypass_actors` field at all (not even `[]`) — only a self-referential
 *   `current_user_can_bypass` convenience field, which answers "can *this*
 *   token bypass" but can't reveal whether a second, rogue actor was also
 *   added.
 *
 * Credential note — why not GITHUB_ACTIONS_DISPATCH_TOKEN either (Sep 18 2026):
 *   This check originally reused GITHUB_ACTIONS_DISPATCH_TOKEN (David's own
 *   personal PAT, shared with scripts/cross-tool-promote.ts and carrying full
 *   admin on the repo) because it was the only credential on hand that could
 *   see `bypass_actors`. GitHub's own docs for this endpoint explain why the
 *   App token couldn't:
 *
 *     "To prevent leaking sensitive information, the bypass_actors property
 *     is only returned if the user making the API request has write access
 *     to the ruleset."
 *
 *   There is no read-only permission tier that can ever see `bypass_actors`
 *   — that's a hard platform constraint, not a scoping choice. So the
 *   narrowest credential that can still run this check is a *dedicated*
 *   fine-grained PAT, scoped to only this repo, granted only the
 *   "Administration: Read and write" repository permission (the minimum
 *   tier GitHub allows for this visibility) and nothing else — not David's
 *   full personal identity, and not shared with any other job. That's
 *   RULESET_MONITOR_TOKEN_GITHUB. If it ever leaks, the blast radius is
 *   "can rewrite this repo's branch protection/ruleset config" (bad, but
 *   recoverable) instead of "has David's full admin identity on the repo."
 *
 *   Both this token and the App token 403 on the dedicated
 *   `/branches/{branch}/protection` endpoint ("Resource not accessible");
 *   both can read the plain `/branches/{branch}` resource, whose nested
 *   `protection.enabled` field reflects classic-protection state without
 *   needing that elevated permission.
 *
 * This is a LIVE check against the real GitHub API — not a source-code scan.
 * It only ever issues GET requests; it never mutates ruleset or protection
 * state.
 *
 * Run:
 *   npx tsx server/scripts/test-github-branch-bypass-guard.ts
 *   npx tsx server/scripts/test-github-branch-bypass-guard.ts --self-check
 *
 * --self-check mode: confirms the guard currently passes against the REAL
 * live ruleset/branch state, then feeds the same assertion logic synthetic
 * *bad* fixtures (the old App re-added, a DeployKey or other bypass actor,
 * enforcement disabled, a core rule or the required `test` check removed,
 * classic protection reenabled)
 * and verifies each one is caught. It never mutates the real, live
 * ruleset or branch protection to do this — even briefly reintroducing the
 * bypass hole on production `main` to "prove" the check works is not an
 * acceptable trade, unlike mutating a local source file and restoring it.
 *
 * Skips (exit 0) when RULESET_MONITOR_TOKEN_GITHUB is not present in the
 * environment, e.g. an isolated task-agent worktree that does not inherit
 * this secret — EXCEPT inside the scheduled monitor workflow (GitHub sets
 * GITHUB_WORKFLOW to its name, MONITOR_WORKFLOW_NAME below) or wherever
 * RULESET_MONITOR_REQUIRED=true. There a missing token FAILS (exit 1), so the
 * monitor can never go silently green without having actually checked the live
 * ruleset. test-github-branch-bypass-guard-required.test.ts pins the workflow
 * name to MONITOR_WORKFLOW_NAME so a rename cannot silently disable this.
 */
export {};

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const sep = () => console.log('\n' + '─'.repeat(70));

const OWNER = 'HolaHolaOrganization';
const REPO = 'HolaHola';
const BRANCH = 'main';
const RULESET_ID = 21584232;
const REQUIRED_RULE_TYPES = ['deletion', 'non_fast_forward', 'pull_request', 'required_linear_history', 'required_status_checks'] as const;
const REQUIRED_STATUS_CHECK = 'test';
const RETIRED_APP_INTEGRATION_ID = 4984686;

interface RulesetBypassActor {
  actor_id?: number;
  actor_type?: string;
  bypass_mode?: string;
}

interface RulesetRule {
  type?: string;
  parameters?: { required_status_checks?: Array<{ context?: string }> };
}

interface RulesetState {
  enforcement?: string;
  bypass_actors?: RulesetBypassActor[];
  rules?: RulesetRule[];
}

interface BranchState {
  protection?: {
    enabled?: boolean;
  };
}

function hasCredentials(): boolean {
  return Boolean(process.env.RULESET_MONITOR_TOKEN_GITHUB);
}

/** Must match the `name:` of .github/workflows/github-branch-bypass-monitor.yml. */
const MONITOR_WORKFLOW_NAME = 'GitHub branch bypass monitor';

/** Missing token: SKIP (exit 0) by default; FAIL (exit 1) where the monitor requires it. */
function exitForMissingCredentials(): never {
  const required = process.env.RULESET_MONITOR_REQUIRED === 'true' || process.env.GITHUB_WORKFLOW === MONITOR_WORKFLOW_NAME;
  if (required) {
    console.log(`  ${R('✗')} RULESET_MONITOR_TOKEN_GITHUB is not set, but this is the scheduled monitor (or RULESET_MONITOR_REQUIRED=true) — it cannot check the live ruleset. Failing instead of skipping.`);
    process.exit(1);
  }
  console.log(`  ${B('SKIP')}: RULESET_MONITOR_TOKEN_GITHUB not set in this environment.`);
  process.exit(0);
}

function assertRulesetBypass(ruleset: RulesetState): string[] {
  const failures: string[] = [];
  if (ruleset.enforcement !== 'active') {
    failures.push(`ruleset ${RULESET_ID} enforcement is "${ruleset.enforcement}", expected "active"`);
  }
  const actors = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  for (const actor of actors) {
    const retired = actor.actor_type === 'Integration' && actor.actor_id === RETIRED_APP_INTEGRATION_ID
      ? ' (the retired holahola-source-promotion App)' : '';
    failures.push(`ruleset ${RULESET_ID} has a bypass actor: ${actor.actor_type} ${actor.actor_id ?? ''} mode=${actor.bypass_mode}${retired} — expected NO bypass actors`);
  }
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  for (const type of REQUIRED_RULE_TYPES) {
    if (!rules.some((rule) => rule.type === type)) {
      failures.push(`ruleset ${RULESET_ID} is missing required rule "${type}"`);
    }
  }
  const checks = rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks ?? [];
  if (!checks.some((check) => check.context === REQUIRED_STATUS_CHECK)) {
    failures.push(`ruleset ${RULESET_ID} no longer requires the "${REQUIRED_STATUS_CHECK}" status check`);
  }
  return failures;
}

function assertNoClassicProtection(branch: BranchState): string[] {
  if (branch.protection?.enabled === true) {
    return [`classic branch protection is enabled on ${BRANCH} — it is a second, unmonitored protection layer outside the audited ruleset`];
  }
  return [];
}

async function fetchLiveState(): Promise<{ ruleset: RulesetState; branch: BranchState }> {
  const token = process.env.RULESET_MONITOR_TOKEN_GITHUB!;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  const rulesetRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/rulesets/${RULESET_ID}`, { headers });
  if (!rulesetRes.ok) {
    const detail = await rulesetRes.text().catch(() => '');
    throw new Error(`Ruleset fetch failed (${rulesetRes.status}): ${detail.slice(0, 300)}`);
  }
  const ruleset = await rulesetRes.json() as RulesetState;
  if (!Array.isArray(ruleset.bypass_actors)) {
    throw new Error(
      `Ruleset ${RULESET_ID} response did not include a bypass_actors array — RULESET_MONITOR_TOKEN_GITHUB may have lost the Administration permission this check relies on to see it (current_user_can_bypass was "${(ruleset as { current_user_can_bypass?: string }).current_user_can_bypass}"). Fix the credential before trusting this check's result.`,
    );
  }

  // Deliberately NOT /branches/{branch}/protection — that dedicated endpoint
  // requires the "administration" permission, which this token does not have
  // (verified: 403 "Resource not accessible by personal access token"). The
  // branch resource's own `protection.enabled` field reflects classic
  // protection state too, and is readable without that elevated permission.
  const branchRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}`, { headers });
  if (!branchRes.ok) {
    const detail = await branchRes.text().catch(() => '');
    throw new Error(`Branch fetch failed (${branchRes.status}): ${detail.slice(0, 300)}`);
  }
  const branch = await branchRes.json() as BranchState;

  return { ruleset, branch };
}

async function runRealCheck(): Promise<void> {
  sep();
  console.log(B('GitHub main-branch bypass surface guard'));
  console.log(B(`Verifies ruleset ${RULESET_ID} has NO bypass actors and keeps its core protections,`));
  console.log(B(`and that classic branch protection has not reappeared on ${BRANCH}.`));
  sep();

  if (!hasCredentials()) exitForMissingCredentials();

  const { ruleset, branch } = await fetchLiveState();
  const failures = [...assertRulesetBypass(ruleset), ...assertNoClassicProtection(branch)];

  console.log('');
  if (failures.length === 0) {
    console.log(`  ${G('✓')} ruleset ${RULESET_ID} has no bypass actors and keeps all core protections`);
    console.log(`  ${G('✓')} classic branch protection is not active on ${BRANCH}`);
    sep();
    console.log(G('\n✓ All assertions passed — nothing can push to main around review and CI.\n'));
    process.exit(0);
  } else {
    for (const f of failures) console.log(`  ${R('✗')} ${f}`);
    sep();
    console.log(R(`\n✗ ${failures.length} assertion(s) failed — main's push-bypass surface has drifted from the audited state.\n`));
    process.exit(1);
  }
}

async function selfCheck(): Promise<void> {
  sep();
  console.log(B('SELF-CHECK: verifying this guard fails against known-bad ruleset/protection states'));
  sep();

  if (!hasCredentials()) exitForMissingCredentials();

  // Baseline: the real live state must currently pass. This is a read-only
  // GET against the real ruleset and branch — never a mutation. Actually
  // mutating the live ruleset/protection to prove the failure path would
  // mean briefly reintroducing the exact bypass hole this guard exists to
  // catch, on production `main` — not an acceptable trade even transiently.
  // Failure paths are exercised below against synthetic in-memory fixtures
  // derived from the real baseline instead.
  const { ruleset, branch } = await fetchLiveState();
  const baselineFailures = [...assertRulesetBypass(ruleset), ...assertNoClassicProtection(branch)];
  if (baselineFailures.length > 0) {
    console.log(R('✗ Self-check aborted — the guard already fails against the REAL live state:'));
    for (const f of baselineFailures) console.log(`    ${R('✗')} ${f}`);
    console.log(R('  Fix the live ruleset/protection drift first, then rerun the self-check.'));
    process.exit(1);
    return;
  }
  console.log(G('✓ Baseline: guard passes against the real, live ruleset and branch state'));
  console.log('');

  let selfCheckFailed = 0;

  const rulesetFixtures: Array<{ label: string; bad: RulesetState }> = [
    {
      label: 'the retired holahola-source-promotion App is re-added as a bypass actor',
      bad: { ...ruleset, bypass_actors: [{ actor_type: 'Integration', actor_id: RETIRED_APP_INTEGRATION_ID, bypass_mode: 'always' }] },
    },
    {
      label: 'a broad DeployKey bypass_actor is added',
      bad: { ...ruleset, bypass_actors: [{ actor_type: 'DeployKey', bypass_mode: 'always' }] },
    },
    {
      label: 'a different Integration bypass_actor is added',
      bad: { ...ruleset, bypass_actors: [{ actor_type: 'Integration', actor_id: 999999, bypass_mode: 'always' }] },
    },
    {
      label: 'a repository-role bypass_actor is added (pull_request mode)',
      bad: { ...ruleset, bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'pull_request' }] },
    },
    {
      label: 'the required pull_request rule is removed',
      bad: { ...ruleset, rules: (ruleset.rules ?? []).filter((rule) => rule.type !== 'pull_request') },
    },
    {
      label: 'the required "test" status check is removed',
      bad: { ...ruleset, rules: (ruleset.rules ?? []).map((rule) => rule.type === 'required_status_checks'
        ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [] } } : rule) },
    },
    {
      label: 'non-fast-forward (force push) protection is removed',
      bad: { ...ruleset, rules: (ruleset.rules ?? []).filter((rule) => rule.type !== 'non_fast_forward') },
    },
    {
      label: 'ruleset enforcement is switched to "disabled"',
      bad: { ...ruleset, enforcement: 'disabled' },
    },
  ];

  for (const { label, bad } of rulesetFixtures) {
    const failures = assertRulesetBypass(bad);
    if (failures.length > 0) {
      console.log(`  ${G('✓')} Guard correctly FAILS when: ${label}`);
    } else {
      console.log(`  ${R('✗')} Guard still PASSES when: ${label} — this drift would go uncaught`);
      selfCheckFailed++;
    }
  }

  const branchFixtures: Array<{ label: string; bad: BranchState }> = [
    {
      label: 'classic branch protection reappears on main',
      bad: { ...branch, protection: { enabled: true } },
    },
  ];

  for (const { label, bad } of branchFixtures) {
    const failures = assertNoClassicProtection(bad);
    if (failures.length > 0) {
      console.log(`  ${G('✓')} Guard correctly FAILS when: ${label}`);
    } else {
      console.log(`  ${R('✗')} Guard still PASSES when: ${label} — this drift would go uncaught`);
      selfCheckFailed++;
    }
  }

  sep();
  if (selfCheckFailed === 0) {
    console.log(G('\n✓ Self-check passed: every known drift scenario makes this guard fail.\n'));
    process.exit(0);
  } else {
    console.log(R(`\n✗ Self-check FAILED: ${selfCheckFailed} drift scenario(s) were not caught.\n`));
    process.exit(1);
  }
}

function main(): void {
  const task = process.argv.includes('--self-check') ? selfCheck() : runRealCheck();
  task.catch((err) => {
    console.error(R(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}

main();
