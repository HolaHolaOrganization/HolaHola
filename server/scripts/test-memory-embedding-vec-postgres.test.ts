/**
 * memory_embeddings.embedding_vec (migration 0077) against real, disposable CI
 * Postgres with pgvector: the sync trigger, the resumable backfill data-op, and
 * the stored-vector scorer the Archive Guardian uses (ranking and the same
 * ownership guard as the jsonb path). Vectors are synthetic; no provider calls.
 *
 * Skipped outside verified CI, and skipped with a printed reason where the CI
 * Postgres image lacks pgvector (migration 0077 is conditional on it). Set
 * REQUIRE_PGVECTOR=1 once the CI image provides pgvector so a regression to a
 * plain image fails instead of skipping.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { memoryEmbeddings } from '@shared/schema';
import { backfill } from '../../scripts/data-ops/backfill-memory-embedding-vec';
import {
  resetStoredVectorReadinessForTests,
  scoreWithStoredVectors,
  storedVectorsReady,
} from '../services/semantic-memory-service';

const ciUrl = getVerifiedCiDatabaseUrl();
let pgvectorReady = false;
const databaseTest = (name: string, fn: () => Promise<void>) => (ciUrl ? test : test.skip)(name, async t => {
  if (!pgvectorReady) return t.skip('CI Postgres has no pgvector; migration 0077 skipped the column');
  await fn();
});
const OWNER = `vec-owner-${randomUUID()}`;
const OTHER = `vec-other-${randomUUID()}`;
const tag = randomUUID().slice(0, 8);
let pool: pg.Pool | undefined;

/** A unit-ish 768-dim vector pointing mostly along `axis`. */
function vec(axis: number, lean = 0.05): number[] {
  const v = Array.from({ length: 768 }, () => lean);
  v[axis] = 1;
  return v;
}

async function insert(memoryId: string, userId: string | null, memoryType: string, embedding: unknown) {
  await getSharedDb().execute(sql`
    INSERT INTO memory_embeddings (memory_type, memory_id, user_id, embedding, content_hash)
    VALUES (${memoryType}, ${memoryId}, ${userId}, ${JSON.stringify(embedding)}::jsonb, ${'h-' + memoryId})`);
}

async function storedVec(memoryId: string): Promise<string | null> {
  const r: any = await getSharedDb().execute(sql`
    SELECT embedding_vec::text AS v FROM memory_embeddings WHERE memory_id = ${memoryId}`);
  return (r.rows ?? r)[0]?.v ?? null;
}

before(async () => {
  if (!ciUrl) return;
  const available: any = await getSharedDb().execute(sql`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`);
  if ((available.rows ?? available).length === 0) {
    assert.notEqual(process.env.REQUIRE_PGVECTOR, '1', 'REQUIRE_PGVECTOR=1 but CI Postgres has no pgvector');
    console.log('[embedding-vec] pgvector unavailable in this Postgres — database cases skip');
    return;
  }
  pgvectorReady = true;
  const column: any = await getSharedDb().execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_embeddings' AND column_name = 'embedding_vec'`);
  assert.equal((column.rows ?? column).length, 1, 'migration 0077 must have added embedding_vec');
  await getSharedDb().execute(sql`INSERT INTO users (id, role) VALUES (${OWNER}, 'student'), (${OTHER}, 'student')
    ON CONFLICT (id) DO NOTHING`);
  pool = new pg.Pool({ connectionString: ciUrl });
});

after(async () => {
  if (ciUrl) {
    await getSharedDb().execute(sql`DELETE FROM memory_embeddings WHERE memory_id LIKE ${'%' + tag + '%'}`);
    await getSharedDb().execute(sql`DELETE FROM users WHERE id IN (${OWNER}, ${OTHER})`);
  }
  await pool?.end();
  await closeDbConnections();
});

databaseTest('the trigger fills 768-dim rows, leaves stubs NULL and follows updates and upserts', async () => {
  await insert(`full-${tag}`, OWNER, 'conversation_memory', vec(3));
  await insert(`stub-${tag}`, OWNER, 'conversation_memory', [0.5, 0.5]);
  const malformed: unknown[] = vec(4);
  malformed[10] = 'not-a-number';
  await insert(`malformed-${tag}`, OWNER, 'conversation_memory', malformed);
  assert.ok((await storedVec(`full-${tag}`))?.startsWith('[0.05,0.05,0.05,1,'));
  assert.equal(await storedVec(`stub-${tag}`), null);
  assert.equal(await storedVec(`malformed-${tag}`), null, 'a malformed 768-element array is stored without a vector, not rejected');

  await getSharedDb().update(memoryEmbeddings).set({ embedding: vec(9) })
    .where(eq(memoryEmbeddings.memoryId, `full-${tag}`));
  assert.ok((await storedVec(`full-${tag}`))?.includes(',1,'));

  await getSharedDb().execute(sql`
    INSERT INTO memory_embeddings (memory_type, memory_id, user_id, embedding, content_hash)
    VALUES ('conversation_memory', ${`full-${tag}`}, ${OWNER}, ${JSON.stringify(vec(5))}::jsonb, 'h2')
    ON CONFLICT (memory_type, memory_id) DO UPDATE SET embedding = EXCLUDED.embedding`);
  const upserted = (await storedVec(`full-${tag}`))!.slice(1, -1).split(',').map(Number);
  assert.equal(upserted[5], 1);
  assert.equal(upserted[9], 0.05);
});

