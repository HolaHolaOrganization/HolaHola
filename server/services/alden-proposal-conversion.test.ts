// PR conversion of Alden's stored proposals (gated-fixes design e4f8e988, P1
// "At PR conversion"): eligibility, publication and stale-base checks against
// a throwaway repository with a real bare remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildPinnedChange, groupEditsByResolvedPath, isCommitPublished, pinSourceForRole, verifyProposalForConversion } from './alden-propose-fix';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-conversion-'));
const root = path.join(base, 'ws');
const remote = path.join(base, 'remote.git');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
fs.mkdirSync(path.join(root, 'server'), { recursive: true });
fs.writeFileSync(path.join(root, 'server', 'x.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
run(base, 'init', '-q', '--bare', remote);
run(root, 'init', '-q');
run(root, 'add', '-A');
run(root, 'commit', '-q', '-m', 'fixture');
run(root, 'remote', 'add', 'origin', remote);
run(root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
run(root, 'fetch', '-q', 'origin');
const PUBLISHED = run(root, 'rev-parse', 'HEAD').toString().trim();
const readAt = (commit: string, rel: string) => run(root, 'show', `${commit}:${rel}`);

function pinned() {
  const change = buildPinnedChange(groupEditsByResolvedPath([{ path: 'server/x.ts', find: 'const b = 2;', replace: 'const b = 20;' }], root), pinSourceForRole(root, { HOLAHOLA_INSTANCE_ROLE: 'dev' } as NodeJS.ProcessEnv));
  return { confidence: 'high', pinKind: change.pin.kind, pinCommit: change.pin.commit, pinFiles: change.pin.files };
}

test('a published commit is recognised; a local-only commit or a non-sha is not', () => {
  assert.equal(isCommitPublished(root, PUBLISHED), true);
  fs.writeFileSync(path.join(root, 'server', 'local.ts'), 'local\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'local only');
  const local = run(root, 'rev-parse', 'HEAD').toString().trim();
  try {
    assert.equal(isCommitPublished(root, local), false);
    assert.equal(isCommitPublished(root, 'not-a-sha'), false);
  } finally {
    run(root, 'reset', '-q', '--hard', PUBLISHED);
  }
});

test('a valid pinned proposal converts to the exact edited content', () => {
  const files = verifyProposalForConversion(pinned(), readAt);
  assert.deepEqual(files, [{ path: 'server/x.ts', content: 'const a = 1;\nconst b = 20;\nconst c = 3;\n' }]);
});

test('ineligible proposals are refused', () => {
  const ok = pinned();
  for (const bad of [
    { ...ok, confidence: 'medium' },
    { ...ok, pinKind: null },
    { ...ok, pinCommit: null },
    { ...ok, pinFiles: null },
    { ...ok, pinFiles: [{ ...(ok.pinFiles as any)[0], edits: [] }] },
  ]) {
    assert.throws(() => verifyProposalForConversion(bad as any, readAt), /not eligible for PR conversion/);
  }
});

test('a changed before-hash, a changed after-hash or a moved pin is a stale base', () => {
  const ok = pinned();
  const file = (ok.pinFiles as any)[0];
  assert.throws(() => verifyProposalForConversion({ ...ok, pinFiles: [{ ...file, beforeSha256: '0'.repeat(64) }] }, readAt), /stale base: server\/x\.ts at .* before-hash/);
  assert.throws(() => verifyProposalForConversion({ ...ok, pinFiles: [{ ...file, afterSha256: '0'.repeat(64) }] }, readAt), /stale base: server\/x\.ts no longer produces/);
  // The same file at a different commit no longer matches the pinned bytes.
  fs.writeFileSync(path.join(root, 'server', 'x.ts'), 'const a = 1;\nconst b = 2;\nconst c = 4;\n');
  run(root, 'commit', '-q', '-am', 'moved');
  const moved = run(root, 'rev-parse', 'HEAD').toString().trim();
  try {
    assert.throws(() => verifyProposalForConversion({ ...ok, pinCommit: moved }, readAt), /stale base/);
  } finally {
    run(root, 'reset', '-q', '--hard', PUBLISHED);
  }
});
