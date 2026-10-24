---
name: PostgreSQL hermetic testing gotchas
description: Five recurring pitfalls writing real-database tests against disposable PostgreSQL — POSIX regex vs JS escapes, immutable expiry, wrapped driver errors, lease clocks, CLI termination, and composite-FK negative fixtures.
---

## PostgreSQL lease clocks


Use an advancing PostgreSQL wall clock for lease issue, renewal, expiry, and
takeover decisions. Do not use a transaction-start timestamp for elapsed-time
authority.

**Why:** PostgreSQL transaction timestamps are fixed at transaction start.
Concurrent setup or test operations can therefore make “now” older than a
recently persisted lease boundary, producing contradictory expiry behavior
even though every value came from the database.

**How to apply:** Any database-authoritative timeout or lease transition that
depends on elapsed time should obtain the advancing clock inside the locked
transaction and derive expiry from that same value.

## PostgreSQL control checks and immutable expiry tests


Use PostgreSQL POSIX `[[:cntrl:]]` checks for bounded text fields. Do not
translate JavaScript-style hexadecimal control ranges into doubly escaped SQL
regex character classes.

**Why:** A doubled-backslash `\x00-\x1f` pattern was interpreted as ordinary
character-class content and rejected valid request keys containing normal
letters. The schema looked strict but enforced the wrong alphabet.

**How to apply:** Keep the Drizzle schema, generated migration, and snapshot on
the same POSIX expression, and prove representative valid values on a disposable
PostgreSQL branch.

When an authority row makes its expiry immutable, test expiry by creating a
short-lived authoritative parent or session whose database-clock bound naturally
caps the child. Never rewrite the child expiry to make a test convenient.

**Why:** Directly shortening the reservation expiry contradicted the
immutability trigger and tested a state production can never create.

**How to apply:** Create the short-lived parent immediately before the scenario,
wait past its database-clock bound, then exercise the normal recovery path.

## PostgreSQL wrapped structured errors


PostgreSQL conflict handling must inspect structured errors through a bounded
`cause` chain. SQLSTATE and constraint identity may be present on an inner
driver error rather than the outer exception.

**Why:** Database and ORM layers can wrap PostgreSQL errors. Checking only the
outer object can miss a real `23505`, while treating every wrapped error as a
conflict can hide unrelated failures and weaken authority guarantees.

**How to apply:** Walk only a small fixed number of structured `cause` links,
accept the expected SQLSTATE only with an exact allowlisted constraint name,
and rethrow everything else. Do not classify by message text or broad substring
matching.

## Database CLI termination


One-shot database administration commands must flush their final output and
terminate explicitly after success or failure when they import application
database infrastructure.

**Why:** A successful command can leave a shared connection pool holding the
Node.js event loop open. Gates then appear stalled even though the operation
and verification completed.

**How to apply:** For CLI entry points that reuse long-lived application
database modules, write the final result through a completion callback and
exit with the intended status; preserve import-safe behavior for library use.

## Composite-FK negative fixtures


For each intended composite foreign-key mismatch, create a fresh valid parent
lineage and fresh uniqueness dimensions, then alter exactly one child lineage
field. Do not reuse a host/request or host/release pair already consumed by a
successful child row.

**Why:** PostgreSQL may enforce a unique index before the composite foreign key.
A test expecting `23503` can instead receive a correct `23505`, which proves
only that the fixture collided with an earlier row.

**How to apply:** In negative database tests for lineage-bound evidence, keep
host fingerprints, requests, releases, manifests, and successful child pairs
distinct across cases. Assert the exact SQLSTATE only after those preempting
constraints are isolated.

## getSharedDb() silently targets Neon's WebSocket endpoint without CI_DATABASE_URL

## getSharedDb() silently targets Neon's WebSocket endpoint without CI_DATABASE_URL

