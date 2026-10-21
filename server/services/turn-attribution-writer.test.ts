import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseAttributionTags } from './canonical-attribution';
import { auditEpisodeRow, strictFailure } from './four-channel-continuity-audit';
import { buildClaudeCodeProvenance } from './provenance-builder';
import { turnAttributionOf, verifyTurnAttribution } from './turn-attribution';
import { buildCanonicalEpisodeEvent, buildCanonicalRowAttribution, type AttributableTurn } from './turn-attribution-writer';
import { planProjectionAppend } from './projection-append';
import { readFileSync } from 'node:fs';
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

  // luca-replit review of PR66: every assistant turn counts, including ones
  // whose provenance is absent or unverifiable.
  test('a known-model assistant turn plus an unknown-model one get no single model tag', () => {
    const known = buildClaudeCodeProvenance([{ text: 'a1', model: 'claude-opus-5-5' }]);
    const turns: AttributableTurn[] = [
      ...pair('claude-code', 'cc-7', 'q1', known.assistantText, known.provenance),
      ...pair('claude-code', 'cc-8', 'q2', 'a2 with no provenance'),
    ];
    const row = buildCanonicalRowAttribution(turns, { bold: false });
    assert.ok(row);
    assert.deepEqual(row.modelTags, []);
  });

  test('a single turn whose runs mix a known and an unknown model gets no single model tag', () => {
    const mixed = buildClaudeCodeProvenance([{ text: 'part one', model: 'claude-opus-5-5' }, { text: 'part two', model: undefined }]);
    const row = buildCanonicalRowAttribution(pair('claude-code', 'cc-9', 'q', mixed.assistantText, mixed.provenance), { bold: false });
    assert.deepEqual(row!.modelTags, []);
  });

  test('two assistant turns with the same known model keep the single model tag', () => {
    const a = buildClaudeCodeProvenance([{ text: 'a1', model: 'claude-opus-5-5' }]);
    const b = buildClaudeCodeProvenance([{ text: 'a2', model: 'claude-opus-5-5' }]);
    const row = buildCanonicalRowAttribution([
      ...pair('claude-code', 'cc-10', 'q1', a.assistantText, a.provenance),
      ...pair('claude-code', 'cc-11', 'q2', b.assistantText, b.provenance),
    ], { bold: false });
    assert.deepEqual(row!.modelTags, ['provider-anthropic', 'model-claude-opus-5-5']);
  });

  test('turns that cannot be framed honestly return null (row written as before)', () => {
    assert.equal(buildCanonicalRowAttribution([{ speaker: 'DAVID', text: 'q', source: 'claude-code' }], { bold: false }), null, 'no capture id');
    assert.equal(buildCanonicalRowAttribution([{ speaker: 'DAVID', text: 'q', captureId: 'x' }], { bold: false }), null, 'no source');
    assert.equal(buildCanonicalRowAttribution([...pair('claude-code', 'cc-6', 'q', 'a'), { speaker: 'DAVID', text: 'again', captureId: 'cc-6', source: 'claude-code' }], { bold: false }), null, 'duplicate key');
    assert.equal(buildCanonicalRowAttribution([], { bold: false }), null);
  });
});

describe('writer 1: the framed episode-mirror event (design 3.4)', () => {
  test('one canonical exchange becomes one bold-labelled event that the common append frames validly', () => {
    const event = buildCanonicalEpisodeEvent(pair('replit', 'rp-7', 'pregunta — ñ', 'respuesta\nen dos líneas'));
    assert.ok(event);
    assert.equal(event.source, 'replit');
    assert.equal(event.sourceEventId, 'rp-7');
    assert.deepEqual(event.frames.map(f => [f.frameKey, f.label, f.body, f.hat, f.hatEvidence]), [
      ['david', '**David:** ', 'pregunta — ñ', 'replit', 'capture-source'],
      ['luca', '**Luca:** ', 'respuesta\nen dos líneas', 'replit', 'capture-source'],
    ]);
    const plan = planProjectionAppend('# Episode 99\n\nlegacy bytes\n', null, event);
    assert.equal(plan.kind, 'append');
    if (plan.kind !== 'append') return;
    assert.equal(verifyTurnAttribution(plan.content, plan.turnAttribution).status, 'valid');
    const audit = auditEpisodeRow(plan.content, { turnAttribution: plan.turnAttribution });
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [false], 'an envelope-less Replit turn is honestly incomplete');
    assert.equal(planProjectionAppend(plan.content, plan.turnAttribution, event).kind, 'noop', 'exact retry');
  });
  test('turns without a durable capture id, or mixing two ids, cannot be framed', () => {
    assert.equal(buildCanonicalEpisodeEvent([{ speaker: 'DAVID', text: 'x', source: 'replit' }]), null);
    assert.equal(buildCanonicalEpisodeEvent([...pair('replit', 'a-1', 'q', 'a'), ...pair('replit', 'a-2', 'q', 'a')]), null);
  });
});

describe('writer 1 routing in agent-session-autosave (source order)', () => {
  const src = readFileSync(new URL('./agent-session-autosave.ts', import.meta.url), 'utf8');
  test('switch-on items go to the framed append and are never appended unframed', () => {
    const route = src.indexOf('if (item.attributionRequired || item.episodeEvent) {');
    assert.ok(route > 0);
    const framed = src.indexOf('episodeOk = await appendFramedEpisodeMirror(item);', route);
    const legacy = src.indexOf('projectedContent = projectHistoricalEpisodeMirror(item, capturePath);', route);
    assert.ok(framed > route && framed < legacy, 'the framed branch comes first, before the legacy projection');
    assert.ok(src.includes('...(writersV1 ? { attributionRequired: true, ...withEpisodeEvent(buildCanonicalEpisodeEvent(batchTurns)) } : {}),'));
  });
  test('the legacy DB-first append refuses an attribution-aware episode row', () => {
    const fn = src.slice(src.indexOf('async function appendInnerLifeToEpisodeDb('));
    const guard = fn.indexOf('if (turnAttributionOf(preRow?.attribution) !== undefined) {');
    assert.ok(guard > 0);
    assert.ok(guard < fn.indexOf('UPDATE conversation_memories'), 'the guard precedes every unframed UPDATE');
  });
});
