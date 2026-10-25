/**
 * Alden narrative sync against real (disposable CI) Postgres: convergence,
 * concurrent syncs, a speaker change, a vanished source, and recall freshness
 * (failed and stale embeddings retried). Classifier and embedder are stubs: no
 * provider calls. Skipped unless an isolated CI database is configured.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { syncAldenConversation, type AldenSyncDeps } from '../services/founder-chat-sync';
import { ALDEN_MEMORY_FRAMING_LINE, fullArmInput } from '../services/alden-chat-transcript';

const databaseTest = getVerifiedCiDatabaseUrl() ? test : test.skip;
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const conversations: string[] = [];

/** Stub embedder: writes the arms reembed-memory.ts would, from the row as stored now. */
function stubDeps(options: { failFirst?: number } = {}) {
  let failures = options.failFirst ?? 0;
  const embedded: string[] = [];
  const deps: AldenSyncDeps = {
    classify: async (caller) => (/build|deploy/i.test(caller) ? 'technical' : 'conversational'),
    embed: async (id) => {
      if (failures > 0) { failures--; throw new Error('embedding provider down'); }
      const db = getSharedDb();
      const row = (await db.execute(sql`SELECT title, summary, content FROM conversation_memories WHERE id = ${id}`)).rows[0] as any;
      await db.execute(sql`DELETE FROM memory_embeddings WHERE memory_id = ${id} OR memory_id LIKE ${id + ':chunk:%'}`);
      await db.execute(sql`INSERT INTO memory_embeddings (memory_type, memory_id, embedding, content_hash)
        VALUES ('conversation_memory', ${id}, '[0]'::jsonb, ${sha(fullArmInput(row))}),
               ('conversation_chunk', ${id + ':chunk:0'}, '[0]'::jsonb, 'x')`);
      embedded.push(id);
    },
  };
  return { deps, embedded };
}

async function seedSession(turns: Array<[string, string, string?]>) {
  const db = getSharedDb();
  const id = randomUUID();
  conversations.push(id);
  await db.execute(sql`INSERT INTO alden_conversations (id, title, started_at) VALUES (${id}, ${'Test session ' + id.slice(0, 8)}, now())`);
  let t = Date.now();
  for (const [caller, reply, replyRole] of turns) {
    t += 1000;
    const at = new Date(t);
    await db.execute(sql`INSERT INTO alden_messages (id, conversation_id, role, content, created_at) VALUES (${randomUUID()}, ${id}, 'david', ${caller}, ${at})`);
    await db.execute(sql`INSERT INTO alden_messages (id, conversation_id, role, content, created_at) VALUES (${randomUUID()}, ${id}, ${replyRole ?? 'alden'}, ${reply}, ${at})`);
  }
  return id;
}

async function derivedRows(conversationId: string) {
  return (await getSharedDb().execute(sql`
    SELECT id, content FROM conversation_memories
    WHERE arc_name = 'david-alden-chats' AND ${'alden-cid:' + conversationId} = ANY(tags) ORDER BY content
  `)).rows as Array<{ id: string; content: string }>;
}

after(async () => {
  if (getVerifiedCiDatabaseUrl()) {
    const db = getSharedDb();
    for (const id of conversations) {
      const rows = await derivedRows(id);
      for (const row of rows) await db.execute(sql`DELETE FROM memory_embeddings WHERE memory_id = ${row.id} OR memory_id LIKE ${row.id + ':chunk:%'}`);
      await db.execute(sql`DELETE FROM conversation_memories WHERE ${'alden-cid:' + id} = ANY(tags)`);
      await db.execute(sql`DELETE FROM alden_exchange_labels WHERE conversation_id = ${id}`);
      await db.execute(sql`DELETE FROM alden_messages WHERE conversation_id = ${id}`);
      await db.execute(sql`DELETE FROM alden_conversations WHERE id = ${id}`);
    }
  }
  await closeDbConnections();
});

