/**
 * Fail-closed CODEOWNERS coverage check — standard-controls plan efb1e3d1
 * rev 10, A0.1 (PR #38 review).
 *
 * GitHub's codeowners/errors API proves syntax and owner validity, not that the
 * right paths are covered. This check resolves the effective owner of every
 * tracked file (last matching pattern wins, as GitHub does) and requires:
 *   - the founder is the ONLY owner of EVERY tracked file during the bootstrap
 *     (an additional listed owner could satisfy code-owner review alone), because the
 *     App-key broker runs in the main application process;
 *   - each named credential/auth/boot boundary below is founder-owned;
 *   - CODEOWNERS uses only the pattern forms this resolver understands, so an
 *     unsupported pattern fails instead of being misread;
 *   - TEMPORARY (D3, plan rev 13 step 3; shared-spec 5c823a71): exactly one
 *     exact anchored leaf, D3_PROBE_PATH, has ZERO owners, so a native
 *     cross-App review can be measured on an inert file. Every other ownerless
 *     rule is rejected by shape, whether or not it matches a tracked file today,
 *     and no REQUIRED_BOUNDARIES path can be exempted. The restore PR removes
 *     this exception.
 *
 * Usage: npx tsx server/scripts/test-codeowners-coverage.ts [--self-check]
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

export const FOUNDER = '@davidwmcintosh';

/** Boundaries named in review; each must stay founder-owned. */
export const REQUIRED_BOUNDARIES = [
  'server/index.ts',
  'server/routes.ts',
  'server/db.ts',
  'server/storage.ts',
  'server/replitAuth.ts',
  'server/googleAuth.ts',
  'server/middleware/rbac.ts',
  'server/middleware/coordination-auth.ts',
  'server/services/github-token-broker.ts',
  'server/services/github-token-broker-store.ts',
  'server/routes/github-token-broker-routes.ts',
  'server/services/coordination-credential-broker.ts',
  'server/services/runtime-onboarding-service.ts',
  'server/routes/runtime-onboarding-routes.ts',
  'server/services/instance-role.ts',
  'shared/schema.ts',
  'migrations/0066_ownership_promotion_contexts.sql',
  'scripts/render-predeploy.ts',
  'render.yaml',
  'Dockerfile',
  'package.json',
  'package-lock.json',
  '.github/CODEOWNERS',
  '.github/workflows/ci.yml',
];

/** D3 probe: the ONLY path allowed to have zero owners (temporary; see header). */
export const D3_PROBE_PATH = 'docs/probes/d3-cross-app-probe.txt';
const D3_PROBE_RULE = `/${D3_PROBE_PATH}`;

interface Rule { pattern: string; owners: string[]; line: number }

export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const [pattern, ...owners] = line.split(/\s+/);
    // Supported forms only: "*", "/exact/file", "/dir/".
    if (!(pattern === '*' || /^\/[A-Za-z0-9._\-/]+$/.test(pattern)) || pattern.includes('*', 1) || pattern.includes('..')) {
      throw new Error(`CODEOWNERS line ${index + 1}: unsupported pattern ${JSON.stringify(pattern)}`);
    }
    for (const owner of owners) {
      const user = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?$/;
      const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (!user.test(owner) && !email.test(owner)) {
        throw new Error(`CODEOWNERS line ${index + 1}: invalid owner ${JSON.stringify(owner)}`);
      }
    }
    rules.push({ pattern, owners, line: index + 1 });
  });
  return rules;
}

function matches(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  const anchored = pattern.slice(1);
  return pattern.endsWith('/') ? path.startsWith(anchored) : path === anchored;
}

/** Effective owners of `path`: the LAST matching rule wins (GitHub semantics). */
export function ownersOf(rules: Rule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (matches(rule.pattern, path)) owners = rule.owners;
  return owners;
}

export function coverageFailures(
  text: string,
  trackedFiles: string[],
  boundaries: readonly string[] = REQUIRED_BOUNDARIES,
): string[] {
  let rules: Rule[];
  try {
    rules = parseCodeowners(text);
  } catch (error) {
    return [(error as Error).message];
  }
  const failures: string[] = [];
  if (boundaries.includes(D3_PROBE_PATH)) failures.push(`${D3_PROBE_PATH} cannot be a required boundary`);
  // Rule SHAPE: only the exact D3 leaf may be ownerless, and only once.
  const ownerless = rules.filter((rule) => rule.owners.length === 0);
  for (const rule of ownerless) {
    if (rule.pattern !== D3_PROBE_RULE) {
      failures.push(`ownerless rule ${rule.pattern} (line ${rule.line}) is not the D3 probe leaf`);
    }
  }
  if (ownerless.filter((rule) => rule.pattern === D3_PROBE_RULE).length > 1) {
    failures.push(`${D3_PROBE_RULE} is listed more than once`);
  }
  for (const path of new Set([...trackedFiles, ...boundaries])) {
    const owners = ownersOf(rules, path);
    if (path === D3_PROBE_PATH) {
      if (owners.length !== 0) failures.push(`${path} must have zero owners (owners: ${owners.join(' ')})`);
      continue;
    }
    // Founder-ONLY: any additional listed owner could satisfy code-owner review alone.
    if (owners.length !== 1 || owners[0] !== FOUNDER) {
      failures.push(`${path} must be owned by ${FOUNDER} alone (owners: ${owners.join(' ') || 'none'})`);
    }
  }
  return failures;
}

