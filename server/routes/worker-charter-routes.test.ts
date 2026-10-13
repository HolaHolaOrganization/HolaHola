import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express, { type RequestHandler } from 'express';
import { WORKER_MINIMUM_DENYLIST, type WorkerCharterBody } from '../../shared/worker-contracts';
import type { CharterRecordView, CharterState, WorkerCharterRepository, WorkerJobView } from '../services/worker-charter-service';
import { registerWorkerCharterRoutes } from './worker-charter-routes';

const ID = '11111111-2222-4333-8444-555555555555';
const body = (over: Partial<WorkerCharterBody> = {}): WorkerCharterBody => ({
  schema: 'hh.worker.charter.v1', workerActor: 'luca-claude-code', host: 'LITTLENEMO', originators: ['luca-replit'],
  kinds: ['doc_inspect'], pathAllowlist: ['docs/**'], pathDenylist: [...WORKER_MINIMUM_DENYLIST], authProfiles: ['subscription'],
  models: ['sonnet'], qualifiedHarnesses: [],
  limits: { maxJobsPerWindow: 3, maxRuntimeSec: 600, maxApiBudgetUsdPerJob: 1, pollIntervalSec: 300 },
  window: { notBefore: '2026-10-08T00:00:00.000Z', notAfter: '2026-10-09T00:00:00.000Z' }, ...over,
});

class MemoryRepo implements WorkerCharterRepository {
  rows: CharterRecordView[] = [];
  jobs: WorkerJobView[] = [];
  accepted: { actor: string; charterId: string; charterVersion: number; at: string }[] = [];
  present = true;
  failing = false;
  async tableExists() { if (this.failing) throw new Error('db down'); return this.present; }
  async maxVersion(id: string) { const v = this.rows.filter((r) => r.id === id).map((r) => r.version); return v.length ? Math.max(...v) : null; }
  async insert(v: Omit<CharterRecordView, 'createdAt'>) { const r = { ...v, createdAt: new Date().toISOString() }; this.rows.push(r); return r; }
  async get(id: string, version: number) { return this.rows.find((r) => r.id === id && r.version === version) ?? null; }
  async transition(id: string, version: number, from: CharterState, to: CharterState, actor: string, at: Date) {
    const r = this.rows.find((x) => x.id === id && x.version === version && x.approvalState === from);
    if (!r) return null;
    r.approvalState = to;
    if (to === 'approved') { r.approvedBy = actor; r.approvedAt = at.toISOString(); } else { r.revokedBy = actor; r.revokedAt = at.toISOString(); }
    return { ...r };
  }
  async listJobs(q: { workerActor: string; afterGlobalSequence: number; approvedAt: string; limit: number }) {
    return this.jobs.filter((j) => j.creationRecipient === q.workerActor && j.createdGlobalSequence > q.afterGlobalSequence
      && Date.parse(j.createdAt) > Date.parse(q.approvedAt)).sort((a, b) => a.createdGlobalSequence - b.createdGlobalSequence).slice(0, q.limit);
  }
  async countAccepted(q: { workerActor: string; charterId: string; charterVersion: number; notBefore: string; notAfter: string }) {
    return this.accepted.filter((a) => a.actor === q.workerActor && a.charterId === q.charterId && a.charterVersion === q.charterVersion
      && a.at >= q.notBefore && a.at < q.notAfter).length;
  }
}

async function server(repo: MemoryRepo) {
  const app = express();
  app.use(express.json());
  const founderGate: RequestHandler = (req, res, next) => {
    const f = req.get('x-test-founder');
    if (f) { (req as unknown as { authenticatedUser: { id: string } }).authenticatedUser = { id: f }; return next(); }
    if (req.get('x-test-coordination-actor') === 'david') { (req as unknown as { coordinationActor: string }).coordinationActor = 'david'; return next(); }
    res.status(401).json({ error: { code: 'FOUNDER_REQUIRED' } });
  };
  const coordinationAuthMiddleware: RequestHandler = (req, res, next) => {
    const a = req.get('x-test-coordination-actor');
    if (!a) { res.status(401).json({ error: { code: 'COORDINATION_AUTH_REQUIRED' } }); return; }
    (req as unknown as { coordinationActor: string }).coordinationActor = a;
    next();
  };
  registerWorkerCharterRoutes(app, { founderGate, coordinationAuthMiddleware, repository: repo });
  const s = http.createServer(app);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, json?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: r.status, body: await r.json() as Record<string, any> };
  };
  return { call, close: () => new Promise<void>((r) => s.close(() => r())) };
}
const F = { 'x-test-founder': 'founder-id' };
const W = { 'x-test-coordination-actor': 'luca-claude-code' };

