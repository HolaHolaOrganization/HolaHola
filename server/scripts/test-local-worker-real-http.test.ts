/**
 * Local Read-only Worker v1 — real-HTTP / exact-envelope proof (proposal c0774a17 rev 12653c72,
 * choices 1A/2A/3B, founder-approved test-code scope).
 *
 * The REAL supervisor (runSupervisor) with its REAL production HTTP ledger port
 * (createHttpLedgerPort) runs against the REAL production Express routes
 * (registerCoordinationRoutes + registerWorkerCharterRoutes with the production founder gate
 * defaultWorkerCharterFounderGate and requireCoordinationAuth), backed by CI's verified
 * job-local PostgreSQL. Only the worker's host and state ports are test doubles (fake
 * harness: no model, no Windows launcher; choice 2A).
 *
 * Isolation (checked BEFORE any database/route import or fixture write):
 *   getVerifiedCiDatabaseUrl() must return CI's job-local URL. Otherwise every proof test is
 *   SKIPPED (never reported as a pass) and no server/database module is imported.
 * Credentials: synthetic, process-local legacy coordination tokens only. Every ambient
 *   COORDINATION_*_TOKEN / *_SECRET is removed for the duration and restored afterwards, so
 *   no real credential can be read or fallen back to. The "david" token is a FIXTURE for the
 *   production founder-or-david gate (choice 3B) — not founder impersonation or live authorization.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const verified = (() => { try { return getVerifiedCiDatabaseUrl(); } catch (e) { return e as Error; } })();
const skip = typeof verified === 'string' ? false : 'requires the verified CI job-local PostgreSQL (getVerifiedCiDatabaseUrl)';

const W = 'luca-claude-code';
const ORIGIN = 'luca-replit';
const TOKENS = {
  'luca-replit': `rh-replit-${randomUUID()}-${randomUUID()}`,
  'luca-claude-code': `rh-claude-code-${randomUUID()}-${randomUUID()}`,
  david: `rh-david-fixture-${randomUUID()}-${randomUUID()}`,
} as const;
const TOKEN_ENV: Record<string, string> = {
  COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'],
  COORDINATION_LUCA_CLAUDE_CODE_TOKEN: TOKENS['luca-claude-code'],
  COORDINATION_DAVID_TOKEN: TOKENS.david,
  COORDINATION_INBOX_TOKEN_SECRET: `rh-inbox-secret-${randomUUID()}`,
};
const COMMIT = 'a'.repeat(40);
const EXE = 'C:\\fake\\claude.exe';
const EXE_SHA = 'e'.repeat(64);
const STAGED_TEXT = 'line one\nline two\n';

// ---------------------------------------------------------------------------
// Lifecycle: isolation first, then (only when verified) imports and the server.
// ---------------------------------------------------------------------------

type Mods = {
  runSupervisor: typeof import('../services/local-worker/supervisor').runSupervisor;
  createHttpLedgerPort: typeof import('../services/local-worker/ports').createHttpLedgerPort;
  validateHarnessOutput: typeof import('../services/local-worker/staging').validateHarnessOutput;
  configDigest: typeof import('../services/local-worker/adapter').configDigest;
  freezeOutboxEntry: typeof import('../services/local-worker/lifecycle').freezeOutboxEntry;
  compareEventToEntry: typeof import('../services/local-worker/lifecycle').compareEventToEntry;
  contracts: typeof import('../../shared/worker-contracts');
};
let mods: Mods;
let server: Server | null = null;
let baseUrl = '';
let closeDb: (() => Promise<void>) | null = null;
const savedEnv = new Map<string, string | undefined>();
const createdThreads: string[] = [];
const createdCharters: string[] = [];

test('isolation gate: only the verified CI job-local database is used (else the suite skips)', () => {
  if (verified instanceof Error) throw verified; // misconfigured CI must fail, not silently skip
  if (skip) return;
  assert.match(new URL(verified as string).hostname, /^(127\.0\.0\.1|localhost|::1)$/);
});

before(async () => {
  if (skip) return;
  // Remove every ambient coordination credential/secret, then set only the synthetic fixtures.
  for (const k of Object.keys(process.env)) {
    if (/^COORDINATION_.*(TOKEN|SECRET)$/.test(k)) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(TOKEN_ENV)) { if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]); process.env[k] = v; }

  const express = (await import('express')).default;
  const { createServer } = await import('node:http');
  const { registerCoordinationRoutes } = await import('../routes/coordination-routes');
  const { registerWorkerCharterRoutes, defaultWorkerCharterFounderGate } = await import('../routes/worker-charter-routes');
  const { requireCoordinationAuth } = await import('../middleware/coordination-auth');
  const db = await import('../db');
  closeDb = db.closeDbConnections;
  mods = {
    runSupervisor: (await import('../services/local-worker/supervisor')).runSupervisor,
    createHttpLedgerPort: (await import('../services/local-worker/ports')).createHttpLedgerPort,
    validateHarnessOutput: (await import('../services/local-worker/staging')).validateHarnessOutput,
    configDigest: (await import('../services/local-worker/adapter')).configDigest,
    freezeOutboxEntry: (await import('../services/local-worker/lifecycle')).freezeOutboxEntry,
    compareEventToEntry: (await import('../services/local-worker/lifecycle')).compareEventToEntry,
    contracts: await import('../../shared/worker-contracts'),
  };
  // Production wiring, as in server/routes.ts (no auth middleware is replaced or weakened).
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerCoordinationRoutes(app);
  registerWorkerCharterRoutes(app, { founderGate: await defaultWorkerCharterFounderGate(), coordinationAuthMiddleware: requireCoordinationAuth });
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`; resolve(); });
  });
});

after(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); }
    if (!skip && (createdThreads.length || createdCharters.length)) {
      const { getSharedDb } = await import('../db');
      const { inArray } = await import('drizzle-orm');
      const { coordinationThreads, workerCharters } = await import('@shared/schema');
      if (createdThreads.length) await getSharedDb().delete(coordinationThreads).where(inArray(coordinationThreads.id, createdThreads));
      if (createdCharters.length) await getSharedDb().delete(workerCharters).where(inArray(workerCharters.id, createdCharters));
    }
  } finally {
    if (closeDb) await closeDb();
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---------------------------------------------------------------------------
// HTTP helpers and fixtures (all through the real routes)
// ---------------------------------------------------------------------------

async function call(method: 'GET' | 'POST', path: string, actor: keyof typeof TOKENS | null, body?: unknown, key?: string) {
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
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

function charterBody(over: Partial<{ maxJobsPerWindow: number }> = {}) {
  const { WORKER_MINIMUM_DENYLIST } = mods.contracts;
  return {
    schema: 'hh.worker.charter.v1', workerActor: W, host: 'ci-real-http', originators: [ORIGIN], kinds: ['doc_inspect'],
    pathAllowlist: ['docs/**'], pathDenylist: [...WORKER_MINIMUM_DENYLIST], authProfiles: ['subscription'], models: ['sonnet'],
    qualifiedHarnesses: [{ adapter: 'claude-cli', executableSha256: EXE_SHA, version: '0.0.0-fixture', configDigest: mods.configDigest('claude-cli', 'subscription'), qualificationRef: 'ci-real-http-fixture' }],
    limits: { maxJobsPerWindow: over.maxJobsPerWindow ?? 5, maxRuntimeSec: 600, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300 },
    window: { notBefore: new Date(Date.now() - 3600_000).toISOString(), notAfter: new Date(Date.now() + 86_400_000).toISOString() },
  };
}

/** Creates and approves a charter through the REAL routes with the david fixture credential. */
async function approvedCharter(over: Partial<{ maxJobsPerWindow: number }> = {}) {
  const id = randomUUID();
  const c = await call('POST', '/api/worker-charters', 'david', { id, body: charterBody(over) });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  createdCharters.push(id);
  const a = await call('POST', `/api/worker-charters/${id}/versions/1/approve`, 'david', {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.approvalState, 'approved');
  return { id, version: 1 };
}

function jobPayload(charterId: string, over: Record<string, unknown> = {}) {
  return {
    schema: 'hh.worker.job.v1', kind: 'doc_inspect', repository: 'davidwmcintosh/HolaHola', commit: COMMIT, paths: ['docs/*.md'],
    question: 'What does the document say?', resultSchemaId: 'answer-with-citations.v1', authProfile: 'subscription', model: 'sonnet',
    limits: { maxRuntimeSec: 600 }, charterId, charterVersion: 1, deadline: new Date(Date.now() + 3600_000).toISOString(), ...over,
  };
}

/** Creates a synthetic worker job through the REAL create route as the originator. */
async function createJob(charterId: string, over: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/coordination/threads', ORIGIN, {
    title: 'LRW real-HTTP proof job', description: 'synthetic CI fixture', intendedRecipient: W, payload: jobPayload(charterId, over),
  }, `rh-create-${randomUUID()}`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.thread.id as string;
  createdThreads.push(id);
  return id;
}

