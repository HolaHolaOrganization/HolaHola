/**
 * The legacy (unframed) episode append, guarded at the row (attribution
 * design f5d77712 section 3.4; luca-replit's requirements on PR71).
 *
 * Once a row carries per-turn attribution, an unframed append would leave
 * bytes after coveredEnd and invalidate every frame. The guard is part of the
 * UPDATE's own predicate, so it follows the row's persisted state, not the
 * current switch value. It survives a switch rollback and a restart, and it
 * cannot race the first framed append: PostgreSQL re-evaluates the predicate
 * after a concurrent UPDATE commits. Any present `turnAttribution` key counts
 * as aware, including a malformed one; an invalid aware row is never
 * downgraded to legacy to let an append through. On refusal nothing is
 * written, so existing framed history is unchanged.
 */
import { sql } from 'drizzle-orm';
import { rowsOf, type SqlExecutor } from './projection-append-store';

export type LegacyAppendResult =
  | { kind: 'appended'; content: string }
  /** The marker is already present: an exact retry of a committed append. */
  | { kind: 'already-present'; content: string }
  /** The row carries per-turn attribution: refused, nothing written. */
  | { kind: 'refused-aware' }
  /** Not updated for no reason this function can name: never reported as success. */
  | { kind: 'refused'; reason: string }
  | { kind: 'missing' };

export async function appendUnframedToLegacyRow(
  db: SqlExecutor,
  rowId: string,
  appendText: string,
  marker?: string,
): Promise<LegacyAppendResult> {
  const appendBytes = '\n' + appendText + '\n';
  const updated = rowsOf(await db.execute(marker
    ? sql`
        UPDATE conversation_memories
        SET content = content || ${appendBytes}
        WHERE id = ${rowId}
          AND NOT (COALESCE(attribution, '{}'::jsonb) ? 'turnAttribution')
          AND POSITION(${marker} IN content) = 0
        RETURNING content
      `
    : sql`
        UPDATE conversation_memories
        SET content = content || ${appendBytes}
        WHERE id = ${rowId}
          AND NOT (COALESCE(attribution, '{}'::jsonb) ? 'turnAttribution')
        RETURNING content
      `))[0];
  if (updated) return { kind: 'appended', content: updated.content as string };
  // Nothing was written; say exactly why.
  const row = rowsOf(await db.execute(sql`
    SELECT content, (COALESCE(attribution, '{}'::jsonb) ? 'turnAttribution') AS aware
    FROM conversation_memories WHERE id = ${rowId}
  `))[0];
  if (!row) return { kind: 'missing' };
  if (row.aware === true) return { kind: 'refused-aware' };
  if (marker && typeof row.content === 'string' && row.content.includes(marker)) return { kind: 'already-present', content: row.content };
  return { kind: 'refused', reason: 'the conditional append matched no row although the row is neither aware nor already marked' };
}
