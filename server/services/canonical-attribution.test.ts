import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  canonicalProvenanceJson,
  parseAttributionTags,
  parseSpeakerLabel,
  parseSpeakerLine,
  verifyProvenance,
} from './canonical-attribution';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

/** Build a valid provenance object over `text`, split at the given byte offsets. */
function provenanceFor(text: string, cuts: number[], models: string[], hat = 'claude-code') {
  const bytes = enc(text);
  const bounds = [0, ...cuts, bytes.length];
  return {
    version: 1,
    encoding: 'utf8-bytes',
    textSha256: sha(bytes),
    runs: models.map((model, index) => ({
      index,
      start: bounds[index],
      end: bounds[index + 1],
      rangeSha256: sha(bytes.subarray(bounds[index], bounds[index + 1])),
      hat,
      hatEvidence: 'capture-source',
      ...(model === 'unknown'
        ? { model: 'unknown', modelEvidence: 'none', provider: 'unknown', providerEvidence: 'none' }
        : { model, modelEvidence: 'claude-code-transcript:message.model', provider: 'anthropic', providerEvidence: 'audited-model-vendor-map:v1' }),
    })),
  };
}

describe('speaker labels: legacy and plain forms', () => {
  const L = (name: string, labelHat: string | null, labelSuffix: string | null, form: string) => ({ name, labelHat, labelSuffix, form });

  test('historical labels keep their hat and exact suffix', () => {
    assert.deepEqual(parseSpeakerLabel('David [Claude Code]'), L('David', 'claude-code', 'Claude Code', 'historical'));
    assert.deepEqual(parseSpeakerLabel('David [Replit]'), L('David', 'replit', 'Replit', 'historical'));
    assert.deepEqual(parseSpeakerLabel('Luca [Replit]'), L('Luca', 'replit', 'Replit', 'historical'));
    assert.deepEqual(parseSpeakerLabel('LUCA [Claude Code]'), L('Luca', 'claude-code', 'Claude Code', 'historical'));
    assert.deepEqual(parseSpeakerLabel('LUCA [claude code]'), L('Luca', 'claude-code', 'claude code', 'historical'));
    assert.deepEqual(parseSpeakerLabel('Claude Code'), L('Claude Code', 'claude-code', null, 'historical'));
    assert.deepEqual(parseSpeakerLabel('LUCA'), L('Luca', null, null, 'historical'));
    assert.deepEqual(parseSpeakerLabel('DAVID'), L('David', null, null, 'historical'));
  });

  test('every historical form found in the stored record is accepted', () => {
    // Read-only scan of conversation_memories and docs/episode-*.md, 2026-10-19.
    assert.deepEqual(parseSpeakerLabel('LUCA [HolaHola]'), L('Luca', 'holahola', 'HolaHola', 'historical'));
    assert.deepEqual(parseSpeakerLabel('LUCA [HolaHola chat]'), L('Luca', 'holahola-chat', 'HolaHola chat', 'historical'));
    // Suffixes that are not an interface keep their text but name no hat.
    assert.deepEqual(parseSpeakerLabel('LUCA [steward]'), L('Luca', null, 'steward', 'historical'));
    assert.deepEqual(parseSpeakerLabel('LUCA [steward — taxonomy]'), L('Luca', null, 'steward — taxonomy', 'historical'));
    assert.deepEqual(parseSpeakerLabel('David [GL]'), L('David', null, 'GL', 'historical'));
  });

  test('plain labels carry no hat; it must come from tags or provenance', () => {
    assert.deepEqual(parseSpeakerLabel('David'), L('David', null, null, 'plain'));
    assert.deepEqual(parseSpeakerLabel('Luca'), L('Luca', null, null, 'plain'));
  });

  test('unknown speakers and brackets are rejected, not guessed', () => {
    for (const bad of ['Daniela', 'Alden', 'Wren', 'Daniela [GL]', 'Luca [Antigravity]', 'David [claude code]', 'Luca [HolaHola]',
      'luca', 'Luca [Replit] ', 'Agent', 'David said', 'constructor', 'LUCA [toString]', 'LUCA [__proto__]']) {
      assert.equal(parseSpeakerLabel(bad), null, bad);
    }
  });

  test('lines in plain and bold renderings', () => {
    assert.deepEqual(parseSpeakerLine('Luca: hello'), { ...L('Luca', null, null, 'plain'), label: 'Luca', bold: false, rest: 'hello' });
    assert.deepEqual(parseSpeakerLine('**LUCA [Replit]:** hi'), { ...L('Luca', 'replit', 'Replit', 'historical'), label: 'LUCA [Replit]', bold: true, rest: 'hi' });
    assert.equal(parseSpeakerLine('**Luca: unbalanced'), null);
    assert.equal(parseSpeakerLine('Note: Luca said hi'), null);
  });

  test('authored provider and model names are not labels and are left alone', () => {
    // Required fixture (design section 4): authored mentions round-trip as text.
    const line = 'Luca: Compare Anthropic Claude with OpenAI GPT, and Claude Code with Replit.';
    const parsed = parseSpeakerLine(line);
    assert.equal(parsed?.rest, 'Compare Anthropic Claude with OpenAI GPT, and Claude Code with Replit.');
    assert.equal(`${parsed?.label}: ${parsed?.rest}`, line);
  });
});

