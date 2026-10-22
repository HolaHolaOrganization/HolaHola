/** Stop hook turn identity (.claude/hooks/stop-turn-id.mjs): uuid ids from activation on, position ids before. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { positionTurnId, readOrCreateActivation, stopTurnId } from '../../.claude/hooks/stop-turn-id.mjs';

const sessionId = '4efb200a-ed44-4e7b-be8f-d89d2d1c8053';
const activatedAt = '2026-10-22T00:00:00.000Z';
const entry = (uuid: string | undefined, timestamp: string | undefined) => ({ type: 'user', uuid, timestamp });

describe('stopTurnId', () => {
  test('a message after activation is identified by its own uuid, wherever it sits in the transcript', () => {
    const e = entry('e578595d-6983-4796-bb9e-6fd63aa2cca1', '2026-10-22T01:00:00.000Z');
    const id = stopTurnId({ sessionId, entry: e, index: 120, activatedAt });
    assert.equal(id, `cc-${sessionId}-u-e578595d-6983-4796-bb9e-6fd63aa2cca1`);
    assert.equal(stopTurnId({ sessionId, entry: e, index: 7, activatedAt }), id, 'a shifted position keeps the id');
    assert.match(id, /^[A-Za-z0-9-]+$/, 'accepted by the ingress turn-id check');
  });

  test('two distinct messages with identical text get distinct ids', () => {
    const a = { ...entry('11111111-1111-4111-8111-111111111111', '2026-10-22T01:00:00.000Z'), message: { content: 'Hola' } };
    const b = { ...entry('22222222-2222-4222-8222-222222222222', '2026-10-22T01:00:05.000Z'), message: { content: 'Hola' } };
    assert.notEqual(stopTurnId({ sessionId, entry: a, index: 3, activatedAt }), stopTurnId({ sessionId, entry: b, index: 5, activatedAt }));
  });

  test('a message from before activation keeps its position id, so the switch never re-records it', () => {
    const e = entry('33333333-3333-4333-8333-333333333333', '2026-10-21T23:59:59.000Z');
    assert.equal(stopTurnId({ sessionId, entry: e, index: 42, activatedAt }), positionTurnId(sessionId, 42));
    assert.equal(positionTurnId(sessionId, 42), `cc-${sessionId}-42`, 'byte-identical to the previous hook');
  });

  test('missing uuid, timestamp or activation falls back to the position id', () => {
    const later = '2026-10-22T01:00:00.000Z';
    assert.equal(stopTurnId({ sessionId, entry: entry(undefined, later), index: 9, activatedAt }), positionTurnId(sessionId, 9));
    assert.equal(stopTurnId({ sessionId, entry: entry('  ', later), index: 9, activatedAt }), positionTurnId(sessionId, 9));
    assert.equal(stopTurnId({ sessionId, entry: entry('44444444-4444-4444-8444-444444444444', undefined), index: 9, activatedAt }), positionTurnId(sessionId, 9));
    assert.equal(stopTurnId({ sessionId, entry: entry('44444444-4444-4444-8444-444444444444', later), index: 9, activatedAt: null }), positionTurnId(sessionId, 9));
  });

  test('unsafe characters are replaced as before', () => {
    assert.equal(stopTurnId({ sessionId: 'a b', entry: entry('x/y', '2026-10-22T01:00:00.000Z'), index: 1, activatedAt }), 'cc-a-b-u-x-y');
  });
});

describe('readOrCreateActivation', () => {
  test('the first call records the time once; later calls return that same time', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'stop-turn-id-')), 'nested', 'marker.json');
    const first = readOrCreateActivation(marker, new Date('2026-10-22T00:00:00.000Z'));
    assert.equal(first, '2026-10-22T00:00:00.000Z');
    assert.equal(readOrCreateActivation(marker, new Date('2027-01-01T00:00:00.000Z')), first);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { activatedAt: first });
  });

  test('an unreadable marker yields null, and the hook keeps position ids', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'stop-turn-id-')), 'marker.json');
    writeFileSync(marker, 'not json');
    assert.equal(readOrCreateActivation(marker), null);
    writeFileSync(marker, JSON.stringify({ activatedAt: 'not a date' }));
    assert.equal(readOrCreateActivation(marker), null);
    assert.equal(readFileSync(marker, 'utf8'), JSON.stringify({ activatedAt: 'not a date' }), 'an existing marker is never replaced');
  });
});

describe('the Stop hook uses it', () => {
  test('record-stop-turn.mjs derives its turn id from stopTurnId and the checkout-local marker', () => {
    const hook = readFileSync(new URL('../../.claude/hooks/record-stop-turn.mjs', import.meta.url), 'utf8');
    assert.match(hook, /import \{ readOrCreateActivation, stopTurnId \} from '\.\/stop-turn-id\.mjs';/);
    assert.match(hook, /const turnId = stopTurnId\(\{/);
    assert.match(hook, /'\.local', 'stop-hook-turn-id-v2\.json'/);
    assert.doesNotMatch(hook, /`cc-\$\{sessionId\}-\$\{lastUserIdx\}`/, 'no second, position-only id path');
  });
});
