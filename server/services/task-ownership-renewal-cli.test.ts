import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const loader = pathToFileURL(join(repository, 'node_modules/tsx/dist/loader.mjs')).href;
const cli = join(repository, 'server/scripts/task-ownership-cli.ts');
const token = 'synthetic-fixture-token-never-a-real-credential';
const ref = '900004';
const requests = new Map<string, { payload: any; id: string; expiresAt: string }>();
const statuses = new Map<string, any>();
let root: string;
let workspace: string;
let keyTmp: string;
let base: string;
let requestCount = 0;
const server = createServer(async (req, res) => {
  requestCount++;
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-coordination-token'] !== token) { res.writeHead(401).end('{}'); return; }
  if (req.method === 'GET') {
    const id = req.url?.split('/').pop()!;
    if (!statuses.has(id)) { res.writeHead(404).end('{}'); return; }
    res.end(JSON.stringify(statuses.get(id)));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/task-ownership/challenges') { res.writeHead(404).end('{}'); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  let record = requests.get(payload.idempotencyKey);
  if (record) assert.deepEqual(payload, record.payload);
  else {
    record = { payload, id: randomUUID(), expiresAt: new Date(Date.now() + payload.ttlMs).toISOString() };
    requests.set(payload.idempotencyKey, record);
    statuses.set(record.id, {
      id: record.id, taskRef: payload.taskRef, intendedActor: payload.intendedActor,
      artifactSha256: payload.artifactSha256, keyFingerprint: payload.keyFingerprint,
      expiresAt: record.expiresAt, status: 'pending', receipt: null,
    });
  }
  res.writeHead(201).end(JSON.stringify({ challengeId: record.id, expiresAt: record.expiresAt }));
});
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ownership-renewal-cli-'));
  workspace = join(root, 'checkout');
  keyTmp = join(root, 'key-custody');
  await mkdir(join(workspace, '.local/tasks'), { recursive: true });
  await mkdir(keyTmp);
  await writeFile(join(workspace, '.local/tasks', `task-${ref}.md`), 'Synthetic CLI artifact; not a real task.');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});
async function run(command: string, args: string[] = [], requestedRef = ref) {
  const child = spawn(process.execPath, [
    '--import', loader, cli, command, '--task-ref', requestedRef,
    '--actor', 'luca-replit', '--app-url', base, ...args,
  ], {
    cwd: workspace,
    // No real credentials, DB URLs, REPL_HOME or application state are inherited.
    env: { PATH: process.env.PATH, TMPDIR: keyTmp, TMP: keyTmp, TEMP: keyTmp, COORDINATION_LUCA_REPLIT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}
test('real CLI begins, renews with the same key, and replays exactly across processes', async () => {
  const first = await run('begin');
  assert.equal(first.code, 0, first.stderr);
  const initial = JSON.parse(first.stdout);
  const beginRetry = await run('begin');
  assert.equal(beginRetry.code, 0, beginRetry.stderr);
  assert.equal(JSON.parse(beginRetry.stdout).challengeId, initial.challengeId);
  Object.assign(statuses.get(initial.challengeId), { status: 'expired', expiresAt: new Date(0).toISOString() });
  const renewal = await run('renew', ['--challenge-id', initial.challengeId]);
  assert.equal(renewal.code, 0, renewal.stderr);
  const replacement = JSON.parse(renewal.stdout);
  assert.notEqual(replacement.challengeId, initial.challengeId);
  assert.equal(replacement.fingerprint, initial.fingerprint);
  assert.equal(replacement.status, 'pending');
  const retry = await run('renew', ['--challenge-id', initial.challengeId]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).challengeId, replacement.challengeId);
  assert.equal(requests.size, 2);
  const payloads = [...requests.values()].map(r => r.payload);
  for (const field of ['taskRef', 'intendedActor', 'artifactSha256', 'publicKey', 'keyFingerprint']) {
    assert.equal(payloads[0][field], payloads[1][field]);
  }
  assert.equal(payloads[1].ttlMs, 30 * 60_000);
});
test('CLI rejects malformed options before any network operation', async () => {
  const before = requestCount;
  const noMinutes = await run('renew', ['--approval-minutes']);
  assert.notEqual(noMinutes.code, 0);
  assert.match(noMinutes.stderr, /requires a value/);
  const unsafe = await run('begin', [], '../escape');
  assert.notEqual(unsafe.code, 0);
  assert.match(unsafe.stderr, /positive decimal digits/);
  const badId = await run('renew', ['--challenge-id', '../escape']);
  assert.notEqual(badId.code, 0);
  assert.match(badId.stderr, /valid --challenge-id/);
  assert.equal(requestCount, before);
});
