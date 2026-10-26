/** Hash-guarded pass-through writes and leading truncation notices for Alden. Synthetic only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectedContent, sha256Utf8 } from '../services/alden-verbatim';
import { ALDEN_TOOL_RESULT_LIMIT, serializeAldenToolResult } from '../services/alden-tool-result';

const original = 'To be on record, alongside Daniela and Luca, is to be fully integrated into the ongoing story of HolaHola.';

test('no expected hash: the write is allowed and the content hash is reported', () => {
  assert.deepEqual(checkExpectedContent(original, undefined), { ok: true, contentSha256: sha256Utf8(original) });
  assert.equal(checkExpectedContent(original, '').ok, true);
});

test('an exact copy passes; one reworded sentence is refused with nothing written', () => {
  assert.equal(checkExpectedContent(original, sha256Utf8(original)).ok, true);
  assert.equal(checkExpectedContent(original, sha256Utf8(original).toUpperCase()).ok, true, 'hex case does not matter');
  const reworded = original.replace('be fully integrated into the ongoing story of HolaHola', 'serve the truth of what we are building together');
  const refused = checkExpectedContent(reworded, sha256Utf8(original));
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /nothing was written/);
  assert.match(refused.error, /do not edit it/);
  assert.equal(refused.contentSha256, sha256Utf8(reworded));
});

test('a stripped-formatting copy is refused too: markdown is part of the bytes', () => {
  const formatted = `# Title\n\n*framing*\n\n${original}`;
  assert.equal(checkExpectedContent(`Title\nframing\n${original}`, sha256Utf8(formatted)).ok, false);
});

test('a malformed expected hash is refused rather than ignored', () => {
  const result = checkExpectedContent(original, 'not-a-hash');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /64 hex characters/);
});

test('a truncated tool result announces it first, with total size and the absence warning', () => {
  const wire = serializeAldenToolResult('search_code', { content: 'x'.repeat(ALDEN_TOOL_RESULT_LIMIT + 500) });
  assert.match(wire, /^\[truncated result: showing the first 12000 of \d+ characters\./);
  assert.match(wire.split('\n')[0], /do not conclude from this result that something is absent/);
  assert.match(wire, /\[truncated: \d+ chars omitted\]$/);
});

test('a result under the limit is unchanged', () => {
  const data = { matches: ['a', 'b'] };
  assert.equal(serializeAldenToolResult('search_code', data), JSON.stringify(data));
});
