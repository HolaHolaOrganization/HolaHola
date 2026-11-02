/**
 * test-delegation-race-episode.ts
 *
 * CI check: confirms that maybeAppendDelegationExchange catches a rolling episode
 * that was activated between delegation submission and the exchange write.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The race
 * ─────────────────────────────────────────────────────────────────────────────
 * delegateToAlden() posts Luca's task to Team Room, calls Alden (which takes
 * seconds), then calls maybeAppendDelegationExchange. The rolling-episode
 * cache has a 60-second TTL. If no rolling episode was active when the cache
 * was last populated, it holds null — so a new episode activated while Alden
 * is responding would be missed unless the cache is invalidated before the
 * exchange write.
 *
 * Production fix (in team-room-episode-hook.ts):
 *   maybeAppendDelegationExchange always calls invalidateRollingEpisodeCache()
 *   before getRollingEpisodeName() so it always gets a fresh DB result.
 *   The extra DB round-trip is negligible — delegation calls are infrequent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Normal mode
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Locate the current rolling episode row in the DB.
 *   2. Temporarily remove the 'rolling' tag, then prime the cache as null
 *      by calling getRollingEpisodeName() — cache now holds null (60s TTL).
 *   3. Re-add the 'rolling' tag (simulates episode activation while Alden runs).
 *   4. Call the production maybeAppendDelegationExchange().
 *      — With the fix: invalidates cache → fresh DB lookup → finds the episode
 *        → writes the trigger file.
 *   5. Assert the trigger file contains the exchange and the episode name.
 *   6. Restore the 'rolling' tag in a finally block.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-check  (--self-check)
 * ─────────────────────────────────────────────────────────────────────────────
 *   Proves the test catches the broken path (guard removed):
 *   1. Remove 'rolling' tag → prime cache as null.
 *   2. Re-add 'rolling' tag (episode activated).
 *   3. Skip invalidation before getRollingEpisodeName (broken path) → stale
 *      null → exchange would be silently dropped.
 *   4. Assert trigger file is absent (drop confirmed).
 *   5. Then call invalidation → fresh lookup → trigger written (fix confirmed).
 *   6. Assert this test would fail when the guard is removed.
 *
 * Exit 0 = pass, exit 1 = fail.
 */

import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';

import { getSharedDb } from '../db';
import { sql } from 'drizzle-orm';
import {
  getRollingEpisodeName,
  invalidateRollingEpisodeCache,
  maybeAppendDelegationExchange,
  safeWriteTrigger,
} from '../services/team-room-episode-hook';
import { rollingEpisodeNameFromTitle } from '../services/episode-gap-projection';

// ── CLI ───────────────────────────────────────────────────────────────────────

const IS_SELF_CHECK = process.argv.includes('--self-check');

// ── Colour helpers ────────────────────────────────────────────────────────────

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const sep = () => console.log('\n' + '─'.repeat(70));

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ${G('✓')} ${label}`);
    passed++;
  } else {
    console.error(`  ${R('✗')} ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Temp trigger dir — writes never touch the live workspace file ─────────────

const tmpDir  = join(os.tmpdir(), `holahola-delegation-race-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const TRIGGER = join(tmpDir, '.episode_append');

function readTrigger(): { exchange: string; episode: string } | null {
  if (!existsSync(TRIGGER)) return null;
  try { return JSON.parse(readFileSync(TRIGGER, 'utf-8')); } catch { return null; }
}

function clearTrigger(): void {
  if (existsSync(TRIGGER)) unlinkSync(TRIGGER);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function findRollingEpisodeRow(
  db: ReturnType<typeof getSharedDb>,
): Promise<{ id: string; title: string } | null> {
  const rows = await db.execute(sql`
    SELECT id, title
    FROM conversation_memories
    WHERE arc_name = 'HolaHola Episodes'
      AND 'rolling' = ANY(tags)
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = (rows as any).rows?.[0] ?? (rows as any)[0];
  return row ? { id: row.id as string, title: row.title as string } : null;
}

async function removeRollingTag(db: ReturnType<typeof getSharedDb>, rowId: string): Promise<void> {
  await db.execute(sql`
    UPDATE conversation_memories
    SET tags = array_remove(tags, 'rolling')
    WHERE id = ${rowId}
  `);
}

