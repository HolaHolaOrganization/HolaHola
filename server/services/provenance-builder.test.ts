import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { verifyProvenance } from './canonical-attribution';
import { buildClaudeCodeProvenance, flattenAssistantText, type TranscriptSegment } from './provenance-builder';

const runsOf = (p: Record<string, unknown> | null) => (p?.runs as Array<Record<string, unknown>>) ?? [];

describe('assistantText matches the Stop hook byte-for-byte', () => {
  test('the hook still flattens with the same join and trim', () => {
    // Guard: if the hook's flattening changes, provenance offsets would be wrong.
    const hook = readFileSync(new URL('../../.claude/hooks/record-stop-turn.mjs', import.meta.url), 'utf8');
    assert.match(hook, /\.filter\(entry => entry\.type === 'assistant'\)\s*\.map\(entry => extractText\(entry\.message\?\.content\)\)\s*\.filter\(Boolean\)\s*\.join\('\\n\\n'\)\s*\.trim\(\);/);
  });

  test('flattenAssistantText = non-empty texts joined by a blank line, trimmed', () => {
    assert.equal(flattenAssistantText([{ text: '  a', model: 'm' }, { text: '', model: 'm' }, { text: 'b  ', model: 'm' }]), 'a\n\nb');
  });
});

describe('buildClaudeCodeProvenance', () => {
  test('a single-model turn: one run, mapped vendor, verifies', () => {
    const { assistantText, provenance } = buildClaudeCodeProvenance([{ text: 'Hello.', model: 'claude-opus-5-5' }, { text: 'More.', model: 'claude-opus-5-5' }]);
    assert.equal(assistantText, 'Hello.\n\nMore.');
    const runs = runsOf(provenance);
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0].model, runs[0].provider, runs[0].providerEvidence], ['claude-opus-5-5', 'anthropic', 'audited-model-vendor-map:v1']);
    assert.equal(verifyProvenance(provenance, assistantText, 'claude-code').status, 'valid');
  });

  test('a mixed-model turn keeps chronological runs; the separator belongs to the following run', () => {
    const segments: TranscriptSegment[] = [
      { text: 'café ✓', model: 'claude-opus-5-5' },
      { text: 'second', model: 'claude-sonnet-5-5' },
      { text: 'third', model: 'claude-opus-5-5' },
    ];
    const { assistantText, provenance } = buildClaudeCodeProvenance(segments);
    const runs = runsOf(provenance);
    assert.deepEqual(runs.map(r => r.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    const bytes = new TextEncoder().encode(assistantText);
    assert.equal(new TextDecoder().decode(bytes.subarray(runs[1].start as number, runs[1].end as number)), '\n\nsecond');
    assert.equal(verifyProvenance(provenance, assistantText, 'claude-code').status, 'valid');
  });

  test('a missing model is unknown/none; a malformed one is unknown/invalid; an unmapped one has no provider', () => {
    const missing = runsOf(buildClaudeCodeProvenance([{ text: 'x', model: undefined }]).provenance)[0];
    assert.deepEqual([missing.model, missing.modelEvidence, missing.provider], ['unknown', 'none', 'unknown']);
    const malformed = runsOf(buildClaudeCodeProvenance([{ text: 'x', model: 'bad model!' }]).provenance)[0];
    assert.deepEqual([malformed.model, malformed.modelEvidence], ['unknown', 'invalid']);
    const unmapped = buildClaudeCodeProvenance([{ text: 'x', model: 'gpt-5' }]);
    assert.deepEqual([runsOf(unmapped.provenance)[0].model, runsOf(unmapped.provenance)[0].provider], ['gpt-5', 'unknown']);
    assert.equal(verifyProvenance(unmapped.provenance, unmapped.assistantText, 'claude-code').status, 'valid');
  });

  test('leading and trailing whitespace trimmed away still leaves exact coverage', () => {
    const { assistantText, provenance } = buildClaudeCodeProvenance([{ text: '   ', model: 'claude-opus-5-5' }, { text: 'body  ', model: 'claude-sonnet-5-5' }]);
    assert.equal(assistantText, 'body');
    assert.equal(verifyProvenance(provenance, assistantText, 'claude-code').status, 'valid');
    assert.deepEqual(runsOf(provenance).map(r => r.model), ['claude-sonnet-5-5']);
  });

  test('more than 16 runs: runs 0-14 attributed, run 15 covers the rest unattributed', () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ text: `p${i}`, model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5' }));
    const { assistantText, provenance } = buildClaudeCodeProvenance(segments);
    const runs = runsOf(provenance);
    assert.equal(runs.length, 16);
    assert.deepEqual([runs[15].model, runs[15].modelEvidence], ['unknown', 'overflow-unattributed']);
    assert.equal(verifyProvenance(provenance, assistantText, 'claude-code').status, 'valid');
  });

  test('no text means no provenance', () => {
    assert.deepEqual(buildClaudeCodeProvenance([{ text: '', model: 'claude-opus-5-5' }]), { assistantText: '', provenance: null });
  });
});
