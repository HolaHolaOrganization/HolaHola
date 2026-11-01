/**
 * The wake loop breaker's pure rules (design eb2ed6bf r10/r11): only a
 * repeating exchange pauses a thread, never volume, a roll call, ids that
 * carry meaning, or anything David says.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateUnpublishedNotes, buildFollowUpNote, buildTriggerText, buildWakeMessage, decideWakeOutcome, UNVERIFIED_NOTE, WAKE_MAX_ROUNDS, isRepeatingExchange, loopHash, normalizeForLoop, noticeOwed, wakeEngineConfig } from './alden-wake-rules';

type Pair = Parameters<typeof isRepeatingExchange>[0][number];
let sequence = 1000;
const pair = (reply: string, trigger: string, actor = 'luca-codex'): Pair => ({
  replyEventId: `reply-${sequence}`,
  replySequence: sequence++,
  replyHash: loopHash(reply),
  triggerActor: actor,
  triggerHash: loopHash(trigger),
});
/** Newest first, as recentWakeReplies returns them. */
const newestFirst = (pairs: Pair[]) => [...pairs].reverse();

test('normalization folds case and whitespace and masks timestamps only', () => {
  assert.equal(normalizeForLoop('  Status   CHECK\n please '), 'status check please');
  assert.equal(normalizeForLoop('ran at 2026-10-31T08:11:59.385Z'), normalizeForLoop('ran at 2026-10-30 22:01:02+00:00'));
  assert.notEqual(normalizeForLoop('PR #157 is green'), normalizeForLoop('PR #158 is green'));
  assert.notEqual(normalizeForLoop('head 124e7030'), normalizeForLoop('head 6a188533'));
});

test('three identical replies to three identical messages from one counterpart is a loop', () => {
  const pairs = [1, 2, 3].map(() => pair('I need David for that.', 'Can you approve the PR?'));
  assert.equal(isRepeatingExchange(newestFirst(pairs)), true);
  assert.equal(isRepeatingExchange(newestFirst(pairs.slice(0, 2))), false, 'two repeats are not yet a loop');
});

test('the onboarding pattern, 30+ distinct alternating turns, never pauses', () => {
  const pairs = Array.from({ length: 32 }, (_, n) => pair(`Step ${n + 1}: run the next check and report back.`, `Done with step ${n}; output attached.`));
  for (let end = 3; end <= pairs.length; end += 1) {
    assert.equal(isRepeatingExchange(newestFirst(pairs.slice(end - 3, end))), false, `window ending at ${end}`);
  }
});

test('a roll call of identical acknowledgements from different actors never pauses', () => {
  const pairs = ['luca-replit', 'luca-claude-code', 'luca-codex'].map((actor) => pair('Thanks, noted.', 'present', actor));
  assert.equal(isRepeatingExchange(newestFirst(pairs)), false);
});

test('messages that differ only in a PR number, sha or event id never pause', () => {
  const ids = [['157', '6a188533'], ['158', '124e7030'], ['159', '07862f38']];
  const pairs = ids.map(([pr, sha]) => pair(`PR #${pr} at ${sha} is noted.`, `Please look at PR #${pr}, head ${sha}.`));
  assert.equal(isRepeatingExchange(newestFirst(pairs)), false);
  const events = ['e1f0', 'e2a9', 'e3c4'].map((id) => pair(`Read event ${id}.`, `See event ${id}.`));
  assert.equal(isRepeatingExchange(newestFirst(events)), false);
});

test('a repeating exchange that includes a David message never pauses', () => {
  const pairs = [pair('Same answer.', 'Same question.'), pair('Same answer.', 'Same question.'), pair('Same answer.', 'Same question.')];
  assert.equal(isRepeatingExchange(newestFirst(pairs)), true);
  const withDavid = [...pairs.slice(0, 2), pair('Same answer.', 'Same question.', 'david')];
  assert.equal(isRepeatingExchange(newestFirst(withDavid)), false);
  const allDavid = [1, 2, 3].map(() => pair('Same answer.', 'Same question.', 'david'));
  assert.equal(isRepeatingExchange(newestFirst(allDavid)), false);
});

test('a long varied conversation is never paused', () => {
  const pairs = Array.from({ length: 40 }, (_, n) => pair(n % 2 ? `Answer ${n}` : `Reply about topic ${n}`, `Question ${n}`));
  assert.equal(isRepeatingExchange(newestFirst(pairs.slice(-3))), false);
});

