const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const scriptPath = path.join(__dirname, 'alden-build-guardian.js');
const source = fs.readFileSync(scriptPath, 'utf8');

// Exercise the actual function bodies without starting the detached recovery flow.
// Only the four static imports and the CLI invocation are removed.
function loadGuardian(token) {
  const entrypoint = source.lastIndexOf('\nmain().catch(');
  assert.ok(entrypoint > 0, 'CLI entrypoint must remain recognizable');
  const body = source.slice(0, entrypoint).replace(/^import .+;\r?$/gm, '');
  let requested;
  const forbidden = () => { throw new Error('Unexpected filesystem/process side effect'); };
  const context = vm.createContext({
    process: { env: token === undefined ? {} : { GUARDIAN_TOKEN: token }, exit: forbidden },
    console: { log() {}, error() {} },
    Buffer,
    setTimeout,
    fs: { readFileSync: forbidden, writeFileSync: forbidden, unlinkSync: forbidden },
    path,
    execFileSync: forbidden,
    http: {
      request(options, respond) {
        requested = options;
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.write = () => {};
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 200;
          respond(res);
          res.emit('data', '{}');
          res.emit('end');
        };
        return req;
      },
    },
  });
  vm.runInContext(body, context, { filename: scriptPath });
  return { context, request: () => requested };
}

for (const token of [undefined, '', ' \t ']) {
  test(`missing/blank token fails before any recovery side effects (${JSON.stringify(token)})`, async () => {
    const guardian = loadGuardian(token);
    await assert.rejects(guardian.context.main(), /GUARDIAN_TOKEN must be configured/);
    assert.equal(guardian.request(), undefined);
  });
}

test('callback uses the configured token, including a rotated replacement', async () => {
  for (const token of ['synthetic-guardian-first', 'synthetic-guardian-rotated']) {
    const guardian = loadGuardian(token);
    const result = await guardian.context.postToServer(5000, '/synthetic-callback', {});
    assert.equal(result.status, 200);
    assert.equal(guardian.request().headers['X-Guardian-Token'], token);
  }
});

test('real Node entrypoint runs as ESM and fails closed without a token', () => {
  const child = spawnSync(process.execPath, [scriptPath], {
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /GUARDIAN_TOKEN must be configured/);
  assert.doesNotMatch(child.stderr, /require is not defined|Cannot read manifest/);
});
