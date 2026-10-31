/**
 * The Alden inbox wake ledger (design eb2ed6bf r11, build step W2a) against
 * the CI job's disposable PostgreSQL, through the real coordination ledger.
 * Scenarios run in order on one database and each starts by draining any
 * eligible item the previous one left, because a claim takes the oldest
 * eligible item globally. Synthetic threads only; everything is removed after.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const url = getVerifiedCiDatabaseUrl();
const runId = randomUUID().slice(0, 8);
const threads: string[] = [];
let n = 0;
let db: any;
let wake: typeof import('./alden-wake-ledger');
let ledger: typeof import('./coordination-ledger-service');
let priorCursor: number | null = null;
const costRows: string[] = [];

const rows = async (query: any) => ((await db.execute(query)) as any).rows as any[];
const one = async (query: any) => (await rows(query))[0];

before(async () => {
  if (!url) return;
  db = (await import('../db')).getSharedDb();
  const inbox = await import('./coordination-inbox-service');
  wake = await import('./alden-wake-ledger');
  ledger = await import('./coordination-ledger-service');
  process.env.COORDINATION_INBOX_TOKEN_SECRET ??= 'w'.repeat(32);
  await db.execute(sql`insert into coordination_inbox_activation (id, schema_version, recipient_rule_version, state)
    values (${inbox.COORDINATION_INBOX_ACTIVATION_ID}, ${inbox.COORDINATION_INBOX_SCHEMA_VERSION}, ${inbox.COORDINATION_INBOX_RECIPIENT_RULE_VERSION}, 'active')
    on conflict (id) do update set state = 'active', schema_version = excluded.schema_version, recipient_rule_version = excluded.recipient_rule_version`);
  priorCursor = (await one(sql`select acknowledged_event_global_sequence as v from coordination_inbox_cursors where recipient_actor = 'alden'`))?.v ?? null;
  await db.execute(sql`delete from alden_wake_attempts`);
  await db.execute(sql`update alden_wake_control set enabled = true, cutoff_global_sequence = null, activated_at = null where id = 'alden'`);
});

after(async () => {
  if (!url) return;
  await db.execute(sql`delete from alden_wake_attempts`);
  await db.execute(sql`delete from alden_wake_thread_pauses where thread_id in (select value from jsonb_array_elements_text(${JSON.stringify(threads)}::jsonb) as value)`);
  for (const id of threads) await db.execute(sql`delete from coordination_threads where id = ${id}`);
  await db.execute(sql`delete from alden_notifications where triggered_by = 'alden-wake'`);
  for (const id of costRows) await db.execute(sql`delete from ai_cost_logs where id = ${id}`);
  await db.execute(sql`update alden_wake_control set enabled = true, cutoff_global_sequence = null, activated_at = null where id = 'alden'`);
  if (priorCursor === null) await db.execute(sql`delete from coordination_inbox_cursors where recipient_actor = 'alden'`);
  else await db.execute(sql`update coordination_inbox_cursors set acknowledged_event_global_sequence = ${priorCursor} where recipient_actor = 'alden'`);
  await (await import('../db')).closeDbConnections();
});

const skipUnlessCi = (context: any) => {
  if (url) return false;
  context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
  return true;
};

/** A new thread to Alden; its created event is an Alden inbox item. */
async function newThread(sender: string, content: string) {
  const created = await ledger.createCoordinationThread({
    actor: sender as any, intendedRecipient: 'alden', title: `wake test ${runId} ${n}`, description: content, content,
    idempotencyKey: `wake-test:${runId}:${n++}`,
  });
  threads.push(created.thread.id);
  await wake.seedWakeAttempts(db);
  return { threadId: created.thread.id, eventId: created.event.id, itemId: (await wake.findAldenItemByEvent(created.event.id, db))! };
}

async function append(threadId: string, actor: string, content: string, recipient: string, idempotencyKey = `wake-test:${runId}:${n++}`) {
  const { latest_sequence: seq } = await one(sql`select latest_sequence from coordination_threads where id = ${threadId}`);
  return ledger.appendCoordinationEvent({ threadId, actor: actor as any, eventType: 'comment', content, recipientActor: recipient as any, idempotencyKey, expectedSequence: Number(seq) });
}

