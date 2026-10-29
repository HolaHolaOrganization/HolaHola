# Runtime central record reads

## Grant lifetime and expiry warning (local source, pending release)

The founder selected a maximum of one calendar year and a warning 14 days
before expiry. Creation and replacement enforce this ceiling using database
time, with UTC calendar arithmetic; a rejected replacement leaves the existing
grant active. The admin snapshot supplies the exact database-derived maximum,
and the UI both bounds its date input and refuses an over-limit confirmation.

After normal HTTP startup, the expiry scanner runs initially and hourly. It
warns once per enabled runtime's unrevoked, unexpired grant within its final
14 days, including newly issued short grants. Delivery is to the founder's
existing `alden_notifications` inbox, not to hats or Team Room. The inbox insert
and successful audit marker commit together; either failing rolls both back.
A partial unique audit index deduplicates by grant ID. A nonblocking,
transaction-scoped scanner lock avoids concurrent scans; short per-grant
transactions recheck runtime/grant state under the grant/revoke runtime lock.
Warnings do not renew access. No additional expired-grant notice is implied.

Generated migration `0068_central_expiry_warning_dedup.sql` adds only that
partial unique index. The shared database has not been migrated. Local proof:
root typecheck; 51 HTTP checks; 21 full disposable PostgreSQL checks, plus
targeted proofs under Denver/Kolkata host timezones and a non-UTC database
timezone. This includes parallel deduplication, both transactional failure
directions, and a scan/revocation race. The disposable Neon migration gate and
native-source review remain separate release requirements.
The current local Neon gate is blocked by ownership-purpose baseline drift:
native main already has newer service/fixture code. The whole workspace is not
a promotion candidate; reconcile only owned central-read changes onto native
main and regenerate migration metadata before approval.

## Founder-only issuance — local implementation, not released (2026-10-28)

The approved isolated-grant design is now implemented locally. This is not a
live grant, applied migration, source approval, deployment or runtime-readiness
claim. The sections below this update describe the already-landed first
increment; their issuer-absent/no-migration statements apply only to that
historical increment.

- Founder controls are in `/admin/runtime-onboarding`. Dedicated
  `/api/runtime/central-read/admin` routes require a loaded canonical founder
  session, reject mixed credential headers and enforce a session CSRF token
  plus the configured `APP_URL` origin, never a request-supplied Host.
  Non-production founder-equivalence does not authorize this path.
- Grants bind an existing exact actor/runtime and only `central-records:read`.
  Confirmation freezes actor/runtime/expiry/expected grant state; background
  refresh cannot silently advance that expected state.
- `POST /api/runtime/central-read/exchange` accepts the runtime's own current
  routine broker credential and an exact grant ID. The browser grant response
  never contains a token. The runtime receives a separate central-only token;
  its TTL is 300 seconds, capped by grant expiry. Five minutes bounds exposure
  of a copied token; grant revocation is additionally checked on every use.
- The dedicated resolver rechecks grant, credential, scope and runtime.
  Generic resolution refuses any grant-bound credential, records the denial,
  and cannot renew it. Routine registrations and token scopes are unchanged.
  Generic grace/reissue/status queries exclude central credentials; an explicit
  runtime-wide revocation remains inclusive.
- Transactions lock the exact runtime using
  `pg_advisory_xact_lock(hashtextextended(runtimeId,0))`, then registration,
  grant and credential rows, using database `now()` for central expiry checks.
  A resolution acquiring that lock after grant revocation commits is denied.
  A previously authenticated in-flight request may finish.
- Required independent-review corrections are applied locally: grace recovery
  ignores central use only for eligibility, then revokes all prior live
  credentials, including used central tokens. Audit counts distinguish revoked
  unused routine credentials from revoked central credentials. Exchange computes
  the expiry cap directly from the locked grant's database timestamp; it never
  round-trips that authority through a host-local JavaScript Date.
- Migration `0067_central_read_grants.sql` adds the grant table and credential
  FK binding, one-scope CHECK, partial live-grant uniqueness and a CHECK requiring
  a binding for central credentials. Expired unrevoked grants are explicitly
  revoked during a confirmed replacement. Audit failure rolls back mutations.
