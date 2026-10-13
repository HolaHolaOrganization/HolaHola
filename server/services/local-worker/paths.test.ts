import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STAGING_LIMITS, checkStagingPath, globToRegExp, matchesAnchored, matchesDeny, parseLsTreeZ,
  selectStagingFiles, type TreeEntry,
} from './paths';

const blob = (path: string, size = 100, mode = '100644'): TreeEntry => ({ mode, type: 'blob', size, path });
const select = (tree: TreeEntry[], jobPatterns: string[], allowlist = ['docs/**'], denylist: string[] = []) =>
  selectStagingFiles({ tree, jobPatterns, allowlist, denylist });

test('glob: *, ? and ** semantics are segment-bounded', () => {
  assert.equal(matchesAnchored('docs/a.md', 'docs/*.md'), true);
  assert.equal(matchesAnchored('docs/sub/a.md', 'docs/*.md'), false);
  assert.equal(matchesAnchored('docs/sub/a.md', 'docs/**'), true);
  assert.equal(matchesAnchored('docs/a/b/c.md', 'docs/**/c.md'), true);
  assert.equal(matchesAnchored('docs/c.md', 'docs/**/c.md'), true);
  assert.equal(matchesAnchored('docs/ab.md', 'docs/a?.md'), true);
  assert.equal(matchesAnchored('docsX/a.md', 'docs/**'), false);
  assert.equal(globToRegExp('a.b').test('aXb'), false); // dots are literal
});

test('deny: basename patterns match at any depth; slash patterns match any suffix; case-insensitive', () => {
  assert.equal(matchesDeny('.env', '.env*'), true);
  assert.equal(matchesDeny('server/.ENV.local', '.env*'), true);
  assert.equal(matchesDeny('x/.claude/settings.json', '.claude/**'), true);
  assert.equal(matchesDeny('docs/api-token-notes.md', '**/*token*'), true);
  assert.equal(matchesDeny('docs/readme.md', '**/*token*'), false);
});

test('path checks: traversal, absolute, ADS, reserved names, trailing dot/space, length', () => {
  for (const [p, reason] of [
    ['a/../b', 'path_traversal'], ['/a', 'path_absolute'], ['a:b', 'path_forbidden_character'],
    ['docs/CON.md', 'path_reserved_name'], ['docs/nul', 'path_reserved_name'], ['docs/a.', 'path_trailing_dot_or_space'],
    ['docs/a ', 'path_trailing_dot_or_space'], ['docs/a|b', 'path_windows_invalid_character'], ['x'.repeat(181), 'path_length'],
  ] as const) {
    assert.deepEqual(checkStagingPath(p), { ok: false, reason }, p);
  }
  assert.deepEqual(checkStagingPath('docs/operations-catalog.md'), { ok: true });
});

test('selection: happy path stages only matched, allowlisted, non-denied blobs', () => {
  const r = select([blob('docs/a.md'), blob('docs/b.md'), blob('server/x.ts')], ['docs/*.md']);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.files.map((f) => f.path), ['docs/a.md', 'docs/b.md']);
});

test('selection: order is expand -> allowlist -> denylist, failing closed on any violation', () => {
  assert.deepEqual(select([blob('server/x.ts')], ['server/*.ts']), { ok: false, reason: 'path_not_allowlisted', path: 'server/x.ts' });
  assert.deepEqual(select([blob('docs/secret-plan.md')], ['docs/*'], ['docs/**']), { ok: false, reason: 'path_denylisted', path: 'docs/secret-plan.md' });
  assert.deepEqual(select([blob('docs/a.md')], ['nothing/*']), { ok: false, reason: 'paths_no_match' });
});

test('selection: the fixed minimum denylist applies even when the charter denylist is empty', () => {
  const r = select([blob('docs/.env.example')], ['docs/*'], ['docs/**'], []);
  assert.deepEqual(r, { ok: false, reason: 'path_denylisted', path: 'docs/.env.example' });
});

test('selection: symlink and submodule entries are rejected, not skipped', () => {
  assert.deepEqual(select([blob('docs/link', 10, '120000')], ['docs/*']), { ok: false, reason: 'path_symlink', path: 'docs/link' });
  assert.deepEqual(select([{ mode: '160000', type: 'commit', size: null, path: 'docs/sub' }], ['docs/*']), { ok: false, reason: 'path_submodule', path: 'docs/sub' });
});

test('selection: case-insensitive collisions (file and directory) are rejected', () => {
  assert.equal(select([blob('docs/A.md'), blob('docs/a.md')], ['docs/*']).ok, false);
  assert.equal(select([blob('docs/Sub/x.md'), blob('docs/sub/y.md')], ['docs/**']).ok, false);
});

test('selection: per-file, total and count bounds are enforced', () => {
  assert.equal(select([blob('docs/big.md', STAGING_LIMITS.maxFileBytes + 1)], ['docs/*']).ok, false);
  const many = Array.from({ length: 11 }, (_, i) => blob(`docs/f${i}.md`, 200_000));
  assert.deepEqual(select(many, ['docs/*']), { ok: false, reason: 'staging_too_large' });
  const tooMany = Array.from({ length: STAGING_LIMITS.maxFiles + 1 }, (_, i) => blob(`docs/g${i}.md`, 1));
  assert.deepEqual(select(tooMany, ['docs/*']), { ok: false, reason: 'staging_too_many_files' });
});

test('ls-tree -z parsing handles sizes, trees and tabs in records', () => {
  const NUL = '\u0000';
  const out = ['100644 blob abc123      42\tdocs/a.md', '040000 tree def456       -\tdocs', '120000 blob 999aaa       7\tdocs/l', ''].join(NUL);
  assert.deepEqual(parseLsTreeZ(out), [
    { mode: '100644', type: 'blob', size: 42, path: 'docs/a.md' },
    { mode: '040000', type: 'tree', size: null, path: 'docs' },
    { mode: '120000', type: 'blob', size: 7, path: 'docs/l' },
  ]);
  assert.throws(() => parseLsTreeZ(`garbage${NUL}`));
});
