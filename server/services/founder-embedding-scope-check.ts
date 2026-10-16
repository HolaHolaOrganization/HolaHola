/**
 * Read-only, fail-closed check used by a non-production instance at boot in
 * place of correctFounderEmbeddingScopes (plan efb1e3d1 S2.2, PR #36 review R1).
 *
 * A null-scoped embedding on a founder-tagged conversation memory would appear
 * in every student's recall pool. Production repairs such rows at boot (UPDATE
 * or DELETE). A dev instance must not mutate shared data to become ready, so it
 * only counts them and refuses to serve traffic if any exist.
 */
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
