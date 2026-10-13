import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256Hex } from '../../../shared/worker-contracts';
import { assertNoLinks, stageFiles, validateHarnessOutput, verifyStagedTree } from './staging';

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lrw-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'a.md'), 'line1\nline2\nline3\n');
  writeFileSync(join(dir, 'docs', 'secret.md'), 'not staged');
  git('add', '.'); git('commit', '-q', '-m', 'c');
  writeFileSync(join(dir, 'docs', 'a.md'), 'CHANGED IN WORKTREE\n'); // staging must use the commit, not the worktree
  return { dir, commit: git('rev-parse', 'HEAD') };
}

test('staging writes only selected files from commit blobs, not the working tree; baseline holds those blob bytes', () => {
  const { dir, commit } = tempRepo();
  const staging = mkdtempSync(join(tmpdir(), 'lrw-in-'));
  try {
    const staged = stageFiles({ repoRoot: dir, commit, files: [{ path: 'docs/a.md' }], stagingDir: staging });
    assert.equal(readFileSync(join(staging, 'docs', 'a.md'), 'utf8'), 'line1\nline2\nline3\n');
    assert.equal(staged.baseline.get('docs/a.md')!.toString('utf8'), 'line1\nline2\nline3\n');
    assert.equal(staged.baseline.size, 1);
    assert.deepEqual(verifyStagedTree(staged), { ok: true });
    assert.throws(() => readFileSync(join(staging, 'docs', 'secret.md')));
    assert.throws(() => stageFiles({ repoRoot: dir, commit, files: [{ path: 'docs/a.md' }], stagingDir: staging }), /staging_not_empty/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); }
});

test('a link or junction anywhere in staging fails the check', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lrw-link-'));
  try {
    mkdirSync(join(root, 'docs'));
    try { symlinkSync(tmpdir(), join(root, 'docs', 'escape'), 'junction'); } catch { t.skip('cannot create junction here'); return; }
    assert.throws(() => assertNoLinks(root), /staging_reparse_point/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const baselineOf = (text: string) => new Map([['docs/a.md', Buffer.from(text, 'utf8')]]);
const out = (structured: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', is_error: false, structured_output: structured, total_cost_usd: 0.12, ...extra });

test('valid output yields citations computed from the immutable baseline with supervisor-computed digests', () => {
  const r = validateHarnessOutput(out({ summary: 's', findings: [], citations: [{ path: 'docs/a.md', startLine: 2, endLine: 3 }] }), baselineOf('alpha\nbeta\ngamma\n'));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.citations[0].excerpt, 'beta\ngamma');
    assert.equal(r.citations[0].excerptSha256, sha256Hex(Buffer.from('beta\ngamma', 'utf8')));
    assert.equal(r.costTelemetryUsd, 0.12);
  }
});

test('citations outside the baseline or beyond the file are citation_mismatch', () => {
  const base = baselineOf('one\n');
  const bad1 = validateHarnessOutput(out({ summary: 's', findings: [], citations: [{ path: 'server/x.ts', startLine: 1, endLine: 1 }] }), base);
  assert.deepEqual(bad1, { ok: false, failureClass: 'citation_mismatch', detail: 'citation_path_not_staged' });
  const bad2 = validateHarnessOutput(out({ summary: 's', findings: [], citations: [{ path: 'docs/a.md', startLine: 1, endLine: 9 }] }), base);
  assert.deepEqual(bad2, { ok: false, failureClass: 'citation_mismatch', detail: 'citation_beyond_file' });
});

test('malformed output, schema violations and harness errors map to closed failure classes', () => {
  const base = baselineOf('x\n');
  const cls = (s: string) => (validateHarnessOutput(s, base) as { failureClass: string }).failureClass;
  assert.equal(cls('not json'), 'schema_invalid');
  // Review item 4: valid JSON that is not an object is rejected normally, never thrown.
  for (const s of ['null', ' null ', '[]', '"result"', '42', 'true']) {
    assert.deepEqual(validateHarnessOutput(s, base), { ok: false, failureClass: 'schema_invalid', detail: 'output_not_object' }, s);
  }
  assert.equal(cls(out({ summary: 1 })), 'schema_invalid');
  assert.equal(cls(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })), 'auth_required');
  assert.equal(cls(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })), 'harness_unavailable');
});

test('F7: changed, same-length-changed, added or removed staged bytes fail the post-run check; citations never use mutated bytes', () => {
  const { dir, commit } = tempRepo();
  const all: string[] = [];
  const mk = () => {
    const staging = mkdtempSync(join(tmpdir(), 'lrw-in-'));
    all.push(staging);
    return stageFiles({ repoRoot: dir, commit, files: [{ path: 'docs/a.md' }], stagingDir: staging });
  };
  try {
    const changed = mk();
    writeFileSync(join(changed.dir, 'docs', 'a.md'), 'line1\nFORGED\nline3\n');
    assert.deepEqual(verifyStagedTree(changed), { ok: false, detail: 'staged_file_changed' });
    const r = validateHarnessOutput(out({ summary: 's', findings: [], citations: [{ path: 'docs/a.md', startLine: 2, endLine: 2 }] }), changed.baseline);
    assert.equal(r.ok && r.citations[0].excerpt, 'line2', 'excerpt comes from the pinned blob, not the forged file');

    const sameLength = mk();
    writeFileSync(join(sameLength.dir, 'docs', 'a.md'), 'line1\nlinE2\nline3\n');
    assert.deepEqual(verifyStagedTree(sameLength), { ok: false, detail: 'staged_file_changed' });

    const added = mk();
    writeFileSync(join(added.dir, 'docs', 'b.md'), 'new');
    assert.deepEqual(verifyStagedTree(added), { ok: false, detail: 'staged_extra_entry' });

    const removed = mk();
    rmSync(join(removed.dir, 'docs', 'a.md'));
    assert.deepEqual(verifyStagedTree(removed), { ok: false, detail: 'staged_file_missing' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const d of all) rmSync(d, { recursive: true, force: true });
  }
});

test('F7: a staged directory replaced by a junction is rejected', (t) => {
  const { dir, commit } = tempRepo();
  const staging = mkdtempSync(join(tmpdir(), 'lrw-in-'));
  try {
    const staged = stageFiles({ repoRoot: dir, commit, files: [{ path: 'docs/a.md' }], stagingDir: staging });
    rmSync(join(staging, 'docs'), { recursive: true, force: true });
    try { symlinkSync(join(dir, 'docs'), join(staging, 'docs'), 'junction'); } catch { t.skip('cannot create junction here'); return; }
    assert.deepEqual(verifyStagedTree(staged), { ok: false, detail: 'staged_entry_is_link' });
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
