/**
 * Proof for O2/O3 containment (plan efb1e3d1 rev 13, step 1): the ACTUAL
 * launch commands cannot resume held writers outside a verified disposable CI
 * database. It exercises scripts/launch-gate.sh, every shell.exec workflow
 * command in .replit, scripts/start-application.sh, and the in-script holds,
 * using shims for npx/node/npm/tsx that only record what they were asked to
 * run. No real server, database or network is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HELD_WRITERS } from './lib/launch-hold';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'launch-gate.sh');
const POSIX = process.platform !== "win32" || process.env.LAUNCH_GATE_TEST_FORCE_POSIX === "1";
const LOCAL_CI = 'postgresql://postgres:postgres@127.0.0.1:5432/holahola_ci';
const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: mkdtempSync(join(tmpdir(), 'gate-home-')) };

function bash(command: string, env: Record<string, string>, cwd = ROOT) {
  const result = spawnSync('bash', ['-c', command], { cwd, env: { ...BASE_ENV, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function shimDir(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-shims-'));
  const log = join(dir, 'invocations.log');
  // flock is a pass-through lock shim: start-application.sh's singleton lock is
  // not under test, and Git Bash on Windows has no flock.
  for (const name of ['npx', 'node', 'npm', 'tsx', 'ssh-keyscan', 'flock']) {
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  return { dir, log };
}

const readLog = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const GATE_IDS = readFileSync(GATE, 'utf8').replace(/\r\n/g, '\n').match(/REGISTERED_IDS=\(\n([\s\S]*?)\n\)/)![1]
  .split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);

test('gate registry covers every in-script held writer', () => {
  for (const id of HELD_WRITERS) assert.ok(GATE_IDS.includes(id), `${id} missing from launch-gate.sh`);
});

test('the gate runs a registered command only against the verified disposable CI database', { skip: !POSIX }, () => {
  const run = (env: Record<string, string>, id = 'capture-watchdog') =>
    bash(`bash "${GATE}" ${id} -- bash -c 'echo RAN'`, env);
  const verified = { CI: 'true', CI_DATABASE_URL: LOCAL_CI, NEON_SHARED_DATABASE_URL: LOCAL_CI };
  for (const id of GATE_IDS) assert.match(run(verified, id).out, /RAN/, id);

  const held: Array<[string, Record<string, string>]> = [
    ['no CI at all', {}],
    ['production role does not unlock', { HOLAHOLA_INSTANCE_ROLE: 'production' }],
    ['dev role', { HOLAHOLA_INSTANCE_ROLE: 'dev', NEON_SHARED_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db' }],
    ['CI flag missing', { CI_DATABASE_URL: LOCAL_CI, NEON_SHARED_DATABASE_URL: LOCAL_CI }],
    ['remote CI database', { CI: 'true', CI_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db', NEON_SHARED_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db' }],
    ['app DB differs from CI DB', { CI: 'true', CI_DATABASE_URL: LOCAL_CI, NEON_SHARED_DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db' }],
    ['lookalike host', { CI: 'true', CI_DATABASE_URL: 'postgresql://u:p@127.0.0.1.evil.example/db', NEON_SHARED_DATABASE_URL: 'postgresql://u:p@127.0.0.1.evil.example/db' }],
  ];
  for (const [label, env] of held) {
    const result = run(env);
    assert.equal(result.code, 0, label);
    assert.doesNotMatch(result.out, /RAN/, label);
    assert.match(result.out, /NOT RUN: 'capture-watchdog' is HELD/, label);
  }
});

test('the gate refuses unknown ids and malformed calls', { skip: !POSIX }, () => {
  assert.equal(bash(`bash "${GATE}" not-registered -- true`, {}).code, 2);
  assert.equal(bash(`bash "${GATE}" capture-watchdog true`, {}).code, 2);
  assert.equal(bash(`bash "${GATE}" capture-watchdog --`, {}).code, 2);
});

/** shell.exec task commands from .replit, in order. */
function replitShellCommands(): string[] {
  const text = readFileSync(join(ROOT, '.replit'), 'utf8');
  const commands: string[] = [];
  const re = /task = "shell\.exec"\s*\nargs = "((?:[^"\\]|\\.)*)"/g;
  for (const m of text.matchAll(re)) commands.push(m[1].replace(/\\"/g, '"'));
  return commands;
}

// Launch commands that do not write shared state, or are covered separately.
const UNGATED_ALLOWED = new Set([
  'bash scripts/start-application.sh', // covered below; its writer step is gated inside
  'bash server/scripts/check-user-openai-key-absent.sh', // environment check, no writes
]);

test('every .replit launch command is gated or explicitly a non-writer (fail-closed inventory)', () => {
  const commands = replitShellCommands();
  assert.ok(commands.length >= 6, 'expected the Replit workflow commands');
  for (const command of commands) {
    const gated = /^bash scripts\/launch-gate\.sh [a-z-]+ -- /.test(command);
    assert.ok(gated || UNGATED_ALLOWED.has(command), `ungated launch command: ${command}`);
  }
});

test('the ACTUAL gated .replit commands start nothing outside a disposable CI DB', { skip: !POSIX }, () => {
  for (const command of replitShellCommands().filter((c) => c.startsWith('bash scripts/launch-gate.sh'))) {
    for (const env of [{}, { HOLAHOLA_INSTANCE_ROLE: 'dev' }, { HOLAHOLA_INSTANCE_ROLE: 'production' }]) {
      const { dir, log } = shimDir();
      const result = bash(command, { ...env, PATH: `${dir}:${BASE_ENV.PATH}`, NEON_SHARED_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none' });
      assert.match(result.out, /NOT RUN: '[a-z-]+' is HELD/, command);
      assert.equal(readLog(log), '', `nothing may be invoked: ${command}`);
      assert.doesNotMatch(result.out, /CHECK:/, 'no validation check may start');
    }
  }
});

test('start-application.sh never runs the rolling-episode restore outside a disposable CI DB', { skip: !POSIX }, () => {
  const { dir, log } = shimDir();
  const lock = join(mkdtempSync(join(tmpdir(), 'gate-lock-')), 'start.lock');
  const result = bash('bash scripts/start-application.sh', {
    PATH: `${dir}:${BASE_ENV.PATH}`,
    PORT: '59173',
    START_APPLICATION_LOCK_FILE: lock,
    HOLAHOLA_INSTANCE_ROLE: 'dev',
    GIT_CONFIG_GLOBAL: join(BASE_ENV.HOME, '.gitconfig'),
  });
  const invoked = readLog(log);
  assert.match(result.out, /NOT RUN: 'rolling-episode-restore' is HELD/);
  assert.doesNotMatch(invoked, /restore-rolling-episodes-from-db/);
  assert.match(invoked, /npm run dev/, 'the dev server itself still starts (its own role gate applies)');
});

test('held writers launched DIRECTLY refuse before doing any work', () => {
  const scripts: Array<[string, string]> = [
    ['server/scripts/restore-rolling-episodes-from-db.ts', 'rolling-episode-restore'],
    ['server/scripts/capture-watchdog.ts', 'capture-watchdog'],
    ['server/scripts/test-luca-chat-canonical-save.ts', 'luca-chat-canonical-save'],
  ];
  for (const [script, id] of scripts) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: BASE_ENV.HOME,
        USERPROFILE: process.env.USERPROFILE ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        NEON_SHARED_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none',
        HOLAHOLA_INSTANCE_ROLE: 'dev',
      },
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `${script} exit: ${out.slice(-400)}`);
    assert.match(out, new RegExp(`NOT RUN: '${id}' is HELD`), script);
    assert.doesNotMatch(out, /\[watchdog\] started|Restoring|CHECK:/, `${script} must not start work`);
  }
});