test('notices: observe items only on failure-like outcomes; addressed items on every wake outcome', () => {
  for (const state of ['replied', 'declined', 'observed']) assert.equal(noticeOwed('observe', state), false, state);
  for (const state of ['failed', 'uncertain', 'conflict']) assert.equal(noticeOwed('observe', state), true, state);
  for (const state of ['replied', 'declined', 'needs_david', 'failed', 'uncertain', 'conflict']) assert.equal(noticeOwed('addressed', state), true, state);
  for (const state of ['handled_in_chat', 'covered', 'history', 'manual']) assert.equal(noticeOwed('addressed', state), false, state);
});

test('the wake message fills the event into Alden\'s words', () => {
  const message = buildWakeMessage({ eventId: 'ev-1', threadId: 'th-1', title: 'Onboarding', actor: 'luca-codex', createdAt: '2026-10-31T09:00:00.000Z' });
  assert.ok(message.startsWith('[INBOX WAKE — David is not present] Coordination event ev-1 on thread th-1 ("Onboarding") from luca-codex, created 2026-10-31T09:00:00.000Z.'));
  assert.ok(message.endsWith('Only items listed there count as covered, and only items on this thread from the same sender.'));
});

test('outcome without a publication: failed on error, observed for observe items, needs_david only after notify', () => {
  assert.equal(decideWakeOutcome({ itemKind: 'addressed', published: { status: 'replied' } }, { }), null);
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed' }, { error: 'boom' }), { outcome: 'failed', errorClass: 'turn_error' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed' }, null), { outcome: 'failed', errorClass: 'turn_error' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'observe', notified: true }, {}), { outcome: 'observed' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed', notified: true }, {}), { outcome: 'needs_david' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed' }, {}), { outcome: 'declined' });
});

test('the wake engine is Gemini by default, Sonnet by configuration, and anything else fails closed', () => {
  assert.deepEqual(wakeEngineConfig(undefined, 'claude-sonnet-5-5'), { engine: 'gemini' });
  assert.deepEqual(wakeEngineConfig(' Gemini ', 'claude-sonnet-5-5'), { engine: 'gemini' });
  assert.deepEqual(wakeEngineConfig('sonnet', 'claude-sonnet-5-5'), { engine: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.throws(() => wakeEngineConfig('opus', 'claude-sonnet-5-5'), /must be "gemini" or "sonnet"/);
});

test('a turn stopped on the tool-round limit gets one follow-up, then fails visibly', () => {
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed', claimEpoch: 1 }, { roundLimitReached: true }), { outcome: 'follow_up' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'observe', claimEpoch: 1 }, { roundLimitReached: true }), { outcome: 'follow_up' });
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed', claimEpoch: 2 }, { roundLimitReached: true }), { outcome: 'failed', errorClass: 'round_limit' });
  assert.equal(decideWakeOutcome({ itemKind: 'addressed', claimEpoch: 1, published: { status: 'replied' } }, { roundLimitReached: true }), null, 'a reply wins');
  assert.deepEqual(decideWakeOutcome({ itemKind: 'addressed', claimEpoch: 1 }, { error: 'boom', roundLimitReached: true }), { outcome: 'failed', errorClass: 'turn_error' });
  const note = buildFollowUpNote('I read seq 30 and 31; next I read 37.');
  assert.match(note, /follow-up turn/);
  assert.ok(note.includes('I read seq 30 and 31; next I read 37.'));
});

test('the trigger text rides in the turn, cut with a pointer when long; unverified claims are marked', () => {
  const short = buildTriggerText({ eventId: 'ev-9', actor: 'luca-codex', content: 'Please confirm.' });
  assert.ok(short.includes('The full text of event ev-9, from luca-codex:'));
  assert.ok(short.endsWith('Please confirm.'));
  const long = buildTriggerText({ eventId: 'ev-9', actor: 'luca-codex', content: 'x'.repeat(9000) });
  assert.match(long, /first 8000 of 9000 characters; read_coordination_message with an offset gives the rest/);
  assert.ok(long.endsWith(':\n\n' + 'x'.repeat(8000)), 'exactly the first 8000 characters follow the header');
  assert.equal(WAKE_MAX_ROUNDS, 16);
  assert.equal(annotateUnpublishedNotes('I replied on the thread.'), `I replied on the thread.\n\n${UNVERIFIED_NOTE}`);
  assert.equal(annotateUnpublishedNotes(''), UNVERIFIED_NOTE);
  assert.match(UNVERIFIED_NOTE, /No reply was published in this turn/);
});

test('the unverified marker survives a long wrap-up (LR, #167)', () => {
  const long = annotateUnpublishedNotes('w'.repeat(2500));
  assert.ok(long.length <= 2000, `stored notes fit the limit (${long.length})`);
  assert.ok(long.endsWith(UNVERIFIED_NOTE));
  assert.equal(long.slice(0, 2000).endsWith(UNVERIFIED_NOTE), true, 'still there after the store-side cut');
});
