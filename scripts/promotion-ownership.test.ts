import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { canonicalJson } from '../server/services/task-ownership-service';
import { saveOwnershipChallengeHandle } from '../server/services/task-ownership-discovery';
import { ownershipProofPayload } from '../server/services/task-ownership-proof-payload';
import {
  promotionContextDigest, PROMOTION_REPOSITORY, promotionGit, verifyPromotionHead,
  type PromotionCandidate,
} from '../server/services/promotion-candidate';

const root = mkdtempSync(join(tmpdir(), 'promotion-proof-'));
const workspace = join(root, 'checkout');
const custody = join(root, 'tmp');
const repo = resolve(import.meta.dirname, '..');
const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href;
const promoteModule = pathToFileURL(join(repo, 'scripts/cross-tool-promote.ts')).href;
const probeModule = pathToFileURL(join(repo, 'server/services/promotion-ownership-probe.ts')).href;
const ownershipModule = pathToFileURL(join(repo, 'server/scripts/task-ownership-cli.ts')).href;
const ref = '900002';
const actor = 'luca-claude-code';
const token = 'synthetic-own-actor-credential-for-private-fixture';
const challengeId = '00000000-0000-4000-8000-000000000001';
const secondChallengeId = '00000000-0000-4000-8000-000000000003';
const receiptId = '00000000-0000-4000-8000-000000000002';
const artifact = 'Synthetic promotion fixture, never a live task artifact.';
const digest = createHash('sha256').update(artifact).digest('hex');
const keys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const publicKey = keys.publicKey.toString('base64url');
const fingerprint = createHash('sha256').update(keys.publicKey).digest('hex');
const artifactPath = join(workspace, '.local', 'tasks', `task-${ref}.md`);
const keyPath = join(custody, 'task-agent-ownership', `task-${ref}`, 'private-key.pem');
let endpoint = '';
let mode = '';
let approved = true;
let nonces = new Map<string, any>();
let statusCalls = 0;
let nonceCalls = 0;
let proofCalls = 0;
let signatures = 0;
let dispatches = 0;
let challengePosts = 0;
let redirectedCalls = 0;
let jobId = '';
let candidate: PromotionCandidate;
let contextDigest = '';
let dispatchedSha = '';

