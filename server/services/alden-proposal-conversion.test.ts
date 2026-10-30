// PR conversion of Alden's stored proposals (gated-fixes design e4f8e988, P1
// "At PR conversion"): eligibility, stored-metadata validation, publication
// on the selected remote only, stale-base checks, and the write sink, against
// throwaway repositories with real bare remotes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  buildPinnedChange, gitEntryAt, groupEditsByResolvedPath, isCommitPublished, pinSourceForRole,
  verifyProposalForConversion, writeConvertedFiles,
} from './alden-propose-fix';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-conversion-'));
const root = path.join(base, 'ws');
const origin = path.join(base, 'origin.git');
const other = path.join(base, 'other.git');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const ORIGINAL = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
fs.mkdirSync(path.join(root, 'server'), { recursive: true });
fs.writeFileSync(path.join(root, 'server', 'x.ts'), ORIGINAL);
run(base, 'init', '-q', '--bare', origin);
run(base, 'init', '-q', '--bare', other);
run(root, 'init', '-q');
run(root, 'add', '-A');
run(root, 'commit', '-q', '-m', 'fixture');
run(root, 'remote', 'add', 'origin', origin);
run(root, 'remote', 'add', 'unselected', other);
const HEAD = run(root, 'rev-parse', 'HEAD').toString().trim();
const readEntry = (commit: string, rel: string) => gitEntryAt(root, commit, rel);

function pinned() {
  const change = buildPinnedChange(groupEditsByResolvedPath([{ path: 'server/x.ts', find: 'const b = 2;', replace: 'const b = 20;' }], root), pinSourceForRole(root, { HOLAHOLA_INSTANCE_ROLE: 'dev' } as NodeJS.ProcessEnv));
  return { confidence: 'high', pinKind: change.pin.kind, pinCommit: change.pin.commit, pinFiles: change.pin.files as any[] };
}

describe('publication is checked on the selected remote only', () => {
  test('a commit only on another remote is not published for origin; pushed and fetched it is', () => {
    run(root, 'push', '-q', 'unselected', 'HEAD:refs/heads/feature');
    run(root, 'fetch', '-q', '--prune', 'unselected');
    assert.equal(isCommitPublished(root, HEAD, 'unselected'), true);
    assert.equal(isCommitPublished(root, HEAD, 'origin'), false, 'refs/remotes/unselected/feature must not count for origin');
    run(root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    run(root, 'fetch', '-q', '--prune', 'origin');
    assert.equal(isCommitPublished(root, HEAD, 'origin'), true);
  });

  test('a deleted remote branch stops counting after a pruning fetch; bad inputs are refused', () => {
    run(root, 'push', '-q', 'unselected', '--delete', 'feature');
    run(root, 'fetch', '-q', '--prune', 'unselected');
    assert.equal(isCommitPublished(root, HEAD, 'unselected'), false);
    assert.equal(isCommitPublished(root, 'not-a-sha', 'origin'), false);
    assert.equal(isCommitPublished(root, HEAD, 'origin/../unselected'), false);
  });

  test('a local-only commit is not published', () => {
    fs.writeFileSync(path.join(root, 'server', 'local.ts'), 'local\n');
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'local only');
    const local = run(root, 'rev-parse', 'HEAD').toString().trim();
    try {
      assert.equal(isCommitPublished(root, local, 'origin'), false);
    } finally {
      run(root, 'reset', '-q', '--hard', HEAD);
    }
  });
});

