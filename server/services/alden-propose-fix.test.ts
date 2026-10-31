// propose_fix (gated-fixes design e4f8e988, P1): gates, pins, diff and
// storage, against a throwaway git workspace. Nothing is ever written to a
// source file; the store is an in-memory fake (the SQL path is covered by
// alden-propose-fix-postgres.test.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  applyEditsToOriginal, buildPinnedChange, groupEditsByResolvedPath, parseConfidence, pinSourceForRole,
  ProposeFixRefusal, recheckPin, unifiedDiff,
} from './alden-propose-fix';
import { notifyStoredProposal, proposeFix } from './alden-propose-fix-service';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-propose-fix-'));
const root = path.join(base, 'ws');
const outside = path.join(base, 'outside');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
const FILES: Record<string, string> = {
  'server/a.ts': lines(30, 'a'),
  'server/b.ts': lines(10, 'b'),
  'server/c.ts': lines(10, 'c'),
  'server/d.ts': lines(10, 'd'),
  'server/twice.ts': 'same\nsame\n',
  'server/routes.ts': lines(5, 'r'),
  'docs/n.md': lines(5, 'n'),
  '.agents/memory/m.md': lines(5, 'm'),
  '.github/workflows/ci.yml': lines(5, 'w'),
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
fs.mkdirSync(root, { recursive: true });
for (const [rel, content] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'x.ts'), 'outside\n');
let symlinkMade = false;
try {
  fs.symlinkSync(path.join(root, '.agents', 'memory'), path.join(root, 'server', 'mem'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkMade = true;
} catch { /* symlinks unavailable */ }
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
const HEAD = git('rev-parse', 'HEAD');
const DEV = { HOLAHOLA_INSTANCE_ROLE: 'dev' } as NodeJS.ProcessEnv;
const PROD = { HOLAHOLA_INSTANCE_ROLE: 'production' } as NodeJS.ProcessEnv;
const edit = (p: string, find: string, replace: string) => ({ path: p, find, replace });

function writeManifest(overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'release-manifest.json'), JSON.stringify({
    schemaVersion: 1, authority: 'build', promotable: true, commitSha: 'f'.repeat(40), commitSource: 'render-build-input',
    sourceContextSha256: 'e'.repeat(64), sourceContextAlgorithm: 'sha256(path-nul-kind-nul-bytes-nul-v1)', sourceFileCount: 9, dirtyWorktree: false,
    ...overrides,
  }));
}

function refuses(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: any) => err instanceof ProposeFixRefusal && pattern.test(err.message), String(pattern));
}