const server = createServer(async (req, res) => {
  try {
    res.setHeader('content-type', 'application/json');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url?.startsWith('/__workflow_api/')) {
      assert.equal(req.headers.authorization, 'Bearer synthetic-workflow-token');
      const sha = promotionGit(workspace, ['ls-remote', '--heads', 'origin', 'refs/heads/fixture']).split(/\s+/)[0];
      res.end(JSON.stringify({ ref: 'refs/heads/fixture', object: { type: 'commit', sha } }));
      return;
    }
    if (req.url?.startsWith('/__github/')) {
      if (req.method === 'POST') {
        dispatches++;
        jobId = body.inputs.jobId;
        dispatchedSha = body.inputs.expectedSha;
        assert.match(dispatchedSha, /^[0-9a-f]{40}$/);
        res.writeHead(204).end();
      } else res.end(JSON.stringify({ workflow_runs: [{
        id: 1, display_title: `fixture ${jobId}`, status: 'completed',
        conclusion: 'success', html_url: 'https://example.invalid/synthetic-run',
      }] }));
      return;
    }
    if (req.headers['x-coordination-token'] !== token) {
      res.writeHead(401).end(JSON.stringify({ error: 'synthetic credential refused' }));
      return;
    }
    if (req.url === '/redirect-target') {
      redirectedCalls++;
      res.end('{}');
      return;
    }
    if (req.url === '/api/task-ownership/challenges' && req.method === 'POST') {
      challengePosts++;
      assert.equal(body.taskRef, ref);
      assert.equal(body.intendedActor, actor);
      assert.equal(body.artifactSha256, digest);
      assert.equal(body.keyFingerprint, fingerprint);
      assert.equal(body.contextDigest, contextDigest);
      res.end(JSON.stringify({ challengeId, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      return;
    }
    if (req.url === `/api/task-ownership/challenges/${challengeId}` ||
        req.url === `/api/task-ownership/challenges/${secondChallengeId}`) {
      statusCalls++;
      if (mode === 'redirect') {
        res.writeHead(302, { location: `${endpoint}/redirect-target` }).end();
        return;
      }
      // Deliberately exercise the older status contract. Only fresh proof can authorize.
      res.end(JSON.stringify({
        id: req.url.endsWith(secondChallengeId) ? secondChallengeId : challengeId,
        status: mode === 'malformed-status' ? 'invented' : approved ? 'approved' : 'pending',
        receipt: approved ? {
          id: req.url.endsWith(secondChallengeId) ? '00000000-0000-4000-8000-000000000004' : receiptId,
          status: mode === 'revoked-status' ? 'revoked' : 'active',
        } : null,
      }));
      return;
    }
    if (req.url === `/api/task-ownership/receipts/${receiptId}/proof-nonce`) {
      nonceCalls++;
      if (mode === 'revoked' || (mode === 'revoked-after-proof' && proofCalls > 0)) {
        res.writeHead(403).end(JSON.stringify({ error: 'synthetic revoked receipt' }));
        return;
      }
      const nonceId = `synthetic-${nonceCalls}`;
      const expiry = new Date(Date.now() + (mode === 'expired-receipt' ? -60_000
        : mode === 'expires-during-proof' ? 1_000 : 60_000)).toISOString();
      const payload = {
        nonceId, nonce: `one-time-${nonceCalls}`, receiptId, taskRef: ref,
        intendedActor: mode === 'wrong-actor' ? 'luca-replit' : actor,
        artifactSha256: mode === 'wrong-artifact' ? 'f'.repeat(64) : digest,
        publicKey, keyFingerprint: mode === 'wrong-key' ? 'e'.repeat(64) : fingerprint,
        expiresAt: expiry,
        ...(mode === 'task-only' ? {} : {
          contextDigest: mode === 'wrong-context' ? 'e'.repeat(64) : mode === 'wrong-purpose'
            ? createHash('sha256').update('synthetic-antigravity-bundle').digest('hex')
            : mode === 'wrong-branch-context' ? promotionContextDigest({ ...candidate, branch: 'other-branch' })
            : mode === 'wrong-repository-context'
              ? createHash('sha256').update(canonicalJson({ ...candidate, repository: 'github:other/repository' })).digest('hex')
              : contextDigest,
        }),
      };
      nonces.set(nonceId, payload);
      res.end(JSON.stringify({
        nonceId, signedPayload: payload,
        expiresAt: new Date(Date.now() + (mode === 'expired-nonce' ? -60_000 : 60_000)).toISOString(),
      }));
      return;
    }
    if (req.url === '/api/task-ownership/proof') {
      proofCalls++;
      const payload = nonces.get(body.nonceId);
      assert.ok(payload, 'proof nonce exists and is unused');
      const bytes = Buffer.from(canonicalJson(payload));
      assert.ok(verify(null, bytes, createPublicKey({
        key: keys.publicKey, type: 'spki', format: 'der',
      }), Buffer.from(body.signature, 'base64url')), 'real Ed25519 signature verifies');
      nonces.delete(body.nonceId);
      signatures++;
      assert.equal(body.standalone, true);
      if (mode === 'expires-during-proof') await new Promise(done => setTimeout(done, 1_100));
      if (mode === 'changed-artifact') writeFileSync(artifactPath, `${artifact} changed during proof`);
      res.end(JSON.stringify({
        ok: true, verified: true, receiptId, taskRef: ref, intendedActor: actor, artifactSha256: digest,
        proofPayloadDigest: mode === 'wrong-result' ? 'a'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
        ...(mode === 'missing-result-context' ? {} : { contextDigest: mode === 'wrong-result-context' ? 'd'.repeat(64) : contextDigest }),
        ...(mode === 'unexpected-grant' ? { grant: { id: 'synthetic-unwanted-grant' } } : {}),
      }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture path' }));
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ error: 'private fixture assertion failed' }));
  }
});

before(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(custody, { recursive: true, force: true });
  mkdirSync(join(workspace, '.local', 'tasks'), { recursive: true });
  mkdirSync(join(custody, 'task-agent-ownership', `task-${ref}`), { recursive: true });
  writeFileSync(artifactPath, artifact);
  writeFileSync(keyPath, keys.privateKey, { mode: 0o600 });
  writeFileSync(join(workspace, '.git'), 'gitdir: synthetic-linked-worktree\n');
  nonces = new Map();
  statusCalls = nonceCalls = proofCalls = signatures = dispatches = challengePosts = redirectedCalls = 0;
  mode = '';
  contextDigest = '';
  dispatchedSha = '';
  approved = true;
});

async function seedHandle() {
  await saveOwnershipChallengeHandle(workspace, {
    version: 1, endpoint, actor, taskRef: ref, artifactSha256: digest,
    keyFingerprint: fingerprint, challengeId,
  });
}

/** Real Git, but all repositories, remotes, configuration and hooks are private. */
function preparePrivateGit(environment: NodeJS.ProcessEnv) {
  if (lstatSync(join(workspace, '.git')).isDirectory()) return;
  rmSync(join(workspace, '.git'), { force: true });
  const remote = join(root, 'private-origin.git');
  rmSync(remote, { recursive: true, force: true });
  const hooks = join(workspace, 'empty-hooks');
  mkdirSync(hooks, { recursive: true });
  const git = (args: string[], cwd = workspace) =>
    execFileSync('git', args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', remote]);
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Synthetic Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', hooks]);
  writeFileSync(join(workspace, '.gitignore'), '.local/\nempty-hooks/\nsynthetic-git.log\n');
  writeFileSync(join(workspace, 'fixture.txt'), 'Synthetic repository only.\n');
  git(['add', '.gitignore', 'fixture.txt']);
  git(['commit', '-m', 'Private fixture baseline']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', 'origin', 'main']);
  git(['checkout', '-b', 'fixture']);
  git(['push', 'origin', 'fixture']);
  const canonicalOrigin = 'https://github.com/davidwmcintosh/HolaHola.git';
  git(['config', `url.${remote}.insteadOf`, canonicalOrigin]);
  git(['config', 'remote.origin.url', canonicalOrigin]);
  candidate = {
    purpose: 'cross-tool-promote', repository: PROMOTION_REPOSITORY, branch: 'fixture',
    candidateCommit: git(['rev-parse', 'HEAD']).toString().trim(),
  };
  contextDigest = promotionContextDigest(candidate);
  if (environment.SYNTHETIC_MERGE_NEEDED === '1') {
    git(['checkout', 'main']);
    writeFileSync(join(workspace, 'main-addition.txt'), 'Synthetic main advancement.\n');
    git(['add', 'main-addition.txt']);
    git(['commit', '-m', 'Private main advancement']);
    git(['push', 'origin', 'main']);
    git(['checkout', 'fixture']);
  }
}

async function child(kind: 'dispatch' | 'push' | 'begin', extra: string[] = [], envPatch: NodeJS.ProcessEnv = {}) {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('COORDINATION_') || name.startsWith('GIT_') ||
        /DATABASE|PGHOST|PGPASSWORD|PGUSER|OPENAI|ANTHROPIC|GEMINI/.test(name)) delete environment[name];
  }
  Object.assign(environment, {
    TMPDIR: custody, TEMP: custody, TMP: custody, COORDINATION_ACTOR: actor,
    COORDINATION_API_URL: endpoint, COORDINATION_LUCA_CLAUDE_CODE_TOKEN: token,
    GITHUB_ACTIONS_DISPATCH_TOKEN: 'synthetic-dispatch-only',
  }, envPatch);
  const config = join(root, 'empty-git-config');
  writeFileSync(config, '');
  environment.GIT_CONFIG_GLOBAL = config;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  preparePrivateGit(environment);
  const gitLog = join(workspace, 'synthetic-git.log');
  environment.GIT_TRACE = gitLog;
  const module = kind === 'begin' ? ownershipModule : promoteModule;
  const args = kind === 'begin'
    ? ['begin', '--task-ref', ref, '--actor', actor, '--app-url', endpoint,
      '--promote-branch', 'fixture', '--promote-commit', candidate.candidateCommit, ...extra]
    : ['push', 'fixture', '--task-ref', ref, ...extra];
  const code = `
    const realFetch=globalThis.fetch;
    globalThis.fetch=(url,init)=>String(url).startsWith('https://api.github.com/')
      ? realFetch(${JSON.stringify(endpoint)}+'/__github/'+String(url).slice('https://api.github.com/'.length),init)
      : realFetch(url,init);
    const realTimeout=globalThis.setTimeout;
    globalThis.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===10000?1:ms,...args);
    process.chdir(${JSON.stringify(workspace)});
    ${kind !== 'dispatch' ? `process.argv=[process.execPath,${JSON.stringify(fileURLToPath(module))},...${JSON.stringify(args)}];` : ''}
    const mod=await import(${JSON.stringify(module)});
    ${kind === 'dispatch' ? `try{await mod.dispatchCrossToolPromote(${JSON.stringify(extra[0] ?? 'fixture')},${JSON.stringify(ref)},'fixture-job'${extra[0] ? `,{probeOwnership:(await import(${JSON.stringify(probeModule)})).createPromotionOwnershipProbe({branch:'fixture'})}` : ''});console.log(JSON.stringify({ok:true}));}
      catch(error){console.log(JSON.stringify({ok:false,error:error.message}));}` : ''}
  `;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
      cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    process.stdout.on('data', chunk => { stdout += chunk; });
    process.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { process.kill(); reject(new Error('Private subprocess timed out.')); }, 20_000);
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('close', exit => { clearTimeout(timer); done({ code: exit, stdout, stderr }); });
  });
}

