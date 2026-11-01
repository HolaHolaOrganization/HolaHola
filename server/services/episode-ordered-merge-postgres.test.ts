/**
 * Episode ordered rebuild against the CI job's disposable PostgreSQL: the
 * previous text is snapshotted in the same transaction as the UPDATE, the
 * snapshot table is insert only and binds old_content to its hash, writers
 * that append while the rebuild holds the row lock land after it, a re-run is
 * a no-op, and a changed episode refuses with nothing written. Synthetic rows
 * only, in their own year, so no other test's turns fall in their windows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { CREATED_AT_SQL, PER_TURN_ARC, PER_TURN_TAG, sha256 } from './episode-backfill';
import { computeOrderedMerge, orderedMergeReceipt, type OrderedMergeReceipt } from './episode-ordered-merge';
import { applyRebuild } from '../../scripts/data-ops/rebuild-episode-ordered';
import type { BackfillPool } from '../../scripts/data-ops/backfill-episode-turns';

let pool: any = null;
after(async () => { if (pool) await pool.end(); });

const run = randomUUID().slice(0, 8);
const at = (hour: number, minute: number) => `2087-01-01 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000000`;

async function insertTurn(hour: number, minute: number, label: string) {
  const id = randomUUID();
  const captureId = `om-${run}-${label}`;
  const content = `David [Claude Code]: rebuild ${run} ${label}\n\nClaude Code: reply ${run} ${label}`;
  await pool.query(
    `insert into conversation_memories (id, title, summary, content, tags, arc_name, created_at) values ($1, $2, $3, $4, $5, $6, $7::timestamp)`,
    [id, `rebuild test ${label}`, `rebuild test ${label}`, content, [PER_TURN_TAG, `capture-id:${captureId}`], PER_TURN_ARC, at(hour, minute)],
  );
  return { id, captureId, content };
}

async function insertEpisode(hour: number, content: string) {
  const id = randomUUID();
  const title = `Rebuild test episode ${run} ${id.slice(0, 4)}`;
  await pool.query(
    `insert into conversation_memories (id, title, summary, content, tags, created_at) values ($1, $2, $3, $4, $5, $6::timestamp)`,
    [id, title, title, content, ['rebuild-test'], at(hour, 0)],
  );
  return { id, title };
}

const read = async (id: string) => (await pool.query('select content from conversation_memories where id = $1', [id])).rows[0].content as string;
const snapshots = async (id: string) => (await pool.query('select * from episode_content_snapshots where episode_id = $1', [id])).rows;

/** Build the receipt from the database exactly as the generator does. */
async function receiptFor(episodeId: string, until: string): Promise<OrderedMergeReceipt> {
  const ep = (await pool.query(`select id, title, content, ${CREATED_AT_SQL} as created_at from conversation_memories where id = $1`, [episodeId])).rows[0];
  const rows = (await pool.query(
    `select id, content, ${CREATED_AT_SQL} as created_at, arc_name, tags from conversation_memories where arc_name = $1 and $2 = any(tags) and ${CREATED_AT_SQL} >= $3`,
    [PER_TURN_ARC, PER_TURN_TAG, ep.created_at],
  )).rows.map((r: any) => ({ id: r.id, content: r.content, createdAt: r.created_at, arcName: r.arc_name, tags: r.tags }));
  const merge = computeOrderedMerge(ep.content, rows, ep.created_at, until);
  assert.equal(merge.status, 'merge', JSON.stringify(merge).slice(0, 300));
  if (merge.status !== 'merge') throw new Error('unreachable');
  return orderedMergeReceipt({ id: ep.id, title: ep.title, createdAt: ep.created_at, content: ep.content }, until, merge);
}