async function events(threadId: string, actor: keyof typeof TOKENS = ORIGIN) {
  const r = await call('GET', `/api/coordination/threads/${encodeURIComponent(threadId)}`, actor);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { thread: r.body.thread as Record<string, any>, events: r.body.events as Record<string, any>[] };
}

// ---------------------------------------------------------------------------
// Worker doubles: fake host (no model, no launcher) and in-memory state
// ---------------------------------------------------------------------------

type LaunchMode = 'ok' | 'hang';
function makeWorker(opts: { instanceId?: string; launch?: LaunchMode; onLaunch?: () => Promise<void> | void } = {}) {
  const clock = { now: Date.now() };
  const launches = { n: 0 };
  const hookRuns: Promise<unknown>[] = [];
  const hookErrors: unknown[] = [];
  let resolveExit: ((v: { code: number | null }) => void) | null = null;
  const timers = new Set<NodeJS.Timeout>();
  const host = {
    now: () => clock.now,
    // Each fake sleep advances fake time by ms after ~25 ms of real time, so real HTTP replies
    // (a few ms) are consumed long before the 30 s unconfirmed-authority bound.
    sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const t = setTimeout(() => { timers.delete(t); if (!signal?.aborted) clock.now += ms; resolve(); }, 25);
      timers.add(t);
      signal?.addEventListener('abort', () => { clearTimeout(t); timers.delete(t); resolve(); }, { once: true });
    }),
    fetchOrigin: async () => true,
    commitExists: (c: string) => c === COMMIT,
    isAncestorOfOriginMain: (c: string) => c === COMMIT,
    lsTree: () => [{ mode: '100644', type: 'blob' as const, size: Buffer.byteLength(STAGED_TEXT), path: 'docs/a.md' }],
    resolveHarness: async () => ({ path: EXE, version: '0.0.0-fixture', sha256: EXE_SHA }),
    stage: () => ({ dir: 'C:\\fake\\staging\\in', baseline: new Map([['docs/a.md', Buffer.from(STAGED_TEXT)]]) as ReadonlyMap<string, Buffer> }),
    removeStaging: () => undefined,
    verifyStaged: () => ({ ok: true as const }),
    validate: (stdout: string, baseline: ReadonlyMap<string, Buffer>) => mods.validateHarnessOutput(stdout, baseline),
    launch: () => {
      launches.n += 1;
      const exited = new Promise<{ code: number | null }>((r) => { resolveExit = r; });
      if ((opts.launch ?? 'ok') === 'ok') resolveExit!({ code: 0 });
      if (opts.onLaunch) hookRuns.push(Promise.resolve().then(opts.onLaunch).catch((e) => { hookErrors.push(e); }));
      return {
        terminate: () => { resolveExit?.({ code: 80 }); return true; },
        killLauncher: () => { resolveExit?.({ code: null }); },
        exited,
        stdout: () => ({ text: JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0,
          structured_output: { summary: 'Fixture answer.', findings: [{ statement: 'Line one exists.' }], citations: [{ path: 'docs/a.md', startLine: 1, endLine: 1 }] } }), overflow: false }),
        listMembers: async () => ({ listOk: true, active: 1, processes: [{ pid: 4242, state: 'member' as const, image: EXE }] }),
      };
    },
    env: () => ({ SystemRoot: 'C:\\Windows' }),
  };
  const outbox = new Map<string, unknown>();
  const launched = new Set<string>();
  const receipts: { threadId: string; kind: string }[] = [];
  const scan = new Map<string, number>();
  let locked = false;
  const instanceId = opts.instanceId ?? randomUUID();
  const state = {
    instanceId: () => instanceId,
    acquireLock: () => (locked ? { ok: false as const, reason: 'held' } : ((locked = true), { ok: true as const })),
    releaseLock: () => { locked = false; return { released: true }; },
    outbox: () => [...outbox.values()].map((e) => JSON.parse(JSON.stringify(e))),
    saveOutbox: (e: { key: string }) => { outbox.set(e.key, e); },
    receipt: (threadId: string, kind: string) => { receipts.push({ threadId, kind }); },
    launched: (k: string) => launched.has(k),
    markLaunched: (k: string) => { launched.add(k); },
    scanAfter: (c: string, v: number) => scan.get(`${c}:${v}`) ?? 0,
    saveScanAfter: (c: string, v: number, a: number) => { scan.set(`${c}:${v}`, a); },
  };
  // Production HTTP ledger port, wrapped only to RECORD raw append results (no behaviour change).
  const port = mods.createHttpLedgerPort(baseUrl, TOKENS[W]);
  const appendLog: { eventType: string; result: Awaited<ReturnType<typeof port.append>> }[] = [];
  const ledger = { ...port, append: async (...a: Parameters<typeof port.append>) => { const r = await port.append(...a); appendLog.push({ eventType: a[1], result: r }); return r; } };
  const cleanup = () => { for (const t of timers) clearTimeout(t); timers.clear(); resolveExit?.({ code: 0 }); };
  return { host, state, ledger, port, appendLog, receipts, launches, outbox, instanceId, cleanup, clock, hookRuns, hookErrors };
}

