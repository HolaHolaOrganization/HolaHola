import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = readFileSync(new URL('./post-merge.sh', import.meta.url), 'utf8');
const posixOnly = {
  skip: process.platform === 'win32'
    ? 'Automatic post-merge setup and executable command stubs run in the POSIX workspace'
    : false,
};

function isolatedRun({ gateExit = 0, source = script } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'post-merge-no-migration-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'scripts', 'post-merge.sh'), source);
    writeFileSync(join(root, 'scripts', 'gemini-gate-check.sh'), `exit ${gateExit}\n`);
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
