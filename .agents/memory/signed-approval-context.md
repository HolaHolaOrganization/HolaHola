## Protocol binding and rollout

An existing approval-context hash in storage is not enough to establish that
the proof protocol binds the caller's readable intent. Trace both nonce
issuance and verifier reconstruction, and independently compare the signed
context with the caller's canonical descriptor.

**Why:** An ownership proof can correctly authenticate the holder and artifact
while the client cannot distinguish a task-only approval from a different
purpose or candidate. An opaque receipt hash does not expose those bindings.

**How to apply:** Keep purpose-specific context in the signed proof, retain
legacy bytes only for genuinely context-free callers, and deny promotion when
context is absent. Treat receiver/workflow changes as a separately authorized
protocol rollout; never add an old-protocol fallback to make bootstrap work.


## Bootstrap release approval is separate from immutable allocation

For a founder-reserved bootstrap release, distinguish the immutable allocation
artifact from a separately founder-approved, exact-commit ownership artifact.
The release artifact may accompany a new ownership request under the existing
reference without replacing the original allocation definition or published
legacy transport. Keep that distinction explicit in the artifact and review.

**Why:** The first registry rollout freezes accepted bootstrap bytes. Republishing
expanded release scope under the reserved reference would conflict with those
bytes, while pretending the original build-only artifact authorizes release
would erase the approval boundary. Separate context-bound ownership preserves
both the original reservation and the new release decision.

**How to apply:** Preserve the original canonical build artifact and transport;
use the release artifact in the executor's owned checkout and attributed review
record, then request a fresh candidate-bound approval with existing custody.
Do not invoke the legacy artifact publisher for those new release bytes. This
is a pre-registry bootstrap arrangement, not general permission to revise
registered tasks; later scope changes use a new registration with supersedes.

