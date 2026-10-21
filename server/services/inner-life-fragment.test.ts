/**
 * Revision 12 (attribution design f5d77712 section 3.5): the inner-life
 * fragment kind, reader side. The verifier, the receipt binding check and
 * the four-channel audit, before any writer emits the kind.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { auditEpisodeRow, strictFailure } from './four-channel-continuity-audit';
import { buildInnerLifeReceipt, checkInnerLifeReceipt, innerLifeEntryTag, type ReceiptRow } from './inner-life-receipt';
import { innerLifeLabel, verifyTurnAttribution, type InnerLifeFrame } from './turn-attribution';
import { row, type Spec } from './turn-attribution-fixture';

const ROW_ID = '0b6f2c1e-7a3d-4c2b-9e1f-5d8a6b4c3e21';
const ENTRY = 'entry-2026-10-21-a';
const CONTENT = 'algo se movió —\nen dos líneas ✓ [con corchetes]';

const fragment = (over: Partial<Spec> = {}): Spec => ({
  kind: 'inner-life', source: 'replit-inner-life', eventId: `inner-life:felt:${ENTRY}`, frameKey: 'felt',
  label: innerLifeLabel('felt'), body: `${CONTENT}]`, channel: 'felt', hat: 'unknown', hatEvidence: 'none', receiptRowId: ROW_ID,
  ...over,
});
const verify = (specs: Spec[], legacy = '') => { const r = row(legacy, specs); return { r, v: verifyTurnAttribution(r.content, r.turnAttribution) }; };
const receiptRow = (over: Partial<ReceiptRow> = {}, receipt: Record<string, unknown> = buildInnerLifeReceipt('felt', ENTRY, `${innerLifeLabel('felt')}${CONTENT}]`) as any): ReceiptRow => ({
  id: ROW_ID, entry_type: 'emergence', arc_name: 'luca-inner-life',
  tags: ['luca-inner-life', 'luca-reflection', innerLifeEntryTag('felt', ENTRY)],
  attribution: { innerLifeReceipt: receipt }, ...over,
});
const theFrame = () => { const { v } = verify([fragment()]); assert.equal(v.status, 'valid'); return (v as any).frames[0] as InnerLifeFrame; };

describe('inner-life fragment: verifier', () => {
  test("today's bytes, unchanged, verify as one fragment with hat unknown (Unicode, multiline, brackets)", () => {
    const { r, v } = verify([fragment()], 'legacy episode bytes\n');
    assert.equal(v.status, 'valid');
    if (v.status !== 'valid') return;
    assert.ok(r.content.endsWith(`[Luca — felt: ${CONTENT}]`), 'the rendered bytes are exactly formatInnerLifeEpisodeEntry output');
    const f = v.frames[0];
    assert.equal(f.kind, 'inner-life');
    if (f.kind !== 'inner-life') return;
    assert.deepEqual([f.channel, f.entryId, f.receiptRowId, f.content], ['felt', ENTRY, ROW_ID, CONTENT]);
  });
  for (const [name, over] of [
    ['a known hat claimed for file intake', { hat: 'replit', hatEvidence: 'capture-source' }],
    ['authenticated-actor evidence fabricated for a file', { hat: 'replit', hatEvidence: 'authenticated-actor' }],
    ['channel disagreeing with frameKey', { frameKey: 'thinking' }],
    ['channel disagreeing with sourceEventId', { eventId: `inner-life:moment:${ENTRY}` }],
    ['label of another channel', { label: innerLifeLabel('moment') }],
    ['a rewritten **Luca:** label', { label: '**Luca:** ' }],
    ['no closing bracket', { body: 'content without its bracket' }],
    ['an unknown channel', { channel: 'dream', frameKey: 'dream', eventId: `inner-life:dream:${ENTRY}` }],
    ['an entry id too short', { eventId: 'inner-life:felt:x' }],
    ['a malformed receiptRowId', { receiptRowId: 'not-a-uuid' }],
    ['the kind from another source', { source: 'replit' }],
  ] as const) {
    test(`refused: ${name}`, () => assert.equal(verify([fragment(over as Partial<Spec>)]).v.status, 'invalid'));
  }
  test('the inner-life source emits no other kind (a main turn cannot be relabelled onto it)', () => {
    const main: Spec = { kind: 'attributed', source: 'replit-inner-life', eventId: `inner-life:felt:${ENTRY}`, frameKey: 'luca', speaker: 'luca', hat: 'unknown', hatEvidence: 'none', label: '**Luca:** ', body: 'main words' };
    assert.equal(verify([main]).v.status, 'invalid');
  });
});

describe('inner-life fragment: receipt binding check', () => {
  test('a matching personal emergence row verifies', () => {
    assert.deepEqual(checkInnerLifeReceipt(theFrame(), receiptRow()), { status: 'verified' });
  });
  const exact = `${innerLifeLabel('felt')}${CONTENT}]`;
  const good = buildInnerLifeReceipt('felt', ENTRY, exact) as unknown as Record<string, unknown>;
  for (const [name, row] of [
    ['lookup unavailable', 'unavailable'],
    ['no such row', null],
    ['wrong entry type', receiptRow({ entry_type: 'conversation' })],
    ['wrong arc', receiptRow({ arc_name: 'david-luca-chat' })],
    ['a different row id', receiptRow({ id: '11111111-2222-4333-8444-555555555555' })],
    ['missing entry tag', receiptRow({ tags: ['luca-inner-life'] })],
    ['entry tag of another entry', receiptRow({ tags: [innerLifeEntryTag('felt', 'other-entry-1')] })],
    ['two entry tags', receiptRow({ tags: [innerLifeEntryTag('felt', ENTRY), innerLifeEntryTag('felt', 'other-entry-1')] })],
    ['no receipt object', receiptRow({ attribution: {} })],
    ['receipt channel mismatch', receiptRow({}, { ...good, channel: 'moment' })],
    ['receipt entryId mismatch', receiptRow({}, { ...good, entryId: 'other-entry-1' })],
    ['receipt sourceEventId mismatch', receiptRow({}, { ...good, sourceEventId: 'inner-life:felt:other-entry-1' })],
    ['receipt source policy claims a hat', receiptRow({}, { ...good, hat: 'replit' })],
    ['exactFragment differs from the frame', receiptRow({}, { ...buildInnerLifeReceipt('felt', ENTRY, exact + ' ') })],
    ['exactFragment disagrees with its digest', receiptRow({}, { ...good, exactFragment: exact.replace('✓', 'x') })],
    ['a copied digest on an unrelated fragment', receiptRow({}, { ...good, exactFragment: 'unrelated', fragmentSha256: good.fragmentSha256 })],
    ['an extra receipt field', receiptRow({}, { ...good, extra: true })],
  ] as const) {
    test(`unverified: ${name}`, () => {
      const verdict = checkInnerLifeReceipt(theFrame(), row as ReceiptRow | null | 'unavailable');
      assert.equal(verdict.status, 'unverified');
    });
  }
});

describe('inner-life fragment: four-channel audit', () => {
  const ENVELOPE = '[felt]: f\n\n[thinking]: t\n\n[moment]: m\n\nmain words';
  const specs: Spec[] = [
    { kind: 'attributed', source: 'replit', eventId: 'r-1', frameKey: 'luca', speaker: 'luca', hat: 'replit', hatEvidence: 'capture-source', label: '**Luca:** ', body: ENVELOPE },
    fragment(),
  ];
  test('a fragment is listed separately, never as a Replit turn, and never certifies one', () => {
    const r = row('', specs);
    const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution }, new Map([[ROW_ID, receiptRow()]]));
    assert.deepEqual(audit.replitTurns.map(t => t.complete), [true], 'only the main turn is a Replit turn');
    assert.deepEqual(audit.channelFragments.map(f => [f.channel, f.entryId, f.receipt]), [['felt', ENTRY, 'verified']]);
    assert.equal(strictFailure(audit), false);
    const alone = row('', [fragment()]);
    const fragmentOnly = auditEpisodeRow(alone.content, { turnAttribution: alone.turnAttribution }, new Map([[ROW_ID, receiptRow()]]));
    assert.deepEqual(fragmentOnly.replitTurns, [], 'a fragment alone certifies no main turn');
  });
  test('without a receipt lookup, or with a failing one, the fragment is unverified and strict fails', () => {
    const r = row('', specs);
    for (const rows of [undefined, new Map(), new Map([[ROW_ID, 'unavailable' as const]]), new Map([[ROW_ID, null]])]) {
      const audit = auditEpisodeRow(r.content, { turnAttribution: r.turnAttribution }, rows as any);
      assert.equal(audit.channelFragments[0].receipt, 'unverified');
      assert.ok(audit.channelFragments[0].reason);
      assert.equal(strictFailure(audit), true, 'an unverified receipt is a coverage error, never a pass');
    }
  });
});

describe('present-null attribution never falls back to legacy (luca-replit review R4)', () => {
  test('a NULL column and a missing key are legacy; a present null is invalid and strict fails', () => {
    const content = `[Luca — felt: an authored fragment]`;
    assert.equal(auditEpisodeRow(content, null).attribution, 'absent');
    assert.equal(auditEpisodeRow(content, {}).attribution, 'absent');
    assert.equal(auditEpisodeRow(content, { modelTags: ['x'] }).attribution, 'absent');
    const presentNull = auditEpisodeRow(content, { turnAttribution: null });
    assert.equal(presentNull.attribution, 'invalid');
    assert.equal(strictFailure(presentNull), true, 'the receipt check can no longer be bypassed');
  });
});
