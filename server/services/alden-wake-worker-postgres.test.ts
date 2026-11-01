/**
 * The Alden inbox wake worker (design eb2ed6bf r11, build step W2b) against
 * the CI job's disposable PostgreSQL. The model is replaced by a scripted
 * turn that calls the real executeAldenTool with the context the worker
 * passes, so the wake profile, the reply binding, the fenced publication and
 * the chat-only refusals are exercised on their real paths. Synthetic
 * threads only; everything is removed after.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const url = getVerifiedCiDatabaseUrl();
const runId = randomUUID().slice(0, 8);
const threads: string[] = [];
let n = 0;
let db: any;
let worker: typeof import('./alden-wake-worker');
let wake: typeof import('./alden-wake-ledger');
let ledger: typeof import('./coordination-ledger-service');
let tools: typeof import('./alden-functions');
let priorCursor: number | null = null;

const one = async (query: any) => ((await db.execute(query)) as any).rows[0];

before(async () => {
  if (!url) return;
  db = (await import('../db')).getSharedDb();
  const inbox = await import('./coordination-inbox-service');
  worker = await import('./alden-wake-worker');
  wake = await import('./alden-wake-ledger');
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
  await db.execute(sql`delete from alden_notifications where triggered_by = 'alden-wake' or content like ${`%${runId}%`}`);
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

async function newThread(sender: string, content: string) {
  const created = await ledger.createCoordinationThread({
    actor: sender as any, intendedRecipient: 'alden', title: `wake worker test ${runId} ${n}`, description: content, content,
    idempotencyKey: `wake-worker-test:${runId}:${n++}`,
  });
  threads.push(created.thread.id);
  return { threadId: created.thread.id, eventId: created.event.id };
}

const stateOf = async (eventId: string) => (await one(sql`select state from alden_wake_attempts where event_id = ${eventId}`))?.state;
const drain = () => db.execute(sql`update alden_wake_attempts set state = 'manual', notes = 'test drain' where state = 'eligible'`);

/** A scripted turn: records what the worker passed, then calls the real dispatcher. */
function scripted(steps: (params: any) => Promise<{ response?: string; error?: string; roundLimitReached?: boolean } | void>) {
  const seen: any[] = [];
  const generate = async (params: any) => {
    seen.push(params);
    const result = (await steps(params)) ?? {};
    return { response: result.response ?? '', toolsUsed: [], error: result.error, roundLimitReached: (result as any).roundLimitReached };
  };
  return { generate, seen };
}
const call = (params: any, name: string, args: Record<string, any>) =>
  tools.executeAldenTool(name, args, { toolAllowlist: params.toolAllowlist, wakeTurn: params.wakeTurn });

test('a wake turn replies through the bound path on the wake engine and profile', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', `please confirm ${runId}`);
  const turn = scripted(async (params) => {
    const refused = await call(params, 'reply_to_coordination_thread', { thread_id: randomUUID(), recipient: 'luca-claude-code', content: 'x', model: 'm' });
    assert.equal(refused.data.refused, 'tool_binding_mismatch', 'another thread is refused');
    const wrongRecipient = await call(params, 'reply_to_coordination_thread', { thread_id: item.threadId, recipient: 'luca-replit', content: 'x', model: 'm' });
    assert.equal(wrongRecipient.data.refused, 'reply_binding_mismatch');
    const interject = await call(params, 'interject_on_coordination_thread', { thread_id: item.threadId, content: 'x', model: 'm' });
    assert.equal(interject.data.refused, 'tool_not_allowed');
    const ack = await call(params, 'ack_coordination_item', { event_id: item.eventId });
    assert.ok(ack.data.refused, 'the chat-only ack is refused in a wake turn');
    const reply = await call(params, 'reply_to_coordination_thread', { thread_id: item.threadId, recipient: 'luca-claude-code', content: 'Confirmed. (Unattended turn.)', model: 'gemini-3-flash-preview' });
    assert.equal(reply.data.status, 'replied');
  });
  const result = await worker.runWakePass({ db, generate: turn.generate, env: {} });
  assert.deepEqual(result.turns, ['published:replied']);
  assert.equal(result.stop, 'none');
  const [params] = turn.seen;
  assert.equal(params.engineOverride, 'gemini');
  assert.equal(params.modelOverride, undefined, 'Gemini runs on its configured Flash model');
  assert.equal(params.costContext, 'alden-wake');
  assert.equal(params.toolAllowlist.label, 'wake');
  assert.ok(params.userMessage.includes(`Coordination event ${item.eventId} on thread ${item.threadId}`));
  assert.ok(params.userMessage.includes('from luca-claude-code'));
  assert.equal(await stateOf(item.eventId), 'replied');
  const reply = await one(sql`select recipient_actor, content from coordination_events where thread_id = ${item.threadId} and actor = 'alden'`);
  assert.equal(reply.recipient_actor, 'luca-claude-code');
  assert.equal((await one(sql`select o.status from alden_wake_notice_outbox o join alden_wake_attempts a on a.item_id = o.item_id where a.event_id = ${item.eventId}`)).status, 'delivered', 'the pass delivers the notice');
});

