import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture(t, malformed = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/run-ci-test-steps.mjs'), path.join(dir, 'scripts/run-ci-test-steps.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), malformed ? '{invalid' : fs.readFileSync(path.join(root, 'package.json')));
  const marker = path.join(dir, 'unexpected-child');
  const hook = path.join(dir, 'no-spawn.mjs');
  fs.writeFileSync(hook, `import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
cp.spawn = () => { fs.writeFileSync(${JSON.stringify(marker)}, 'spawned'); throw Error('Unexpected test execution'); };
syncBuiltinESMExports();`);
  return args => {
    const result = spawnSync(process.execPath, ['--import', hook, path.join(dir, 'scripts/run-ci-test-steps.mjs'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, CI: 'true' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(marker), false, 'inspection/invalid flags must never spawn tests');
    return result;
  };
}

for (const args of [
  ['--unknown'], ['--list', '--group=unit', '--bogus'], ['--group='],
  ['--group=wrong'], ['--group=unit', '--group=guards'], ['--list', '--list'],
  ['unit'], ['--help', '--bogus'],
]) {
  test(`reject arguments before reading the manifest: ${args.join(' ')}`, t => {
    const result = fixture(t, true)(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /JSON|START|ALL .*PASSED/);
  });
}

test('help needs neither a valid manifest nor database credentials', t => {
  const result = fixture(t, true)(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test('list is read-only, covers exactly all groups, and requires no database credentials', t => {
  const run = fixture(t);
  const all = run(['--list']);
  assert.equal(all.status, 0, all.stderr);
  const groups = ['unit', 'guards', 'episodes'].map(group => {
    const result = run(['--list', `--group=${group}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
    assert.doesNotMatch(result.stdout, /START|PASSED/);
    return result.stdout;
  });
  assert.equal(groups.join(''), all.stdout);
  assert.match(all.stdout, /run-ci-test-steps\.test\.mjs/);
  assert.match(all.stdout, /validated-source-write\.test\.ts/);
});

test('real execution still enforces the isolated CI database gate', t => {
  const result = fixture(t)(['--group=unit']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires CI_DATABASE_URL/);
  assert.doesNotMatch(result.stdout, /START/);
});
