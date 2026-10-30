// The code-review queue's approve path (gated-fixes design e4f8e988, P0b),
// driven through runReviewQueue itself against a throwaway git workspace,
// with the write, rename, delete, process and sync primitives trapped.
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, mock, test } from 'node:test';
import { reviewedChangeAsEdit } from './alden-review-approval';

// Importing the review service pulls in modules with module-level intervals;
// unref them here so node --test can exit. Their own behaviour is unchanged.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => realSetInterval(...args).unref()) as typeof setInterval;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-review-approval-'));
const root = path.join(base, 'ws');
after(async () => {
  fs.rmSync(base, { recursive: true, force: true });
  const { closeDbConnections } = await import('../db');
  await closeDbConnections();
});

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
const FILES: Record<string, string> = {
  'server/routes.ts': lines(30, 'route'),
  'server/repeat.ts': '}\n'.repeat(60),
  '.agents/memory/m.md': lines(5, 'm'),
  '.agents/skills/k.md': lines(5, 'k'),
  '.github/workflows/ci.yml': lines(5, 'w'),
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
fs.mkdirSync(root, { recursive: true });
for (const [rel, content] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
let symlinkMade = false;
try {
  fs.symlinkSync(path.join(root, '.agents', 'memory'), path.join(root, 'server', 'mem'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkMade = true;
} catch { /* symlinks unavailable */ }
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
const HEAD = git('rev-parse', 'HEAD');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'release-manifest.json'), JSON.stringify({
  schemaVersion: 1, authority: 'build', promotable: true, commitSha: HEAD, commitSource: 'render-build-input',
  sourceContextSha256: 'e'.repeat(64), sourceContextAlgorithm: 'sha256(path-nul-kind-nul-bytes-nul-v1)', sourceFileCount: 5, dirtyWorktree: false,
}));

const ENV = {
  production: { HOLAHOLA_INSTANCE_ROLE: 'production' },
  dev: { HOLAHOLA_INSTANCE_ROLE: 'dev' },
  missing: {},
  unknown: { HOLAHOLA_INSTANCE_ROLE: 'staging' },
} as Record<string, NodeJS.ProcessEnv>;

async function trap(options: { processes: boolean }): Promise<string[]> {
  const { SourceControlService } = await import('./source-control-service');
  const calls: string[] = [];
  const fail = (name: string) => () => { calls.push(name); throw new Error(`${name} must not run`); };
  for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'copyFileSync', 'unlinkSync', 'unlink', 'rmSync'] as const) mock.method(fs, name, fail(`fs.${name}`));
  for (const name of ['writeFile', 'rename', 'copyFile', 'unlink', 'rm'] as const) mock.method(fs.promises, name, fail(`fs.promises.${name}`));
  if (options.processes) {
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, name, fail(`child_process.${name}`));
  }
  mock.method(SourceControlService.prototype, 'sync', fail('SourceControlService.sync'));
  syncBuiltinESMExports();
  return calls;
}
function restore(): void {
  mock.restoreAll();
  syncBuiltinESMExports();
}

function reviewed(filePath: string, lineStart: number, lineEnd: number, afterCode: string) {
  const original = FILES[filePath] ?? fs.readFileSync(path.join(root, filePath), 'utf8');
  return {
    id: `change-${Math.random().toString(16).slice(2, 10)}`, findingTitle: 'test finding', findingDescription: 'd', findingSeverity: 'low',
    filePath, lineStart, lineEnd, beforeCode: original.split('\n').slice(lineStart - 1, lineEnd).join('\n'),
    afterCode, patchRationale: 'r', status: 'pending_review',
  } as any;
}

function harness(change: any, env: NodeJS.ProcessEnv, overrides: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  const stored: any[] = [];
  const blocked: string[] = [];
  const decisions: unknown[][] = [];
  const deps = {
    db: {
      select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [change] }) }) }),
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push(values); } }) }),
    } as any,
    loadMemory: async () => '',
    review: async () => ({ decision: 'approve' as const, reason: 'looks right' }),
    postDecision: async (...args: unknown[]) => { decisions.push(args); },
    root,
    env,
    storeProposal: async (input: any) => { stored.push(input); return { id: 'bq-1' }; },
    notifyBlocked: async (_change: unknown, reason: string) => { blocked.push(reason); },
    ...overrides,
  };
  return { deps, updates, stored, blocked, decisions };
}

