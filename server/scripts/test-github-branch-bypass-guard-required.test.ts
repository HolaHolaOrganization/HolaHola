/**
 * The scheduled bypass monitor must not pass by skipping. Without its token the
 * guard skips (exit 0) by default, but FAILS (exit 1) inside the monitor
 * workflow (GITHUB_WORKFLOW equals its name) or with RULESET_MONITOR_REQUIRED=true.
 * No network is used: both paths exit before any GitHub request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GUARD = join(ROOT, 'server', 'scripts', 'test-github-branch-bypass-guard.ts');
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function runGuard(extraEnv: Record<string, string>, args: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ...extraEnv,
  };
  delete env.RULESET_MONITOR_TOKEN_GITHUB;
  const result = spawnSync(process.execPath, ['--import', 'tsx', GUARD, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(ANSI, '') };
}

for (const args of [[], ['--self-check']]) {
  const label = args.length ? 'self-check' : 'real check';
  test(`${label}: a missing token SKIPS by default`, () => {
    const result = runGuard({}, args);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /SKIP: RULESET_MONITOR_TOKEN_GITHUB not set/);
  });
  for (const [why, env] of [
    ['inside the monitor workflow', { GITHUB_WORKFLOW: 'GitHub branch bypass monitor' }],
    ['with RULESET_MONITOR_REQUIRED=true', { RULESET_MONITOR_REQUIRED: 'true' }],
  ] as const) {
    test(`${label}: a missing token FAILS ${why}`, () => {
      const result = runGuard(env, args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /Failing instead of skipping/);
      assert.doesNotMatch(result.out, /SKIP:/);
    });
  }
  test(`${label}: another workflow name still SKIPS`, () => {
    const result = runGuard({ GITHUB_WORKFLOW: 'CI' }, args);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /SKIP: RULESET_MONITOR_TOKEN_GITHUB not set/);
  });
}

test('the monitor workflow name matches MONITOR_WORKFLOW_NAME in the guard (a rename cannot silently disable fail-closed)', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'github-branch-bypass-monitor.yml'), 'utf8');
  const name = workflow.match(/^name:\s*(.+)$/m)?.[1].trim();
  const guard = readFileSync(GUARD, 'utf8');
  const pinned = guard.match(/MONITOR_WORKFLOW_NAME = '([^']+)'/)?.[1];
  assert.ok(name && pinned, 'both names must be present');
  assert.equal(name, pinned);
});
