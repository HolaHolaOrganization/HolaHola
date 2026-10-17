/**
 * restore-episode-28-from-db.ts
 *
 * Restores docs/episode-28.md from the canonical DB record when the file has
 * been overwritten by a stale task-agent commit (shrinkage detection).
 *
 * Usage:
 *   npx tsx server/scripts/restore-episode-28-from-db.ts
 *     → always restores (unconditional)
 *
 *   npx tsx server/scripts/restore-episode-28-from-db.ts --check-shrinkage
 *     → only restores when .md is shorter than DB by > SHRINKAGE_THRESHOLD
 *       characters (normalized). Exits 0 in both cases (restore = success).
 *       Used by scripts/post-merge.sh automatically on every merge.
 *
 *   npx tsx server/scripts/restore-episode-28-from-db.ts --self-check
 *     → CI self-check: temporarily truncates the .md to simulate a task-agent
 *       overwrite, confirms the shrinkage guard detects and restores it, then
 *       verifies the restored file matches the DB.  The original .md bytes are
 *       ALWAYS written back at the end regardless of pass or fail — the
 *       self-check is a non-destructive probe.
 *       Exit 0  — guard fired and restored correctly.
 *       Exit 1  — guard failed to detect or restore (CI failure).
 *
 * Exit codes:
 *   0  — OK (no shrinkage detected, restore completed successfully, or
 *            self-check passed)
 *   1  — Fatal error (DB unavailable, record missing, write failed, or
 *            self-check: guard did not fire / restore was wrong)
 */

import './lib/held-writer-preflight'; // O2/O3 containment: must stay the first import
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { neon } from '@neondatabase/serverless';
import {
  removeIsolatedProjectionFixture,
  writeIsolatedProjectionFixture,
  writeProjectionAtomically,
} from '../services/projection-receipts';

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const W = (s: string) => `\x1b[33;1m${s}\x1b[0m`;

const EPISODE_ID   = '28000000-0000-4000-8000-000000000028';
const SNAPSHOT_ID  = '28000000-0001-4000-8000-000000000028'; // sealed; NEVER write to this ID
const MD_PATH      = join(process.cwd(), 'docs', 'episode-28.md');

/**
 * Minimum number of normalized characters by which the .md must be shorter
 * than the DB before we treat it as a stale overwrite. Tiny diffs (e.g. a
 * trailing newline) are ignored; real overwrites lose thousands of bytes.
 */
const SHRINKAGE_THRESHOLD = 200;

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
 * Shared shrinkage detection used by both --check-shrinkage and --self-check.
 * Returns { detected, shrinkage } — does NOT perform the restore.
 */
function detectShrinkage(
  dbNorm: string,
  mdNorm: string,
): { detected: boolean; shrinkage: number } {
  const shrinkage = dbNorm.length - mdNorm.length;
  return { detected: shrinkage > SHRINKAGE_THRESHOLD, shrinkage };
}

/**
 * Core restore logic: write dbContent to MD_PATH.
 * Returns true on success, false on failure.
 */
function restoreFromDb(dbContent: string): boolean {
  try {
    writeProjectionAtomically(process.cwd(), MD_PATH, dbContent, {
      kind: 'episode-db-markdown',
      writer: 'restore-episode-28-from-db',
      source: { type: 'conversation_memory', ids: [EPISODE_ID] },
      reason: 'episode-28 canonical DB restore',
      correlation: { episodeId: EPISODE_ID },
    });
    console.log(B(''));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log(B('  RESTORED: docs/episode-28.md written from DB canonical record'));
    console.log(B(`  DB id   : ${EPISODE_ID}`));
    console.log(B(`  Size    : ${dbContent.length} bytes`));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log('');
    return true;
  } catch (err: any) {
    console.error(R(`FATAL: Could not write ${MD_PATH}: ${err?.message ?? err}`));
    return false;
  }
}

/**
 * --self-check mode.
 *
 * Non-destructive: the original .md bytes are always written back at the
 * end, whether the check passes or fails.  The file must never be left in
 * a truncated or DB-only state after this function returns.
 *
 * Steps:
 *   1. Save the current .md content (the "original").
 *   2. Write a truncated version to simulate a stale task-agent overwrite.
 *   3. Run detectShrinkage() — the same function the startup guard uses.
 *   4. Confirm shrinkage is detected (exits 1 if not).
 *   5. Call restoreFromDb() — the same function the startup guard uses.
 *   6. Verify the written file matches the DB in normalized length.
 *   7. Always write the original bytes back before exiting.
 */
