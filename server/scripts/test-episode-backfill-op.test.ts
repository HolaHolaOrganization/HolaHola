// Founder-approved episode backfill (scripts/data-ops/backfill-episode-turns.ts):
// receipt rules, the whole-batch plan (appendable tail, source identity), the
// single-transaction apply, and the verified embedding outcome. Synthetic data;
// the real-PostgreSQL locking proof is server/services/episode-backfill-postgres.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyBackfill, describe as describeOutcome, ensureEmbeddings, runBackfill, type BackfillPool, type EmbeddingDeps,
} from '../../scripts/data-ops/backfill-episode-turns';
import {
  EPISODE_BACKFILL_RECEIPT_KIND, PER_TURN_ARC, PER_TURN_TAG, embeddingCoverage, episodeBackfillReceiptProblem,
  planBackfill, sha256, type EpisodeBackfillEntry, type EpisodeBackfillReceipt, type SourceRow,
} from '../services/episode-backfill';
import { episodeTextForTurn } from '../services/episode-gap-projection';

const EP = 'episode-35';
const TITLE = "Episode 35: Alden's Entry into the Record";
const at = (day: number, minute = 0) => `2026-10-${String(day).padStart(2, '0')} 00:${String(minute).padStart(2, '0')}:00.000000`;
const src = (id: string, day: number, captureId: string | null = `cap-${id}`, extra: Partial<SourceRow> = {}): SourceRow => ({
  id, content: `David [Claude Code]: turn ${id}\n\nClaude Code: reply ${id}`, createdAt: at(day),
  arcName: PER_TURN_ARC, tags: [PER_TURN_TAG, ...(captureId ? [`capture-id:${captureId}`] : [])], ...extra,
});
const entryOf = (row: SourceRow): EpisodeBackfillEntry => {
  const tag = (row.tags ?? []).find((t) => t.startsWith('capture-id:'));
  return { rowId: row.id, captureId: tag ? tag.slice('capture-id:'.length) : null, createdAt: row.createdAt, contentSha256: sha256(row.content) };
};
const receiptOf = (rows: SourceRow[]): EpisodeBackfillReceipt => {
  const entries = rows.map(entryOf);
  return { kind: EPISODE_BACKFILL_RECEIPT_KIND, episodeId: EP, episodeTitle: TITLE, entries, listSha256: sha256(JSON.stringify(entries)) };
};
const projected = (row: SourceRow) => '\n' + episodeTextForTurn({ id: row.id, captureId: entryOf(row).captureId ?? undefined, content: row.content, createdAtMs: 0 }) + '\n';
const mapOf = (rows: SourceRow[]) => new Map(rows.map((r) => [r.id, r]));

const A = src('a', 25), B = src('b', 26), C = src('c', 27);

describe('receipt rules', () => {
  test('a well-formed receipt passes; tampering, repeats, bad hashes, bad times and disorder are refused', () => {
    const good = receiptOf([A, B]);
    assert.equal(episodeBackfillReceiptProblem(good), null);
    assert.match(episodeBackfillReceiptProblem({ ...good, listSha256: '0'.repeat(64) })!, /list hash/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([A, { ...A }]))!, /repeated/);
    const badTime = { ...entryOf(A), createdAt: '2026-10-25T00:00:00Z' };
    assert.match(episodeBackfillReceiptProblem({ ...good, entries: [badTime], listSha256: sha256(JSON.stringify([badTime])) })!, /valid time/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([B, A]))!, /out of order/);
    assert.match(episodeBackfillReceiptProblem({ ...good, kind: 'other' })!, /kind/);
    assert.match(episodeBackfillReceiptProblem(receiptOf([]))!, /no entries/);
  });
});

