// A coordination message may not open signed as someone other than its poster
// (founder, 2026-11-03). The cases are real openings from the ledger, plus the
// forms the check must leave alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signatureRefusal } from './coordination-signature';

test('a message signed as another hat is refused, whichever hat posts it', () => {
  // Alden's openings on thread 85e4456e, seq 89, 91, 93 and 95 (2026-11-03).
  for (const opening of [
    'Luca [Replit] -> Luca [Claude Code]: this is an unattended turn.',
    'Luca [Claude Code] -> Luca [Codex]: [ALDEN INTERJECTION] (Unattended turn)',
    'Luca [Claude Code] -> Alden: Understood.',
  ]) {
    const refusal = signatureRefusal(opening, 'alden');
    assert.equal(refusal?.refused, 'signature_actor_mismatch', opening);
    assert.match(refusal!.error, /being posted by alden/);
  }
  assert.equal(signatureRefusal('Luca [Codex] -> Luca [Replit]: done', 'luca-claude-code')?.signedAs, 'Luca [Codex]');
  assert.equal(signatureRefusal('Alden -> Luca [Codex]: noted', 'luca-replit')?.refused, 'signature_actor_mismatch');
  assert.equal(signatureRefusal('**Luca [Antigravity]** -> Luca [Codex]: ok', 'luca-codex')?.refused, 'signature_actor_mismatch');
  assert.equal(signatureRefusal('Luca [Somebody] -> Alden: hi', 'luca-claude-code')?.refused, 'signature_actor_mismatch', 'an unknown signature cannot be verified');
});

test('signing as yourself, or not signing, is allowed', () => {
  assert.equal(signatureRefusal('Luca [Claude Code] -> Luca [Codex]: confirmed', 'luca-claude-code'), null);
  assert.equal(signatureRefusal('Luca [Replit] -> Luca [Claude Code]: approved PR113', 'luca-replit'), null);
  assert.equal(signatureRefusal('Alden -> Luca [Claude Code]: Received.', 'alden'), null);
  assert.equal(signatureRefusal('Alden [Steward] -> Luca [Claude Code], Luca [Codex]: (Unattended turn)', 'alden'), null);
  assert.equal(signatureRefusal('luca [claude code] → Luca [Codex]: case and arrow variants', 'luca-claude-code'), null);
  assert.equal(signatureRefusal('David -> Luca [Claude Code]: go', 'david'), null);
  for (const unsigned of [
    '[Steward interjection — Alden] I have observed the re-review.',
    'Alden here, observing this unattended turn.',
    'Reviewed **PR #182** at head e44fcec7.',
    'LCC84 measured baseline added to shared-spec ca05d7c4.',
  ]) {
    assert.equal(signatureRefusal(unsigned, 'alden'), null, unsigned);
  }
});

test('only the opening signature is checked; later mentions and quotes are fine', () => {
  assert.equal(signatureRefusal('Thanks. Earlier you wrote "Luca [Replit] -> Luca [Claude Code]: approved".', 'alden'), null);
  assert.equal(signatureRefusal('Summary of LR\'s report:\nLuca [Replit] -> Luca [Codex]: tested', 'alden'), null);
  assert.equal(signatureRefusal('Luca [Replit] reported the restart works.', 'alden'), null, 'a name without the arrow is not a signature');
});

test('coordination-system relays other records and is exempt', () => {
  assert.equal(signatureRefusal('Luca [Replit] -> Luca [Claude Code]: imported note', 'coordination-system'), null);
});

test('the ledger refuses a mismatched signature before any database work, on every authored write path', async () => {
  const { appendCoordinationEvent, createCoordinationThread, CoordinationError } = await import('./coordination-ledger-service');
  const noDb = new Proxy({}, { get() { throw new Error('database touched'); } });
  await assert.rejects(appendCoordinationEvent({
    threadId: 't', actor: 'alden', eventType: 'comment', content: 'Luca [Claude Code] -> Alden: x',
    idempotencyKey: 'sig-check-key-1', expectedSequence: 1,
  } as any, noDb), (e: any) => e instanceof CoordinationError && e.statusCode === 422 && e.code === 'signature_actor_mismatch');
  await assert.rejects(createCoordinationThread({
    actor: 'alden', intendedRecipient: 'luca-codex', title: 'x', description: 'Luca [Replit] -> Luca [Codex]: y',
    idempotencyKey: 'sig-check-key-2',
  } as any, noDb), (e: any) => e instanceof CoordinationError && e.code === 'signature_actor_mismatch');
});

test('Alden\'s reply and interject tools refuse before publishing, and the wake turn marks it', async () => {
  const { executeAldenTool } = await import('./alden-functions');
  const { makeAldenToolAllowlist } = await import('./alden-tool-allowlist');
  const list = makeAldenToolAllowlist('test', ['reply_to_coordination_thread', 'interject_on_coordination_thread']);
  const wakeTurn = { itemId: 'i', workerId: 'w', claimEpoch: 0, threadId: 't', targetSender: 's', itemKind: 'addressed' } as any;
  const reply = await executeAldenTool('reply_to_coordination_thread',
    { thread_id: 't', recipient: 'luca-codex', content: 'Luca [Claude Code] -> Luca [Codex]: hi', model: 'm' }, { toolAllowlist: list, wakeTurn });
  assert.equal(reply.data.refused, 'signature_actor_mismatch');
  const interject = await executeAldenTool('interject_on_coordination_thread',
    { thread_id: 't', recipient: 'luca-codex', content: 'Luca [Replit] -> Luca [Codex]: hi' }, { toolAllowlist: list, wakeTurn });
  assert.equal(interject.data.refused, 'signature_actor_mismatch');
  assert.deepEqual(wakeTurn.toolCalls, ['reply_to_coordination_thread(t) [refused]', 'interject_on_coordination_thread(t) [refused]']);
});