/** A pool whose transaction pauses right after the episode's FOR UPDATE until released. */
function pausingPool(inner: any) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const locked = new Promise<void>((r) => { reached = r; });
  const wrapped: BackfillPool = {
    query: (sql, params) => inner.query(sql, params),
    async connect() {
      const client = await inner.connect();
      return {
        async query(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params);
          if (sql.includes('FOR UPDATE')) { reached(); await gate; }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  return { wrapped, release: () => release(), locked };
}

test('episode ordered rebuild: snapshot, insert-only table, shared row lock, rerun and refusal', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for the episode rebuild gate');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 30 });

  // An opening, an existing block for turn B (another recorder's format), and A, C missing around it.
  const a = await insertTurn(1, 5, 'a');
  const b = await insertTurn(1, 10, 'b');
  const c = await insertTurn(1, 15, 'c');
  const opening = `# Rebuild test ${run}\n\nAn opening that must not move.\n\n`;
  const blockB = `<!-- chat-capture:${b.captureId} -->\n\n**David:** B in its own format\n`;
  const ep = await insertEpisode(1, opening + blockB);
  const until = at(1, 59);
  const receipt = await receiptFor(ep.id, until);
  assert.deepEqual(receipt.entries.map((e) => [e.rowId, e.insertBefore]), [[a.id, 0], [c.id, null]]);

  // 1. Appends fired while the rebuild holds the row lock land after the rebuilt content.
  const paused = pausingPool(pool);
  const applying = applyRebuild(paused.wrapped, receipt);
  await paused.locked;
  const appends = Array.from({ length: 5 }, (_, i) => pool.query('update conversation_memories set content = content || $2 where id = $1', [ep.id, `\nlive ${run} ${i}\n`]));
  await new Promise((r) => setTimeout(r, 200));
  paused.release();
  const outcome = await applying;
  assert.equal(outcome.status, 'merged');
  await Promise.all(appends);
  const after1 = await read(ep.id);
  assert.ok(after1.startsWith(opening + `\n<!-- chat-capture:${a.captureId} -->\n`), 'A is inserted before the existing block, after the opening');
  const rebuilt = after1.slice(0, after1.indexOf(`\nlive ${run} `));
  assert.equal(sha256(rebuilt), receipt.newContentSha256, 'the approved bytes, then the live appends');
  for (let i = 0; i < 5; i++) assert.ok(after1.indexOf(`\nlive ${run} ${i}\n`) >= rebuilt.length);

  // 2. The previous text is in the snapshot, bound to its hash.
  const [snap] = await snapshots(ep.id);
  assert.equal(snap.old_content, opening + blockB);
  assert.equal(snap.old_content_sha256, receipt.oldContentSha256);
  assert.equal(snap.new_content_sha256, receipt.newContentSha256);
  assert.equal(snap.receipt_list_sha256, receipt.listSha256);

  // 3. The snapshot table is insert only, and its CHECK binds old_content to its hash.
  await assert.rejects(pool.query('update episode_content_snapshots set reason = $2 where id = $1', [snap.id, 'edited']), /insert-only/);
  await assert.rejects(pool.query('delete from episode_content_snapshots where id = $1', [snap.id]), /insert-only/);
  await assert.rejects(pool.query(
    `insert into episode_content_snapshots (episode_id, reason, old_content, old_content_sha256, new_content_sha256, receipt_list_sha256) values ($1, 'test', 'x', $2, $2, $2)`,
    [randomUUID(), 'f'.repeat(64)],
  ), /episode_content_snapshots_old_hash_matches/);

  // 4. The episode moved on (live appends), so the same receipt now refuses; nothing is written.
  const refused = await applyRebuild(pool, receipt);
  assert.equal(refused.status, 'refused');
  assert.equal(await read(ep.id), after1);
  assert.equal((await snapshots(ep.id)).length, 1);

  // 5. A re-run on exactly the approved content is complete and writes nothing.
  const d = await insertTurn(2, 5, 'd');
  const e = await insertTurn(2, 10, 'e');
  const ep2 = await insertEpisode(2, `# Rebuild test two ${run}\n\n<!-- chat-capture:${e.captureId} -->\nE as recorded\n`);
  const receipt2 = await receiptFor(ep2.id, at(2, 59));
  assert.equal((await applyRebuild(pool, receipt2)).status, 'merged');
  const after2 = await read(ep2.id);
  assert.ok(after2.indexOf(d.content) < after2.indexOf('E as recorded'));
  assert.deepEqual(await applyRebuild(pool, receipt2), { status: 'complete' });
  assert.equal(await read(ep2.id), after2);
  assert.equal((await snapshots(ep2.id)).length, 1);
});