/** Another message to Alden on an existing thread. */
async function ask(threadId: string, sender: string, content: string) {
  const { event } = await append(threadId, sender, content, 'alden');
  await wake.seedWakeAttempts(db);
  return { threadId, eventId: event.id, itemId: (await wake.findAldenItemByEvent(event.id, db))! };
}

const state = async (itemId: string) => (await one(sql`select state from alden_wake_attempts where inbox_item_id = ${itemId}`))?.state;
const drain = () => db.execute(sql`update alden_wake_attempts set state = 'manual', notes = 'test drain' where state = 'eligible'`);
const eventsUnderKey = async (itemId: string) => Number((await one(sql`select count(*)::int as c from coordination_events where actor = 'alden' and idempotency_key = ${`alden-wake:${itemId}`}`)).c);

async function claimItem(itemId: string, workerId = 'worker-a', options: any = {}) {
  const result = await wake.claimNextWakeItem(workerId, options, db);
  assert.equal(result.status, 'claimed', JSON.stringify(result));
  assert.equal((result as any).attempt.inboxItemId, itemId);
  return (result as any).attempt;
}

test('activation: one cutoff from the event stream, and history is classified by global sequence', async (context) => {
  if (skipUnlessCi(context)) return;
  const old = await ledger.createCoordinationThread({ actor: 'luca-claude-code', intendedRecipient: 'alden', title: `wake test ${runId} history`, description: 'before activation', idempotencyKey: `wake-test:${runId}:${n++}` });
  threads.push(old.thread.id);
  // An event that exists at activation but whose Alden item materializes late (LR's 100/105 case).
  const late = await append(old.thread.id, 'luca-claude-code', 'late-materialized', 'luca-replit');
  const [a, b] = await Promise.all([wake.activateWake(db), wake.activateWake(db)]);
  assert.equal(a.cutoff, b.cutoff, 'two instances starting together see one cutoff');
  const { max } = await one(sql`select max(global_sequence) as max from coordination_events`);
  assert.equal(a.cutoff, Number(max));
  assert.equal((await wake.activateWake(db)).cutoff, a.cutoff, 'a restart reads the stored cutoff');
  await db.execute(sql`insert into coordination_inbox_items (recipient_actor, coordination_event_id, coordination_thread_id, event_global_sequence, sender_actor, message_kind, recipient_rule_version)
    values ('alden', ${late.event.id}, ${old.thread.id}, ${late.event.globalSequence}, 'luca-claude-code', 'comment', 1)`);
  await wake.seedWakeAttempts(db);
  await wake.seedWakeAttempts(db); // idempotent
  assert.equal(await state((await wake.findAldenItemByEvent(old.event.id, db))!), 'history');
  assert.equal(await state((await wake.findAldenItemByEvent(late.event.id, db))!), 'history', 'a late item for an old event is history');
  const fresh = await newThread('luca-claude-code', 'after activation');
  assert.equal(await state(fresh.itemId), 'eligible');
  const pending = await wake.listWakePending({}, db);
  assert.ok(pending.history.count >= 2);
});