describe('edit gates', () => {
  test('confidence is required and must be low, medium or high', () => {
    for (const bad of [undefined, '', 'certain', 'HIGH', 3]) refuses(() => parseConfidence(bad), /confidence is required/);
    assert.equal(parseConfidence('medium'), 'medium');
  });

  test('blocklisted, read-only and escaping targets are refused after resolution', (t) => {
    refuses(() => groupEditsByResolvedPath([edit('server/routes.ts', 'r 1', 'x')], root), /blocklist/);
    refuses(() => groupEditsByResolvedPath([edit('server/../server/routes.ts', 'r 1', 'x')], root), /blocklist/);
    refuses(() => groupEditsByResolvedPath([edit('.agents/memory/m.md', 'm 1', 'x')], root), /read-only/);
    refuses(() => groupEditsByResolvedPath([edit('docs/../.github/workflows/ci.yml', 'w 1', 'x')], root), /read-only/);
    refuses(() => groupEditsByResolvedPath([edit('../outside/x.ts', 'outside', 'x')], root), /outside/);
    refuses(() => groupEditsByResolvedPath([edit(path.join(root, 'server/a.ts'), 'a 1', 'x')], root), /absolute/);
    if (!symlinkMade) return t.skip('symlinks unavailable');
    refuses(() => groupEditsByResolvedPath([edit('server/mem/m.md', 'm 1', 'x')], root), /read-only/);
  });

  test('more than 3 resolved files is refused; several edits to one path count once', () => {
    refuses(() => groupEditsByResolvedPath([edit('server/a.ts', 'a 1', 'x'), edit('server/b.ts', 'b 1', 'x'), edit('server/c.ts', 'c 1', 'x'), edit('server/d.ts', 'd 1', 'x')], root), /at most 3 files/);
    const groups = groupEditsByResolvedPath([edit('server/a.ts', 'a 2\n', 'x\n'), edit('server/./a.ts', 'a 20\n', 'y\n'), edit('server/b.ts', 'b 1\n', 'z\n')], root);
    assert.deepEqual([...groups.keys()].sort(), ['server/a.ts', 'server/b.ts']);
    assert.equal(groups.get('server/a.ts')!.length, 2);
  });

  test('find must be unique in the pinned original; ranges must not overlap; applied by position', () => {
    refuses(() => applyEditsToOriginal('f', FILES['server/a.ts'], [edit('f', 'absent', 'x')]), /does not occur/);
    refuses(() => applyEditsToOriginal('f', FILES['server/twice.ts'], [edit('f', 'same', 'x')]), /more than once/);
    refuses(() => applyEditsToOriginal('f', FILES['server/a.ts'], [edit('f', 'a 3\na 4', 'x'), edit('f', 'a 4\na 5', 'y')]), /overlap/);
    // Unique only after an earlier replacement: still matched against the original, so refused.
    refuses(() => applyEditsToOriginal('f', 'one\ntwo\ntwo\n', [edit('f', 'one\ntwo', 'one'), edit('f', 'two', 'TWO')]), /more than once/);
    const { after } = applyEditsToOriginal('f', FILES['server/a.ts'], [edit('f', 'a 20\n', 'twenty\n'), edit('f', 'a 2\n', 'two\n')]);
    assert.match(after, /^a 1\ntwo\na 3\n/);
    assert.match(after, /\na 19\ntwenty\na 21\n/);
  });

  test('the unified diff matches git diff', () => {
    const cases: Array<[string, Array<ReturnType<typeof edit>>]> = [
      [lines(40, 'l'), [edit('f', 'l 10\n', 'ten\nten-b\n')]],
      [lines(40, 'l'), [edit('f', 'l 12\n', '')]],
      [lines(40, 'l').slice(0, -1), [edit('f', 'l 40', 'forty')]],
      [lines(40, 'l'), [edit('f', 'l 2\n', 'two\n'), edit('f', 'l 38\n', 'x\n')]],
      [lines(40, 'l'), [edit('f', 'l 5\nl 6', 'l 5 and 6')]],
      [lines(40, 'l'), [edit('f', 'l 40\n', 'l 40')]],
    ];
    const dir = fs.mkdtempSync(path.join(base, 'diff-'));
    for (const [original, edits] of cases) {
      const { after } = applyEditsToOriginal('f', original, edits);
      fs.writeFileSync(path.join(dir, 'a'), original);
      fs.writeFileSync(path.join(dir, 'b'), after);
      let out = '';
      try { execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '-U3', 'a', 'b'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e: any) { out = String(e.stdout); }
      const expected = out.split('\n').filter((l) => /^(@@|[ +\-\\])/.test(l) && !/^(---|\+\+\+)/.test(l))
        .map((l) => (l.startsWith('@@') ? l.slice(0, l.indexOf('@@', 2) + 2) : l)).join('\n').trim();
      assert.equal(unifiedDiff('f', original, after).split('\n').slice(2).join('\n').trim(), expected);
    }
  });
});

