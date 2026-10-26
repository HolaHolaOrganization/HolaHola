/**
 * Alden narrative sync against real (disposable CI) Postgres: convergence,
 * concurrent syncs, a speaker change, a vanished source, recall completeness,
 * and the version-checked embedding commit under real interleavings (an old
 * embedding job held open while a newer update or a retirement commits).
 * Classifier and vectors are stubs: no provider calls. Skipped unless an
 * isolated CI database is configured.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { syncAldenConversation, type AldenSyncDeps } from '../services/founder-chat-sync';
import { ALDEN_MEMORY_FRAMING_LINE } from '../services/alden-chat-transcript';

const databaseTest = getVerifiedCiDatabaseUrl() ? test : test.skip;
const conversations: string[] = [];

function deps(over: Partial<AldenSyncDeps> = {}): AldenSyncDeps {
  return {
    classify: async (caller) => (/build|deploy/i.test(caller) ? 'technical' : 'conversational'),
    embedVector: async () => [0.5, 0.5],
    ownerUserId: null,
    ...over,
  };
}

/** A vector source that holds its first call open until released. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  let first = true;
  const embedVector = async () => {
    if (first) { first = false; entered(); await opened; }
    return [0.1, 0.9];
  };
  return { embedVector, started, release };
}

async function seedSession(turns: Array<[string, string]>) {
  const db = getSharedDb();
  const id = randomUUID();
  conversations.push(id);
  await db.execute(sql`INSERT INTO alden_conversations (id, title, started_at) VALUES (${id}, ${'Test session ' + id.slice(0, 8)}, now())`);
  let t = Date.now();
  for (const [caller, reply] of turns) {
    t += 1000;
    const at = new Date(t);
    await db.execute(sql`INSERT INTO alden_messages (id, conversation_id, role, content, created_at) VALUES (${randomUUID()}, ${id}, 'david', ${caller}, ${at})`);
    await db.execute(sql`INSERT INTO alden_messages (id, conversation_id, role, content, created_at) VALUES (${randomUUID()}, ${id}, 'alden', ${reply}, ${at})`);
  }
  return id;
}

async function derivedRows(conversationId: string) {
  return (await getSharedDb().execute(sql`
    SELECT id, content FROM conversation_memories
    WHERE arc_name = 'david-alden-chats' AND ${'alden-cid:' + conversationId} = ANY(tags) ORDER BY content
  `)).rows as Array<{ id: string; content: string }>;
}

async function arms(rowId: string) {
  return (await getSharedDb().execute(sql`
    SELECT memory_type, memory_id, embedding FROM memory_embeddings
    WHERE memory_id = ${rowId} OR memory_id LIKE ${rowId + ':chunk:%'} ORDER BY memory_type, memory_id
  `)).rows as Array<{ memory_type: string; memory_id: string; embedding: number[] }>;
}

after(async () => {
  if (getVerifiedCiDatabaseUrl()) {
    const db = getSharedDb();
    for (const id of conversations) {
      for (const row of await derivedRows(id)) {
        await db.execute(sql`DELETE FROM memory_embeddings WHERE memory_id = ${row.id} OR memory_id LIKE ${row.id + ':chunk:%'}`);
      }
      await db.execute(sql`DELETE FROM conversation_memories WHERE ${'alden-cid:' + id} = ANY(tags)`);
      await db.execute(sql`DELETE FROM alden_exchange_labels WHERE conversation_id = ${id}`);
      await db.execute(sql`DELETE FROM alden_messages WHERE conversation_id = ${id}`);
      await db.execute(sql`DELETE FROM alden_conversations WHERE id = ${id}`);
    }
  }
  await closeDbConnections();
});

databaseTest('sync builds framed verbatim clusters with every recall arm, and a rerun converges', async () => {
  const id = await seedSession([['how are you?', 'well, thanks'], ['please build it', 'done'], ['good night', 'sleep well']]);
  const first = await syncAldenConversation(id, deps());
  assert.equal(first.status, 'synced');
  if (first.status !== 'synced') return;
  assert.deepEqual([first.inserted, first.embedded, first.pendingLabels], [2, 2, 0]);
  const rows = await derivedRows(id);
  assert.ok(rows.every((r) => r.content.startsWith(ALDEN_MEMORY_FRAMING_LINE)));
  assert.ok(rows.some((r) => r.content.endsWith('David: good night\n\nAlden: sleep well')));
  for (const row of rows) {
    assert.deepEqual((await arms(row.id)).map((a) => a.memory_type), ['conversation_chunk', 'conversation_memory', 'conversation_summary']);
  }
  const again = await syncAldenConversation(id, deps());
  assert.deepEqual(again.status === 'synced' && [again.inserted, again.updated, again.retired, again.unchanged, again.embedded], [0, 0, 0, 2, 0]);
});

databaseTest('concurrent syncs of one session produce exactly one row per cluster', async () => {
  const id = await seedSession([['hello', 'hi there'], ['thank you', 'any time']]);
  await Promise.all([syncAldenConversation(id, deps()), syncAldenConversation(id, deps()), syncAldenConversation(id, deps())]);
  assert.equal((await derivedRows(id)).length, 1);
});

databaseTest('a speaker change relabels and updates the row, and its recall is rebuilt', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  await syncAldenConversation(id, deps());
  const [before] = await derivedRows(id);
  await getSharedDb().execute(sql`UPDATE alden_messages SET role = 'alden-gemini' WHERE conversation_id = ${id} AND role = 'alden'`);
  const result = await syncAldenConversation(id, deps());
  assert.deepEqual(result.status === 'synced' && [result.updated, result.embedded], [1, 1]);
  const [after] = await derivedRows(id);
  assert.equal(after.id, before.id);
  assert.match(after.content, /Alden \[gemini\]: hi there$/);
});

databaseTest('a vanished source retires its derived rows and their recall', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  await syncAldenConversation(id, deps());
  const [row] = await derivedRows(id);
  const db = getSharedDb();
  await db.execute(sql`DELETE FROM alden_messages WHERE conversation_id = ${id}`);
  await db.execute(sql`DELETE FROM alden_conversations WHERE id = ${id}`);
  const result = await syncAldenConversation(id, deps());
  assert.equal(result.status === 'synced' && result.retired, 1);
  assert.equal((await derivedRows(id)).length, 0);
  assert.equal((await arms(row.id)).length, 0);
});

databaseTest('recall is rebuilt when any arm is missing, stale or extra, and after a failed embed', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  let fail = true;
  const flaky = deps({ embedVector: async () => { if (fail) { fail = false; throw new Error('provider down'); } return [0.5, 0.5]; } });
  const first = await syncAldenConversation(id, flaky);
  assert.deepEqual(first.status === 'synced' && [first.inserted, first.embedded, first.embedFailures], [1, 0, 1]);
  const retry = await syncAldenConversation(id, flaky);
  assert.deepEqual(retry.status === 'synced' && [retry.unchanged, retry.embedded], [1, 1]);
  const [row] = await derivedRows(id);
  const db = getSharedDb();
  for (const corrupt of [
    sql`DELETE FROM memory_embeddings WHERE memory_id = ${row.id} AND memory_type = 'conversation_summary'`,
    sql`UPDATE memory_embeddings SET content_hash = 'stale' WHERE memory_id = ${row.id + ':chunk:0'}`,
    sql`INSERT INTO memory_embeddings (memory_type, memory_id, embedding, content_hash) VALUES ('conversation_chunk', ${row.id + ':chunk:9'}, '[0]'::jsonb, 'x')`,
  ]) {
    await db.execute(corrupt);
    const repaired = await syncAldenConversation(id, deps());
    assert.equal(repaired.status === 'synced' && repaired.embedded, 1);
    assert.equal((await arms(row.id)).length, 3);
  }
});

databaseTest('an old embedding job held open while a newer update commits is discarded, not written', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  const held = gate();
  const oldSync = syncAldenConversation(id, deps({ embedVector: held.embedVector }));
  await held.started; // the old job has its snapshot and is computing vectors
  await getSharedDb().execute(sql`UPDATE alden_messages SET content = 'hello again' WHERE conversation_id = ${id} AND role = 'alden'`);
  const newer = await syncAldenConversation(id, deps());
  assert.deepEqual(newer.status === 'synced' && [newer.updated, newer.embedded], [1, 1]);
  held.release();
  const old = await oldSync;
  assert.equal(old.status === 'synced' && old.superseded, 1, 'the old job saw a newer version and wrote nothing');
  const [row] = await derivedRows(id);
  assert.match(row.content, /Alden: hello again$/);
  const now = await arms(row.id);
  assert.equal(now.length, 3);
  assert.ok(now.every((a) => JSON.stringify(a.embedding) === '[0.5,0.5]'), 'only the newer job\'s vectors are stored');
  const settled = await syncAldenConversation(id, deps());
  assert.equal(settled.status === 'synced' && settled.embedded, 0, 'recall is current for the newer text');
});

databaseTest('an old embedding job held open while the row is retired writes nothing (no orphan arms)', async () => {
  const id = await seedSession([['hello', 'hi there']]);
  const held = gate();
  const oldSync = syncAldenConversation(id, deps({ embedVector: held.embedVector }));
  await held.started;
  const [row] = await derivedRows(id);
  const db = getSharedDb();
  await db.execute(sql`DELETE FROM alden_messages WHERE conversation_id = ${id}`);
  await db.execute(sql`DELETE FROM alden_conversations WHERE id = ${id}`);
  const retire = await syncAldenConversation(id, deps());
  assert.equal(retire.status === 'synced' && retire.retired, 1);
  held.release();
  const old = await oldSync;
  assert.equal(old.status === 'synced' && old.superseded, 1);
  assert.equal((await arms(row.id)).length, 0, 'no orphan arms for the retired row');
});