databaseTest('the backfill fills rows written before the trigger and is a no-op afterwards', async () => {
  await insert(`old-a-${tag}`, OWNER, 'conversation_summary', vec(7));
  await insert(`old-b-${tag}`, null, 'growth_memory', vec(8));
  await insert(`old-stub-${tag}`, null, 'growth_memory', [0]);
  // Simulate pre-0077 rows: clearing embedding_vec alone does not fire the trigger.
  await getSharedDb().execute(sql`UPDATE memory_embeddings SET embedding_vec = NULL
    WHERE memory_id IN (${`old-a-${tag}`}, ${`old-b-${tag}`})`);
  assert.equal(await storedVec(`old-a-${tag}`), null);

  const first = await backfill(pool as any);
  assert.equal(first.applied, true);
  assert.match(first.detail, /all rows filled/);
  assert.ok(await storedVec(`old-a-${tag}`));
  assert.ok(await storedVec(`old-b-${tag}`));
  assert.equal(await storedVec(`old-stub-${tag}`), null, 'non-768 rows stay NULL');

  const second = await backfill(pool as any);
  assert.equal(second.applied, false);
  assert.match(second.detail, /filled 0 row\(s\); all rows filled/);
});

databaseTest('a zero time budget stops before filling and reports that it will continue', async () => {
  await insert(`late-${tag}`, OWNER, 'conversation_memory', vec(11));
  await getSharedDb().execute(sql`UPDATE memory_embeddings SET embedding_vec = NULL WHERE memory_id = ${`late-${tag}`}`);
  const result = await backfill(pool as any, 0);
  assert.equal(result.applied, false);
  assert.match(result.detail, /Guardian pools still filling/);
  assert.equal(await storedVec(`late-${tag}`), null);
  await backfill(pool as any);
});

databaseTest('the stored-vector scorer ranks by similarity and keeps the ownership guard', async () => {
  await insert(`near-${tag}`, OWNER, 'conversation_memory', vec(20));
  await insert(`far-${tag}`, OWNER, 'conversation_memory', vec(21));
  await insert(`foreign-${tag}`, OTHER, 'conversation_memory', vec(20));
  await insert(`global-ok-${tag}`, null, 'growth_memory', vec(20));
  await insert(`global-collab-${tag}`, null, 'collaboration_message', vec(20));

  const scored = await scoreWithStoredVectors(
    vec(20),
    and(eq(memoryEmbeddings.userId, OWNER), inArray(memoryEmbeddings.memoryType, ['conversation_memory']))!,
    ['growth_memory'],
  );
  const mine = scored.filter(r => r.memoryId.endsWith(tag));
  const ids = mine.map(r => r.memoryId);
  assert.ok(ids.includes(`near-${tag}`) && ids.includes(`far-${tag}`) && ids.includes(`global-ok-${tag}`));
  assert.equal(new Set(ids).size, ids.length, 'the global and in-window batches are de-duplicated');
  assert.ok(!ids.includes(`foreign-${tag}`), 'another user\'s private row must never be returned');
  assert.ok(!ids.includes(`global-collab-${tag}`), 'types outside the allowed global list must never be returned');
  const near = mine.find(r => r.memoryId === `near-${tag}`)!;
  const far = mine.find(r => r.memoryId === `far-${tag}`)!;
  assert.ok(near.similarity > 0.999, `identical vector should score ~1, got ${near.similarity}`);
  assert.ok(near.similarity > far.similarity);
  assert.ok(near.effectiveScore > 0);
});

test('readiness answers from cache, checks in the background, latches once filled', async () => {
  resetStoredVectorReadinessForTests();
  let clock = 0;
  const answers = [false, true];
  let calls = 0;
  const check = async () => { calls++; return answers.shift()!; };
  const now = () => clock;

  assert.equal(storedVectorsReady(['conversation_memory'], check, now), false, 'never blocks: first call is false');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(storedVectorsReady(['conversation_memory'], check, now), false, 'no recheck inside the interval');
  assert.equal(calls, 1);

  clock = 60_000;
  assert.equal(storedVectorsReady(['conversation_memory'], check, now), false);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(storedVectorsReady(['conversation_memory'], check, now), true, 'latched once filled');
  clock = 10_000_000;
  assert.equal(storedVectorsReady(['conversation_memory'], check, now), true);
  assert.equal(calls, 2, 'no further checks after latching');

  resetStoredVectorReadinessForTests();
  const failing = async () => { throw new Error('db down'); };
  assert.equal(storedVectorsReady(['x'], failing, () => 0), false);
  await new Promise(r => setImmediate(r));
  assert.equal(storedVectorsReady(['x'], failing, () => 1), false, 'a failed check stays not-ready');
});