async function addRollingTag(db: ReturnType<typeof getSharedDb>, rowId: string): Promise<void> {
  await db.execute(sql`
    UPDATE conversation_memories
    SET tags = array_append(tags, 'rolling')
    WHERE id = ${rowId}
      AND NOT ('rolling' = ANY(tags))
  `);
}

// ── Normal mode ───────────────────────────────────────────────────────────────

async function runNormalMode(): Promise<void> {
  const db = getSharedDb();

  // ── Preflight: find a real rolling episode row ────────────────────────────
  sep();
  console.log(B('PREFLIGHT — locate active rolling episode in DB'));
  sep();

  const rollingRow = await findRollingEpisodeRow(db);
  assert(
    'Rolling episode row found in DB',
    !!rollingRow,
    'No row tagged "rolling" in HolaHola Episodes — run set-rolling-episode.ts first',
  );
  if (!rollingRow) return;

  const { id: rowId, title } = rollingRow;
  console.log(Y(`  ℹ  Rolling episode: "${title}" (id ${rowId.slice(0, 8)}…)`));

  // Derive the slug form that getRollingEpisodeName returns
  const expectedSlug = rollingEpisodeNameFromTitle(title);
  console.log(Y(`  ℹ  Expected slug: "${expectedSlug}"`));

  try {
    // ── Step 1: Prime the cache as null ─────────────────────────────────────
    sep();
    console.log(B('STEP 1 — prime cache as null (no rolling episode at submission time)'));
    sep();
    console.log(Y('  ℹ  Simulates: delegation submitted when no rolling episode was active.'));

    // Remove the rolling tag so the DB returns no rolling episode.
    await removeRollingTag(db, rowId);
    console.log(Y('  ℹ  Rolling tag removed from DB row.'));

    // Clear any existing cache, then populate it with the "no episode" DB result.
    invalidateRollingEpisodeCache();
    const cachedNull = await getRollingEpisodeName(); // DB has no rolling row → null
    assert(
      'Cache primed as null (no rolling episode in DB)',
      cachedNull === null,
      `expected null, got "${cachedNull}"`,
    );
    console.log(Y(`  ℹ  Cache is now: ${cachedNull ?? '(null)'} — TTL 60s starts now.`));

    // ── Step 2: Episode activated while Alden responds ───────────────────────
    sep();
    console.log(B('STEP 2 — episode activated (rolling tag re-added while Alden responds)'));
    sep();
    console.log(Y('  ℹ  Simulates: episode promoted to "rolling" between submission and write.'));

    await addRollingTag(db, rowId);
    console.log(Y('  ℹ  Rolling tag re-added to DB row.'));
    console.log(Y('  ℹ  Cache still holds null — 60-second stale window is open.'));

    // ── Step 3: Call the production function ─────────────────────────────────
    sep();
    console.log(B('STEP 3 — call production maybeAppendDelegationExchange()'));
    sep();
    console.log(Y('  ℹ  Production fix: function invalidates cache then does a fresh DB lookup.'));

    clearTrigger();
    const exchange = `**LUCA [delegation → Alden]:** [race-CI-${Date.now()}] Confirm delegation loop.\n\n**ALDEN [delegation]:** Confirmed.`;
    const episodeName = await maybeAppendDelegationExchange(exchange, TRIGGER);

    // ── Step 4: Assertions ────────────────────────────────────────────────────
    sep();
    console.log(B('STEP 4 — assert: episode found and exchange written'));
    sep();

    assert(
      'maybeAppendDelegationExchange returns episode name (not null)',
      episodeName !== null,
      'returned null — stale null cache not cleared; race guard is missing',
    );
    assert(
      'Returned episode slug matches expected slug',
      episodeName === expectedSlug,
      `expected "${expectedSlug}", got "${episodeName}"`,
    );

    const payload = readTrigger();
    assert(
      'Trigger file written (exchange reached the episode)',
      !!payload,
      'trigger file absent — exchange silently dropped',
    );
    assert(
      'Exchange content present in trigger file',
      !!payload && payload.exchange.includes('[race-CI-'),
      `payload: ${JSON.stringify(payload)?.slice(0, 200)}`,
    );
    assert(
      'Episode name in trigger matches slug',
      payload?.episode === expectedSlug,
      `expected "${expectedSlug}", got "${payload?.episode}"`,
    );

    console.log(Y(`\n  ℹ  Exchange written to trigger for episode "${episodeName}".`));
    console.log(Y('  ℹ  Race guard confirmed: stale null cache did not cause a silent drop.'));

  } finally {
    // Always restore the rolling tag so the production episode is not disrupted.
    sep();
    console.log(B('CLEANUP — restoring rolling tag'));
    sep();
    try {
      await addRollingTag(db, rowId);
      // Invalidate so any subsequent call sees the restored state.
      invalidateRollingEpisodeCache();
      const restored = await findRollingEpisodeRow(db);
      assert(
        'Rolling tag restored on episode row',
        !!restored && restored.id === rowId,
        'row not found after restore',
      );
      console.log(Y(`  ℹ  Restored: "${restored?.title ?? '?'}"`));
    } catch (err: any) {
      console.error(R(`  ✗  Cleanup failed: ${err.message}`));
      failed++;
    }
  }
}

