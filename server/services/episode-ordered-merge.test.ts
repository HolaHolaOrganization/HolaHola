/**
 * Ordered merge rules on a fixture shaped like Episode 35: an authored opening,
 * existing turn blocks written by another recorder (their text is not what the
 * projection would write), missing turns before, between and after them, a
 * turn after `until`, and a CI sentinel row. Pure; no database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PER_TURN_ARC, PER_TURN_TAG, sha256, type SourceRow } from './episode-backfill';
import {
  computeOrderedMerge, insertedTextFor, orderedMergeReceipt, parseEpisodeBlocks, planOrderedMergeApply,
  type OrderedMergeReceipt,
} from './episode-ordered-merge';

const t = (minute: number) => `2026-10-26 17:${String(minute).padStart(2, '0')}:00.000000`;
const EPISODE_START = '2026-10-26 17:00:00.000000';
const UNTIL = t(50);

function row(id: string, minute: number, content: string, captureId?: string): SourceRow {
  return { id, content, createdAt: t(minute), arcName: PER_TURN_ARC, tags: captureId ? [PER_TURN_TAG, `capture-id:${captureId}`] : [PER_TURN_TAG] };
}

const opening = '# Episode 99 — "Fixture"\n\n*An opening written by hand, not a turn.*\n\n## Alden, rereading it\n\nWords that must never move.\n\n';
// Existing blocks in the other recorder's own format.
const blockB = '<!-- chat-capture:replit-b -->\n\n**David:** please continue\n\n**LUCA [Replit]:** [felt]: steady.\n\nDone with B.\n';
const blockD = '<!-- chat-capture:replit-d -->\n\n**David:** and D\n\n**LUCA [Replit]:** D reply, ending without a newline.';
const old = opening + blockB + '\n' + blockD;

const A = row('a-row', 5, '  David [Claude Code]: A\n\nClaude Code: reply A  \n', 'cc-a');
const B = row('b-row', 10, 'stored text of B differs from its block', 'replit-b');
const C = row('c-row', 15, 'David [Claude Code]: C\n\nClaude Code: reply C', 'cc-c');
const E = row('e-row', 15, 'David [Claude Code]: E (same time as C, later id)\n\nClaude Code: reply E');
const D = row('d-row', 20, 'stored text of D', 'replit-d');
const F = row('f-row', 40, 'David [Claude Code]: F\n\nClaude Code: reply F', 'cc-f');
const G = row('g-row', 55, 'David [Claude Code]: G after until', 'cc-g');
const SENTINEL = row('s-row', 30, 'CI-TEST-SENTINEL-123 never projected', 'ci-s');
const rows = [G, F, SENTINEL, E, D, C, B, A];

function receiptFor(content = old): OrderedMergeReceipt {
  const merge = computeOrderedMerge(content, rows, EPISODE_START, UNTIL);
  assert.equal(merge.status, 'merge');
  if (merge.status !== 'merge') throw new Error('unreachable');
  return orderedMergeReceipt({ id: 'ep-99', title: 'Episode 99', createdAt: EPISODE_START, content }, UNTIL, merge);
}

test('missing turns are inserted at block boundaries in time order; every existing byte is kept', () => {
  const merge = computeOrderedMerge(old, rows, EPISODE_START, UNTIL);
  assert.equal(merge.status, 'merge');
  if (merge.status !== 'merge') return;
  assert.deepEqual(merge.entries.map((e) => [e.rowId, e.insertBefore]), [['a-row', 0], ['c-row', 1], ['e-row', 1], ['f-row', null]]);
  const expected = opening + insertedTextFor(A) + blockB + '\n' + insertedTextFor(C) + insertedTextFor(E) + blockD + insertedTextFor(F);
  assert.equal(merge.newContent, expected);
  // Removing exactly the inserted spans gives back the old content.
  let stripped = merge.newContent;
  for (const r of [A, C, E, F]) stripped = stripped.replace(insertedTextFor(r), '');
  assert.equal(stripped, old);
  assert.ok(merge.newContent.startsWith(opening));
  // The inserted text is exactly the projection's: trimmed content, marker line first.
  assert.ok(merge.newContent.includes('\n<!-- chat-capture:cc-a -->\nDavid [Claude Code]: A\n\nClaude Code: reply A\n'));
  assert.ok(merge.newContent.includes('\n<!-- canonical-row:e-row -->\n'));
  // G is after until and the sentinel is never projected.
  assert.ok(!merge.newContent.includes('G after until'));
  assert.ok(!merge.newContent.includes('CI-TEST-SENTINEL'));
});

test('apply: the approved receipt merges, and a re-run on the result is complete and writes nothing', () => {
  const receipt = receiptFor();
  const plan = planOrderedMergeApply(receipt, old, rows);
  assert.equal(plan.status, 'merge');
  if (plan.status !== 'merge') return;
  assert.equal(sha256(plan.newContent), receipt.newContentSha256);
  assert.equal(planOrderedMergeApply(receipt, plan.newContent, rows).status, 'complete');
  // The merged content is complete up to until on its own terms too.
  assert.equal(computeOrderedMerge(plan.newContent, rows, EPISODE_START, UNTIL).status, 'complete');
});

test('apply refuses when anything differs from the receipt', () => {
  const receipt = receiptFor();
  const refused = (content: string, rs: SourceRow[], r = receipt) => {
    const plan = planOrderedMergeApply(r, content, rs);
    assert.equal(plan.status, 'refused');
    return plan.status === 'refused' ? plan.reason : '';
  };
  assert.match(refused(old + '\nappended later', rows), /changed since the receipt/);
  assert.match(refused(old, rows.map((x) => (x.id === 'c-row' ? { ...x, content: x.content + ' edited' } : x))), /content changed/);
  // A late commit carrying an old timestamp is not silently skipped.
  const lateOld = row('late-row', 25, 'David [Claude Code]: committed late with an old time', 'cc-late');
  assert.match(refused(old, [...rows, lateOld]), /differ from the receipt/);
  // A tampered receipt fails its own list hash.
  assert.match(refused(old, rows, { ...receipt, entries: receipt.entries.slice(1) }), /list hash/);
});

test('structure: a marker inside a line, an unknown marker, a repeated marker, or out-of-order blocks refuse', () => {
  const reason = (content: string, rs = rows) => {
    const m = computeOrderedMerge(content, rs, EPISODE_START, UNTIL);
    assert.equal(m.status, 'refused');
    return m.status === 'refused' ? m.reason : '';
  };
  assert.match(reason(opening + 'quoted <!-- chat-capture:replit-b --> inline\n' + blockD), /inside a line/);
  assert.match(reason(opening + '<!-- chat-capture:nobody -->\ntext\n'), /resolves to no canonical turn/);
  assert.match(reason(old + '\n' + blockB), /more than once/);
  assert.match(reason(opening + blockD + '\n' + blockB), /not in time order/);
  // A missing turn whose own text quotes a marker on its own line would split a block: refused.
  const quoting = row('q-row', 12, 'David [Claude Code]: look\n<!-- chat-capture:replit-d -->\nquoted', 'cc-q');
  assert.match(reason(old, [...rows, quoting]), /merged content/);
  // An existing block newer than until.
  const blockG = '<!-- chat-capture:cc-g -->\nG\n';
  assert.match(reason(old + '\n' + blockG), /newer than until/);
});

test('parse: opening ends at the first whole-line marker; an episode with no markers is all opening', () => {
  const parsed = parseEpisodeBlocks(old);
  assert.ok(!('problem' in parsed));
  if ('problem' in parsed) return;
  assert.equal(parsed.openingEnd, opening.length);
  assert.deepEqual(parsed.markers.map((m) => m.marker), ['<!-- chat-capture:replit-b -->', '<!-- chat-capture:replit-d -->']);
  const bare = parseEpisodeBlocks(opening);
  assert.ok(!('problem' in bare) && bare.openingEnd === opening.length && bare.markers.length === 0);
  const merge = computeOrderedMerge(opening, rows.filter((r) => r.id !== 'b-row' && r.id !== 'd-row'), EPISODE_START, UNTIL);
  assert.equal(merge.status, 'merge');
  if (merge.status === 'merge') assert.ok(merge.entries.every((e) => e.insertBefore === null));
});
