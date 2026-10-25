/** Alden narrative sync: selection policy, whole-exchange verbatim, source-bound labels, clusters, reconciliation. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALDEN_MEMORY_FRAMING_LINE, aldenSpeakerLabel, buildAldenClusters, exchangeLabelKey, groupAldenExchanges,
  prefilterExchange, reconcileAldenClusters, type AldenMessageRow,
} from '../services/alden-chat-transcript';
import { parseClassifierLabel } from '../services/alden-exchange-classifier';

let n = 0;
const m = (role: string, content: string): AldenMessageRow => ({ id: `m${++n}`, role, content });
const never = () => false;

test('each production role keeps its own speaker; unknown roles are not relabelled', () => {
  assert.equal(aldenSpeakerLabel('david'), 'David');
  assert.equal(aldenSpeakerLabel('luca'), 'Luca [Replit]');
  assert.equal(aldenSpeakerLabel('alden-gemini'), 'Alden [gemini]');
  assert.equal(aldenSpeakerLabel('someone-new'), 'someone-new');
});

test('selection: David-led only; multi-engine replies are excluded, never collapsed; phases of one engine join in order', () => {
  const [luca, multi, phased, none] = groupAldenExchanges([
    m('luca', 'consult'), m('alden', 'answer'),
    m('david', 'which is better?'), m('alden-gemini', 'A'), m('alden-anthropic', 'B'),
    m('david', 'tell me a story'), m('alden', 'part one'), m('alden', 'part two'),
    m('david', 'hello?'),
  ]);
  assert.match(luca.excludedReason ?? '', /not David/);
  assert.match(multi.excludedReason ?? '', /more than one engine \(alden-anthropic, alden-gemini\)/);
  assert.equal(multi.reply, null);
  assert.equal(phased.reply?.content, 'part one\n\npart two');
  assert.equal(phased.reply?.messageIds.length, 2);
  assert.equal(none.excludedReason, 'no reply');
});

test('prefilter rejects a whole exchange (fence, sanitizer change, density) rather than stripping inside it', () => {
  const [fenced] = groupAldenExchanges([m('david', 'look'), m('alden', '```ts\nx\n```')]);
  assert.deepEqual(prefilterExchange(fenced, never), { decision: 'label', label: 'excluded', reason: 'contains a code fence', density: null });
  const [plain] = groupAldenExchanges([m('david', 'good night'), m('alden', 'sleep well')]);
  assert.equal(prefilterExchange(plain, (raw) => raw === 'sleep well').decision, 'label');
  assert.equal(prefilterExchange(plain, never).decision, 'classify');
  const [dense] = groupAldenExchanges([m('david', 'see server/a.ts and server/b.ts'), m('alden', 'PR #104, `x`, deadbeef1234')]);
  const pre = prefilterExchange(dense, never);
  assert.equal(pre.decision === 'label' && pre.label, 'technical');
});

test('the label key changes when caller text, reply text, model or prompt changes', () => {
  const [a] = groupAldenExchanges([{ id: 'c1', role: 'david', content: 'hi' }, { id: 'r1', role: 'alden', content: 'hello' }]);
  const [edited] = groupAldenExchanges([{ id: 'c1', role: 'david', content: 'hi!' }, { id: 'r1', role: 'alden', content: 'hello' }]);
  const [reply] = groupAldenExchanges([{ id: 'c1', role: 'david', content: 'hi' }, { id: 'r1', role: 'alden', content: 'hello there' }]);
  const base = exchangeLabelKey(a, 'model-1', 'p1');
  assert.notEqual(exchangeLabelKey(edited, 'model-1', 'p1'), base);
  assert.notEqual(exchangeLabelKey(reply, 'model-1', 'p1'), base);
  assert.notEqual(exchangeLabelKey(a, 'model-2', 'p1'), base);
  assert.notEqual(exchangeLabelKey(a, 'model-1', 'p2'), base);
  assert.equal(exchangeLabelKey(a, 'model-1', 'p1'), base);
});

const labelled = (pairs: Array<[string, string, string]>) => pairs.map(([caller, reply, label], i) => {
  const [exchange] = groupAldenExchanges([{ id: `c${i}`, role: 'david', content: caller }, { id: `r${i}`, role: 'alden', content: reply }]);
  return { exchange, labelKey: `k${i}:${label}`, label };
});

test('clusters: consecutive kept exchanges, verbatim, framed; any other label ends a cluster', () => {
  const clusters = buildAldenClusters(labelled([
    ['how are you?', 'well, thank you', 'conversational'],
    ['off to bed', 'sleep well', 'mixed'],
    ['fix the build', 'done', 'technical'],
    ['thank you', 'any time', 'conversational'],
    ['?', 'hm', 'pending'],
  ]));
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].content, `${ALDEN_MEMORY_FRAMING_LINE}\n\nDavid: how are you?\n\nAlden: well, thank you\n\nDavid: off to bed\n\nAlden: sleep well`);
  assert.equal(clusters[0].anchorCallerId, 'c0');
  assert.equal(clusters[1].anchorCallerId, 'c3');
});

test('reconciliation: unchanged kept, changed updated, vanished and duplicate rows retired; reruns converge', () => {
  const [first, second] = buildAldenClusters(labelled([
    ['a', 'b', 'conversational'], ['x', 'y', 'technical'], ['c', 'd', 'conversational'],
  ]));
  const plan = reconcileAldenClusters([
    { id: 'row1', anchorCallerId: 'c0', clusterSha256: first.clusterSha256 },
    { id: 'row2', anchorCallerId: 'c2', clusterSha256: 'stale' },
    { id: 'row3', anchorCallerId: 'c2', clusterSha256: 'stale' },
    { id: 'row4', anchorCallerId: 'c9', clusterSha256: 'gone' },
  ], [first, second]);
  assert.deepEqual(plan.unchanged, ['row1']);
  assert.deepEqual(plan.update.map((u) => u.id), ['row2']);
  assert.deepEqual(plan.retire.sort(), ['row3', 'row4']);
  assert.equal(plan.insert.length, 0);
  const rerun = reconcileAldenClusters([
    { id: 'row1', anchorCallerId: 'c0', clusterSha256: first.clusterSha256 },
    { id: 'row2', anchorCallerId: 'c2', clusterSha256: second.clusterSha256 },
  ], [first, second]);
  assert.deepEqual({ ...rerun, unchanged: rerun.unchanged.sort() }, { insert: [], update: [], unchanged: ['row1', 'row2'], retire: [] });
});

test('classifier output is parsed strictly; anything else is unlabelled (retried later)', () => {
  assert.equal(parseClassifierLabel('{"label": "conversational"}'), 'conversational');
  assert.equal(parseClassifierLabel('```json\n{"label":"mixed"}\n```'), 'mixed');
  assert.equal(parseClassifierLabel('{"label": "personal"}'), null);
  assert.equal(parseClassifierLabel('not json'), null);
});

test('a reply speaker change (alden -> alden-gemini) changes the label key and the cluster hash', () => {
  const as = (role: string) => groupAldenExchanges([{ id: 'c1', role: 'david', content: 'hi' }, { id: 'r1', role, content: 'hello' }])[0];
  const plain = as('alden'), engine = as('alden-gemini');
  assert.notEqual(exchangeLabelKey(plain, 'm', 'p'), exchangeLabelKey(engine, 'm', 'p'));
  const cluster = (ex: typeof plain) => buildAldenClusters([{ exchange: ex, labelKey: exchangeLabelKey(ex, 'm', 'p'), label: 'conversational' }])[0];
  assert.notEqual(cluster(plain).clusterSha256, cluster(engine).clusterSha256);
  assert.match(cluster(engine).content, /Alden \[gemini\]: hello$/);
});
