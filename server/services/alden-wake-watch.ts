/**
 * Thread watch (wake design eb2ed6bf r12, build step W3). A watcher gets a
 * watch item for each conversation-content event on a watched thread, so the
 * wake hears onboarding-thread posts addressed to someone else. The
 * coordination inbox is not involved: watch items live in their own table and
 * are materialized here, by the wake pass, by anti-join.
 *
 * Outcomes are defined by the record, never by arrival order:
 * - adding a watch records from_global_sequence = the event stream's maximum
 *   under a lock on the thread, so history never produces an item
 *   (forward-only) and an event with a higher sequence always does, however
 *   late it commits;
 * - removing a watch records removed_at; an event inserted before that moment
 *   is still materialized even if it commits later, and one inserted after it
 *   never is;
 * - materialization is an anti-join, not a cursor, so a late-committing event
 *   below items already materialized is still picked up.
 */
import { sql } from 'drizzle-orm';
import { getSharedDb } from '../db';

type Db = any;
const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/** Conversation content only; bookkeeping and status events never produce watch items. */
export const WATCH_EVENT_TYPES = ['comment', 'steward_comment'] as const;
export const WATCH_MATERIALIZE_BATCH = 200;

export class WatchRefusal extends Error {
  constructor(readonly code: 'self_add' | 'not_readable' | 'reason_required' | 'unknown_thread' | 'not_watching', message: string) {
    super(message);
  }
}

/**
 * Whether the watcher can read the thread. Alden reads every thread as
 * steward; any other watcher must already be one of its participants.
 */
async function watcherCanRead(tx: Db, threadId: string, watcher: string): Promise<boolean> {
  if (watcher === 'alden') return true;
  const [row] = rowsOf(await tx.execute(sql`select 1 from coordination_threads where id = ${threadId}
    and ${watcher} in (origin_actor, intended_recipient, current_owner)`));
  return Boolean(row);
}

/**
 * Adds a watch. Only the founder, or a hat acting under his recorded
 * instruction, calls this; the caller names itself as addedBy. A self-add is
 * refused here and by the table's CHECK. Idempotent for an active watch.
 */
export async function addThreadWatch(
  input: { threadId: string; watcher: string; addedBy: string; reason: string },
  db: Db = getSharedDb(),
): Promise<{ id: string; fromGlobalSequence: number; existing: boolean }> {
  if (input.addedBy === input.watcher) throw new WatchRefusal('self_add', 'a watcher cannot add its own watch');
  if (!input.reason?.trim()) throw new WatchRefusal('reason_required', 'a watch needs a reason');
  return db.transaction(async (tx: Db) => {
    const [thread] = rowsOf(await tx.execute(sql`select id from coordination_threads where id = ${input.threadId} for update`));
    if (!thread) throw new WatchRefusal('unknown_thread', `no thread ${input.threadId}`);
    if (!await watcherCanRead(tx, input.threadId, input.watcher)) throw new WatchRefusal('not_readable', `${input.watcher} cannot read thread ${input.threadId}`);
    const [active] = rowsOf(await tx.execute(sql`select id, from_global_sequence from coordination_thread_watchers
      where thread_id = ${input.threadId} and watcher = ${input.watcher} and removed_at is null`));
    if (active) return { id: active.id, fromGlobalSequence: Number(active.from_global_sequence), existing: true };
    const [row] = rowsOf(await tx.execute(sql`
      insert into coordination_thread_watchers (thread_id, watcher, added_by, reason, from_global_sequence)
      values (${input.threadId}, ${input.watcher}, ${input.addedBy}, ${input.reason.trim()},
        (select coalesce(max(global_sequence), 0) from coordination_events))
      returning id, from_global_sequence`));
    return { id: row.id, fromGlobalSequence: Number(row.from_global_sequence), existing: false };
  });
}

/** Removes an active watch, recording who removed it and when. */
export async function removeThreadWatch(
  input: { threadId: string; watcher: string; removedBy: string },
  db: Db = getSharedDb(),
): Promise<{ id: string }> {
  const [row] = rowsOf(await db.execute(sql`update coordination_thread_watchers
    set removed_at = clock_timestamp(), removed_by = ${input.removedBy}
    where thread_id = ${input.threadId} and watcher = ${input.watcher} and removed_at is null
    returning id`));
  if (!row) throw new WatchRefusal('not_watching', `${input.watcher} is not watching thread ${input.threadId}`);
  return { id: row.id };
}

/**
 * Creates watch items for every content event on a watched thread that has
 * none yet, oldest first, one bounded batch per call. Excluded: the watcher's
 * own events, and events that already give the watcher an inbox item (it keeps
 * that addressed item, so there is never a duplicate). Idempotent.
 */
export async function materializeWatchItems(db: Db = getSharedDb(), limit = WATCH_MATERIALIZE_BATCH): Promise<number> {
  const result = await db.execute(sql`
    insert into coordination_watch_items (watch_id, watcher, event_id, thread_id, event_global_sequence, sender)
    select w.id, w.watcher, e.id, e.thread_id, e.global_sequence, e.actor
    from coordination_thread_watchers w
    join coordination_events e on e.thread_id = w.thread_id
    where e.global_sequence > w.from_global_sequence
      and (w.removed_at is null or e.created_at <= w.removed_at)
      and e.event_type in ('comment', 'steward_comment')
      and e.actor <> w.watcher
      and not exists (select 1 from coordination_inbox_items i where i.recipient_actor = w.watcher and i.coordination_event_id = e.id)
      and not exists (select 1 from coordination_watch_items x where x.watcher = w.watcher and x.event_id = e.id)
    order by e.global_sequence
    limit ${limit}
    on conflict (watcher, event_id) do nothing`);
  return Number(result?.rowCount ?? 0);
}
