/**
 * Alden inbox wake, durable side (design eb2ed6bf r11, build step W2a).
 *
 * Every Alden answer to an inbox item, from an unattended wake turn or from
 * chat with David present, goes through publishAldenItemResponse: one
 * transaction that locks the item's attempt row, checks the fencing token,
 * writes the intent, appends the bound reply, reads it back, applies coverage
 * and records the disposition. The claim, the spending guard, the loop
 * breaker, the notice outbox and the reconcile live here too. Nothing in this
 * file calls a model; the turn runner (W2b) does.
 *
 * Every function takes a drizzle database handle so the real-PostgreSQL
 * tests can drive it; production passes getSharedDb().
 */
import { sql } from 'drizzle-orm';
import { getSharedDb } from '../db';
import { appendCoordinationEvent, CoordinationError } from './coordination-ledger-service';
import { materializeWatchItems } from './alden-wake-watch';
import { isRepeatingExchange, LOOP_LENGTH, loopHash, noticeOwed, sha256, type ThreadReplyPair, type WakeItemKind } from './alden-wake-rules';

export { isRepeatingExchange, loopHash, normalizeForLoop, noticeOwed } from './alden-wake-rules';

type Db = any;

export const WAKE_RECIPIENT = 'alden';
export const WAKE_COST_CONTEXT = 'alden-wake';
export const WAKE_BUDGET_USD = 10;
export const WAKE_LEASE_MS = 10 * 60 * 1000;
const WAKE_ADVISORY_KEY = 7_150_330_075; // "alden wake", migration 0075
const COOLDOWN_START_MINUTES = 30;
const COOLDOWN_MAX_MINUTES = 240;
const CLAIM_SCAN_LIMIT = 50;

/** A chat publication, with David present, may answer an item in these states. */
const CHAT_ANSWERABLE = ['eligible', 'manual', 'history', 'claimed'];
const COVERABLE = ['eligible', 'manual'];

export type WakeOutcome = 'declined' | 'needs_david' | 'failed' | 'observed';

/**
 * One unattended wake turn, passed to executeAldenTool. The dispatcher routes
 * the reply tool through publishAldenItemResponse under this claim and
 * records what happened here, so the worker can choose the outcome.
 */
export interface AldenWakeTurn {
  itemId: string;
  workerId: string;
  claimEpoch: number;
  threadId: string;
  targetSender: string;
  itemKind: WakeItemKind;
  published?: PublishResult;
  notified?: boolean;
}

export interface WakeAttempt {
  itemId: string;
  itemKind: WakeItemKind;
  eventGlobalSequence: number;
  state: string;
  claimedBy: string | null;
  claimEpoch: number;
  leaseUntil: Date | null;
  effectKey: string;
  targetThreadId: string;
  targetSender: string;
  replyEventId: string | null;
}

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];
const jsonArray = (values: readonly string[]) => sql`(select coalesce(array_agg(value), '{}') from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) as value)`;

function toAttempt(row: any): WakeAttempt {
  return {
    itemId: row.item_id,
    itemKind: row.item_kind,
    eventGlobalSequence: Number(row.event_global_sequence),
    state: row.state,
    claimedBy: row.claimed_by ?? null,
    claimEpoch: Number(row.claim_epoch),
    leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
    effectKey: row.effect_key,
    targetThreadId: row.target_thread_id,
    targetSender: row.target_sender,
    replyEventId: row.reply_event_id ?? null,
  };
}

/**
 * Lease authority, read in its own statement once the row lock is held. In a
 * SELECT ... FOR UPDATE, the select list can be computed before the lock wait
 * and kept when the holder did not change the row, so a clock comparison
 * there could predate the wait (design r7).
 */
async function leaseLive(tx: Db, itemId: string): Promise<boolean> {
  const [row] = rowsOf(await tx.execute(sql`select lease_until > clock_timestamp() as live from alden_wake_attempts where item_id = ${itemId}`));
  return row?.live === true;
}

async function audit(tx: Db, itemId: string, epoch: number, workerId: string, result: 'published' | 'superseded' | 'refused' | 'failed', reason: string | null) {
  await tx.execute(sql`insert into alden_wake_attempt_audit (item_id, claim_epoch, worker_id, result, reason)
    values (${itemId}, ${epoch}, ${workerId}, ${result}, ${reason})`);
}

async function addNotice(tx: Db, attempt: { itemId: string; itemKind: WakeItemKind }, state: string) {
  if (!noticeOwed(attempt.itemKind, state)) return;
  await tx.execute(sql`insert into alden_wake_notice_outbox (item_id, state_reported, dedupe_key)
    values (${attempt.itemId}, ${state}, ${`alden_wake:${attempt.itemId}:${state}`})
    on conflict (dedupe_key) do nothing`);
}

/**
 * Moves Alden's inbox watermark to the highest global sequence below which
 * every Alden item has a terminal disposition. Unseeded items count as not
 * terminal. The cursor never claims more than the attempt ledger proves, and
 * it never moves backwards.
 */