function opts(charter: { id: string; version: number }, worker: ReturnType<typeof makeWorker>, over: Record<string, unknown> = {}) {
  return { workerActor: W, charterId: charter.id, charterVersion: charter.version, planOnly: false, untilMs: worker.clock.now + 3_600_000, maxJobs: 1, adapter: 'claude-cli' as const, ...over };
}

async function run(charter: { id: string; version: number }, worker: ReturnType<typeof makeWorker>, over: Record<string, unknown> = {}) {
  try {
    const r = await mods.runSupervisor(opts(charter, worker, over), worker.ledger, worker.host as never, worker.state as never);
    await Promise.all(worker.hookRuns);
    assert.deepEqual(worker.hookErrors, [], 'fixture hook failed');
    return r;
  } finally { worker.cleanup(); }
}

const canon = (v: unknown) => mods.contracts.canonicalJson(v);

// ---------------------------------------------------------------------------
// Proofs (real routes, real HTTP port, real database)
// ---------------------------------------------------------------------------

test('charter-gate negatives: neither the originator nor the worker can create, approve or revoke a charter', { skip }, async () => {
  const id = randomUUID();
  for (const actor of [ORIGIN, W] as const) {
    const c = await call('POST', '/api/worker-charters', actor, { id, body: charterBody() });
    assert.ok(c.status === 401 || c.status === 403, `${actor} create must be refused (got ${c.status})`);
  }
  const ch = await approvedCharter(); // fixture via the production gate (david fixture credential)
  for (const actor of [ORIGIN, W] as const) {
    for (const op of ['approve', 'revoke']) {
      const r = await call('POST', `/api/worker-charters/${ch.id}/versions/1/${op}`, actor, {});
      assert.ok(r.status === 401 || r.status === 403, `${actor} ${op} must be refused (got ${r.status})`);
    }
  }
  // No no-token case here: without x-coordination-token the production gate falls through to the
  // founder web-session chain (Passport/session from setupAuth), which this test app deliberately
  // does not install — CI run 38006302656 showed that case only exercises missing session wiring.
  const still = await call('GET', `/api/worker-charters/${ch.id}/versions/1`, W);
  assert.equal(still.body.approvalState, 'approved', 'refused calls changed nothing');
});

