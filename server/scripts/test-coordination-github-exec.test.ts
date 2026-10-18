/**
 * Proof for the github-exec bridge (shared-spec 13d480b7, approved revision
 * 045b595f, section B). The real coordination CLI runs against a local stand-in
 * for the broker using synthetic tokens only. These tests cover wrapper-owned
 * behavior only: they do not claim anything about what an arbitrary child does
 * with its own environment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCoordinationActorClient } from '../services/coordination-actor-client';
import { githubExecChildEnvironment, parseGithubExecArgs } from './coordination-cli';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'server', 'scripts', 'coordination-cli.ts');
const BOOTSTRAP = `cb_${'B'.repeat(43)}`;
const ACCESS = `cat_synthetic_access_${'a'.repeat(32)}`;
const GITHUB = `ghs_synthetic_github_${'g'.repeat(32)}`;
const LEGACY = `legacy_synthetic_${'l'.repeat(40)}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const future = () => new Date(Date.now() + 30 * 60_000).toISOString();

type MintReply = { status: number; body: unknown };

/** Stand-in broker: exchange returns ACCESS; github-token returns `mint` and records hits. */
async function standInBroker(mint: MintReply) {
  const hits: Array<{ path: string; token: string | undefined }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    const token = request.headers['x-coordination-token'];
    hits.push({ path, token: typeof token === 'string' ? token : undefined });
    request.resume();
    request.on('end', () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (path === '/api/coordination/credentials/exchange') {
        send(200, { actor: 'luca-replit', accessToken: ACCESS, expiresAt: future() });
      } else if (path === '/api/coordination/github-token') {
        if (token !== ACCESS) send(403, { error: { code: 'broker_credential_required' } });
        else send(mint.status, mint.body);
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** Runs the real CLI (`github-exec`) and captures everything the wrapper and child print. */
function runCli(url: string, childArgv: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    COORDINATION_ACTOR: 'luca-replit',
    COORDINATION_API_URL: url,
    COORDINATION_RUNTIME_ID: 'luca-replit-primary',
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: BOOTSTRAP,
    COORDINATION_CLI_CREDENTIAL_CACHE_DIR: mkdtempSync(join(tmpdir(), 'gh-exec-cache-')),
    EXPECT_SHA: sha(GITHUB),
    ...extraEnv,
  };
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'github-exec', '--', ...childArgv], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => done({ code, out }));
  });
}

const markerPath = () => join(mkdtempSync(join(tmpdir(), 'gh-exec-marker-')), 'spawned');
const childReporting = (marker: string, exitCode: number) => [
  process.execPath, '-e',
  [
    "const { createHash } = require('node:crypto');",
    "const fs = require('node:fs');",
    'fs.writeFileSync(process.argv[1], "x");',
    'const h = (v) => v ? createHash("sha256").update(v).digest("hex") : null;',
    'console.log("CHILD " + JSON.stringify({',
    '  gh: h(process.env.GH_TOKEN) === process.env.EXPECT_SHA,',
    '  github: h(process.env.GITHUB_TOKEN) === process.env.EXPECT_SHA,',
    '  bootstrapPresent: process.env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN !== undefined,',
    '  argv: process.argv.slice(1),',
    '}));',
    `process.exit(${exitCode});`,
  ].join('\n'),
  marker, 'literal; not-a-shell $HOME',
];

test('parser accepts the exact approved E.6 invocation and rejects malformed ones', () => {
  assert.deepEqual(
    parseGithubExecArgs(['--', 'gh', 'api', '/repos/davidwmcintosh/HolaHola', '--jq', '.full_name']),
    { childArgv: ['gh', 'api', '/repos/davidwmcintosh/HolaHola', '--jq', '.full_name'] },
  );
  assert.deepEqual(
    parseGithubExecArgs(['--url', 'https://getholahola.com', '--', 'gh', 'pr', 'view', '42']),
    { url: 'https://getholahola.com', childArgv: ['gh', 'pr', 'view', '42'] },
  );
  assert.throws(() => parseGithubExecArgs(['gh', 'api']), /requires --/);
  assert.throws(() => parseGithubExecArgs(['--']), /command after --/);
  assert.throws(() => parseGithubExecArgs(['--token', 'x', '--', 'gh']), /Unsupported github-exec argument/);
  assert.throws(() => parseGithubExecArgs(['--url', '--', 'gh']), /Unsupported github-exec argument/);
});

