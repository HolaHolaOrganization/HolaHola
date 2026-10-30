/**
 * Episode backfill transaction against the CI job's disposable PostgreSQL:
 * the episode row lock excludes interleaved episode writers for the whole
 * batch, source rows are held FOR SHARE until commit, a newer turn already in
 * the episode refuses the batch, and a re-run is a no-op. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { EPISODE_BACKFILL_RECEIPT_KIND, PER_TURN_ARC, PER_TURN_TAG, sha256, type EpisodeBackfillEntry, type EpisodeBackfillReceipt } from './episode-backfill';
import { applyBackfill, type BackfillPool } from '../../scripts/data-ops/backfill-episode-turns';

let pool: any = null;
after(async () => { if (pool) await pool.end(); });

const run = randomUUID().slice(0, 8);
const time = (minute: number) => `2099-01-01 00:${String(minute).padStart(2, '0')}:00.000000`;

async function insertTurn(minute: number, label: string) {
  const id = randomUUID();
  const captureId = `bf-${run}-${label}`;
  const content = `David [Claude Code]: backfill ${run} ${label}\n\nClaude Code: reply ${run} ${label}`;
  await pool.query(
    `insert into conversation_memories (id, title, summary, content, tags, arc_name, created_at) values ($1, $2, $3, $4, $5, $6, $7::timestamp)`,
    [id, `backfill test ${label}`, `backfill test ${label}`, content, [PER_TURN_TAG, `capture-id:${captureId}`], PER_TURN_ARC, time(minute)],
  );
  const entry: EpisodeBackfillEntry = { rowId: id, captureId, createdAt: time(minute), contentSha256: sha256(content) };
  return { id, content, entry };
}

async function insertEpisode(content: string) {
  const id = randomUUID();
  const title = `Backfill test episode ${run} ${id.slice(0, 4)}`;
  await pool.query(`insert into conversation_memories (id, title, summary, content, tags) values ($1, $2, $3, $4, $5)`, [id, title, title, content, ['backfill-test']]);
  return { id, title };
}

const receiptOf = (episodeId: string, episodeTitle: string, entries: EpisodeBackfillEntry[]): EpisodeBackfillReceipt =>
  ({ kind: EPISODE_BACKFILL_RECEIPT_KIND, episodeId, episodeTitle, entries, listSha256: sha256(JSON.stringify(entries)) });
const read = async (id: string) => (await pool.query('select content from conversation_memories where id = $1', [id])).rows[0].content as string;

/** A pool whose transaction pauses right after the given locking SELECT until released. */
function pausingPool(inner: any, after: 'FOR UPDATE' | 'FOR SHARE') {
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
          if (sql.includes(after)) { reached(); await gate; }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  return { wrapped, release: () => release(), locked };
}

test('episode backfill: batch lock, source share lock, newer-turn refusal and rerun', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for the episode backfill gate');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 30 });

  // 1. Appends fired while the backfill holds the episode lock all land after the whole batch.
  const t1 = await insertTurn(1, 'one');
  const t2 = await insertTurn(2, 'two');
  const ep = await insertEpisode('# Synthetic episode\n');
  const receipt = receiptOf(ep.id, ep.title, [t1.entry, t2.entry]);
  const paused = pausingPool(pool, 'FOR UPDATE');
  const applying = applyBackfill(paused.wrapped, receipt);
  await paused.locked;
  const appends = Array.from({ length: 10 }, (_, i) => pool.query('update conversation_memories set content = content || $2 where id = $1', [ep.id, `\nlive ${i}\n`]));
  await new Promise((r) => setTimeout(r, 200));
  paused.release();
  assert.deepEqual(await applying, { status: 'appended', appended: 2, alreadyPresent: 0 });
  await Promise.all(appends);
  const after1 = await read(ep.id);
  const lastBackfill = after1.indexOf(`reply ${run} two`);
  assert.ok(after1.indexOf(`reply ${run} one`) < lastBackfill, 'oldest first');
  for (let i = 0; i < 10; i++) {
    const at = after1.indexOf(`\nlive ${i}\n`);
    assert.ok(at > lastBackfill, `live append ${i} landed after the whole batch`);
  }

  // 2. A re-run writes nothing.
  assert.deepEqual(await applyBackfill(pool, receipt), { status: 'complete', alreadyPresent: 2 });
  assert.equal(await read(ep.id), after1);

  // 3. A source row update waits for the backfill's FOR SHARE lock; the backfill uses the approved bytes.
  const t3 = await insertTurn(3, 'three');
  const ep2 = await insertEpisode('# Synthetic episode two\n');
  const sharePaused = pausingPool(pool, 'FOR SHARE');
  const applying2 = applyBackfill(sharePaused.wrapped, receiptOf(ep2.id, ep2.title, [t3.entry]));
  await sharePaused.locked;
  let sourceUpdated = false;
  const editing = pool.query('update conversation_memories set content = content || $2 where id = $1', [t3.id, ' edited']).then(() => { sourceUpdated = true; });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sourceUpdated, false, 'source edit waits for the backfill transaction');
  sharePaused.release();
  assert.equal((await applying2).status, 'appended');
  await editing;
  assert.ok((await read(ep2.id)).includes(`reply ${run} three`) && !(await read(ep2.id)).includes('edited'));

  // 4. A newer canonical turn already in the episode refuses the batch; nothing is written.
  const older = await insertTurn(4, 'older');
  const newer = await insertTurn(5, 'newer');
  const ep3 = await insertEpisode('# Synthetic episode three\n');
  await applyBackfill(pool, receiptOf(ep3.id, ep3.title, [newer.entry]));
  const before4 = await read(ep3.id);
  const refused = await applyBackfill(pool, receiptOf(ep3.id, ep3.title, [older.entry]));
  assert.equal(refused.status, 'refused');
  assert.equal(await read(ep3.id), before4);

  // 5. Equal timestamps: a present turn at the SAME created_at with a later id still refuses the batch.
  const tieTime = 6;
  const tiedIds = [randomUUID(), randomUUID()].sort();
  const insertTied = async (id: string, label: string) => {
    const captureId = `bf-${run}-${label}`;
    const content = `David [Claude Code]: backfill ${run} ${label}\n\nClaude Code: reply ${run} ${label}`;
    await pool.query(
      `insert into conversation_memories (id, title, summary, content, tags, arc_name, created_at) values ($1, $2, $3, $4, $5, $6, $7::timestamp)`,
      [id, `backfill test ${label}`, `backfill test ${label}`, content, [PER_TURN_TAG, `capture-id:${captureId}`], PER_TURN_ARC, time(tieTime)],
    );
    return { id, entry: { rowId: id, captureId, createdAt: time(tieTime), contentSha256: sha256(content) } as EpisodeBackfillEntry };
  };
  const tiedOlder = await insertTied(tiedIds[0], 'tie-a');
  const tiedNewer = await insertTied(tiedIds[1], 'tie-b');
  const ep4 = await insertEpisode('# Synthetic episode four\n');
  assert.equal((await applyBackfill(pool, receiptOf(ep4.id, ep4.title, [tiedNewer.entry]))).status, 'appended');
  const before5 = await read(ep4.id);
  const tiedRefusal = await applyBackfill(pool, receiptOf(ep4.id, ep4.title, [tiedOlder.entry]));
  assert.deepEqual([tiedRefusal.status, (tiedRefusal as any).rowId], ['refused', tiedNewer.id]);
  assert.equal(await read(ep4.id), before5);
});
