import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { registerLucaObserverRoute } from '../routes/luca-observer-route';
import { requireFounderOrCoordinationCapability } from '../middleware/coordination-auth';
import {
  observeSessionEnd,
  observeSessionStart,
} from '../services/session-observation-store';

const disposable = Boolean(getVerifiedCiDatabaseUrl());
const databaseTest = disposable ? test : test.skip;
const prefix = `luca-observer-route-${Date.now()}`;
const lucaToken = 'integration-luca-token-'.repeat(3);
const aldenToken = 'integration-alden-token-'.repeat(3);
let server: Server;
let baseUrl = '';
let userId = '';
let conversationId = '';
let sessionA = '';
let sessionB = '';
let founderFallbackCalls = 0;

const query = (statement: ReturnType<typeof sql>) => getSharedDb().execute(statement);
const loadUser = () => (_req: any, _res: any, next: any) => next();
const founderFallback = (_req: any, _res: any, next: any) => {
  founderFallbackCalls += 1;
  next();
};

async function get(path: string, token?: string) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== undefined) headers['x-coordination-token'] = token;
  const response = await fetch(baseUrl + path, { headers });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Express returns its default HTML body for an unregistered adjacent route.
  }
  return { status: response.status, body };
}

before(async () => {
  if (!disposable) return;
  process.env.COORDINATION_LUCA_HOLAHOLA_TOKEN = lucaToken;
  process.env.COORDINATION_ALDEN_TOKEN = aldenToken;
  userId = ((await query(sql`SELECT id FROM users LIMIT 1`)) as any).rows[0].id;
  conversationId = `${prefix}-conversation`;
  sessionA = `${prefix}-session-a`;
  sessionB = `${prefix}-session-b`;
  await query(sql`INSERT INTO conversations (id, user_id, language, native_language, difficulty)
    VALUES (${conversationId}, ${userId}, 'Spanish', 'English', 'beginner')`);
  await query(sql`INSERT INTO voice_sessions
    (id, user_id, conversation_id, language, status, started_at,
     guardian_fires, guardian_hard_walls, guardian_heard, guardian_missed, guardian_carry_forward)
    VALUES (${sessionA}, ${userId}, ${conversationId}, 'Spanish', 'active', NOW() - interval '2 minutes', 1, 0, 1, 0, 0),
           (${sessionB}, ${userId}, ${conversationId}, 'Spanish', 'active', NOW() - interval '1 minute', 1, 0, 1, 0, 0)`);
  await query(sql`INSERT INTO voice_pipeline_events
    (id, session_id, user_id, event_type, event_data, created_at)
    VALUES
    (${prefix + '-event-a'}, ${sessionA}, ${userId}, 'gl_guardian_fire',
      jsonb_build_object('conversationId', ${conversationId}::text, 'path', 'pre-turn', 'phrase', 'A', 'outcome', 'heard'), NOW() - interval '110 seconds'),
    (${prefix + '-event-b'}, ${sessionB}, ${userId}, 'gl_guardian_fire',
      jsonb_build_object('conversationId', ${conversationId}::text, 'path', 'hard-wall', 'phrase', 'B'), NOW() - interval '50 seconds'),
    (${prefix + '-event-legacy'}, ${prefix + '-unknown-session'}, ${userId}, 'gl_guardian_fire',
      jsonb_build_object('conversationId', ${conversationId}::text, 'path', 'pre-turn', 'phrase', 'legacy'), NOW() - interval '40 seconds')`);
  const app = express();
  registerLucaObserverRoute({
    app, storage: {}, getSharedDb, loadAuthenticatedUser: loadUser,
    requireFounderOrCoordinationCapability, requireFounder: founderFallback,
  });
  await new Promise<void>(resolve => {
    server = createServer(app).listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  if (!disposable) return;
  observeSessionEnd(conversationId);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await query(sql`DELETE FROM voice_pipeline_events WHERE id LIKE ${prefix + '%'}`);
  await query(sql`DELETE FROM voice_sessions WHERE id IN (${sessionA}, ${sessionB})`);
  await query(sql`DELETE FROM conversations WHERE id = ${conversationId}`);
  await closeDbConnections();
});

databaseTest('real Luca observer route enforces auth and isolates DB evidence', async () => {
  assert.equal((await get('/api/admin/luca/observe', lucaToken)).status, 200);
  assert.equal((await get('/api/admin/luca/observe', aldenToken)).status, 403);
  assert.equal(founderFallbackCalls, 0);
  assert.equal((await get('/api/admin/luca/observe', 'invalid-presented-token-'.repeat(3))).status, 401);
  assert.equal(founderFallbackCalls, 0, 'invalid presented credentials must not reach founder fallback');
  assert.equal((await get('/api/admin/luca/observe')).status, 200);
  assert.equal(founderFallbackCalls, 1);
  assert.equal((await get('/api/admin/luca/observe-adjacent', lucaToken)).status, 404);

  const response = await get(`/api/admin/luca/observe?conversationId=${conversationId}`, lucaToken);
  assert.equal(response.body.status, 'db_only');
  assert.equal(response.body.session.conversationId, conversationId);
  const evidence = response.body.guardianEvidence;
  assert.deepEqual(Object.keys(evidence).sort(), ['authoritative', 'discrepancy', 'recentEvents', 'source', 'summary', 'summaryState'].sort());
  assert.deepEqual(
    evidence.recentEvents.map((event: any) => event.sessionId),
    [sessionB, prefix + '-unknown-session'],
  );
  assert.equal(evidence.recentEvents.some((event: any) => event.sessionId === sessionA), false);
  assert.equal(evidence.recentEvents.filter((event: any) => event.phrase === 'legacy').length, 1);

  observeSessionStart({
    conversationId,
    dbSessionId: sessionB,
    transientSessionId: `${prefix}-transient-b`,
    userId,
    language: 'Spanish',
    actflLevel: 'novice-low',
  });
  await query(sql`
    INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
    SELECT ${prefix + '-snapshot-'} || n::text, ${sessionB}, ${userId},
           'gl_session_heartbeat', '{}'::jsonb, NOW()
    FROM generate_series(1, 41) AS series(n)
  `);
  const activeResponse = await get(
    `/api/admin/luca/observe?conversationId=${conversationId}`,
    lucaToken,
  );
  assert.equal(activeResponse.body.status, 'active');
  assert.equal(activeResponse.body.recentPipelineEvents.length, 40);
  assert.deepEqual(activeResponse.body.observationCoverage.pipelineEvents, {
    returned: 40,
    sessionTotal: 42,
  });
  assert.deepEqual(
    activeResponse.body.guardianEvidence.recentEvents.map((event: any) => event.sessionId),
    [sessionB],
  );
  assert.equal(
    activeResponse.body.guardianEvidence.recentEvents.some(
      (event: any) => event.sessionId === sessionA || event.phrase === 'legacy',
    ),
    false,
  );
});
