// Founder-approved episode backfill (scripts/data-ops/backfill-episode-turns.ts):
// receipt rules, per-entry decisions, and the locked, ordered, fail-closed apply.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyBackfill, describe as describeCounts, type BackfillPool } from '../../scripts/data-ops/backfill-episode-turns';
import {
  EPISODE_BACKFILL_RECEIPT_KIND, decideEntry, episodeBackfillReceiptProblem, sha256,
  type EpisodeBackfillEntry, type EpisodeBackfillReceipt,
} from '../services/episode-backfill';
import { episodeTextForTurn, turnEpisodeMarker } from '../services/episode-gap-projection';

const EP = 'episode-35';
const TITLE = "Episode 35: Alden's Entry into the Record";
const turns: Record<string, string> = {
  a: 'David [Claude Code]: first\n\nClaude Code: one',
  b: 'David [Claude Code]: second\n\nClaude Code: two',
  c: 'David [Claude Code]: third\n\nClaude Code: three',
};
const entry = (id: string, minute: number, captureId: string | null = `cap-${id}`): EpisodeBackfillEntry =>
  ({ rowId: id, captureId, createdAt: new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString(), contentSha256: sha256(turns[id]) });
const receiptOf = (entries: EpisodeBackfillEntry[]): EpisodeBackfillReceipt =>
  ({ kind: EPISODE_BACKFILL_RECEIPT_KIND, episodeId: EP, episodeTitle: TITLE, entries, listSha256: sha256(JSON.stringify(entries)) });

/** In-memory stand-in for the two tables and the transaction protocol. */
function fakePool(episodeContent: string, rows: Record<string, string | undefined> = turns) {
  const db = { episode: { title: TITLE, content: episodeContent }, rows: { ...rows } as Record<string, string | undefined> };
  const log: string[] = [];
  let pending: string | null = null;
  const pool: BackfillPool = {
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          log.push(sql.split(' ')[0] + (sql.includes('FOR UPDATE') ? ' FOR UPDATE' : ''));
          if (sql === 'BEGIN') { pending = null; return { rows: [] }; }
          if (sql === 'COMMIT') { if (pending !== null) db.episode.content = pending; pending = null; return { rows: [] }; }
          if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
          if (sql.includes('FOR UPDATE')) return { rows: params[0] === EP ? [{ ...db.episode, content: pending ?? db.episode.content }] : [] };
          if (sql.startsWith('SELECT content')) { const c = db.rows[params[0] as string]; return { rows: c === undefined ? [] : [{ content: c }] }; }
          if (sql.startsWith('UPDATE')) { pending = (pending ?? db.episode.content) + (params[1] as string); return { rows: [] }; }
          throw new Error(`unexpected sql ${sql}`);
        },
        release() {},
      };
    },
  };
  return { pool, db, log };
}

describe('receipt rules', () => {
  test('a well-formed receipt passes; a tampered list, repeat, bad hash or disorder is refused', () => {
    const good = receiptOf([entry('a', 1), entry('b', 2)]);
    assert.equal(episodeBackfillReceiptProblem(good), null);
    assert.match(episodeBackfillReceiptProblem({ ...good, listSha256: '0'.repeat(64) })!, /list hash/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([entry('a', 1), entry('a', 2)]))!, /repeated/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([{ ...entry('a', 1), contentSha256: 'x' }]))!, /content hash/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([entry('b', 2), entry('a', 1)]))!, /out of order/);
    assert.match(episodeBackfillReceiptProblem({ ...good, kind: 'other' })!, /kind/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([]))!, /no entries/);
  });
});

