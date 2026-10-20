import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { auditEpisodeContent, auditEpisodeRow, strictFailure } from './four-channel-continuity-audit';
import { episodeTailHasInnerLifeChannel } from './inner-life-capture';
import { row, type Spec } from './turn-attribution-fixture';

const ENVELOPE = '[felt]: f\n\n[thinking]: t\n\n[moment]: m\n\nmain words';
const LEGACY = `**David:** hi\n\n**LUCA [Replit]:** ${ENVELOPE}`;

const replit = (eventId: string, body: string): Spec[] => [
  { kind: 'attributed', source: 'replit', eventId, frameKey: 'david', speaker: 'david', hat: 'replit', hatEvidence: 'capture-source', label: '**David:** ', body: 'q' },
  { kind: 'attributed', source: 'replit', eventId, frameKey: 'luca', speaker: 'luca', hat: 'replit', hatEvidence: 'capture-source', label: '**Luca:** ', body },
];
const claude = (eventId: string, body: string): Spec[] => [
  { kind: 'attributed', source: 'claude-code', eventId, frameKey: 'david', speaker: 'david', hat: 'claude-code', hatEvidence: 'capture-source', label: '**David:** ', body: 'q' },
  { kind: 'attributed', source: 'claude-code', eventId, frameKey: 'luca', speaker: 'luca', hat: 'claude-code', hatEvidence: 'capture-source', label: '**Luca:** ', body },
];

describe('legacy rows (no per-turn attribution) behave as before', () => {
  test('historical Replit turns are certified exactly as the old audit did', () => {
    const content = `${LEGACY}\n\n**David:** again\n\n**LUCA [Replit]:** main only`;
    const audit = auditEpisodeRow(content, null);
    assert.equal(audit.attribution, 'absent');
    assert.deepEqual(audit.replitTurns, auditEpisodeContent(content));
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [true, false]);
    assert.equal(strictFailure(audit), true);
  });

  test('hatless historical Luca labels are reported, but do not fail strict on legacy rows', () => {
    const audit = auditEpisodeRow(`${LEGACY}\n\n**Luca:** an old pre-SOURCE turn`, null);
    assert.equal(audit.unattributed.length, 1);
    assert.equal(audit.unattributed[0].region, 'legacy');
    assert.equal(strictFailure(audit), false);
  });
});

describe('rows with per-turn attribution', () => {
  test('plain-label Replit turns are found by verified hat, not by label text', () => {
    const r = row(LEGACY, [...replit('r-1', ENVELOPE), ...claude('c-1', 'a Claude Code answer, no envelope')]);
    const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution });
    assert.equal(audit.attribution, 'valid');
    // One legacy Replit turn plus one entry-framed Replit turn; the Claude Code turn is not a Replit turn.
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [true, true]);
    assert.equal(strictFailure(audit), false);
  });

  test('a plain-label Replit turn missing its envelope is caught', () => {
    const r = row('', replit('r-2', 'visible main only'));
    const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution });
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [false]);
    assert.equal(strictFailure(audit), true);
  });

  test('a turn whose hat is unknown is unattributed: cannot certify, and fails strict', () => {
    const r = row('', [{ kind: 'attributed', source: 'holahola-team-room', eventId: 'm-1', frameKey: 'luca', speaker: 'luca', hat: 'unknown', hatEvidence: 'none', label: '**Luca:** ', body: 'main only' }]);
    const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution });
    assert.equal(audit.replitTurns.length, 0);
    assert.deepEqual(audit.unattributed.map(u => [u.region, u.reason]), [['attributed', 'hat unknown: cannot certify']]);
    assert.equal(strictFailure(audit), true);
  });

  test('a quoted "**Luca:**" line inside a Claude Code body never becomes a Replit turn', () => {
    const r = row('', claude('c-2', 'example:\n\n**LUCA [Replit]:** quoted, not a turn'));
    const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution });
    assert.equal(audit.replitTurns.length, 0);
    assert.equal(strictFailure(audit), false);
  });

  test('invalid attribution keeps the legacy prefix audit and fails the rest closed', () => {
    const r = row(LEGACY, replit('r-3', ENVELOPE));
    const tampered = r.content.replace(/main words$/, 'main wordz');
    const audit = auditEpisodeRow(tampered, { turnAttribution: r.turnAttribution });
    assert.equal(audit.attribution, 'invalid');
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [true]); // the legacy turn only
    assert.equal(audit.unattributed.at(-1)?.region, 'attributed');
    assert.equal(strictFailure(audit), true);
  });
});

describe('capture-status presence check', () => {
  test('the felt channel on a plain **Luca:** label line is seen', () => {
    assert.equal(episodeTailHasInnerLifeChannel(`**Luca:** ${ENVELOPE}`, 'felt'), true);
    assert.equal(episodeTailHasInnerLifeChannel(`**LUCA [Replit]:** ${ENVELOPE}`, 'felt'), true);
    assert.equal(episodeTailHasInnerLifeChannel('**Luca:** main only', 'felt'), false);
    assert.equal(episodeTailHasInnerLifeChannel('prose mentioning **Luca:** [felt]: inline', 'felt'), false);
  });
});
