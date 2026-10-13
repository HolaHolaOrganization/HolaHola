import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompletionEvidence, claimKeyFor } from '../../../shared/worker-contracts';
import { FakeLedger } from './fake-ledger';
import {
  checkFence, compareEventToEntry, decideClaimOutcome, decideResend, decideWatchdog, freezeOutboxEntry, isIntactOutboxEntry, outboxBlocksClaims,
  reconcileOutboxEntry, selectOwnRecoveries, type ThreadEventLite, type WatchdogInput,
} from './lifecycle';

const W = 'luca-claude-code';
const I1 = '11111111-1111-4111-8111-111111111111';
const I2 = '22222222-2222-4222-8222-222222222222';
const N1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const N2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function claim(l: FakeLedger, instanceId: string, runNonce: string, launched = new Set<string>()) {
  const seq = l.threads.get(T)!.latestSequence;
  const key = claimKeyFor(instanceId, T, runNonce, seq);
  const result = l.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: key, expectedSequence: seq, payload: { instanceId, runNonce, claimKey: key } });
  return { key, result, decision: decideClaimOutcome({ attemptKey: key, result, alreadyLaunchedKeys: launched }) };
}

test('two instances racing on the same observed sequence: exactly one fresh launch (§5.3)', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  const seq = l.threads.get(T)!.latestSequence;
  const k1 = claimKeyFor(I1, T, N1, seq); const k2 = claimKeyFor(I2, T, N2, seq);
  const r1 = l.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: k1, expectedSequence: seq, payload: { claimKey: k1 } });
  const r2 = l.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: k2, expectedSequence: seq, payload: { claimKey: k2 } });
  assert.equal(decideClaimOutcome({ attemptKey: k1, result: r1, alreadyLaunchedKeys: new Set() }).action, 'launch');
  assert.deepEqual(decideClaimOutcome({ attemptKey: k2, result: r2, alreadyLaunchedKeys: new Set() }), { action: 'skip', reason: 'lost_race' });
  assert.equal(r2.ok ? '' : r2.errorCode, 'sequence_conflict');
});

test('a later instance seeing the owned thread gets invalid_transition and skips', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  claim(l, I1, N1);
  const seq = l.threads.get(T)!.latestSequence;
  const k = claimKeyFor(I2, T, N2, seq);
  const r = l.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: k, expectedSequence: seq, payload: { claimKey: k } });
  assert.deepEqual(decideClaimOutcome({ attemptKey: k, result: r, alreadyLaunchedKeys: new Set() }), { action: 'skip', reason: 'lost_race' });
});

test('same-process replay after an ambiguous send never double-launches', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  const first = claim(l, I1, N1);
  assert.equal(first.decision.action, 'launch');
  const launched = new Set([first.key]);
  const replay = l.append({ threadId: T, actor: W, eventType: 'accepted', idempotencyKey: first.key, expectedSequence: 2, payload: { claimKey: first.key } });
  assert.equal(replay.ok && replay.deduplicated, true);
  assert.equal(decideClaimOutcome({ attemptKey: first.key, result: replay, alreadyLaunchedKeys: launched }).action, 'already_launched');
});

test('reassign away and back yields a NEW claim key; the old acceptance can never be replayed into a launch', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  const first = claim(l, I1, N1);
  l.append({ threadId: T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'test-reassign-away', expectedSequence: l.threads.get(T)!.latestSequence, recipientActor: 'alden' });
  l.append({ threadId: T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'test-reassign-back', expectedSequence: l.threads.get(T)!.latestSequence, recipientActor: W });
  const second = claim(l, I1, N1, new Set([first.key]));
  assert.notEqual(second.key, first.key);
  assert.equal(second.decision.action, 'launch');
});

test('a key match returning another operation halts as idempotency_conflict', () => {
  const d = decideClaimOutcome({ attemptKey: 'k', result: { ok: true, deduplicated: true, event: { eventType: 'completed', payload: { claimKey: 'k' } } }, alreadyLaunchedKeys: new Set() });
  assert.deepEqual(d, { action: 'halt', reason: 'idempotency_conflict' });
});

test('transport and 5xx errors reconcile; 403/404 skip; unknown errors halt', () => {
  const d = (errorCode: string, httpStatus?: number) => decideClaimOutcome({ attemptKey: 'k', result: { ok: false, errorCode, httpStatus }, alreadyLaunchedKeys: new Set() }).action;
  assert.equal(d('timeout'), 'reconcile');
  assert.equal(d('server_error', 503), 'reconcile');
  assert.equal(d('not_participant', 403), 'skip');
  assert.equal(d('weird_code', 418), 'halt');
});