test('without a reply: declined, needs_david after notify, failed on an error or a throw', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const quiet = await newThread('luca-claude-code', 'nothing to say');
  const needs = await newThread('luca-claude-code', 'needs David');
  const errors = await newThread('luca-claude-code', 'engine error');
  const throws = await newThread('luca-claude-code', 'engine throws');
  const byEvent = new Map<string, (params: any) => Promise<any>>([
    [quiet.eventId, async () => ({ response: 'No reply needed.' })],
    [needs.eventId, async (params) => { await call(params, 'notify_david', { message: `wake test ${runId}: needs David` }); return { response: 'Waiting for David.' }; }],
    [errors.eventId, async () => ({ response: 'Something went wrong on my end.', error: 'gemini 500' })],
    [throws.eventId, async () => { throw new Error('network down'); }],
  ]);
  const turn = scripted(async (params) => {
    const eventId = /Coordination event (\S+) on thread/.exec(params.userMessage)![1];
    return byEvent.get(eventId)!(params);
  });
  const result = await worker.runWakePass({ db, generate: turn.generate, env: {} });
  assert.deepEqual(result.turns, ['declined:recorded', 'needs_david:recorded', 'failed:recorded', 'failed:recorded']);
  assert.equal(await stateOf(quiet.eventId), 'declined');
  assert.equal(await stateOf(needs.eventId), 'needs_david');
  assert.equal(await stateOf(errors.eventId), 'failed');
  assert.equal(await stateOf(throws.eventId), 'failed');
  const failed = await one(sql`select error_class, notes from alden_wake_attempts where event_id = ${throws.eventId}`);
  assert.equal(failed.error_class, 'turn_error');
  assert.match(failed.notes, /network down/);
});

test('Sonnet by configuration; ALDEN_INBOX_WAKE=off skips the pass and leaves items eligible', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const item = await newThread('luca-claude-code', 'engine switch');
  const off = await worker.runWakePass({ db, generate: async () => { throw new Error('must not run'); }, env: { ALDEN_INBOX_WAKE: 'off' } });
  assert.equal(off.skipped, 'ALDEN_INBOX_WAKE=off');
  await wake.seedWakeAttempts(db);
  assert.equal(await stateOf(item.eventId), 'eligible');
  const turn = scripted(async () => ({ response: 'Noted.' }));
  await worker.runWakePass({ db, generate: turn.generate, env: { ALDEN_WAKE_ENGINE: 'sonnet' } });
  assert.equal(turn.seen[0].engineOverride, 'anthropic');
  assert.equal(turn.seen[0].modelOverride, 'claude-sonnet-5-5');
});

