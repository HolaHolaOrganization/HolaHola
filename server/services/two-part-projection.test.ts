import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, truncateSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendCanonicalConversationExchange,
  appendCanonicalTwoPartExchange,
  decideTimedOutTwoPartExchanges,
  indexTwoPartExchanges,
  twoPartExchangesEnabled,
  twoPartIntakeRefusal,
  twoPartReplyTimeoutMs,
  validateOccurredAt,
} from './canonical-conversation-capture';
import { appendChatCaptureEntriesAtomic, parseChatCaptureFromOffset } from './transcript-parser';
import {
  applyTwoPartEffect,
  buildTwoPartRow,
  planNextTwoPartStep,
  type TwoPartEffectStore,
  type TwoPartRow,
  type TwoPartStep,
} from './two-part-projection';

// Every test uses its own temporary capture log and lock: no workspace file,
// database, network or live capture is touched.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'a2-two-part-'));
  return {
    dir,
    capturePath: join(dir, 'chat_capture'),
    ingressLockPath: join(dir, 'ingress.lock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Receipt time (the TIME header) is the real clock, so the test clock starts now.
const T0 = Date.now();
const OCCURRED = new Date(T0 - 30_000).toISOString();
const HOUR = 60 * 60 * 1000;

function part(f: ReturnType<typeof fixture>, p: 'user' | 'assistant', turnId: string, text: string, nowMs = T0, extra: object = {}) {
  return appendCanonicalTwoPartExchange({
    source: 'antigravity', part: p, turnId, text,
    ...(p === 'user' ? { occurredAt: OCCURRED } : {}),
    capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs, ...extra,
  });
}

/** Run the planner over the whole log, as the autosave loop does. */
function planAll(capturePath: string, fromOffset = 0): TwoPartStep[] {
  const parsed = parseChatCaptureFromOffset(capturePath, fromOffset);
  const index = indexTwoPartExchanges(capturePath);
  let turns = parsed.turns, offsets = parsed.turnByteOffsets, records = parsed.records;
  const steps: TwoPartStep[] = [];
  for (;;) {
    const step = planNextTwoPartStep(turns, offsets, records, index);
    if (!step) return steps;
    steps.push(step);
    if (step.kind === 'legacy') {
      turns = turns.slice(step.count); offsets = offsets.slice(step.count);
    } else if (step.kind === 'part' || step.effect.outcome === 'late-reply') {
      turns = turns.slice(1); offsets = offsets.slice(1);
    } else {
      records = records.slice(1);
    }
  }
}

function memoryStore() {
  const rows: TwoPartRow[] = [];
  const store: TwoPartEffectStore = {
    hasRow: async tag => rows.some(row => row.identityTag === tag),
    insertRow: async row => { rows.push(row); },
  };
  return { rows, store };
}

test('intake is off by default and the timeout has a conservative floor', () => {
  assert.equal(twoPartExchangesEnabled({}), false);
  assert.equal(twoPartExchangesEnabled({ CANONICAL_TWO_PART_EXCHANGES: 'true' }), false);
  assert.equal(twoPartExchangesEnabled({ CANONICAL_TWO_PART_EXCHANGES: 'on' }), true);
  assert.equal(twoPartReplyTimeoutMs({}), 6 * HOUR);
  assert.equal(twoPartReplyTimeoutMs({ CANONICAL_TWO_PART_REPLY_TIMEOUT_MS: '1000' }), 6 * HOUR);
  assert.equal(twoPartReplyTimeoutMs({ CANONICAL_TWO_PART_REPLY_TIMEOUT_MS: '120000' }), 120_000);
});

test('occurredAt must be a zoned ISO time inside the accepted range', () => {
  assert.equal(validateOccurredAt(OCCURRED, T0), OCCURRED);
  for (const bad of [undefined, '', '2026-10-27T04:59:30', '2023-12-31T23:59:59Z', new Date(T0 + 10 * 60_000).toISOString(), 'yesterday']) {
    assert.throws(() => validateOccurredAt(bad, T0), /occurredAt/);
  }
});

test('user part is durable alone; identical retry is a no-op; changed retry is refused', () => {
  const f = fixture();
  try {
    const first = part(f, 'user', 'ag-1', 'hola');
    assert.equal(first.appended, true);
    assert.equal(first.decision, null);
    const bytes = readFileSync(f.capturePath);
    const retry = part(f, 'user', 'ag-1', 'hola');
    assert.equal(retry.appended, false);
    assert.deepEqual(readFileSync(f.capturePath), bytes);
    assert.throws(() => part(f, 'user', 'ag-1', 'hola!'), /different user part/);
    assert.throws(() => part(f, 'user', 'ag-1', 'hola', T0, { occurredAt: '2026-10-27T04:00:00Z' }), /different user part/);
    const parsed = parseChatCaptureFromOffset(f.capturePath, 0);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].exchangePart, 'user');
    assert.equal(parsed.turns[0].occurredAt, OCCURRED);
    assert.equal(parsed.turns[0].receivedAt?.length ? true : false, true);
    assert.equal(parsed.records.length, 0);
  } finally { f.cleanup(); }
});

