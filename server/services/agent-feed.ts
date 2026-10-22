/**
 * Agent awareness feed, stage F-P1 (hat feed design r5.1; canonical items only).
 *
 * Tells each hat what the OTHER hats said, drawn from canonical rows in
 * conversation_memories (tag canonical-conversation), within hard byte budgets.
 *
 * Delivery contract (design §3-§5):
 * - Actor receipts are first-ack and immutable, each stamped with its writing
 *   transaction's xid8. Enrollment writes MVCC-visible baseline receipts once.
 * - A session epoch (registration) stores its registering transaction's snapshot.
 *   A row is pending for the epoch when it has no page receipt in the epoch and
 *   either no actor receipt, or one NOT visible in the epoch snapshot. Timestamps
 *   never decide visibility.
 * - Pages serve oldest pending first; an acknowledgment may name only what that
 *   page served. Peeks write nothing. Notices are debited before output (12 per
 *   epoch), and the bootstrap is debited once per epoch.
 * - An epoch idle for 48 hours is closed; the runtime registers a new one.
 * Feed output is never written to conversation_memories.
 */
import { sql } from 'drizzle-orm';
import { getSharedDb } from '../db';

export const FEED_LIMITS = Object.freeze({
  pageBytes: 9_000,
  bootstrapBytes: 9_000,
  noticeBytes: 400,
  noticesPerEpoch: 12,
  noticeItems: 3,
  chunkBytes: 9_000,
  headlineChars: 200,
  ownBootstrapRows: 5,
  epochIdleMs: 48 * 60 * 60 * 1000,
});

/** The canonical source tag each feed actor writes under. */
export const ACTOR_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  'luca-claude-code': 'source-claude-code',
  'luca-replit': 'source-replit',
});

export class FeedError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

type Db = ReturnType<typeof getSharedDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  return ((result as { rows?: Row[] }).rows ?? []) as Row[];
}

function sourceTag(actor: string): string {
  const tag = ACTOR_SOURCE[actor];
  if (!tag) throw new FeedError(403, 'actor is not a feed reader');
  return tag;
}

/** In-scope canonical rows, with their content hash computed in SQL. */
const CANONICAL = sql`(
  select cm.id::text as id, cm.created_at, cm.tags, cm.content,
         encode(sha256(convert_to(cm.content, 'UTF8')), 'hex') as sha
  from conversation_memories cm
  where 'canonical-conversation' = any(cm.tags)
)`;

export interface FeedItem {
  itemKind: 'canonical';
  id: string;
  sha256: string;
  source: string[];
  createdAt: string;
  excerpt: string;
  clipped: { shown: number; total: number } | null;
}

/** A bounded, clearly clipped headline for one canonical row. Pure. */
export function headline(row: { id: string; sha: string; tags: string[]; created_at: Date | string; content: string }): FeedItem {
  const total = [...row.content].length;
  const shown = Math.min(total, FEED_LIMITS.headlineChars);
  return {
    itemKind: 'canonical',
    id: row.id,
    sha256: row.sha,
    source: row.tags.filter((t) => t.startsWith('source-')).sort(),
    createdAt: new Date(row.created_at).toISOString(),
    excerpt: [...row.content].slice(0, shown).join(''),
    clipped: shown < total ? { shown, total } : null,
  };
}

export function itemBytes(item: unknown): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/** Takes items in order while the serialized list stays within the byte cap. Pure. */
export function fitToBudget<T>(items: T[], budget: number): { taken: T[]; overflow: number } {
  const taken: T[] = [];
  let used = 2; // the enclosing brackets
  for (const item of items) {
    const size = itemBytes(item) + (taken.length ? 1 : 0);
    if (used + size > budget) break;
    taken.push(item);
    used += size;
  }
  return { taken, overflow: items.length - taken.length };
}

/** One-time enrollment: baseline receipts for every canonical row visible to this transaction. */
export async function enroll(actor: string): Promise<{ baselineCount: number }> {
  const own = sourceTag(actor);
  return getSharedDb().transaction(async (tx) => {
    const existing = rows(await tx.execute(sql`select 1 from agent_feed_enrollments where actor = ${actor} for update`));
    if (existing.length) throw new FeedError(409, 'actor already enrolled');
    const inserted = rows(await tx.execute(sql`
      insert into agent_feed_actor_receipts (actor, row_id, content_sha256, kind, xid)
      select ${actor}, c.id, c.sha, 'baseline', pg_current_xact_id()::text
      from ${CANONICAL} c
      where not (${own} = any(c.tags))
      on conflict do nothing
      returning 1`));
    await tx.execute(sql`insert into agent_feed_enrollments (actor, enrollment_xid, baseline_count)
      values (${actor}, pg_current_xact_id()::text, ${inserted.length})`);
    return { baselineCount: inserted.length };
  });
}

