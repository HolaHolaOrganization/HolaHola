/**
 * The wake loop breaker's pure rules (design eb2ed6bf r10/r11): only a
 * repeating exchange pauses a thread, never volume, a roll call, ids that
 * carry meaning, or anything David says.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isRepeatingExchange, loopHash, normalizeForLoop, noticeOwed } from './alden-wake-rules';

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
