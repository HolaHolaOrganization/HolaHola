import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordBootDiagnosticEntry } from './coordination-listener-boot-diagnostic';
import { bootChildEnvironment, workspaceBootConfig } from './coordination-listener-boot';

const state = '.local/coordination-listeners/luca-replit/boot/diagnostics';
const tag = 'invocation.ABCDE12345';
const source = resolve('server/scripts/coordination-listener-boot-diagnostic.sh');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'boot-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'server/scripts'), { recursive: true });
  await copyFile(source, join(root, 'server/scripts/coordination-listener-boot-diagnostic.sh'));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'out'));
  for (const command of ['mkdir', 'mktemp', 'date']) {
    const executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command],
      { encoding: 'utf8' }).trim();
    await symlink(executable, join(root, 'bin', command));
  }
  return root;
}
async function fakeNode(root: string, body = 'exit "${TEST_EXIT:-0}"') {
  await writeFile(join(root, 'bin/node'), `#!/bin/sh
printf '%s\\n' "$$" > "$TEST_OUT/pid"
printf '%s\\n' "$@" > "$TEST_OUT/argv"
printf '%s\\n' "$HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN" > "$TEST_OUT/tag"
printf '%s\\n' SYNTHETIC_STDOUT_SECRET
printf '%s\\n' SYNTHETIC_STDERR_SECRET >&2
${body}
`, { mode: 0o700 });
}
function wrapper(root: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [join(root, 'server/scripts/coordination-listener-boot-diagnostic.sh'), ...args], {
    cwd: '/', encoding: 'utf8',
    env: { PATH: join(root, 'bin'), HOME: root, LANG: 'C', TEST_OUT: join(root, 'out'),
      OPENAI_API_KEY: 'SYNTHETIC_ENV_SECRET', ...extra },
  });
}
async function events(root: string) {
  const names = await readdir(join(root, state));
  assert.equal(names.length, 1);
  const directory = join(root, state, names[0]);
  return { directory, name: names[0], text: await readFile(join(directory, 'events.log'), 'utf8') };
}
async function marker(root: string) {
  const directory = join(root, state, tag);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'events.log'), 'wrapper-fixture\n', { mode: 0o600 });
  return directory;
}