test('assistant part cannot come first and is written together with its pair decision', () => {
  const f = fixture();
  try {
    assert.throws(() => part(f, 'assistant', 'ag-2', 'reply'), /no user part/);
    part(f, 'user', 'ag-2', 'question');
    const reply = part(f, 'assistant', 'ag-2', 'reply', T0 + 1000);
    assert.equal(reply.decision, 'pair');
    assert.equal(reply.late, false);
    const parsed = parseChatCaptureFromOffset(f.capturePath, 0);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].outcome, 'pair');
    // The decision block ends the file: nothing can sit between part and decision.
    assert.equal(parsed.records[0].byteOffsetAfter, readFileSync(f.capturePath).length);
    const retry = part(f, 'assistant', 'ag-2', 'reply', T0 + 2000);
    assert.equal(retry.appended, false);
    assert.throws(() => part(f, 'assistant', 'ag-2', 'other reply'), /different assistant part/);
    assert.equal(parseChatCaptureFromOffset(f.capturePath, 0).records.length, 1);
  } finally { f.cleanup(); }
});

test('two-part and atomic identities never share an id, and sources never mix', () => {
  const f = fixture();
  try {
    appendCanonicalConversationExchange({
      source: 'claude-code', turnId: 'atomic-1', userText: 'u', assistantText: 'a',
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath,
    });
    assert.throws(() => part(f, 'user', 'atomic-1', 'u'), /atomic pair/);
    part(f, 'user', 'ag-3', 'u');
    assert.throws(() => appendCanonicalConversationExchange({
      source: 'antigravity', turnId: 'ag-3', userText: 'u', assistantText: 'a',
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath,
    }), /two-part exchange/);
    assert.throws(() => appendCanonicalTwoPartExchange({
      source: 'claude-code', part: 'assistant', turnId: 'ag-3', text: 'a',
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0,
    }), /different source/);
  } finally { f.cleanup(); }
});

test('timeout sweep records reply-absent once, only after the timeout', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-4', 'are you there?');
    const opts = { capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, timeoutMs: HOUR };
    assert.deepEqual(decideTimedOutTwoPartExchanges({ ...opts, nowMs: T0 + HOUR - 2_000 }), []);
    assert.deepEqual(decideTimedOutTwoPartExchanges({ ...opts, nowMs: T0 + HOUR + 5_000 }), ['ag-4']);
    assert.deepEqual(decideTimedOutTwoPartExchanges({ ...opts, nowMs: T0 + 2 * HOUR }), []);
    const records = parseChatCaptureFromOffset(f.capturePath, 0).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'reply-absent');
  } finally { f.cleanup(); }
});