describe('pins', () => {
  test('dev-head pins the immutable HEAD bytes; a dirty touched file is refused', () => {
    const source = pinSourceForRole(root, DEV);
    assert.equal(source.kind, 'dev-head');
    assert.equal(source.commit, HEAD);
    const change = buildPinnedChange(groupEditsByResolvedPath([edit('server/a.ts', 'a 2\n', 'two\n')], root), source);
    assert.deepEqual(change.pin.files, [{
      path: 'server/a.ts', beforeSha256: sha(FILES['server/a.ts']), afterSha256: sha(FILES['server/a.ts'].replace('a 2\n', 'two\n')),
      edits: [{ find: 'a 2\n', replace: 'two\n' }], gitMode: '100644', objectType: 'blob',
    }]);
    assert.match(change.diff, /^--- a\/server\/a\.ts\n\+\+\+ b\/server\/a\.ts\n@@ -1,5 \+1,5 @@/);
    fs.appendFileSync(path.join(root, 'server/b.ts'), 'dirty\n');
    try {
      refuses(() => buildPinnedChange(groupEditsByResolvedPath([edit('server/b.ts', 'b 1\n', 'x\n')], root), pinSourceForRole(root, DEV)), /working copy differs from HEAD for server\/b\.ts/);
    } finally {
      git('checkout', '--', 'server/b.ts');
    }
  });

  test('a file not in the pinned commit is refused', () => {
    fs.writeFileSync(path.join(root, 'server/new.ts'), 'new\n');
    try {
      refuses(() => buildPinnedChange(groupEditsByResolvedPath([edit('server/new.ts', 'new', 'x')], root), pinSourceForRole(root, DEV)), /not in the pinned commit/);
    } finally {
      fs.rmSync(path.join(root, 'server/new.ts'));
    }
  });

  test('release pins the manifest commit and digest and the deployed bytes; a missing, dirty or unpromotable manifest refuses', () => {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
    refuses(() => pinSourceForRole(root, PROD), /cannot pin a proposal to this build/);
    for (const bad of [{ dirtyWorktree: true }, { promotable: false, authority: 'development' }, { commitSha: null, promotable: false }]) {
      writeManifest(bad);
      refuses(() => pinSourceForRole(root, PROD), /cannot pin a proposal to this build/);
    }
    writeManifest();
    const source = pinSourceForRole(root, PROD);
    assert.deepEqual([source.kind, source.commit, source.sourceDigest], ['release', 'f'.repeat(40), 'e'.repeat(64)]);
    const change = buildPinnedChange(groupEditsByResolvedPath([edit('server/c.ts', 'c 1\n', 'x\n')], root), source);
    assert.equal(change.pin.files[0].beforeSha256, sha(FILES['server/c.ts']));
  });

  test('an unknown role refuses', () => {
    for (const env of [{}, { HOLAHOLA_INSTANCE_ROLE: 'staging' }]) refuses(() => pinSourceForRole(root, env as NodeJS.ProcessEnv), /instance role unknown/);
  });

  test('the recheck refuses a changed file or commit (stale base)', () => {
    writeManifest();
    const source = pinSourceForRole(root, PROD);
    const change = buildPinnedChange(groupEditsByResolvedPath([edit('server/d.ts', 'd 1\n', 'x\n')], root), source);
    recheckPin(change.pin, source);
    fs.appendFileSync(path.join(root, 'server/d.ts'), 'changed\n');
    try {
      refuses(() => recheckPin(change.pin, pinSourceForRole(root, PROD)), /stale base: server\/d\.ts changed/);
    } finally {
      git('checkout', '--', 'server/d.ts');
    }
    writeManifest({ commitSha: '1'.repeat(40) });
    refuses(() => recheckPin(change.pin, pinSourceForRole(root, PROD)), /stale base: the pinned commit changed/);
  });
});

/** A minimal in-memory build_queue for proposeFix's store calls. */
function fakeStore() {
  const rows: any[] = [];
  let failCommit = false;
  const insert = () => ({ values: (v: any) => ({ returning: async () => { const row = { id: `bq-${rows.length + 1}`, notifyAttempts: 0, diff: null, pinKind: null, pinCommit: null, pinSourceDigest: null, pinFiles: null, ...v }; rows.push(row); return [row]; } }) });
  const db: any = {
    insert,
    transaction: async (fn: any) => {
      const before = rows.length;
      try {
        const out = await fn({ insert });
        if (failCommit) throw new Error('commit failed');
        return out;
      } catch (err) {
        rows.length = before;
        throw err;
      }
    },
    update: () => ({ set: (v: any) => ({ where: async () => { Object.assign(rows[rows.length - 1], v); } }) }),
    select: () => ({ from: () => ({ where: async () => [rows[rows.length - 1]] }) }),
  };
  return { db, rows, setFailCommit: (v: boolean) => { failCommit = v; } };
}

