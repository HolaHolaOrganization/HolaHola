import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  attributionTags,
  attributionWritersEnabled,
  plainParticipants,
  plainRowTitle,
  plainSpeakerName,
  plainTitleDate,
} from './attribution-rendering';
import { parseAttributionTags, parseSpeakerLabel } from './canonical-attribution';
import { formatChatCaptureSpeakerLabel } from './transcript-parser';

const original = process.env.ATTRIBUTION_WRITERS_V1;
afterEach(() => {
  if (original === undefined) delete process.env.ATTRIBUTION_WRITERS_V1;
  else process.env.ATTRIBUTION_WRITERS_V1 = original;
});

const DAVID = { speaker: 'DAVID' as const, source: 'claude-code' as const };
const LUCA_CC = { speaker: 'LUCA' as const, source: 'claude-code' as const };
const CLAUDE = { speaker: 'CLAUDE_CODE' as const, source: 'claude-code' as const };
const LUCA_REPLIT = { speaker: 'LUCA' as const, source: 'replit' as const };

describe('the shared writer switch', () => {
  test('is off unless exactly "1"', () => {
    assert.equal(attributionWritersEnabled({}), false);
    assert.equal(attributionWritersEnabled({ ATTRIBUTION_WRITERS_V1: 'true' }), false);
    assert.equal(attributionWritersEnabled({ ATTRIBUTION_WRITERS_V1: '1' }), true);
  });
});

describe('formatChatCaptureSpeakerLabel', () => {
  test('switch off: byte-identical to the existing labels', () => {
    delete process.env.ATTRIBUTION_WRITERS_V1;
    assert.deepEqual(
      [DAVID, LUCA_CC, CLAUDE, LUCA_REPLIT, { speaker: 'DAVID' as const, source: 'replit' as const }, { speaker: 'LUCA' as const }].map(t => formatChatCaptureSpeakerLabel(t)),
      ['David [Claude Code]', 'Luca [Claude Code]', 'Claude Code', 'Luca [Replit]', 'David [Replit]', 'Luca'],
    );
  });

  test('switch on: plain David / Luca for every hat, including bare Claude Code', () => {
    process.env.ATTRIBUTION_WRITERS_V1 = '1';
    assert.deepEqual([DAVID, LUCA_CC, CLAUDE, LUCA_REPLIT].map(t => formatChatCaptureSpeakerLabel(t)), ['David', 'Luca', 'Luca', 'Luca']);
    // Every rendered label is one the step-4 readers accept as the plain form.
    for (const t of [DAVID, LUCA_CC, CLAUDE, LUCA_REPLIT]) {
      assert.equal(parseSpeakerLabel(formatChatCaptureSpeakerLabel(t))?.form, 'plain');
    }
  });
});

describe('rendering helpers', () => {
  test('plain names, title and participants never carry a hat', () => {
    assert.equal(plainSpeakerName({ speaker: 'CLAUDE_CODE' }), 'Luca');
    assert.equal(plainRowTitle([DAVID, LUCA_CC], 'Oct 20, 2026'), 'David and Luca — Oct 20, 2026');
    assert.equal(plainRowTitle([DAVID], 'Oct 20, 2026'), 'David — Oct 20, 2026');
    assert.deepEqual(plainParticipants([DAVID, CLAUDE]), ['David', 'Luca']);
    assert.equal(plainTitleDate(new Date('2026-10-20T23:59:00Z')), 'Oct 20, 2026');
  });

  test('tags: one evidenced hat, otherwise none; provider and model unknown until provenance', () => {
    assert.deepEqual(attributionTags([DAVID, LUCA_CC]), ['hat-claude-code', 'provider-unknown', 'model-unknown']);
    assert.deepEqual(attributionTags([DAVID, LUCA_REPLIT]), ['provider-unknown', 'model-unknown']);
    assert.deepEqual(attributionTags([{ speaker: 'LUCA' }]), ['provider-unknown', 'model-unknown']);
    // The readers parse what the writers emit.
    assert.deepEqual(parseAttributionTags(attributionTags([DAVID, LUCA_CC])), { hat: 'claude-code', provider: 'unknown', model: 'unknown' });
    assert.deepEqual(parseAttributionTags(attributionTags([DAVID, LUCA_REPLIT])), { hat: 'absent', provider: 'unknown', model: 'unknown' });
  });
});
