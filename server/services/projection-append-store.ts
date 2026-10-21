/**
 * The I/O half of the common attribution-aware append (attribution design
 * f5d77712 section 3.3 "Atomic, idempotent projection appends"; revision 10
 * section 3.4 "one common atomic append"). planProjectionAppend decides;
 * this runs that decision inside ONE transaction with the row locked
 * FOR UPDATE and writes content and turnAttribution together.
 *
 * Every aware writer goes through applyProjectionAppend. A noop (exact
 * retry) and a conflict write nothing; only "append" changes the row.
 */
import { sql } from 'drizzle-orm';
import { planProjectionAppend, type AppendEvent } from './projection-append';
import { turnAttributionOf } from './turn-attribution';

/** The minimal executor this module needs: drizzle's execute. */
export interface SqlExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}
export interface TransactionalDb extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export type StoredAppend =
  | { kind: 'append'; content: string }
  | { kind: 'noop'; content: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'missing' };

export const rowsOf = (result: unknown): Record<string, unknown>[] =>
  ((result as { rows?: unknown[] })?.rows ?? (Array.isArray(result) ? result : [])) as Record<string, unknown>[];

/**
 * Apply one source event to an existing row inside the caller's transaction.
 * The row is locked FOR UPDATE, so concurrent appends to the same row are
 * serialized by PostgreSQL and none can lose another's frames.
 */
export async function applyProjectionAppendInTx(tx: SqlExecutor, rowId: string, event: AppendEvent): Promise<StoredAppend> {
  const locked = rowsOf(await tx.execute(sql`
    SELECT content, attribution FROM conversation_memories WHERE id = ${rowId} FOR UPDATE
  `))[0];
  if (!locked) return { kind: 'missing' };
  const content = typeof locked.content === 'string' ? locked.content : '';
  // Only a missing turnAttribution key is legacy. A present key whose value is
  // null is malformed aware metadata: refuse it, never treat it as legacy
  // (luca-replit review R4; matches the legacy-append guard's key test).
  const column = locked.attribution;
  if (typeof column === 'object' && column !== null && Object.hasOwn(column, 'turnAttribution')
    && (column as Record<string, unknown>).turnAttribution === null) {
    return { kind: 'conflict', reason: 'turnAttribution is present but null: malformed aware metadata' };
  }
  const plan = planProjectionAppend(content, turnAttributionOf(column), event);
  if (plan.kind === 'conflict') return plan;
  if (plan.kind === 'noop') return { kind: 'noop', content };
  // Keep any other keys in the attribution column (e.g. canonical-row
  // fields); only turnAttribution is replaced, together with the content.
  await tx.execute(sql`
    UPDATE conversation_memories
    SET content = ${plan.content},
        attribution = COALESCE(attribution, '{}'::jsonb) || jsonb_build_object('turnAttribution', ${JSON.stringify(plan.turnAttribution)}::jsonb)
    WHERE id = ${rowId}
  `);
  return { kind: 'append', content: plan.content };
}

/** applyProjectionAppendInTx in its own transaction. */
export function applyProjectionAppend(db: TransactionalDb, rowId: string, event: AppendEvent): Promise<StoredAppend> {
  return db.transaction(tx => applyProjectionAppendInTx(tx, rowId, event));
}

/** The current rolling episode row's id, read from the database (never a cache). */
export async function currentRollingEpisodeId(db: SqlExecutor): Promise<string | null> {
  const row = rowsOf(await db.execute(sql`
    SELECT id FROM conversation_memories
    WHERE arc_name = 'HolaHola Episodes' AND 'rolling' = ANY(tags)
    ORDER BY created_at DESC
    LIMIT 1
  `))[0];
  return typeof row?.id === 'string' ? row.id : null;
}
