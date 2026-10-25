/** Alden chat sync transcript helpers: honest speaker labels, verbatim order, sanitizer skips. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aldenParticipants, aldenSpeakerLabel, formatAldenTranscript } from '../services/alden-chat-transcript';

test('each production role keeps its own speaker; unknown roles are not relabelled', () => {
  assert.equal(aldenSpeakerLabel('david'), 'David');
  assert.equal(aldenSpeakerLabel('luca'), 'Luca [Replit]');
  assert.equal(aldenSpeakerLabel('alden'), 'Alden');
  assert.equal(aldenSpeakerLabel('alden-gemini'), 'Alden [gemini]');
  assert.equal(aldenSpeakerLabel('alden-anthropic'), 'Alden [anthropic]');
  assert.equal(aldenSpeakerLabel('daniela'), 'Daniela');
  assert.equal(aldenSpeakerLabel('someone-new'), 'someone-new');
});

test('the transcript is verbatim and ordered; fully sanitized messages are skipped', () => {
  const rows = [
    { role: 'david', content: 'I am only human after all.' },
    { role: 'alden', content: 'ARTIFACT' },
    { role: 'alden-gemini', content: 'Two surgeons, one patient.' },
  ];
  const clean = (raw: string) => (raw === 'ARTIFACT' ? null : raw);
  assert.equal(
    formatAldenTranscript(rows, clean),
    'David: I am only human after all.\n\nAlden [gemini]: Two surgeons, one patient.',
  );
});

test('participants are listed once each, engines folded into Alden', () => {
  assert.equal(aldenParticipants([
    { role: 'david', content: 'a' }, { role: 'alden-gemini', content: 'b' },
    { role: 'alden-anthropic', content: 'c' }, { role: 'luca', content: 'd' },
  ]), 'David + Alden + Luca');
});