describe('per-entry decision', () => {
  test('an absent turn is appended with exactly the projection framing', () => {
    const e = entry('a', 1);
    const out = decideEntry(e, { content: turns.a }, 'opening');
    assert.equal(out.status, 'append');
    assert.equal((out as any).text, '\n' + episodeTextForTurn({ id: 'a', captureId: 'cap-a', content: turns.a, createdAtMs: 0 }) + '\n');
    assert.ok((out as any).text.includes(turnEpisodeMarker({ id: 'a', captureId: 'cap-a' })));
  });

  test('a present turn, a missing row and a changed row are never appended', () => {
    const e = entry('a', 1);
    assert.equal(decideEntry(e, { content: turns.a }, `x\n${episodeTextForTurn({ id: 'a', captureId: 'cap-a', content: turns.a, createdAtMs: 0 })}`).status, 'present');
    assert.equal(decideEntry(e, null, 'x').status, 'missing-row');
    assert.equal(decideEntry(e, { content: turns.a + ' edited' }, 'x').status, 'drifted');
  });
});

describe('locked, ordered, fail-closed apply', () => {
  test('appends every absent turn oldest first, each in its own locked transaction', async () => {
    const { pool, db, log } = fakePool('opening');
    const counts = await applyBackfill(pool, receiptOf([entry('a', 1), entry('b', 2), entry('c', 3)]));
    assert.deepEqual(counts, { appended: 3, present: 0, stoppedAt: null, stopReason: null });
    assert.ok(db.episode.content.indexOf('one') < db.episode.content.indexOf('two'));
    assert.ok(db.episode.content.indexOf('two') < db.episode.content.indexOf('three'));
    assert.equal(log.filter((l) => l === 'SELECT FOR UPDATE').length, 3);
    assert.equal(log.filter((l) => l === 'COMMIT').length, 3);
  });

  test('a second run appends nothing (idempotent)', async () => {
    const { pool, db } = fakePool('opening');
    const receipt = receiptOf([entry('a', 1), entry('b', 2)]);
    await applyBackfill(pool, receipt);
    const after = db.episode.content;
    const again = await applyBackfill(pool, receipt);
    assert.deepEqual([again.appended, again.present, again.stoppedAt], [0, 2, null]);
    assert.equal(db.episode.content, after);
  });

  test('a changed row stops the run: nothing after it is appended, and nothing is forced', async () => {
    const { pool, db } = fakePool('opening', { ...turns, b: turns.b + ' edited later' });
    const counts = await applyBackfill(pool, receiptOf([entry('a', 1), entry('b', 2), entry('c', 3)]));
    assert.deepEqual(counts, { appended: 1, present: 0, stoppedAt: 'b', stopReason: 'drifted' });
    assert.ok(db.episode.content.includes('one'));
    assert.ok(!db.episode.content.includes('two') && !db.episode.content.includes('three'));
  });

  test('a missing row or a renamed episode also stops before writing', async () => {
    const missing = fakePool('opening', { a: turns.a, b: undefined, c: turns.c });
    assert.equal((await applyBackfill(missing.pool, receiptOf([entry('a', 1), entry('b', 2), entry('c', 3)]))).stopReason, 'missing-row');
    const renamed = fakePool('opening');
    renamed.db.episode.title = 'Episode 36';
    const c = await applyBackfill(renamed.pool, receiptOf([entry('a', 1)]));
    assert.deepEqual([c.appended, c.stopReason], [0, 'episode title differs from the receipt']);
    assert.equal(renamed.db.episode.content, 'opening');
  });

  test('a malformed receipt is refused before any connection is opened', async () => {
    const { pool, log } = fakePool('opening');
    await assert.rejects(applyBackfill(pool, { ...receiptOf([entry('a', 1)]), listSha256: '0'.repeat(64) }), /receipt refused/);
    assert.equal(log.length, 0);
  });

  test('the detail line names a stop and the re-embed outcome', () => {
    assert.match(describeCounts({ appended: 1, present: 0, stoppedAt: 'b', stopReason: 'drifted' }, 3, 'skipped'), /STOPPED at b \(drifted\)/);
    assert.match(describeCounts({ appended: 3, present: 0, stoppedAt: null, stopReason: null }, 3, 'done'), /appended 3, already present 0 of 3; re-embed: done/);
  });
});