describe('verifyProposalForConversion', () => {
  test('a valid pinned proposal converts to the exact edited content', () => {
    assert.deepEqual(verifyProposalForConversion(pinned(), readEntry), [{ path: 'server/x.ts', content: 'const a = 1;\nconst b = 20;\nconst c = 3;\n' }]);
  });

  test('ineligible or malformed stored proposals are refused', () => {
    const ok = pinned();
    const f = ok.pinFiles[0];
    for (const [bad, why] of [
      [{ ...ok, confidence: 'medium' }, /only a high-confidence/],
      [{ ...ok, pinKind: null }, /only a high-confidence/],
      [{ ...ok, pinCommit: 'abc' }, /only a high-confidence/],
      [{ ...ok, pinFiles: [] }, /empty or too long/],
      [{ ...ok, pinFiles: [f, f, f, f] }, /empty or too long/],
      [{ ...ok, pinFiles: [f, f] }, /listed twice/],
      [{ ...ok, pinFiles: [null] }, /malformed pinned file/],
      [{ ...ok, pinFiles: [{ ...f, edits: [] }] }, /carry no edits/],
      [{ ...ok, pinFiles: [{ ...f, edits: [{ find: '', replace: 'x' }] }] }, /carry no edits/],
      [{ ...ok, pinFiles: [{ ...f, beforeSha256: 'short' }] }, /malformed hashes/],
      [{ ...ok, pinFiles: [{ ...f, path: '../outside.ts' }] }, /not a normalized workspace path/],
      [{ ...ok, pinFiles: [{ ...f, path: 'server/./x.ts' }] }, /not a normalized workspace path/],
      [{ ...ok, pinFiles: [{ ...f, path: '/etc/passwd' }] }, /is absolute/],
      [{ ...ok, pinFiles: [{ ...f, path: 'server\\x.ts' }] }, /malformed pinned path/],
      [{ ...ok, pinFiles: [{ ...f, path: '.agents/memory/m.md' }] }, /read-only directory/],
      [{ ...ok, pinFiles: [{ ...f, path: 'server/.env' }] }, /excluded/],
      [{ ...ok, pinFiles: [{ ...f, path: 'attached_assets/a.md' }] }, /outside Alden's readable root/],
    ] as Array<[any, RegExp]>) {
      assert.throws(() => verifyProposalForConversion(bad, readEntry), why, JSON.stringify(bad.pinFiles?.[0]?.path ?? bad.confidence));
    }
  });

  test('a symlink entry in the pinned tree is refused even with matching link-text hashes', () => {
    const linkText = '../../outside-sentinel.ts';
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: linkText }).toString().trim();
    run(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},server/link.ts`);
    run(root, 'commit', '-q', '-m', 'symlink entry');
    const commit = run(root, 'rev-parse', 'HEAD').toString().trim();
    try {
      const forged = {
        confidence: 'high', pinKind: 'release', pinCommit: commit,
        pinFiles: [{ path: 'server/link.ts', beforeSha256: sha(linkText), afterSha256: sha('../../elsewhere.ts'), edits: [{ find: 'outside-sentinel', replace: 'elsewhere' }] }],
      };
      assert.throws(() => verifyProposalForConversion(forged, readEntry), /server\/link\.ts is not a regular file/);
    } finally {
      run(root, 'reset', '-q', '--hard', HEAD);
    }
  });

  test('a changed before-hash, a changed after-hash or a moved pin is a stale base', () => {
    const ok = pinned();
    const f = ok.pinFiles[0];
    assert.throws(() => verifyProposalForConversion({ ...ok, pinFiles: [{ ...f, beforeSha256: '0'.repeat(64) }] }, readEntry), /stale base: server\/x\.ts at .* before-hash/);
    assert.throws(() => verifyProposalForConversion({ ...ok, pinFiles: [{ ...f, afterSha256: '0'.repeat(64) }] }, readEntry), /stale base: server\/x\.ts no longer produces/);
    fs.writeFileSync(path.join(root, 'server', 'x.ts'), 'const a = 1;\nconst b = 2;\nconst c = 4;\n');
    run(root, 'commit', '-q', '-am', 'moved');
    const moved = run(root, 'rev-parse', 'HEAD').toString().trim();
    try {
      assert.throws(() => verifyProposalForConversion({ ...ok, pinCommit: moved }, readEntry), /stale base/);
    } finally {
      run(root, 'reset', '-q', '--hard', HEAD);
    }
  });
});

describe('the conversion write sink', () => {
  function worktree(name: string): string {
    const dir = path.join(base, name);
    run(root, 'worktree', 'add', '-q', '--detach', dir, HEAD);
    return dir;
  }

  test('writes the verified content into the worktree only', () => {
    const dir = worktree('wt-ok');
    writeConvertedFiles(dir, verifyProposalForConversion(pinned(), readEntry));
    assert.equal(fs.readFileSync(path.join(dir, 'server', 'x.ts'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    assert.equal(fs.readFileSync(path.join(root, 'server', 'x.ts'), 'utf8'), ORIGINAL, 'the source checkout is untouched');
  });

  test('a symlinked directory component or target, or a malformed path, is refused before any write; the outside sentinel is untouched', (t) => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const sentinel = path.join(outside, 'x.ts');
    fs.writeFileSync(sentinel, 'sentinel\n');
    const files = verifyProposalForConversion(pinned(), readEntry);

    const dir = worktree('wt-dir-link');
    fs.rmSync(path.join(dir, 'server'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(dir, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeConvertedFiles(dir, files), /server is a symlink/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel\n');

    for (const bad of ['../outside/x.ts', '/tmp/x.ts', 'server/../../outside/x.ts']) {
      assert.throws(() => writeConvertedFiles(worktree(`wt-bad-${Math.random().toString(16).slice(2, 8)}`), [{ path: bad, content: 'x' }]), /not eligible|absolute|normalized/);
    }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel\n');

    const dir2 = worktree('wt-file-link');
    fs.rmSync(path.join(dir2, 'server', 'x.ts'));
    try {
      fs.symlinkSync(sentinel, path.join(dir2, 'server', 'x.ts'), 'file');
    } catch {
      t.diagnostic('file symlinks unavailable here; the target-symlink case is skipped');
      return;
    }
    assert.throws(() => writeConvertedFiles(dir2, files), /server\/x\.ts is a symlink/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
  });
});