test('founder creates immutable versions; invalid bodies are rejected; non-founders cannot create', async () => {
  const repo = new MemoryRepo(); const s = await server(repo);
  try {
    const a = await s.call('POST', '/api/worker-charters', F, { id: ID, body: body() });
    assert.equal(a.status, 201); assert.equal(a.body.version, 1); assert.equal(a.body.approvalState, 'draft');
    const b = await s.call('POST', '/api/worker-charters', F, { id: ID, body: body({ models: ['haiku'] }) });
    assert.equal(b.body.version, 2); assert.notEqual(b.body.bodyDigest, a.body.bodyDigest);
    assert.equal(repo.rows[0].models === undefined && repo.rows[0].body.models[0], 'sonnet', 'version 1 body unchanged');
    const bad = await s.call('POST', '/api/worker-charters', F, { id: ID, body: body({ pathDenylist: [] }) });
    assert.equal(bad.status, 422); assert.equal(bad.body.error.details.reason, 'charter_minimum_denylist_missing');
    const nf = await s.call('POST', '/api/worker-charters', W, { id: ID, body: body() });
    assert.equal(nf.status, 401);
    const viaDavidToken = await s.call('POST', '/api/worker-charters', { 'x-test-coordination-actor': 'david' }, { id: ID, body: body() });
    assert.equal(viaDavidToken.status, 201);
  } finally { await s.close(); }
});

test('transitions are compare-and-set: draft->approved->revoked only', async () => {
  const repo = new MemoryRepo(); const s = await server(repo);
  try {
    await s.call('POST', '/api/worker-charters', F, { id: ID, body: body() });
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/1/revoke`, F)).status, 409, 'cannot revoke a draft');
    const ap = await s.call('POST', `/api/worker-charters/${ID}/versions/1/approve`, F);
    assert.equal(ap.status, 200); assert.equal(ap.body.approvedBy, 'founder-id');
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/1/approve`, F)).status, 409, 'cannot approve twice');
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/1/revoke`, F)).status, 200);
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/1/approve`, F)).status, 409, 'revoked never returns to approved');
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/9/approve`, F)).status, 404);
    assert.equal((await s.call('POST', `/api/worker-charters/${ID}/versions/1/approve`, W)).status, 401, 'worker cannot approve');
  } finally { await s.close(); }
});

test('missing table and database failure are distinct 503 codes', async () => {
  const repo = new MemoryRepo(); const s = await server(repo);
  try {
    repo.present = false;
    const a = await s.call('GET', `/api/worker-charters/${ID}/versions/1`, W);
    assert.deepEqual([a.status, a.body.error.code], [503, 'WORKER_CHARTER_SCHEMA_UNAVAILABLE']);
    repo.present = true; repo.failing = true;
    const b = await s.call('GET', `/api/worker-charters/${ID}/versions/1`, W);
    assert.deepEqual([b.status, b.body.error.code], [503, 'DATABASE_UNAVAILABLE']);
  } finally { await s.close(); }
});

test('jobs endpoint: worker actor only, explicit cursor, paging and server-side window count (R3)', async () => {
  const repo = new MemoryRepo(); const s = await server(repo);
  try {
    await s.call('POST', '/api/worker-charters', F, { id: ID, body: body() });
    await s.call('POST', `/api/worker-charters/${ID}/versions/1/approve`, F);
    const approvedAt = repo.rows[0].approvedAt!;
    const later = new Date(Date.parse(approvedAt) + 1000).toISOString();
    for (let i = 1; i <= 3; i += 1) {
      repo.jobs.push({ threadId: `t${i}`, createdGlobalSequence: 100 + i, createdAt: later, originActor: 'luca-replit', creationRecipient: 'luca-claude-code',
        state: 'delivered', currentOwner: null, intendedRecipient: i === 2 ? 'alden' : 'luca-claude-code', latestSequence: 2, sourceReferenceType: null, payload: {} });
    }
    repo.accepted.push({ actor: 'luca-claude-code', charterId: ID, charterVersion: 1, at: '2026-10-08T05:00:00.000Z' });
    const p1 = await s.call('GET', `/api/worker/jobs?charterId=${ID}&charterVersion=1&after=0&limit=2`, W);
    assert.equal(p1.status, 200);
    assert.deepEqual(p1.body.jobs.map((j: WorkerJobView) => j.threadId), ['t1', 't2'], 'creation-time recipient, even if reassigned since');
    assert.equal(p1.body.complete, false); assert.equal(p1.body.nextAfter, 102); assert.equal(p1.body.acceptedInWindow, 1);
    const p2 = await s.call('GET', `/api/worker/jobs?charterId=${ID}&charterVersion=1&after=102&limit=2`, W);
    assert.deepEqual(p2.body.jobs.map((j: WorkerJobView) => j.threadId), ['t3']); assert.equal(p2.body.complete, true);
    assert.equal((await s.call('GET', `/api/worker/jobs?charterId=${ID}&charterVersion=1&after=0`, { 'x-test-coordination-actor': 'alden' })).status, 403);
    assert.equal((await s.call('GET', `/api/worker/jobs?charterId=${ID}&charterVersion=1`, W)).status, 400, 'after is required');
    assert.equal((await s.call('GET', `/api/worker/jobs?charterId=${ID}&charterVersion=1&after=-1`, W)).status, 400);
  } finally { await s.close(); }
});
