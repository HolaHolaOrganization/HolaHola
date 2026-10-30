// Alden's background routines all run on the founder-chosen background model
// (2026-10-26 / 2026-10-29: Claude Sonnet 5.5), with its thinking settings, and
// read the first text block rather than content[0].
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ALDEN_BACKGROUND_MODEL, ALDEN_BACKGROUND_THINKING } from './alden-background-model';

const ROUTINES = [
  'alden-watch-worker.ts',
  'alden-digest-worker.ts',
  'alden-auto-repair.ts',
  'alden-code-review-service.ts',
];

describe('Alden background model', () => {
  test('the background model is Sonnet 5.5 with between-tools thinking at medium effort', () => {
    assert.equal(ALDEN_BACKGROUND_MODEL, 'claude-sonnet-5-5');
    assert.deepEqual(ALDEN_BACKGROUND_THINKING, { thinking: { type: 'between_tools' }, output_config: { effort: 'medium' } });
  });

  for (const file of ROUTINES) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

    test(`${file} names no other Claude model`, () => {
      assert.deepEqual(source.match(/'claude-[a-z0-9-]+'|"claude-[a-z0-9-]+"/g) ?? [], []);
    });

    test(`${file} sends every request with the background model and its thinking settings`, () => {
      const requests = source.split('messages.create(').length - 1;
      assert.ok(requests > 0);
      assert.equal(source.split('model: ALDEN_BACKGROUND_MODEL').length - 1, requests);
      assert.equal(source.split('...ALDEN_BACKGROUND_THINKING').length - 1, requests);
    });

    test(`${file} never reads content[0] as the answer`, () => {
      assert.doesNotMatch(source, /content\[0\]/);
    });
  }
});