test('chat with David: ack and a covers reply go through the same path; both are refused without David', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const acked = await newThread('luca-claude-code', 'ack me');
  const first = await newThread('luca-claude-code', 'first of two');
  const { latest_sequence: seq } = await one(sql`select latest_sequence from coordination_threads where id = ${first.threadId}`);
  const second = await ledger.appendCoordinationEvent({ threadId: first.threadId, actor: 'luca-claude-code', eventType: 'comment', content: 'second of two',
    recipientActor: 'alden', idempotencyKey: `wake-worker-test:${runId}:${n++}`, expectedSequence: Number(seq) });
  await wake.seedWakeAttempts(db);

  const unattended = await tools.executeAldenTool('ack_coordination_item', { event_id: acked.eventId }, {});
  assert.equal(unattended.data.refused, 'founder_not_present');
  const resume = await tools.executeAldenTool('resume_wake_thread', { thread_id: acked.threadId }, {});
  assert.equal(resume.data.refused, 'founder_not_present');

  const ack = await tools.executeAldenTool('ack_coordination_item', { event_id: acked.eventId, note: 'handled with David' }, { founderPresent: true });
  assert.equal(ack.data.status, 'handled_in_chat');
  assert.equal(await stateOf(acked.eventId), 'handled_in_chat');

  const reply = await tools.executeAldenTool('reply_to_coordination_thread', {
    thread_id: first.threadId, recipient: 'luca-claude-code', content: 'Both answered, with David.', model: 'claude-opus-5-5', covers: [first.eventId, second.event.id],
  }, { founderPresent: true });
  assert.equal(reply.data.status, 'handled_in_chat');
  assert.deepEqual(reply.data.covered, [second.event.id]);
  assert.equal(await stateOf(first.eventId), 'handled_in_chat');
  assert.equal(await stateOf(second.event.id), 'covered');

  const pending = await tools.executeAldenTool('list_wake_pending', {}, { founderPresent: true });
  assert.ok(Array.isArray(pending.data.held) && typeof pending.data.history.count === 'number');
});

test('a turn stopped on the tool-round limit gets exactly one follow-up carrying its notes, then fails visibly', async (context) => {
  if (skipUnlessCi(context)) return;
  await drain();
  const resolves = await newThread('luca-claude-code', 'read four long messages and answer');
  const exhausts = await newThread('luca-claude-code', 'a task that never fits');
  const seen = new Map<string, any[]>();
  const turn = scripted(async (params) => {
    const eventId = /Coordination event (\S+) on thread/.exec(params.userMessage)![1];
    seen.set(eventId, [...(seen.get(eventId) ?? []), params]);
    const followUp = params.userMessage.includes('This is your follow-up turn on this item.');
    if (eventId === resolves.eventId && followUp) {
      const reply = await call(params, 'reply_to_coordination_thread', { thread_id: resolves.threadId, recipient: 'luca-claude-code', content: 'Done on the follow-up. (Unattended turn.)', model: 'gemini-test' });
      assert.equal(reply.data.status, 'replied');
      return { response: 'replied' };
    }
    return { response: `Summary so far for ${eventId}: read two of four.`, roundLimitReached: true };
  });
  const first = await worker.runWakePass({ db, generate: turn.generate, env: {} });
  // A released item is eligible again and still the oldest, so the same pass gives it its follow-up at once.
  assert.deepEqual(first.turns, ['follow_up:released', 'published:replied', 'follow_up:released', 'failed:recorded']);
  assert.equal(seen.get(resolves.eventId)!.length, 2);
  assert.equal(seen.get(exhausts.eventId)!.length, 2);
  const followUpMessage = seen.get(resolves.eventId)![1].userMessage;
  assert.ok(followUpMessage.includes(`Summary so far for ${resolves.eventId}: read two of four.`), 'the follow-up carries the first turn notes');
  assert.ok(!seen.get(resolves.eventId)![0].userMessage.includes('follow-up turn'), 'the first turn has no follow-up note');
  assert.equal(await stateOf(resolves.eventId), 'replied');
  const failed = await one(sql`select state, error_class, claim_epoch from alden_wake_attempts where event_id = ${exhausts.eventId}`);
  assert.deepEqual({ state: failed.state, error_class: failed.error_class, epoch: Number(failed.claim_epoch) }, { state: 'failed', error_class: 'round_limit', epoch: 2 });
  assert.equal((await one(sql`select count(*)::int as c from alden_wake_notice_outbox o join alden_wake_attempts a on a.item_id = o.item_id where a.event_id = ${exhausts.eventId} and o.state_reported = 'failed'`)).c, 1, 'the founder hears about it');
  const released = await one(sql`select count(*)::int as c from alden_wake_attempt_audit au join alden_wake_attempts a on a.item_id = au.item_id where a.event_id = ${exhausts.eventId} and au.reason like 'round_limit:%'`);
  assert.equal(released.c, 1, 'exactly one release');
});