export async function advanceAldenCursor(tx: Db): Promise<number | null> {
  const [row] = rowsOf(await tx.execute(sql`
    select least(
      (select min(event_global_sequence) from alden_wake_attempts where item_kind = 'addressed' and state in ('eligible', 'claimed', 'uncertain')),
      (select min(i.event_global_sequence) from coordination_inbox_items i
        where i.recipient_actor = ${WAKE_RECIPIENT}
          and not exists (select 1 from alden_wake_attempts a where a.item_id = i.id or a.event_id = i.coordination_event_id))
    ) as blocked,
    (select max(event_global_sequence) from coordination_inbox_items where recipient_actor = ${WAKE_RECIPIENT}) as top`));
  if (row.top === null) return null;
  const watermark = row.blocked === null ? Number(row.top) : Number(row.blocked) - 1;
  if (watermark < 1) return null;
  await tx.execute(sql`
    insert into coordination_inbox_cursors (recipient_actor, acknowledged_event_global_sequence, updated_at)
    values (${WAKE_RECIPIENT}, ${watermark}, now())
    on conflict (recipient_actor) do update set
      acknowledged_event_global_sequence = greatest(coordination_inbox_cursors.acknowledged_event_global_sequence, excluded.acknowledged_event_global_sequence),
      updated_at = now()`);
  return watermark;
}

// ---------------------------------------------------------------------------
// Activation, seeding, emergency stop

/**
 * Sets the cutoff once, from the authoritative event stream (W1), under the
 * control row lock, so two instances starting together see one cutoff. A
 * restart reads the stored value and never recomputes it.
 */
export async function activateWake(db: Db = getSharedDb()): Promise<{ enabled: boolean; cutoff: number }> {
  return db.transaction(async (tx: Db) => {
    const [control] = rowsOf(await tx.execute(sql`select enabled, cutoff_global_sequence from alden_wake_control where id = 'alden' for update`));
    if (!control) throw new Error('alden_wake_control row missing (migration 0075)');
    if (control.cutoff_global_sequence !== null) {
      return { enabled: control.enabled, cutoff: Number(control.cutoff_global_sequence) };
    }
    const [row] = rowsOf(await tx.execute(sql`
      update alden_wake_control set
        cutoff_global_sequence = (select coalesce(max(global_sequence), 0) from coordination_events),
        activated_at = clock_timestamp(), updated_by = 'alden-wake-activation', updated_at = clock_timestamp()
      where id = 'alden' returning enabled, cutoff_global_sequence`));
    return { enabled: row.enabled, cutoff: Number(row.cutoff_global_sequence) };
  });
}

/**
 * Gives every Alden inbox item without one an attempt row. Classification
 * depends only on the item's global sequence against the durable cutoff, so a
 * late materialization of an old event is history, never woken. An event that
 * already has an attempt (a watch item seeded first, before a backfill created
 * its inbox item) is skipped, so one event is never answered twice; the
 * cursor does not wait on that inbox item either. Idempotent.
 */
export async function seedWakeAttempts(db: Db = getSharedDb()): Promise<number> {
  const result = await db.execute(sql`
    insert into alden_wake_attempts (item_id, item_kind, inbox_item_id, event_id, event_global_sequence, state, effect_key, target_thread_id, target_sender)
    select i.id, 'addressed', i.id, i.coordination_event_id, i.event_global_sequence,
      case when i.event_global_sequence <= c.cutoff_global_sequence then 'history' else 'eligible' end,
      'alden-wake:' || i.id, i.coordination_thread_id, i.sender_actor
    from coordination_inbox_items i
    cross join alden_wake_control c
    where c.id = 'alden' and c.cutoff_global_sequence is not null
      and i.recipient_actor = ${WAKE_RECIPIENT}
      and not exists (select 1 from alden_wake_attempts a where a.item_id = i.id or a.event_id = i.coordination_event_id)
    on conflict do nothing`);
  // Observe items (W3): one per watch item for Alden, classified by the same cutoff.
  // An event that already has an attempt (its addressed item) is skipped.
  const observed = await db.execute(sql`
    insert into alden_wake_attempts (item_id, item_kind, watch_item_id, event_id, event_global_sequence, state, effect_key, target_thread_id, target_sender)
    select w.id, 'observe', w.id, w.event_id, w.event_global_sequence,
      case when w.event_global_sequence <= c.cutoff_global_sequence then 'history' else 'eligible' end,
      'alden-wake:' || w.id, w.thread_id, w.sender
    from coordination_watch_items w
    cross join alden_wake_control c
    where c.id = 'alden' and c.cutoff_global_sequence is not null
      and w.watcher = ${WAKE_RECIPIENT}
      and not exists (select 1 from alden_wake_attempts a where a.item_id = w.id or a.event_id = w.event_id)
    on conflict do nothing`);
  return Number(result?.rowCount ?? 0) + Number(observed?.rowCount ?? 0);
}

/** The emergency stop. Ordered against claims by the control row lock. */
export async function setWakeEnabled(enabled: boolean, actor: string, db: Db = getSharedDb()): Promise<void> {
  await db.transaction(async (tx: Db) => {
    await tx.execute(sql`select 1 from alden_wake_control where id = 'alden' for update`);
    await tx.execute(sql`update alden_wake_control set enabled = ${enabled}, updated_by = ${actor}, updated_at = clock_timestamp() where id = 'alden'`);
  });
}

// ---------------------------------------------------------------------------
// Guards

/** Today's wake spend, by UTC day on the DB clock, from the logged costs. */
export async function wakeSpendToday(tx: Db): Promise<{ spend: number; resumeAt: Date }> {
  const [row] = rowsOf(await tx.execute(sql`
    with day as (select date_trunc('day', clock_timestamp() at time zone 'UTC') as start)
    select coalesce((select sum(cost_usd) from ai_cost_logs, day
        where context = ${WAKE_COST_CONTEXT}
          and logged_at >= (extract(epoch from day.start) * 1000)::bigint), 0) as spend,
      to_char((select start from day) + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as resume_at`));
  return { spend: Number(row.spend), resumeAt: new Date(row.resume_at) };
}

