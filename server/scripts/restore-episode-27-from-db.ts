/**
 * restore-episode-27-from-db.ts
 *
 * Restores docs/episode-27.md from the canonical DB record when the file has
 * been overwritten by a stale task-agent commit (shrinkage detection).
 *
 * Usage:
 *   npx tsx server/scripts/restore-episode-27-from-db.ts
 *     → always restores (unconditional)
 *
 *   npx tsx server/scripts/restore-episode-27-from-db.ts --check-shrinkage
 *     → only restores when .md is shorter than DB by > SHRINKAGE_THRESHOLD
 *       characters (normalized). Exits 0 in both cases (restore = success).
 *       Used by scripts/post-merge.sh automatically on every merge.
 *
 * Exit codes:
 *   0  — OK (no shrinkage detected, or restore completed successfully)
 *   1  — Fatal error (DB unavailable, record missing, write failed)
 */

import './lib/held-writer-preflight'; // O2/O3 containment: must stay the first import
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { neon } from '@neondatabase/serverless';
import { writeProjectionAtomically } from '../services/projection-receipts';

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const W = (s: string) => `\x1b[33;1m${s}\x1b[0m`;

const EPISODE_ID = '27000000-0000-4000-8000-000000000027';
const MD_PATH    = join(process.cwd(), 'docs', 'episode-27.md');

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

async function main() {
  const checkShrinkageOnly = process.argv.includes('--check-shrinkage');

  const DATABASE_URL = process.env.NEON_SHARED_DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(R('FATAL: NEON_SHARED_DATABASE_URL is not set'));
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

  // ── Read .md file (if it exists) ────────────────────────────────────────────
  let mdContent = '';
  if (existsSync(MD_PATH)) {
    try {
      mdContent = readFileSync(MD_PATH, 'utf8');
      const mdNorm = normalize(mdContent);
      console.log(Y(`  ℹ  .md file : ${mdContent.length} raw bytes / ${mdNorm.length} normalized chars`));

      if (checkShrinkageOnly) {
        const shrinkage = dbNorm.length - mdNorm.length;

        if (shrinkage <= SHRINKAGE_THRESHOLD) {
          console.log(
            G(`  ✓  No shrinkage detected (db=${dbNorm.length} chars, md=${mdNorm.length} chars, delta=${shrinkage}).`),
          );
          console.log(G('     docs/episode-27.md is at least as large as DB — no restore needed.'));
          process.exit(0);
        }

        // Shrinkage exceeded threshold → overwrite detected
        console.log('');
        console.log(W('  ⚠  SHRINKAGE DETECTED — task-agent overwrite suspected'));
        console.log(W(`     DB has ${dbNorm.length} chars; .md has ${mdNorm.length} chars`));
        console.log(W(`     Delta: -${shrinkage} chars (threshold: ${SHRINKAGE_THRESHOLD})`));
        console.log(W('     Restoring docs/episode-27.md from DB canonical version...'));
        console.log('');
      }
    } catch (err: any) {
      console.error(R(`  ✗  Could not read .md file: ${err?.message ?? err} — will restore unconditionally`));
    }
  } else {
    console.log(Y('  ℹ  .md file does not exist — restoring from DB'));
  }

  // ── Restore ─────────────────────────────────────────────────────────────────
  try {
    writeProjectionAtomically(process.cwd(), MD_PATH, dbContent, {
      kind: 'episode-db-markdown', writer: 'restore-episode-27-from-db',
      source: { type: 'conversation_memory', ids: [EPISODE_ID] },
      reason: checkShrinkageOnly ? 'episode shrinkage restore' : 'episode restore',
      correlation: { episodeId: EPISODE_ID },
    });
    console.log(B(''));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log(B('  RESTORED: docs/episode-27.md written from DB canonical record'));
    console.log(B(`  DB id   : ${EPISODE_ID}`));
    console.log(B(`  Size    : ${dbContent.length} bytes`));
    console.log(B('  ══════════════════════════════════════════════════════════════════'));
    console.log('');
    process.exit(0);
  } catch (err: any) {
    console.error(R(`FATAL: Could not write ${MD_PATH}: ${err?.message ?? err}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(R(`\nUnhandled error: ${err?.message ?? err}`));
  process.exit(1);
});
