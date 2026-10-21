/** Chat-bench receipt: pure event shape, identity rules and route ordering (no database). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { benchEvent, benchEventId, benchReplayEvent, sessionHeader, validateBenchIdentity } from './chat-bench-receipt';
import { planProjectionAppend } from './projection-append';
import { verifyTurnAttribution, type VerifiedFrame } from './turn-attribution';

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

  test('replay rebuilds the stored event exactly, and refuses any frame kind a bench turn never writes', () => {
    const event = benchEvent(turn);
    const plan = planProjectionAppend(sessionHeader('topic'), null, event);
    assert.equal(plan.kind, 'append');
    if (plan.kind !== 'append') return;
    const verdict = verifyTurnAttribution(plan.content, plan.turnAttribution);
    assert.equal(verdict.status, 'valid');
    if (verdict.status !== 'valid') return;
    const eventId = benchEventId(turn.sessionId, turn.turnId);
    assert.deepEqual(benchReplayEvent(eventId, verdict.frames), { event });
    const [luca] = verdict.frames;
    for (const stray of [
      { ...luca, kind: 'structural' as const },
      { ...luca, kind: 'unattributed' as const },
      { ...luca, kind: 'inner-life' as const, channel: 'thinking', entryId: 'e1', receiptRowId: 'r1', content: 'x' },
    ]) {
      const replay = benchReplayEvent(eventId, [...verdict.frames, stray as VerifiedFrame]);
      assert.ok('conflict' in replay && replay.conflict.includes(`unexpected ${stray.kind} frame`), stray.kind);
    }
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
    for (const needle of ['bench.validateBenchIdentity(', 'bench.reserveBenchTurn(', 'bench.findBenchTurn(', "replayed: true"]) {
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

describe('in-process turn reservation (luca-replit review of PR69, R1)', () => {
  test('two concurrent identical requests: exactly one reaches the model', async () => {
    const { reserveBenchTurn } = await import('./chat-bench-receipt');
    const inFlight = new Map<string, symbol>();
    let open!: () => void;
    const barrier = new Promise<void>(resolve => { open = resolve; });
    // The route's shape: reserve synchronously, then await the receipt lookup.
    const attempt = async () => {
      const release = reserveBenchTurn(inFlight, 'sess-aaaa:turn-aaaa');
      if (!release) return 'refused';
      try { await barrier; return 'runs-model'; } finally { release(); }
    };
    const both = Promise.all([attempt(), attempt()]);
    open();
    assert.deepEqual((await both).sort(), ['refused', 'runs-model']);
    assert.equal(inFlight.size, 0, 'released once the attempt finished');
  });
  test('release removes only its own reservation', async () => {
    const { reserveBenchTurn } = await import('./chat-bench-receipt');
    const inFlight = new Map<string, symbol>();
    const first = reserveBenchTurn(inFlight, 'k')!;
    first();
    const second = reserveBenchTurn(inFlight, 'k')!;
    first(); // a stale release must not free the new owner
    assert.equal(reserveBenchTurn(inFlight, 'k'), null);
    second();
    assert.ok(reserveBenchTurn(inFlight, 'k'));
  });
  test('the route reserves before its first lookup and releases only when the attempt ends', () => {
    const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    const start = source.indexOf('app.post("/api/admin/agent-voice-turn"');
    const route = source.slice(start, source.indexOf('app.get("/api/admin/google-voices', start));
    assert.ok(route.indexOf('reservation.release = release;') < route.indexOf('await bench.findBenchTurn('));
    assert.match(route, /await agentVoiceTurn\(req, res, reservation\);\s*\} finally \{\s*reservation\.release\?\.\(\);/);
    assert.doesNotMatch(route, /res\.on\('close'/, 'a disconnect never frees a running attempt');
    assert.doesNotMatch(route, /res\.on\('finish'/);
  });
  test('switch rollback: a receipt session is refused by the legacy path, and the sweep follows persisted rows', () => {
    const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    assert.match(source, /ATTRIBUTION_WRITERS_V1 is off; start a new session or turn the switch back on/);
    assert.match(source, /if \(autoSaveExpiredVoiceTranscripts\) \{\s*\/\/ Restart-safe/);
  });
});

describe('rollback fails closed on an unknown receipt state (luca-replit re-review of PR69)', () => {
  const lookups = {
    receipt: async () => true,
    legacy: async () => false,
    failing: async () => { throw new Error('database unavailable'); },
  };
  test('a switch-off request refuses a receipt session and returns retry when ownership is unknown', async () => {
    const { receiptOwnership, rollbackRequestDecision } = await import('./chat-bench-receipt');
    assert.equal(rollbackRequestDecision(await receiptOwnership(lookups.receipt)), 'refuse');
    assert.equal(rollbackRequestDecision(await receiptOwnership(lookups.failing)), 'retry', 'never runs-legacy-model on a failed lookup');
    assert.equal(rollbackRequestDecision(await receiptOwnership(lookups.legacy)), 'legacy');
  });
  test('the expiry sweep defers on an unknown state and never legacy-saves a receipt session', async () => {
    const { receiptOwnership, expirySweepDecision } = await import('./chat-bench-receipt');
    assert.equal(expirySweepDecision(await receiptOwnership(lookups.receipt)), 'drop');
    assert.equal(expirySweepDecision(await receiptOwnership(lookups.failing)), 'defer', 'kept and retried next sweep');
    assert.equal(expirySweepDecision(await receiptOwnership(lookups.legacy)), 'legacy-save');
  });
  test('the route applies those decisions before any model work and in the sweep', () => {
    const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
    const start = source.indexOf('app.post("/api/admin/agent-voice-turn"');
    const route = source.slice(start, source.indexOf('app.get("/api/admin/google-voices', start));
    const decide = route.indexOf('rollbackRequestDecision(await receiptOwnership(');
    assert.ok(decide > 0 && decide < route.indexOf('ai.live.connect('));
    assert.match(route, /if \(decision === 'retry'\) \{\s*return res\.status\(503\)/);
    assert.match(source, /const decision = expirySweepDecision\(await receiptOwnership\([^\n]+\n\s*if \(decision === 'defer'\) continue;/);
    assert.doesNotMatch(source, /\.catch\(\(\) => attributionWritersEnabled\(\)\)/, 'no fail-open fallback remains');
  });
});
