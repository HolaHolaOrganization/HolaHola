/**
 * restore-rolling-episodes-from-db.ts
 *
 * Restores all rolling episode .md files from the canonical DB records when
 * a file has been overwritten by a stale task-agent commit (shrinkage detection).
 *
 * Rolling episodes are discovered automatically by querying the DB for all
 * conversation_memories rows tagged 'rolling' in the HolaHola Episodes arc.
 * No code changes are needed when a new episode becomes the rolling one.
 *
 * Usage:
 *   npx tsx server/scripts/restore-rolling-episodes-from-db.ts
 *     → always restores all rolling episodes (unconditional)
 *
 *   npx tsx server/scripts/restore-rolling-episodes-from-db.ts --check-shrinkage
 *     → restores when .md and DB differ by more than SIZE_DELTA_THRESHOLD
 *       normalized characters in EITHER direction: .md shorter than DB (a
 *       stale task-agent overwrite) or .md longer than DB (content written
 *       straight to the file, bypassing the DB-first path — the DB is always
 *       canonical and the .md must never hold content the DB lacks). Exits 0
 *       in both cases. Used at startup.
 *
 *   npx tsx server/scripts/restore-rolling-episodes-from-db.ts --force-push
 *     → unconditionally push ALL rolling .md files → DB, bypassing the
 *       length/shrinkage guard. Use after an intentional editorial edit that
 *       makes the .md shorter than the DB (e.g. removing a raw dump section).
 *       Cannot be combined with --check-shrinkage.
 *
 *   npx tsx server/scripts/restore-rolling-episodes-from-db.ts --force-push --episode-id=<uuid>
 *     → restrict force-push (or any mode) to a single episode by DB id.
 *       Safe for CI/test use: no other rolling records are touched.
 *
 *   npx tsx server/scripts/restore-rolling-episodes-from-db.ts --force-push --skip-missing
 *     → when combined with --force-push, episodes whose .md file does not yet
 *       exist on disk are silently skipped (warning logged) instead of causing
 *       a fatal error. Useful when a new episode has been added to the DB but
 *       its docs/ file has not been written yet.
 *
 * Exit codes:
 *   0  — OK (no shrinkage detected for any episode, or all restores succeeded)
 *   1  — Fatal error (DB unavailable, write failed)
 */

import './lib/held-writer-preflight'; // O2/O3 containment: must stay the first import
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { neon } from '@neondatabase/serverless';
import { Pool } from 'pg';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import { writeProjectionAtomically } from '../services/projection-receipts';

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const W = (s: string) => `\x1b[33;1m${s}\x1b[0m`;

/**
 * Minimum number of normalized characters by which the .md and the DB may
 * differ before we treat it as a real integrity violation. Tiny diffs (e.g.
 * a trailing newline) are ignored.
 *
 * The DB is always canonical, so drift in EITHER direction is a bug:
 *   - .md shorter than DB (positive delta) → a stale task-agent overwrite
 *     wiped content that should still be there.
 *   - .md longer than DB (negative delta)  → something wrote content
 *     directly into the .md, bypassing the DB-first append path. The .md is
 *     a derived projection and must never contain content the DB lacks.
 */
const SIZE_DELTA_THRESHOLD = 200;

const ARC_NAME = 'HolaHola Episodes';

/**
 * The sealed Episode 28 snapshot ID. This ID must NEVER be targeted by any
 * write operation in this script. If forcePushMdToDb or checkAndRestore are
 * ever called with this ID, the operation is immediately rejected with a
 * logged warning. The snapshot lives in a separate arc ('HolaHola Episode
 * Snapshots') so it will not appear in the rolling-episode discovery query,
 * but the guard here provides defense-in-depth for the force-push path.
 */
const SNAPSHOT_WRITE_GUARD_ID = '28000000-0001-4000-8000-000000000028';