describe('whole-batch plan', () => {
  test('all missing: appends every turn oldest first with the projection framing, as one text', () => {
    const plan = planBackfill(receiptOf([A, B]), mapOf([A, B]), [], 'opening');
    assert.deepEqual(plan, { status: 'append', text: projected(A) + projected(B), appending: 2, alreadyPresent: 0 });
  });

  test('a present prefix (a re-run after partial success) appends only the rest; all present is complete', () => {
    const plan = planBackfill(receiptOf([A, B]), mapOf([A, B]), [], 'opening' + projected(A));
    assert.deepEqual(plan, { status: 'append', text: projected(B), appending: 1, alreadyPresent: 1 });
    assert.deepEqual(planBackfill(receiptOf([A, B]), mapOf([A, B]), [], 'opening' + projected(A) + projected(B)), { status: 'complete', alreadyPresent: 2 });
  });

  test('LR P1: a newer canonical turn already in the episode refuses the batch (no older-after-newer append)', () => {
    const plan = planBackfill(receiptOf([B]), mapOf([B]), [C], 'opening' + projected(C));
    assert.equal(plan.status, 'refused');
    assert.match((plan as any).reason, /newer canonical turn is already in the episode/);
    assert.equal((plan as any).rowId, 'c');
  });

  test('LR re-review: a newer turn with the SAME timestamp and a later id also refuses', () => {
    const tiedA = src('id-0001', 26), tiedB = src('id-0002', 26);
    const plan = planBackfill(receiptOf([tiedA]), mapOf([tiedA]), [tiedB], 'opening' + projected(tiedB));
    assert.equal(plan.status, 'refused');
    assert.equal((plan as any).rowId, 'id-0002');
    // The same timestamp with an EARLIER id is older, so it does not refuse.
    const earlier = src('id-0000', 26);
    assert.equal(planBackfill(receiptOf([tiedA]), mapOf([tiedA]), [earlier], 'opening' + projected(earlier)).status, 'append');
  });

  test('a later receipt turn present while an earlier one is not is an interior gap', () => {
    const plan = planBackfill(receiptOf([A, B]), mapOf([A, B]), [], 'opening' + projected(B));
    assert.match((plan as any).reason, /later receipt turn is present/);
  });

  test('newer turns that are absent, or not canonical per-turn rows, do not refuse', () => {
    const notPerTurn = src('n', 28, null, { arcName: 'other-arc' });
    assert.equal(planBackfill(receiptOf([A]), mapOf([A]), [C, notPerTurn], 'opening' + projected(notPerTurn)).status, 'append');
  });

  test('LR P2: metadata-only drift (capture id, time, membership) refuses, as does content or a missing row', () => {
    const receipt = receiptOf([A]);
    const cases: [SourceRow | undefined, RegExp][] = [
      [{ ...A, tags: [PER_TURN_TAG, 'capture-id:replacement'] }, /capture id changed/],
      [{ ...A, createdAt: at(25, 9) }, /time changed/],
      [{ ...A, tags: ['capture-id:cap-a'] }, /no longer a canonical per-turn row/],
      [{ ...A, arcName: 'elsewhere' }, /no longer a canonical per-turn row/],
      [{ ...A, content: A.content + ' edited' }, /content changed/],
      [undefined, /missing/],
    ];
    for (const [row, reason] of cases) {
      const plan = planBackfill(receipt, row ? mapOf([row]) : new Map(), [], 'opening');
      assert.equal(plan.status, 'refused');
      assert.match((plan as any).reason, reason);
    }
  });
});

