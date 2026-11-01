/**
 * Thread watch (wake design eb2ed6bf r12, build step W3) against the CI job's
 * disposable PostgreSQL, through the real coordination ledger. Covers LR's
 * binding conditions: forward-only by sequence; only content kinds; add and
 * remove refused for a self-add, an unreadable thread or no reason, and the
 * chat tools refused without David; the add/commit race and a late commit
 * resolved by the record; observe items under the spending guard with
 * addressed items claimed first; and the inbox untouched. Synthetic threads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const url = getVerifiedCiDatabaseUrl();
const runId = randomUUID().slice(0, 8);
const threads: string[] = [];
const costRows: string[] = [];
let n = 0;
let db: any;
let watch: typeof import('./alden-wake-watch');
let wake: typeof import('./alden-wake-ledger');
let worker: typeof import('./alden-wake-worker');
let ledger: typeof import('./coordination-ledger-service');
let tools: typeof import('./alden-functions');
let priorCursor: number | null = null;

const rows = async (query: any) => ((await db.execute(query)) as any).rows as any[];
const one = async (query: any) => (await rows(query))[0];

before(async () => {
  if (!url) return;
  db = (await import('../db')).getSharedDb();
  const inbox = await import('./coordination-inbox-service');
  watch = await import('./alden-wake-watch');
  wake = await import('./alden-wake-ledger');
  worker = await import('./alden-wake-worker');
  ledger = await import('./coordination-ledger-service');
  tools = await import('./alden-functions');
  process.env.COORDINATION_INBOX_TOKEN_SECRET ??= 'w'.repeat(32);
  await db.execute(sql`insert into coordination_inbox_activation (id, schema_version, recipient_rule_version, state)
    values (${inbox.COORDINATION_INBOX_ACTIVATION_ID}, ${inbox.COORDINATION_INBOX_SCHEMA_VERSION}, ${inbox.COORDINATION_INBOX_RECIPIENT_RULE_VERSION}, 'active')
    on conflict (id) do update set state = 'active', schema_version = excluded.schema_version, recipient_rule_version = excluded.recipient_rule_version`);
  priorCursor = (await one(sql`select acknowledged_event_global_sequence as v from coordination_inbox_cursors where recipient_actor = 'alden'`))?.v ?? null;
  await db.execute(sql`delete from alden_wake_attempts`);
  await db.execute(sql`update alden_wake_control set enabled = true, cutoff_global_sequence = null, activated_at = null where id = 'alden'`);
  await wake.activateWake(db);
});

after(async () => {
  if (!url) return;
  await db.execute(sql`delete from alden_wake_attempts`);
  for (const id of threads) await db.execute(sql`delete from coordination_threads where id = ${id}`);
  for (const id of costRows) await db.execute(sql`delete from ai_cost_logs where id = ${id}`);
  await db.execute(sql`delete from alden_notifications where triggered_by = 'alden-wake'`);
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

/** A thread between Luca [Claude Code] and Luca [Replit]: Alden is not a participant. */
async function pairThread(content: string) {
  const created = await ledger.createCoordinationThread({
    actor: 'luca-claude-code', intendedRecipient: 'luca-replit', title: `watch test ${runId} ${n}`, description: content, content,
    idempotencyKey: `watch-test:${runId}:${n++}`,
  });
  threads.push(created.thread.id);
  return created.thread.id as string;
}

async function comment(threadId: string, actor: string, content: string, recipient: string, eventType: 'comment' | 'steward_comment' = 'comment') {
  const { latest_sequence: seq } = await one(sql`select latest_sequence from coordination_threads where id = ${threadId}`);
  const result = await ledger.appendCoordinationEvent({ threadId, actor: actor as any, eventType, content, recipientActor: recipient as any,
    idempotencyKey: `watch-test:${runId}:${n++}`, expectedSequence: Number(seq) });
  return result.event as any;
}