function selfCheck(text: string, tracked: string[]): string[] {
  const problems: string[] = [];
  const expectFailure = (label: string, mutated: string, mustMention: string) => {
    const failures = coverageFailures(mutated, tracked);
    if (!failures.some((f) => f.includes(mustMention))) problems.push(`negative case did not fail: ${label}`);
  };
  const withoutCatchAll = text.replace(/^\*\s+@davidwmcintosh\s*$/m, '');
  expectFailure('catch-all removed (an unlisted file loses its owner)', withoutCatchAll, 'client/');
  expectFailure('catch-all and /server/ removed (replitAuth.ts unowned)',
    withoutCatchAll.replace(/^\/server\/\s+@davidwmcintosh\s*$/m, ''), 'server/replitAuth.ts');
  expectFailure('a later rule hands server/db.ts to someone else', `${text}\n/server/db.ts @someone-else\n`, 'server/db.ts');
  expectFailure('a later rule leaves server/routes.ts ownerless', `${text}\n/server/routes.ts\n`, 'server/routes.ts');
  expectFailure('an unsupported glob pattern', `${text}\nserver/**/*.ts @davidwmcintosh\n`, 'unsupported pattern');
  expectFailure('founder PLUS another owner on server/db.ts', `${text}\n/server/db.ts @davidwmcintosh @someone-else\n`, 'server/db.ts');
  expectFailure('founder PLUS a team on the catch-all',
    text.replace(/^\*\s+@davidwmcintosh\s*$/m, '* @davidwmcintosh @org/team').replace(/^\/server\/\s+@davidwmcintosh\s*$/m, ''),
    'server/replitAuth.ts');
  expectFailure('an invalid owner token', `${text}\n/server/db.ts @davidwmcintosh not-an-owner\n`, 'invalid owner');
  // D3 exception: exactly one exact anchored leaf may be ownerless.
  const probeRule = /^\/docs\/probes\/d3-cross-app-probe\.txt\s*$/m;
  expectFailure('D3: the exception widened to a directory rule', `${text}\n/docs/probes/\n`, 'ownerless rule /docs/probes/ ');
  expectFailure('D3: a second ownerless leaf that is not tracked', `${text}\n/docs/never-tracked.txt\n`, 'ownerless rule /docs/never-tracked.txt');
  expectFailure('D3: an ownerless sibling of the probe', `${text}\n/docs/probes/other.txt\n`, 'ownerless rule /docs/probes/other.txt');
  expectFailure('D3: the probe given a non-founder owner', text.replace(probeRule, `${D3_PROBE_RULE} @someone-else`), `${D3_PROBE_PATH} must have zero owners`);
  expectFailure('D3: the probe given the founder plus another owner', text.replace(probeRule, `${D3_PROBE_RULE} @davidwmcintosh @someone-else`), `${D3_PROBE_PATH} must have zero owners`);
  expectFailure('D3: the probe rule removed (the probe falls back to the founder)', text.replace(probeRule, ''), `${D3_PROBE_PATH} must have zero owners`);
  expectFailure('D3: a required boundary left ownerless', `${text}\n/server/db.ts\n`, 'ownerless rule /server/db.ts');
  expectFailure('D3: the leaf with a different case', `${text}\n/docs/probes/D3-cross-app-probe.txt\n`, 'ownerless rule /docs/probes/D3-cross-app-probe.txt');
  expectFailure('D3: the leaf without its leading slash', `${text}\ndocs/probes/d3-cross-app-probe.txt\n`, 'unsupported pattern');
  expectFailure('D3: the probe rule listed twice', `${text}\n${D3_PROBE_RULE}\n`, 'listed more than once');
  if (!coverageFailures(text, tracked, [...REQUIRED_BOUNDARIES, D3_PROBE_PATH]).some((f) => f.includes('cannot be a required boundary'))) {
    problems.push('negative case did not fail: D3: the probe added to REQUIRED_BOUNDARIES');
  }
  return problems;
}

/** Number of negative cases selfCheck runs (8 baseline + 11 D3). */
const SELF_CHECK_CASES = 19;

/** The probe must be a regular, non-executable tracked file (git mode 100644), not a symlink. */
function probeFileFailures(): string[] {
  const entry = execFileSync('git', ['ls-files', '-s', '--', D3_PROBE_PATH], { encoding: 'utf8' }).trim();
  if (!entry) return [];
  const failures: string[] = [];
  if (!entry.startsWith('100644 ')) failures.push(`${D3_PROBE_PATH} must be a regular non-executable file (git: ${entry.split(' ')[0]})`);
  if (lstatSync(D3_PROBE_PATH).isSymbolicLink()) failures.push(`${D3_PROBE_PATH} must not be a symlink`);
  return failures;
}

function main(): void {
  const text = readFileSync('.github/CODEOWNERS', 'utf8');
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const failures = [...coverageFailures(text, tracked), ...probeFileFailures()];
  if (failures.length) {
    console.error(`CODEOWNERS coverage FAILED (${failures.length}):`);
    for (const failure of failures.slice(0, 50)) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const probeNote = tracked.includes(D3_PROBE_PATH) ? `, except the D3 probe ${D3_PROBE_PATH} (zero owners)` : '';
  console.log(`CODEOWNERS coverage PASS: ${tracked.length} tracked files and ${REQUIRED_BOUNDARIES.length} named boundaries owned by ${FOUNDER}${probeNote}.`);
  if (process.argv.includes('--self-check')) {
    const problems = selfCheck(text, tracked);
    if (problems.length) {
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`CODEOWNERS coverage self-check PASS: ${SELF_CHECK_CASES} deliberate removals/overrides/additions each fail.`);
  }
}

main();
