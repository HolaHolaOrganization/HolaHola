/** Chat-bench receipt: pure event shape, identity rules and route ordering (no database). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { benchEvent, benchEventId, sessionHeader, validateBenchIdentity } from './chat-bench-receipt';
import { planProjectionAppend } from './projection-append';
import { verifyTurnAttribution } from './turn-attribution';

const turn = { sessionId: 'jspace-obs-1700000000000', turnId: 'jspace-obs-1700000000000-t1', lucaText: ' Hola, Daniela.\n', danielaText: '¡Hola! 🙂', participant: 'daniela' as const };

describe('chat-bench receipt event', () => {
  test('records exact bytes as one verifiable event with hat unknown', () => {
    const plan = planProjectionAppend(sessionHeader('topic'), null, benchEvent(turn));
    assert.equal(plan.kind, 'append');
    if (plan.kind !== 'append') return;
    assert.equal(plan.content, 'With Luca — topic\n\n---\n\n**Luca:**  Hola, Daniela.\n\n\n**Daniela:** ¡Hola! 🙂');
    const verdict = verifyTurnAttribution(plan.content, plan.turnAttribution);
    assert.equal(verdict.status, 'valid');
    if (verdict.status !== 'valid') return;
    assert.equal(verdict.legacyPrefixEnd, Buffer.byteLength('With Luca — topic\n\n---'));
    const [luca, daniela] = verdict.frames;
    assert.equal(luca.kind === 'attributed' && luca.hat, 'unknown', 'an admin web login is not a Luca hat');
    assert.equal(daniela.kind === 'participant' && daniela.participant, 'daniela');
    assert.ok(verdict.frames.every(f => f.sourceEventId === benchEventId(turn.sessionId, turn.turnId)));
  });

  test('a consult reply carries the Daniela [consult] participant label', () => {
    const plan = planProjectionAppend('', null, benchEvent({ ...turn, participant: 'daniela-consult' }));
    assert.equal(plan.kind, 'append');
    if (plan.kind !== 'append') return;
    assert.match(plan.content, /\*\*Daniela \[consult\]:\*\* ¡Hola!/);
    assert.equal(verifyTurnAttribution(plan.content, plan.turnAttribution).status, 'valid');
  });

  test('no Daniela text records only the luca frame (never an invented reply)', () => {
    assert.deepEqual(benchEvent({ ...turn, danielaText: '' }).frames.map(f => f.frameKey), ['luca']);
  });

  test('the session header keeps the legacy row bytes', () => {
    assert.equal(sessionHeader(''), 'With Luca\n\n---');
    assert.equal(sessionHeader('x'), 'With Luca — x\n\n---');
  });
});

describe('caller identity', () => {
  test('requires stable caller-generated session and turn ids', () => {
    assert.equal(validateBenchIdentity(turn.sessionId, turn.turnId), null);
    for (const [s, t] of [[undefined, turn.turnId], [turn.sessionId, undefined], ['short', turn.turnId], [turn.sessionId, 'has:colon-xx'], [turn.sessionId, 'x'.repeat(81)], [42, turn.turnId]]) {
      assert.notEqual(validateBenchIdentity(s, t), null, `${String(s)} / ${String(t)}`);
    }
  });
  test('the event id is unambiguous because ids cannot contain ":"', () => {
    assert.equal(benchEventId('aaaaaaaa', 'bbbbbbbb'), 'aaaaaaaa:bbbbbbbb');
  });
});

describe('agent-voice-turn route ordering', () => {
  const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf('app.post("/api/admin/agent-voice-turn"');
  const route = source.slice(start, source.indexOf('app.get("/api/admin/google-voices', start));
  const at = (needle: string) => {
    const i = route.indexOf(needle);
    assert.ok(i >= 0, `route must contain ${needle}`);
    return i;
  };
  test('identity, conflict and exact-retry checks run before the session or model starts', () => {
    const model = at('ai.live.connect(');
    for (const needle of ['bench.validateBenchIdentity(', 'bench.findBenchTurn(', "replayed: true", 'benchTurnsInFlight.has(']) {
      assert.ok(at(needle) < at('agentVoiceSessions.set(sessionKey') && at(needle) < model, needle);
    }
  });
  test('the receipt commits before episode projection, and the legacy hook is not used in receipt mode', () => {
    const record = at('bench.recordBenchTurn(');
    assert.ok(record < at('bench.projectBenchTurn(db, bench.benchEvent(turn)'));
    assert.ok(record < at("} else if (lucaLine?.trim() && !noEpisode) {"));
  });
  test('endSession in receipt mode finalizes the receipt row instead of inserting a transcript', () => {
    assert.ok(at('if (endSession && bench) {') < at('} else if (endSession && agentSession.conversationTranscript.length > 0) {'));
  });
});

describe('SQL parameter shape (no database)', () => {
  test('tag arrays travel as one JSON parameter, never an expanded tuple', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { recordBenchTurn, finalizeBenchSession } = await import('./chat-bench-receipt');
    const dialect = new PgDialect();
    const seen: { sql: string; params: unknown[] }[] = [];
    const responses: Record<string, unknown>[][] = [[], [], [{ id: '00000000-0000-0000-0000-000000000001' }], [{ content: sessionHeader('t'), attribution: null }], [], []];
    const tx = { execute: async (q: any) => { seen.push(dialect.sqlToQuery(q)); return { rows: responses.shift() ?? [] }; } };
    const db = { ...tx, transaction: async (fn: any) => fn(tx) };
    assert.equal((await recordBenchTurn(db as any, turn, { userId: 'dev-test-agent', topicHint: 't', dateStr: 'd' })).kind, 'stored');
    await finalizeBenchSession(tx as any, turn.sessionId, null, ['a', 'b']);
    for (const q of seen) assert.doesNotMatch(q.sql, /\(\$\d+, \$\d+/, `no expanded tuple in: ${q.sql.slice(0, 120)}`);
    const insert = seen.find(q => q.sql.includes('INSERT INTO conversation_memories'))!;
    const asJson = (p: unknown) => { try { return typeof p === 'string' ? JSON.parse(p) : null; } catch { return null; } };
    assert.ok(insert.params.some(p => Array.isArray(asJson(p)) && asJson(p).includes(`bench-session:${turn.sessionId}`)));
    const finalize = seen.at(-1)!;
    assert.ok(finalize.params.includes('["a","b"]'));
  });
});