databaseTest('sync builds framed verbatim clusters, stores labels with reasons, and a rerun converges', async () => {
  const id = await seedSession([['how are you?', 'well, thanks'], ['please build it', 'done'], ['good night', 'sleep well']]);
  const { deps, embedded } = stubDeps();
  const first = await syncAldenConversation(id, deps);
  assert.equal(first.status, 'synced');
  if (first.status !== 'synced') return;
  assert.deepEqual([first.inserted, first.embedded, first.pendingLabels], [2, 2, 0]);
  const rows = await derivedRows(id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.content.startsWith(ALDEN_MEMORY_FRAMING_LINE)));
  assert.ok(rows.some((r) => r.content.endsWith('David: good night\n\nAlden: sleep well')));
  const labels = (await getSharedDb().execute(sql`SELECT label, reason FROM alden_exchange_labels WHERE conversation_id = ${id} ORDER BY reason`)).rows as any[];
  assert.deepEqual(labels.map((l) => l.label).sort(), ['conversational', 'conversational', 'technical']);
  const again = await syncAldenConversation(id, deps);
  assert.deepEqual(again.status === 'synced' && [again.inserted, again.updated, again.retired, again.unchanged, again.embedded], [0, 0, 0, 2, 0]);
  assert.equal(embedded.length, 2, 'current recall is not re-embedded');
});

databaseTest('concurrent syncs of one session produce exactly one row per cluster', async () => {
  const id = await seedSession([['hello', 'hi there'], ['thank you', 'any time']]);
  const { deps } = stubDeps();
  await Promise.all([syncAldenConversation(id, deps), syncAldenConversation(id, deps), syncAldenConversation(id, deps)]);
  assert.equal((await derivedRows(id)).length, 1);
});

databaseTest('a speaker change relabels and updates the row, dropping its old recall in the same step', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  const { deps } = stubDeps();
  await syncAldenConversation(id, deps);
  const [before] = await derivedRows(id);
  await getSharedDb().execute(sql`UPDATE alden_messages SET role = 'alden-gemini' WHERE conversation_id = ${id} AND role = 'alden'`);
  const result = await syncAldenConversation(id, deps);
  assert.deepEqual(result.status === 'synced' && [result.updated, result.embedded], [1, 1]);
  const [after] = await derivedRows(id);
  assert.equal(after.id, before.id);
  assert.match(after.content, /Alden \[gemini\]: hi there$/);
});

databaseTest('a vanished source retires its derived rows and their recall', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  const { deps } = stubDeps();
  await syncAldenConversation(id, deps);
  const [row] = await derivedRows(id);
  const db = getSharedDb();
  await db.execute(sql`DELETE FROM alden_messages WHERE conversation_id = ${id}`);
  await db.execute(sql`DELETE FROM alden_conversations WHERE id = ${id}`);
  const result = await syncAldenConversation(id, deps);
  assert.equal(result.status === 'synced' && result.retired, 1);
  assert.equal((await derivedRows(id)).length, 0);
  const left = (await db.execute(sql`SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id = ${row.id} OR memory_id LIKE ${row.id + ':chunk:%'}`)).rows[0] as any;
  assert.equal(left.n, 0);
});

databaseTest('a failed embed is retried on the next sync, and a stale embedding is caught by hash', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  const failing = stubDeps({ failFirst: 1 });
  const first = await syncAldenConversation(id, failing.deps);
  assert.deepEqual(first.status === 'synced' && [first.inserted, first.embedded, first.embedFailures], [1, 0, 1]);
  const retry = await syncAldenConversation(id, failing.deps);
  assert.deepEqual(retry.status === 'synced' && [retry.unchanged, retry.embedded, retry.embedFailures], [1, 1, 0]);
  const [row] = await derivedRows(id);
  await getSharedDb().execute(sql`UPDATE memory_embeddings SET content_hash = 'stale' WHERE memory_id = ${row.id} AND memory_type = 'conversation_memory'`);
  const caught = await syncAldenConversation(id, failing.deps);
  assert.equal(caught.status === 'synced' && caught.embedded, 1);
});
