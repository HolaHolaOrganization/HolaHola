/** Episode relabel: selection by projection context, prefix-bounded apply, and the locked transaction. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  NEW_LABEL, OLD_LABEL, buildEpisodeReceipt, episodeReceiptProblem, relabelEpisodeContent, selectEpisodeEdits,
} from '../services/runtime-notice-relabel-episode';
import { applyEpisodeReceipt } from '../../scripts/data-ops/relabel-runtime-notices';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const notice = (n: number) => `${OLD_LABEL} <task-notification>\n<task-id>b${n}</task-id>\n</task-notification>\n\nClaude Code: reply ${n}\n`;
const founder = (n: number) => `${OLD_LABEL} a real founder message ${n}\n\nClaude Code: answer ${n}\n`;
const row = (id: string, content: string) => ({ id, content, preSha256: sha(content) });
/** The gap patcher's projection: "\n" + trimmed row + "\n", appended in order. */
const project = (contents: string[]) => contents.map(c => `\n${c.trim()}\n`).join('');

const n1 = row('n1', notice(1)), n2 = row('n2', notice(2)), n3 = row('n3', notice(3));
const f1 = row('f1', founder(1)), f2 = row('f2', founder(2));
const canonical = [n1, n2, n3, f1, f2];
const episode = '# Episode\n\nNarrative.\n' + project([f1.content, n1.content, n2.content, f2.content]) + '\n## Later heading\n' + project([n3.content]) + 'tail';

test('two-sided projections are included, a run edge goes to review, nothing is inferred from text', () => {
  const s = selectEpisodeEdits(episode, [n1, n2, n3], canonical);
  assert.deepEqual(s.included.map(e => e.sourceRowId), ['n1', 'n2']);
  assert.deepEqual(s.review.map(e => e.sourceRowId), []);
  assert.deepEqual(s.excluded.map(e => [e.sourceRowId, e.reason]), [['n3', 'isolated: no neighbouring canonical frame']]);
  const edge = '# E\n' + project([f1.content, n1.content]) + 'narrative after\n';
  const t = selectEpisodeEdits(edge, [n1], canonical);
  assert.deepEqual([t.included.length, t.review.map(e => e.sourceRowId)], [0, ['n1']]);
  assert.ok(t.review[0].otherSide?.trimStart().startsWith('narrative after'));
});

test('a quoted copy inside a fence, a duplicated row, and a drifted source row are excluded', () => {
  const fenced = '# E\n```\n' + project([f1.content, n1.content, f2.content]) + '```\n';
  assert.equal(selectEpisodeEdits(fenced, [n1], canonical).excluded[0].reason, 'inside a code fence');
  const dup = project([f1.content, n1.content, f2.content, n1.content, f1.content]);
  assert.ok(selectEpisodeEdits(dup, [n1], canonical).excluded.every(e => e.reason === 'row appears more than once in the episode'));
  const drifted = { ...n1, preSha256: '0'.repeat(64) };
  assert.equal(selectEpisodeEdits(episode, [drifted], canonical).excluded[0].reason, 'source row content does not match its receipt hash');
});

function planFor(content: string) {
  const s = selectEpisodeEdits(content, [n1, n2, n3], canonical);
  return buildEpisodeReceipt(content, 'ep-1', 'list-sha', s.included);
}

test('apply changes only the label spans inside [0, L); the tail is untouched', () => {
  const r = planFor(episode);
  assert.equal(episodeReceiptProblem(r, 'ep-1'), null);
  const out = relabelEpisodeContent(episode, r);
  assert.equal(out.status, 'apply');
  if (out.status !== 'apply') return;
  assert.equal(out.next, episode.split(`\n${OLD_LABEL} <task-notification>\n<task-id>b1`).join(`\n${NEW_LABEL} <task-notification>\n<task-id>b1`)
    .split(`\n${OLD_LABEL} <task-notification>\n<task-id>b2`).join(`\n${NEW_LABEL} <task-notification>\n<task-id>b2`));
  assert.ok(out.next.includes(`${OLD_LABEL} a real founder message 1`), 'genuine founder labels stay');
  assert.ok(out.next.endsWith(episode.slice(r.L)), 'tail after L is byte-identical');
  assert.equal(out.next.length, episode.length - 2 * (OLD_LABEL.length - NEW_LABEL.length));
});

test('rerun after shrinking labels and a new tail is a no-op; a changed prefix drifts', () => {
  const r = planFor(episode);
  const out = relabelEpisodeContent(episode, r);
  if (out.status !== 'apply') throw new Error('expected apply');
  assert.deepEqual(relabelEpisodeContent(out.next + '\nappended later\n', r), { status: 'already-applied' });
  assert.equal(relabelEpisodeContent(episode.replace('Narrative.', 'Narrative!'), r).status, 'drifted');
  assert.equal(relabelEpisodeContent(episode + '\nappended before apply\n', r).status, 'apply', 'growth before apply is fine');
});

test('structural receipt checks refuse a forged or inconsistent receipt', () => {
  const r = planFor(episode);
  assert.match(episodeReceiptProblem({ ...r, label: 'Daniela' }, 'ep-1') ?? '', /label/);
  assert.match(episodeReceiptProblem(r, 'ep-other') ?? '', /episode/);
  assert.match(episodeReceiptProblem({ ...r, Lprime: r.Lprime + 1 }, 'ep-1') ?? '', /L'/);
  assert.match(episodeReceiptProblem({ ...r, L: r.L - 1 }, 'ep-1') ?? '', /L is not/);
  assert.match(episodeReceiptProblem({ ...r, edits: [...r.edits].reverse() }, 'ep-1') ?? '', /hash|unsorted/);
});

function fakePool(selected: { content: string; attribution: unknown } | null) {
  const statements: string[] = [];
  let written: string | null = null;
  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          statements.push(sql.split(' ')[0]);
          if (sql.startsWith('UPDATE')) written = params?.[1] as string;
          return { rows: sql.startsWith('SELECT') && selected ? [selected] : [] };
        },
        release() {},
      };
    },
  };
  return { pool, statements, written: () => written };
}

test('the locked transaction applies once, refuses attribution, and refuses an unbound receipt before connecting', async () => {
  const r = planFor(episode);
  const fresh = fakePool({ content: episode, attribution: null });
  assert.equal((await applyEpisodeReceipt(fresh.pool, r, 'list-sha')).status, 'applied');
  assert.deepEqual(fresh.statements, ['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
  const attributed = fakePool({ content: episode, attribution: { turnAttribution: {} } });
  assert.equal((await applyEpisodeReceipt(attributed.pool, r, 'list-sha')).status, 'attributed');
  assert.deepEqual(attributed.statements, ['BEGIN', 'SELECT', 'COMMIT']);
  const unbound = fakePool({ content: episode, attribution: null });
  await assert.rejects(() => applyEpisodeReceipt(unbound.pool, r, 'another-list'));
  assert.deepEqual(unbound.statements, []);
});
