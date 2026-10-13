# Shared task registry — staged implementation

This source is staged only. Applying the reviewed migration to the shared
application database and publishing a runtime require separate authorization.
Until migration/backfill/enforcement commit, registry requests fail closed.
No startup DDL, source promotion, worker activation or publication is performed.

## Identity and authority

Task references are globally unique positive-decimal **strings**, up to the
existing32-character storage limit. Never convert references through Number.
Hat allocation uses a PostgreSQL bigint sequence, starting at1000000, advanced
above authentic imports and reserved bootstraps. Sequence gaps are permanent.
Imports larger than bigint are preserved verbatim; they exhaust future sequential
allocation explicitly, rather than rounding or silently reusing a number.

Definitions, source/provenance and artifact bytes are immutable. Changing scope
means a new task with `supersedes`. Replit imports preserve the actual supplied
bytes; platform provenance is declared/unverified, never a fabricated platform
task. Legacy backfill preserves original publisher/time/bytes/hash, with unknown
creator/title/purpose/scope explicitly unknown. Accepted bootstrap artifacts are
embedded verbatim in the migration and checked against their reservation hashes.

Creation/import returns immutable registration. Exact retries do not change
after lifecycle edits. Show/list return current separately versioned lifecycle.
Registry status, registration, imports and materialization grant **no ownership,
founder approval, execution, CI success or publication authority**. Ownership
remains a distinct begin / signed-in founder approve / actual key proof flow.
Discovery marks ownership `not_assessed`, not approved or automatically pending.

## Bounds and authentication

Reuse coordination read/write capabilities. Creator is derived from the
authenticated actor, never request JSON. Require an existing source thread in
which that actor is originator, recipient, current owner or event participant.
Validate canonical project repository binding independently of global ref.

Allocation policy: at most20 newly registered definitions per actor in a rolling
24-hour window, and at most10 outstanding definitions. These are explicit
founder-page noise bounds, not platform guarantees. Per-actor transaction locking
prevents concurrent requests bypassing them. Exact idempotent retries and
same-content existing imports do not allocate new definitions.

Artifacts use the existing preparation/publication256 KiB cap, strict canonical
base64, valid UTF-8 and SHA-256. API definition limits are title200, purpose8000,
up to64 scope/exclusion entries of4000 characters; final rendered bytes must
also satisfy the artifact cap. Source thread IDs must be UUIDs.

## API / CLI

API namespace `/api/task-registry`:

- `POST /tasks`: hat allocation; required `Idempotency-Key`.
- `POST /imports`: exact existing reference/artifact import; same key requirement.
- `GET /tasks?after=<decimal>&limit=<1..100>`: numeric-string seek pagination.
- `GET /tasks/:ref`: immutable definition plus current lifecycle.
- `GET /tasks/:ref/artifact`: exact base64/hash/repository/source/creator.
- `POST /tasks/:ref/transitions`: `expectedVersion`, state and reason.

Create input: `repositoryIdentity`, `startingCommit`, `title`, `purpose`, `scope`,
`exclusions`, `sourceThread`, optional `supersedes`. Import also requires string
`taskRef`, `sourceKind` (`replit` or `bootstrap`) and `artifactBase64`. Bootstrap
imports require an actual matching owner proof; reservation mismatch conflicts.

Lifecycle states: proposed, active, blocked, completed, cancelled. Only creator,
authenticated founder coordination actor, or currently verified exact-artifact
owner may transition. Successful CAS appends an attributed event; losing CAS
conflicts. Closing a registry task does not revoke its ownership receipt.

Portable command:

```
npx tsx server/scripts/shared-task-registry-cli.ts <command> \
  --url <trusted-server-origin> --actor <your-configured-actor>
```

Commands: create/import (`--input <json> --idempotency-key <key>`), list
(`--after <ref> --limit <n>`), show/materialize (`--ref <ref>`), transition
(`--ref <ref> --input <json>`). Only the actor's configured credential is sent.
No keys are requested or generated. Malformed response/input diagnostics never
echo artifact bodies. An import's optional proof is a fresh signed nonce capsule,
not a request-body claim of ownership.

Materialize verifies repository and hash before publishing exact bytes under
`.local/tasks/task-<ref>.md`. Complete, flushed/closed temp followed by exclusive
hard-link publication is the listener's proven algorithm, retained separately
because its reviewed payload is frozen. Identical files are reused; differing
files and symlinks are refused. Interrupted staging files do not authorize work.

## Legacy caller/writer inventory and rollout

Production writer: `publishCoordinationTaskArtifact`, invoked by the
`coordination-v2-publish-task-artifact` CLI. Direct fixture writer:
`test-coordination-task-artifact-registry-postgres.test.ts`. Schema tests inspect
the table but do not publish. Production metadata/material readers use
`PostgresCoordinationTaskMetadataRegistry`; they remain unchanged.

Before enforcement, legacy transport upserted mutable bytes/metadata. After
enforcement, an exact registered retry is a provenance-preserving no-op;
changed bytes/hash/repository/commit and deletes fail. Unregistered legacy writes
require registry import first. Changed scope must use a new reference, not
republish under an old approval. Publisher errors distinguish registration
required and frozen-reference conflict from database unavailability.

Migration holds the legacy table, verifies/backfills every existing hash,
refuses bootstrap conflicts, installs frozen projection/insert-only definition
triggers and advances the sequence before enabling the ready gate, all in the
migration transaction. Every writer uses the same bare-reference advisory lock
as ownership. Registry order is request→actor-bound→allocator→ref. Old
UPDATE/DELETE already holding a tuple use a non-waiting advisory acquisition,
failing busy instead of creating a reverse-lock deadlock.

Focused registry tests are included by the existing ownership-client and
artifact-registry CI entrypoints; the pending listener's runner lines are
unchanged. Database tests require a verified disposable target, refuse shared
hosts including pooled aliases, and use a private job-local schema so repeat
runs cannot mutate canonical rows.
