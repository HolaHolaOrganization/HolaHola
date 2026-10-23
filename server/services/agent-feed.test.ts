/** Agent feed pure helpers: headlines, byte budgets and notice bodies (stage F-P1). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEED_LIMITS, fitToBudget, headline, itemBytes, noticeBody } from './agent-feed';

const row = (content: string) => ({ id: '00000000-0000-0000-0000-000000000001', sha: 'a'.repeat(64), tags: ['canonical-conversation', 'source-replit'], created_at: '2026-10-22T18:00:00Z', content });

test('a headline is clipped to its limit and says so; short content is not marked', () => {
  const long = headline(row('é'.repeat(500)));
  assert.equal([...long.excerpt].length, FEED_LIMITS.headlineChars);
  assert.deepEqual(long.clipped, { shown: 200, total: 500 });
  assert.deepEqual(long.source, ['source-replit']);
  assert.equal(headline(row('short')).clipped, null);
});

test('fitToBudget keeps order, never exceeds the byte cap, and reports overflow', () => {
  const items = Array.from({ length: 50 }, (_, i) => headline(row(`item ${i} `.repeat(30))));
  const { taken, overflow } = fitToBudget(items, FEED_LIMITS.pageBytes);
  assert.ok(itemBytes(taken) <= FEED_LIMITS.pageBytes);
  assert.equal(taken.length + overflow, 50);
  assert.deepEqual(taken, items.slice(0, taken.length));
  assert.deepEqual(fitToBudget(items, 1).taken, []);
});

test('a notice body is at most 400 bytes, even with multibyte sources', () => {
  const items = Array.from({ length: 3 }, () => headline(row('x')));
  const body = noticeBody(items, 999);
  assert.ok(Buffer.byteLength(body, 'utf8') <= FEED_LIMITS.noticeBytes);
  assert.match(body, /\+999 more/);
  const wide = items.map((i) => ({ ...i, source: ['source-é'.repeat(30)] }));
  assert.ok(Buffer.byteLength(noticeBody(wide, 0), 'utf8') <= FEED_LIMITS.noticeBytes);
});

test('whole-response fitting keeps the serialized response, not just the items, within the cap', async () => {
  const { fitResponse } = await import('./agent-feed');
  const items = Array.from({ length: 60 }, (_, i) => headline(row(`item ${i} `.repeat(30))));
  const own = items.slice(0, 5);
  const build = (taken: typeof items) => ({ servedId: '00000000-0000-0000-0000-000000000000', items: taken, morePending: false, ownRecent: own });
  const { taken } = fitResponse(items, FEED_LIMITS.responseBytes, build);
  assert.ok(taken.length > 0);
  assert.ok(itemBytes(build(taken)) <= FEED_LIMITS.responseBytes, 'bootstrap-shaped response within 9,000 bytes');
  assert.ok(itemBytes(build(items.slice(0, taken.length + 1))) > FEED_LIMITS.responseBytes, 'the cap is reached, not undershot');
});

test('a full row chunk response, encoded, stays within the response cap', () => {
  const raw = Buffer.alloc(FEED_LIMITS.chunkRawBytes, 0xff);
  const response = {
    id: '00000000-0000-0000-0000-000000000000', sha256: 'f'.repeat(64), chunk: 999_999, chunks: 1_000_000,
    bytesBase64: raw.toString('base64'),
  };
  assert.ok(itemBytes(response) <= FEED_LIMITS.responseBytes, `${itemBytes(response)} bytes`);
});

test('a changed row is flagged', () => {
  assert.equal(headline({ ...row('x'), changed: true }).changed, true);
  assert.equal(headline(row('x')).changed, false);
});