test('a busy ingress lock makes the sweep return null without writing', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-5', 'u');
    // A lock held by a live process (this one) is never stolen.
    appendFileSync(f.ingressLockPath, String(process.pid));
    const bytes = readFileSync(f.capturePath);
    assert.equal(decideTimedOutTwoPartExchanges({
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR,
    }), null);
    assert.deepEqual(readFileSync(f.capturePath), bytes);
  } finally { f.cleanup(); }
});

test('crash winner: once reply-absent is recorded, a late reply never flips the outcome', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-6', 'question');
    decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR });
    const late = part(f, 'assistant', 'ag-6', 'sorry, late', T0 + 8 * HOUR);
    assert.equal(late.decision, 'reply-absent');
    assert.equal(late.late, true);
    const entry = indexTwoPartExchanges(f.capturePath).get('ag-6')!;
    assert.equal(entry.decision?.outcome, 'reply-absent');
    assert.equal(parseChatCaptureFromOffset(f.capturePath, 0).records.length, 1);
    // A sweep after the late reply decides nothing new.
    assert.deepEqual(decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 9 * HOUR, timeoutMs: HOUR }), []);
  } finally { f.cleanup(); }
});

test('crash winner, other order: a reply decided as pair is never swept', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-7', 'question');
    part(f, 'assistant', 'ag-7', 'answer', T0 + 7 * HOUR);
    assert.deepEqual(decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 8 * HOUR, timeoutMs: HOUR }), []);
    assert.equal(indexTwoPartExchanges(f.capturePath).get('ag-7')!.decision?.outcome, 'pair');
  } finally { f.cleanup(); }
});

test('planner: parts have no effect at their own position; effects sit at decisions', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-8', 'first question');
    // An unrelated atomic pair from another source lands while ag-8 waits.
    appendCanonicalConversationExchange({
      source: 'claude-code', turnId: 'cc-1', userText: 'cc u', assistantText: 'cc a',
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath,
    });
    part(f, 'assistant', 'ag-8', 'first answer', T0 + 1000);
    const steps = planAll(f.capturePath);
    assert.deepEqual(steps.map(s => s.kind === 'effect' ? `effect:${s.effect.outcome}` : s.kind === 'legacy' ? `legacy:${s.count}` : `part:${s.turn.exchangePart}`),
      ['part:user', 'legacy:2', 'part:assistant', 'effect:pair']);
    const pair = steps[3] as Extract<TwoPartStep, { kind: 'effect' }>;
    assert.deepEqual(pair.effect.turns.map(t => t.text), ['first question', 'first answer']);
    assert.equal(pair.effect.identity, 'two-part:ag-8');
    // Offsets are strictly increasing, so the cursor only moves forward.
    const offsets = steps.filter(s => s.kind !== 'legacy').map(s => s.kind === 'effect' ? s.effect.offset : (s as any).offset);
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
  } finally { f.cleanup(); }
});

test('planner: reply-absent and late reply each get one effect with distinct identities', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-9', 'hello?');
    decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR });
    part(f, 'assistant', 'ag-9', 'here now', T0 + 8 * HOUR);
    const effects = planAll(f.capturePath).filter((s): s is Extract<TwoPartStep, { kind: 'effect' }> => s.kind === 'effect');
    assert.deepEqual(effects.map(e => [e.effect.outcome, e.effect.identity]), [['reply-absent', 'two-part:ag-9'], ['late-reply', 'two-part-late:ag-9']]);
    const absent = buildTwoPartRow(effects[0].effect);
    assert.ok(absent.tags.includes('reply-absent'));
    assert.match(absent.content, /hello\?/);
    assert.doesNotMatch(absent.content, /here now/);
    const late = buildTwoPartRow(effects[1].effect);
    assert.ok(late.tags.includes('late-reply') && late.tags.includes('reply-to:ag-9'));
    assert.equal(late.identityTag, 'two-part-late:ag-9');
  } finally { f.cleanup(); }
});