test('happy path + exact envelope: discovery, claim, fake run, completed with evidence; stored bytes equal the frozen operation', { skip }, async (t) => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const w = makeWorker();
  const r = await run(ch, w);
  assert.equal(r.halted, null, JSON.stringify(r));
  assert.deepEqual(r.outcomes, [{ threadId: job, outcome: 'completed' }]);
  assert.equal(w.launches.n, 1);

  // Observed append-response shape (reported, never assumed).
  const shapes = w.appendLog.filter((a) => a.result.ok).map((a) => {
    const ev = (a.result as { event: Record<string, unknown> }).event;
    return { eventType: a.eventType, content: 'content' in ev, evidence: 'evidence' in ev, recipientActor: 'recipientActor' in ev };
  });
  t.diagnostic(`observed append response fields: ${JSON.stringify(shapes)}`);
  const complete = shapes.every((s) => s.content && s.evidence && s.recipientActor);
  const incompleteDecision = r.decisions.some((d) => d.decision === 'claim:response_incomplete');
  assert.equal(incompleteDecision, !complete, 'supervisor took the match path iff the real response was complete');

  // Stored events vs frozen outbox entries: payload, evidence, content and recipient, byte-for-byte (canonical JSON).
  const { thread, events: evs } = await events(job);
  assert.equal(thread.state, 'completed');
  const entries = w.state.outbox() as { key: string; op: string; eventType: string; payload: unknown; evidence: unknown[]; content: string; recipientActor: string | null; state: string }[];
  for (const op of ['accept', 'completed']) {
    const e = entries.find((x) => x.op === op)!;
    assert.equal(e.state, 'sent');
    const ev = evs.find((x) => x.idempotencyKey === e.key)!;
    assert.ok(ev, `${op} event stored under its frozen key`);
    assert.equal(ev.eventType, e.eventType);
    assert.equal(canon(ev.payload), canon(e.payload));
    assert.equal(canon(ev.evidence ?? []), canon(e.evidence));
    assert.equal(ev.content, e.content);
    assert.equal(ev.recipientActor ?? null, e.recipientActor);
    assert.equal(mods.compareEventToEntry(e as never, ev as never), 'match');
  }
  const done = evs.find((x) => x.eventType === 'completed')!;
  assert.equal((done.payload as { schema: string }).schema, 'hh.worker.result.v1');
  assert.equal((done.evidence as { type: string }[])[0].type, 'commit');
});