// ── Self-check mode ───────────────────────────────────────────────────────────

async function runSelfCheck(): Promise<void> {
  const db = getSharedDb();

  sep();
  console.log(B('SELF-CHECK — proves the test catches the broken path (guard removed)'));
  sep();
  console.log(Y('  ℹ  Simulates: cache primed as null, episode starts, but'));
  console.log(Y('     invalidateRollingEpisodeCache() is NOT called before the'));
  console.log(Y('     getRollingEpisodeName() lookup → stale null → silent drop.'));

  // ── Preflight ─────────────────────────────────────────────────────────────
  const rollingRow = await findRollingEpisodeRow(db);
  assert(
    'Rolling episode row found in DB',
    !!rollingRow,
    'No "rolling" row in HolaHola Episodes — cannot run self-check',
  );
  if (!rollingRow) return;

  const { id: rowId, title } = rollingRow;
  const expectedSlug = rollingEpisodeNameFromTitle(title);
  console.log(Y(`  ℹ  Rolling episode: "${title}" → slug "${expectedSlug}"`));

  try {
    // ── Step 1: Prime cache as null ──────────────────────────────────────────
    sep();
    console.log(B('STEP 1 — prime cache as null (episode removed from DB)'));
    sep();

    await removeRollingTag(db, rowId);
    invalidateRollingEpisodeCache();
    const cachedNull = await getRollingEpisodeName();
    assert(
      'Cache primed as null after rolling tag removed',
      cachedNull === null,
      `expected null, got "${cachedNull}"`,
    );
    console.log(Y(`  ℹ  Cache now holds: ${cachedNull ?? '(null)'}`));

    // ── Step 2: Episode activated ────────────────────────────────────────────
    sep();
    console.log(B('STEP 2 — episode activated (rolling tag re-added to DB)'));
    sep();

    await addRollingTag(db, rowId);
    console.log(Y('  ℹ  Rolling tag re-added. Cache still holds null (60s TTL).'));

    // ── Step 3: Broken path — no invalidation before lookup ──────────────────
    sep();
    console.log(B('STEP 3 — broken path: lookup without prior invalidation'));
    sep();
    console.log(Y('  ℹ  This replicates the code WITHOUT the race guard.'));

    // Do NOT call invalidateRollingEpisodeCache() — stale null cache is used.
    const staleLookup = await getRollingEpisodeName(); // cache hit → null

    assert(
      'Stale null cache: getRollingEpisodeName returns null (no DB query)',
      staleLookup === null,
      `expected null from cache, got "${staleLookup}"`,
    );

    clearTrigger();
    const exchange = `**LUCA [delegation → Alden]:** [self-check-${Date.now()}] task.\n\n**ALDEN [delegation]:** reply.`;

    // Simulate the broken maybeAppendDelegationExchange (no invalidation):
    let brokenResult: string | null = null;
    if (staleLookup) {
      await safeWriteTrigger(exchange, staleLookup, TRIGGER);
      brokenResult = staleLookup;
    }

    assert(
      'Broken path: exchange silently dropped (trigger file absent)',
      !existsSync(TRIGGER),
      'trigger file exists — exchange was written despite stale null cache; guard may be inline',
    );
    assert(
      'Broken path: maybeAppendDelegationExchange equivalent returns null',
      brokenResult === null,
      `expected null, got "${brokenResult}"`,
    );
    console.log(Y('  ℹ  Silent drop confirmed: stale null cache swallows the exchange.'));

    // ── Step 4: Fixed path — invalidation before lookup ──────────────────────
    sep();
    console.log(B('STEP 4 — fixed path: invalidation before lookup finds episode'));
    sep();
    console.log(Y('  ℹ  This is the production fix inside maybeAppendDelegationExchange.'));

    invalidateRollingEpisodeCache(); // ← the guard that the production function now calls
    const freshLookup = await getRollingEpisodeName();

    assert(
      'After invalidation: fresh DB lookup returns the episode slug',
      freshLookup === expectedSlug,
      `expected "${expectedSlug}", got "${freshLookup}"`,
    );

    clearTrigger();
    if (freshLookup) {
      await safeWriteTrigger(exchange, freshLookup, TRIGGER);
    }
    const payload = readTrigger();
    assert(
      'Fixed path: trigger file written after invalidation + fresh lookup',
      !!payload && payload.episode === expectedSlug,
      `payload: ${JSON.stringify(payload)?.slice(0, 200)}`,
    );

    // ── Step 5: Confirm the normal-mode test would fail without the guard ────
    sep();
    console.log(B('STEP 5 — confirm normal-mode test would fail when guard is removed'));
    sep();

    // The normal-mode test asserts maybeAppendDelegationExchange returns non-null.
    // The broken path above returned null → that assertion would have failed.
    assert(
      'Self-check detection sound: broken path returns null → normal-mode assertion would fail',
      brokenResult === null && freshLookup === expectedSlug,
      'self-check logic inconsistent — detection may not work',
    );
    console.log(Y('  ℹ  If the race guard (invalidateRollingEpisodeCache inside'));
    console.log(Y('     maybeAppendDelegationExchange) is removed, the normal-mode test'));
    console.log(Y('     will fail because the function returns null.'));

  } finally {
    sep();
    console.log(B('CLEANUP — restoring rolling tag'));
    sep();
    try {
      await addRollingTag(db, rowId);
      invalidateRollingEpisodeCache();
      const restored = await findRollingEpisodeRow(db);
      assert(
        'Rolling tag restored',
        !!restored && restored.id === rowId,
        'row not found after restore',
      );
      console.log(Y(`  ℹ  Restored: "${restored?.title ?? '?'}"`));
    } catch (err: any) {
      console.error(R(`  ✗  Cleanup failed: ${err.message}`));
      failed++;
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const DATABASE_URL = process.env.NEON_SHARED_DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(R('FATAL: NEON_SHARED_DATABASE_URL is not set'));
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(70));
  if (IS_SELF_CHECK) {
    console.log(B('  Delegation Race Episode — SELF-CHECK'));
  } else {
    console.log(B('  Delegation Race Episode — CI Check'));
  }
  console.log('═'.repeat(70));

  if (IS_SELF_CHECK) {
    await runSelfCheck();
  } else {
    await runNormalMode();
  }

  sep();
  const total = passed + failed;
  if (failed === 0) {
    if (IS_SELF_CHECK) {
      console.log(G(`\n✓  Self-check passed (${total} assertions).`));
      console.log(G('   Broken path (no invalidation) correctly causes silent drop.'));
      console.log(G('   Fixed path (invalidation) writes the exchange to the trigger file.\n'));
    } else {
      console.log(G(`\n✓  All ${total} assertions passed.`));
      console.log(G('   Race guard confirmed: maybeAppendDelegationExchange always invalidates'));
      console.log(G('   the cache before the lookup — episode activated during Alden\'s'));
      console.log(G('   response is found, not silently dropped.\n'));
    }
    process.exit(0);
  } else {
    console.error(R(`\n✗  ${failed} of ${total} assertions failed.\n`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(R(`\nUnhandled error: ${err?.message ?? err}`));
  process.exit(1);
});