test('planner resumes correctly from a cursor between a part and its decision', () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-10', 'q');
    const afterUser = readFileSync(f.capturePath).length;
    part(f, 'assistant', 'ag-10', 'a', T0 + 1000);
    // The user part is behind the cursor; the index still supplies its text.
    const steps = planAll(f.capturePath, afterUser);
    const pair = steps.find((s): s is Extract<TwoPartStep, { kind: 'effect' }> => s.kind === 'effect')!;
    assert.deepEqual(pair.effect.turns.map(t => t.text), ['q', 'a']);
  } finally { f.cleanup(); }
});

test('fault windows: replay after a crash at any point inserts each row exactly once', async () => {
  const f = fixture();
  try {
    part(f, 'user', 'ag-11', 'q1');
    part(f, 'assistant', 'ag-11', 'a1', T0 + 1000);
    part(f, 'user', 'ag-12', 'q2');
    decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR });
    part(f, 'assistant', 'ag-12', 'a2 late', T0 + 8 * HOUR);
    const effects = planAll(f.capturePath).filter((s): s is Extract<TwoPartStep, { kind: 'effect' }> => s.kind === 'effect').map(s => s.effect);
    assert.equal(effects.length, 3);
    // Crash after the insert but before the cursor save, at every effect:
    // the cursor never passed it, so the effect is retried and deduplicated.
    for (let crashAt = 0; crashAt < effects.length; crashAt++) {
      const { rows, store } = memoryStore();
      let cursor = 0;
      for (let i = 0; i < effects.length; i++) {
        await applyTwoPartEffect(effects[i], store);
        if (i === crashAt) break; // crash: cursor not saved
        cursor = effects[i].offset;
      }
      for (const effect of effects.filter(e => e.offset > cursor)) {
        await applyTwoPartEffect(effect, store);
      }
      assert.deepEqual(rows.map(r => r.identityTag).sort(),
        ['two-part-late:ag-12', 'two-part:ag-11', 'two-part:ag-12']);
    }
    // A full second replay from zero inserts nothing.
    const { rows, store } = memoryStore();
    for (const e of effects) await applyTwoPartEffect(e, store);
    for (const e of effects) assert.equal(await applyTwoPartEffect(e, store), false);
    assert.equal(rows.length, 3);
  } finally { f.cleanup(); }
});

test('rows are never truncated, whatever the length', () => {
  const f = fixture();
  try {
    const long = 'x'.repeat(200_000);
    part(f, 'user', 'ag-13', long);
    part(f, 'assistant', 'ag-13', long, T0 + 1000);
    const pair = planAll(f.capturePath).find((s): s is Extract<TwoPartStep, { kind: 'effect' }> => s.kind === 'effect')!;
    const row = buildTwoPartRow(pair.effect);
    assert.ok(row.content.includes(long + '\n'));
    assert.equal(row.content.split(long).length - 1, 2);
    assert.doesNotMatch(row.content, /truncated/);
    assert.match(row.summary, new RegExp(`occurred at ${OCCURRED}`));
  } finally { f.cleanup(); }
});