test('same-key replay over HTTP is deduplicated with identical content; no second event', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const w = makeWorker();
  await run(ch, w);
  const before = (await events(job)).events.length;
  const completed = (w.state.outbox() as { op: string; key: string; eventType: 'completed'; payload: Record<string, unknown>; evidence: unknown[]; content: string }[]).find((e) => e.op === 'completed')!;
  const replay = await w.port.append(job, 'completed', { expectedSequence: 1, idempotencyKey: completed.key, content: completed.content, payload: completed.payload, evidence: completed.evidence });
  assert.equal(replay.ok, true);
  assert.equal(replay.ok && replay.deduplicated, true);
  assert.equal(replay.ok && canon(replay.event.payload), canon(completed.payload));
  assert.equal((await events(job)).events.length, before);
});

test('claim race: two supervisor instances on one job produce exactly one acceptance and one launch', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const a = makeWorker(); const b = makeWorker();
  const [ra, rb] = await Promise.all([run(ch, a), run(ch, b)]);
  const evs = (await events(job)).events;
  assert.equal(evs.filter((e) => e.eventType === 'accepted').length, 1);
  assert.equal(evs.filter((e) => e.eventType === 'completed').length, 1);
  assert.equal(a.launches.n + b.launches.n, 1);
  assert.equal([...ra.outcomes, ...rb.outcomes].filter((o) => o.outcome === 'completed').length, 1);
});

