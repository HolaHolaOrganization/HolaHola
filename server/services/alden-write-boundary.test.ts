// Production write boundary for Alden (gated-fixes design e4f8e988): file
// writes and shell only when the instance role is exactly `dev`; the code
// search runs rg without a shell.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { ALDEN_WRITE_TOOLS, aldenWriteBoundary, aldenWriteToolRefusal } from './alden-write-boundary';

const ROLE = 'HOLAHOLA_INSTANCE_ROLE';

function withRole<T>(role: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[ROLE];
  if (role === undefined) delete process.env[ROLE]; else process.env[ROLE] = role;
  return fn().finally(() => {
    if (before === undefined) delete process.env[ROLE]; else process.env[ROLE] = before;
  });
}

describe('the boundary itself', () => {
  test('only the exact `dev` role may write', () => {
    assert.deepEqual(aldenWriteBoundary({ [ROLE]: 'dev' }), { allowed: true });
    assert.equal(aldenWriteBoundary({ [ROLE]: 'production' }).allowed, false);
    for (const env of [{}, { [ROLE]: '' }, { [ROLE]: 'Dev' }, { [ROLE]: 'staging' }]) {
      const b = aldenWriteBoundary(env);
      assert.equal(b.allowed, false);
      assert.equal(b.allowed === false && b.role, 'unknown', JSON.stringify(env));
    }
  });

  test('refuses exactly the write tools outside dev, with the reason', () => {
    assert.deepEqual([...ALDEN_WRITE_TOOLS].sort(), ['apply_code_change', 'patch_file', 'run_shell']);
    for (const tool of ALDEN_WRITE_TOOLS) {
      assert.equal(aldenWriteToolRefusal(tool, { [ROLE]: 'dev' }), null);
      assert.equal(aldenWriteToolRefusal(tool, { [ROLE]: 'production' })?.refused, 'production_write_disabled');
      assert.equal(aldenWriteToolRefusal(tool, {})?.refused, 'instance_role_unknown');
    }
    assert.equal(aldenWriteToolRefusal('read_file', { [ROLE]: 'production' }), null);
  });
});

describe('enforcement in executeAldenTool', () => {
  afterEach(() => mock.restoreAll());

  for (const role of ['production', undefined]) {
    test(`write tools are refused before any write primitive runs (role ${role ?? 'missing'})`, async () => {
      const { executeAldenTool } = await import('./alden-functions');
      const calls: string[] = [];
      const trap = (name: string) => () => { calls.push(name); throw new Error(`${name} must not run`); };
      mock.method(fs, 'writeFileSync', trap('fs.writeFileSync'));
      mock.method(fs, 'mkdirSync', trap('fs.mkdirSync'));
      mock.method(childProcess, 'execSync', trap('execSync'));
      mock.method(childProcess, 'execFileSync', trap('execFileSync'));
      mock.method(childProcess, 'spawn', trap('spawn'));
      mock.method(childProcess, 'spawnSync', trap('spawnSync'));
      await withRole(role, async () => {
        for (const tool of ALDEN_WRITE_TOOLS) {
          const result = await executeAldenTool(tool, {
            command: 'echo should-not-run', path: 'server/x.ts', file_path: 'server/x.ts',
            content: 'x', old_string: 'a', new_string: 'b', description: 'test',
          });
          assert.equal(result.data.refused, role ? 'production_write_disabled' : 'instance_role_unknown', tool);
          assert.equal(result.sideEffects, undefined, `${tool} produced no side effects`);
        }
      });
      assert.deepEqual(calls, []);
    });
  }

  test('the per-turn allowlist is still checked first', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    const { makeAldenToolAllowlist } = await import('./alden-tool-allowlist');
    await withRole('production', async () => {
      const result = await executeAldenTool('run_shell', { command: 'echo x' }, { toolAllowlist: makeAldenToolAllowlist('t', ['read_file']) });
      assert.equal(result.data.refused, 'tool_not_allowed');
    });
  });
});

describe('code search runs rg without a shell', () => {
  test('a shell-shaped file_glob or pattern is never executed', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    const sentinel = path.join(os.tmpdir(), `alden-glob-injection-${process.pid}-${Date.now()}`);
    try {
      await withRole('production', async () => {
        const probe = await executeAldenTool('search_code', { pattern: 'pgTable', directory: 'shared', file_glob: '*.ts' });
        // CI installs ripgrep, so there this exercises rg itself, not the JS fallback.
        if (process.env.CI) assert.doesNotMatch(String(probe.data.note ?? ''), /fallback/, 'rg ran');
        assert.ok(probe.data.matchCount > 0, 'an ordinary glob still matches');
        await executeAldenTool('search_code', { pattern: 'zzqq', directory: 'shared', file_glob: `*.zz;touch ${sentinel}` });
        await executeAldenTool('search_code', { pattern: 'zzqq', directory: 'shared', file_glob: `$(touch ${sentinel})` });
        await executeAldenTool('search_code', { pattern: `'; touch ${sentinel}; '`, directory: 'shared', context_lines: 1 });
      });
      assert.equal(fs.existsSync(sentinel), false, 'the injected command ran');
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('runCodeSearch uses execFileSync with an argument array and no shell', () => {
    const src = fs.readFileSync(new URL('./alden-functions.ts', import.meta.url), 'utf8');
    const start = src.indexOf('function runCodeSearch(');
    const end = src.indexOf('fallbackCodeSearch(pattern, searchDir', start);
    const body = src.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.match(body, /execFileSync\('rg', rgArgs, \{/);
    assert.doesNotMatch(body, /execSync\(|shell:/);
    assert.match(body, /rgArgs\.push\('-e', pattern, '--', searchDir\)/);
  });
});

describe('the other write paths check the boundary first', () => {
  const repair = fs.readFileSync(new URL('./alden-auto-repair.ts', import.meta.url), 'utf8');
  const review = fs.readFileSync(new URL('./alden-code-review-service.ts', import.meta.url), 'utf8');

  test('auto-repair queues the plan outside dev, before any manifest, guardian or file write', () => {
    const start = repair.indexOf('export async function attemptAutoRepair(');
    const gate = repair.indexOf('const boundary = aldenWriteBoundary();', start);
    const branch = repair.slice(gate, repair.indexOf('return false;', gate));
    assert.ok(start > 0 && gate > start);
    assert.match(branch, /await queueAsProposal\(issueDescription,/);
    for (const write of ['fs.writeFileSync(GUARDIAN_MANIFEST_PATH', 'spawn(process.execPath', 'fs.writeFileSync(change.filePath', 'Auto-repair initiated']) {
      const at = repair.indexOf(write, start);
      assert.ok(at > gate, `${write} comes after the boundary`);
    }
  });

  test('the review queue never applies or syncs outside dev; unknown escalates', () => {
    const start = review.indexOf('export async function runReviewQueue(');
    const gate = review.indexOf('const boundary = aldenWriteBoundary();', start);
    const branchEnd = review.indexOf('continue;', gate);
    const branch = review.slice(gate, branchEnd);
    assert.ok(start > 0 && gate > start && branchEnd > gate);
    assert.ok(review.indexOf('applyPatch(change.filePath', start) > branchEnd);
    assert.ok(review.indexOf("requestSourceControlSync('alden-code-review')", start) > branchEnd);
    assert.match(branch, /status: boundary\.role === 'unknown' \? 'escalated' : 'approved'/);
    assert.doesNotMatch(branch, /'applied'|applyPatch|requestSourceControlSync/);
    assert.match(branch, /appliedAt: null,\s+githubSynced: false/);
  });
});
