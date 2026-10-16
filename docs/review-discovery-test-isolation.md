# Review-discovery database isolation

The review-discovery integration test exercises the real path:
`executeAldenTool` → `listAldenSharedSpecReviews` → the service's cached
`SharedSpecCore` → `PostgresSharedSpecRepository` → `getSharedDb()`.

`server/db.ts` captures its connection URL at module evaluation. Checking a
disposable URL without binding it before those imports does not protect fixture
writes. The test now verifies its target, binds the test process's connection
environment, dynamically imports the database, and checks the actual pool's
connection string before writing any fixture. The dispatch module is imported
only after that check. No production database or service routing was changed.

## Target contracts

- A dedicated `SHARED_SPEC_TEST_DATABASE_URL` requires
  `SHARED_SPEC_TEST_DATABASE_DISPOSABLE=1`, must use the PostgreSQL scheme,
  and must differ from `SHARED_SPEC_FORBIDDEN_SHARED_URL`.
- `SHARED_SPEC_REQUIRE_DATABASE_TESTS=1` requires the dedicated URL even if
  another CI URL exists. A bad dedicated target cannot fall back to CI.
- Without a dedicated target, the existing job-local CI contract applies:
  `CI=true`, a loopback PostgreSQL `CI_DATABASE_URL`, and an exactly matching
  `NEON_SHARED_DATABASE_URL`.
- A normal development run without a verified target skips before importing
  database/tool modules. Missing required, unmarked, forbidden, and mismatched
  CI targets fail closed.
- A verified local target uses the existing node-postgres CI transport; a
  dedicated Neon branch uses the existing Neon transport. Binding is confined
  to the test process. The pool is closed on completion or assertion failure.

## Two-database proof

Run against an already verified, disposable local CI PostgreSQL service:

```sh
npx tsx --test server/scripts/test-alden-shared-spec-review-discovery-isolation.test.ts
```

The suite creates a permitted database and an ambient trap for each mode,
applies the actual shared-spec migrations, and launches the original test in a
fresh process with an allowlisted environment:

1. **Dedicated mode:** both ambient application and CI connections point at
   the trap; the explicit dedicated URL points at the permitted database.
2. **Job-local CI mode:** the CI and application connections match the
   permitted database, as required by the existing contract.
3. **Rejected runs:** missing required, unmarked, forbidden, and mismatched
   CI targets must fail before pool initialization, leaving both databases
   unchanged. An ordinary ungated run must skip without writes.

Each successful run must execute the real discovery assertions without skips,
write exactly two policies, five documents, five revisions, five reviews, and
associated idempotency records to the permitted database, and leave all those
trap tables empty. The databases are destroyed in teardown; append-only policy
history is never deleted row by row.

The proof is registered in both `scripts/run-ci-test-steps.mjs` and
`server/scripts/run-validation-suite.sh`. Outside verified local CI, its pure
gate/binding checks still run, while its database-creation test skips.

## Verification and handoff

- `npm run typecheck`: passed.
- Original test and isolation suite in an ordinary development environment:
  three checks passed; the two database-dependent checks skipped safely.
- Isolation suite against a throwaway local PostgreSQL 16 service: all three
  checks passed, including both real dispatch modes and every rejected run.
- No shared production test run, migration, reviewer-policy cleanup, Alden
  policy change, or deployment was performed.
- No coordination thread or inbox source was linked from this assignment.
- The broad system-health verifier is not used as an isolation check: it
  refreshes a persisted synthetic-fixture alert, and a minimal disposable
  shared-spec database does not contain the application's curriculum seeds.
