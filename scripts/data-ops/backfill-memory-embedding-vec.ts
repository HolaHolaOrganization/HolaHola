/**
 * Fills memory_embeddings.embedding_vec (migration 0077) for rows written before the
 * sync trigger existed. Idempotent and resumable: it only touches rows whose
 * embedding_vec is still NULL, and stops after a time budget so a Render pre-deploy
 * is never held for long. Later runs continue where the previous one stopped and
 * are no-ops once every 768-dim row is filled.
 *
 * The Guardian's pools (conversation_memory / conversation_summary, ~37k rows) are
 * filled first so its in-database vector search can switch on after the first run;
 * the remaining ~207k rows follow over later runs.
 */
import type { Pool } from '@neondatabase/serverless';
import type { DataOpResult } from '../run-data-ops';

export const PRIORITY_TYPES = ['conversation_memory', 'conversation_summary'];
const BATCH_SIZE = 1000;
const DEFAULT_BUDGET_MS = 45_000;

type Queryable = Pick<Pool, 'query'>;

/** One pass over rows with a NULL embedding_vec, optionally limited to some types. */
async function fillPass(pool: Queryable, types: string[] | null, deadline: number,
  now: () => number): Promise<{ filled: number; complete: boolean }> {
  let after = '';
  let filled = 0;
  while (now() < deadline) {
    const batch = await pool.query(
      `SELECT id FROM memory_embeddings
        WHERE embedding_vec IS NULL AND id > $1
          AND ($2::jsonb IS NULL OR memory_type IN (SELECT jsonb_array_elements_text($2::jsonb)))
        ORDER BY id LIMIT $3`,
      [after, types ? JSON.stringify(types) : null, BATCH_SIZE],
    );
    if (batch.rows.length === 0) return { filled, complete: true };
    const ids = batch.rows.map((r: { id: string }) => r.id);
    after = ids[ids.length - 1];
    // Same conversion as the trigger (migration 0077): rows that are not a 768-element
    // numeric array stay NULL and can never fail the run.
    const updated = await pool.query(
      `UPDATE memory_embeddings SET embedding_vec = memory_embeddings_vec_or_null(embedding)
        WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))
          AND embedding_vec IS NULL
          AND memory_embeddings_vec_or_null(embedding) IS NOT NULL`,
      [JSON.stringify(ids)],
    );
    filled += updated.rowCount ?? 0;
  }
  return { filled, complete: false };
}

export async function backfill(pool: Queryable, budgetMs = DEFAULT_BUDGET_MS,
  now: () => number = Date.now): Promise<DataOpResult> {
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_embeddings' AND column_name = 'embedding_vec'`,
  );
  if (column.rows.length === 0) {
    return { applied: false, detail: 'embedding_vec column absent (pgvector unavailable) — nothing to fill' };
  }
  const deadline = now() + budgetMs;
  const priority = await fillPass(pool, PRIORITY_TYPES, deadline, now);
  const rest = priority.complete ? await fillPass(pool, null, deadline, now) : { filled: 0, complete: false };
  const filled = priority.filled + rest.filled;
  const state = rest.complete ? 'all rows filled'
    : priority.complete ? 'Guardian pools filled; remaining types continue next run'
    : 'Guardian pools still filling; continues next run';
  return { applied: filled > 0, detail: `filled ${filled} row(s); ${state}` };
}

export async function run(pool: Pool): Promise<DataOpResult> {
  return backfill(pool);
}