test('begin persists a handle; a separate real push CLI automatically proves twice, without manual prove', async () => {
  approved = false;
  const begin = await child('begin');
  assert.equal(begin.code, 0, begin.stderr);
  assert.equal(challengePosts, 1);
  approved = true; // Synthetic founder decision, outside the promotion process.
  const push = await child('push');
  assert.equal(push.code, 0, push.stderr);
  assert.match(push.stdout, /SYNCED/);
  assert.equal(dispatches, 1);
  assert.equal(proofCalls, 2);
  assert.equal(signatures, 2);
  assert.equal(challengePosts, 1, 'promotion never opens or replays a challenge');
});

test('older host approval works with explicit receipt ID and no saved challenge handle', async () => {
  const result = await child('push', ['--actor', actor, '--app-url', endpoint, '--receipt-id', receiptId]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statusCalls, 0);
  assert.equal(signatures, 2);
  assert.equal(dispatches, 1);
  assert.equal(challengePosts, 0);
});

test('the real default dispatch path succeeds in independent processes and never reuses a proof', async () => {
  await seedHandle();
  for (let i = 0; i < 2; i++) {
    const result = await child('dispatch');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
  }
  assert.equal(signatures, 2);
  assert.equal(nonceCalls, 2);
  assert.equal(dispatches, 2);
  assert.equal(challengePosts, 0);
});

