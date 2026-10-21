import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { auditEpisodeRow, strictFailure } from './four-channel-continuity-audit';
import { planProjectionAppend, type AppendEvent, type AppendFrame } from './projection-append';
import { verifyTurnAttribution } from './turn-attribution';

const LEGACY = '# Episode 99\n\n**David:** hello\n\n**LUCA [Replit]:** hi\n';
const david = (body: string, hat = 'claude-code'): AppendFrame => ({ kind: 'attributed', frameKey: 'david', speaker: 'david', hat, hatEvidence: 'capture-source', label: '**David:** ', body });
const luca = (body: string, hat = 'claude-code'): AppendFrame => ({ kind: 'attributed', frameKey: 'luca', speaker: 'luca', hat, hatEvidence: 'capture-source', label: '**Luca:** ', body });
const exchange = (source: string, id: string, q: string, a: string): AppendEvent => ({ source, sourceEventId: id, frames: [david(q, source), luca(a, source)] });

function apply(content: string, ta: unknown, event: AppendEvent) {
  const plan = planProjectionAppend(content, ta, event);
  assert.equal(plan.kind, 'append', plan.kind === 'conflict' ? plan.reason : plan.kind);
  return plan.kind === 'append' ? plan : (null as never);
}

describe('planProjectionAppend', () => {
  test('the first aware append keeps legacy bytes and marks the legacy prefix', () => {
    const r = apply(LEGACY, null, exchange('claude-code', 'cc-1', 'question', 'answer'));
    assert.ok(r.content.startsWith(LEGACY));
    assert.equal(r.turnAttribution.legacyPrefixEnd, new TextEncoder().encode(LEGACY).length);
    assert.equal(verifyTurnAttribution(r.content, r.turnAttribution).status, 'valid');
  });

  test('a David + Luca pair under one id is two entries; a second exchange appends chronologically', () => {
    const one = apply(LEGACY, null, exchange('claude-code', 'cc-1', 'q1', 'a1'));
    const two = apply(one.content, one.turnAttribution, exchange('replit', 'r-1', 'q2', 'a2'));
    const turns = two.turnAttribution.turns as Array<Record<string, unknown>>;
    assert.deepEqual(turns.map(t => [t.index, t.source, t.frameKey]), [[0, 'claude-code', 'david'], [1, 'claude-code', 'luca'], [2, 'replit', 'david'], [3, 'replit', 'luca']]);
    assert.equal(verifyTurnAttribution(two.content, two.turnAttribution).status, 'valid');
  });

  test('an exact retry of the pair is a no-op; one side retried unchanged is also a no-op', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    assert.deepEqual(planProjectionAppend(one.content, one.turnAttribution, exchange('claude-code', 'cc-1', 'q', 'a')), { kind: 'noop' });
    assert.deepEqual(planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [luca('a')] }), { kind: 'noop' });
  });

  test('the same key with changed bytes fails closed', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    const plan = planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [luca('a, edited')] });
    assert.equal(plan.kind, 'conflict');
    assert.match(plan.kind === 'conflict' ? plan.reason : '', /already present with different bytes/);
  });

  test('a partly present event fails closed instead of half-appending', () => {
    const one = apply('', null, { source: 'claude-code', sourceEventId: 'cc-1', frames: [david('q')] });
    const plan = planProjectionAppend(one.content, one.turnAttribution, exchange('claude-code', 'cc-1', 'q', 'a'));
    assert.match(plan.kind === 'conflict' ? plan.reason : plan.kind, /only partly present/);
  });

  test('the same sourceEventId from a different source is a different key', () => {
    const one = apply('', null, exchange('claude-code', 'id-1', 'q', 'a'));
    assert.equal(planProjectionAppend(one.content, one.turnAttribution, exchange('replit', 'id-1', 'q', 'a')).kind, 'append');
  });

  test('participants from mixed sources stay framed and carry no hat', () => {
    const one = apply(LEGACY, null, exchange('replit', 'r-1', 'q', '[felt]: f\n\n[thinking]: t\n\n[moment]: m\n\nmain'));
    const two = apply(one.content, one.turnAttribution, {
      source: 'holahola-chat-bench', sourceEventId: 'bench-1',
      frames: [
        { kind: 'attributed', frameKey: 'luca', speaker: 'luca', hat: 'claude-code', hatEvidence: 'authenticated-actor', label: '**Luca:** ', body: 'hola' },
        { kind: 'participant', frameKey: 'daniela', participant: 'daniela-consult', label: '**Daniela [consult]:** ', body: 'hola, Luca' },
      ],
    });
    const verdict = verifyTurnAttribution(two.content, two.turnAttribution);
    assert.equal(verdict.status, 'valid');
    const participant = verdict.status === 'valid' ? verdict.frames.at(-1) : undefined;
    assert.equal(participant?.kind, 'participant');
    // The legacy prefix's Replit turn (no envelope) and the attributed Replit turn are both audited.
    const audit = auditEpisodeRow(two.content, { turnAttribution: two.turnAttribution });
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [false, true]);
    assert.equal(strictFailure(audit), true, 'the legacy "LUCA [Replit]: hi" turn has no envelope');
  });

  test('a legacy writer appending after an aware append makes the row refuse further aware appends', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    const tampered = `${one.content}\n<!-- chat-capture-range:1:2 -->\n**David:** late`;
    const plan = planProjectionAppend(tampered, one.turnAttribution, exchange('claude-code', 'cc-2', 'q2', 'a2'));
    assert.match(plan.kind === 'conflict' ? plan.reason : plan.kind, /current attribution does not verify/);
  });

  test('authored bodies are never trimmed or rewritten', () => {
    const body = '  leading and trailing  \n\nLuca: quoted label line\n';
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', body));
    assert.ok(one.content.endsWith(body));
  });

  // luca-replit review of PR67: validate the whole event before idempotency,
  // and pin the first-receipt retry contract.
  test('an already-stored frame supplied twice in one retry is a conflict, not a no-op', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    const plan = planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [luca('a'), luca('a')] });
    assert.match(plan.kind === 'conflict' ? plan.reason : plan.kind, /duplicate frameKey within the event/);
  });

  test('a retry in a different frame order is still a no-op', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    assert.deepEqual(planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [luca('a'), david('q')] }), { kind: 'noop' });
  });

  test('a retry claiming different hat evidence is a conflict', () => {
    const one = apply('', null, exchange('claude-code', 'cc-1', 'q', 'a'));
    const plan = planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [{ ...luca('a'), hat: 'replit' }] });
    assert.match(plan.kind === 'conflict' ? plan.reason : plan.kind, /different identity or evidence/);
  });

  test('a provenance-only retry keeps the first stored provenance', () => {
    const one = apply('', null, { source: 'claude-code', sourceEventId: 'cc-1', frames: [{ ...luca('a'), provenance: null }] });
    const retry = planProjectionAppend(one.content, one.turnAttribution, { source: 'claude-code', sourceEventId: 'cc-1', frames: [{ ...luca('a'), provenance: { version: 1 } }] });
    assert.deepEqual(retry, { kind: 'noop' });
    assert.equal((one.turnAttribution.turns as Array<Record<string, unknown>>)[0].provenance, null);
  });

  test('empty events and duplicate keys within an event are refused', () => {
    assert.equal(planProjectionAppend('', null, { source: 'claude-code', sourceEventId: 'x', frames: [] }).kind, 'conflict');
    assert.equal(planProjectionAppend('', null, { source: 'claude-code', sourceEventId: 'x', frames: [luca('a'), luca('b')] }).kind, 'conflict');
  });
});
