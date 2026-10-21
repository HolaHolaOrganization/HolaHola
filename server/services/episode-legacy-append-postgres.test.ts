/**
 * The row-level guard on the legacy unframed episode append (design
 * f5d77712 section 3.4; luca-replit's PR71 requirements), on real PostgreSQL
 * in an owned throwaway schema of the verified disposable CI database.
 *
 * Cases: legacy null attribution, a valid aware row, malformed-but-present
 * attribution, a marker exact retry, the race with the first framed append,
 * independence from the switch value, and refused legacy work repaired
 * through the supported framed route.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { appendUnframedToLegacyRow } from './episode-legacy-append';
import { applyProjectionAppend, applyProjectionAppendInTx } from './projection-append-store';
import type { AppendEvent } from './projection-append';
import { turnAttributionOf, verifyTurnAttribution } from './turn-attribution';

const event = (id: string, body: string): AppendEvent => ({
  source: 'replit', sourceEventId: id,
  frames: [{ kind: 'attributed', frameKey: 'luca', label: '**Luca:** ', body, speaker: 'luca', hat: 'replit', hatEvidence: 'capture-source', captureId: id, provenance: null }],
});

test('legacy episode append guard on real PostgreSQL', async context => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for the legacy-append guard');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const schema = `legacy_guard_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const pool = new Pool({ connectionString: url, max: 6, options: `-c search_path=${schema}` });
  const db = drizzle(pool) as any;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await admin.query(`CREATE TABLE "${schema}".conversation_memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content text NOT NULL, attribution jsonb)`);
    const make = async (content: string, attribution: unknown = null) =>
      (await pool.query('INSERT INTO conversation_memories (content, attribution) VALUES ($1, $2) RETURNING id', [content, attribution === null ? null : JSON.stringify(attribution)])).rows[0].id as string;
    const read = async (id: string) => (await pool.query('SELECT content, attribution FROM conversation_memories WHERE id = $1', [id])).rows[0];

    await context.test('a legacy row (null attribution) appends, and a marker retry is already-present', async () => {
      const id = await make('ep\n');
      const first = await appendUnframedToLegacyRow(db, id, '<!-- m:1 -->\nhello', '<!-- m:1 -->');
      assert.equal(first.kind, 'appended');
      assert.equal((await read(id)).content, 'ep\n\n<!-- m:1 -->\nhello\n');
      assert.equal((await appendUnframedToLegacyRow(db, id, '<!-- m:1 -->\nhello', '<!-- m:1 -->')).kind, 'already-present');
      assert.equal((await appendUnframedToLegacyRow(db, id, 'unmarked')).kind, 'appended');
    });

    await context.test('a valid aware row is refused and its framed history is unchanged', async () => {
      const id = await make('ep\n');
      assert.equal((await applyProjectionAppend(db, id, event('rp-1', 'framed'))).kind, 'append');
      const before = await read(id);
      for (const marker of ['<!-- m:2 -->', undefined]) {
        assert.equal((await appendUnframedToLegacyRow(db, id, 'unframed', marker)).kind, 'refused-aware');
      }
      const after = await read(id);
      assert.deepEqual(after, before);
      assert.equal(verifyTurnAttribution(after.content, turnAttributionOf(after.attribution)).status, 'valid');
    });

    await context.test('present but malformed attribution is still protected, never downgraded to legacy', async () => {
      for (const attribution of [{ turnAttribution: 'garbage' }, { turnAttribution: null }, { turnAttribution: { version: 99 } }]) {
        const id = await make('ep\n', attribution);
        assert.equal((await appendUnframedToLegacyRow(db, id, 'unframed')).kind, 'refused-aware', JSON.stringify(attribution));
        assert.equal((await read(id)).content, 'ep\n');
      }
      // Other attribution keys alone (e.g. canonical-row fields) do not make a row aware.
      const other = await make('ep\n', { modelTags: ['x'] });
      assert.equal((await appendUnframedToLegacyRow(db, other, 'unframed')).kind, 'appended');
    });

    await context.test('race: a legacy append waiting on the first framed append is refused after it commits', async () => {
      const id = await make('ep\n');
      const framer = await pool.connect();
      try {
        await framer.query('BEGIN');
        // Lock the row and write the first aware append, uncommitted.
        const framerDb = drizzle(framer) as any;
        assert.equal((await applyProjectionAppendInTx(framerDb, id, event('rp-race', 'first framed'))).kind, 'append');
        const legacy = appendUnframedToLegacyRow(db, id, 'racing unframed');
        await new Promise(resolve => setTimeout(resolve, 200));
        await framer.query('COMMIT');
        assert.equal((await legacy).kind, 'refused-aware', 'the predicate is re-evaluated after the framed commit');
      } finally { framer.release(); }
      const row = await read(id);
      assert.doesNotMatch(row.content, /racing unframed/);
      assert.equal(verifyTurnAttribution(row.content, turnAttributionOf(row.attribution)).status, 'valid');
    });

    await context.test('the guard follows the row, not the switch; refused work is repaired by the framed route', async () => {
      const id = await make('ep\n');
      await applyProjectionAppend(db, id, event('rp-3', 'framed'));
      for (const value of ['1', '0', undefined]) {
        if (value === undefined) delete process.env.ATTRIBUTION_WRITERS_V1; else process.env.ATTRIBUTION_WRITERS_V1 = value;
        assert.equal((await appendUnframedToLegacyRow(db, id, 'unframed')).kind, 'refused-aware', `switch=${String(value)}`);
      }
      // The same content, sent through the supported framed append, lands once.
      assert.equal((await applyProjectionAppend(db, id, event('rp-4', 'unframed'))).kind, 'append');
      assert.equal((await applyProjectionAppend(db, id, event('rp-4', 'unframed'))).kind, 'noop');
      const partial: AppendEvent = { ...event('rp-4', 'unframed'), frames: [...event('rp-4', 'unframed').frames, { kind: 'attributed', frameKey: 'david', label: '**David:** ', body: 'q', speaker: 'david', hat: 'replit', hatEvidence: 'capture-source', captureId: 'rp-4', provenance: null }] };
      assert.equal((await applyProjectionAppend(db, id, partial)).kind, 'conflict', 'a partly present event is refused');
      assert.equal((await applyProjectionAppend(db, id, event('rp-4', 'different'))).kind, 'conflict', 'a conflicting retry is refused');
    });

    await context.test('a missing row is reported, never success', async () => {
      assert.equal((await appendUnframedToLegacyRow(db, randomUUID(), 'x')).kind, 'missing');
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