/** Registers a session epoch, storing this transaction's snapshot. */
export async function register(actor: string, runtimeSessionId: unknown): Promise<{ registrationId: string }> {
  sourceTag(actor);
  if (typeof runtimeSessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(runtimeSessionId)) throw new FeedError(400, 'invalid runtimeSessionId');
  return getSharedDb().transaction(async (tx) => {
    const enrolled = rows(await tx.execute(sql`select 1 from agent_feed_enrollments where actor = ${actor}`));
    if (!enrolled.length) throw new FeedError(409, 'actor is not enrolled');
    await tx.execute(sql`update agent_feed_registrations set closed_at = clock_timestamp()
      where actor = ${actor} and runtime_session_id = ${runtimeSessionId} and closed_at is null
        and last_activity_at < clock_timestamp() - make_interval(secs => ${FEED_LIMITS.epochIdleMs / 1000})`);
    const live = rows(await tx.execute(sql`select id from agent_feed_registrations
      where actor = ${actor} and runtime_session_id = ${runtimeSessionId} and closed_at is null`));
    if (live.length) {
      await tx.execute(sql`update agent_feed_registrations set last_activity_at = clock_timestamp() where id = ${live[0].id as string}`);
      return { registrationId: live[0].id as string };
    }
    const created = rows(await tx.execute(sql`insert into agent_feed_registrations (actor, runtime_session_id, snapshot)
      values (${actor}, ${runtimeSessionId}, pg_current_snapshot()::text) returning id`));
    return { registrationId: created[0].id as string };
  });
}

/** Loads a live epoch for the actor, closing it if idle past the TTL. */
async function liveEpoch(tx: Tx, actor: string, registrationId: unknown): Promise<Row> {
  if (typeof registrationId !== 'string') throw new FeedError(400, 'invalid registrationId');
  const found = rows(await tx.execute(sql`select * from agent_feed_registrations
    where id = ${registrationId} and actor = ${actor} for update`));
  if (!found.length) throw new FeedError(404, 'unknown registration');
  const epoch = found[0];
  if (epoch.closed_at) throw new FeedError(410, 'epoch closed; register again');
  const idle = rows(await tx.execute(sql`select (last_activity_at < clock_timestamp() - make_interval(secs => ${FEED_LIMITS.epochIdleMs / 1000})) as idle
    from agent_feed_registrations where id = ${registrationId}`))[0].idle;
  if (idle) {
    await tx.execute(sql`update agent_feed_registrations set closed_at = clock_timestamp() where id = ${registrationId}`);
    throw new FeedError(410, 'epoch closed; register again');
  }
  await tx.execute(sql`update agent_feed_registrations set last_activity_at = clock_timestamp() where id = ${registrationId}`);
  return epoch;
}

/** Pending canonical rows for an epoch, oldest first (design §3). */
async function pendingRows(tx: Tx, actor: string, epoch: Row, opts: { excludeNoticeSeen?: boolean; limit: number }): Promise<Row[]> {
  const own = sourceTag(actor);
  return rows(await tx.execute(sql`
    select c.id, c.sha, c.tags, c.created_at, c.content
    from ${CANONICAL} c
    where not (${own} = any(c.tags))
      and not exists (select 1 from agent_feed_session_receipts s
        where s.registration_id = ${epoch.id as string} and s.receipt_kind = 'page-notified'
          and s.item_kind = 'canonical' and s.item_id = c.id and s.item_sha256 = c.sha)
      ${opts.excludeNoticeSeen ? sql`and not exists (select 1 from agent_feed_session_receipts s
        where s.registration_id = ${epoch.id as string} and s.receipt_kind = 'notice-seen'
          and s.item_kind = 'canonical' and s.item_id = c.id and s.item_sha256 = c.sha)` : sql``}
      and not exists (select 1 from agent_feed_actor_receipts r
        where r.actor = ${actor} and r.row_id = c.id and r.content_sha256 = c.sha
          and pg_visible_in_snapshot(r.xid::xid8, ${epoch.snapshot as string}::pg_snapshot))
    order by c.created_at, c.id
    limit ${opts.limit}`));
}

async function servePage(tx: Tx, actor: string, epoch: Row, kind: 'page' | 'bootstrap', budget: number) {
  const candidates = (await pendingRows(tx, actor, epoch, { limit: 200 })).map((r) => headline(r as never));
  const { taken, overflow } = fitToBudget(candidates, budget);
  const bytes = itemBytes(taken);
  const served = rows(await tx.execute(sql`insert into agent_feed_served (registration_id, kind, items, bytes)
    values (${epoch.id as string}, ${kind}, ${JSON.stringify(taken.map((t) => ({ itemKind: t.itemKind, id: t.id, sha256: t.sha256 })))}::jsonb, ${bytes})
    returning id`));
  return { servedId: served[0].id as string, items: taken, morePending: overflow > 0 || candidates.length === 200 };
}