test('completion requires evidence on the event itself (R1, fake mirrors real rule)', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  claim(l, I1, N1);
  const seq = l.threads.get(T)!.latestSequence;
  const bare = l.append({ threadId: T, actor: W, eventType: 'completed', idempotencyKey: 'test-complete-bare', expectedSequence: seq, payload: {} });
  assert.equal(bare.ok ? '' : bare.errorCode, 'completion_evidence_required');
  const ev = buildCompletionEvidence('d'.repeat(40), [{ path: 'docs/a.md', startLine: 1, endLine: 2, excerptSha256: 'e'.repeat(64), excerpt: 'x' }]);
  const done = l.append({ threadId: T, actor: W, eventType: 'completed', idempotencyKey: 'test-complete-ev', expectedSequence: seq, payload: {}, evidence: ev });
  assert.equal(done.ok, true);
});

test('after reassignment to another actor the old worker is not a participant and cannot block (R2)', () => {
  const l = new FakeLedger(); l.createThread(T, 'luca-replit', W);
  claim(l, I1, N1);
  l.append({ threadId: T, actor: 'luca-replit', eventType: 'reassigned', idempotencyKey: 'test-reassign-1', expectedSequence: l.threads.get(T)!.latestSequence, recipientActor: 'alden' });
  assert.deepEqual(l.read(T, W), { ok: false, error: 'not_participant' });
  const b = l.append({ threadId: T, actor: W, eventType: 'blocked', idempotencyKey: 'test-block-after', expectedSequence: l.threads.get(T)!.latestSequence, payload: {} });
  assert.equal(b.ok, false);
});

test('fencing requires actor ownership, this claim key and an active state (§5.4)', () => {
  assert.deepEqual(checkFence({ currentOwner: W, state: 'accepted', latestAcceptedClaimKey: 'k1' }, W, 'k1'), { ok: true });
  assert.deepEqual(checkFence({ currentOwner: null, state: 'reassigned', latestAcceptedClaimKey: 'k1' }, W, 'k1'), { ok: false, reason: 'not_owner' });
  assert.deepEqual(checkFence({ currentOwner: W, state: 'accepted', latestAcceptedClaimKey: 'k2' }, W, 'k1'), { ok: false, reason: 'claim_superseded' });
});

const wd = (o: Partial<WatchdogInput> = {}): WatchdogInput => ({
  nowMs: 1000, runDeadlineMs: 10_000, windowEndMs: 20_000, jobDeadlineMs: 30_000,
  charterRead: { ok: true, value: { approvalState: 'approved' } },
  threadRead: { ok: true, value: { currentOwner: W, state: 'in_progress', latestAcceptedClaimKey: 'k' } },
  consecutiveUnknown: 0, workerActor: W, claimKey: 'k', ...o,
});

test('watchdog: local deadlines stop even with no network result (R5)', () => {
  assert.deepEqual(decideWatchdog(wd({ nowMs: 10_000, charterRead: null, threadRead: null })), { action: 'stop', failureClass: 'timeout', ownerWritable: true });
  assert.deepEqual(decideWatchdog(wd({ nowMs: 25_000, runDeadlineMs: 99_999, charterRead: null, threadRead: null })), { action: 'stop', failureClass: 'window_closed', ownerWritable: true });
});

test('watchdog: not_participant or a fence failure is authority_lost with no owner write (R2)', () => {
  assert.deepEqual(decideWatchdog(wd({ threadRead: { ok: false, error: 'not_participant' } })), { action: 'stop', failureClass: 'authority_lost', ownerWritable: false });
  assert.deepEqual(decideWatchdog(wd({ threadRead: { ok: true, value: { currentOwner: null, state: 'reassigned', latestAcceptedClaimKey: 'k' } } })).action, 'stop');
});

test('watchdog: revocation stops with owner write; two consecutive unknown reads stop as authority_unknown', () => {
  assert.deepEqual(decideWatchdog(wd({ charterRead: { ok: true, value: { approvalState: 'revoked' } } })), { action: 'stop', failureClass: 'charter_revoked', ownerWritable: true });
  const first = decideWatchdog(wd({ charterRead: { ok: false, error: 'timeout' } }));
  assert.deepEqual(first, { action: 'continue', consecutiveUnknown: 1 });
  assert.deepEqual(decideWatchdog(wd({ charterRead: { ok: false, error: 'timeout' }, consecutiveUnknown: 1 })), { action: 'stop', failureClass: 'authority_unknown', ownerWritable: false });
  assert.deepEqual(decideWatchdog(wd({ consecutiveUnknown: 1 })), { action: 'continue', consecutiveUnknown: 0 });
});

const op = (key: string, eventType: 'completed' | 'blocked', payload: unknown, evidence: unknown[] = [], content = 'c') =>
  freezeOutboxEntry({ key, threadId: T, op: eventType, eventType, content, recipientActor: null, claimKey: 'claim-k', payload, evidence });

