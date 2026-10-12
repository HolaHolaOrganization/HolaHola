import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { canonicalJson } from './task-ownership-service';
// The existing CI entrypoint also runs the renewal suites. Keep the separately
// reviewed listener/CI payload unchanged while its source landing is pending.
import './task-ownership-attempt.test';
import './task-ownership-renewal-cli.test';

// All keys, task artifacts, and child-process state belong to this private fixture.
const root = mkdtempSync(join(tmpdir(), 'ownership-client-'));
const workspace = join(root, 'checkout');
const childTmp = join(root, 'tmp');
const taskRef = '900001';
const actor = 'luca-replit';
const receiptId = 'fixture-receipt';
const token = 'dummy-fixture-token-not-a-real-credential';
const artifact = 'Synthetic ownership test artifact; never a canonical task.';
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const keys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicKey = keys.publicKey.toString('base64url');
const fingerprint = createHash('sha256').update(keys.publicKey).digest('hex');
const repo = resolve(import.meta.dirname, '../..');
const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href;
const clientModule = pathToFileURL(join(repo, 'server/services/task-ownership-client.ts')).href;
let baseUrl: string;
let noncePatch: Record<string, unknown> = {};
let payloadPatch: Record<string, unknown> = {};
let resultPatch: Record<string, unknown> = {};
let includeGrant = false;
let proofCalls = 0;
let validSignatures = 0;
let requests = 0;
let nonceRejection = '';
let consumed = false;
let changeArtifactDuringProof = false;

function nonceResponse() {
  return {
    nonceId: 'fixture-nonce-id',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signedPayload: {
      nonce: 'fixture-one-time-nonce', nonceId: 'fixture-nonce-id',
      receiptId, taskRef, intendedActor: actor, artifactSha256,
      publicKey, keyFingerprint: fingerprint, challengeId: 'fixture-challenge',
      payloadDigest: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...payloadPatch,
    },
    ...noncePatch,
  };
}

let signedPayload: ReturnType<typeof nonceResponse>['signedPayload'];
const server = createServer(async (req, res) => {
  requests++;
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-coordination-token'] !== token) {
    res.writeHead(401).end(JSON.stringify({ error: 'invalid fixture auth' }));
    return;
  }
  if (req.url === `/api/task-ownership/receipts/${receiptId}/proof-nonce`) {
    if (nonceRejection) {
      res.writeHead(403).end(JSON.stringify({ error: nonceRejection }));
      return;
    }
    const nonce = nonceResponse();
    signedPayload = nonce.signedPayload;
    res.end(JSON.stringify(nonce));
    return;
  }
  if (req.url !== '/api/task-ownership/proof') {
    res.writeHead(404).end('{}');
    return;
  }
  proofCalls++;
  if (consumed) {
    res.writeHead(409).end(JSON.stringify({ error: 'NONCE_REPLAYED' }));
    return;
  }
  consumed = true;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const bytes = Buffer.from(canonicalJson(signedPayload));
  const valid = body.nonceId === 'fixture-nonce-id' && verify(
    null, bytes, createPublicKey({ key: keys.publicKey, type: 'spki', format: 'der' }),
    Buffer.from(body.signature, 'base64url'),
  );
  if (valid) validSignatures++;
  if (changeArtifactDuringProof) {
    writeFileSync(join(workspace, '.local/tasks', `task-${taskRef}.md`), 'changed synthetic artifact');
  }
  const proof = {
    ok: valid, verified: valid, receiptId, taskRef, intendedActor: actor,
    artifactSha256, proofPayloadDigest: createHash('sha256').update(bytes).digest('hex'),
    ...(includeGrant ? {
      contextDigest: 'fixture-context',
      grant: { id: 'fixture-grant', taskRef, artifactSha256, contextDigest: 'fixture-context',
        startingCommit: 'b'.repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    } : {}),
    ...resultPatch,
  };
  res.end(JSON.stringify(proof));
});