test('reassignment mid-run: real 403 not_participant -> authority_lost, no write, new owner state untouched', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const w = makeWorker({
    launch: 'hang',
    onLaunch: async () => {
      const cur = await events(job);
      const r = await call('POST', `/api/coordination/threads/${job}/reassign`, ORIGIN, { expectedSequence: cur.thread.latestSequence, recipientActor: 'alden' }, `rh-reassign-${randomUUID()}`);
      assert.equal(r.status, 201, JSON.stringify(r.body));
    },
  });
  const r = await run(ch, w);
  assert.deepEqual(r.outcomes, [{ threadId: job, outcome: 'authority_lost' }]);
  const { thread, events: evs } = await events(job);
  assert.equal(thread.intendedRecipient, 'alden');
  assert.equal(thread.currentOwner ?? null, null);
  assert.equal(evs.filter((e) => e.actor === W && ['blocked', 'completed'].includes(e.eventType)).length, 0);
  assert.ok(w.receipts.some((x) => x.kind === 'authority_lost'));
});

test('charter revoked mid-run through the real gate: charter_revoked, then a fenced blocked write accepted by the server', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const w = makeWorker({
    launch: 'hang',
    onLaunch: async () => {
      const r = await call('POST', `/api/worker-charters/${ch.id}/versions/1/revoke`, 'david', {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
    },
  });
  const r = await run(ch, w);
  assert.deepEqual(r.outcomes, [{ threadId: job, outcome: 'charter_revoked' }]);
  const blocked = (await events(job)).events.filter((e) => e.eventType === 'blocked');
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0].payload as { failureClass: string }).failureClass, 'charter_revoked');
});

test('window limit from the real server count: maxJobsPerWindow=1 with two jobs -> exactly one acceptance', { skip }, async () => {
  const ch = await approvedCharter({ maxJobsPerWindow: 1 });
  const j1 = await createJob(ch.id); const j2 = await createJob(ch.id);
  const w = makeWorker();
  const r = await run(ch, w, { maxJobs: 2, untilMs: w.clock.now + 1000 });
  const accepted = [...(await events(j1)).events, ...(await events(j2)).events].filter((e) => e.eventType === 'accepted');
  assert.equal(accepted.length, 1);
  assert.ok(r.decisions.some((d) => d.decision === 'ineligible:limit_reached'), JSON.stringify(r.decisions));
});