/** Alden's last wake replies on a thread, newest first, each with the message it answered. */
async function recentWakeReplies(tx: Db, threadId: string): Promise<ThreadReplyPair[]> {
  const rows = rowsOf(await tx.execute(sql`
    select r.id as reply_id, r.global_sequence as reply_sequence, r.content as reply_content,
           t.actor as trigger_actor, t.content as trigger_content
    from alden_wake_attempts a
    join coordination_events r on r.id = a.reply_event_id
    join coordination_events t on t.id = a.event_id
    where a.target_thread_id = ${threadId} and a.state = 'replied'
    order by r.global_sequence desc
    limit ${LOOP_LENGTH}`));
  return rows.map((row) => ({
    replyEventId: row.reply_id,
    replySequence: Number(row.reply_sequence),
    replyHash: loopHash(row.reply_content),
    triggerActor: row.trigger_actor,
    triggerHash: loopHash(row.trigger_content),
  }));
}

type ThreadHold = { held: false } | { held: true; pauseId: string; resumeAt: Date };

/**
 * The loop breaker for one thread, run under the claim lock. Ends a pause
 * that a new non-repeating message or the cooldown has ended; pauses a thread
 * on new evidence of repetition; otherwise leaves it running.
 */
async function threadHold(tx: Db, threadId: string): Promise<ThreadHold> {
  const [active] = rowsOf(await tx.execute(sql`
    select id, evidence, resume_at, resume_at <= clock_timestamp() as cooled
    from alden_wake_thread_pauses where thread_id = ${threadId} and resumed_at is null for update`));
  if (active) {
    const evidence = active.evidence as { triggerHash: string; replyHash: string; lastSequence: number };
    const later = rowsOf(await tx.execute(sql`
      select id, actor, content from coordination_events
      where thread_id = ${threadId} and global_sequence > ${evidence.lastSequence} and actor <> ${WAKE_RECIPIENT}
      order by global_sequence`));
    const fresh = later.find((event) => loopHash(event.content) !== evidence.triggerHash && loopHash(event.content) !== evidence.replyHash);
    if (fresh) {
      await tx.execute(sql`update alden_wake_thread_pauses set resumed_at = clock_timestamp(), resumed_by = 'new_message', resume_event_id = ${fresh.id} where id = ${active.id}`);
      return { held: false };
    }
    if (active.cooled) {
      await tx.execute(sql`update alden_wake_thread_pauses set resumed_at = clock_timestamp(), resumed_by = 'cooldown' where id = ${active.id}`);
      return { held: false };
    }
    return { held: true, pauseId: active.id, resumeAt: new Date(active.resume_at) };
  }

  const pairs = await recentWakeReplies(tx, threadId);
  if (!isRepeatingExchange(pairs)) return { held: false };
  const [previous] = rowsOf(await tx.execute(sql`
    select cooldown_minutes, resumed_by, (evidence->>'lastSequence')::bigint as last_sequence
    from alden_wake_thread_pauses where thread_id = ${threadId} order by paused_at desc limit 1`));
  // Only new evidence pauses: a resumed thread is not re-paused on the same three replies.
  if (previous && Number(previous.last_sequence) >= pairs[0].replySequence) return { held: false };
  const cooldown = previous?.resumed_by === 'cooldown'
    ? Math.min(Number(previous.cooldown_minutes) * 2, COOLDOWN_MAX_MINUTES)
    : COOLDOWN_START_MINUTES;
  const evidence = {
    replyEventIds: pairs.map((pair) => pair.replyEventId),
    replyHash: pairs[0].replyHash,
    triggerHash: pairs[0].triggerHash,
    counterpart: pairs[0].triggerActor,
    lastSequence: pairs[0].replySequence,
  };
  const [pause] = rowsOf(await tx.execute(sql`
    insert into alden_wake_thread_pauses (thread_id, paused_at, reason, evidence, resume_at, cooldown_minutes)
    values (${threadId}, clock_timestamp(), 'repeating_exchange', ${JSON.stringify(evidence)}::jsonb,
      clock_timestamp() + make_interval(mins => ${cooldown}), ${cooldown})
    returning id, resume_at`));
  await tx.execute(sql`insert into alden_notifications (content, triggered_by, severity, read, fingerprint)
    values (${`Alden's inbox wake paused thread ${threadId}: the same exchange with ${evidence.counterpart} repeated ${LOOP_LENGTH} times (reply ${evidence.replyHash.slice(0, 12)}, message ${evidence.triggerHash.slice(0, 12)}). It resumes on a new message, an explicit resume, or after ${cooldown} minutes.`},
      'alden-wake', 'warning', false, ${`alden_wake_loop:${pause.id}`})`);
  return { held: true, pauseId: pause.id, resumeAt: new Date(pause.resume_at) };
}

// ---------------------------------------------------------------------------
// Claim

export type ClaimResult =
  | { status: 'stopped' }
  | { status: 'spending'; spend: number; resumeAt: Date }
  | { status: 'none'; held: number }
  | { status: 'claimed'; attempt: WakeAttempt; held: number };

/**
 * Claims the next eligible item in one transaction: the wake advisory lock,
 * the emergency stop read under FOR SHARE, the spending guard, the loop
 * breaker per thread, then a CAS from eligible. Addressed items are claimed
 * before observe items, oldest first. Held items stay eligible.
 */
export async function claimNextWakeItem(
  workerId: string,
  options: { budgetUsd?: number; leaseMs?: number } = {},
  db: Db = getSharedDb(),
): Promise<ClaimResult> {
  const budget = options.budgetUsd ?? WAKE_BUDGET_USD;
  const leaseMs = options.leaseMs ?? WAKE_LEASE_MS;
  return db.transaction(async (tx: Db) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${WAKE_ADVISORY_KEY})`);
    const [control] = rowsOf(await tx.execute(sql`select enabled from alden_wake_control where id = 'alden' for share`));
    if (!control?.enabled) return { status: 'stopped' } as const;

    const { spend, resumeAt } = await wakeSpendToday(tx);
    if (spend >= budget) {
      await tx.execute(sql`insert into alden_notifications (content, triggered_by, severity, read, fingerprint)
        select ${`Alden's inbox wake reached its daily budget ($${spend.toFixed(2)} of $${budget}). Waiting items stay listed in list_wake_pending; the wake resumes at ${resumeAt.toISOString()} or when the budget is raised.`},
          'alden-wake', 'alert', false, ${`alden_wake_spending:${resumeAt.toISOString().slice(0, 10)}`}
        where not exists (select 1 from alden_notifications where fingerprint = ${`alden_wake_spending:${resumeAt.toISOString().slice(0, 10)}`})`);
      return { status: 'spending', spend, resumeAt } as const;
    }

    // Page through eligible items, leaving out threads already found held, so a
    // paused thread with any number of waiting items never hides other threads
    // (LR, #160 review). A non-held candidate is locked by this transaction, so
    // its claim always succeeds; the loop ends on a claim or when nothing is left.
    const holds = new Map<string, ThreadHold>();
    const heldThreads: string[] = [];
    const passed: string[] = []; // never expected; guarantees the loop terminates
    let held = 0;
    for (;;) {
      const candidates = rowsOf(await tx.execute(sql`
        select item_id, target_thread_id from alden_wake_attempts
        where state = 'eligible'
          and target_thread_id not in (select value from jsonb_array_elements_text(${JSON.stringify(heldThreads)}::jsonb) as value)
          and item_id not in (select value from jsonb_array_elements_text(${JSON.stringify(passed)}::jsonb) as value)
        order by (item_kind = 'observe'), event_global_sequence
        limit ${CLAIM_SCAN_LIMIT}
        for update skip locked`));
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        if (!holds.has(candidate.target_thread_id)) holds.set(candidate.target_thread_id, await threadHold(tx, candidate.target_thread_id));
        if (holds.get(candidate.target_thread_id)!.held) {
          held += 1;
          if (!heldThreads.includes(candidate.target_thread_id)) heldThreads.push(candidate.target_thread_id);
          continue;
        }
        const [row] = rowsOf(await tx.execute(sql`
          update alden_wake_attempts set state = 'claimed', claim_epoch = claim_epoch + 1, claimed_by = ${workerId},
            claimed_at = clock_timestamp(), lease_until = clock_timestamp() + make_interval(secs => ${leaseMs / 1000}),
            claim_day = (clock_timestamp() at time zone 'UTC')::date, updated_at = clock_timestamp()
          where item_id = ${candidate.item_id} and state = 'eligible'
          returning *`));
        if (row) return { status: 'claimed', attempt: toAttempt(row), held } as const;
        passed.push(candidate.item_id);
      }
    }
    return { status: 'none', held } as const;
  });
}

// ---------------------------------------------------------------------------
// Publication

export interface PublishInput {
  itemId: string;
  /** 'wake' needs the claim's worker and epoch; 'chat' means David is present. */
  mode: 'wake' | 'chat';
  workerId: string;
  claimEpoch?: number;
  /** The reply. Omitted for an acknowledgement without a reply (ack_coordination_item). */
  content?: string;
  model?: string;
  /** Event ids of other Alden items this reply also answers. */
  covers?: string[];
  note?: string;
  /** Test seam: runs inside the transaction just before commit. */
  beforeCommit?: () => Promise<void> | void;
}

export interface CoverageRefusal { eventId: string; reason: 'not_an_alden_item' | 'is_trigger' | 'other_thread' | 'other_requester' | 'claimed' | 'terminal' }

export type PublishResult =
  | { status: 'superseded' | 'already_answered'; state: string }
  | { status: 'replied' | 'handled_in_chat'; replyEventId: string | null; deduplicated: boolean; covered: string[]; refusedCovers: CoverageRefusal[] }
  | { status: 'conflict' | 'uncertain'; replyEventId: string | null; reason: string }
  | { status: 'failed'; reason: string };

class FencedOut extends Error {}

/** Applies validated coverage under the publication lock. Never infers coverage. */
async function applyCoverage(tx: Db, trigger: WakeAttempt, triggerEventId: string, eventIds: readonly string[], replyEventId: string | null, decidedBy: string) {
  const covered: string[] = [];
  const refused: CoverageRefusal[] = [];
  if (eventIds.length === 0) return { covered, refused };
  const rows = rowsOf(await tx.execute(sql`
    select a.*, a.event_id as coordination_event_id from alden_wake_attempts a
    where a.item_kind = 'addressed'
      and a.event_id in (select value from jsonb_array_elements_text(${JSON.stringify(eventIds)}::jsonb) as value)
    order by a.item_id
    for update`));
  const byEvent = new Map(rows.map((row) => [row.coordination_event_id as string, row]));
  for (const eventId of new Set(eventIds)) {
    const row = byEvent.get(eventId);
    const reason: CoverageRefusal['reason'] | null = !row ? 'not_an_alden_item'
      : eventId === triggerEventId ? 'is_trigger'
      : row.target_thread_id !== trigger.targetThreadId ? 'other_thread'
      : row.target_sender !== trigger.targetSender ? 'other_requester'
      : row.state === 'claimed' ? 'claimed'
      : !COVERABLE.includes(row.state) ? 'terminal'
      : null;
    if (reason) { refused.push({ eventId, reason }); continue; }
    await tx.execute(sql`update alden_wake_attempts set state = 'covered', covered_by = ${trigger.itemId},
      covered_reply_event_id = ${replyEventId}, decided_by = ${decidedBy}, decided_at = clock_timestamp(), updated_at = clock_timestamp()
      where item_id = ${row.item_id} and state in ('eligible', 'manual')`);
    covered.push(eventId);
  }
  return { covered, refused };
}

/** The full read-back contract for a reply effect. */
function readBackMismatch(event: any, attempt: WakeAttempt, payloadSha: string): string | null {
  if (!event) return 'reply event not found';
  if (event.thread_id !== attempt.targetThreadId) return 'reply on another thread';
  if (event.actor !== WAKE_RECIPIENT) return 'reply not authored by alden';
  if (event.idempotency_key !== attempt.effectKey) return 'reply under another key';
  if (event.recipient_actor !== attempt.targetSender) return 'reply addressed to someone other than the requester';
  if (sha256(event.content) !== payloadSha) return 'reply content differs from the recorded payload';
  return null;
}

/**
 * The single publication path for every Alden answer to an inbox item (W2,
 * W3). Chat and wake for the same item serialize on the attempt row lock; a
 * wake must hold an unexpired lease under the epoch it claimed with, judged
 * on clock_timestamp() after the lock is held.
 */
export async function publishAldenItemResponse(input: PublishInput, db: Db = getSharedDb()): Promise<PublishResult> {
  const covers = [...new Set(input.covers ?? [])];
  try {
    return await db.transaction(async (tx: Db) => {
      const [locked] = rowsOf(await tx.execute(sql`
        select a.*, a.event_id as coordination_event_id
        from alden_wake_attempts a
        where a.item_id = ${input.itemId} for update`));
      if (!locked) throw new Error(`no wake attempt for inbox item ${input.itemId}`);
      const attempt = toAttempt(locked);

      if (input.mode === 'wake') {
        const live = attempt.state === 'claimed' && attempt.claimEpoch === input.claimEpoch
          && attempt.claimedBy === input.workerId && await leaseLive(tx, attempt.itemId);
        if (!live) throw new FencedOut(attempt.state);
      } else if (!CHAT_ANSWERABLE.includes(attempt.state)) {
        await audit(tx, attempt.itemId, attempt.claimEpoch, input.workerId, 'refused', `already_answered:${attempt.state}`);
        return { status: 'already_answered', state: attempt.state } as const;
      }

      const decidedState = input.mode === 'wake' ? 'replied' : 'handled_in_chat';
      const epochBump = input.mode === 'chat' && attempt.state === 'claimed' ? 1 : 0;
      let replyEventId: string | null = null;
      let deduplicated = false;
      let outcome: 'replied' | 'handled_in_chat' | 'conflict' | 'uncertain' = decidedState;
      let reason: string | null = null;

      if (input.content !== undefined) {
        const payloadSha = sha256(input.content);
        // Durable intent first: the payload digest and the requested coverage.
        await tx.execute(sql`update alden_wake_attempts set reply_payload_sha256 = ${payloadSha},
          requested_covers = ${jsonArray(covers)}, updated_at = clock_timestamp() where item_id = ${attempt.itemId}`);
        const [thread] = rowsOf(await tx.execute(sql`select latest_sequence from coordination_threads where id = ${attempt.targetThreadId} for update`));
        const appended = await appendCoordinationEvent({
          threadId: attempt.targetThreadId,
          actor: WAKE_RECIPIENT,
          eventType: attempt.itemKind === 'observe' ? 'steward_comment' : 'comment',
          content: input.content,
          recipientActor: attempt.targetSender as any,
          payload: { model: input.model ?? null, itemId: attempt.itemId, covers, via: input.mode === 'wake' ? 'alden-wake' : 'alden-chat' },
          idempotencyKey: attempt.effectKey,
          expectedSequence: Number(thread.latest_sequence),
        }, tx);
        replyEventId = appended.event.id;
        deduplicated = appended.deduplicated;
        const [event] = rowsOf(await tx.execute(sql`select id, thread_id, actor, idempotency_key, recipient_actor, content from coordination_events where id = ${replyEventId}`));
        const mismatch = readBackMismatch(event, attempt, payloadSha);
        if (mismatch && deduplicated && event && sha256(event.content) !== payloadSha) { outcome = 'conflict'; reason = 'an earlier reply under this item\'s key has different content'; }
        else if (mismatch) { outcome = 'uncertain'; reason = mismatch; }
      }

      const coverage = outcome === 'conflict' || outcome === 'uncertain'
        ? { covered: [], refused: [] }
        : await applyCoverage(tx, attempt, locked.coordination_event_id, covers, replyEventId, input.mode === 'wake' ? 'alden-wake' : 'alden-chat');

      await tx.execute(sql`update alden_wake_attempts set state = ${outcome}, reply_event_id = ${replyEventId},
        claim_epoch = claim_epoch + ${epochBump}, notes = ${input.note ?? reason},
        decided_by = ${input.mode === 'chat' ? 'alden-chat' : null}, decided_at = clock_timestamp(), updated_at = clock_timestamp()
        where item_id = ${attempt.itemId}`);
      if (input.mode === 'wake' || outcome === 'conflict' || outcome === 'uncertain') await addNotice(tx, attempt, outcome);
      await audit(tx, attempt.itemId, attempt.claimEpoch + epochBump, input.workerId, outcome === 'replied' || outcome === 'handled_in_chat' ? 'published' : 'failed', reason);
      await advanceAldenCursor(tx);
      await input.beforeCommit?.();

      if (outcome === 'conflict' || outcome === 'uncertain') return { status: outcome, replyEventId, reason: reason! } as const;
      return { status: outcome, replyEventId, deduplicated, covered: coverage.covered, refusedCovers: coverage.refused } as const;
    });
  } catch (err) {
    if (err instanceof FencedOut) {
      await db.transaction(async (tx: Db) => {
        const [row] = rowsOf(await tx.execute(sql`select claim_epoch from alden_wake_attempts where item_id = ${input.itemId}`));
        await audit(tx, input.itemId, input.claimEpoch ?? Number(row?.claim_epoch ?? 0), input.workerId, 'superseded', `fenced:${err.message}`);
      });
      return { status: 'superseded', state: err.message };
    }
    if (input.mode === 'wake' && (err as any)?.code === 'idempotency_conflict') {
      const recorded = await recordWakeOutcome({ itemId: input.itemId, workerId: input.workerId, claimEpoch: input.claimEpoch!, outcome: 'conflict', notes: 'the item\'s key is already used on another thread' }, db);
      return recorded === 'recorded'
        ? { status: 'conflict', replyEventId: null, reason: 'idempotency_conflict' }
        : { status: 'superseded', state: 'fenced' };
    }
    // A ledger refusal (for example, Alden is no longer a participant) is the
    // turn's failed outcome, recorded under the same fencing; chat rethrows.
    if (input.mode === 'wake' && err instanceof CoordinationError) {
      const code = String((err as any).code ?? 'coordination_error');
      const recorded = await recordWakeOutcome({ itemId: input.itemId, workerId: input.workerId, claimEpoch: input.claimEpoch!, outcome: 'failed', errorClass: code, notes: String((err as Error).message).slice(0, 500) }, db);
      return recorded === 'recorded' ? { status: 'failed', reason: code } : { status: 'superseded', state: 'fenced' };
    }
    throw err;
  }
}

/**
 * Records a wake turn's outcome when it did not publish a reply. Fenced like
 * publication: a CAS on claimed, the epoch, the worker and an unexpired lease.
 * A failed CAS lands only in the audit table, so a stale worker never
 * overwrites the winning disposition.
 */
export async function recordWakeOutcome(
  input: { itemId: string; workerId: string; claimEpoch: number; outcome: WakeOutcome | 'conflict'; notes?: string; errorClass?: string; toolsUsed?: string[] },
  db: Db = getSharedDb(),
): Promise<'recorded' | 'superseded'> {
  return db.transaction(async (tx: Db) => {
    const [row] = rowsOf(await tx.execute(sql`
      select * from alden_wake_attempts where item_id = ${input.itemId} for update`));
    const attempt = row ? toAttempt(row) : null;
    const live = attempt && attempt.state === 'claimed' && attempt.claimEpoch === input.claimEpoch
      && attempt.claimedBy === input.workerId && await leaseLive(tx, input.itemId);
    const allowed = attempt && (input.outcome === 'observed' ? attempt.itemKind === 'observe'
      : input.outcome === 'needs_david' ? attempt.itemKind === 'addressed' : true);
    if (!live || !allowed) {
      await audit(tx, input.itemId, input.claimEpoch, input.workerId, 'superseded', !live ? `fenced:${attempt?.state ?? 'missing'}` : `not_for_kind:${input.outcome}`);
      return 'superseded';
    }
    await tx.execute(sql`update alden_wake_attempts set state = ${input.outcome}, notes = ${input.notes ?? null},
      error_class = ${input.errorClass ?? null}, tools_used = ${jsonArray(input.toolsUsed ?? [])},
      decided_at = clock_timestamp(), updated_at = clock_timestamp() where item_id = ${input.itemId}`);
    await addNotice(tx, attempt, input.outcome);
    await audit(tx, input.itemId, input.claimEpoch, input.workerId, input.outcome === 'failed' ? 'failed' : 'published', input.notes ?? null);
    await advanceAldenCursor(tx);
    return 'recorded';
  });
}

/**
 * Releases a claim whose turn stopped on the tool-round limit back to
 * eligible for its one follow-up turn, carrying the turn's wrap-up as notes.
 * Fenced like any outcome write; the next claim bumps the epoch, which is how
 * the follow-up is recognised and capped (decideWakeOutcome).
 */
export async function releaseWakeForFollowUp(
  input: { itemId: string; workerId: string; claimEpoch: number; notes: string; toolsUsed?: string[] },
  db: Db = getSharedDb(),
): Promise<'released' | 'superseded'> {
  return db.transaction(async (tx: Db) => {
    const [row] = rowsOf(await tx.execute(sql`select * from alden_wake_attempts where item_id = ${input.itemId} for update`));
    const attempt = row ? toAttempt(row) : null;
    const live = attempt && attempt.state === 'claimed' && attempt.claimEpoch === input.claimEpoch
      && attempt.claimedBy === input.workerId && await leaseLive(tx, input.itemId);
    if (!live) {
      await audit(tx, input.itemId, input.claimEpoch, input.workerId, 'superseded', `fenced:${attempt?.state ?? 'missing'}`);
      return 'superseded';
    }
    await tx.execute(sql`update alden_wake_attempts set state = 'eligible', claimed_by = null, claimed_at = null, lease_until = null,
      notes = ${input.notes.slice(0, 2000)}, tools_used = ${jsonArray(input.toolsUsed ?? [])}, updated_at = clock_timestamp()
      where item_id = ${input.itemId}`);
    await audit(tx, input.itemId, input.claimEpoch, input.workerId, 'failed', 'round_limit: released for one follow-up turn');
    return 'released';
  });
}

// ---------------------------------------------------------------------------
// Reconcile and notices

/**
 * Seeds missing attempt rows and fences every expired claim: under the row
 * lock, judged on clock_timestamp(), the claim's epoch is bumped and the item
 * becomes replied (the reply is found under the full read-back contract,
 * including recorded coverage) or uncertain. There is no second model call.
 */
export async function reconcileWake(db: Db = getSharedDb()): Promise<{ seeded: number; recovered: number; uncertain: number }> {
  await materializeWatchItems(db);
  const seeded = await seedWakeAttempts(db);
  let recovered = 0;
  let uncertain = 0;
  const expired = rowsOf(await db.execute(sql`select item_id from alden_wake_attempts where state = 'claimed' and lease_until <= clock_timestamp()`));
  for (const { item_id: itemId } of expired) {
    await db.transaction(async (tx: Db) => {
      const [row] = rowsOf(await tx.execute(sql`
        select a.*, a.event_id as coordination_event_id from alden_wake_attempts a
        where a.item_id = ${itemId} and a.state = 'claimed' and a.lease_until <= clock_timestamp() for update`));
      if (!row) return;
      const attempt = toAttempt(row);
      const [event] = rowsOf(await tx.execute(sql`select id, thread_id, actor, idempotency_key, recipient_actor, content from coordination_events
        where actor = ${WAKE_RECIPIENT} and idempotency_key = ${attempt.effectKey}`));
      const found = row.reply_payload_sha256 && event && !readBackMismatch(event, attempt, row.reply_payload_sha256);
      const state = found ? 'replied' : 'uncertain';
      if (found) await applyCoverage(tx, attempt, row.coordination_event_id, row.requested_covers ?? [], event.id, 'alden-wake-reconcile');
      await tx.execute(sql`update alden_wake_attempts set state = ${state}, claim_epoch = claim_epoch + 1,
        reply_event_id = ${found ? event.id : null}, notes = ${found ? 'recovered after lease expiry' : 'lease expired without a verified reply'},
        decided_at = clock_timestamp(), updated_at = clock_timestamp() where item_id = ${itemId}`);
      await addNotice(tx, attempt, state);
      await audit(tx, itemId, attempt.claimEpoch + 1, 'alden-wake-reconcile', found ? 'published' : 'failed', `lease_expired:${state}`);
      await advanceAldenCursor(tx);
      if (found) recovered += 1; else uncertain += 1;
    });
  }
  return { seeded, recovered, uncertain };
}

const NOTICE_TEXT: Record<string, string> = {
  replied: 'answered it unattended',
  declined: 'read it unattended and chose not to reply',
  needs_david: 'needs you before answering it',
  failed: 'could not finish an unattended turn on it',
  uncertain: 'cannot confirm whether his unattended reply was published',
  conflict: 'found a conflicting earlier reply under the same key',
};

/**
 * Delivers pending notices exactly once each: SKIP LOCKED between
 * deliverers, and a read-back by fingerprint for a crash after the insert.
 * Every undelivered row is scanned, so a crash between the outcome and the
 * notice cannot strand an obligation. A failure leaves the outcome untouched.
 */
export async function deliverWakeNotices(db: Db = getSharedDb(), limit = 20): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  const pending = rowsOf(await db.execute(sql`select id from alden_wake_notice_outbox where status = 'pending' order by created_at limit ${limit}`));
  for (const { id } of pending) {
    try {
      await db.transaction(async (tx: Db) => {
        const [notice] = rowsOf(await tx.execute(sql`
          select o.*, a.target_sender, a.event_id as coordination_event_id, t.title from alden_wake_notice_outbox o
          join alden_wake_attempts a on a.item_id = o.item_id
          join coordination_threads t on t.id = a.target_thread_id
          where o.id = ${id} and o.status = 'pending' for update of o skip locked`));
        if (!notice) return;
        const [existing] = rowsOf(await tx.execute(sql`select id from alden_notifications where fingerprint = ${notice.dedupe_key} limit 1`));
        const notificationId = existing?.id ?? rowsOf(await tx.execute(sql`
          insert into alden_notifications (content, triggered_by, severity, read, fingerprint)
          values (${`Alden ${NOTICE_TEXT[notice.state_reported] ?? notice.state_reported}: coordination event ${notice.coordination_event_id} from ${notice.target_sender} on "${notice.title}".`},
            'alden-wake', ${['failed', 'uncertain', 'conflict', 'needs_david'].includes(notice.state_reported) ? 'warning' : 'info'}, false, ${notice.dedupe_key})
          returning id`))[0].id;
        await tx.execute(sql`update alden_wake_notice_outbox set status = 'delivered', notification_id = ${notificationId},
          attempts = attempts + 1, updated_at = clock_timestamp() where id = ${id}`);
        delivered += 1;
      });
    } catch (err) {
      failed += 1;
      await db.execute(sql`update alden_wake_notice_outbox set attempts = attempts + 1,
        last_error = ${String((err as Error)?.message ?? err).slice(0, 500)}, updated_at = clock_timestamp() where id = ${id}`);
    }
  }
  return { delivered, failed };
}

// ---------------------------------------------------------------------------
// Chat-side reads and actions

/** Resolves an Alden item from the event id chat tools are given. */
export async function findAldenItemByEvent(eventId: string, db: Db = getSharedDb()): Promise<string | null> {
  const [row] = rowsOf(await db.execute(sql`select id from coordination_inbox_items where recipient_actor = ${WAKE_RECIPIENT} and coordination_event_id = ${eventId}`));
  return row?.id ?? null;
}

/** Where an item's reply must go: its thread and its sender. */
export async function aldenItemReplyTarget(itemId: string, db: Db = getSharedDb()): Promise<{ threadId: string; sender: string } | null> {
  const [row] = rowsOf(await db.execute(sql`select target_thread_id, target_sender from alden_wake_attempts where item_id = ${itemId}`));
  return row ? { threadId: row.target_thread_id, sender: row.target_sender } : null;
}

/** Ends a thread pause on an explicit resume, recording who resumed it. */
export async function resumeWakeThread(threadId: string, actor: string, db: Db = getSharedDb()): Promise<boolean> {
  const result = await db.execute(sql`update alden_wake_thread_pauses set resumed_at = clock_timestamp(), resumed_by = ${actor}
    where thread_id = ${threadId} and resumed_at is null`);
  return Number(result?.rowCount ?? 0) > 0;
}

export interface WakePending {
  attention: Array<{ eventId: string; threadId: string; sender: string; state: string; kind: WakeItemKind; notes: string | null }>;
  held: Array<{ eventId: string; threadId: string; sender: string; reason: 'spending' | 'repeating_exchange'; resumeAt: string; resumesOn: string; evidence?: unknown }>;
  waiting: Array<{ eventId: string; threadId: string; sender: string; since: string }>;
  observing: Array<{ threadId: string; count: number }>;
  history: { count: number; oldest: string | null };
}

/**
 * What list_wake_pending shows: items needing attention; every eligible item
 * a guard holds, immediately, with its reason and how it resumes; unheld
 * eligible items older than 24 hours; observe items as a count per thread;
 * and the history group as one line.
 */
export async function listWakePending(options: { budgetUsd?: number } = {}, db: Db = getSharedDb()): Promise<WakePending> {
  const budget = options.budgetUsd ?? WAKE_BUDGET_USD;
  const { spend, resumeAt } = await wakeSpendToday(db);
  const spending = spend >= budget;
  const items = rowsOf(await db.execute(sql`
    select a.state, a.item_kind, a.target_thread_id, a.target_sender, a.notes, a.event_id as coordination_event_id, e.created_at,
      e.created_at < clock_timestamp() - interval '24 hours' as stale,
      p.id as pause_id, p.resume_at as pause_resume_at, p.evidence as pause_evidence
    from alden_wake_attempts a
    join coordination_events e on e.id = a.event_id
    left join alden_wake_thread_pauses p on p.thread_id = a.target_thread_id and p.resumed_at is null
    where a.state in ('eligible', 'manual', 'uncertain', 'failed', 'needs_david', 'conflict')
    order by a.event_global_sequence`));
  const pending: WakePending = { attention: [], held: [], waiting: [], observing: [], history: { count: 0, oldest: null } };
  const observing = new Map<string, number>();
  for (const item of items) {
    const base = { eventId: item.coordination_event_id, threadId: item.target_thread_id, sender: item.target_sender };
    if (item.state !== 'eligible') {
      if (item.item_kind === 'observe' && item.state === 'manual') continue;
      pending.attention.push({ ...base, state: item.state, kind: item.item_kind, notes: item.notes ?? null });
    } else if (spending) {
      pending.held.push({ ...base, reason: 'spending', resumeAt: resumeAt.toISOString(), resumesOn: 'the next UTC day, or a raised budget' });
    } else if (item.pause_id) {
      pending.held.push({ ...base, reason: 'repeating_exchange', resumeAt: new Date(item.pause_resume_at).toISOString(),
        resumesOn: 'a new non-repeating message on the thread, resume_wake_thread, or the cooldown', evidence: item.pause_evidence });
    } else if (item.item_kind === 'observe') {
      observing.set(item.target_thread_id, (observing.get(item.target_thread_id) ?? 0) + 1);
    } else if (item.stale) {
      pending.waiting.push({ ...base, since: new Date(item.created_at).toISOString() });
    }
  }
  pending.observing = [...observing].map(([threadId, count]) => ({ threadId, count }));
  const [history] = rowsOf(await db.execute(sql`select count(*)::int as count, min(e.created_at) as oldest
    from alden_wake_attempts a join coordination_events e on e.id = a.event_id where a.state = 'history'`));
  pending.history = { count: Number(history?.count ?? 0), oldest: history?.oldest ? new Date(history.oldest).toISOString() : null };
  return pending;
}
