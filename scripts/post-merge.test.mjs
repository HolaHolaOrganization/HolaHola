import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = readFileSync(new URL('./post-merge.sh', import.meta.url), 'utf8');
const posixOnly = {
  skip: process.platform === 'win32' && process.env.LAUNCH_GATE_TEST_FORCE_POSIX !== '1'
    ? 'Automatic post-merge setup and executable command stubs run in the POSIX workspace'
    : false,
};

function isolatedRun({ gateExit = 0, source = script, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'post-merge-no-migration-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'scripts', 'post-merge.sh'), source);
    writeFileSync(join(root, 'scripts', 'gemini-gate-check.sh'), `exit ${gateExit}\n`);
    // The real launch gate and its policy, so the actual restore command path is exercised.
    mkdirSync(join(root, 'scripts', 'lib'));
    copyFileSync(new URL('./launch-gate.sh', import.meta.url), join(root, 'scripts', 'launch-gate.sh'));
    copyFileSync(new URL('./lib/disposable-target.sh', import.meta.url), join(root, 'scripts', 'lib', 'disposable-target.sh'));
    const log = join(root, 'commands.jsonl');
    for (const command of ['git', 'npm', 'npx']) {
      writeFileSync(join(root, 'bin', command), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + '\\n');
if (args.some(arg => /migrat|db:push|db:branch/.test(arg))) process.exit(86);
`, { mode: 0o755 });
    }
    writeFileSync(log, '');
    // No application credentials or database environment are inherited.
    const result = spawnSync('bash', ['scripts/post-merge.sh'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        HOME: root,
        COMMAND_LOG: log,
        SOURCE_CONTROL_WAKE_FILE: join(root, '.local', 'source-control-wake'),
        ...env,
      },
    });
    if (result.error) throw result.error;
    return {
      ...result,
      commands: readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('automatic setup keeps ordinary steps but never invokes database migrations', posixOnly, () => {
  const result = isolatedRun();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Database migrations SKIPPED: separate explicit authorization required/);
  assert.ok(result.commands.some(c => c.command === 'npm'
    && JSON.stringify(c.args) === JSON.stringify(['install', '--legacy-peer-deps'])));
  assert.ok(result.commands.some(c => c.command === 'npx'
    && c.args.includes('server/scripts/check-episode-content-loss.ts')));
  assert.ok(!result.commands.some(c => c.args.some(arg => /migrat|db:push|db:branch/.test(arg))));
});

test('a failed approval gate still prevents every subsequent setup command', posixOnly, () => {
  const result = isolatedRun({ gateExit: 17 });
  assert.equal(result.status, 17);
  assert.deepEqual(result.commands, []);
});

test('negative control fails if an automatic migration invocation is restored', posixOnly, () => {
  const result = isolatedRun({ source: `${script}\nnpx drizzle-kit migrate\n` });
  assert.equal(result.status, 86);
  assert.ok(result.commands.some(c => c.command === 'npx'
    && JSON.stringify(c.args) === JSON.stringify(['drizzle-kit', 'migrate'])));
});

const restoreInvocations = (commands) => commands.filter(c => c.command === 'npx'
  && c.args.some(arg => /restore-episode-2[78]-from-db\.ts/.test(arg)));

test('automatic episode-27/28 restores are HELD outside a disposable CI database', posixOnly, () => {
  for (const env of [{}, { HOLAHOLA_INSTANCE_ROLE: 'dev' }, { HOLAHOLA_INSTANCE_ROLE: 'production' }]) {
    const result = isolatedRun({ env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NOT RUN: 'episode-27-restore' is HELD/);
    assert.match(result.stdout, /NOT RUN: 'episode-28-restore' is HELD/);
    assert.deepEqual(restoreInvocations(result.commands), []);
  }
});

test('the episode restores still run against the verified disposable CI database', posixOnly, () => {
  const ci = 'postgresql://postgres:postgres@127.0.0.1:5432/holahola_ci';
  const result = isolatedRun({ env: { CI: 'true', CI_DATABASE_URL: ci, NEON_SHARED_DATABASE_URL: ci } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(restoreInvocations(result.commands).length, 2);
});