async function selfCheck(dbContent: string, dbNorm: string): Promise<void> {
  console.log(B(''));
  console.log(B('  ── SELF-CHECK MODE ────────────────────────────────────────────────'));
  console.log(B('  Simulating a stale task-agent overwrite to confirm the guard fires'));
  console.log(B('  Original .md will be restored unconditionally after the probe.'));
  console.log('');

  // ── 1. Save original .md ──────────────────────────────────────────────────
  let originalContent: string | null = null;
  if (existsSync(MD_PATH)) {
    try {
      originalContent = readFileSync(MD_PATH, 'utf8');
      console.log(Y(`  ℹ  Saved original .md (${originalContent.length} bytes) — will restore unconditionally`));
    } catch (err: any) {
      console.error(R(`  ✗  Could not read .md for backup: ${err?.message ?? err}`));
      process.exit(1);
    }
  } else {
    console.log(Y('  ℹ  .md does not exist — will create truncated version for test'));
  }

  /**
   * Restore the original file state unconditionally:
   *   - If the file existed before the probe: write back the original bytes.
   *   - If the file did not exist before the probe: delete it (leave no temp artifact).
   * Returns true on success, false on failure (caller should exit 1 on false).
   */
  function restoreOriginal(label: string): boolean {
    if (originalContent !== null) {
      try {
        writeIsolatedProjectionFixture(process.cwd(), MD_PATH, originalContent);
        console.log(G(`  ↩  Original .md restored (${originalContent.length} bytes) [${label}]`));
        return true;
      } catch (e: any) {
        console.error(R(`  ✗  FATAL: could not restore original .md: ${e?.message ?? e}`));
        return false;
      }
    } else {
      // File did not exist before — remove any temp artifact written during the probe.
      if (existsSync(MD_PATH)) {
        try {
          removeIsolatedProjectionFixture(process.cwd(), MD_PATH);
          console.log(G(`  ↩  Temp .md removed (file did not exist before probe) [${label}]`));
        } catch (e: any) {
          console.error(R(`  ✗  FATAL: could not remove temp .md: ${e?.message ?? e}`));
          return false;
        }
      }
      return true;
    }
  }

  let passed = false;

  try {
    // ── 2. Write a truncated version (well below threshold) ────────────────
    //    Cut to ~50% of DB content length — guaranteed >> SHRINKAGE_THRESHOLD.
    const truncateAt = Math.max(0, Math.floor(dbContent.length / 2));
    const truncated  = dbContent.slice(0, truncateAt);
    const truncatedNorm = normalize(truncated);

    console.log(Y(`  ℹ  Writing truncated .md (${truncated.length} bytes / ${truncatedNorm.length} normalized chars)`));
    writeIsolatedProjectionFixture(process.cwd(), MD_PATH, truncated);

    // ── 3. Run detectShrinkage — same function as the startup guard ────────
    const { detected, shrinkage } = detectShrinkage(dbNorm, truncatedNorm);
    console.log(Y(`  ℹ  Shrinkage delta: ${shrinkage} chars (threshold: ${SHRINKAGE_THRESHOLD})`));

    if (!detected) {
      console.error(R(''));
      console.error(R('  ✗  SELF-CHECK FAILED: detectShrinkage() returned false'));
      console.error(R(`     Expected delta > ${SHRINKAGE_THRESHOLD}, got ${shrinkage}`));
      console.error(R('     The truncated file was not short enough — investigate SHRINKAGE_THRESHOLD'));
      return; // falls through to finally
    }

    console.log(G(`  ✓  Shrinkage detected (delta=${shrinkage} > threshold=${SHRINKAGE_THRESHOLD}) — guard fires`));
    console.log('');

    // ── 4. Fire restoreFromDb — same function as the startup guard ─────────
    const ok = restoreFromDb(dbContent);
    if (!ok) {
      return; // restoreFromDb already logged; falls through to finally
    }

    // ── 5. Verify the written file matches DB in normalized length ──────────
    let writtenContent: string;
    try {
      writtenContent = readFileSync(MD_PATH, 'utf8');
    } catch (err: any) {
      console.error(R(`  ✗  SELF-CHECK FAILED: could not read restored file: ${err?.message ?? err}`));
      return;
    }

    const writtenNorm = normalize(writtenContent);
    if (writtenNorm !== dbNorm) {
      console.error(R('  ✗  SELF-CHECK FAILED: restored file content does not match DB'));
      console.error(R(`     DB normalized: ${dbNorm.length} chars`));
      console.error(R(`     Written normalized: ${writtenNorm.length} chars`));
      return;
    }

    console.log(G('  ✓  Restored file content matches DB exactly (full equality)'));
    passed = true;

  } catch (err: any) {
    console.error(R(`  ✗  SELF-CHECK FAILED: unexpected error: ${err?.message ?? err}`));
  } finally {
    // ── Always restore original state; fail the check if this itself fails ──
    const cleanupOk = restoreOriginal(passed ? 'pass' : 'fail');
    if (!cleanupOk) {
      // Restoration failed — the file is in an unknown state; always exit 1.
      passed = false;
    }
  }

  if (passed) {
    console.log('');
    console.log(G('  ══════════════════════════════════════════════════════════════════'));
    console.log(G('  SELF-CHECK PASSED'));
    console.log(G('  The startup shrinkage guard correctly detected the simulated'));
    console.log(G('  overwrite and restored docs/episode-28.md from the DB record.'));
    console.log(G('  Original .md bytes were fully preserved.'));
    console.log(G('  ══════════════════════════════════════════════════════════════════'));
    console.log('');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

async function main() {
  const checkShrinkageOnly = process.argv.includes('--check-shrinkage');
  const isSelfCheck        = process.argv.includes('--self-check');

  const DATABASE_URL = process.env.NEON_SHARED_DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(R('FATAL: NEON_SHARED_DATABASE_URL is not set'));
    process.exit(1);
  }

  // ── Snapshot write-guard ────────────────────────────────────────────────────
  // SNAPSHOT_ID is the sealed point-in-time snapshot — it must NEVER be
  // targeted by a restore or sync operation.  This check runs before any
  // DB I/O so a future edit that accidentally swaps the IDs fails loudly.
  if ((EPISODE_ID as string) === (SNAPSHOT_ID as string)) {
    console.error(R(''));
    console.error(R('  ══════════════════════════════════════════════════════════════════'));
    console.error(R('  BLOCKED: EPISODE_ID matches the sealed snapshot ID.'));
    console.error(R(`  Snapshot ID : ${SNAPSHOT_ID}`));
    console.error(R('  The snapshot is read-only and must never be overwritten by this'));
    console.error(R('  script.  Restore the live episode ID and try again.'));
    console.error(R('  ══════════════════════════════════════════════════════════════════'));
    console.error(R(''));
    process.exit(1);
  }

  // ── Read DB record ──────────────────────────────────────────────────────────
  const sql = neon(DATABASE_URL);
  const rows = await sql`
    SELECT id, content, length(content) AS len
    FROM conversation_memories
    WHERE id = ${EPISODE_ID}
  `;

  if (rows.length !== 1) {
    console.error(R(`FATAL: DB record ${EPISODE_ID} not found (rows: ${rows.length})`));
    process.exit(1);
  }

  const dbContent: string = rows[0].content ?? '';
  if (!dbContent) {
    console.error(R('FATAL: DB content field is empty — cannot restore'));
    process.exit(1);
  }

  const dbNorm = normalize(dbContent);
  console.log(Y(`  ℹ  DB record: ${dbContent.length} raw bytes / ${dbNorm.length} normalized chars`));

  // ── Self-check mode ─────────────────────────────────────────────────────────
  if (isSelfCheck) {
    await selfCheck(dbContent, dbNorm);
    return; // selfCheck calls process.exit()
  }

  // ── Read .md file (if it exists) ────────────────────────────────────────────
  let mdContent = '';
  if (existsSync(MD_PATH)) {
    try {
      mdContent = readFileSync(MD_PATH, 'utf8');
      const mdNorm = normalize(mdContent);
      console.log(Y(`  ℹ  .md file : ${mdContent.length} raw bytes / ${mdNorm.length} normalized chars`));

      if (checkShrinkageOnly) {
        const { detected, shrinkage } = detectShrinkage(dbNorm, mdNorm);

        if (!detected) {
          console.log(
            G(`  ✓  No shrinkage detected (db=${dbNorm.length} chars, md=${mdNorm.length} chars, delta=${shrinkage}).`),
          );
          console.log(G('     docs/episode-28.md is at least as large as DB — no restore needed.'));
          process.exit(0);
        }

        // Shrinkage exceeded threshold → overwrite detected
        console.log('');
        console.log(W('  ⚠  SHRINKAGE DETECTED — task-agent overwrite suspected'));
        console.log(W(`     DB has ${dbNorm.length} chars; .md has ${mdNorm.length} chars`));
        console.log(W(`     Delta: -${shrinkage} chars (threshold: ${SHRINKAGE_THRESHOLD})`));
        console.log(W('     Restoring docs/episode-28.md from DB canonical version...'));
        console.log('');
      }
    } catch (err: any) {
      console.error(R(`  ✗  Could not read .md file: ${err?.message ?? err} — will restore unconditionally`));
    }
  } else {
    console.log(Y('  ℹ  .md file does not exist — restoring from DB'));
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  if (!restoreFromDb(dbContent)) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(R(`\nUnhandled error: ${err?.message ?? err}`));
  process.exit(1);
});
