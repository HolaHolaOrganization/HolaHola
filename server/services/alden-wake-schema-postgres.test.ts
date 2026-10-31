/**
 * Migration 0075 (Alden inbox wake, design eb2ed6bf r11) against the CI job's
 * disposable PostgreSQL: the wake ships enabled, attempt rows only take the
 * designed states and kinds, a thread holds at most one active pause and one
 * active watch per watcher, a pause's cooldown stays within 30 to 240 minutes,
 * and no hat can add itself as a watcher. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

let pool: pg.Pool | null = null;
const threads: string[] = [];
after(async () => {
  if (!pool) return;
  // Cascades remove the events, inbox items, attempts, audit, outbox, pauses and watches.
  if (threads.length) await pool.query('delete from coordination_threads where id = any($1::varchar[])', [threads]);
  await pool.end();
});

async function insertRow(table: string, columns: Record<string, unknown>): Promise<void> {
  const names = Object.keys(columns);
  await pool!.query(
    `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(columns),
  );
}

async function rejects(table: string, columns: Record<string, unknown>, code: string, constraint: string): Promise<void> {
  await assert.rejects(insertRow(table, columns), (err: any) => err.code === code && err.constraint === constraint, constraint);
}

/** A thread with one bookkeeping event and an inbox item for Alden, the shape the wake claims. */
async function seedInboxItem(): Promise<{ threadId: string; itemId: string; sequence: number }> {
  const threadId = randomUUID();
  await insertRow('coordination_threads', { id: threadId, title: '0075 test', description: 'synthetic', origin_actor: 'luca-claude-code', intended_recipient: 'alden' });
  threads.push(threadId);
  const eventId = randomUUID();
  const { rows } = await pool!.query(
    `insert into coordination_events (id, thread_id, sequence, actor, event_type, content, idempotency_key)
     values ($1, $2, 1, 'luca-claude-code', 'progress', 'synthetic', $3) returning global_sequence`,
    [eventId, threadId, `0075-test-${eventId}`],
  );
  const sequence = Number(rows[0].global_sequence);
  const itemId = randomUUID();
  await insertRow('coordination_inbox_items', {
    id: itemId, recipient_actor: 'alden', coordination_event_id: eventId, coordination_thread_id: threadId,
    event_global_sequence: sequence, sender_actor: 'luca-claude-code', message_kind: 'progress', recipient_rule_version: 1,
  });
  return { threadId, itemId, sequence };
}

function attempt(item: { threadId: string; itemId: string; sequence: number }, columns: Record<string, unknown> = {}) {
  return {
    inbox_item_id: item.itemId, event_global_sequence: item.sequence, state: 'eligible',
    effect_key: `wake:${item.itemId}:${randomUUID()}`, target_thread_id: item.threadId, target_sender: 'luca-claude-code',
    ...columns,
  };
}