test('immutable challenge handles refuse conflicting bytes and malformed state cannot authorize', async () => {
  await seedHandle();
  await assert.rejects(() => saveOwnershipChallengeHandle(workspace, {
    version: 1, endpoint, actor, taskRef: ref, artifactSha256: 'b'.repeat(64),
    keyFingerprint: fingerprint, challengeId,
  }), /conflicts/);
  const scope = createHash('sha256').update(JSON.stringify([endpoint, actor, ref])).digest('hex');
  const handlePath = join(workspace, '.local', 'task-ownership-discovery', scope, `${challengeId}.json`);
  assert.equal(JSON.parse(readFileSync(handlePath, 'utf8')).artifactSha256, digest);
  writeFileSync(handlePath, 'not JSON');
  const result = await child('dispatch');
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stdout, /unreadable/);
  assert.equal(statusCalls, 0);
  assert.equal(dispatches, 0);
});

test('multiple distinct active receipts fail closed before requesting a proof', async () => {
  await seedHandle();
  await saveOwnershipChallengeHandle(workspace, {
    version: 1, endpoint, actor, taskRef: ref, artifactSha256: digest,
    keyFingerprint: fingerprint, challengeId: secondChallengeId,
  });
  const result = await child('dispatch');
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stdout, /Multiple ownership receipts/);
  assert.equal(nonceCalls, 0);
  assert.equal(dispatches, 0);
});

