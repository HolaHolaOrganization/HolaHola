/**
 * Episode relabel transaction against the CI job's disposable PostgreSQL:
 * concurrent atomic appends (the episode writers' `content || ...`) never lose
 * a corrected label or any tail, late attribution and prefix drift leave the
 * row untouched, and a rerun is a no-op. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { NEW_LABEL, OLD_LABEL, buildEpisodeReceipt, selectEpisodeEdits } from './runtime-notice-relabel-episode';
import { applyEpisodeReceipt, type RelabelPool } from '../../scripts/data-ops/relabel-runtime-notices';

let pool: any = null;
after(async () => { if (pool) await pool.end(); });

const sha = async (t: string) => (await import('node:crypto')).createHash('sha256').update(t, 'utf8').digest('hex');
const notice = (n: number) => `${OLD_LABEL} <task-notification>\n<task-id>pg${n}</task-id>\n</task-notification>\n\nClaude Code: reply ${n}\n`;
const founder = (n: number) => `${OLD_LABEL} founder words ${n}\n\nClaude Code: answer ${n}\n`;
const project = (contents: string[]) => contents.map(c => `\n${c.trim()}\n`).join('');

async function fixture() {
  const rows = [founder(1), notice(1), notice(2), founder(2), notice(3), founder(3)].map((content, i) => ({ id: `r${i}`, content }));
  const approved = await Promise.all(rows.filter(r => r.content.includes('<task-notification>')).map(async r => ({ ...r, preSha256: await sha(r.content) })));
  const content = '# Synthetic episode\n' + project(rows.map(r => r.content)) + 'tail before\n';
  const selection = selectEpisodeEdits(content, approved, rows);
  assert.equal(selection.included.length, 3);
  const entries = await Promise.all(approved.map(async r => ({
    rowId: r.id, preSha256: r.preSha256, projectionFrameSha256: await sha(`\n${r.content.trim()}\n`), projectionLength: r.content.trim().length,
  })));
  const rowsReceipt = { listSha256: await sha(JSON.stringify(entries)), entries };
  return { content, selection, rowsReceipt };
}

async function insertEpisode(client: any, content: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into conversation_memories (id, title, summary, content, tags) values ($1, 'relabel episode test', 'relabel episode test', $2, $3)`,
    [id, content, ['relabel-episode-test']],
  );
  return id;
}

/** A pool whose clients pause right after the locking SELECT until `release` is called. */
function pausingPool(inner: any) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let reachedLock!: () => void;
  const locked = new Promise<void>(r => { reachedLock = r; });
  const wrapped: RelabelPool = {
    async connect() {
      const client = await inner.connect();
      return {
        async query(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params);
          if (sql.startsWith('SELECT') && sql.includes('FOR UPDATE')) { reachedLock(); await gate; }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  return { wrapped, release: () => release(), locked };
}

test('episode relabel: concurrent appends, late attribution, drift and rerun', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    if (process.env.CI === 'true') throw new Error('CI requires a verified disposable database for the episode relabel gate');
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 30 });
  const { content, selection, rowsReceipt } = await fixture();
  const read = async (id: string) => (await pool.query('select content from conversation_memories where id = $1', [id])).rows[0].content as string;
  const append = (id: string, text: string) => pool.query('update conversation_memories set content = content || $2 where id = $1', [id, text]);

  // 1. Appends fired while the relabel holds the row lock all land after it.
  const id = await insertEpisode(pool, content);
  const receipt = buildEpisodeReceipt(content, id, rowsReceipt.listSha256, selection.included);
  const paused = pausingPool(pool);
  const applying = applyEpisodeReceipt(paused.wrapped, receipt, rowsReceipt, id);
  await paused.locked;
  const appends = Array.from({ length: 20 }, (_, i) => append(id, `\nappend ${i}\n`));
  await new Promise(r => setTimeout(r, 200));
  paused.release();
  assert.equal((await applying).status, 'applied');
  await Promise.all(appends);
  const after1 = await read(id);
  assert.equal(after1.split(`${NEW_LABEL} <task-notification>`).length - 1, 3, 'all three labels corrected');
  assert.equal(after1.split(`${OLD_LABEL} founder words`).length - 1, 3, 'founder labels untouched');
  for (let i = 0; i < 20; i++) assert.equal(after1.split(`\nappend ${i}\n`).length - 1, 1, `append ${i} kept exactly once`);
  assert.ok(after1.includes('tail before'), 'original tail kept');

  // 2. A rerun after the shrinking labels and new appends is a no-op.
  assert.equal((await applyEpisodeReceipt(pool, receipt, rowsReceipt, id)).status, 'already-applied');
  assert.equal(await read(id), after1);

  // 3. An append holding the lock first is preserved, then the relabel applies.
  const id2 = await insertEpisode(pool, content);
  const receipt2 = buildEpisodeReceipt(content, id2, rowsReceipt.listSha256, selection.included);
  const holder = await pool.connect();
  await holder.query('begin');
  await holder.query('update conversation_memories set content = content || $2 where id = $1', [id2, '\nfirst writer\n']);
  const applying2 = applyEpisodeReceipt(pool, receipt2, rowsReceipt, id2);
  await new Promise(r => setTimeout(r, 200));
  await holder.query('commit');
  holder.release();
  assert.equal((await applying2).status, 'applied');
  const after2 = await read(id2);
  assert.ok(after2.endsWith('tail before\n\nfirst writer\n'));
  assert.equal(after2.split(`${NEW_LABEL} <task-notification>`).length - 1, 3);

  // 4. Late attribution and prefix drift leave the row untouched.
  const id3 = await insertEpisode(pool, content);
  await pool.query(`update conversation_memories set attribution = '{"turnAttribution":{}}'::jsonb where id = $1`, [id3]);
  assert.equal((await applyEpisodeReceipt(pool, buildEpisodeReceipt(content, id3, rowsReceipt.listSha256, selection.included), rowsReceipt, id3)).status, 'attributed');
  assert.equal(await read(id3), content);
  const id4 = await insertEpisode(pool, content);
  const receipt4 = buildEpisodeReceipt(content, id4, rowsReceipt.listSha256, selection.included);
  await pool.query(`update conversation_memories set content = replace(content, '# Synthetic episode', '# Edited episode') where id = $1`, [id4]);
  assert.equal((await applyEpisodeReceipt(pool, receipt4, rowsReceipt, id4)).status, 'drifted');
  assert.ok((await read(id4)).includes(`${OLD_LABEL} <task-notification>`));

  await pool.query(`delete from conversation_memories where 'relabel-episode-test' = any(tags)`);
});