/** A raw event at an explicit global sequence: how a late commit looks to the anti-join. */
async function rawEvent(threadId: string, eventType: string, actor: string, globalSequence?: number) {
  const id = randomUUID();
  const [{ max }] = await rows(sql`select coalesce(max(sequence), 0) + 1000 + ${n++} as max from coordination_events where thread_id = ${threadId}`);
  if (globalSequence === undefined) {
    await db.execute(sql`insert into coordination_events (id, thread_id, sequence, actor, event_type, content, idempotency_key)
      values (${id}, ${threadId}, ${max}, ${actor}, ${eventType}, 'raw', ${`watch-raw:${id}`})`);
  } else {
    await db.execute(sql`insert into coordination_events (id, global_sequence, thread_id, sequence, actor, event_type, content, idempotency_key)
      values (${id}, ${globalSequence}, ${threadId}, ${max}, ${actor}, ${eventType}, 'raw', ${`watch-raw:${id}`})`);
  }
  return id;
}

const watchedEvents = async (threadId: string) =>
  (await rows(sql`select event_id from coordination_watch_items where thread_id = ${threadId} and watcher = 'alden' order by event_global_sequence`)).map((r) => r.event_id);
const reserveSequence = async () => Number((await one(sql`select nextval(pg_get_serial_sequence('coordination_events', 'global_sequence')) as v`)).v);
const drain = () => db.execute(sql`update alden_wake_attempts set state = 'manual', notes = 'test drain' where state = 'eligible'`);

test('forward-only, content kinds only, never the watcher own events, never a duplicate of an inbox item; the inbox is untouched', async (context) => {
  if (skipUnlessCi(context)) return;
  const threadId = await pairThread('before the watch');
  await comment(threadId, 'luca-claude-code', 'history, before the watch', 'luca-replit');
  await watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'david', reason: 'onboarding test' }, db);
  assert.equal(await watch.materializeWatchItems(db), 0, 'history creates nothing');

  const content = await comment(threadId, 'luca-replit', 'a reply addressed to someone else', 'luca-claude-code');
  await rawEvent(threadId, 'progress', 'luca-claude-code');
  await comment(threadId, 'alden', 'Alden own steward comment', 'luca-replit', 'steward_comment');
  const addressed = await comment(threadId, 'luca-claude-code', 'addressed to Alden', 'alden');
  // The ledger reserves steward_comment for Alden; another actor's one can only be a raw row.
  const steward = { id: await rawEvent(threadId, 'steward_comment', 'luca-holahola') };

  const inboxBefore = JSON.stringify(await rows(sql`select id, recipient_actor, coordination_event_id, recipient_rule_version, message_kind from coordination_inbox_items where coordination_thread_id = ${threadId} order by id`));
  const activationBefore = JSON.stringify(await rows(sql`select id, schema_version, recipient_rule_version, state from coordination_inbox_activation`));
  await watch.materializeWatchItems(db);
  await watch.materializeWatchItems(db); // idempotent
  assert.deepEqual(await watchedEvents(threadId), [content.id, steward.id], 'only other actors content, not bookkeeping, not Alden own, not his addressed item');
  assert.equal(JSON.stringify(await rows(sql`select id, recipient_actor, coordination_event_id, recipient_rule_version, message_kind from coordination_inbox_items where coordination_thread_id = ${threadId} order by id`)), inboxBefore, 'inbox items byte-identical');
  assert.equal(JSON.stringify(await rows(sql`select id, schema_version, recipient_rule_version, state from coordination_inbox_activation`)), activationBefore, 'rule version untouched');

  await wake.seedWakeAttempts(db);
  const kinds = await rows(sql`select event_id, item_kind from alden_wake_attempts where target_thread_id = ${threadId} order by event_global_sequence`);
  assert.deepEqual(kinds.map((k) => [k.event_id, k.item_kind]), [[content.id, 'observe'], [addressed.id, 'addressed'], [steward.id, 'observe']]);
});