test('actual push CLI refuses before any Git command without an approved receipt', async () => {
  await seedHandle();
  approved = false;
  const result = await child('push');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No approved ownership receipt/);
  assert.equal(existsSync(join(workspace, 'synthetic-git.log')), false);
  assert.equal(dispatches, 0);
  assert.equal(challengePosts, 0);
});

test('second real CLI gate reproves and blocks dispatch after receipt revocation', async () => {
  await seedHandle();
  mode = 'revoked-after-proof';
  const result = await child('push');
  assert.equal(result.code, 1);
  assert.equal(signatures, 1);
  assert.equal(nonceCalls, 2);
  assert.equal(dispatches, 0);
  assert.doesNotMatch(readFileSync(join(workspace, 'synthetic-git.log'), 'utf8'), /push /);
});

test('fresh proof also gates the merged-branch upload before dispatch', async () => {
  await seedHandle();
  const result = await child('push', [], { SYNTHETIC_MERGE_NEEDED: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(signatures, 3, 'freshen, merge upload and dispatch each reprove');
  assert.equal(dispatches, 1);
  assert.match(readFileSync(join(workspace, 'synthetic-git.log'), 'utf8'), /push origin [0-9a-f]{40}:refs\/heads\/fixture/);
  assert.notEqual(dispatchedSha, candidate.candidateCommit, 'workflow pins the exact derived merge');
  assert.equal(promotionGit(workspace, ['rev-list', '--parents', '-n', '1', dispatchedSha]).split(' ').length, 3);
});

test('revocation during freshening prevents uploading the merge itself', async () => {
  await seedHandle();
  mode = 'revoked-after-proof';
  const result = await child('push', [], { SYNTHETIC_MERGE_NEEDED: '1' });
  assert.equal(result.code, 1);
  assert.equal(signatures, 1);
  assert.equal(nonceCalls, 2);
  assert.equal(dispatches, 0);
  const commands = readFileSync(join(workspace, 'synthetic-git.log'), 'utf8');
  assert.match(commands, /merge --no-ff --no-edit/);
  assert.doesNotMatch(commands, /push origin/);
});

for (const failure of ['wrong-actor', 'wrong-artifact', 'wrong-key', 'expired-receipt', 'expired-nonce', 'wrong-result', 'changed-artifact', 'revoked', 'revoked-status', 'malformed-status', 'redirect', 'expires-during-proof', 'task-only', 'wrong-context', 'wrong-purpose', 'wrong-branch-context', 'wrong-repository-context', 'wrong-result-context', 'missing-result-context', 'unexpected-grant']) {
  test(`real default dispatch probe denies ${failure} with zero GitHub calls`, async () => {
    await seedHandle();
    mode = failure;
    const result = await child('dispatch');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, false, result.stdout);
    assert.equal(dispatches, 0);
    assert.equal(challengePosts, 0);
    assert.equal(redirectedCalls, 0, 'credentials never follow a redirect');
  });
}

test('missing custody is refused, never regenerated', async () => {
  await seedHandle();
  rmSync(keyPath);
  const result = await child('dispatch');
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(existsSync(keyPath), false);
  assert.equal(nonceCalls, 0);
  assert.equal(dispatches, 0);
});

test('no previous proof process or local handle grants authority; missing actor is refused', async () => {
  await seedHandle();
  const result = await child('dispatch', [], { COORDINATION_ACTOR: '' });
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stdout, /COORDINATION_ACTOR/);
  assert.equal(nonceCalls, 0);
  assert.equal(dispatches, 0);
});