test('wrapper records private fixed phases and execs exact launcher with the same PID', async t => {
  const root = await fixture(t);
  await fakeNode(root);
  const result = wrapper(root);
  assert.equal(result.status, 0);
  const e = await events(root), lines = e.text.trim().split('\n');
  assert.equal(lines.length, 2);
  const pid = (await readFile(join(root, 'out/pid'), 'utf8')).trim();
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ phase=shell-invoked pid=${pid}$`));
  assert.match(lines[1], new RegExp(`phase=node-exec-attempt pid=${pid}$`));
  assert.equal(await readFile(join(root, 'out/argv'), 'utf8'),
    `--import\ntsx\n${root}/server/scripts/coordination-listener-boot.ts\n`);
  assert.equal((await readFile(join(root, 'out/tag'), 'utf8')).trim(), e.name);
  assert.equal((await stat(e.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(e.directory, 'events.log'))).mode & 0o777, 0o600);
  assert.match(result.stdout, /SYNTHETIC_STDOUT_SECRET/);
  assert.match(result.stderr, /SYNTHETIC_STDERR_SECRET/);
  assert.doesNotMatch(e.text, /SYNTHETIC|OPENAI|--import|server\/scripts/);
});
test('exec preserves an early Node/loader failure exit and never records false entry', async t => {
  const root = await fixture(t);
  await fakeNode(root);
  const result = wrapper(root, [], { TEST_EXIT: '23' });
  assert.equal(result.status, 23);
  const e = await events(root);
  assert.match(e.text, /phase=node-exec-attempt/);
  assert.doesNotMatch(e.text, /phase=node-entry/);
});
test('missing Node is distinguishable without Node or network access', async t => {
  const root = await fixture(t);
  assert.equal(wrapper(root).status, 127);
  const e = await events(root);
  assert.match(e.text, /phase=shell-invoked/);
  assert.match(e.text, /phase=node-unavailable/);
  assert.doesNotMatch(e.text, /node-exec-attempt|node-entry/);
});
test('wrapper refuses arbitrary arguments before writes or execution', async t => {
  const root = await fixture(t);
  await fakeNode(root);
  const result = wrapper(root, ['SYNTHETIC_ARG_SECRET']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /SYNTHETIC/);
  await assert.rejects(readdir(join(root, '.local')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'out/pid')), { code: 'ENOENT' });
});
test('wrapper refuses redirected local ancestors without touching their target', async t => {
  const root = await fixture(t);
  await fakeNode(root);
  await symlink(join(root, 'out'), join(root, '.local'));
  assert.equal(wrapper(root).status, 1);
  assert.deepEqual(await readdir(join(root, 'out')), []);
});
test('entry marker is opt-in, private, fixed and append-only', async t => {
  const root = await fixture(t);
  await recordBootDiagnosticEntry(root);
  await assert.rejects(readdir(join(root, '.local')), { code: 'ENOENT' });
  const directory = await marker(root);
  await recordBootDiagnosticEntry(root, tag);
  const text = await readFile(join(directory, 'events.log'), 'utf8');
  assert.match(text, /^wrapper-fixture\n\d{4}.*Z phase=node-entry pid=\d+\n$/);
  assert.equal((await stat(join(directory, 'events.log'))).mode & 0o777, 0o600);
});
test('invalid tags never become paths or appear in the fixed nonfatal warning', async t => {
  const root = await fixture(t);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => warnings.push(args));
  for (const value of ['../../SYNTHETIC_SECRET', '/tmp/SYNTHETIC_SECRET', '', 'invocation.short']) {
    await recordBootDiagnosticEntry(root, value);
  }
  assert.equal(warnings.length, 4);
  for (const warning of warnings) assert.deepEqual(warning, ['LUCABOOT diagnostic-entry-unavailable']);
  await assert.rejects(readdir(join(root, '.local')), { code: 'ENOENT' });
});
test('entry refuses symlink and hardlink targets without writing them', async t => {
  const root = await fixture(t), directory = await marker(root);
  t.mock.method(console, 'error', () => {});
  const target = join(root, 'out/untouched');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  const file = join(directory, 'events.log');
  await rm(file);
  await symlink(target, file);
  await recordBootDiagnosticEntry(root, tag);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  await rm(file);
  await link(target, file);
  await recordBootDiagnosticEntry(root, tag);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
test('entry refuses public permissions, missing files and redirected run directories', async t => {
  const root = await fixture(t), directory = await marker(root);
  t.mock.method(console, 'error', () => {});
  const file = join(directory, 'events.log');
  await chmod(directory, 0o755);
  await recordBootDiagnosticEntry(root, tag);
  assert.equal(await readFile(file, 'utf8'), 'wrapper-fixture\n');
  await chmod(directory, 0o700);
  await chmod(file, 0o644);
  await recordBootDiagnosticEntry(root, tag);
  assert.equal(await readFile(file, 'utf8'), 'wrapper-fixture\n');
  await rm(file);
  await recordBootDiagnosticEntry(root, tag);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await rm(directory, { recursive: true });
  await symlink(join(root, 'out'), directory);
  await recordBootDiagnosticEntry(root, tag);
  assert.deepEqual(await readdir(join(root, 'out')), []);
});
test('supervisor/child allowlist drops the diagnostic tag and all credential extras', () => {
  const c = workspaceBootConfig('/synthetic-root');
  const environment = bootChildEnvironment(c, {
    PATH: '/synthetic-bin', HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN: tag,
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: 'SYNTHETIC_SECRET',
  });
  assert.equal(environment.HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN, undefined);
  assert.equal(environment.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN, undefined);
});
async function realCliFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fixture(t), directory = await marker(root);
  await copyFile(resolve('server/scripts/coordination-listener-boot.ts'),
    join(root, 'server/scripts/coordination-listener-boot.ts'));
  await symlink(resolve('server/scripts/lib'), join(root, 'server/scripts/lib'));
  await writeFile(join(root, '.replit'), '# synthetic fixture\n');
  const environment = {
    PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', HOLAHOLA_INSTANCE_ROLE: 'dev',
    HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN: tag,
    COORDINATION_RUNTIME_ID: 'luca-replit-primary',
    COORDINATION_CLI_CREDENTIAL_CACHE_DIR: join(root, '.local/coordination-cli-credentials'),
  };
  return { root, directory, environment, entry: join(root, 'server/scripts/coordination-listener-boot.ts') };
}
test('real CLI status remains read-only even with a valid diagnostic tag', async t => {
  const { root, directory, environment, entry } = await realCliFixture(t);
  await writeFile(join(root, '.local/coordination-listeners/luca-replit/boot/status.json'),
    '{"state":"synthetic-read-only"}');
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, 'status'], {
    cwd: process.cwd(), encoding: 'utf8', env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic-read-only/);
  assert.equal(await readFile(join(directory, 'events.log'), 'utf8'), 'wrapper-fixture\n');
});
test('importing real CLI remains read-only even with a valid diagnostic tag', async t => {
  const { directory, environment, entry } = await realCliFixture(t);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module',
    '-e', 'await import(process.env.SYNTHETIC_ENTRY_PATH)'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...environment, SYNTHETIC_ENTRY_PATH: entry },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(await readFile(join(directory, 'events.log'), 'utf8'), 'wrapper-fixture\n');
});
test('real launcher records entry but still fails closed before network when fixture cache is absent', async t => {
  const { root, directory, environment, entry } = await realCliFixture(t);
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd: process.cwd(), encoding: 'utf8', env: environment,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^LUCABOOT failed-closed recovery-required\n$/);
  assert.match(await readFile(join(directory, 'events.log'), 'utf8'), /phase=node-entry pid=\d+\n$/);
  await assert.rejects(readFile(join(root, '.local/coordination-listeners/luca-replit/boot/supervisor.lock')),
    { code: 'ENOENT' });
});
