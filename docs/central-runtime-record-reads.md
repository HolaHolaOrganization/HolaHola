# Runtime central record reads

## Native-reconciled issuer candidate — pending review and release

The founder-only issuer, central-bound credential exchange and one-calendar-year
grant ceiling are reconciled onto native main without replacing its newer
ownership protections, GitHub App panel, CI registrations or instance-role gate.
This candidate is source only: no shared migration, grant, release, capture
restart, policy opening or live observation is implied.

The grant UI lives in `/admin/runtime-onboarding`. Its dedicated admin routes
require the loaded canonical founder session, session CSRF token and configured
origin; mixed credentials and non-production founder equivalence are refused.
Confirmation freezes the exact actor/runtime/expiry and expected prior grant.
The snapshot supplies a DB-derived UTC maximum one calendar year ahead;
creation/replacement checks DB time, and rejected replacement preserves the
existing grant.

An exact runtime's current routine broker credential can exchange an active
grant for a separate central-only token, valid for at most 300 seconds and
never beyond grant expiry. The browser never receives this token. The central
resolver rechecks scope, binding, runtime, grant, expiry and revocation on every
use. Generic resolution/renewal cannot accept or upgrade it. Runtime locking
orders grant/revoke/exchange/use. A read authenticated before revocation may
finish; authentication after committed revocation is denied.

Routine grace eligibility, reissue/status and native dormant-retirement usage
checks ignore central tokens, but runtime-wide recovery or revocation remains
inclusive. Grace recovery revokes used and unused central tokens. Native
dormant-retirement safeguards for ordinary credentials remain intact.

Normal production startup runs the expiry scanner initially and hourly after
its role-gated delayed start. Dev instances cannot start it against the shared
database. Each enabled runtime's live grant receives one founder-inbox warning
inside its final 14 days. Inbox and audit inserts are atomic; a partial unique
index deduplicates the grant. A nonblocking scanner lock plus short runtime-locked
rechecks handles concurrency. Warnings neither renew access nor fan out to hats.

Generated `0073_central_read_grants.sql` is based on native snapshot `0072`.
It contains only the grant table, credential binding/check/FK and grant/warning
indexes. Old local `0067`/`0068` migrations and metadata are not carried.
The exact candidate needs independent source review and the founder-dispatched
Linux/Neon migration gate before any authorized shared application.

Approved/active document resolution and native Codex participation are still
subsequent work. Codex onboarding is intended to prove workplace discovery,
attributed communication and active-session reply awareness, observation-bench
discovery within founder-selected access, restart continuity, and its own
evidenced readiness message read back by a colleague. Available hats and Alden
observe; assistance and blocked steps stay visible. No scripted green, new
execution platform, unattended pickup or backfill is implied.

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
