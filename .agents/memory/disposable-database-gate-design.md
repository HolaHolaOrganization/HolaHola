## Disposable database test boundary

---
name: Disposable database test boundary
description: Safety rule for regression tests whose production paths write database records.
---

Any regression test that can write database state must fail closed unless the process has positively verified a disposable, job-local database. Local and Replit runs without that proof may keep static and in-memory coverage, but must not reach the persistence path. Full persistence coverage belongs in CI with an isolated database.

**Why:** Best-effort cleanup did not protect shared Neon. Interrupted or failed tests left synthetic coordination projections and hundreds of identical scratchpad memories behind. A cleanup hook is recovery logic, not an isolation boundary. A green gate can also hide a broken required-variable contract when an alternate database selector happens to supply the target, while swallowed teardown errors can conceal forbidden mutation attempts against immutable evidence.

**How to apply:** Before adding or extending a DB-writing test, use the project's verified CI database contract. Guard the whole mutating setup/test/teardown path, preserve full coverage in isolated CI, and add a check that detects removal of the guard. Independently prove each suite fails when database coverage is required but its exact verified target variables are absent. On disposable branches, retain immutable records until branch destruction rather than issuing best-effort deletes.

**Gate-only test pitfall (own var vs. ambient var):** several `scripts/neon-branch.ts`-gated `*-postgres.test.ts` files write their existence check as `const url = process.env.NEON_SHARED_DATABASE_URL` instead of their own dedicated `<PREFIX>_TEST_DATABASE_URL`. Since `NEON_SHARED_DATABASE_URL` is the app's own database and is already set in a normal dev shell, that ambient-first check makes the file throw a confusing "`<PREFIX>_TEST_DATABASE_DISPOSABLE=1` is required" error the moment anyone runs it directly outside the gate, instead of skipping cleanly. Confirmed live (Sep 2026) in `test-coordination-task-artifact-registry-postgres.test.ts`, `test-coordinator-v2-host-reauthorization-postgres.test.ts`, `test-coordination-v2-runtime-bootstrap-postgres.test.ts`, and `test-coordinator-v2-schema-postgres.test.ts`; already fixed in `test-founder-task-ownership-postgres.test.ts` and correctly avoided in `test-coordination-session-service.test.ts` (own var first) and `test-coordination-windows-generation.test.ts` (returns `undefined` immediately whenever `<PREFIX>_REQUIRE_DATABASE_TESTS` isn't `'1'`, regardless of the ambient var). Gate on the file's own var first, or add that early return, so "run outside the gate" reliably means "skip", not "throw."

## Fixed-ID collision under concurrent CI batches

**Fixed-ID collision under concurrent CI batches:** `test-founder-mode-absence-guard.ts` seeds/reads/cleans up a nudge row keyed by a *fixed, deterministic* test-user id (not randomized per run) against the shared dev database. Running two `npm run test:ci:guards` invocations concurrently (e.g. while isolating an unrelated flake, spot-checking a fix in one process while a full gate runs in another) made both instances race on that same row — one process's cleanup/read raced the other's write, producing "row not found" / null-return failures with no code regression involved. A clean solo run passed every time. Confirmed Sep 22 2026 while verifying Task 1519's fix; distinct from that task's root cause (in-place file mutation) — this is a shared-row collision from a non-unique fixture id, same underlying lesson (shared-state tests need per-run isolation) via a different mechanism. Treat any CI self-check with a hardcoded fixture id as unsafe to run in parallel with itself against the shared DB.

## Disposable-gate own-var-first

---
name: Disposable-DB test gates must check their own var first
description: Why a disposableTarget()-style gate must read its own dedicated *_TEST_DATABASE_URL before the ambient NEON_SHARED_DATABASE_URL, and the two safe shapes for the check.
---

Many `*.test.ts` files in this repo use a `disposableTarget()`-style helper so a
Postgres-writing test only runs against a Neon branch that `scripts/neon-branch.ts`'s
migration gate provisioned and marked disposable, never against the app's own
database. `NEON_SHARED_DATABASE_URL` is the ambient var holding the app's own
database connection — it is truthy in essentially every normal dev shell, well
outside any gate.

**The bug shape:** `disposableTarget()` reads `NEON_SHARED_DATABASE_URL` first and
branches on its presence/absence (`if (!url) { ...maybe throw...; return undefined }`).
Because that var is *always* set in a normal dev shell, the function always falls
through past the "am I even inside a gate" check and into the disposable/forbidden
verification branch — which then throws a confusing `"..._DISPOSABLE=1 is required"`
or similar error instead of skipping cleanly, any time someone runs the file
directly (`npx tsx --test <file>`) outside the gate.

