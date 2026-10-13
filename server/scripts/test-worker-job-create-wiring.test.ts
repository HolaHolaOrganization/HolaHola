/**
 * D1 wiring proof for structured create payloads (Local Read-only Worker v1).
 *
 * - Route: the real registerCoordinationRoutes + real coordination auth (legacy
 *   test tokens). Refusals are proven without any database: they must happen
 *   before the ledger service is reached. Acceptance paths (payload-free create,
 *   valid worker job, no execution authority granted) need the isolated CI
 *   database and are SKIPPED elsewhere, never reported as passes.
 * - Client: CoordinationActorClient.create forwards exactly the payload given.
 * - CLI: `coordination-cli create --data` validates locally, refuses before any
 *   request, and sends the payload only when given.
 * No shared or production database is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import express from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { inArray } from 'drizzle-orm';
import { coordinationThreads } from '@shared/schema';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { CoordinationActorClient } from '../services/coordination-actor-client';

const hasIsolatedCiDatabase = Boolean(getVerifiedCiDatabaseUrl());
// server/db.ts refuses to load without a URL. Outside the isolated CI database,
// point it at an unreachable loopback placeholder so the refusal tests can load
// the real route module; any accidental database access fails to connect.
if (!hasIsolatedCiDatabase) process.env.NEON_SHARED_DATABASE_URL = 'postgresql://lrw-wiring-test:unused@127.0.0.1:9/unreachable';
const { closeDbConnections, getSharedDb } = await import('../db');
const { registerCoordinationRoutes } = await import('../routes/coordination-routes');

const TOKENS = {
  'luca-replit': 'wiring-replit-token-'.repeat(3),
  'luca-claude-code': 'wiring-claude-code-token-'.repeat(3),
} as const;
const TOKEN_ENVIRONMENT: Record<string, string> = {
  COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'],
  COORDINATION_LUCA_CLAUDE_CODE_TOKEN: TOKENS['luca-claude-code'],
  COORDINATION_INBOX_TOKEN_SECRET: 'wiring-inbox-signing-secret-'.repeat(2),
};
const prefix = `worker-create-wiring-${Date.now()}`;
const databaseTest = hasIsolatedCiDatabase ? test : test.skip;

function workerJob(over: Record<string, unknown> = {}) {
  return {
    schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola', commit: 'a'.repeat(40),
    paths: ['docs/*.md'], question: 'What does this document say?', resultSchemaId: 'answer-with-citations.v1',
    authProfile: 'subscription', model: 'sonnet', limits: { maxRuntimeSec: 600 },
    charterId: '11111111-2222-4333-8444-555555555555', charterVersion: 1,
    deadline: new Date(Date.now() + 3600_000).toISOString(), ...over,
  };
}

const app = express();
app.use(express.json());
registerCoordinationRoutes(app);
let server: Server;
let baseUrl = '';
const previousEnvironment = new Map<string, string | undefined>();
const createdThreads: string[] = [];

before(async () => {
  for (const [name, value] of Object.entries(TOKEN_ENVIRONMENT)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (hasIsolatedCiDatabase && createdThreads.length) {
    await getSharedDb().delete(coordinationThreads).where(inArray(coordinationThreads.id, createdThreads));
  }
  await closeDbConnections();
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function call(method: 'GET' | 'POST', path: string, actor: keyof typeof TOKENS | null, key?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(actor ? { 'x-coordination-token': TOKENS[actor] } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const createBody = (payload?: unknown) => ({
  title: `Worker create wiring ${prefix}`, description: 'D1 wiring test thread.', intendedRecipient: 'luca-claude-code',
  ...(payload !== undefined ? { payload } : {}),
});

// --- route: refusals (no database reached) -----------------------------------------

test('route: unauthenticated create carrying a valid worker job is refused by auth', async () => {
  const r = await call('POST', '/api/coordination/threads', null, `${prefix}-unauth`, createBody(workerJob()));
  assert.equal(r.status, 401);
});

test('route: malformed, unknown-schema, reserved-kind and non-object payloads are refused with invalid_payload before the ledger', async () => {
  const cases: [string, unknown][] = [
    ['malformed worker job (bad commit)', workerJob({ commit: 'nothex' })],
    ['worker job with an unknown field', { ...workerJob(), extra: true }],
    ['worker job with a past deadline', workerJob({ deadline: new Date(Date.now() - 60_000).toISOString() })],
    ['unknown schema', { schema: 'hh.something.else.v1' }],
    ['reserved observation kind', { kind: 'observation_source' }],
    ['reserved linked-outcome shape', { linkedOutcome: { noteId: 'x' } }],
    ['array', [workerJob()]],
    ['string', 'hh.worker.job.v1'],
    ['null', null],
  ];
  for (const [name, payload] of cases) {
    const r = await call('POST', '/api/coordination/threads', 'luca-replit', `${prefix}-bad-${name}`, createBody(payload));
    assert.equal(r.status, 400, name);
    assert.equal(r.body.code, 'invalid_payload', name);
  }
});

// --- route: acceptance (isolated CI database only) ----------------------------------

databaseTest('route: an ordinary payload-free create still works and stores an empty created payload', async () => {
  const r = await call('POST', '/api/coordination/threads', 'luca-replit', `${prefix}-plain`, createBody());
  assert.equal(r.status, 201);
  const id = r.body.thread.id as string;
  createdThreads.push(id);
  const shown = await call('GET', `/api/coordination/threads/${encodeURIComponent(id)}`, 'luca-replit');
  const created = (shown.body.events as Record<string, any>[]).find((e) => e.eventType === 'created')!;
  assert.deepEqual(created.payload, {});
});

databaseTest('route: a valid worker job is stored exactly on the created event and grants no execution authority', async () => {
  const job = workerJob();
  const r = await call('POST', '/api/coordination/threads', 'luca-replit', `${prefix}-job`, createBody(job));
  assert.equal(r.status, 201);
  assert.equal(r.body.accepted, false);
  const id = r.body.thread.id as string;
  createdThreads.push(id);
  const shown = await call('GET', `/api/coordination/threads/${encodeURIComponent(id)}`, 'luca-replit');
  const t = shown.body.thread as Record<string, any>;
  assert.equal(t.currentOwner ?? null, null, 'creation never assigns an owner');
  assert.notEqual(t.state, 'accepted');
  const created = (shown.body.events as Record<string, any>[]).find((e) => e.eventType === 'created')!;
  assert.deepEqual(created.payload, job);
  // The creator cannot claim the job it created; only the intended recipient may accept.
  const creatorAccept = await call('POST', `/api/coordination/threads/${encodeURIComponent(id)}/accept`, 'luca-replit', `${prefix}-creator-accept`, { expectedSequence: t.latestSequence });
  assert.ok(creatorAccept.status >= 400, `creator accept must be refused (got ${creatorAccept.status})`);
  const after = await call('GET', `/api/coordination/threads/${encodeURIComponent(id)}`, 'luca-replit');
  assert.equal((after.body.thread as Record<string, any>).currentOwner ?? null, null);
});

// --- client ---------------------------------------------------------------------

test('client: create forwards the payload exactly when given and omits it otherwise', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ thread: { id: 't' }, deduplicated: false }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new CoordinationActorClient('luca-replit', { apiUrl: 'http://127.0.0.1:9', environment: { COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'] }, fetchImpl });
  const job = workerJob();
  await client.create({ title: 't', description: 'd', intendedRecipient: 'luca-claude-code', payload: job, idempotencyKey: `${prefix}-c1` });
  await client.create({ title: 't', description: 'd', intendedRecipient: 'luca-claude-code', idempotencyKey: `${prefix}-c2` });
  assert.deepEqual(bodies[0].payload, job);
  assert.equal('payload' in bodies[1], false);
});

// --- CLI ----------------------------------------------------------------------------

async function stub() {
  const seen: Record<string, any>[] = [];
  const s = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ achievedState: 'stored', accepted: false, deduplicated: false, thread: { id: 'stub-thread' }, event: { id: 'e' } }));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => s.close(() => r())) };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/scripts/coordination-cli.ts', ...args], {
      env: {
        SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '', LOCALAPPDATA: process.env.LOCALAPPDATA ?? '', APPDATA: process.env.APPDATA ?? '',
        COORDINATION_ACTOR: 'luca-replit', COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'],
      },
      windowsHide: true,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: create --data with a valid job sends it; without --data no payload is sent; an invalid --data is refused before any request', async () => {
  const api = await stub();
  try {
    const base = ['create', '--url', api.url, '--title', 't', '--description', 'd', '--recipient', 'luca-claude-code'];
    const job = workerJob();
    const ok = await runCli([...base, '--idempotency-key', `${prefix}-cli-1`, '--data', JSON.stringify(job)]);
    assert.equal(ok.code, 0, ok.stderr);
    const plain = await runCli([...base, '--idempotency-key', `${prefix}-cli-2`]);
    assert.equal(plain.code, 0, plain.stderr);
    const posts = api.seen.filter((r) => r.method === 'POST' && r.url === '/api/coordination/threads');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].body.payload, job);
    assert.equal('payload' in posts[1].body, false);

    const before = api.seen.length;
    for (const bad of [JSON.stringify(workerJob({ commit: 'nothex' })), JSON.stringify({ kind: 'observation_source' }), JSON.stringify([1])]) {
      const r = await runCli([...base, '--idempotency-key', `${prefix}-cli-bad`, '--data', bad]);
      assert.equal(r.code, 64, r.stderr);
      assert.match(r.stderr, /--data rejected|must be/);
    }
    assert.equal(api.seen.length, before, 'refused --data never reaches the server');
  } finally { await api.close(); }
});