test('a late commit below items already materialized is still picked up; an add/commit race resolves by sequence', async (context) => {
  if (skipUnlessCi(context)) return;
  const threadId = await pairThread('late commit');
  // An event that took its sequence before a later event committed, and commits only after the watch is added:
  // its sequence is at or below from_global_sequence, so it is history.
  const belowFrom = await reserveSequence();
  await comment(threadId, 'luca-claude-code', 'committed before the watch', 'luca-replit');
  const added = await watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'david', reason: 'late commit test' }, db);
  assert.ok(belowFrom <= added.fromGlobalSequence);
  const reserved = await reserveSequence(); // an event that started after the add, committing late
  assert.ok(reserved > added.fromGlobalSequence);
  const early = await comment(threadId, 'luca-replit', 'committed first, higher sequence', 'luca-claude-code');
  await watch.materializeWatchItems(db);
  assert.deepEqual(await watchedEvents(threadId), [early.id]);

  const late = await rawEvent(threadId, 'comment', 'luca-replit', reserved);
  const tooEarly = await rawEvent(threadId, 'comment', 'luca-replit', belowFrom);
  await watch.materializeWatchItems(db);
  assert.deepEqual(await watchedEvents(threadId), [late, early.id], 'the late event above from_global_sequence is picked up by the anti-join');
  assert.ok(!(await watchedEvents(threadId)).includes(tooEarly), 'an event at or below from_global_sequence never is, however late it commits');
});

test('removing a watch: events inserted before the removal still count, events after it never do', async (context) => {
  if (skipUnlessCi(context)) return;
  const threadId = await pairThread('removal');
  await watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'david', reason: 'removal test' }, db);
  const before = await rawEvent(threadId, 'comment', 'luca-replit');
  await watch.removeThreadWatch({ threadId, watcher: 'alden', removedBy: 'david' }, db);
  await comment(threadId, 'luca-replit', 'after the removal', 'luca-claude-code');
  await watch.materializeWatchItems(db);
  assert.deepEqual(await watchedEvents(threadId), [before]);
  await assert.rejects(watch.removeThreadWatch({ threadId, watcher: 'alden', removedBy: 'david' }, db), (e: any) => e.code === 'not_watching');
});

test('add and remove refusals; the chat tools need David and record him as the adder', async (context) => {
  if (skipUnlessCi(context)) return;
  const threadId = await pairThread('refusals');
  await assert.rejects(watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'alden', reason: 'x' }, db), (e: any) => e.code === 'self_add');
  await assert.rejects(watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'david', reason: '  ' }, db), (e: any) => e.code === 'reason_required');
  await assert.rejects(watch.addThreadWatch({ threadId: randomUUID(), watcher: 'alden', addedBy: 'david', reason: 'x' }, db), (e: any) => e.code === 'unknown_thread');
  await assert.rejects(watch.addThreadWatch({ threadId, watcher: 'luca-gemini', addedBy: 'david', reason: 'x' }, db), (e: any) => e.code === 'not_readable');
  await assert.rejects(db.execute(sql`insert into coordination_thread_watchers (thread_id, watcher, added_by, reason, from_global_sequence) values (${threadId}, 'alden', 'alden', 'x', 0)`),
    (e: any) => e.cause?.constraint === 'coordination_thread_watchers_no_self_add' || e.constraint === 'coordination_thread_watchers_no_self_add', 'the CHECK refuses a self-add too');
  const participant = await watch.addThreadWatch({ threadId, watcher: 'luca-replit', addedBy: 'david', reason: 'a participant can watch' }, db);
  assert.equal(participant.existing, false);

  const unattended = await tools.executeAldenTool('watch_coordination_thread', { thread_id: threadId, reason: 'x' }, {});
  assert.equal(unattended.data.refused, 'founder_not_present');
  const added = await tools.executeAldenTool('watch_coordination_thread', { thread_id: threadId, reason: 'David asked' }, { founderPresent: true });
  assert.equal(added.data.existing, false);
  assert.equal((await one(sql`select added_by from coordination_thread_watchers where id = ${added.data.id}`)).added_by, 'david');
  const again = await tools.executeAldenTool('watch_coordination_thread', { thread_id: threadId, reason: 'David asked' }, { founderPresent: true });
  assert.equal(again.data.existing, true, 'idempotent for an active watch');
  const removed = await tools.executeAldenTool('unwatch_coordination_thread', { thread_id: threadId }, { founderPresent: true });
  assert.equal(removed.data.id, added.data.id);
});