Setting only `NEON_SHARED_DATABASE_URL` to point at a disposable local
Postgres is not enough for a script that calls `getSharedDb()`
(`server/db.ts`) — it still picks the Neon serverless WebSocket driver unless
`CI=true` and `CI_DATABASE_URL` are also set to that same loopback URL (see
`server/ci-database.ts`'s `getVerifiedCiDatabaseUrl`).

**Why:** The failure doesn't look like a missing-env-var error. It surfaces
as a WebSocket `ErrorEvent` wrapping `connect ECONNREFUSED 127.0.0.1:443` —
`getSharedDb()` silently fell back to `NEON_SHARED_DATABASE_URL` alone and
tried to speak Neon's WSS protocol to a plain local Postgres, rather than
reporting that the CI override didn't apply.

**How to apply:** Any one-off script under `server/scripts/` that imports
`getSharedDb()` and needs to run against a disposable local Postgres must
set all three of `CI=true`, `CI_DATABASE_URL`, and `NEON_SHARED_DATABASE_URL`
(the latter two identical, loopback host) in the same invocation — not just
`NEON_SHARED_DATABASE_URL`.


## Connection-string query overrides defeat apparent isolation

PostgreSQL connection-string query arguments can override the URL hostname and database path. Validating only the URL's apparent authority/path is not proof of the driver's actual target.

**Why:** node-postgres' connection-string parser gives query arguments precedence; a loopback-looking URL or private-looking database path can still resolve to a different host or database.

**How to apply:** fail closed on target-changing URL parameters before opening even an administrative connection in a disposable-database harness. Verify both the driver's effective target and invocation ownership, not just that CI is enabled.

## Canonical evidence adapter fidelity

Canonical evidence diagnostics must reproduce the production database adapter's
runtime value types, not just query the same rows with an interchangeable SQL
client.

**Why:** During the October 6, 2026 bootstrap diagnosis, a plain PostgreSQL
client returned Date objects and made the old timestamp conversion appear to
match stored evidence. The application's adapter returned timestamp strings
and exposed the replay mismatch. Identical rows did not imply identical
canonical bytes.

**How to apply:** Check the actual adapter's value types before concluding a
digest mismatch is resolved. Keep stored evidence unchanged and compare full
canonical digests, rather than accepting approximate timestamp equivalence.


## Authorization expiry after row-lock waits

Use a genuinely fresh database clock when checking authorization expiry after a lock wait: PostgreSQL now() and CURRENT_TIMESTAMP are fixed at transaction start, even if selected after the lock is acquired. clock_timestamp() reports current wall-clock time.

**Why:** A real disposable PostgreSQL race test began authorization before grant expiry, blocked on a row lock until after expiry, then showed that now() still accepted the expired grant while clock_timestamp() correctly rejected it. Moving the SELECT below the lock did not make the clock fresh.

**How to apply:** For time-sensitive authorization after waiting, read the fresh clock inside the authoritative lock boundary. Test by beginning before expiry and releasing the conflicting row lock after expiry; injecting a preselected later time does not prove actual PostgreSQL behavior.


## Shared-identity ownership and empty historical lookups

Permanent identity ownership must be serialized by the shared identity being assigned, not only by each request or grant row. SELECT ... FOR UPDATE locks matching rows; an empty historical-ownership lookup does not reserve an unused identity.

**Why:** A real disposable PostgreSQL interleaving let two actors lock distinct pending grants for one identity and both observe no approved history. The first actor approved and revoked before the second performed its update. Live-only unique indexes then allowed the second approval, despite the permanent-binding rule and potentially overlapping residual tokens.

**How to apply:** Establish immutable identity-owner rows/constraints, or acquire stable, consistently ordered identity-level transaction locks before the fresh ownership lookup. Test the approve/revoke/approve interleaving, not only sequential reuse. A cancelled proposal that was never approved must not become historical ownership merely because its terminal state is revoked.


## Database clock agreement is not commit visibility

A common database clock does not establish commit/visibility order. PostgreSQL now()/CURRENT_TIMESTAMP is fixed at transaction start; an advancing wall clock can also stamp data before it commits. Comparing those timestamps is not by itself proof that a concurrent reader has seen every relevant state transition.

**Why:** A receipt design acknowledged by a model as race-free could assign an actor acknowledgment time10, start another session at20, and expose the actor receipt only at commit30. Its after-session-start predicate then hid an unserved row from that concurrent session. Official PostgreSQL clock docs and an executable abstract predicate check support the counterexample; no candidate implementation or actual DB race was run. Source: conversation_memories 1e59e91c-56fa-429f-ac10-cf8cffec1cde.

**How to apply:** For cross-transaction delivery/visibility guarantees, establish a real serialization or visibility handoff (or explicitly conservative recovery), not merely one clock source or a different time function. Once implementation is authorized, test the real interleaving on a disposable database. Clock-skew, elapsed-time freshness and commit visibility are distinct questions.


## Timezone-sensitive fixture parameter binding

**Rule:** For same-process node-postgres fixtures targeting `timestamp without time zone`, bind `Date` values when modeling service-created instants; an ISO `Z` string is a different wall-clock representation. Do not interpret this as cross-timezone service safety.

**Why:** UTC masks the distinction. Independent PostgreSQL round trips showed ISO-string fixtures shift by the local offset in Denver and Kolkata while `Date` parameters preserve the instants under the same writer/reader timezone. A historical-replay test consequently passed in UTC CI but failed a production-copy gate run on a non-UTC host.

**How to apply:** Compare the column type, driver serialization and parser before diagnosing signed-digest failures. Include a non-UTC timezone in the relevant regression evidence and distinguish fixture correctness from mixed-timezone production semantics. Never repair evidence by rewriting stored hashes or weakening digest validation.


## Consistent clocks for ordered lifecycle transitions

**Rule:** Ordered lifecycle timestamps and their expiry decisions need a consistent authoritative clock. Mixing application-clock creation/promotion with database-clock acknowledgement can violate a correct timestamp-order constraint even when every process uses UTC.

**Why:** A production-copy gate exposed lifecycle stamps ordered incorrectly under a small host/database clock skew. Independent actual-source probes with the app clock both ahead and behind also showed erroneous live/expired decisions until the changed transitions consistently used database time.

**How to apply:** Sample the fresh database clock after acquiring the authoritative row lock; use that sample for the transition's expiry decision and stamp. Preserve the constraint and evidence. Keep clock skew, timezone serialization, transaction-start clock staleness and commit visibility distinct; one clock source alone does not establish cross-transaction ordering.

