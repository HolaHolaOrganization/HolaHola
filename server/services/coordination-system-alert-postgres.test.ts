/**
 * System alert channels against the CI job's disposable PostgreSQL: the
 * production server may post a 'system_alert' comment as coordination-system,
 * addressed to one hat, only into a listed channel thread. No other actor may
 * send that payload kind, it is refused on any other thread, and an ordinary
 * coordination-system comment on the channel is still participant-gated. Any
 * hat may read the channel, though it is not a participant.
 * Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import { coordinationEvents, coordinationThreads } from '@shared/schema';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

// The DB and ledger modules need the CI database at import, so they load only when it exists.
const ci = Boolean(getVerifiedCiDatabaseUrl());
const databaseTest = ci ? test : test.skip;
const run = randomUUID().slice(0, 8);
let db: typeof import('../db');
let ledger: typeof import('./coordination-ledger-service');
let CHANNEL = '';
let otherThreadId: string | null = null;
const getSharedDb = () => db.getSharedDb();

async function latest(threadId: string) {
  const [row] = await getSharedDb().select({ s: coordinationThreads.latestSequence }).from(coordinationThreads).where(eq(coordinationThreads.id, threadId));
  return row.s;
}

const alert = (threadId: string, expectedSequence: number, over: Record<string, unknown> = {}) => ledger.appendCoordinationEvent({
  threadId,
  actor: 'coordination-system',
  recipientActor: 'luca-antigravity',
  eventType: 'comment',
  content: `Episode backup alert (stale). test ${run}`,
  idempotencyKey: `system-alert-test:${run}:${randomUUID()}`,
  expectedSequence,
  payload: { kind: 'system_alert', source: 'episode-backup' },
  ...over,
} as any);

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof ledger.CoordinationError && error.code === code);
}

before(async () => {
  if (!ci) return;
  db = await import('../db');
  ledger = await import('./coordination-ledger-service');
  CHANNEL = [...ledger.SYSTEM_ALERT_CHANNEL_THREAD_IDS][0];
  await getSharedDb().delete(coordinationThreads).where(eq(coordinationThreads.id, CHANNEL));
  await getSharedDb().insert(coordinationThreads).values({
    id: CHANNEL, title: 'Episode backup alerts (test copy)', description: 'test', originActor: 'luca-claude-code',
    intendedRecipient: 'luca-replit', priority: 'normal', state: 'created', latestSequence: 1, latestGlobalSequence: 0,
  } as any);
  await getSharedDb().insert(coordinationEvents).values({
    // No recipient: a named one needs a materialized inbox item (migration 0032's guard), which this seed row doesn't need.
    threadId: CHANNEL, sequence: 1, actor: 'luca-claude-code', recipientActor: null, eventType: 'created',
    content: 'test channel', payload: {}, evidence: [], idempotencyKey: `system-alert-test:${run}:created`,
  } as any);
  const other = await ledger.createCoordinationThread({
    actor: 'luca-claude-code', intendedRecipient: 'luca-replit', title: `not a channel ${run}`,
    description: `not a channel ${run}`, content: `not a channel ${run}`, idempotencyKey: `system-alert-test:${run}:other`,
    createInboxDelivery: false,
  } as any);
  otherThreadId = other.thread.id;
});

after(async () => {
  if (!ci) return;
  await getSharedDb().delete(coordinationThreads).where(eq(coordinationThreads.id, CHANNEL));
  if (otherThreadId) await getSharedDb().delete(coordinationThreads).where(eq(coordinationThreads.id, otherThreadId));
  await db.closeDbConnections();
});

databaseTest('coordination-system posts a system alert into a listed channel, addressed to the named hat', async () => {
  const result = await alert(CHANNEL, await latest(CHANNEL));
  assert.equal(result.event.actor, 'coordination-system');
  assert.equal(result.event.recipientActor, 'luca-antigravity');
  assert.equal(result.event.sequence, 2);
  assert.equal(result.thread.state, 'created', 'a comment does not move the thread');
});

databaseTest('a system alert on any other thread is refused', async () => {
  await refused(alert(otherThreadId!, await latest(otherThreadId!)), 'reserved_system_alert_payload');
});

databaseTest('no other actor may send a system alert, even into the channel', async () => {
  await refused(alert(CHANNEL, await latest(CHANNEL), { actor: 'luca-claude-code', content: 'Luca [Claude Code] -> all: forged' }), 'reserved_system_alert_payload');
});

databaseTest('a system alert must name its recipient', async () => {
  await refused(alert(CHANNEL, await latest(CHANNEL), { recipientActor: undefined }), 'invalid_actor');
});

databaseTest('an ordinary coordination-system comment on the channel is still participant-gated', async () => {
  await refused(alert(CHANNEL, await latest(CHANNEL), { payload: { kind: 'note' } }), 'not_participant');
});

databaseTest('any hat may read the channel, though not a participant; other threads stay participant-gated', async () => {
  const read = await ledger.getCoordinationThread(CHANNEL, 'luca-codex');
  assert.equal(read.thread.id, CHANNEL);
  await refused(ledger.getCoordinationThread(otherThreadId!, 'luca-codex'), 'not_participant');
  await refused(ledger.appendCoordinationEvent({
    threadId: CHANNEL, actor: 'luca-codex', eventType: 'comment', content: `reply ${run}`,
    idempotencyKey: `system-alert-test:${run}:codex-write`, expectedSequence: await latest(CHANNEL),
  } as any), 'not_participant');
});