test('the child environment gets the GitHub token and no coordination credentials', () => {
  const env = githubExecChildEnvironment({
    PATH: '/bin',
    COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: BOOTSTRAP,
    COORDINATION_LUCA_REPLIT_TOKEN: LEGACY,
    COORDINATION_RUNTIME_ID: 'luca-replit-primary',
  }, GITHUB);
  assert.equal(env.GH_TOKEN, GITHUB);
  assert.equal(env.GITHUB_TOKEN, GITHUB);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.COORDINATION_RUNTIME_ID, 'luca-replit-primary');
  assert.equal(env.COORDINATION_RUNTIME_BOOTSTRAP_TOKEN, undefined);
  assert.equal(env.COORDINATION_LUCA_REPLIT_TOKEN, undefined);
});

test('mintGithubToken refuses a legacy credential locally, without contacting the mint', async () => {
  const calls: string[] = [];
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'http://127.0.0.1:9',
    environment: { COORDINATION_LUCA_REPLIT_TOKEN: LEGACY },
    fetchImpl: (async (url: URL | string) => { calls.push(String(url)); throw new Error('must not be called'); }) as typeof fetch,
  });
  await assert.rejects(client.mintGithubToken(), /requires a broker credential.*COORDINATION_LUCA_REPLIT_TOKEN/);
  assert.deepEqual(calls, []);
});

test('end to end: one mint, token only in the child env, exact argv, child exit code propagated', async () => {
  const broker = await standInBroker({ status: 200, body: { token: GITHUB, expiresAt: future(), appId: 1, repositoryId: 1170208766, permissions: {} } });
  try {
    const marker = markerPath();
    const result = await runCli(broker.url, childReporting(marker, 7));
    assert.equal(result.code, 7, result.out);
    const report = JSON.parse(result.out.match(/CHILD (.*)/)![1]);
    assert.deepEqual(report, { gh: true, github: true, bootstrapPresent: false, argv: [marker, 'literal; not-a-shell $HOME'] });
    for (const secret of [GITHUB, ACCESS, BOOTSTRAP]) assert.ok(!result.out.includes(secret), 'no credential in output');
    const mints = broker.hits.filter((hit) => hit.path === '/api/coordination/github-token');
    assert.equal(mints.length, 1, 'exactly one mint');
    assert.equal(mints[0].token, ACCESS, 'the mint is authenticated with the broker access token');
  } finally {
    await broker.close();
  }
});

for (const [label, reply, expected] of [
  ['a broker denial', { status: 403, body: { error: { code: 'no_active_grant' } } }, /denied \(403\): no_active_grant/],
  ['a malformed mint response', { status: 200, body: { token: '', expiresAt: future() } }, /malformed response/],
  ['an already-expired token', { status: 200, body: { token: GITHUB, expiresAt: new Date(Date.now() - 1000).toISOString() } }, /malformed response/],
] as const) {
  test(`${label} spawns nothing and exits non-zero`, async () => {
    const broker = await standInBroker(reply);
    try {
      const marker = markerPath();
      const result = await runCli(broker.url, childReporting(marker, 0));
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, expected);
      assert.equal(existsSync(marker), false, 'the child must not be spawned');
      assert.ok(!result.out.includes(GITHUB) && !result.out.includes(ACCESS), 'no credential in output');
    } finally {
      await broker.close();
    }
  });
}

test('a configured legacy token is refused before any mint, and nothing is spawned', async () => {
  const broker = await standInBroker({ status: 200, body: { token: GITHUB, expiresAt: future() } });
  try {
    const marker = markerPath();
    const result = await runCli(broker.url, childReporting(marker, 0), { COORDINATION_LUCA_REPLIT_TOKEN: LEGACY });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /requires a broker credential/);
    assert.equal(broker.hits.filter((hit) => hit.path === '/api/coordination/github-token').length, 0);
    assert.equal(existsSync(marker), false);
    assert.ok(!result.out.includes(LEGACY));
  } finally {
    await broker.close();
  }
});

test('a child that cannot be started exits non-zero without printing the token', async () => {
  const broker = await standInBroker({ status: 200, body: { token: GITHUB, expiresAt: future() } });
  try {
    const result = await runCli(broker.url, ['holahola-definitely-not-a-command']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /could not start holahola-definitely-not-a-command/);
    assert.ok(!result.out.includes(GITHUB));
  } finally {
    await broker.close();
  }
});

test('a child killed by a signal is reported as 128 + signal', { skip: process.platform === 'win32' }, async () => {
  const broker = await standInBroker({ status: 200, body: { token: GITHUB, expiresAt: future() } });
  try {
    const result = await runCli(broker.url, [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")']);
    assert.equal(result.code, 143, result.out);
  } finally {
    await broker.close();
  }
});
