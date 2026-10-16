/**
 * Read-only, fail-closed check used by a non-production instance at boot in
 * place of correctFounderEmbeddingScopes (plan efb1e3d1 S2.2, PR #36 review R1).
 *
 * A null-scoped embedding on a founder-tagged conversation memory would appear
 * in every student's recall pool. Production repairs such rows at boot (UPDATE
 * or DELETE). A dev instance must not mutate shared data to become ready, so it
 * only counts them and refuses to serve traffic if any exist.
 */
/**
 * Parses the single-row `SELECT COUNT(...)::int AS n` result. Fail closed: the
 * aggregate always owes exactly one row with a present, non-null, non-negative
 * integer `n` (a number, or a string of digits as some drivers return). Any other
 * shape throws, so unavailable count data can never be read as "clean".
 */
export function parseFounderScopeCount(result: unknown): number {
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('[Boot] Founder embedding scope check: expected exactly one count row; refusing to serve traffic.');
  }
  const row = rows[0] as Record<string, unknown> | null;
  const raw = row && typeof row === 'object' ? row.n : undefined;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  throw new Error(`[Boot] Founder embedding scope check: count is missing or invalid (${JSON.stringify(raw ?? null)}); refusing to serve traffic.`);
}

export async function assertFounderEmbeddingScopesClean(countUnscoped: () => Promise<number>): Promise<void> {
  const unscoped = await countUnscoped();
  if (!Number.isInteger(unscoped) || unscoped < 0) {
    throw new Error(`[Boot] Founder embedding scope check returned an invalid count (${String(unscoped)}); refusing to serve traffic.`);
  }
  if (unscoped > 0) {
    throw new Error(
      `[Boot] ${unscoped} founder-tagged conversation memor${unscoped === 1 ? 'y has' : 'ies have'} null-scoped embeddings. ` +
      'This instance role does not repair shared data; the production instance repairs them on its next boot. Refusing to serve traffic.',
    );
  }
}