describe('runReviewQueue approvals by role', () => {
  afterEach(restore);

  test('production stores one release-pinned proposal and links it; nothing is written or synced', async () => {
    const { runReviewQueue } = await import('./alden-code-review-service');
    const { deps, updates, stored, blocked } = harness(reviewed('server/routes.ts', 10, 10, 'route ten'), ENV.production);
    const calls = await trap({ processes: true });
    const summary = await runReviewQueue(deps);
    restore();
    assert.deepEqual(calls, []);
    assert.equal(summary.applied, 0);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].change.pin.kind, 'release');
    assert.equal(stored[0].change.pin.commit, HEAD);
    assert.deepEqual(stored[0].change.pin.files.map((f: any) => f.path), ['server/routes.ts']);
    assert.match(stored[0].change.diff, /^-route 10\n\+route ten$/m);
    assert.deepEqual(blocked, []);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'approved_pending_review');
    assert.equal(updates[0].buildQueueId, 'bq-1');
    assert.equal(updates[0].appliedAt, null);
    assert.equal(updates[0].githubSynced, false);
  });

  for (const role of ['missing', 'unknown'] as const) {
    test(`an ${role} role is review_blocked with the reason and a notice; no proposal, pin, write or sync`, async () => {
      const { runReviewQueue } = await import('./alden-code-review-service');
      const { deps, updates, stored, blocked } = harness(reviewed('server/routes.ts', 10, 10, 'x'), ENV[role]);
      const calls = await trap({ processes: true });
      await runReviewQueue(deps);
      restore();
      assert.deepEqual(calls, []);
      assert.equal(stored.length, 0);
      assert.equal(updates[0].status, 'review_blocked');
      assert.equal(updates[0].buildQueueId, undefined);
      assert.match(String(updates[0].reviewerNotes), /instance role unknown; cannot pin/);
      assert.deepEqual(blocked, ['instance role unknown; cannot pin a proposal']);
    });
  }

  test('production: a stale before-code or a failed store is review_blocked, never applied', async () => {
    const { runReviewQueue } = await import('./alden-code-review-service');
    const stale = { ...reviewed('server/routes.ts', 5, 5, 'x'), beforeCode: 'route 999' };
    const one = harness(stale, ENV.production);
    let calls = await trap({ processes: true });
    await runReviewQueue(one.deps);
    restore();
    assert.deepEqual(calls, []);
    assert.equal(one.updates[0].status, 'review_blocked');
    assert.match(String(one.updates[0].reviewerNotes), /stale base/);

    const two = harness(reviewed('server/routes.ts', 6, 6, 'x'), ENV.production, { storeProposal: async () => { throw new Error('stale base: server/routes.ts changed'); } });
    calls = await trap({ processes: true });
    await runReviewQueue(two.deps);
    restore();
    assert.deepEqual(calls, []);
    assert.equal(two.updates[0].status, 'review_blocked');
    assert.match(String(two.updates[0].reviewerNotes), /could not be stored: stale base/);
  });

  test('positive control: dev with a clean pin reaches the trapped file write', async () => {
    const { runReviewQueue } = await import('./alden-code-review-service');
    const { deps, updates, stored } = harness(reviewed('server/routes.ts', 12, 12, 'twelve'), ENV.dev);
    const calls = await trap({ processes: false });
    await runReviewQueue(deps);
    restore();
    assert.deepEqual(calls, ['fs.writeFileSync']);
    assert.equal(stored.length, 0);
    assert.equal(updates[0].status, 'approved', 'the trapped write failed, so nothing was applied');
    assert.match(String(updates[0].reviewerNotes), new RegExp(`Pinned to dev-head ${HEAD}`));
  });

  test('dev with a dirty file is review_blocked before any write', async () => {
    const { runReviewQueue } = await import('./alden-code-review-service');
    fs.appendFileSync(path.join(root, 'server/routes.ts'), 'dirty\n');
    try {
      const { deps, updates } = harness(reviewed('server/routes.ts', 3, 3, 'x'), ENV.dev);
      const calls = await trap({ processes: false });
      await runReviewQueue(deps);
      restore();
      assert.deepEqual(calls, []);
      assert.equal(updates[0].status, 'review_blocked');
      assert.match(String(updates[0].reviewerNotes), /working copy differs from HEAD for server\/routes\.ts/);
    } finally {
      restore();
      git('checkout', '--', 'server/routes.ts');
    }
  });
});

describe('the read-only roots are never a target, in any role', () => {
  afterEach(restore);
  const targets = ['.agents/memory/m.md', '.agents/skills/k.md', '.github/workflows/ci.yml', 'docs/../.agents/memory/m.md'];

  for (const role of ['production', 'dev'] as const) {
    test(`${role}: each root, directly or through an alias or symlink, is review_blocked with no write or sync`, async (t) => {
      const { runReviewQueue } = await import('./alden-code-review-service');
      const all = symlinkMade ? [...targets, 'server/mem/m.md'] : targets;
      if (!symlinkMade) t.diagnostic('symlink alias skipped: symlinks unavailable');
      for (const filePath of all) {
        const change = { ...reviewed(filePath.replace(/^docs\/\.\.\//, '').replace(/^server\/mem\//, '.agents/memory/'), 2, 2, 'x'), filePath };
        const { deps, updates, stored } = harness(change, ENV[role]);
        const calls = await trap({ processes: role === 'production' });
        await runReviewQueue(deps);
        restore();
        assert.deepEqual(calls, [], filePath);
        assert.equal(stored.length, 0, filePath);
        assert.equal(updates[0].status, 'review_blocked', filePath);
        assert.match(String(updates[0].reviewerNotes), /read-only directory/, filePath);
      }
    });
  }
});

describe('reviewedChangeAsEdit', () => {
  test('grows the find with unchanged context until it is unique', () => {
    const original = FILES['server/repeat.ts'].replace(/\}\n/, 'start\n');
    const edit = reviewedChangeAsEdit('f', original, { lineStart: 2, lineEnd: 2, beforeCode: '}', afterCode: '};' } as any);
    // Context grows one line each way per step: line 1 above, line 3 below.
    assert.equal(edit.find, 'start\n}\n}');
    assert.equal(edit.replace, 'start\n};\n}');
  });

  test('refuses a range that never becomes unique, a stale before-code and an out-of-range line', () => {
    assert.throws(() => reviewedChangeAsEdit('f', FILES['server/repeat.ts'], { lineStart: 30, lineEnd: 30, beforeCode: '}', afterCode: '};' } as any), /not unique/);
    assert.throws(() => reviewedChangeAsEdit('f', 'a\nb\n', { lineStart: 1, lineEnd: 1, beforeCode: 'z', afterCode: 'y' } as any), /stale base/);
    assert.throws(() => reviewedChangeAsEdit('f', 'a\nb\n', { lineStart: 5, lineEnd: 6, beforeCode: '', afterCode: 'y' } as any), /outside the pinned file/);
  });
});