test('an explicit actor conflicting with configured identity fails before mutation', async () => {
  const result = await child('push', ['--actor', 'luca-replit', '--receipt-id', receiptId]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /conflicts with the configured actor/);
  assert.equal(dispatches, 0);
  assert.equal(nonceCalls, 0);
  assert.equal(existsSync(join(workspace, 'synthetic-git.log')), false);
});

test('invalid explicit receipt and valueless ownership flags fail closed', async () => {
  for (const extra of [['--receipt-id', 'not-a-receipt'], ['--receipt-id'], ['--actor'], ['--app-url']]) {
    const result = await child('push', extra);
    assert.equal(result.code, 1);
    assert.equal(dispatches, 0);
    assert.equal(nonceCalls, 0);
    assert.equal(existsSync(join(workspace, 'synthetic-git.log')), false);
  }
});

for (const moved of ['local', 'remote', 'both'] as const) {
  test(`candidate ${moved} head moving after approval prevents freshening and dispatch`, async () => {
    await seedHandle();
    assert.equal(JSON.parse((await child('dispatch')).stdout).ok, true);
    writeFileSync(join(workspace, 'unapproved.txt'), 'Unapproved synthetic commit.\n');
    promotionGit(workspace, ['add', 'unapproved.txt']);
    promotionGit(workspace, ['commit', '-m', 'Unapproved synthetic candidate']);
    if (moved !== 'local') promotionGit(workspace, ['push', 'origin', 'fixture']);
    if (moved === 'remote') promotionGit(workspace, ['reset', '--hard', candidate.candidateCommit]);
    dispatches = 0;
    rmSync(join(workspace, 'synthetic-git.log'), { force: true });
    const result = await child('push');
    assert.equal(result.code, 1, result.stdout);
    assert.equal(dispatches, 0);
    assert.doesNotMatch(readFileSync(join(workspace, 'synthetic-git.log'), 'utf8'), /built-in: git (merge|push) /);
  });
}

