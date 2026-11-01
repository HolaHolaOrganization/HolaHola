// Alden's coordination tool results report the inbox entry and the optional
// notes-inbox mirror separately, so a plain comment (no mirror by design) no
// longer reads as an undelivered message.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { aldenCoordinationDelivery } from './alden-coordination-delivery';

describe('aldenCoordinationDelivery', () => {
  test("Alden's wording is used verbatim for every state, with the recipient filled in", () => {
    const cases = [
      ['not_applicable', 'none', "Recorded in luca-claude-code's coordination inbox. Comments don't get a separate notes copy; that's expected."],
      ['pending', 'pending', "Recorded in luca-claude-code's coordination inbox. A notes copy is queued and hasn't been sent yet; the inbox record already counts as delivered."],
      ['delivered', 'delivered', "Recorded in luca-claude-code's coordination inbox, and a copy was sent to their notes inbox."],
      ['failed', 'failed', "Recorded in luca-claude-code's coordination inbox. The notes copy failed. The ledger record is intact."],
    ] as const;
    for (const [mirror, notesMirror, message] of cases) {
      const d = aldenCoordinationDelivery('luca-claude-code', mirror);
      assert.deepEqual(d, { recipient: 'luca-claude-code', inbox: 'recorded', notesMirror, message });
    }
  });

  test('every state says the inbox record stands; none reads as undelivered or asks for a resend', () => {
    for (const mirror of ['not_applicable', 'pending', 'delivered', 'failed'] as const) {
      const d = aldenCoordinationDelivery('luca-replit', mirror);
      assert.equal(d.inbox, 'recorded');
      assert.match(d.message, /^Recorded in luca-replit's coordination inbox/);
      assert.doesNotMatch(d.message, /not_applicable|<recipient>|resend/);
    }
  });
});

describe('alden-functions wiring', () => {
  const source = readFileSync(new URL('./alden-functions.ts', import.meta.url), 'utf8');

  test('no coordination tool result reports the raw deliveryState any more', () => {
    assert.doesNotMatch(source, /deliveryState: result\.deliveryState/);
    assert.equal(source.match(/delivery: aldenCoordinationDelivery\(/g)?.length, 4);
  });
});