/** Two tables and the transaction protocol, in memory. Records every statement. */
function fakePool(episodeContent: string, rows: SourceRow[], newer: SourceRow[] = []) {
  const db = { episode: { title: TITLE, content: episodeContent, summary: null as string | null } };
  const log: string[] = [];
  let pending: string | null = null;
  const run = async (sql: string, params: unknown[] = []) => {
    log.push(sql.trim().split(/\s+/).slice(0, 2).join(' ') + (sql.includes('FOR UPDATE') ? ' FOR UPDATE' : sql.includes('FOR SHARE') ? ' FOR SHARE' : ''));
    if (sql === 'BEGIN') { pending = null; return { rows: [] }; }
    if (sql === 'COMMIT') { if (pending !== null) db.episode.content = pending; pending = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
    if (sql.includes('FOR UPDATE')) return { rows: params[0] === EP ? [{ title: db.episode.title, content: db.episode.content }] : [] };
    if (sql.includes('FOR SHARE')) return { rows: rows.filter((r) => (params[0] as string[]).includes(r.id)).map((r) => ({ id: r.id, content: r.content, created_at: r.createdAt, arc_name: r.arcName, tags: r.tags })) };
    if (sql.includes('arc_name = $1')) return { rows: newer.map((r) => ({ id: r.id, content: r.content, created_at: r.createdAt, arc_name: r.arcName, tags: r.tags })) };
    if (sql.startsWith('UPDATE')) { pending = db.episode.content + (params[1] as string); return { rows: [] }; }
    if (sql.startsWith('SELECT id, title, summary, content')) return { rows: [{ id: EP, title: db.episode.title, summary: db.episode.summary, content: db.episode.content }] };
    throw new Error(`unexpected sql ${sql}`);
  };
  const pool: BackfillPool = { async connect() { return { query: run, release() {} }; }, query: run };
  return { pool, db, log };
}

describe('single-transaction apply', () => {
  test('appends the whole batch in one UPDATE inside one locked transaction', async () => {
    const { pool, db, log } = fakePool('opening', [A, B, C]);
    assert.deepEqual(await applyBackfill(pool, receiptOf([A, B, C])), { status: 'appended', appended: 3, alreadyPresent: 0 });
    assert.equal(db.episode.content, 'opening' + projected(A) + projected(B) + projected(C));
    assert.deepEqual(log.filter((l) => /^(BEGIN|COMMIT|ROLLBACK|UPDATE)/.test(l) || l.includes('FOR')),
      ['BEGIN', 'SELECT title, FOR UPDATE', 'SELECT id, FOR SHARE', 'UPDATE conversation_memories', 'COMMIT']);
  });

  test('a re-run writes nothing and rolls back; a refusal writes nothing', async () => {
    const ok = fakePool('opening', [A, B]);
    await applyBackfill(ok.pool, receiptOf([A, B]));
    const done = ok.db.episode.content;
    assert.deepEqual(await applyBackfill(ok.pool, receiptOf([A, B])), { status: 'complete', alreadyPresent: 2 });
    assert.equal(ok.db.episode.content, done);
    assert.ok(!ok.log.slice(ok.log.lastIndexOf('BEGIN')).some((l) => l.startsWith('UPDATE')));

    const drifted = fakePool('opening', [A, { ...B, tags: [PER_TURN_TAG, 'capture-id:replacement'] }]);
    const out = await applyBackfill(drifted.pool, receiptOf([A, B]));
    assert.equal(out.status, 'refused');
    assert.equal(drifted.db.episode.content, 'opening');
    assert.equal(drifted.log.at(-1), 'ROLLBACK');
  });

  test('LR P1 through the executor: a newer turn already present refuses before writing', async () => {
    const { pool, db } = fakePool('opening' + projected(C), [B], [C]);
    const out = await applyBackfill(pool, receiptOf([B]));
    assert.equal(out.status, 'refused');
    assert.equal(db.episode.content, 'opening' + projected(C));
  });

  test('LR re-review through the executor: a tied-timestamp newer turn already present refuses', async () => {
    const tiedA = src('id-0001', 26), tiedB = src('id-0002', 26);
    const { pool, db } = fakePool('opening' + projected(tiedB), [tiedA], [tiedB]);
    const out = await applyBackfill(pool, receiptOf([tiedA]));
    assert.deepEqual([out.status, (out as any).rowId], ['refused', 'id-0002']);
    assert.equal(db.episode.content, 'opening' + projected(tiedB));
  });

  test('a renamed episode refuses; a malformed receipt is refused before any connection', async () => {
    const renamed = fakePool('opening', [A]);
    renamed.db.episode.title = 'Episode 36';
    assert.deepEqual(await applyBackfill(renamed.pool, receiptOf([A])), { status: 'refused', reason: 'episode title differs from the receipt' });
    const bad = fakePool('opening', [A]);
    await assert.rejects(applyBackfill(bad.pool, { ...receiptOf([A]), listSha256: '0'.repeat(64) }), /receipt refused/);
    assert.equal(bad.log.length, 0);
  });
});

describe('verified embedding outcome (LR P2)', () => {
  const expected = [{ memoryType: 'conversation_memory', memoryId: EP, contentHash: 'h-full' }, { memoryType: 'conversation_chunk', memoryId: `${EP}:chunk:0`, contentHash: 'h-0' }];
  const deps = (stored: any[], opts: { configured?: boolean; onReembed?: () => void; throws?: boolean } = {}) => {
    let calls = 0;
    const d: EmbeddingDeps = {
      configured: () => opts.configured ?? true,
      expected: async () => expected,
      stored: async () => stored.map((s) => ({ ...s })),
      reembed: async () => { calls++; if (opts.throws) throw new Error('provider down'); opts.onReembed?.(); },
    };
    return { d, calls: () => calls };
  };
  const pool = () => fakePool('opening', []).pool;

  test('already current: no re-embed call', async () => {
    const x = deps(expected.map((e) => ({ ...e })));
    assert.equal(await ensureEmbeddings(pool(), EP, x.d), 'already current');
    assert.equal(x.calls(), 0);
  });

  test('no embedding configuration: blocked, nothing called', async () => {
    const x = deps([], { configured: false });
    assert.match(await ensureEmbeddings(pool(), EP, x.d), /^blocked: no embedding configuration \(missing 2, stale 0, extra 0\)/);
    assert.equal(x.calls(), 0);
  });

  test('a resolved re-embed that changed nothing is FAILED, not done', async () => {
    const x = deps([{ ...expected[0], contentHash: 'old' }]);
    assert.match(await ensureEmbeddings(pool(), EP, x.d), /^failed: re-embed resolved but embeddings are not current \(missing 1, stale 1, extra 0\)/);
    assert.equal(x.calls(), 1);
  });

  test('a re-embed that makes every arm current is updated; one that throws is failed', async () => {
    const stored: any[] = [{ ...expected[0], contentHash: 'old' }, { memoryType: 'conversation_chunk', memoryId: `${EP}:chunk:7`, contentHash: 'orphan' }];
    const x = deps(stored, { onReembed: () => { stored.splice(0, stored.length, ...expected.map((e) => ({ ...e }))); } });
    assert.equal(await ensureEmbeddings(pool(), EP, x.d), 'updated (verified current)');
    assert.match(await ensureEmbeddings(pool(), EP, deps([], { throws: true }).d), /^failed: re-embed threw: provider down/);
  });

  test('coverage counts missing, stale and leftover chunk arms', () => {
    assert.deepEqual(embeddingCoverage(expected, [{ ...expected[0], contentHash: 'x' }, { memoryType: 'conversation_chunk', memoryId: `${EP}:chunk:9`, contentHash: 'y' }], `${EP}:chunk:`),
      { current: false, missing: 1, stale: 1, extra: 1 });
  });

  test('runBackfill: a refused batch never touches embeddings; a completed one reports both', async () => {
    const refused = fakePool('opening', [{ ...A, content: 'changed' }]);
    const r1 = await runBackfill(refused.pool, receiptOf([A]), deps([]).d);
    assert.equal(r1.applied, false);
    assert.match(r1.detail, /REFUSED, nothing written: source row content changed .*embeddings: not checked \(backfill refused\)/);
    const ok = fakePool('opening', [A]);
    const r2 = await runBackfill(ok.pool, receiptOf([A]), deps([], { configured: false }).d);
    assert.equal(r2.applied, true);
    assert.match(r2.detail, /appended 1, already present 0 of 1; embeddings: blocked/);
  });

  test('the detail line for a complete re-run', () => {
    assert.equal(describeOutcome({ status: 'complete', alreadyPresent: 3 }, 3, 'already current'), 'episode backfill: nothing to append, all 3 present; embeddings: already current');
  });
});