test('Alden wake tables: shipped enabled, designed states only, one active pause and watch', async (context) => {
  const url = getVerifiedCiDatabaseUrl();
  if (!url) {
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  pool = new pg.Pool({ connectionString: url });

  // Ships on: the migration's single control row exists and is enabled, and no second row is allowed.
  const control = await pool.query(`select id, enabled from alden_wake_control`);
  assert.deepEqual(control.rows, [{ id: 'alden', enabled: true }]);
  await rejects('alden_wake_control', { id: 'other', enabled: true }, '23514', 'alden_wake_control_single_row');

  // Attempts: every designed state is accepted for its kind; anything else is refused.
  for (const state of ['eligible', 'replied', 'declined', 'needs_david', 'failed', 'uncertain', 'conflict', 'manual', 'covered', 'handled_in_chat', 'history']) {
    await insertRow('alden_wake_attempts', attempt(await seedInboxItem(), { state }));
  }
  await insertRow('alden_wake_attempts', attempt(await seedInboxItem(), { state: 'observed', item_kind: 'observe' }));
  await insertRow('alden_wake_attempts', attempt(await seedInboxItem(), {
    state: 'claimed', claimed_by: 'worker-1', claimed_at: new Date(), lease_until: new Date(Date.now() + 60_000), claim_epoch: 1,
  }));
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { state: 'sleeping' }), '23514', 'alden_wake_attempts_state_valid');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { item_kind: 'broadcast' }), '23514', 'alden_wake_attempts_kind_valid');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { state: 'observed' }), '23514', 'alden_wake_attempts_observed_kind');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { state: 'needs_david', item_kind: 'observe' }), '23514', 'alden_wake_attempts_observe_never_needs_david');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { state: 'claimed', claimed_by: 'worker-1' }), '23514', 'alden_wake_attempts_claim_complete');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { reply_payload_sha256: 'ABC' }), '23514', 'alden_wake_attempts_reply_sha256');
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { claim_epoch: -1 }), '23514', 'alden_wake_attempts_epoch_nonnegative');
  const effect = await seedInboxItem();
  const shared = `wake:${effect.itemId}:shared`;
  await insertRow('alden_wake_attempts', attempt(effect, { effect_key: shared }));
  await rejects('alden_wake_attempts', attempt(await seedInboxItem(), { effect_key: shared }), '23505', 'uq_alden_wake_attempts_effect_key');
  await rejects('alden_wake_attempts', { ...attempt(effect), inbox_item_id: randomUUID() }, '23503', 'alden_wake_attempts_inbox_item_id_coordination_inbox_items_id_fk');

  // Audit and outbox take only their closed result and status sets.
  await insertRow('alden_wake_attempt_audit', { inbox_item_id: effect.itemId, claim_epoch: 1, worker_id: 'worker-1', result: 'published' });
  await rejects('alden_wake_attempt_audit', { inbox_item_id: effect.itemId, claim_epoch: 1, worker_id: 'worker-1', result: 'maybe' }, '23514', 'alden_wake_attempt_audit_result_valid');
  await insertRow('alden_wake_notice_outbox', { inbox_item_id: effect.itemId, state_reported: 'needs_david', dedupe_key: `notice:${effect.itemId}` });
  await rejects('alden_wake_notice_outbox', { inbox_item_id: effect.itemId, state_reported: 'needs_david', dedupe_key: `notice:${effect.itemId}` }, '23505', 'uq_alden_wake_notice_outbox_dedupe');
  await rejects('alden_wake_notice_outbox', { inbox_item_id: effect.itemId, state_reported: 'failed', dedupe_key: `notice:${randomUUID()}`, status: 'sent' }, '23514', 'alden_wake_notice_outbox_status_valid');

  // Pauses: cooldown 30 to 240 minutes, resume after the pause, one active pause per thread.
  const pausedAt = new Date();
  const pause = (minutes: number, columns: Record<string, unknown> = {}) => ({
    thread_id: effect.threadId, paused_at: pausedAt, reason: 'repeating_exchange', evidence: JSON.stringify({ pairs: 3 }),
    resume_at: new Date(pausedAt.getTime() + minutes * 60_000), cooldown_minutes: minutes, ...columns,
  });
  await rejects('alden_wake_thread_pauses', pause(29), '23514', 'alden_wake_thread_pauses_cooldown_bounds');
  await rejects('alden_wake_thread_pauses', pause(241), '23514', 'alden_wake_thread_pauses_cooldown_bounds');
  await rejects('alden_wake_thread_pauses', pause(30, { reason: 'volume' }), '23514', 'alden_wake_thread_pauses_reason_valid');
  await rejects('alden_wake_thread_pauses', pause(30, { resume_at: pausedAt }), '23514', 'alden_wake_thread_pauses_resume_after_pause');
  await rejects('alden_wake_thread_pauses', pause(30, { resumed_at: new Date() }), '23514', 'alden_wake_thread_pauses_resumed_complete');
  await insertRow('alden_wake_thread_pauses', pause(30, { resumed_at: new Date(), resumed_by: 'david' }));
  await insertRow('alden_wake_thread_pauses', pause(240));
  await rejects('alden_wake_thread_pauses', pause(60), '23505', 'uq_alden_wake_thread_pauses_active');

  // Watches: never a self-add, a reason is required, one active watch per watcher and thread.
  const watch = (columns: Record<string, unknown> = {}) => ({
    thread_id: effect.threadId, watcher: 'alden', added_by: 'david', reason: 'onboarding thread', from_global_sequence: effect.sequence, ...columns,
  });
  await rejects('coordination_thread_watchers', watch({ added_by: 'alden' }), '23514', 'coordination_thread_watchers_no_self_add');
  await rejects('coordination_thread_watchers', watch({ reason: '   ' }), '23514', 'coordination_thread_watchers_reason_nonempty');
  await rejects('coordination_thread_watchers', watch({ removed_at: new Date() }), '23514', 'coordination_thread_watchers_removed_complete');
  await insertRow('coordination_thread_watchers', watch({ removed_at: new Date(), removed_by: 'david' }));
  await insertRow('coordination_thread_watchers', watch());
  await insertRow('coordination_thread_watchers', watch({ watcher: 'luca-codex' }));
  await rejects('coordination_thread_watchers', watch(), '23505', 'uq_coordination_thread_watchers_active');
});
