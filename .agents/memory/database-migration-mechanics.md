---
name: Database migration mechanics — tracking, gate runtime, and reconciliation
description: Where drizzle-kit migrate tracks state and how to stamp a baseline, how to run the full Neon migration gate without losing its result, and how to reconcile divergent migration sequences already applied to the shared DB.
---

## 1. Drizzle migration tracking table location

**Table:** `drizzle.__drizzle_migrations` — lives in the `drizzle` schema, NOT `public`.

**Columns:** `id SERIAL PRIMARY KEY`, `hash TEXT NOT NULL`, `created_at BIGINT`

**Skip logic:** the migrator fetches the row with the highest `created_at` and skips any migration whose `folderMillis <= lastDbMigration.created_at`. It does NOT compare hashes to decide whether to skip — the timestamp is the gate.

**Stamping a baseline (one-time, when switching from db:push to migrate):**
```js
await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)`);
const hash = createHash('sha256').update(fs.readFileSync('migrations/0000_baseline.sql', 'utf8')).digest('hex');
const folderMillis = <value from migrations/meta/_journal.json entries[0].when>;
await client.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [hash, folderMillis]);
```

**Why folderMillis matters:** the `when` field in `_journal.json` is what Drizzle uses as `created_at`. The stamp must use the exact same value or the comparison fails.

**Connection:** `drizzle.config.ts` uses `DATABASE_URL`. App code uses `NEON_SHARED_DATABASE_URL`. Both point to the same Neon DB. Cannot edit `drizzle.config.ts` per project rules.

## 2. Running the full migration gate

The full disposable-Neon-branch migration gate can take substantially longer than the five-minute foreground shell limit.

**Why:** a foreground run was killed by the shell timeout after its focused checks passed but before the full CI groups and branch cleanup completed. The interrupted run left its disposable branch behind and could not authorize promotion.

**How to apply:** start `npm run db:branch -- gate` in the background, monitor for `READY_TO_PROMOTE` or `[gate] FAILED`, and confirm the disposable branch was deleted. If a process is interrupted, list Neon branches and delete only the exact orphaned test branch before retrying.

**Monitor pattern precision:** the gate's own `npm run test:ci` matrix includes resilience tests that deliberately simulate and log a failure (e.g. a compartment fetch logging `Failed to fetch ... : Error: DB connection lost` before asserting graceful handling) — a broad `Error:` watch pattern false-fires on this expected, passing test output long before the gate actually finishes. Anchor the pattern to the gate's own literal terminal lines instead: `\[gate\] READY_TO_PROMOTE|\[gate\] FAILED:`.

## 3. Reconciling divergent migration sequences already applied

When divergent branches contain colliding migration sequence numbers and the shared database has already applied both branches, preserve every applied SQL file byte-for-byte. Linearize only filenames, journal positions, and snapshot ancestry, then rebuild each snapshot so it includes all earlier changes from both branches.

**Why:** the migration ledger records content hashes and timestamps. Replacing or combining already-applied SQL can leave live ledger entries with no matching source artifact, while choosing one branch's snapshot chain silently omits the other branch's schema.

**How to apply:** query the live migration ledger first, match each recorded hash to an exact SQL file, inspect the live schema, assign a collision-free chronological sequence, and rebuild the snapshot chain cumulatively. Prove the result on a disposable production clone before merging.

## 4. migrate applies every pending migration in one batch, not just your target

`drizzle-kit migrate` has no notion of "apply just this one migration." Per
the skip logic in #1, it applies every migration folder whose `when`
timestamp is newer than the last row in `drizzle.__drizzle_migrations`, all
in the same run. If other migrations were generated and committed earlier
but never actually applied, running migrate for an unrelated schema change
sweeps those in too, silently.

**Why:** direct consequence of the timestamp-gate skip logic (#1) — there is
no per-migration selection, only "everything newer than the last applied
timestamp."

**How to apply:** before running `drizzle-kit migrate` for a specific
change, check `migrations/meta/_journal.json` against
`drizzle.__drizzle_migrations` for any other already-generated-but-unapplied
migrations. Treat those as in scope for this run and review them like your
own change, since they will be applied together whether you meant to or
not. Confirmed case: an unrelated schema task's migrate run incidentally
applied a long-pending migration that had been silently failing a
fail-closed startup schema assertion in production for weeks — a lucky
outcome, but the reverse (an unreviewed unrelated migration introducing a
new problem) is exactly as possible.


## Task integration is not migration authorization

Automatic task merges must not apply shared-database migrations. Treat task integration and schema application as separate authorization boundaries.

**Why:** David explicitly approved removing migration execution from automatic post-merge setup: an apparently unrelated task merge can otherwise apply every staged migration, including changes not authorized for production.

**How to apply:** Keep automatic setup migration-free, with no environment-variable bypass. Apply reviewed migration artifacts only under separate explicit authorization and the existing disposable-database gate. Do not restore automatic migration execution just to unblock a dependency or test task.