describe('proposeFix storage', () => {
  const args = { rationale: 'Guard a missing value', evidence: 'TypeError in logs', verify: 'Run the unit test' };

  test('high confidence stores exactly one pending, pinned row through the existing route; nothing is written', async () => {
    writeManifest();
    const { db, rows } = fakeStore();
    const notices: string[] = [];
    const before = sha(fs.readFileSync(path.join(root, 'server/a.ts')));
    const { row } = await proposeFix({ ...args, confidence: 'high', edits: [edit('server/a.ts', 'a 7\n', 'seven\n')] }, {
      db, root, env: PROD, notify: async (r) => { notices.push(r.id); },
    });
    assert.equal(rows.length, 1);
    assert.equal(sha(fs.readFileSync(path.join(root, 'server/a.ts'))), before, 'the source file is unchanged');
    assert.equal(row.proposedBy, 'alden');
    assert.equal(row.isSafeZone, false);
    assert.equal(row.status, 'pending');
    assert.equal(row.confidence, 'high');
    assert.equal(row.pinKind, 'release');
    assert.match(row.diff, /^-a 7\n\+seven$/m);
    assert.deepEqual(notices, [row.id]);
    assert.equal(row.notifyState, 'delivered');
  });

  for (const confidence of ['low', 'medium']) {
    test(`${confidence} confidence stores exactly one description-only row: no pin, no diff, confidence kept`, async () => {
      const { db, rows } = fakeStore();
      const { row, change } = await proposeFix({ ...args, confidence, edits: [edit('server/routes.ts', 'r 1', 'x')] }, {
        db, root, env: { HOLAHOLA_INSTANCE_ROLE: 'staging' } as NodeJS.ProcessEnv, notify: async () => {},
      });
      assert.equal(rows.length, 1);
      assert.equal(change, null);
      assert.equal(row.confidence, confidence);
      assert.equal(row.pinKind, null);
      assert.equal(row.diff, null);
      assert.match(row.description, /description only, not pinned, not eligible for PR conversion/);
    });
  }

  test('a refusal stores nothing', async () => {
    writeManifest();
    for (const bad of [
      { ...args, confidence: undefined, edits: [edit('server/a.ts', 'a 1\n', 'x\n')] },
      { ...args, confidence: 'high', edits: [edit('server/twice.ts', 'same', 'x')] },
      { ...args, confidence: 'high', edits: [edit('.agents/memory/m.md', 'm 1', 'x')] },
      { ...args, confidence: 'high', edits: [] },
      { ...args, rationale: ' ', confidence: 'high', edits: [edit('server/a.ts', 'a 1\n', 'x\n')] },
    ]) {
      const { db, rows } = fakeStore();
      await assert.rejects(proposeFix(bad as any, { db, root, env: PROD, notify: async () => {} }));
      assert.equal(rows.length, 0, JSON.stringify(bad));
    }
  });

  test('the pin is rechecked before the row commits', async () => {
    writeManifest();
    const { db, rows } = fakeStore();
    let calls = 0;
    const pinSource = () => {
      const source = pinSourceForRole(root, PROD);
      if (++calls === 2) fs.appendFileSync(path.join(root, 'server/c.ts'), 'raced\n');
      return source;
    };
    try {
      await assert.rejects(proposeFix({ ...args, confidence: 'high', edits: [edit('server/c.ts', 'c 2\n', 'x\n')] }, { db, root, pinSource, notify: async () => {} }), /stale base/);
      assert.equal(rows.length, 0);
    } finally {
      git('checkout', '--', 'server/c.ts');
    }
  });

  test('a notice failure leaves the row stored and marked failed; a retry delivers it once', async () => {
    writeManifest();
    const { db, rows } = fakeStore();
    const { row } = await proposeFix({ ...args, confidence: 'high', edits: [edit('server/b.ts', 'b 3\n', 'x\n')] }, {
      db, root, env: PROD, notify: async () => { throw new Error('coordination down'); },
    });
    assert.equal(rows.length, 1);
    assert.equal(row.notifyState, 'failed');
    assert.equal(row.notifyError, 'coordination down');
    assert.equal(row.notifyAttempts, 1);
    const delivered: string[] = [];
    await notifyStoredProposal(rows[0], { db, notify: async (r) => { delivered.push(r.id); } });
    assert.deepEqual(delivered, [row.id]);
    assert.equal(rows.length, 1, 'no duplicate row');
    assert.equal(rows[0].notifyState, 'delivered');
    assert.equal(rows[0].notifyAttempts, 2);
  });
});

