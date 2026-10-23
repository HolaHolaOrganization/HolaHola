// Synthetic regressions for the Migration Gate workflow's trusted helpers and its
// main-only dispatch preflight. No credentials, no network, no Neon branch: the
// branch list is a stubbed fetch and the manifest runs against a temporary repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { branchNameFromGateLog, verifyBranchAbsent } from './verify-branch-absent.mjs';
import { buildManifest, parseNameStatus } from './candidate-manifest.mjs';
import { summarize } from './summarize-gate-log.mjs';

const BRANCH = 'test/migration-2026-10-23T00-10-21-400Z';
const CREATING = `[gate] Creating branch "${BRANCH}" from production...`;

function withLog(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-log-'));
  try {
    const logPath = join(dir, 'gate.log');
    if (text !== null) writeFileSync(logPath, text);
    return fn(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listing = (names, status = 200) => async () =>
  new Response(JSON.stringify({ branches: names.map((name) => ({ name, id: `br-${name.length}` })) }), { status });
const creds = { apiKey: 'synthetic-not-a-key', projectId: 'synthetic-project' };

test('cleanup: absent branch on a successful list is the only started-gate pass', async () => {
  await withLog(`${CREATING}\n[gate] READY_TO_PROMOTE\n`, async (logPath) => {
    const result = await verifyBranchAbsent({ outcome: 'success', logPath, ...creds, fetchImpl: listing(['production', 'other']) });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /confirmed absent/);
  });
});

test('cleanup: a present branch fails', async () => {
  await withLog(`${CREATING}\n`, async (logPath) => {
    const result = await verifyBranchAbsent({ outcome: 'failure', logPath, ...creds, fetchImpl: listing(['production', BRANCH]) });
    assert.equal(result.ok, false);
    assert.match(result.message, /still exists/);
  });
});

test('cleanup: matching is exact, so a superstring or prefix name is not the branch', async () => {
  await withLog(`${CREATING}\n`, async (logPath) => {
    const result = await verifyBranchAbsent({
      outcome: 'success', logPath, ...creds, fetchImpl: listing([`${BRANCH}-copy`, BRANCH.slice(0, -1), `x${BRANCH}`]),
    });
    assert.equal(result.ok, true, result.message);
  });
});

test('cleanup: list failures never become an absence claim', async () => {
  const failures = {
    'HTTP 500': listing([], 500),
    'thrown transport error': async () => { throw new TypeError('fetch failed'); },
    'non-JSON body': async () => new Response('<html>', { status: 200 }),
    'missing branches array': async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    'malformed branch entry': async () => new Response(JSON.stringify({ branches: [{ id: 'br-1' }] }), { status: 200 }),
  };
  for (const [label, fetchImpl] of Object.entries(failures)) {
    await withLog(`${CREATING}\n`, async (logPath) => {
      const result = await verifyBranchAbsent({ outcome: 'success', logPath, ...creds, fetchImpl });
      assert.equal(result.ok, false, label);
      assert.match(result.message, /absence of .* is unknown/, label);
      assert.doesNotMatch(result.message, /confirmed absent/, label);
    });
  }
});

test('cleanup: pagination is never treated as a complete list', async () => {
  const page = (pagination) => async () =>
    new Response(JSON.stringify({ branches: [{ name: 'production' }], pagination }), { status: 200 });
  // Shape returned by the live endpoint for a single-page project (2026-10-23): no cursor.
  await withLog(`${CREATING}\n`, async (logPath) => {
    const live = await verifyBranchAbsent({ outcome: 'success', logPath, ...creds, fetchImpl: page({ sort_by: 'updated_at', sort_order: 'desc' }) });
    assert.equal(live.ok, true, live.message);
  });
  // The target sits on a second page: a cursor on page one must make absence unknown.
  for (const pagination of [{ next: 'cursor-to-page-2' }, { next: 1 }, 'next', [], null]) {
    await withLog(`${CREATING}\n`, async (logPath) => {
      let requests = 0;
      const result = await verifyBranchAbsent({
        outcome: 'success', logPath, ...creds,
        fetchImpl: async (...args) => { requests += 1; return page(pagination)(...args); },
      });
      assert.equal(result.ok, false, JSON.stringify(pagination));
      assert.match(result.message, /paginated|unrecognized pagination/);
      assert.equal(requests, 1);
    });
  }
});

test('cleanup: missing credentials fail before any request', async () => {
  let called = false;
  await withLog(`${CREATING}\n`, async (logPath) => {
    const result = await verifyBranchAbsent({ outcome: 'success', logPath, apiKey: '', projectId: '', fetchImpl: async () => { called = true; } });
    assert.equal(result.ok, false);
  });
  assert.equal(called, false);
});

test('cleanup: invalid or unparseable gate evidence fails', async () => {
  const cases = {
    'no creation line': '[gate] Applying migration to the branch...\n',
    'two creation lines': `${CREATING}\n${CREATING}\n`,
    'malformed name': '[gate] Creating branch "production" from production...\n',
    'truncated line': '[gate] Creating branch "test/migration-2026-10-23T00-10',
  };
  for (const [label, text] of Object.entries(cases)) {
    await withLog(text, async (logPath) => {
      const result = await verifyBranchAbsent({ outcome: 'failure', logPath, ...creds, fetchImpl: listing([]) });
      assert.equal(result.ok, false, label);
    });
  }
  assert.equal(branchNameFromGateLog(`${CREATING}\r\n`).name, BRANCH);
});

test('cleanup: a never-started gate differs from lost evidence after start', async () => {
  await withLog(null, async (logPath) => {
    const skipped = await verifyBranchAbsent({ outcome: 'skipped', logPath, ...creds, fetchImpl: listing([BRANCH]) });
    assert.equal(skipped.ok, true, skipped.message);
    for (const outcome of ['success', 'failure', 'cancelled']) {
      const lost = await verifyBranchAbsent({ outcome, logPath, ...creds, fetchImpl: listing([]) });
      assert.equal(lost.ok, false, outcome);
      assert.match(lost.message, /log is missing/);
    }
    const unknown = await verifyBranchAbsent({ outcome: '', logPath, ...creds, fetchImpl: listing([]) });
    assert.equal(unknown.ok, false);
  });
  await withLog(`${CREATING}\n`, async (logPath) => {
    const inconsistent = await verifyBranchAbsent({ outcome: 'skipped', logPath, ...creds, fetchImpl: listing([]) });
    assert.equal(inconsistent.ok, false);
  });
});

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mg-repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  return { dir, git };
}

function write(dir, path, content) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

test('manifest: lists every changed path with deletions and renames, and hashes gated content on both sides', () => {
  const { dir, git } = tempRepo();
  const cwd = process.cwd();
  try {
    write(dir, 'migrations/0001_drop_me.sql', 'create table a();\n');
    write(dir, 'migrations/0002_rename_me.sql', 'create table b(id int);\n-- long enough to stay a rename\n');
    write(dir, 'docs/with space.md', 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('rm', '-q', 'migrations/0001_drop_me.sql');
    git('mv', 'migrations/0002_rename_me.sql', 'migrations/0003_renamed.sql');
    write(dir, 'scripts/data-ops/0001-backfill.ts', 'export {};\n');
    write(dir, 'docs/with space.md', 'y\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');

    process.chdir(dir);
    const lines = buildManifest(base);
    const entries = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const changed = entries.filter((e) => !e.sha256);
    assert.deepEqual(changed.map((e) => e.status).sort(), ['A', 'D', 'M', 'R100']);
    assert.ok(changed.some((e) => e.status === 'D' && e.path === 'migrations/0001_drop_me.sql'));
    assert.ok(changed.some((e) => e.status === 'R100' && e.from === 'migrations/0002_rename_me.sql' && e.path === 'migrations/0003_renamed.sql'));
    assert.ok(changed.some((e) => e.status === 'M' && e.path === 'docs/with space.md'));
    const hashed = entries.filter((e) => e.sha256);
    assert.deepEqual(hashed.map((e) => `${e.side}:${e.path}`).sort(), [
      'base:migrations/0001_drop_me.sql',
      'base:migrations/0002_rename_me.sql',
      'candidate:migrations/0003_renamed.sql',
      'candidate:scripts/data-ops/0001-backfill.ts',
    ]);
    assert.ok(hashed.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
    assert.match(lines[2], new RegExp(`merge-base ${base}$`));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: refuses a candidate that does not contain the dispatch main commit', () => {
  const { dir, git } = tempRepo();
  const cwd = process.cwd();
  try {
    write(dir, 'a.txt', '1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'root');
    git('checkout', '-q', '-b', 'candidate');
    write(dir, 'b.txt', '2\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    git('checkout', '-q', 'main');
    write(dir, 'c.txt', '3\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main moved');
    const movedMain = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'candidate');
    process.chdir(dir);
    assert.throws(() => buildManifest(movedMain), /does not contain dispatch main/);
    assert.throws(() => buildManifest('not-a-sha'), /40-hex/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: name-status parsing rejects truncated or unknown entries', () => {
  assert.deepEqual(parseNameStatus('D\0a b\0R087\0old\0new\0'), [{ status: 'D', path: 'a b' }, { status: 'R087', from: 'old', path: 'new' }]);
  assert.throws(() => parseNameStatus('R100\0only-one\0'), /truncated/);
  assert.throws(() => parseNameStatus('Q\0x\0'), /unexpected/);
});

// The workflow file is read as text: the job-level guard is GitHub's own enforcement,
// and the preflight step body is executed exactly as written.
const workflowPath = fileURLToPath(new URL('../../.github/workflows/migration-gate.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');

function stepRunBody(name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step ${name} not found`);
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  const indent = lines[runAt].indexOf('run:');
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].search(/\S/) <= indent) break;
    body.push(lines[i].slice(indent + 2));
  }
  return body.join('\n');
}

test('workflow: the job is skipped unless dispatched from main, and cleanup requires the preflight', () => {
  assert.match(workflow, /\n  gate:\n(?:    #.*\n)*    if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n/);
  assert.match(workflow, /- name: Confirm the disposable branch is gone\n\s+if: always\(\) && steps\.dispatch\.outcome == 'success'\n/);
  assert.match(workflow, /\n    defaults:\n      run:\n        shell: bash\n/);
  // Secrets appear only in the gate and cleanup steps.
  const secretSteps = workflow.split(/\n      - /).filter((s) => s.includes('secrets.')).map((s) => s.split('\n')[0]);
  assert.deepEqual(secretSteps, ['name: Gate on a disposable Neon branch', 'name: Confirm the disposable branch is gone']);
  const executable = workflow.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(executable, /drizzle-kit migrate|run-data-ops|git push|contents: write|persist-credentials: true/);
});

const bash = process.platform === 'win32' ? null : 'bash';
test('workflow: preflight accepts only a main dispatch of this workflow', { skip: !bash && 'runs on the Linux CI unit job; Windows has no POSIX bash on PATH' }, () => {
  const body = stepRunBody('Require the main workflow definition');
  const run = (env) => spawnSync(bash, ['-eo', 'pipefail', '-c', body], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const good = { EVENT_NAME: 'workflow_dispatch', DISPATCH_REF: 'refs/heads/main', REPOSITORY: 'o/r', WORKFLOW_REF: 'o/r/.github/workflows/migration-gate.yml@refs/heads/main' };
  assert.equal(run(good).status, 0);
  assert.notEqual(run({ ...good, DISPATCH_REF: 'refs/heads/lcc/candidate' }).status, 0);
  assert.notEqual(run({ ...good, WORKFLOW_REF: 'o/r/.github/workflows/migration-gate.yml@refs/heads/lcc/candidate' }).status, 0);
  assert.notEqual(run({ ...good, WORKFLOW_REF: 'o/r/.github/workflows/other.yml@refs/heads/main' }).status, 0);
  assert.notEqual(run({ ...good, EVENT_NAME: 'push' }).status, 0);
  assert.notEqual(run({ ...good, DISPATCH_REF: '' }).status, 0);
});

test('workflow: the gate step relays no raw output, only the trusted summary', () => {
  const body = stepRunBody('Gate on a disposable Neon branch');
  assert.doesNotMatch(body, /\btee\b|\bgrep\b|\bcat\b|\becho\b/);
  assert.match(body, /> "\$RUNNER_TEMP\/gate\.log" 2>&1 \|\| rc=\$\?/);
  assert.match(body, /node "\$GITHUB_WORKSPACE\/trusted\/scripts\/migration-gate\/summarize-gate-log\.mjs" "\$RUNNER_TEMP\/gate\.log" "\$rc"$/m);
});

const READY = '[gate] READY_TO_PROMOTE — migration and data-ops both passed on an isolated branch.';
const PRIVATE = 'PRIVATE_SYNTHETIC_ROW=learner-content';

test('summary: a fixed template with re-rendered values, whatever follows an accepted prefix', () => {
  const raw = [
    `[gate] ${PRIVATE}`,
    `[gate] Running ${PRIVATE}`,
    `[gate] FAILED: ${PRIVATE}`,
    `✖ ${PRIVATE} (1.2ms)`,
    `ℹ tests 5 ${PRIVATE}`,
    `ℹ pass ${PRIVATE}`,
    `[ci:test:unit 2/168 (command 2/230)] PART 1/2 FAILED (exit 1): ${PRIVATE}`,
    'ℹ tests 12',
    'ℹ pass 10',
    'ℹ fail 2',
    `  AssertionError: ${PRIVATE}`,
  ].join('\n');
  for (const rc of ['1', '0']) {
    const { lines } = summarize(raw, rc);
    const out = lines.join('\n');
    assert.doesNotMatch(out, /PRIVATE|learner/);
    assert.equal(lines.length, 7);
    assert.match(out, /test totals: tests 12, pass 10, fail 2, skipped 0, cancelled 0, todo 0/);
    assert.match(out, /gate groups started: 1/);
  }
});

test('summary: verdict is a closed set and only an exact READY line with exit 0 passes', () => {
  assert.deepEqual(summarize(`${READY}\n`, '0').exitCode, 0);
  assert.match(summarize(`${READY}\n`, '0').lines[1], /^verdict: READY_TO_PROMOTE$/);
  // Non-zero exit wins over a printed READY line, and is preserved.
  assert.equal(summarize(`${READY}\n`, '1').exitCode, 1);
  assert.match(summarize(`${READY}\n`, '1').lines[1], /^verdict: FAILED$/);
  assert.equal(summarize(`${READY}\n`, '7').exitCode, 7);
  // Exit 0 without exactly one READY line, or with a FAILED line, is incomplete and fails.
  for (const text of ['', `${READY}\n${READY}\n`, `${READY}\n[gate] FAILED: x\n`, `${READY} extra\n`, `[gate] READY_TO_PROMOTE ${PRIVATE}\n`]) {
    const result = summarize(text, '0');
    assert.equal(result.exitCode, 1, JSON.stringify(text));
    assert.match(result.lines[1], /^verdict: INCOMPLETE$/);
  }
  // Missing log or unparseable exit code.
  assert.match(summarize(null, '0').lines[1], /INCOMPLETE/);
  assert.equal(summarize(null, '0').exitCode, 1);
  assert.match(summarize(READY, 'x').lines.join('\n'), /verdict: INCOMPLETE[\s\S]*gate exit code: unknown/);
});

test('workflow: the real gate step body leaks no accepted-prefix data and keeps the exit code', { skip: !bash && 'runs on the Linux CI unit job; Windows has no POSIX bash on PATH' }, () => {
  const body = stepRunBody('Gate on a disposable Neon branch');
  const dir = mkdtempSync(join(tmpdir(), 'mg-gate-'));
  const workspace = fileURLToPath(new URL('../../', import.meta.url));
  try {
    mkdirSync(join(dir, 'trusted', 'scripts', 'migration-gate'), { recursive: true });
    writeFileSync(join(dir, 'trusted', 'scripts', 'migration-gate', 'summarize-gate-log.mjs'),
      readFileSync(join(workspace, 'scripts', 'migration-gate', 'summarize-gate-log.mjs')));
    for (const [code, last, expected] of [[1, `[gate] FAILED: ${PRIVATE}`, 1], [0, READY, 0], [0, `[gate] ${PRIVATE}`, 1]]) {
      writeFileSync(join(dir, 'npm'), [
        '#!/usr/bin/env bash',
        `echo '${CREATING}'`,
        `echo '[gate] ${PRIVATE}'`,
        `echo '✖ ${PRIVATE} (1.2ms)'`,
        `echo 'ℹ tests 3 ${PRIVATE}'`,
        `echo '[ci:test:unit 2/168 (command 2/230)] PART 1/2 FAILED (exit 1): ${PRIVATE}'`,
        `echo '${PRIVATE}' >&2`,
        "echo 'ℹ fail 1'",
        `echo '${last}'`,
        `exit ${code}`,
      ].join('\n'), { mode: 0o755 });
      const result = spawnSync(bash, ['-eo', 'pipefail', '-c', body], {
        env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_WORKSPACE: dir }, encoding: 'utf8',
      });
      assert.equal(result.status, expected, `${code} ${last}`);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|learner/);
      assert.match(result.stdout, /^verdict: (READY_TO_PROMOTE|FAILED|INCOMPLETE)$/m);
      assert.match(readFileSync(join(dir, 'gate.log'), 'utf8'), /PRIVATE_SYNTHETIC_ROW/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