test('outbox: reconciliation matches key + operation + payload + evidence + content', () => {
  const e = op('k1', 'completed', { a: 1 }, [{ type: 'commit' }]);
  const ev = (o: Record<string, unknown>) => ({ idempotencyKey: 'k1', eventType: 'completed', payload: { a: 1 }, evidence: [{ type: 'commit' }], content: 'c', recipientActor: null, ...o }) as ThreadEventLite;
  assert.equal(reconcileOutboxEntry(e, []), 'absent');
  assert.equal(reconcileOutboxEntry(e, [ev({})]), 'sent');
  assert.equal(reconcileOutboxEntry(e, [ev({ payload: { a: 2 } })]), 'idempotency_conflict');
  assert.equal(reconcileOutboxEntry(e, [ev({ eventType: 'blocked' })]), 'idempotency_conflict');
  assert.equal(reconcileOutboxEntry(e, [ev({ content: 'other' })]), 'idempotency_conflict', 'same payload, different content is not the frozen operation');
  assert.equal(reconcileOutboxEntry(e, [ev({ recipientActor: 'alden' })]), 'idempotency_conflict', 'recipient is part of the frozen operation');
  // Review item 3: an omitted field is never filled from the request; equality stays unproven.
  assert.equal(reconcileOutboxEntry(e, [ev({ content: undefined })]), 'unverifiable');
  assert.equal(reconcileOutboxEntry(e, [ev({ evidence: undefined })]), 'unverifiable');
  assert.equal(reconcileOutboxEntry(e, [ev({ recipientActor: undefined })]), 'unverifiable');
  assert.equal(reconcileOutboxEntry(e, [ev({ content: undefined, payload: { a: 2 } })]), 'idempotency_conflict', 'a present mismatch wins over an omission');
});

test('compareEventToEntry: append responses are compared without synthesizing omitted fields', () => {
  const e = op('k1', 'blocked', { a: 1 });
  assert.equal(compareEventToEntry(e, { eventType: 'blocked', payload: { a: 1 }, evidence: [], content: 'c', recipientActor: null }), 'match');
  assert.equal(compareEventToEntry(e, { eventType: 'blocked', payload: { a: 1 } }), 'incomplete');
  assert.equal(compareEventToEntry(e, { eventType: 'blocked', payload: { a: 1 }, evidence: [], content: 'c' }), 'incomplete', 'recipient omitted');
  assert.equal(compareEventToEntry(e, { eventType: 'blocked', payload: { a: 1 }, evidence: [{}], content: 'c', recipientActor: null }), 'mismatch');
});

test('outbox: only complete v2 entries whose digests match their bytes are intact', () => {
  const e = op('k1', 'blocked', { a: 1 });
  assert.equal(isIntactOutboxEntry(e), true);
  assert.equal(isIntactOutboxEntry(JSON.parse(JSON.stringify(e))), true, 'survives a persistence round trip');
  assert.equal(isIntactOutboxEntry({ ...e, content: 'tampered' }), false);
  assert.equal(isIntactOutboxEntry({ ...e, payload: { a: 2 } }), false);
  assert.equal(isIntactOutboxEntry({ ...e, claimKey: null }), false, 'an owner write must be bound to a claim');
  const { version: _v, ...legacy } = e;
  assert.equal(isIntactOutboxEntry(legacy), false, 'pre-v2 entries are refused, not guessed');
});

test('outbox: sequence conflicts refresh and resend at most 5 times; others at most 3; abandoned entries do not block', () => {
  assert.deepEqual(decideResend('sequence_conflict', 4), { action: 'resend', refreshSequence: true });
  assert.deepEqual(decideResend('sequence_conflict', 5), { action: 'give_up', state: 'send_ambiguous' });
  assert.deepEqual(decideResend('timeout', 2), { action: 'resend', refreshSequence: false });
  assert.deepEqual(decideResend('timeout', 3), { action: 'give_up', state: 'send_ambiguous' });
  const sent = { ...op('a', 'completed', {}), state: 'sent' as const };
  const abandoned = { ...op('b', 'blocked', {}), state: 'abandoned_authority_lost' as const };
  const neverApplied = { ...op('d', 'blocked', {}), state: 'not_applied' as const };
  assert.equal(outboxBlocksClaims([sent, abandoned, neverApplied]), false);
  assert.equal(outboxBlocksClaims([sent, { ...op('c', 'completed', {}), state: 'send_ambiguous' as const }]), true);
  assert.equal(outboxBlocksClaims([{ ...op('e', 'completed', {}), state: 'pending' as const }]), true);
});

test('recovery touches only threads this worker owns with THIS instanceId (§5.9)', () => {
  const ids = selectOwnRecoveries([
    { threadId: 'mine', state: 'in_progress', currentOwner: W, latestAcceptedPayload: { instanceId: I1 } },
    { threadId: 'other-instance', state: 'in_progress', currentOwner: W, latestAcceptedPayload: { instanceId: I2 } },
    { threadId: 'human', state: 'accepted', currentOwner: W, latestAcceptedPayload: null },
    { threadId: 'reassigned', state: 'reassigned', currentOwner: null, latestAcceptedPayload: { instanceId: I1 } },
    { threadId: 'done', state: 'completed', currentOwner: W, latestAcceptedPayload: { instanceId: I1 } },
  ], W, I1);
  assert.deepEqual(ids, ['mine']);
});