before(async () => {
  mkdirSync(join(workspace, '.local/tasks'), { recursive: true });
  mkdirSync(join(workspace, '.git'));
  mkdirSync(join(childTmp, 'task-agent-ownership', `task-${taskRef}`), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, '.local/tasks', `task-${taskRef}.md`), artifact);
  writeFileSync(join(childTmp, 'task-agent-ownership', `task-${taskRef}`, 'private-key.pem'), keys.privateKey, { mode: 0o600 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

function reset() {
  noncePatch = {}; payloadPatch = {}; resultPatch = {}; includeGrant = false;
  proofCalls = 0; validSignatures = 0; requests = 0;
  nonceRejection = ''; consumed = false;
  changeArtifactDuringProof = false;
  writeFileSync(join(workspace, '.local/tasks', `task-${taskRef}.md`), artifact);
}

async function run(mode: 'cli' | 'runtime' | 'standalone' | 'diagnostic' = 'cli', requestedRef = taskRef) {
  const args = mode === 'cli' || mode === 'diagnostic'
    ? [join(repo, 'server/scripts/task-ownership-cli.ts'), mode === 'cli' ? 'prove' : 'diagnostic',
      '--task-ref', requestedRef, '--actor', actor, '--receipt-id', receiptId, '--app-url', baseUrl]
    : ['--input-type=module', '-e', `
      import {TaskOwnershipHttpClient, proveTaskOwnership, proveStandaloneTaskOwnership} from ${JSON.stringify(clientModule)};
      const client = new TaskOwnershipHttpClient(${JSON.stringify(baseUrl)}, ${JSON.stringify(token)});
      const result = await ${mode === 'runtime' ? 'proveTaskOwnership' : 'proveStandaloneTaskOwnership'}(
        client, ${JSON.stringify(taskRef)}, ${JSON.stringify(actor)}, ${JSON.stringify(receiptId)}, ${JSON.stringify(artifactSha256)});
      console.log(JSON.stringify(result));
    `];
  // Explicit fixture credentials; never inherit ambient app credentials or DB URLs.
  const child = spawn(process.execPath, ['--import', loader, ...args], {
    cwd: workspace, env: { PATH: process.env.PATH, TMPDIR: childTmp, COORDINATION_LUCA_REPLIT_TOKEN: token },
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

test('actual CLI accepts approved proof-only response in a primary-shaped fixture checkout', async () => {
  reset();
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const ownership = JSON.parse(result.stdout);
  assert.equal(ownership.state, 'isolated_agent');
  assert.equal(ownership.evidence.verifiedActiveMainReceipt, false);
  assert.equal(ownership.evidence.checkout.kind, 'primary_worktree');
  assert.equal(validSignatures, 1);
});

test('a task artifact alone still cannot authorize the diagnostic probe', async () => {
  reset();
  const result = await run('diagnostic');
  assert.equal(result.code, 75);
  assert.equal(JSON.parse(result.stdout).state, 'unknown_stop');
  assert.equal(requests, 0);
});

test('invalid task refs are refused before reading artifacts or contacting the server', async () => {
  reset();
  const result = await run('cli', '../outside');
  assert.equal(result.code, 64);
  assert.match(result.stderr, /positive decimal digits/);
  assert.equal(requests, 0);
});

test('an artifact changed during proof cannot authorize the final ownership classification', async () => {
  reset(); changeArtifactDuringProof = true;
  const result = await run();
  assert.equal(result.code, 75);
  assert.equal(JSON.parse(result.stdout).state, 'unknown_stop');
  assert.equal(validSignatures, 1);
});

for (const [field, wrong] of Object.entries({
  taskRef: '900002', intendedActor: 'luca-claude-code', receiptId: 'other-receipt',
  artifactSha256: 'c'.repeat(64), nonceId: 'other-nonce', publicKey: 'other-key',
  keyFingerprint: 'd'.repeat(64), nonce: '', expiresAt: '2000-01-01T00:00:00.000Z',
})) {
  test(`standalone rejects nonce ${field} mismatch before posting a signature`, async () => {
    reset(); payloadPatch = { [field]: wrong };
    const result = await run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /nonce/);
    assert.equal(proofCalls, 0);
  });
}

for (const [field, wrong] of Object.entries({
  taskRef: '900002', intendedActor: 'luca-claude-code', receiptId: 'other-receipt',
  artifactSha256: 'c'.repeat(64), proofPayloadDigest: 'd'.repeat(64), ok: false, verified: false,
})) {
  test(`standalone rejects proof response ${field} mismatch`, async () => {
    reset(); resultPatch = { [field]: wrong };
    const result = await run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /standalone ownership proof response/);
    assert.equal(validSignatures, 1);
  });
}

test('standalone rejects an expired server nonce before signing', async () => {
  reset(); noncePatch = { expiresAt: '2000-01-01T00:00:00.000Z' };
  assert.notEqual((await run()).code, 0);
  assert.equal(proofCalls, 0);
});

for (const reason of ['RECEIPT_NOT_ACTIVE', 'RECEIPT_NOT_FOUND', 'ACTOR_MISMATCH']) {
  test(`server denial ${reason} does not establish ownership or post a signature`, async () => {
    reset(); nonceRejection = reason;
    const result = await run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /endpoint unavailable \(403\)/);
    assert.equal(proofCalls, 0);
  });
}

test('server-rejected replay cannot establish ownership', async () => {
  reset();
  assert.equal((await run()).code, 0);
  const replay = await run();
  assert.notEqual(replay.code, 0);
  assert.match(replay.stderr, /endpoint unavailable \(409\)/);
  assert.equal(validSignatures, 1);
});

test('standalone output strips execution-grant fields even if the server includes them', async () => {
  reset(); includeGrant = true;
  const result = await run('standalone');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(),
    ['ok', 'verified', 'receiptId', 'taskRef', 'intendedActor', 'artifactSha256', 'proofPayloadDigest'].sort());
});

test('runtime helper still rejects an otherwise valid proof without execution grant', async () => {
  reset();
  const result = await run('runtime');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Malformed ownership grant response/);
  assert.equal(validSignatures, 1);
});

test('runtime helper still accepts its complete proof-plus-grant contract', async () => {
  reset(); includeGrant = true;
  const result = await run('runtime');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grant.id, 'fixture-grant');
  assert.equal(validSignatures, 1);
});