// Production write boundary for Alden (gated-fixes design e4f8e988): file
// writes and shell only when the instance role is exactly `dev`; the code
// search runs rg without a shell.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import { ALDEN_WRITE_TOOLS, aldenWriteBoundary, aldenWriteToolRefusal } from './alden-write-boundary';

const ROLE = 'HOLAHOLA_INSTANCE_ROLE';

// Importing the review service pulls in modules that start module-level
// intervals (voice diagnostics, production telemetry, sync auth, session
// compass). They play no part here; unref them in this file so node --test can
// exit. The services' own interval behaviour is unchanged.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => realSetInterval(...args).unref()) as typeof setInterval;

// The services open the shared pool on import; close it so node --test can exit
// (see .agents/memory/pg-pool-idle-timeout-ci-hang.md).
after(async () => {
  const { closeDbConnections } = await import('../db');
  await closeDbConnections();
});

// Fixture target for the write paths: outside the repository, so even a broken
// trap could never touch source.
const OUTSIDE_REPO = path.join(os.tmpdir(), 'alden-write-boundary-fixture', 'target.ts');

function withRole<T>(role: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[ROLE];
  if (role === undefined) delete process.env[ROLE]; else process.env[ROLE] = role;
  return fn().finally(() => {
    if (before === undefined) delete process.env[ROLE]; else process.env[ROLE] = before;
  });
}

// Every source-write, rename, delete, process and git-sync primitive, trapped so
// any call fails the test (a later restore cannot hide a write).
async function trapWritePrimitives(): Promise<string[]> {
  const { SourceControlService } = await import('./source-control-service');
  const calls: string[] = [];
  const trap = (name: string) => () => { calls.push(name); throw new Error(`${name} must not run`); };
  for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'copyFileSync', 'unlinkSync', 'unlink', 'rmSync'] as const) {
    mock.method(fs, name, trap(`fs.${name}`));
  }
  for (const name of ['writeFile', 'rename', 'copyFile', 'unlink', 'rm'] as const) {
    mock.method(fs.promises, name, trap(`fs.promises.${name}`));
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    mock.method(childProcess, name, trap(`child_process.${name}`));
  }
  mock.method(SourceControlService.prototype, 'sync', trap('SourceControlService.sync'));
  // The services import fs and child_process as ES modules; their named
  // bindings see a mock only after this sync.
  syncBuiltinESMExports();
  return calls;
}

function restoreWritePrimitives(): void {
  mock.restoreAll();
  syncBuiltinESMExports();
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
  afterEach(restoreWritePrimitives);

  for (const role of ['production', undefined]) {
    test(`write tools are refused before any write primitive runs (role ${role ?? 'missing'})`, async () => {
      const { executeAldenTool } = await import('./alden-functions');
      const calls = await trapWritePrimitives();
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
    const end = src.indexOf('const result = fallbackCodeSearch(', start);
    const body = src.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.match(body, /execFileSync\('rg', rgArgs, \{/);
    assert.doesNotMatch(body, /execSync\(|shell:/);
    assert.match(body, /rgArgs\.push\('-e', pattern, '--', \.\.\.roots\)/);
  });
});

// runReviewQueue itself (P0b) is driven in alden-review-approval.test.ts against
// a pinned fixture workspace.

describe('auto-repair, driven through attemptAutoRepair itself', () => {
  afterEach(restoreWritePrimitives);

  function fakeRepair(filePath: string) {
    const proposals: string[][] = [];
    const notices: string[][] = [];
    const deps = {
      classify: async () => ({ eligible: true, type: 'null_guard' as const, confidence: 'high' as const, reason: 'clear null guard' }),
      plan: async () => ({
        repairId: 'repair-1', issueDescription: 'issue', repairType: 'null_guard' as const, explanation: 'add a guard',
        changes: [{ filePath, originalContent: 'a\n', newContent: 'b\n', description: 'guard' }],
      }),
      queueProposal: async (...args: string[]) => { proposals.push(args); return true; },
      notify: async (...args: string[]) => { notices.push(args); },
    };
    return { deps, proposals, notices };
  }

  for (const role of ['production', undefined]) {
    test(`under role ${role ?? 'missing'} the plan is queued; no manifest, guardian or file write`, async () => {
      const { attemptAutoRepair } = await import('./alden-auto-repair');
      const { deps, proposals, notices } = fakeRepair(OUTSIDE_REPO);
      const calls = await trapWritePrimitives();
      const initiated = await withRole(role, () => attemptAutoRepair('issue', '', deps));
      assert.deepEqual(calls, []);
      assert.equal(initiated, false);
      assert.equal(proposals.length, 1);
      assert.match(proposals[0][1], /add a guard/);
      assert.equal(notices.length, 1);
      assert.match(notices[0][0], /^Auto-repair proposed, not applied/);
    });
  }

  test('positive control: under dev the same plan reaches the trapped manifest write', async () => {
    const { attemptAutoRepair } = await import('./alden-auto-repair');
    const { deps, proposals } = fakeRepair(OUTSIDE_REPO);
    const calls = await trapWritePrimitives();
    const initiated = await withRole('dev', () => attemptAutoRepair('issue', '', deps));
    restoreWritePrimitives();
    assert.deepEqual(calls, ['fs.writeFileSync']);
    assert.equal(initiated, false);
    assert.equal(proposals.length, 0);
  });
});

test('auto-repair never claims "queued" when the real default queue insert fails', async () => {
  // The real default queueAsProposal runs, with a database handle whose insert
  // fails. That is deterministic everywhere: CI has a reachable database, so an
  // "unreachable DB" assumption would not hold there.
  const { attemptAutoRepair, queueAsProposal } = await import('./alden-auto-repair');
  const failingDb = { insert: () => ({ values: async () => { throw new Error('synthetic insert failure'); } }) } as any;
  const notices: Array<[string, string]> = [];
  const deps = {
    queueProposal: (issue: string, reason: string) => queueAsProposal(issue, reason, failingDb),
    classify: async () => ({ eligible: true, type: 'null_guard' as const, confidence: 'high' as const, reason: 'clear null guard' }),
    plan: async () => ({
      repairId: 'repair-q', issueDescription: 'issue', repairType: 'null_guard' as const, explanation: 'add a guard',
      changes: [{ filePath: OUTSIDE_REPO, originalContent: 'a\n', newContent: 'b\n', description: 'guard' }],
    }),
    notify: async (content: string, severity: string) => { notices.push([content, severity]); },
  };
  const calls = await trapWritePrimitives();
  try {
    const initiated = await withRole('production', () => attemptAutoRepair('issue', '', deps as any));
    assert.equal(initiated, false);
  } finally {
    restoreWritePrimitives();
  }
  assert.deepEqual(calls, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], 'alert');
  assert.match(notices[0][0], /could NOT be saved for review/);
  assert.doesNotMatch(notices[0][0], /The plan is queued for review/);
});

test('the real default queueAsProposal reports success only when its insert succeeds', async () => {
  const { queueAsProposal } = await import('./alden-auto-repair');
  const inserted: unknown[] = [];
  const okDb = { insert: () => ({ values: async (v: unknown) => { inserted.push(v); } }) } as any;
  const failingDb = { insert: () => ({ values: async () => { throw new Error('synthetic insert failure'); } }) } as any;
  assert.equal(await queueAsProposal('issue', 'reason', okDb), true);
  assert.equal(inserted.length, 1);
  assert.equal(await queueAsProposal('issue', 'reason', failingDb), false);
});