test('impossible states fail loudly instead of being guessed', () => {
  const f = fixture();
  try {
    // A pair decision with no assistant part before it.
    part(f, 'user', 'ag-14', 'q');
    appendFileSync(f.capturePath, [
      '---TURN-START---', 'RECORD: exchange-resolved', 'SOURCE: antigravity', `TIME: ${new Date(T0).toISOString()}`,
      'CAPTURE-ID: ag-14', 'OUTCOME: pair', 'CHARLEN: 0', '---', '', '---TURN-END---', '',
    ].join('\n'));
    assert.throws(() => planAll(f.capturePath), /not preceded by its assistant part/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    part(g, 'user', 'ag-15', 'q');
    appendFileSync(g.capturePath, [
      '---TURN-START---', 'RECORD: exchange-resolved', 'SOURCE: antigravity', 'CAPTURE-ID: ag-15', 'CHARLEN: 0', '---', '', '---TURN-END---', '',
    ].join('\n'));
    assert.throws(() => parseChatCaptureFromOffset(g.capturePath, 0), /malformed exchange-resolved record/);
  } finally { g.cleanup(); }
});

test('intake refuses while disabled and while live episode mode is on', () => {
  const f = fixture();
  try {
    const sentinel = join(f.dir, 'episode_live');
    assert.equal(twoPartIntakeRefusal({}, sentinel), 'disabled');
    assert.equal(twoPartIntakeRefusal({ CANONICAL_TWO_PART_EXCHANGES: 'on' }, sentinel), null);
    appendFileSync(sentinel, '');
    assert.equal(twoPartIntakeRefusal({ CANONICAL_TWO_PART_EXCHANGES: 'on' }, sentinel), 'live-mode');
    assert.equal(twoPartIntakeRefusal({}, sentinel), 'disabled');
  } finally { f.cleanup(); }
});

function rawDecision(id: string, outcome: 'pair' | 'reply-absent'): string {
  return [
    '---TURN-START---', 'RECORD: exchange-resolved', 'SOURCE: antigravity', `TIME: ${new Date(T0).toISOString()}`,
    `CAPTURE-ID: ${id}`, `OUTCOME: ${outcome}`, 'CHARLEN: 0', '---', '', '---TURN-END---', '',
  ].join('\n');
}

async function projectAll(capturePath: string) {
  const effects = planAll(capturePath).filter((s): s is Extract<TwoPartStep, { kind: 'effect' }> => s.kind === 'effect').map(s => s.effect);
  const { rows, store } = memoryStore();
  const inserted: boolean[] = [];
  for (const e of effects) inserted.push(await applyTwoPartEffect(e, store));
  return { effects, rows, inserted };
}

test('A2-ID: a late reply and an exchange whose id ends in -late never share a row identity, in either order', async () => {
  for (const order of ['late-first', 'late-second'] as const) {
    const f = fixture();
    try {
      const probeLate = () => { part(f, 'user', 'probe-late', 'question 2'); part(f, 'assistant', 'probe-late', 'reply 2', T0 + 1000); };
      if (order === 'late-first') probeLate();
      part(f, 'user', 'probe', 'question 1');
      decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR });
      part(f, 'assistant', 'probe', 'late reply 1', T0 + 8 * HOUR);
      if (order === 'late-second') probeLate();
      const { rows, inserted } = await projectAll(f.capturePath);
      assert.deepEqual(inserted, [true, true, true], order);
      assert.equal(new Set(rows.map(r => r.identityTag)).size, 3);
      const all = rows.map(r => r.content).join('\n');
      for (const text of ['question 1', 'late reply 1', 'question 2', 'reply 2']) assert.ok(all.includes(text), `${order}: ${text}`);
    } finally { f.cleanup(); }
  }
});

test('A2-ID: two-part identities live outside the atomic capture-id namespace', async () => {
  const f = fixture();
  try {
    // An atomic neighbour whose id equals what the old scheme derived for a late reply.
    appendCanonicalConversationExchange({
      source: 'claude-code', turnId: 'probe-late', userText: 'atomic u', assistantText: 'atomic a',
      capturePath: f.capturePath, ingressLockPath: f.ingressLockPath,
    });
    part(f, 'user', 'probe', 'q');
    decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 7 * HOUR, timeoutMs: HOUR });
    part(f, 'assistant', 'probe', 'late', T0 + 8 * HOUR);
    const { rows } = await projectAll(f.capturePath);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(!row.identityTag.startsWith('capture-id:'), row.identityTag);
      assert.ok(!row.tags.some(tag => tag.startsWith('capture-id:')), row.tags.join(','));
      assert.ok(row.tags.includes('exchange-id:probe'));
    }
  } finally { f.cleanup(); }
});

