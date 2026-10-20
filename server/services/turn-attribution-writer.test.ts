import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseAttributionTags } from './canonical-attribution';
import { auditEpisodeRow, strictFailure } from './four-channel-continuity-audit';
import { buildClaudeCodeProvenance } from './provenance-builder';
import { turnAttributionOf, verifyTurnAttribution } from './turn-attribution';
import { buildCanonicalRowAttribution, type AttributableTurn } from './turn-attribution-writer';
import { attributionTags } from './attribution-rendering';

const original = process.env.ATTRIBUTION_WRITERS_V1;
before(() => { process.env.ATTRIBUTION_WRITERS_V1 = '1'; });
after(() => { if (original === undefined) delete process.env.ATTRIBUTION_WRITERS_V1; else process.env.ATTRIBUTION_WRITERS_V1 = original; });

const pair = (source: 'claude-code' | 'replit', id: string, david: string, luca: string, provenance?: unknown): AttributableTurn[] => [
  { speaker: 'DAVID', text: david, captureId: id, source },
  { speaker: source === 'claude-code' ? 'CLAUDE_CODE' : 'LUCA', text: luca, captureId: id, source, provenance },
];

describe('canonical row attribution (design 3.3, writer side)', () => {
  test('a Claude Code pair: plain labels, exact framing, verified by the step-4 reader', () => {
    const { assistantText, provenance } = buildClaudeCodeProvenance([{ text: 'The answer — résumé ✓', model: 'claude-opus-5-5' }]);
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-1', 'the question', assistantText, provenance), { bold: false });
    assert.ok(row);
    assert.equal(row.content, `David: the question\n\nLuca: ${assistantText}`);
    const verdict = verifyTurnAttribution(row.content, turnAttributionOf(row.attribution));
    assert.equal(verdict.status, 'valid');
    const frames = verdict.status === 'valid' ? verdict.frames : [];
    assert.deepEqual(frames.map(f => f.kind === 'attributed' && [f.speaker, f.hat, f.frameKey, f.provenance.status]), [
      ['david', 'claude-code', 'david', 'absent'],
      ['luca', 'claude-code', 'luca', 'valid'],
    ]);
    assert.deepEqual(row.modelTags, ['provider-anthropic', 'model-claude-opus-5-5']);
    assert.deepEqual(parseAttributionTags(attributionTags(pair('claude-code', 'cc-1', 'q', 'a'), row.modelTags)),
      { hat: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  test('bold framing matches the watchdog rendering', () => {
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-2', 'q', 'a'), { bold: true });
    assert.equal(row?.content, '**David:** q\n\n**Luca:** a');
    assert.equal(verifyTurnAttribution(row!.content, turnAttributionOf(row!.attribution)).status, 'valid');
  });

  test('a Replit row with a four-channel envelope is certified by the audit from stored attribution', () => {
    const envelope = '[felt]: f\n\n[thinking]: t\n\n[moment]: m\n\nmain words';
    const row = buildCanonicalRowAttribution(pair('replit', 'r-1', 'q', envelope), { bold: true });
    assert.ok(row);
    const audit = auditEpisodeRow(row.content, row.attribution);
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [true]);
    assert.equal(strictFailure(audit), false);
    assert.deepEqual(row.modelTags, ['provider-unknown', 'model-unknown']);
  });

  test('authored label-shaped lines stay body text', () => {
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-3', 'q', 'Example:\n\nDavid: quoted\nLuca: quoted'), { bold: false });
    const verdict = verifyTurnAttribution(row!.content, turnAttributionOf(row!.attribution));
    assert.equal(verdict.status === 'valid' && verdict.frames.length, 2);
  });

  test('an unverifiable provenance is stored as null (model unknown), never kept', () => {
    const { provenance } = buildClaudeCodeProvenance([{ text: 'other text', model: 'claude-opus-5-5' }]);
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-4', 'q', 'answer', provenance), { bold: false });
    const entry = (row!.attribution.turnAttribution.turns as Array<Record<string, unknown>>)[1];
    assert.equal(entry.provenance, null);
    assert.deepEqual(row!.modelTags, ['provider-unknown', 'model-unknown']);
  });

  test('several models in one row get no single model tag', () => {
    const { assistantText, provenance } = buildClaudeCodeProvenance([{ text: 'a', model: 'claude-opus-5-5' }, { text: 'b', model: 'claude-sonnet-5-5' }]);
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-5', 'q', assistantText, provenance), { bold: false });
    assert.deepEqual(row!.modelTags, []);
  });

  test('turns that cannot be framed honestly return null (row written as before)', () => {
    assert.equal(buildCanonicalRowAttribution([{ speaker: 'DAVID', text: 'q', source: 'claude-code' }], { bold: false }), null, 'no capture id');
    assert.equal(buildCanonicalRowAttribution([{ speaker: 'DAVID', text: 'q', captureId: 'x' }], { bold: false }), null, 'no source');
    assert.equal(buildCanonicalRowAttribution([...pair('claude-code', 'cc-6', 'q', 'a'), { speaker: 'DAVID', text: 'again', captureId: 'cc-6', source: 'claude-code' }], { bold: false }), null, 'duplicate key');
    assert.equal(buildCanonicalRowAttribution([], { bold: false }), null);
  });
});