test('a two-parent merge with the wrong main parent is rejected', async () => {
  await seedHandle();
  const result = await child('push', [], { SYNTHETIC_MERGE_NEEDED: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.throws(() => verifyPromotionHead(workspace, candidate, {
    candidateCommit: candidate.candidateCommit, mainCommit: candidate.candidateCommit,
    commitSha: dispatchedSha,
  }), /exact in-process two-parent merge/);
});

test('an earlier-process merge cannot reuse the candidate-only approval', async () => {
  await seedHandle();
  assert.equal((await child('push', [], { SYNTHETIC_MERGE_NEEDED: '1' })).code, 0);
  dispatches = 0;
  const result = await child('dispatch');
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(dispatches, 0, 'the in-memory merge lease is never restored from local history');
});

test('dispatcher refuses a different branch even when its supplied probe proves the approved candidate', async () => {
  await seedHandle();
  const result = await child('dispatch', ['other-branch']);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stdout, /Dispatch branch differs/);
  assert.equal(signatures, 1, 'the supplied real probe proves only its own branch');
  assert.equal(dispatches, 0);
});

test('the server nonce builder binds context while preserving null-context legacy bytes', () => {
  const receipt = {
    id: receiptId, challengeId, taskRef: ref, artifactSha256: digest, intendedActor: actor,
    publicKey, keyFingerprint: fingerprint, payloadDigest: 'b'.repeat(64),
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  };
  const nonce = { id: 'synthetic-nonce', nonce: 'synthetic-random' };
  const legacy = ownershipProofPayload(receipt, nonce);
  assert.deepEqual(ownershipProofPayload({ ...receipt, contextDigest: null }, nonce), legacy);
  assert.equal(Object.hasOwn(legacy, 'contextDigest'), false);
  assert.deepEqual(ownershipProofPayload({ ...receipt, contextDigest: 'c'.repeat(64) }, nonce), {
    ...legacy, contextDigest: 'c'.repeat(64),
  });
});

for (const moved of [false, true]) {
  test(`actual workflow guard ${moved ? 'refuses a moved branch' : 'accepts the pinned checkout'}`, async () => {
    await seedHandle();
    assert.equal((await child('push')).code, 0);
    const workflow = readFileSync(join(repo, '.github', 'workflows', 'cross-tool-promote.yml'), 'utf8');
    assert.match(workflow, /^\s+ref: \$\{\{ inputs.expectedSha \}\}$/m, 'checkout never follows the branch');
    const match = workflow.split('- name: Refuse a moved promotion branch')[1]
      .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
    assert.ok(match, 'test executes the actual inline workflow guard');
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'), GIT_CONFIG_NOSYSTEM: '1',
      EXPECTED_SHA: candidate.candidateCommit, PROMOTION_BRANCH: 'fixture',
    };
    if (moved) {
      writeFileSync(join(workspace, 'after-dispatch.txt'), 'Synthetic branch movement.\n');
      promotionGit(workspace, ['add', 'after-dispatch.txt']);
      promotionGit(workspace, ['commit', '-m', 'Moved after dispatch']);
      promotionGit(workspace, ['push', 'origin', 'fixture']);
      promotionGit(workspace, ['reset', '--hard', candidate.candidateCommit]);
    }
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', match[1]], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (moved) assert.throws(run, /Command failed/);
    else assert.doesNotThrow(run);
  });
}

for (const moved of [false, true]) {
  test(`actual pre-checkout workflow guard ${moved ? 'refuses moved refs' : 'accepts the exact approved ref'}`, async () => {
    await seedHandle();
    assert.equal((await child('push')).code, 0);
    const workflow = readFileSync(join(repo, '.github', 'workflows', 'cross-tool-promote.yml'), 'utf8');
    assert.ok(workflow.indexOf('name: Verify promotion branch before checkout') < workflow.indexOf('uses: actions/checkout'));
    const match = workflow.split('- name: Verify promotion branch before checkout')[1]
      .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
    assert.ok(match);
    if (moved) {
      writeFileSync(join(workspace, 'pre-checkout.txt'), 'Moved before checkout.\n');
      promotionGit(workspace, ['add', 'pre-checkout.txt']);
      promotionGit(workspace, ['commit', '-m', 'Moved before checkout']);
      promotionGit(workspace, ['push', 'origin', 'fixture']);
    }
    const run = spawn(process.execPath, ['--input-type=module', '-e', match[1]], {
      cwd: workspace, env: {
        ...process.env, PROMOTION_BRANCH: 'fixture', EXPECTED_SHA: candidate.candidateCommit,
        PROMOTION_TOKEN: 'synthetic-workflow-token', GITHUB_API_URL: `${endpoint}/__workflow_api`,
        GITHUB_REPOSITORY: 'davidwmcintosh/HolaHola',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    run.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>((done, reject) => {
      run.on('error', reject); run.on('close', done);
    });
    assert.equal(code, moved ? 1 : 0, stderr);
    if (moved) assert.match(stderr, /Promotion branch moved before checkout/);
  });
}