/** A real pair append, then the file cut at `cut(assistantOffset, fullSize)`. */
function tornFixture(cut: (assistantOffset: number, full: number) => number) {
  const f = fixture();
  part(f, 'user', 'torn', 'question');
  part(f, 'assistant', 'torn', 'answer', T0 + 1000);
  const assistantOffset = indexTwoPartExchanges(f.capturePath).get('torn')!.assistantOffset!;
  truncateSync(f.capturePath, cut(assistantOffset, statSync(f.capturePath).size));
  return f;
}

test('A2-REC: an assistant part cut off from its decision fails closed, then an identical retry repairs it', async () => {
  const f = tornFixture(a => a);
  try {
    const entry = indexTwoPartExchanges(f.capturePath).get('torn')!;
    assert.ok(entry.assistant && !entry.decision);
    assert.throws(() => planAll(f.capturePath), /torn write/);
    assert.throws(() => part(f, 'assistant', 'torn', 'different'), /different assistant part/);
    const repaired = part(f, 'assistant', 'torn', 'answer', T0 + 2000);
    assert.deepEqual([repaired.appended, repaired.decision, repaired.late], [true, 'pair', false]);
    const { rows } = await projectAll(f.capturePath);
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /question[\s\S]*answer/);
    // The repair happened once; a further retry is a no-op.
    assert.equal(part(f, 'assistant', 'torn', 'answer', T0 + 3000).appended, false);
    assert.equal(parseChatCaptureFromOffset(f.capturePath, 0).records.length, 1);
  } finally { f.cleanup(); }
});

test('A2-REC: the sweep repairs a torn assistant as pair, never as reply-absent', () => {
  const f = tornFixture(a => a);
  try {
    assert.deepEqual(decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 9 * HOUR, timeoutMs: HOUR }), []);
    const records = parseChatCaptureFromOffset(f.capturePath, 0).records;
    assert.deepEqual(records.map(r => [r.captureId, r.outcome]), [['torn', 'pair']]);
    assert.equal(planAll(f.capturePath).filter(s => s.kind === 'effect').length, 1);
  } finally { f.cleanup(); }
});

test('A2-REC: a cut inside the decision block refuses every append and blocks projection', () => {
  const f = tornFixture((a, full) => a + Math.floor((full - a) / 2));
  try {
    const bytes = readFileSync(f.capturePath);
    assert.throws(() => part(f, 'user', 'other', 'q'), /incomplete trailing block/);
    assert.throws(() => part(f, 'assistant', 'torn', 'answer'), /incomplete trailing block/);
    assert.throws(() => decideTimedOutTwoPartExchanges({ capturePath: f.capturePath, ingressLockPath: f.ingressLockPath, nowMs: T0 + 9 * HOUR, timeoutMs: HOUR }), /incomplete trailing block/);
    assert.deepEqual(readFileSync(f.capturePath), bytes);
    assert.throws(() => planAll(f.capturePath), /torn write/);
  } finally { f.cleanup(); }
});

test('A2-REC: decision records out of order are refused by the index', () => {
  const f = tornFixture(a => a);
  try {
    // reply-absent recorded after the reply already exists.
    appendFileSync(f.capturePath, rawDecision('torn', 'reply-absent'));
    assert.throws(() => indexTwoPartExchanges(f.capturePath), /follows its reply/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    appendFileSync(g.capturePath, rawDecision('early', 'reply-absent'));
    // The user part it decides, written after it, directly: intake itself
    // refuses to append to a log in this state.
    appendChatCaptureEntriesAtomic([{ turn: {
      speaker: 'David', text: 'q', captureId: 'early', source: 'antigravity', exchangePart: 'user', occurredAt: OCCURRED,
    } }], g.capturePath);
    assert.throws(() => indexTwoPartExchanges(g.capturePath), /precedes its user part/);
    assert.throws(() => part(g, 'user', 'other', 'q'), /precedes its user part/);
  } finally { g.cleanup(); }
});