test('error mapping through the real routes and the production port', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const w = makeWorker();
  const seq0 = (await events(job, W)).thread.latestSequence as number;
  const key = `lrw.${w.instanceId}.${job}.accept.${randomUUID()}.${seq0}`;
  const acc = await w.port.append(job, 'accepted', { expectedSequence: seq0, idempotencyKey: key, content: 'Local Read-only Worker claim', payload: { instanceId: w.instanceId, runNonce: randomUUID(), claimKey: key, charterId: ch.id, charterVersion: 1 } });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  // A second acceptance on an owned thread.
  const seq1 = (await events(job, W)).thread.latestSequence as number;
  const again = await w.port.append(job, 'accepted', { expectedSequence: seq1, idempotencyKey: `rh-again-${randomUUID()}`, content: 'c', payload: {} });
  assert.deepEqual(again.ok ? 'ok' : again.errorCode, 'invalid_transition');
  // Stale expectedSequence.
  const stale = await w.port.append(job, 'blocked', { expectedSequence: seq0, idempotencyKey: `rh-stale-${randomUUID()}`, content: 'c', payload: {} });
  assert.deepEqual(stale.ok ? 'ok' : [stale.errorCode, stale.httpStatus], ['sequence_conflict', 409]);
  // Completion without evidence.
  const bare = await w.port.append(job, 'completed', { expectedSequence: seq1, idempotencyKey: `rh-bare-${randomUUID()}`, content: 'c', payload: {} });
  assert.deepEqual(bare.ok ? 'ok' : bare.errorCode, 'completion_evidence_required');
  // Not a participant after reassignment away.
  const cur = await events(job);
  const ra = await call('POST', `/api/coordination/threads/${job}/reassign`, ORIGIN, { expectedSequence: cur.thread.latestSequence, recipientActor: 'alden' }, `rh-reassign-${randomUUID()}`);
  assert.equal(ra.status, 201, JSON.stringify(ra.body));
  assert.deepEqual(await w.port.showThread(job), { ok: false, error: 'not_participant' });
  w.cleanup();
});

test('job-intrinsic rejection: one comment to the originator with the recipient bound, idempotent across runs', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id, { model: 'opus' }); // valid job envelope, model outside the charter
  const w = makeWorker();
  await run(ch, w, { untilMs: w.clock.now + 1000 });
  const w2 = makeWorker({ instanceId: w.instanceId });
  await run(ch, w2, { untilMs: w2.clock.now + 1000 });
  const comments = (await events(job)).events.filter((e) => e.eventType === 'comment' && e.actor === W);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].recipientActor, ORIGIN);
  assert.equal((comments[0].payload as { reasonCode: string }).reasonCode, 'model_not_allowed');
  assert.equal((await events(job)).events.some((e) => e.eventType === 'accepted'), false);
});

test('restart replay: a pending frozen completed write is delivered by the next run with exactly its original bytes', { skip }, async () => {
  const ch = await approvedCharter();
  const job = await createJob(ch.id);
  const instanceId = randomUUID();
  const w = makeWorker({ instanceId });
  const seq = (await events(job, W)).thread.latestSequence as number;
  const claimKey = mods.contracts.claimKeyFor(instanceId, job, randomUUID(), seq);
  const acc = await w.port.append(job, 'accepted', { expectedSequence: seq, idempotencyKey: claimKey, content: 'Local Read-only Worker claim', payload: { instanceId, runNonce: randomUUID(), claimKey, charterId: ch.id, charterVersion: 1 } });
  assert.equal(acc.ok, true);
  const evidence = mods.contracts.buildCompletionEvidence(COMMIT, [{ path: 'docs/a.md', startLine: 1, endLine: 1, excerpt: 'line one', excerptSha256: mods.contracts.sha256Hex(Buffer.from('line one', 'utf8')) }]);
  const pending = mods.freezeOutboxEntry({
    key: mods.contracts.writeKeyFor(instanceId, job, 'completed', claimKey), threadId: job, op: 'completed', eventType: 'completed',
    content: 'Local Read-only Worker result — original bytes ✓', recipientActor: null, claimKey, payload: { replay: true, n: 1 }, evidence,
  });
  w.state.saveOutbox(pending);
  const r = await run(ch, w, { untilMs: w.clock.now + 1000 });
  assert.equal(r.halted, null, JSON.stringify(r));
  const done = (await events(job)).events.filter((e) => e.eventType === 'completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].content, pending.content);
  assert.equal(canon(done[0].payload), canon(pending.payload));
  assert.equal(canon(done[0].evidence), canon(evidence));
  assert.equal(w.launches.n, 0, 'replay never re-executes');
});
