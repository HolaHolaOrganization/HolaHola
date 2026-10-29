// Alden's coordination tool results report the inbox entry and the optional
// notes-inbox mirror separately, so a plain comment (no mirror by design) no
// longer reads as an undelivered message.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { aldenCoordinationDelivery } from './alden-coordination-delivery';

describe('aldenCoordinationDelivery', () => {
  test('a plain comment: recorded for the inbox, no mirror, and it says that is expected', () => {
    const d = aldenCoordinationDelivery('luca-claude-code', 'not_applicable');
    assert.deepEqual([d.recipient, d.inbox, d.notesMirror], ['luca-claude-code', 'recorded', 'none']);
    assert.match(d.message, /coordination inbox; luca-claude-code reads it there/);
    assert.match(d.message, /which is expected/);
    assert.doesNotMatch(d.message, /not_applicable|was requested/);
  });

  test('mirror states are reported as the mirror, never as the inbox entry', () => {
    assert.equal(aldenCoordinationDelivery('luca-replit', 'pending').notesMirror, 'pending');
    assert.equal(aldenCoordinationDelivery('luca-replit', 'delivered').notesMirror, 'delivered');
    const failed = aldenCoordinationDelivery('luca-replit', 'failed');
    assert.equal(failed.notesMirror, 'failed');
    assert.equal(failed.inbox, 'recorded');
    assert.match(failed.message, /coordination inbox entry still stands/);
  });
});

describe('alden-functions wiring', () => {
  const source = readFileSync(new URL('./alden-functions.ts', import.meta.url), 'utf8');

  test('no coordination tool result reports the raw deliveryState any more', () => {
    assert.doesNotMatch(source, /deliveryState: result\.deliveryState/);
    assert.equal(source.match(/delivery: aldenCoordinationDelivery\(/g)?.length, 4);
  });
});