test('claim: two workers, one claim; the emergency stop is ordered against claims', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', 'one item, two workers');
  const results = await Promise.all([wake.claimNextWakeItem('worker-a', {}, db), wake.claimNextWakeItem('worker-b', {}, db)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['claimed', 'none']);
  const won = results.find((r) => r.status === 'claimed') as any;
  assert.equal(won.attempt.inboxItemId, item.itemId);
  assert.equal(won.attempt.claimEpoch, 1);

  await drain();
  const stopped = await newThread('luca-claude-code', 'while stopped');
  await wake.setWakeEnabled(false, 'david', db);
  assert.equal((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'stopped');
  assert.equal(await state(stopped.itemId), 'eligible', 'a stop holds items, never hides them');
  await wake.setWakeEnabled(true, 'david', db);
  await claimItem(stopped.itemId);
});

test('publication: bound reply, read-back, notice, audit and a cursor that never passes an open item', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', 'please confirm');
  const waiting = await newThread('luca-replit', 'still open');
  const attempt = await claimItem(item.itemId);
  const result = await wake.publishAldenItemResponse({ inboxItemId: item.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Confirmed (unattended turn).', model: 'gemini-test' }, db);
  assert.equal(result.status, 'replied');
  const event = await one(sql`select * from coordination_events where id = ${(result as any).replyEventId}`);
  assert.equal(event.thread_id, item.threadId);
  assert.equal(event.recipient_actor, 'luca-claude-code', 'the server binds the recipient to the requester');
  assert.equal(event.idempotency_key, `alden-wake:${item.itemId}`);
  assert.equal(await state(item.itemId), 'replied');
  assert.equal((await one(sql`select count(*)::int as c from alden_wake_notice_outbox where inbox_item_id = ${item.itemId}`)).c, 1);
  assert.equal((await one(sql`select result from alden_wake_attempt_audit where inbox_item_id = ${item.itemId} order by created_at desc limit 1`)).result, 'published');
  const cursor = Number((await one(sql`select acknowledged_event_global_sequence as v from coordination_inbox_cursors where recipient_actor = 'alden'`)).v);
  const waitingSeq = Number((await one(sql`select event_global_sequence as v from alden_wake_attempts where inbox_item_id = ${waiting.itemId}`)).v);
  assert.ok(cursor < waitingSeq, `cursor ${cursor} stays below the open item ${waitingSeq}`);

  // A second publish for the same item is fenced (the item is no longer claimed): nothing new is posted.
  const again = await wake.publishAldenItemResponse({ inboxItemId: item.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Confirmed (unattended turn).' }, db);
  assert.equal(again.status, 'superseded');
  assert.equal(await eventsUnderKey(item.itemId), 1);

  // Notices: delivered once, and a second deliverer finds nothing.
  const first = await wake.deliverWakeNotices(db);
  assert.ok(first.delivered >= 1);
  assert.equal((await one(sql`select count(*)::int as c from alden_notifications where fingerprint = ${`alden_wake:${item.itemId}:replied`}`)).c, 1);
  await db.execute(sql`update alden_wake_notice_outbox set status = 'pending' where inbox_item_id = ${item.itemId}`);
  await wake.deliverWakeNotices(db); // a crash after the insert, before marking delivered
  assert.equal((await one(sql`select count(*)::int as c from alden_notifications where fingerprint = ${`alden_wake:${item.itemId}:replied`}`)).c, 1, 'the read-back by fingerprint prevents a duplicate');
});

test('identical retry is deduplicated; a different payload under the key is a conflict', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const same = await newThread('luca-claude-code', 'retry same');
  let attempt = await claimItem(same.itemId);
  await append(same.threadId, 'alden', 'Identical body.', 'luca-claude-code', `alden-wake:${same.itemId}`); // an earlier crash's effect
  const deduped = await wake.publishAldenItemResponse({ inboxItemId: same.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Identical body.' }, db);
  assert.equal(deduped.status, 'replied');
  assert.equal((deduped as any).deduplicated, true);
  assert.equal(await eventsUnderKey(same.itemId), 1);

  const differ = await newThread('luca-claude-code', 'retry different');
  attempt = await claimItem(differ.itemId);
  await append(differ.threadId, 'alden', 'First body.', 'luca-claude-code', `alden-wake:${differ.itemId}`);
  const conflict = await wake.publishAldenItemResponse({ inboxItemId: differ.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Second body.' }, db);
  assert.equal(conflict.status, 'conflict');
  assert.equal(await state(differ.itemId), 'conflict');
  assert.equal(await eventsUnderKey(differ.itemId), 1, 'never reported as delivery of a second payload');
});

test('chat and wake race in both orders; a stale worker never overwrites the winner', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const chatFirst = await newThread('luca-claude-code', 'chat first');
  const attempt = await claimItem(chatFirst.itemId);
  const chat = await wake.publishAldenItemResponse({ inboxItemId: chatFirst.itemId, mode: 'chat', workerId: 'alden-chat', content: 'Answered with David here.' }, db);
  assert.equal(chat.status, 'handled_in_chat');
  assert.equal(Number((await one(sql`select claim_epoch from alden_wake_attempts where inbox_item_id = ${chatFirst.itemId}`)).claim_epoch), attempt.claimEpoch + 1, 'chat bumps the epoch of a claimed item');
  const late = await wake.publishAldenItemResponse({ inboxItemId: chatFirst.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Wake reply.' }, db);
  assert.equal(late.status, 'superseded');
  assert.equal(await wake.recordWakeOutcome({ inboxItemId: chatFirst.itemId, workerId: 'worker-a', claimEpoch: attempt.claimEpoch, outcome: 'declined' }, db), 'superseded');
  assert.equal(await state(chatFirst.itemId), 'handled_in_chat');
  assert.equal((await one(sql`select count(*)::int as c from alden_wake_attempt_audit where inbox_item_id = ${chatFirst.itemId} and result = 'superseded'`)).c, 2);

  await drain();
  const wakeFirst = await newThread('luca-claude-code', 'wake first');
  const claimed = await claimItem(wakeFirst.itemId);
  assert.equal((await wake.publishAldenItemResponse({ inboxItemId: wakeFirst.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: claimed.claimEpoch, content: 'Wake reply.' }, db)).status, 'replied');
  const second = await wake.publishAldenItemResponse({ inboxItemId: wakeFirst.itemId, mode: 'chat', workerId: 'alden-chat', content: 'Chat reply.' }, db);
  assert.deepEqual(second, { status: 'already_answered', state: 'replied' });
  assert.equal(await eventsUnderKey(wakeFirst.itemId), 1);
});

test('lease: a late worker is refused before any reconciliation, including after a lock wait past expiry', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const expired = await newThread('luca-claude-code', 'late completion');
  const attempt = await claimItem(expired.itemId);
  await db.execute(sql`update alden_wake_attempts set lease_until = clock_timestamp() - interval '1 second' where inbox_item_id = ${expired.itemId}`);
  const late = await wake.publishAldenItemResponse({ inboxItemId: expired.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Too late.' }, db);
  assert.equal(late.status, 'superseded');
  assert.equal(await eventsUnderKey(expired.itemId), 0);
  assert.equal(await state(expired.itemId), 'claimed', 'the disposition is left for the reconcile');

  // r7: the worker's transaction starts before expiry, waits on the item lock until after it.
  await drain();
  const waiting = await newThread('luca-claude-code', 'lock wait');
  const held = await claimItem(waiting.itemId);
  await db.execute(sql`update alden_wake_attempts set lease_until = clock_timestamp() + interval '2 seconds' where inbox_item_id = ${waiting.itemId}`);
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  await holder.query('begin');
  await holder.query('select 1 from alden_wake_attempts where inbox_item_id = $1 for update', [waiting.itemId]);
  const publishing = wake.publishAldenItemResponse({ inboxItemId: waiting.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: held.claimEpoch, content: 'Waited.' }, db);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await holder.query('commit');
  await holder.end();
  assert.equal((await publishing).status, 'superseded', 'lease authority is clock_timestamp() after the lock, not transaction start');
  assert.equal(await eventsUnderKey(waiting.itemId), 0);
});

test('atomic boundary: a crash before commit leaves nothing; the reconcile recovers a committed reply or marks uncertain', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const crash = await newThread('luca-claude-code', 'crash before commit');
  const sibling = await ask(crash.threadId, 'luca-claude-code', 'a second question');
  const attempt = await claimItem(crash.itemId);
  await assert.rejects(wake.publishAldenItemResponse({ inboxItemId: crash.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Never lands.', covers: [sibling.eventId], beforeCommit: () => { throw new Error('simulated crash'); } }, db), /simulated crash/);
  assert.equal(await eventsUnderKey(crash.itemId), 0);
  assert.equal(await state(crash.itemId), 'claimed');
  assert.equal(await state(sibling.itemId), 'eligible');

  // Recovered: the reply is on the ledger under the full read-back contract, with recorded coverage.
  const body = 'Recovered body.';
  await db.execute(sql`update alden_wake_attempts set reply_payload_sha256 = encode(sha256(convert_to(${body}, 'UTF8')), 'hex'),
    requested_covers = array[${sibling.eventId}]::text[], lease_until = clock_timestamp() - interval '1 second' where inbox_item_id = ${crash.itemId}`);
  await append(crash.threadId, 'alden', body, 'luca-claude-code', `alden-wake:${crash.itemId}`);
  // Wrong recipient on another expired claim: uncertain.
  const wrong = await newThread('luca-claude-code', 'wrong recipient');
  await db.execute(sql`update alden_wake_attempts set state = 'claimed', claimed_by = 'worker-a', claimed_at = clock_timestamp(), lease_until = clock_timestamp() - interval '1 second',
    reply_payload_sha256 = encode(sha256(convert_to('Misaddressed.', 'UTF8')), 'hex') where inbox_item_id = ${wrong.itemId}`);
  await append(wrong.threadId, 'alden', 'Misaddressed.', 'luca-replit', `alden-wake:${wrong.itemId}`);
  const result = await wake.reconcileWake(db);
  assert.ok(result.recovered >= 1 && result.uncertain >= 1, JSON.stringify(result));
  assert.equal(await state(crash.itemId), 'replied');
  assert.equal(await state(sibling.itemId), 'covered', 'recorded coverage is applied on recovery');
  assert.equal(await state(wrong.itemId), 'uncertain');
  assert.notEqual((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'claimed', 'an uncertain item is never re-claimed');
});

test('coverage: same thread and same requester only; refusals keep their obligations', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const trigger = await newThread('luca-claude-code', 'first ask');
  const same = await ask(trigger.threadId, 'luca-claude-code', 'second ask');
  const otherRequester = await ask(trigger.threadId, 'luca-holahola', 'a different requester');
  const otherThread = await newThread('luca-claude-code', 'another thread');
  const foreign = randomUUID();
  const attempt = await claimItem(trigger.itemId);
  await db.execute(sql`update alden_wake_attempts set state = 'claimed', claimed_by = 'worker-b', claimed_at = clock_timestamp(), lease_until = clock_timestamp() + interval '5 minutes' where inbox_item_id = ${otherThread.itemId}`);
  const result = await wake.publishAldenItemResponse({
    inboxItemId: trigger.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Both answered.',
    covers: [same.eventId, otherRequester.eventId, otherThread.eventId, foreign, trigger.eventId],
  }, db) as any;
  assert.equal(result.status, 'replied');
  assert.deepEqual(result.covered, [same.eventId]);
  assert.deepEqual(Object.fromEntries(result.refusedCovers.map((r: any) => [r.eventId, r.reason])), {
    [otherRequester.eventId]: 'other_requester', [otherThread.eventId]: 'other_thread', [foreign]: 'not_an_alden_item', [trigger.eventId]: 'is_trigger',
  });
  const covered = await one(sql`select * from alden_wake_attempts where inbox_item_id = ${same.itemId}`);
  assert.equal(covered.state, 'covered');
  assert.equal(covered.covered_reply_event_id, result.replyEventId);
  assert.equal(await state(otherRequester.itemId), 'eligible');
  assert.equal(await state(otherThread.itemId), 'claimed', 'a claimed item is not overwritten');
});

test('chat guard: only structured coverage or an ack moves an item; an Alden comment alone does not', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', 'single item thread');
  await append(item.threadId, 'alden', 'An unrelated comment from chat.', 'luca-claude-code');
  assert.equal(await state(item.itemId), 'eligible');
  const ack = await wake.publishAldenItemResponse({ inboxItemId: item.itemId, mode: 'chat', workerId: 'alden-chat', note: 'handled with David' }, db);
  assert.equal(ack.status, 'handled_in_chat');
  assert.equal(await eventsUnderKey(item.itemId), 0, 'an ack publishes nothing');
  assert.equal((await one(sql`select count(*)::int as c from alden_wake_notice_outbox where inbox_item_id = ${item.itemId}`)).c, 0, 'David was present: no notice');
});

test('spending guard: no claim at budget, items stay eligible and listed as held, one alert per day', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', 'over budget');
  const [cost] = await rows(sql`insert into ai_cost_logs (logged_at, model, cost_usd, context) values (${Date.now()}, 'gemini-test', 10, 'alden-wake') returning id`);
  costRows.push(cost.id);
  assert.equal((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'spending');
  assert.equal((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'spending');
  assert.equal(await state(item.itemId), 'eligible');
  assert.equal((await one(sql`select count(*)::int as c from alden_notifications where fingerprint like 'alden_wake_spending:%'`)).c, 1);
  const pending = await wake.listWakePending({}, db);
  const held = pending.held.find((h) => h.eventId === item.eventId);
  assert.equal(held?.reason, 'spending', 'a brand-new held item is listed at once');
  assert.match(held!.resumeAt, /T00:00:00\.000Z$/);
  assert.equal((await wake.claimNextWakeItem('worker-a', { budgetUsd: 20 }, db)).status, 'claimed', 'a raised budget resumes');
  await db.execute(sql`delete from ai_cost_logs where id = ${cost.id}`);
});

test('loop breaker: a repeating exchange pauses its thread only, and every pause ends', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const sender = 'luca-claude-code';
  const loop = await newThread(sender, 'Are you there?');
  let item = loop;
  for (let round = 0; round < 3; round += 1) {
    const attempt = await claimItem(item.itemId);
    assert.equal((await wake.publishAldenItemResponse({ inboxItemId: item.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: attempt.claimEpoch, content: 'Yes, I am here.' }, db)).status, 'replied');
    item = await ask(loop.threadId, sender, 'Are you there?');
  }
  // Created after the loop's held item, so a claim reaching it proves the older held item was skipped.
  const other = await newThread('luca-replit', 'unrelated thread');
  // The loop thread's item is held; the other thread's item is claimed instead.
  await claimItem(other.itemId);
  const pause = await one(sql`select * from alden_wake_thread_pauses where thread_id = ${loop.threadId} and resumed_at is null`);
  assert.equal(pause.reason, 'repeating_exchange');
  assert.equal(pause.cooldown_minutes, 30);
  assert.equal(pause.evidence.counterpart, sender);
  assert.equal(await state(item.itemId), 'eligible');
  assert.equal((await one(sql`select count(*)::int as c from alden_notifications where fingerprint = ${`alden_wake_loop:${pause.id}`}`)).c, 1);
  const held = (await wake.listWakePending({}, db)).held.find((h) => h.eventId === item.eventId);
  assert.equal(held?.reason, 'repeating_exchange');
  assert.equal((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'none', 'still held: no new message, cooldown not over');

  // Cooldown: the next item is claimed once; repeating again re-pauses with the doubled cooldown.
  await db.execute(sql`update alden_wake_thread_pauses set paused_at = clock_timestamp() - interval '31 minutes', resume_at = clock_timestamp() - interval '1 minute' where id = ${pause.id}`);
  const afterCooldown = await claimItem(item.itemId);
  assert.equal((await one(sql`select resumed_by from alden_wake_thread_pauses where id = ${pause.id}`)).resumed_by, 'cooldown');
  await wake.publishAldenItemResponse({ inboxItemId: item.itemId, mode: 'wake', workerId: 'worker-a', claimEpoch: afterCooldown.claimEpoch, content: 'Yes, I am here.' }, db);
  item = await ask(loop.threadId, sender, 'Are you there?');
  assert.equal((await wake.claimNextWakeItem('worker-a', {}, db)).status, 'none');
  const repause = await one(sql`select * from alden_wake_thread_pauses where thread_id = ${loop.threadId} and resumed_at is null`);
  assert.equal(repause.cooldown_minutes, 60);

  // A new non-repeating message ends the pause in the next claim.
  await ask(loop.threadId, sender, 'Different question: what is the status of PR #159?');
  const resumed = await wake.claimNextWakeItem('worker-a', {}, db);
  assert.equal(resumed.status, 'claimed');
  assert.equal((await one(sql`select resumed_by from alden_wake_thread_pauses where id = ${repause.id}`)).resumed_by, 'new_message');

  // Explicit resume from chat.
  await db.execute(sql`insert into alden_wake_thread_pauses (thread_id, paused_at, reason, evidence, resume_at, cooldown_minutes)
    values (${loop.threadId}, clock_timestamp(), 'repeating_exchange', '{"lastSequence": 0, "replyHash": "x", "triggerHash": "y"}'::jsonb, clock_timestamp() + interval '30 minutes', 30)`);
  assert.equal(await wake.resumeWakeThread(loop.threadId, 'david', db), true);
  assert.equal(await wake.resumeWakeThread(loop.threadId, 'david', db), false);
});