test('observe items: addressed items are claimed first, a reply is a steward comment to the observed sender, no reply ends observed with no notice, and the spending guard holds them', async (context) => {
  if (skipUnlessCi(context)) return;
  // Earlier tests' watch items are seeded here, then settled, so they cannot enter this claim order.
  await watch.materializeWatchItems(db);
  await wake.seedWakeAttempts(db);
  await drain();
  const threadId = await pairThread('wake semantics');
  await watch.addThreadWatch({ threadId, watcher: 'alden', addedBy: 'david', reason: 'wake test' }, db);
  const quiet = await comment(threadId, 'luca-replit', 'an observed post Alden lets pass', 'luca-claude-code');
  const answered = await comment(threadId, 'luca-replit', 'an observed post Alden answers', 'luca-claude-code');
  const addressedThread = await ledger.createCoordinationThread({ actor: 'luca-claude-code', intendedRecipient: 'alden', title: `watch test ${runId} addressed`,
    description: 'addressed, newer than the observed posts', idempotencyKey: `watch-test:${runId}:${n++}` });
  threads.push(addressedThread.thread.id);

  const order: string[] = [];
  const generate = async (params: any) => {
    const eventId = /Coordination event (\S+) on thread/.exec(params.userMessage)![1];
    order.push(eventId);
    if (eventId === answered.id) {
      const reply = await tools.executeAldenTool('reply_to_coordination_thread', { thread_id: threadId, recipient: 'luca-replit', content: 'Noted. (Unattended turn.)', model: 'gemini-test' },
        { toolAllowlist: params.toolAllowlist, wakeTurn: params.wakeTurn });
      assert.equal(reply.data.status, 'replied');
    }
    return { response: 'ok', toolsUsed: [] };
  };
  await worker.runWakePass({ db, generate, env: {} });
  assert.equal(order[0], addressedThread.event.id, 'the addressed item is claimed before older observe items');
  assert.deepEqual(order.slice(1), [quiet.id, answered.id]);

  const states = Object.fromEntries((await rows(sql`select event_id, state from alden_wake_attempts where event_id in (${quiet.id}, ${answered.id})`)).map((r) => [r.event_id, r.state]));
  assert.deepEqual(states, { [quiet.id]: 'observed', [answered.id]: 'replied' });
  const reply = await one(sql`select e.event_type, e.recipient_actor from alden_wake_attempts a join coordination_events e on e.id = a.reply_event_id where a.event_id = ${answered.id}`);
  assert.deepEqual(reply, { event_type: 'steward_comment', recipient_actor: 'luca-replit' });
  assert.equal((await one(sql`select count(*)::int as c from alden_wake_notice_outbox o join alden_wake_attempts a on a.item_id = o.item_id where a.event_id = ${quiet.id}`)).c, 0, 'no notice for an observed item');

  const held = await comment(threadId, 'luca-replit', 'arrives while over budget', 'luca-claude-code');
  const [cost] = await rows(sql`insert into ai_cost_logs (logged_at, model, cost_usd, context) values (${Date.now()}, 'gemini-test', 1000, 'alden-wake') returning id`);
  costRows.push(cost.id);
  const pass = await worker.runWakePass({ db, generate, env: {} });
  assert.equal(pass.stop, 'spending');
  assert.equal((await one(sql`select state from alden_wake_attempts where event_id = ${held.id}`)).state, 'eligible', 'held, not claimed');
  await db.execute(sql`delete from ai_cost_logs where id = ${cost.id}`);
});