/** Returns true if content contains git merge conflict markers. */
function hasGitConflictMarkers(content: string): boolean {
  return content.includes('<<<<<<< ') ||
         content.includes('=======') ||
         content.includes('>>>>>>> ');
}

/** Normalize for length comparison (same logic as the CI sync check). */
function normalize(s: string): string {
  return s
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Derive the docs/ file path from an episode title.
 *
 * Handles titles of the form:
 *   "Episode 27"
 *   "Episode 27 — Luca's Episode One"
 *   "Episode 28 — Something"
 *
 * Returns null if the title does not contain a recognisable episode number.
 */
function titleToMdPath(title: string): string | null {
  const match = title.match(/^Episode\s+(\d+)/i);
  if (!match) return null;
  const num = match[1];
  return join(process.cwd(), 'docs', `episode-${num}.md`);
}

interface EpisodeRow {
  id: string;
  title: string;
  content: string;
}

// NeonQueryFunction<false,false> (the concrete return type of neon()) is not
// assignable to ReturnType<typeof neon> due to the overload signature. Use a
// minimal structural type that covers the tagged-template call we actually make.
type NeonSqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

async function forcePushMdToDb(
  sql: NeonSqlFn,
  episode: EpisodeRow,
  mdPath: string,
): Promise<boolean> {
  const { id, title, content: dbContent } = episode;

  console.log('');
  console.log(B(`  ── ${title} (${id}) ──`));

  // ── Snapshot write-guard ───────────────────────────────────────────────────
  // The sealed snapshot MUST NOT be overwritten by force-push or any other
  // write path.  Reject immediately and log a clear warning.
  if (id === SNAPSHOT_WRITE_GUARD_ID) {
    console.error(`\x1b[31m  BLOCKED: forcePushMdToDb was called with the sealed snapshot ID.\x1b[0m`);
    console.error(`\x1b[31m  Snapshot ID : ${SNAPSHOT_WRITE_GUARD_ID}\x1b[0m`);
    console.error(`\x1b[31m  The snapshot is read-only and must never be overwritten.\x1b[0m`);
    console.error(`\x1b[31m  Skipping this episode — no DB write was performed.\x1b[0m`);
    return false;
  }

  if (!existsSync(mdPath)) {
    console.error(R(`  FATAL: .md file does not exist at ${mdPath}`));
    console.error(R(`         The file must exist on disk before --force-push can push it to the DB.`));
    console.error(R(`         If this episode is new and its .md has not been written yet,`));
    console.error(R(`         either write the file first, or re-run with --skip-missing to skip`));
    console.error(R(`         episodes whose .md is absent instead of treating them as fatal.`));
    return false;
  }

  let mdContent: string;
  try {
    mdContent = readFileSync(mdPath, 'utf8');
  } catch (err: any) {
    console.error(R(`  FATAL: Could not read ${mdPath}: ${err?.message ?? err}`));
    return false;
  }

  // Reject content with unresolved git conflict markers — same guard as in
  // sync-episode-28-from-md.ts, applied here before any DB write.
  if (hasGitConflictMarkers(mdContent)) {
    console.error(R(
      `  FATAL: ${mdPath} contains git merge conflict markers ` +
      `(<<<<<<< / ======= / >>>>>>>). ` +
      `Resolve the conflict before force-pushing to prevent DB corruption.`
    ));
    return false;
  }

  const dbNorm = normalize(dbContent ?? '');
  const mdNorm = normalize(mdContent);

  console.log(Y(`  ℹ  DB record: ${(dbContent ?? '').length} raw bytes / ${dbNorm.length} normalized chars`));
  console.log(Y(`  ℹ  .md file : ${mdContent.length} raw bytes / ${mdNorm.length} normalized chars`));

  if (mdContent.length >= (dbContent ?? '').length) {
    console.log(Y(`  ℹ  .md is already longer or equal — force-push is a no-op here, but proceeding anyway`));
  } else {
    console.log(W(`  ⚠  FORCE-PUSH: .md is shorter than DB by ${(dbContent ?? '').length - mdContent.length} bytes`));
    console.log(W(`     Bypassing length guard — pushing .md → DB unconditionally`));
  }

  try {
    await sql`UPDATE conversation_memories SET content = ${mdContent} WHERE id = ${id}`;
    console.log(B(''));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log(B(`  FORCE-PUSHED: ${mdPath} → DB`));
    console.log(B(`  DB id   : ${id}`));
    console.log(B(`  Size    : ${mdContent.length} bytes (DB now matches .md)`));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log('');
    return true;
  } catch (err: any) {
    console.error(R(`  FATAL: DB update failed for ${title}: ${err?.message ?? err}`));
    return false;
  }
}

async function checkAndRestore(
  episode: EpisodeRow,
  mdPath: string,
  checkShrinkageOnly: boolean,
): Promise<boolean> {
  const { id, title, content: dbContent } = episode;

  console.log('');
  console.log(B(`  ── ${title} (${id}) ──`));

  // ── Snapshot write-guard ───────────────────────────────────────────────────
  // Defensive check: the sealed snapshot must not be overwritten even via the
  // restore path.  The discovery query filters by arc so this ID should never
  // arrive here, but defense-in-depth requires an explicit rejection.
  if (id === SNAPSHOT_WRITE_GUARD_ID) {
    console.error(`\x1b[31m  BLOCKED: checkAndRestore was called with the sealed snapshot ID.\x1b[0m`);
    console.error(`\x1b[31m  Snapshot ID : ${SNAPSHOT_WRITE_GUARD_ID}\x1b[0m`);
    console.error(`\x1b[31m  The snapshot must never be overwritten by restore operations.\x1b[0m`);
    console.error(`\x1b[31m  Skipping this episode — no file write was performed.\x1b[0m`);
    return false;
  }

  if (!dbContent) {
    console.error(R(`  FATAL: DB content field is empty for ${title} — cannot restore`));
    return false;
  }

  const dbNorm = normalize(dbContent);
  console.log(Y(`  ℹ  DB record: ${dbContent.length} raw bytes / ${dbNorm.length} normalized chars`));

  if (!existsSync(mdPath)) {
    console.log(Y(`  ℹ  .md file does not exist — restoring from DB`));
  } else {
    try {
      const mdContent = readFileSync(mdPath, 'utf8');
      const mdNorm = normalize(mdContent);
      console.log(Y(`  ℹ  .md file : ${mdContent.length} raw bytes / ${mdNorm.length} normalized chars`));

      if (checkShrinkageOnly) {
        const shrinkage = dbNorm.length - mdNorm.length;

        if (Math.abs(shrinkage) <= SIZE_DELTA_THRESHOLD) {
          console.log(
            G(`  ✓  In sync (db=${dbNorm.length}, md=${mdNorm.length}, delta=${shrinkage}).`),
          );
          console.log(G(`     ${mdPath} matches DB within tolerance — no restore needed.`));
          return true; // no restore needed
        }

        if (shrinkage > 0) {
          // .md shorter than DB by more than tolerance → overwrite detected
          console.log('');
          console.log(W('  ⚠  SHRINKAGE DETECTED — task-agent overwrite suspected'));
          console.log(W(`     DB has ${dbNorm.length} chars; .md has ${mdNorm.length} chars`));
          console.log(W(`     Delta: -${shrinkage} chars (threshold: ${SIZE_DELTA_THRESHOLD})`));
          console.log(W(`     Restoring ${mdPath} from DB canonical version...`));
          console.log('');
        } else {
          // .md LONGER than DB by more than tolerance → the .md holds content
          // the DB doesn't have. The DB is always canonical — this must never
          // happen. Restore from DB to remove whatever bypassed the DB-first
          // write path.
          console.log('');
          console.log(W('  ⚠  GROWTH DETECTED — .md contains content the DB does not have'));
          console.log(W(`     DB has ${dbNorm.length} chars; .md has ${mdNorm.length} chars`));
          console.log(W(`     Delta: +${-shrinkage} chars (threshold: ${SIZE_DELTA_THRESHOLD})`));
          console.log(W(`     The DB is canonical — restoring ${mdPath} from DB to remove the excess...`));
          console.log('');
        }
      }
    } catch (err: any) {
      console.error(R(`  ✗  Could not read .md file: ${err?.message ?? err} — will restore unconditionally`));
    }
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  try {
    writeProjectionAtomically(process.cwd(), mdPath, dbContent, {
      kind: 'episode-db-markdown',
      writer: 'restore-rolling-episodes-from-db',
      source: { type: 'conversation_memory', ids: [id] },
      reason: checkShrinkageOnly ? 'rolling episode shrinkage restore' : 'rolling episode startup restore',
      correlation: { episodeId: id, title },
    });
    console.log(B(''));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log(B(`  RESTORED: ${mdPath}`));
    console.log(B(`  DB id   : ${id}`));
    console.log(B(`  Size    : ${dbContent.length} bytes`));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log('');
    return true;
  } catch (err: any) {
    console.error(R(`FATAL: Could not write ${mdPath}: ${err?.message ?? err}`));
    return false;
  }
}

/** Parse --episode-id=<uuid> from argv, returns null if not provided. */
function parseEpisodeIdFilter(): string | null {
  const arg = process.argv.find(a => a.startsWith('--episode-id='));
  return arg ? arg.slice('--episode-id='.length).trim() : null;
}

async function main() {
  const checkShrinkageOnly = process.argv.includes('--check-shrinkage');
  const forcePush = process.argv.includes('--force-push');
  const skipMissing = process.argv.includes('--skip-missing');
  const episodeIdFilter = parseEpisodeIdFilter();

  if (skipMissing && !forcePush) {
    console.error(R('FATAL: --skip-missing only applies to --force-push; combine them as --force-push --skip-missing'));
    process.exit(1);
  }

  if (forcePush && checkShrinkageOnly) {
    console.error(R('FATAL: --force-push and --check-shrinkage are mutually exclusive'));
    process.exit(1);
  }

  const ciDatabaseUrl = getVerifiedCiDatabaseUrl();
  const DATABASE_URL = ciDatabaseUrl ?? process.env.NEON_SHARED_DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(R('FATAL: NEON_SHARED_DATABASE_URL is not set'));
    process.exit(1);
  }

  // Keep the normal Neon HTTP path unchanged. Integration tests run this same
  // CLI against explicitly verified, job-local PostgreSQL (no Neon endpoint).
  const ciPool = ciDatabaseUrl ? new Pool({ connectionString: ciDatabaseUrl }) : null;
  const sql = ciPool
    ? (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((query, part, i) => query + (i ? `$${i}` : '') + part, '');
        return (await ciPool.query(text, values)).rows;
      }) as unknown as NeonSqlFn
    : neon(DATABASE_URL);

  if (forcePush) {
    if (episodeIdFilter) {
      console.log(W(`[rolling-restore] --force-push mode: restricted to episode id ${episodeIdFilter}`));
    } else {
      console.log(W('[rolling-restore] --force-push mode: pushing ALL rolling .md files → DB (bypassing length guard)'));
      console.log(W('[rolling-restore] Use this ONLY for intentional editorial edits that shorten the .md'));
    }
    console.log('');
  }

  // ── Backfill: stamp rolling-protected on any historically-rolling episodes ──
  // set-rolling-episode.ts now stamps 'rolling-protected' on demoted rows
  // BEFORE removing 'rolling', but older handoffs (e.g. the Episode 27 →
  // Episode 28 promotion) ran before that step was added and left Episode 27
  // with neither tag.  This idempotent UPDATE catches any such gaps so the
  // discovery query below finds them.
  //
  // The title list covers every episode known to have been the rolling one
  // before the step-A0 protection was introduced.  It is safe to re-run on
  // every startup because the CASE guard makes it a no-op for rows that
  // already have the tag.
  const knownHistoricalRollingTitles = ['Episode 27'];
  for (const historicalTitle of knownHistoricalRollingTitles) {
    try {
      const backfillResult = await sql`
        UPDATE conversation_memories
        SET tags = CASE WHEN 'rolling-protected' = ANY(tags)
                        THEN tags
                        ELSE array_append(tags, 'rolling-protected')
                   END
        WHERE arc_name = ${ARC_NAME}
          AND title    = ${historicalTitle}
          AND NOT ('rolling-protected' = ANY(tags))
        RETURNING id
      `;
      if (backfillResult.length > 0) {
        console.log(
          Y(`[rolling-restore] Backfilled rolling-protected on "${historicalTitle}" ` +
            `(id: ${(backfillResult[0] as any).id})`),
        );
      }
    } catch (err: any) {
      // Non-fatal — if the backfill fails we still attempt the main restore.
      console.error(Y(`[rolling-restore] Backfill warning for "${historicalTitle}": ${err?.message ?? err}`));
    }
  }

  // ── Discover all rolling episodes in the arc ────────────────────────────────
  // Query for EITHER 'rolling' (current) OR 'rolling-protected' (all episodes
  // that have ever been rolling). 'rolling-protected' is a permanent tag added
  // by set-rolling-episode.ts when promoting; it is never removed, so retired
  // rolling episodes remain protected even after the handoff.
  const rows = await sql`
    SELECT id, title, content
    FROM conversation_memories
    WHERE arc_name = ${ARC_NAME}
      AND (
        'rolling' = ANY(tags)
        OR 'rolling-protected' = ANY(tags)
      )
    ORDER BY created_at ASC
  ` as EpisodeRow[];

  if (rows.length === 0) {
    console.log(Y('[rolling-restore] No rolling episodes found in DB — nothing to restore.'));
    process.exit(0);
  }

  const filteredRows = episodeIdFilter
    ? rows.filter(r => (r.id as string) === episodeIdFilter)
    : rows;

  if (episodeIdFilter && filteredRows.length === 0) {
    console.error(R(`[rolling-restore] No rolling episode found with id "${episodeIdFilter}" — nothing to do.`));
    process.exit(1);
  }

  console.log(B(`[rolling-restore] Found ${rows.length} rolling episode(s); processing ${filteredRows.length}.`));

  let anyFatal = false;

  for (const row of filteredRows) {
    const episode: EpisodeRow = {
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
    };

    const mdPath = titleToMdPath(episode.title);
    if (!mdPath) {
      console.error(R(`  SKIP: Cannot derive .md path from title "${episode.title}" — no episode number found`));
      continue;
    }

    // --skip-missing: warn and continue without marking fatal when the .md
    // file for this episode does not yet exist on disk.  Only applies to
    // --force-push (checked above); the restore path handles its own missing-
    // file case by restoring from DB.
    if (forcePush && skipMissing && !existsSync(mdPath)) {
      console.log('');
      console.log(B(`  ── ${episode.title} (${episode.id}) ──`));
      console.log(Y(`  ⚠  SKIPPED (--skip-missing): .md file does not yet exist at ${mdPath}`));
      console.log(Y(`     Write the file first, then re-run --force-push to push it to the DB.`));
      continue;
    }

    const ok = forcePush
      ? await forcePushMdToDb(sql, episode, mdPath)
      : await checkAndRestore(episode, mdPath, checkShrinkageOnly);
    if (!ok) anyFatal = true;
  }

  if (anyFatal) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(R(`\nUnhandled error: ${err?.message ?? err}`));
  process.exit(1);
});