/** A catch-up page: oldest pending first, bounded by bytes. Acknowledge it with ackPage. */
export async function page(actor: string, registrationId: unknown) {
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    return servePage(tx, actor, epoch, 'page', FEED_LIMITS.pageBytes);
  });
}

/** Once per epoch, debited before output: other-hat pending page plus this hat's own recent rows (lookup only). */
export async function bootstrap(actor: string, registrationId: unknown) {
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    const claimed = rows(await tx.execute(sql`update agent_feed_registrations set bootstrap_at = clock_timestamp()
      where id = ${epoch.id as string} and bootstrap_at is null returning id`));
    if (!claimed.length) throw new FeedError(409, 'bootstrap already used in this epoch');
    const ownRecent = rows(await tx.execute(sql`select c.id, c.sha, c.tags, c.created_at, c.content from ${CANONICAL} c
      where ${sourceTag(actor)} = any(c.tags) order by c.created_at desc, c.id desc limit ${FEED_LIMITS.ownBootstrapRows}`))
      .map((r) => headline(r as never)).reverse();
    const ownFit = fitToBudget(ownRecent, Math.floor(FEED_LIMITS.bootstrapBytes / 3));
    const other = await servePage(tx, actor, epoch, 'bootstrap', FEED_LIMITS.bootstrapBytes - itemBytes(ownFit.taken));
    return { ...other, ownRecent: ownFit.taken };
  });
}

function assertServedItems(value: unknown): Array<{ itemKind: string; id: string; sha256: string }> {
  if (!Array.isArray(value) || value.length === 0) throw new FeedError(400, 'items required');
  return value.map((v) => {
    const item = v as { itemKind?: unknown; id?: unknown; sha256?: unknown };
    if (item.itemKind !== 'canonical' || typeof item.id !== 'string' || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new FeedError(400, 'invalid item');
    }
    return { itemKind: item.itemKind, id: item.id, sha256: item.sha256 };
  });
}

/** Acknowledges items of one served page or bootstrap. Every item must have been served by it. */
export async function ackPage(actor: string, registrationId: unknown, servedId: unknown, itemsInput: unknown): Promise<{ acknowledged: number }> {
  const items = assertServedItems(itemsInput);
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    if (typeof servedId !== 'string') throw new FeedError(400, 'invalid servedId');
    const served = rows(await tx.execute(sql`select items from agent_feed_served
      where id = ${servedId} and registration_id = ${epoch.id as string} and kind in ('page', 'bootstrap')`));
    if (!served.length) throw new FeedError(404, 'unknown served page');
    const servedKeys = new Set((served[0].items as Array<{ id: string; sha256: string }>).map((i) => `${i.id}:${i.sha256}`));
    for (const i of items) if (!servedKeys.has(`${i.id}:${i.sha256}`)) throw new FeedError(409, `item ${i.id} was not served by this page`);
    for (const i of items) {
      await tx.execute(sql`insert into agent_feed_session_receipts (registration_id, receipt_kind, item_kind, item_id, item_sha256)
        values (${epoch.id as string}, 'page-notified', 'canonical', ${i.id}, ${i.sha256}) on conflict do nothing`);
      await tx.execute(sql`insert into agent_feed_actor_receipts (actor, row_id, content_sha256, kind, xid)
        values (${actor}, ${i.id}, ${i.sha256}, 'delivered', pg_current_xact_id()::text) on conflict do nothing`);
    }
    return { acknowledged: items.length };
  });
}

/** What would a notice say? Writes nothing. */
export async function peek(actor: string, registrationId: unknown) {
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    const pending = await pendingRows(tx, actor, epoch, { excludeNoticeSeen: true, limit: 201 });
    const manifest = pending.slice(0, FEED_LIMITS.noticeItems).map((r) => ({ itemKind: 'canonical' as const, id: r.id as string, sha256: r.sha as string }));
    return { manifest, more: Math.max(0, pending.length - manifest.length), attemptsLeft: FEED_LIMITS.noticesPerEpoch - (epoch.notice_attempts as number) };
  });
}

/** The ≤400-byte notice body. Pure. */
export function noticeBody(items: FeedItem[], more: number): string {
  const lines = items.map((i) => `${i.source.join(',') || 'source-unknown'} ${i.createdAt.slice(0, 16)}Z ${i.id}`);
  const text = `Other hats: ${items.length} new exchange(s)${more ? `, +${more} more` : ''}. Fetch by id.\n${lines.join('\n')}`;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > FEED_LIMITS.noticeBytes) out = out.slice(0, -1);
  return out;
}

