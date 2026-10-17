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
 *     unsupported pattern fails instead of being misread.
 *
 * Usage: npx tsx server/scripts/test-codeowners-coverage.ts [--self-check]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

export function coverageFailures(text: string, trackedFiles: string[]): string[] {
  let rules: Rule[];
  try {
    rules = parseCodeowners(text);
  } catch (error) {
    return [(error as Error).message];
  }
  const failures: string[] = [];
  for (const path of new Set([...trackedFiles, ...REQUIRED_BOUNDARIES])) {
    const owners = ownersOf(rules, path);
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
  return problems;
}

function main(): void {
  const text = readFileSync('.github/CODEOWNERS', 'utf8');
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const failures = coverageFailures(text, tracked);
  if (failures.length) {
    console.error(`CODEOWNERS coverage FAILED (${failures.length}):`);
    for (const failure of failures.slice(0, 50)) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`CODEOWNERS coverage PASS: ${tracked.length} tracked files and ${REQUIRED_BOUNDARIES.length} named boundaries owned by ${FOUNDER}.`);
  if (process.argv.includes('--self-check')) {
    const problems = selfCheck(text, tracked);
    if (problems.length) {
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log('CODEOWNERS coverage self-check PASS: 8 deliberate removals/overrides/additions each fail.');
  }
}

main();