**The fix — two safe shapes, both seen in this repo:**
1. **Own-var-first:** read the file's own dedicated gate var (e.g.
   `COORDINATOR_V2_TEST_DATABASE_URL`, `FOUNDER_TASK_OWNERSHIP_TEST_DATABASE_URL`)
   as the primary `url`/presence check, and throw-if-required only in that branch.
   Cross-check `NEON_SHARED_DATABASE_URL === url` as a *secondary* condition further
   down, not as the entry gate.
2. **Early-return:** immediately `return undefined` (no throw) whenever the file's
   `*_REQUIRE_DATABASE_TESTS` flag isn't `'1'`/`"1"`, before any other check runs —
   safe even if `NEON_SHARED_DATABASE_URL` is read first, because presence of that
   ambient var alone can never trigger the throwing branch.

**Why:** this exact bug was found and fixed independently at least seven times
across this repo's Coordinator V2 / founder-task-ownership / release-cutover-
attestation test families — it is the default mistake, not an edge case, whenever
someone writes a new disposable-DB gate by copying an existing `NEON_SHARED_DATABASE_URL`-first
example instead of an own-var-first or early-return one.

**How to apply:** when adding or reviewing any `disposableTarget()`-style gate,
grep the function for which var is checked in the first `if`. If it's the ambient
`NEON_SHARED_DATABASE_URL`/`CI_DATABASE_URL`-style var and the branch can throw,
run the file directly with that var set (simulating a normal dev/CI shell) and
every gate-specific var unset — a clean skip is required, a thrown error is the bug.
Also add a self-check test in the same file that reads its own source
(`readFileSync(fileURLToPath(import.meta.url), ...)`) and asserts the fail-closed
`_REQUIRE_DATABASE_TESTS === '1'` branch and `_FORBIDDEN_SHARED_URL` check are both
still present, so a future edit can't silently regress the guard.


## Focused runs do not reproduce accumulated suite state

A freshly cloned, focused database test does not reproduce all the state accumulated by a long migration gate. Global housekeeping totals are database-wide results, not counts of the current test's fixtures.

**Why:** Earlier suites can leave nonterminal fixtures that become eligible for a later global sweep. A fresh focused run passed unchanged, while adding one eligible unrelated fixture reproduced the full gate's count-assumption failure. At least three extra rows were traced to earlier suites by their generated ID prefixes and timestamps; the remaining row's origin was not proven. Source: conversation_memories `7b1d6e38-73f4-4748-8a53-ffdd8d117a30`.

**How to apply:** Compare stable generated-ID prefixes and embedded timestamps with the gate start and producer tests; an absent literal UUID in source proves nothing about provenance. Reproduce accumulated state deliberately in a disposable database. Assert exact owned-session outcomes and protection of live fixtures rather than deleting unrelated rows or treating a global sweep total as a fixture count.

## Verified URL versus actual singleton connection

Verifying a disposable database URL is not proof that a module-level application singleton uses it. Bind the target before importing any module that captures connection configuration, and verify the actual connection before fixture writes.

**Why:** A test validated its dedicated target but seeded reviewers through an application singleton that had already captured the ambient shared connection. Cleanup cannot compensate for that mismatch.

**How to apply:** For tests exercising production singletons, prove isolation with a permitted disposable database and a separate ambient trap. Require real fixture and dispatch success in the permitted database, no writes in the trap, and unchanged databases for rejected target contracts. Keep required dedicated-variable checks independent of alternate CI selectors.


## Testing environment is required for every Luca hat

**Rule:** "A proper testing environment is a requirement for every Luca hat." This applies across runtimes, not just the current Windows/Linux gate work.

**Why:** The founder explicitly set this project-wide requirement after the migration-gate portability problems and asked for a plan covering it.

**How to apply:** Include safe, reliable test access when planning support for existing or new Luca hats. Do not assume fixing one hat's Linux gate satisfies the requirement for the others. Shared versus local execution, rollout and credential custody still need an agreed design; this requirement alone does not authorize infrastructure or permission changes.


## Public diagnostics are a separate privacy boundary

Production-copy test execution and public test reporting have separate privacy boundaries. A diagnostic prefix, a failing-test name, or a successful clean-log sample does not establish that future subprocess output is safe to publish.

**Why:** The repository's CI output is public, while a disposable production-copy database can still contain private learner and conversation data. A reviewed prefix filter passed its original private-row test yet relayed synthetic private content carried after allowed status and test-name prefixes.

**How to apply:** Keep raw production-copy diagnostics with an authorized private holder. Public reports should use fixed outer-wrapper status messages and strictly validated, re-rendered numeric summaries, not arbitrary subprocess lines, test names, error reasons or command text. Test accepted-prefix-shaped private content on both success and failure paths.