/** Debits one notice attempt before returning its body; refuses at the epoch allowance. */
export async function noticeAttempt(actor: string, registrationId: unknown) {
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    const pending = await pendingRows(tx, actor, epoch, { excludeNoticeSeen: true, limit: 201 });
    if (!pending.length) return { attemptId: null, body: null };
    const debited = rows(await tx.execute(sql`update agent_feed_registrations set notice_attempts = notice_attempts + 1
      where id = ${epoch.id as string} and notice_attempts < ${FEED_LIMITS.noticesPerEpoch} returning notice_attempts`));
    if (!debited.length) throw new FeedError(429, 'notice allowance for this epoch is used up');
    const items = pending.slice(0, FEED_LIMITS.noticeItems).map((r) => headline(r as never));
    const body = noticeBody(items, pending.length - items.length);
    const served = rows(await tx.execute(sql`insert into agent_feed_served (registration_id, kind, items, bytes)
      values (${epoch.id as string}, 'notice', ${JSON.stringify(items.map((t) => ({ itemKind: t.itemKind, id: t.id, sha256: t.sha256 })))}::jsonb,
        ${Buffer.byteLength(body, 'utf8')}) returning id`));
    return { attemptId: served[0].id as string, body };
  });
}

/** After the hook emitted a notice: records notice-seen for exactly that attempt's items. */
export async function noticeSeen(actor: string, registrationId: unknown, attemptId: unknown): Promise<{ recorded: number }> {
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    if (typeof attemptId !== 'string') throw new FeedError(400, 'invalid attemptId');
    const served = rows(await tx.execute(sql`select items from agent_feed_served
      where id = ${attemptId} and registration_id = ${epoch.id as string} and kind = 'notice'`));
    if (!served.length) throw new FeedError(404, 'unknown notice attempt');
    const items = served[0].items as Array<{ id: string; sha256: string }>;
    for (const i of items) {
      await tx.execute(sql`insert into agent_feed_session_receipts (registration_id, receipt_kind, item_kind, item_id, item_sha256)
        values (${epoch.id as string}, 'notice-seen', 'canonical', ${i.id}, ${i.sha256}) on conflict do nothing`);
    }
    return { recorded: items.length };
  });
}

/** One ≤9,000-byte chunk of a canonical row, with the whole version's hash. Records 'fetched'. */
export async function rowChunk(actor: string, registrationId: unknown, rowId: unknown, chunkInput: unknown) {
  const chunk = Number(chunkInput ?? 0);
  if (!Number.isSafeInteger(chunk) || chunk < 0) throw new FeedError(400, 'invalid chunk');
  if (typeof rowId !== 'string' || !/^[0-9a-f-]{36}$/.test(rowId)) throw new FeedError(400, 'invalid row id');
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    const found = rows(await tx.execute(sql`select c.id, c.sha, c.content, c.tags from ${CANONICAL} c where c.id = ${rowId}`));
    if (!found.length) throw new FeedError(404, 'no canonical row with that id');
    const buf = Buffer.from(found[0].content as string, 'utf8');
    const chunks = Math.max(1, Math.ceil(buf.length / FEED_LIMITS.chunkBytes));
    if (chunk >= chunks) throw new FeedError(416, 'chunk out of range');
    await tx.execute(sql`insert into agent_feed_session_receipts (registration_id, receipt_kind, item_kind, item_id, item_sha256)
      values (${epoch.id as string}, 'fetched', 'canonical', ${rowId}, ${found[0].sha as string}) on conflict do nothing`);
    return {
      id: rowId, sha256: found[0].sha as string, chunk, chunks,
      bytesBase64: buf.subarray(chunk * FEED_LIMITS.chunkBytes, (chunk + 1) * FEED_LIMITS.chunkBytes).toString('base64'),
    };
  });
}

/** Records 'read' only when the client confirms it holds the complete current version. */
export async function confirmRead(actor: string, registrationId: unknown, rowId: unknown, sha256: unknown, receivedSha256: unknown): Promise<{ read: boolean }> {
  if (typeof rowId !== 'string' || typeof sha256 !== 'string' || typeof receivedSha256 !== 'string') throw new FeedError(400, 'invalid read confirmation');
  return getSharedDb().transaction(async (tx) => {
    const epoch = await liveEpoch(tx, actor, registrationId);
    const found = rows(await tx.execute(sql`select c.sha from ${CANONICAL} c where c.id = ${rowId}`));
    if (!found.length || found[0].sha !== sha256 || receivedSha256 !== sha256) return { read: false };
    await tx.execute(sql`insert into agent_feed_session_receipts (registration_id, receipt_kind, item_kind, item_id, item_sha256)
      values (${epoch.id as string}, 'read', 'canonical', ${rowId}, ${sha256}) on conflict do nothing`);
    return { read: true };
  });
}