describe('attribution tags', () => {
  test('legacy rows have no attribution tags', () => {
    assert.deepEqual(parseAttributionTags(['source-claude-code', 'canonical-turn']), { hat: 'absent', provider: 'absent', model: 'absent' });
    assert.deepEqual(parseAttributionTags(null), { hat: 'absent', provider: 'absent', model: 'absent' });
  });

  test('a single-model record', () => {
    assert.deepEqual(parseAttributionTags(['hat-claude-code', 'provider-anthropic', 'model-claude-opus-5-5']),
      { hat: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  test('unknown provider and model are explicit', () => {
    assert.deepEqual(parseAttributionTags(['hat-replit', 'provider-unknown', 'model-unknown']),
      { hat: 'replit', provider: 'unknown', model: 'unknown' });
  });

  test('conflicting or malformed values are invalid, never resolved by picking one', () => {
    assert.equal(parseAttributionTags(['model-a', 'model-b']).model, 'invalid');
    assert.equal(parseAttributionTags(['provider-Anthropic Inc']).provider, 'invalid');
    assert.equal(parseAttributionTags(['hat-unknown', 'hat-replit']).hat, 'invalid');
    // Duplicate identical tags are not a conflict.
    assert.equal(parseAttributionTags(['hat-replit', 'hat-replit']).hat, 'replit');
  });
});

describe('provenance verification', () => {
  const text = 'First part.\n\nSecond part — with a non-ASCII dash.\n\nThird.';

  test('absent provenance (legacy rows) is reported as absent', () => {
    assert.deepEqual(verifyProvenance(undefined, text, 'claude-code'), { status: 'absent' });
    assert.deepEqual(verifyProvenance(null, text, 'claude-code'), { status: 'absent' });
  });

  test('a single-model record verifies', () => {
    const v = verifyProvenance(provenanceFor(text, [], ['claude-opus-5-5']), text, 'claude-code');
    assert.equal(v.status, 'valid');
    assert.equal(v.status === 'valid' && v.runs[0].model, 'claude-opus-5-5');
  });

  test('a mixed-model record keeps chronological runs, split at UTF-8 byte offsets', () => {
    const cut1 = enc('First part.').length;
    const cut2 = enc('First part.\n\nSecond part — with a non-ASCII dash.').length;
    const v = verifyProvenance(provenanceFor(text, [cut1, cut2], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']), text, 'claude-code');
    assert.equal(v.status, 'valid');
    assert.deepEqual(v.status === 'valid' && v.runs.map(r => r.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  test('an unknown model verifies with none evidence', () => {
    const v = verifyProvenance(provenanceFor(text, [], ['unknown'], 'replit'), text, 'replit');
    assert.equal(v.status, 'valid');
    assert.equal(v.status === 'valid' && v.runs[0].provider, 'unknown');
  });

  const invalidCases: Array<[string, (p: any) => unknown, string?]> = [
    ['changed text', p => p, 'First part.\n\nSecond part — EDITED.\n\nThird.'],
    ['wrong version', p => ({ ...p, version: 2 })],
    ['gap between runs', p => { const q = structuredClone(p); q.runs[1].start += 1; return q; }],
    ['short coverage', p => { const q = structuredClone(p); q.runs.pop(); return q; }],
    ['bad range hash', p => { const q = structuredClone(p); q.runs[0].rangeSha256 = '0'.repeat(64); return q; }],
    ['malformed model', p => { const q = structuredClone(p); q.runs[0].model = 'claude opus'; return q; }],
    ['model without transcript evidence', p => { const q = structuredClone(p); q.runs[0].modelEvidence = 'guess'; return q; }],
    ['provider from model id alone', p => { const q = structuredClone(p); q.runs[0].providerEvidence = 'model-id'; return q; }],
    ['hat disagrees with capture source', p => { const q = structuredClone(p); q.runs[0].hat = 'replit'; return q; }],
    // luca-replit review of PR60: valid hashes alone must not make a vendor-map
    // claim valid; the reviewed map has to contain the model and agree.
    ['claude model attributed to openai via the map marker', p => { const q = structuredClone(p); q.runs[0].provider = 'openai'; return q; }],
    ['unreviewed model attributed to anthropic via the map marker', p => { const q = structuredClone(p); q.runs[0].model = 'unreviewed-model'; return q; }],
    ['vendor-map provider with an unknown model', p => { const q = structuredClone(p); Object.assign(q.runs[0], { model: 'unknown', modelEvidence: 'none' }); return q; }],
    ['runtime provider evidence from a hat with no runtime source', p => { const q = structuredClone(p); q.runs[0].providerEvidence = 'runtime:vendor'; return q; }],
    ['out-of-order index', p => { const q = structuredClone(p); q.runs[0].index = 1; return q; }],
    ['overflow not in the last slot', p => { const q = structuredClone(p); Object.assign(q.runs[0], { model: 'unknown', provider: 'unknown', modelEvidence: 'overflow-unattributed', providerEvidence: 'overflow-unattributed' }); return q; }],
    ['not an object', () => 'provenance'],
  ];
  for (const [name, mutate, storedText] of invalidCases) {
    test(`invalid metadata (${name}) degrades to one unknown run and keeps the hat`, () => {
      const cut = enc('First part.').length;
      const p = provenanceFor(text, [cut], ['claude-opus-5-5', 'claude-sonnet-5-5']);
      const stored = storedText ?? text;
      const v = verifyProvenance(mutate(p), stored, 'claude-code');
      assert.equal(v.status, 'invalid');
      if (v.status !== 'invalid') return;
      assert.deepEqual(v.runs, [{
        index: 0, start: 0, end: enc(stored).length, hat: 'claude-code',
        provider: 'unknown', providerEvidence: 'none', model: 'unknown', modelEvidence: 'invalid',
      }]);
    });
  }

  // luca-replit review 5576747644: "constructor" matches the hat pattern; an
  // evidence lookup must not reach Object.prototype and throw.
  test('a hat named like a prototype member is invalid, not a crash (model evidence path)', () => {
    const p = provenanceFor(text, [], ['claude-opus-5-5'], 'constructor');
    const v = verifyProvenance(p, text, 'constructor');
    assert.equal(v.status, 'invalid');
    assert.deepEqual(v.status === 'invalid' && v.runs[0], {
      index: 0, start: 0, end: enc(text).length, hat: 'constructor',
      provider: 'unknown', providerEvidence: 'none', model: 'unknown', modelEvidence: 'invalid',
    });
  });

  test('a hat named like a prototype member is invalid, not a crash (runtime provider path)', () => {
    const p = provenanceFor(text, [], ['unknown'], 'constructor');
    Object.assign(p.runs[0], { provider: 'anthropic', providerEvidence: 'runtime:vendor' });
    const v = verifyProvenance(p, text, 'constructor');
    assert.equal(v.status, 'invalid');
    assert.match(v.status === 'invalid' ? v.reason : '', /hat constructor can supply/);
    assert.equal(v.status === 'invalid' && v.runs[0].hat, 'constructor');
  });

  test('a Replit run cannot borrow Claude Code transcript evidence for a known model', () => {
    const p = provenanceFor(text, [], ['claude-opus-5-5'], 'replit');
    const v = verifyProvenance(p, text, 'replit');
    assert.equal(v.status, 'invalid');
    assert.match(v.status === 'invalid' ? v.reason : '', /hat replit/);
    assert.equal(v.status === 'invalid' && v.runs[0].hat, 'replit');
  });

  test('vendor-map failures name the rule that failed', () => {
    const reason = (mutate: (run: Record<string, unknown>) => void) => {
      const p = provenanceFor(text, [], ['claude-opus-5-5']);
      mutate(p.runs[0] as Record<string, unknown>);
      const v = verifyProvenance(p, text, 'claude-code');
      return v.status === 'invalid' ? v.reason : v.status;
    };
    assert.match(reason(r => { r.model = 'unreviewed-model'; }), /not in the reviewed vendor map/);
    assert.match(reason(r => { r.provider = 'openai'; }), /contradicts the reviewed vendor map/);
  });

  test('the reviewed vendor map: exact prefix only, model required beyond the prefix', async () => {
    const { vendorForModelV1, MODEL_VENDOR_MAP_V1 } = await import('./model-vendor-map');
    assert.equal(vendorForModelV1('claude-opus-5-5'), 'anthropic');
    assert.equal(vendorForModelV1('claude-'), undefined);
    assert.equal(vendorForModelV1('gpt-5'), undefined);
    assert.equal(vendorForModelV1('anthropic/claude-opus'), undefined);
    assert.ok(Object.isFrozen(MODEL_VENDOR_MAP_V1) && MODEL_VENDOR_MAP_V1.every(e => Object.isFrozen(e)));
  });

  test('more than 16 runs is invalid; a 16th overflow run covering the rest is valid', () => {
    const parts = Array.from({ length: 17 }, (_, i) => `p${i}`);
    const t = parts.join('');
    const cuts = parts.slice(0, -1).map((_, i) => enc(parts.slice(0, i + 1).join('')).length);
    assert.equal(verifyProvenance(provenanceFor(t, cuts, parts.map(() => 'claude-opus-5-5')), t, 'claude-code').status, 'invalid');

    const p = provenanceFor(t, cuts.slice(0, 15), Array.from({ length: 16 }, () => 'claude-opus-5-5'));
    Object.assign(p.runs[15], { model: 'unknown', provider: 'unknown', modelEvidence: 'overflow-unattributed', providerEvidence: 'overflow-unattributed' });
    assert.equal(verifyProvenance(p, t, 'claude-code').status, 'valid');
  });

  test('idempotent retries: canonical serialization ignores key order and keeps run order', () => {
    const p = provenanceFor(text, [enc('First part.').length], ['claude-opus-5-5', 'claude-sonnet-5-5']);
    const shuffled = JSON.parse(JSON.stringify(p, Object.keys(p).reverse()));
    shuffled.runs = p.runs.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).reverse()));
    assert.equal(canonicalProvenanceJson(shuffled), canonicalProvenanceJson(p));
    assert.deepEqual(JSON.parse(canonicalProvenanceJson(p)).runs.map((r: { index: number }) => r.index), [0, 1]);
    // Verifying the same stored record twice yields the same verdict.
    assert.deepEqual(verifyProvenance(p, text, 'claude-code'), verifyProvenance(JSON.parse(canonicalProvenanceJson(p)), text, 'claude-code'));
  });
});

// Existing readers that predate the plain form must stay fail-safe on it: a
// plain label carries no hat, so they may refuse or report ambiguity but must
// never attribute a hat from the label. (Checked 2026-10-19 against all 117
// stored rows with historical bold labels: 15 already mix other label forms
// and are reported ambiguous by the exact-sequence requirement, not crashed.)
describe('pre-existing forensic readers on plain-label rows', () => {
  const rawEvidence = [
    '---TURN-START---', 'SPEAKER: David', 'SOURCE: claude-code', 'CAPTURE-ID: c-1', '---', 'exact question', '---TURN-END---',
    '---TURN-START---', 'SPEAKER: Claude Code', 'SOURCE: claude-code', 'CAPTURE-ID: c-1', '---', 'exact answer', '---TURN-END---', '',
  ].join('\n');

  test('an all-plain row is refused by the evidence audit', async () => {
    const { auditEvidenceDocuments } = await import('./missing-conversation-evidence-audit');
    assert.throws(
      () => auditEvidenceDocuments('m-plain', 'David: exact question\n\nLuca: exact answer', [{ class: 'retained-capture', location: 'x', content: rawEvidence }]),
      /no exact dialogue turns/,
    );
  });

  test('a row mixing a historical and a plain label is ambiguous, never tagged', async () => {
    const { auditEvidenceDocuments } = await import('./missing-conversation-evidence-audit');
    const report = auditEvidenceDocuments('m-mixed', '**David:** exact question\n\n**Luca:** exact answer', [{ class: 'retained-capture', location: 'x', content: rawEvidence }]);
    assert.equal(report.conclusion.status, 'remain-ambiguous');
    assert.equal(report.conclusion.sourceTag, null);
  });
});