describe('no writes, through the real dispatch', () => {
  test('proposeFix in production calls no write, rename, delete or process primitive', async () => {
    const { mock } = await import('node:test');
    const { syncBuiltinESMExports } = await import('node:module');
    const childProcess = (await import('node:child_process')).default;
    writeManifest();
    const calls: string[] = [];
    const trap = (name: string) => () => { calls.push(name); throw new Error(`${name} must not run`); };
    for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'renameSync', 'rename', 'copyFileSync', 'unlinkSync', 'unlink', 'rmSync'] as const) mock.method(fs, name, trap(`fs.${name}`));
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(childProcess, name, trap(`child_process.${name}`));
    syncBuiltinESMExports();
    try {
      const { db, rows } = fakeStore();
      await proposeFix({ rationale: 'r', evidence: 'e', verify: 'v', confidence: 'high', edits: [edit('server/a.ts', 'a 9\n', 'nine\n')] }, { db, root, env: PROD, notify: async () => {} });
      assert.equal(rows.length, 1);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(calls, []);
  });

  test('executeAldenTool returns the refusal for an invalid proposal and stores nothing', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    for (const input of [
      { rationale: 'r', evidence: 'e', verify: 'v', edits: [edit('server/a.ts', 'a 1', 'x')] },
      { rationale: 'r', evidence: 'e', verify: 'v', confidence: 'sure', edits: [edit('server/a.ts', 'a 1', 'x')] },
    ]) {
      const result = await executeAldenTool('propose_fix', input);
      assert.equal(result.data.refused, 'propose_fix_refused');
      assert.match(result.data.error, /confidence is required/);
    }
  });
});

test('positive control: the same traps catch the dev pin\'s git process', async () => {
  const { mock } = await import('node:test');
  const { syncBuiltinESMExports } = await import('node:module');
  const childProcess = (await import('node:child_process')).default;
  const calls: string[] = [];
  mock.method(childProcess, 'execFileSync', () => { calls.push('child_process.execFileSync'); throw new Error('trapped'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => pinSourceForRole(root, DEV), /cannot read the dev HEAD commit/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, ['child_process.execFileSync']);
});

test('a symlink or submodule entry in the pinned commit is refused (runs last: it moves the fixture HEAD)', () => {
  const target = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'server/a.ts' }).toString().trim();
  git('update-index', '--add', '--cacheinfo', `120000,${target},server/link.ts`);
  git('update-index', '--add', '--cacheinfo', `160000,${HEAD},server/sub.ts`);
  git('commit', '-q', '-m', 'odd entries');
  // Regular files in the working tree, so only the pinned entry's type differs.
  fs.writeFileSync(path.join(root, 'server/link.ts'), 'server/a.ts');
  fs.writeFileSync(path.join(root, 'server/sub.ts'), 'sub\n');
  try {
    refuses(() => buildPinnedChange(groupEditsByResolvedPath([edit('server/link.ts', 'server', 'x')], root), pinSourceForRole(root, DEV)), /symlink entry and cannot be pinned/);
    refuses(() => buildPinnedChange(groupEditsByResolvedPath([edit('server/sub.ts', 'sub', 'x')], root), pinSourceForRole(root, DEV)), /submodule entry and cannot be pinned/);
  } finally {
    git('reset', '-q', '--hard', HEAD);
    fs.rmSync(path.join(root, 'server/link.ts'), { force: true });
    fs.rmSync(path.join(root, 'server/sub.ts'), { force: true });
  }
});
