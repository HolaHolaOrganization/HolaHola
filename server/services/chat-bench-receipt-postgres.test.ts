/**
 * Chat-bench receipt acceptance fixtures (luca-replit, coordination thread
 * dd40f2cf sequence 524), against real PostgreSQL in an owned throwaway
 * schema of the verified disposable CI database. Never the shared database.
 *
 * Covers: concurrent first-turn creation (one row), concurrent appends (no
 * lost frames), restart (a fresh pool reloads identity and frames from the
 * database), exact retry, conflicting retry, owner mismatch, and a receipt
 * whose episode projection failed and is repaired by retry, plus a
 * partial-event episode conflict and finalization without a second row.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import {
  benchEvent, findBenchTurn, finalizeBenchSession, IN_PROGRESS_TAG, projectBenchTurn, recordBenchTurn,
  sessionTag, staleBenchSessions, type BenchTurn,
} from './chat-bench-receipt';
import { applyProjectionAppend } from './projection-append-store';
import { turnAttributionOf, verifyTurnAttribution } from './turn-attribution';

test('chat-bench receipts on real PostgreSQL', async context => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for chat-bench receipt coverage');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const schema = `bench_fixture_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const pools: Pool[] = [];
  const open = () => {
    const pool = new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}` });
    pools.push(pool);
    return { pool, db: drizzle(pool) as any };
  };
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await admin.query(`CREATE TABLE "${schema}".conversation_memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, summary text, content text NOT NULL,
      participants text[], tags text[], importance integer, created_at timestamptz NOT NULL DEFAULT now(),
      entry_type text, arc_name text, attribution jsonb)`);
    const { pool, db } = open();
    const meta = { userId: 'dev-test-agent', topicHint: 'fixture topic', dateStr: 'October 20, 2026' };
    const turn = (sessionId: string, n: number, daniela = `respuesta ${n} — ñ 🙂`): BenchTurn =>
      ({ sessionId, turnId: `turn-000${n}`, lucaText: `  hola ${n}\n`, danielaText: daniela, participant: 'daniela' });
    const rowsFor = async (sessionId: string) =>
      (await pool.query('SELECT id, content, attribution, tags FROM conversation_memories WHERE $1 = ANY(tags)', [sessionTag(sessionId)])).rows;

    await context.test('concurrent first turns create exactly one session row and keep every frame', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => recordBenchTurn(db, turn(sessionId, n), meta, 'project')));
      assert.deepEqual(results.map(r => r.kind), Array(8).fill('stored'));
      const rows = await rowsFor(sessionId);
      assert.equal(rows.length, 1, 'one receipt row per session');
      const verdict = verifyTurnAttribution(rows[0].content, turnAttributionOf(rows[0].attribution));
      assert.equal(verdict.status, 'valid');
      if (verdict.status !== 'valid') return;
      assert.equal(verdict.frames.length, 16, 'luca + daniela for each of 8 turns');
      for (let n = 0; n < 8; n++) {
        const own = verdict.frames.filter(f => f.sourceEventId === `${sessionId}:turn-000${n}`);
        assert.deepEqual(own.map(f => [f.frameKey, f.body]), [['luca', `  hola ${n}\n`], ['daniela', `respuesta ${n} — ñ 🙂`]]);
      }
      assert.ok(rows[0].tags.includes(IN_PROGRESS_TAG));
    });

    await context.test('restart: a fresh pool finds the receipt in the database; exact and conflicting retries', async () => {
      const sessionId = `sess-${randomUUID()}`;
      assert.equal((await recordBenchTurn(db, turn(sessionId, 1), meta, 'project')).kind, 'stored');
      const before = (await rowsFor(sessionId))[0].content;
      const restarted = open().db; // no in-memory state survives
      const found = await findBenchTurn(restarted, sessionId, 'turn-0001', meta.userId, '  hola 1\n', 'project');
      assert.equal(found.status, 'complete');
      if (found.status === 'complete') {
        assert.equal(found.lucaText, '  hola 1\n');
        assert.equal(found.danielaText, 'respuesta 1 — ñ 🙂');
        assert.deepEqual(found.event, benchEvent(turn(sessionId, 1)), 'the reloaded event is the recorded event');
      }
      assert.equal((await recordBenchTurn(restarted, turn(sessionId, 1), meta, 'project')).kind, 'exact-retry');
      assert.equal((await rowsFor(sessionId))[0].content, before, 'an exact retry writes nothing');
      // Same turnId, different Luca bytes: refused before any model call.
      assert.equal((await findBenchTurn(restarted, sessionId, 'turn-0001', meta.userId, 'hola 1', 'project')).status, 'conflict');
      // Same turnId, different Daniela bytes: the receipt is refused.
      const changed = await recordBenchTurn(restarted, turn(sessionId, 1, 'otra respuesta'), meta, 'project');
      assert.equal(changed.kind, 'conflict');
      // Another user reusing the session identity.
      assert.equal((await findBenchTurn(restarted, sessionId, 'turn-0001', 'someone-else', '  hola 1\n', 'project')).status, 'conflict');
      assert.equal((await recordBenchTurn(restarted, turn(sessionId, 2), { ...meta, userId: 'someone-else' }, 'project')).kind, 'conflict');
      assert.equal((await rowsFor(sessionId))[0].content, before, 'no refused write changed the row');
      // A turn never recorded is "none", so the route runs Daniela for it.
      assert.equal((await findBenchTurn(restarted, sessionId, 'turn-0009', meta.userId, 'x', 'project')).status, 'none');
    });

    await context.test('receipt commits, projection fails, retry repairs the episode through the common append', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const episodeId = (await pool.query(`INSERT INTO conversation_memories (title, content, tags, arc_name)
        VALUES ('Episode 9990', 'legacy episode bytes\n', ARRAY['rolling'], 'HolaHola Episodes') RETURNING id`)).rows[0].id as string;
      const t = turn(sessionId, 3);
      assert.equal((await recordBenchTurn(db, t, meta, 'project')).kind, 'stored');
      await assert.rejects(projectBenchTurn(db, benchEvent(t), async () => { throw new Error('synthetic projection failure'); }, t));
      const unchanged = (await pool.query('SELECT content, attribution FROM conversation_memories WHERE id = $1', [episodeId])).rows[0];
      assert.equal(unchanged.content, 'legacy episode bytes\n');
      assert.equal(unchanged.attribution, null);
      // The retry finds the receipt and still goes to the common append.
      const found = await findBenchTurn(db, sessionId, t.turnId, meta.userId, t.lucaText, 'project');
      assert.equal(found.status, 'complete');
      if (found.status !== 'complete') return;
      assert.equal(await projectBenchTurn(db, found.event, async () => episodeId, t), 'appended');
      assert.equal(await projectBenchTurn(db, found.event, async () => episodeId, t), 'already-present');
      const episode = (await pool.query('SELECT content, attribution FROM conversation_memories WHERE id = $1', [episodeId])).rows[0];
      assert.equal(episode.content, `legacy episode bytes\n\n\n**Luca:**   hola 3\n\n\n**Daniela:** respuesta 3 — ñ 🙂`);
      assert.equal(verifyTurnAttribution(episode.content, turnAttributionOf(episode.attribution)).status, 'valid');
    });

    await context.test('episode intent is bound to the receipt in both directions (luca-replit review 5720066012)', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const episodeId = (await pool.query(`INSERT INTO conversation_memories (title, content, arc_name)
        VALUES ('Episode 9992', 'ep\n', 'HolaHola Episodes') RETURNING id`)).rows[0].id as string;
      const episodeBytes = async () => (await pool.query('SELECT content FROM conversation_memories WHERE id = $1', [episodeId])).rows[0].content;
      const excluded = turn(sessionId, 6);
      const projected = turn(sessionId, 7);
      assert.equal((await recordBenchTurn(db, excluded, meta, 'exclude')).kind, 'stored');
      assert.equal((await recordBenchTurn(db, projected, meta, 'project')).kind, 'stored');
      // noEpisode:true first, retried with noEpisode omitted/false: refused, and never projected.
      const flipOn = await findBenchTurn(db, sessionId, excluded.turnId, meta.userId, excluded.lucaText, 'project');
      assert.equal(flipOn.status, 'conflict');
      assert.match((flipOn as any).reason, /recorded with noEpisode=true/);
      assert.equal((await recordBenchTurn(db, excluded, meta, 'project')).kind, 'conflict');
      const forced = await projectBenchTurn(db, benchEvent(excluded), async () => episodeId, excluded);
      assert.match((forced as { conflict: string }).conflict, /recorded with noEpisode and is never projected/);
      assert.equal(await episodeBytes(), 'ep\n', 'the excluded turn never reaches the episode');
      // Projected first, retried with noEpisode:true: refused, so the projection repair is never skipped silently.
      const flipOff = await findBenchTurn(db, sessionId, projected.turnId, meta.userId, projected.lucaText, 'exclude');
      assert.equal(flipOff.status, 'conflict');
      assert.match((flipOff as any).reason, /recorded with noEpisode=false/);
      assert.equal((await recordBenchTurn(db, projected, meta, 'exclude')).kind, 'conflict');
      // Same intent: the exact retry is found and carries the stored intent.
      const same = await findBenchTurn(db, sessionId, excluded.turnId, meta.userId, excluded.lucaText, 'exclude');
      assert.equal(same.status, 'complete');
      assert.equal((same as any).intent, 'exclude');
    });

    await context.test('a projected turn is never appended again after the rolling episode rotates', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const ids: string[] = [];
      for (const title of ['Episode 9993', 'Episode 9994']) {
        ids.push((await pool.query(`INSERT INTO conversation_memories (title, content, arc_name) VALUES ($1, 'ep\n', 'HolaHola Episodes') RETURNING id`, [title])).rows[0].id as string);
      }
      const [a, b] = ids;
      const t = turn(sessionId, 8);
      assert.equal((await recordBenchTurn(db, t, meta, 'project')).kind, 'stored');
      assert.equal(await projectBenchTurn(db, benchEvent(t), async () => a, t), 'appended');
      const found = await findBenchTurn(db, sessionId, t.turnId, meta.userId, t.lucaText, 'project');
      assert.equal((found as any).projectedTo, a, 'the target is recorded with the turn');
      assert.equal(await projectBenchTurn(db, benchEvent(t), async () => b, t), 'already-present');
      assert.equal((await pool.query('SELECT content FROM conversation_memories WHERE id = $1', [b])).rows[0].content, 'ep\n', 'the rotated episode gets no second copy');
    });

    await context.test('a completed turn with no recorded intent fails closed', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const t = turn(sessionId, 9);
      assert.equal((await recordBenchTurn(db, t, meta, 'project')).kind, 'stored');
      await pool.query('UPDATE conversation_memories SET tags = array_remove(tags, $2) WHERE $1 = ANY(tags)', [sessionTag(sessionId), `bench-intent:${t.turnId}:project`]);
      const found = await findBenchTurn(db, sessionId, t.turnId, meta.userId, t.lucaText, 'project');
      assert.equal(found.status, 'conflict');
      assert.match((found as any).reason, /no recorded episode intent/);
      assert.equal((await recordBenchTurn(db, t, meta, 'project')).kind, 'conflict');
    });

    await context.test('a partly projected event is a conflict, never half-appended twice', async () => {
      const sessionId = `sess-${randomUUID()}`;
      const episodeId = (await pool.query(`INSERT INTO conversation_memories (title, content, arc_name)
        VALUES ('Episode 9991', '', 'HolaHola Episodes') RETURNING id`)).rows[0].id as string;
      const t4 = turn(sessionId, 4);
      const full = benchEvent(t4);
      assert.equal((await recordBenchTurn(db, t4, meta, 'project')).kind, 'stored');
      assert.equal((await applyProjectionAppend(db, episodeId, { ...full, frames: full.frames.slice(0, 1) })).kind, 'append');
      const result = await projectBenchTurn(db, full, async () => episodeId, t4);
      assert.equal(typeof result, 'object');
      assert.match((result as { conflict: string }).conflict, /only partly present/);
    });

    await context.test('finalize updates the same row; stale sweep finds unfinished rows after restart', async () => {
      const sessionId = `sess-${randomUUID()}`;
      await recordBenchTurn(db, turn(sessionId, 5), meta, 'project');
      await pool.query(`UPDATE conversation_memories SET created_at = now() - interval '2 hours' WHERE $1 = ANY(tags)`, [sessionTag(sessionId)]);
      assert.ok((await staleBenchSessions(open().db, new Date(Date.now() - 3600_000))).includes(sessionId));
      const id = await finalizeBenchSession(db, sessionId, 'Final title', ['j-space-observation']);
      const rows = await rowsFor(sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, id);
      assert.ok(!rows[0].tags.includes(IN_PROGRESS_TAG));
      assert.ok(rows[0].tags.includes('j-space-observation'));
      assert.ok(!(await staleBenchSessions(db, new Date())).includes(sessionId));
      assert.equal(await finalizeBenchSession(db, `sess-${randomUUID()}`, null, []), null, 'a legacy session has no receipt row');
    });
  } finally {
    await Promise.all(pools.map(p => p.end()));
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