- Native CI registers HTTP fixtures and a dedicated PostgreSQL runner. The
  latter verifies a job-local target, creates its own random child database,
  applies the actual migration to predecessor fixture tables, runs the real
  services and drops that database. It never substitutes the shared database.
  Current verification passes 51 HTTP/policy checks and 15 full PostgreSQL
  checks in UTC, plus the SQL expiry-cap regression separately under
  America/Denver and Asia/Kolkata host timezones. The two non-UTC runs select
  that one test deliberately; they are not full non-UTC application proofs.

Independent exact-source review and the founder-dispatched Linux/Neon migration
gate are still required. No shared migration, held application/listener restart,
live enrollment, recording/backfill, document activation or publish occurred.
The corrected source review package has a local digest manifest. The expired
coordination login was recovered with explicit founder authorization, limited to
the existing Luca [Replit] runtime. A fresh cache-only read succeeded; runtime
identity, permissions and enabled state are unchanged. No legacy fallback,
schema application or held-service restart was used. Corrected source still
requires independent re-review.
The approved-document resolver/activation and genuine native Codex continuity
and visible-message readback remain subsequent work, not completed by issuance.

## Historical first source increment

This source increment implements authenticated machine reading of the same
canonical episode/story records used by the founder reader. It does **not**
complete runtime onboarding or document activation.

## Release state and permission boundary

The required `central-records:read` capability is recognized, but cannot be
issued by any generic registration constructor, generic onboarding or Alden's
registration tool. It is not in the legacy capability map. The dedicated
founder-web grant flow is deliberately not included in this increment.
Therefore deploying this source alone does not grant anyone access.

Do not manually edit registrations or credentials to exercise the endpoint.
Founder issuance requires the next independently reviewed source increment,
explicit founder authorization and compatible code on every serving replica.
This source also recognizes `central-documents:read` without implementing a
document read/activation route or issuer yet.

## API

All operations are GETs below `/api/runtime/central-records`:

| Path | Result |
| --- | --- |
| `/` | Catalog metadata; `limit` 1–100 and nonnegative bounded `offset` |
| `/:id` | Canonical episode or linked story plus exact UTF-8 bytes/hash |
| `/:id/markdown` | Exact Markdown download with safe episode/story filename |

Authenticate using `x-coordination-token` and an independently granted broker
credential. There is no founder-session, legacy-token, Bearer-header or
observation/coordination-scope fallback. Conflicting Authorization headers
are rejected. Identity comes from the validated credential, not query/body/
custom identity headers. The actor must be in `CENTRAL_READER_ACTORS`.
Runtime-admin alone grants no central read access, including for Alden.

Content endpoints accept an optional lowercase `sha256` query parameter.
A growing record that no longer matches returns409 without content.
Unknown/malformed query parameters return400. Missing records return404,
backend or mandatory audit failure returns503, and responses are private/
no-store. Internal error text is never returned.

The repository is reused unchanged: the three exact display-only fixture
exclusions, separate story/episode identity, linked story parent, UTC
microsecond timestamps, bounded metadata-only catalog and canonical bodies
remain authoritative. No filesystem fallback or copied archive is created.

## Audit and receipt

Before a successful catalog/read/download response, the endpoint awaits a
content-free insert into the existing coordination credential audit table.
The projection includes authenticated actor/runtime/credential identity,
operation, canonical returned IDs, pagination or content hash/byte count,
and the database's server timestamp. It does not copy titles, content,
request headers, credentials or raw query strings.

If the audit fails, no successful content response is sent. A content hash
is a receipt for the returned snapshot, not proof of model understanding or
a permanent claim that a growing episode is still current.

No SQL schema migration is needed here: the only schema-module edit extends
the TypeScript recognized-scope list, and the audit uses an existing table.
The later active-approved document binding will require its own reviewed
schema and disposable-database proof.

## Verification and remaining work

The HTTP/policy tests use synthetic fixtures, an injected resolver and audit,
and ephemeral local servers with database variables removed. Actual generic
issuer function bodies are compiled unchanged into a hermetic VM to prove
that both scopes are refused before executor access or secret generation.
This is not a live credential/revocation integration or persistence proof.

Remaining: founder-only issuance UI/service and isolated proof; active
approved document binding/resolver, activation UI and migration gate; actual
Codex identity, grants, shared-memory continuity and native visible-message
recording/readback. Source review, hosted CI, release, grants, activation,
recording and historical backfill remain separate. No held application/
listener was restarted for these tests.
