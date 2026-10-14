---
name: Shared-spec collaboration default
description: Records the agreed default surface and review boundary for documents created jointly by multiple agents.
---

Use the shared-spec workspace as the default collaboration surface for joint document creation. Keep the exact revision under review immutable, require the named independent actor to claim and decide it under that actor's own credential, and publish only an approved revision. Reviewer prose is not evidence of claim or decision; verify the canonical shared-spec state directly.

**Why:** David explicitly established this as the default beginning September 7, 2026. Git-first collaboration makes independent authorship and exact-revision approval easier to blur, while the shared-spec record preserves both. A reviewer can report approval after inspecting the wrong Git document or from a runtime that cannot make authenticated shared-spec calls; neither changes the canonical review.

**How to apply:** Start new jointly authored documents in shared-spec when the service is available. Do not impersonate a requested reviewer or silently fall back to Git-first review. After any claimed decision, read the document/review state from the service and verify the exact revision hash before export. GitHub is the publication destination after approval, not the collaboration authority.

## Fast-share notes (added Sep 21 2026, task 1511)

Shared-spec also has a second, lighter path: `kind: "note"` documents in a separate `notes/` namespace, shared via CLI `share`/`pull` with no `ready`/`claim`/`approve` ceremony and never GitHub-published. Purpose is real-time cross-hat visibility — "a hat needs another hat to see something now: a finding, a memory-file update, a scratch draft" — not a place to relocate durable content.

**Why:** it is pull-based (the recipient hat must explicitly call `pull`), unlike `.agents/memory/MEMORY.md`, which auto-loads as `<auto_memory>` context every session with no action needed. Moving durable, environment-specific procedural knowledge (e.g. how this Repl's own git-reconciliation scheduler works) into a note would make it *less* discoverable for a future session, not more — there is no cross-hat audience for content only this workspace's automation ever touches.

**How to apply:** use a fast-share note to announce "I'm about to edit MEMORY.md / here's a finding" to concurrently-running hats *before* committing a change to a widely-touched shared git file, so a concurrent session can fold in first instead of both sides committing blind and needing a manual git-merge afterward (this is what would have prevented needing the manual-reconciliation procedure in `reconciliation-git-procedure.md`). Do not use notes as a substitute home for content that belongs in a git-tracked, auto-loaded memory file or an actually-reviewed spec.

## Published files resist plain filesystem edits (observed Sep 17 2026)

## Published files resist plain filesystem edits (observed Sep 17 2026)

A plain `Edit` to an already-published file under `docs/superpowers/specs/`
(adding a short "superseded" note to the top of a design doc) reported
success, but the file on disk was back to a byte-exact match of the git
`HEAD` blob within a couple of minutes, with no edit visible in `git status`.
Other files edited in the same session, in other directories, stayed
modified -- this is specific to already-published shared-spec paths, not a
general workspace revert.

**Why:** the shared-spec skill (`.agents/skills/shared-spec/SKILL.md`)
governs `docs/superpowers/specs/...` as immutable, DB-tracked, independently
reviewed revisions (see `server/services/shared-spec-core.ts`,
`server/adapters/hola-hola-shared-spec-bootstrap.ts`, whose
`destinationPrefix` is exactly `docs/superpowers/specs/`). Something in the
running app reconciles the working-tree copy back to the approved/published
revision, which is the system correctly doing its job of protecting a
reviewed record from unreviewed drift -- not a bug to work around.

**How to apply:** never plan on a plain `Edit`/`WriteFile` sticking for a
file already under `docs/superpowers/specs/` (check `git log -- <path>` for
a prior "docs: ..." publish commit as a signal). To actually change one,
either go through the shared-spec CLI lifecycle (new revision -> independent
review -> approve -> re-publish) or, if the change is just a note that a doc
is stale/superseded, say so directly to the user in chat instead of trying
to bolt it onto the immutable record.


## Appending a revision orphans any pending review on the old one (observed Sep 29 2026)

`appendRevision` unconditionally sets the document's state to `draft` and
moves `currentRevisionId` forward, with no check for an existing pending
review on the revision being superseded, and there is no `cancelReview`
code path (the `"cancelled"` review state is declared in the type/enum but
nothing ever sets it). A pending review on the old revision is left in the
table permanently `state: 'pending'`, `claimedReviewerActorId` still empty
-- the reviewer *can* still `claim` it (that check never looks at the
document), but `approve`/`reject` will then fail with `CONFLICT` because
the document has moved past that revision.

**Why:** revisions are immutable by design, so "add content to a document
that already has a pending review" has no in-place path -- it always means
append-then-re-request, never editing the reviewed revision. This is
correct system behavior, not a bug, but the stale row it leaves behind
looks like an error if you don't expect it.

**How to apply:** before appending a revision to a document that already
has a pending review, expect that review to become permanently
unresolvable once you do. Re-run `ready` naming the same reviewer on the
new revision right after appending, and tell the reviewer directly which
review id is now live so they don't act on the stale one.


## deliver() never throws -- a 201 on ready doesn't prove the reviewer was notified

The route's automatic `review_requested`/`note_shared` notification
(`shared-spec-notifications.ts`) catches every internal failure and returns
`{state:'failed', ...}` instead of throwing, so the `ready`/`revisions`
HTTP call still returns 201 whether or not the underlying delivery actually
reached the recipient's inbox. The response body never surfaces the
delivery outcome either.

**Why:** this is the same "claimed action must leave verifiable evidence"
gap the Shared Agent Instructions doc itself warns about -- an HTTP success
on the mutation is evidence the *document state* changed, not evidence a
person was told.

**How to apply:** when it matters that the named reviewer actually sees a
new request promptly, don't rely on the mutation's success response alone
-- also post directly to a channel with its own verifiable delivery receipt
(e.g. `POST /api/agent/team-room/message`, which returns a real
`messageId`) and reference the exact review/revision id in it.


## Bounded generated-snapshot refresh

For a generated snapshot refresh, retrieve the current canonical document without also retrieving its entire revision history. Keep history access separate and bounded.

**Why:** A handoff's current revision was available promptly, but the combined current-document-plus-history CLI refresh timed out after 60 seconds. The current snapshot alone was about 735 KB; historical retrieval is unnecessary for refreshing that snapshot.

**How to apply:** When a generated handoff refresh stalls, distinguish the current-document read from history retrieval. Verify the current revision and generate the snapshot from it; do not manually merge competing generated snapshots or mistake a history timeout for a missing canonical document.


## Compressed source transport does not confer approval

When unpublished source must be reviewed before publication, a byte-preserving
compressed packet over the existing immutable-note channel can provide source
access without granting a repository-push exception.

**Why:** Large generated snapshots and diffs can make uncompressed paging
impractical. A minimal Git bundle can reuse already-public prerequisite
histories while retaining exact commit, tree and blob identities. This kept
source access separate from code approval and publication authority.

**How to apply:** Pin all page revisions and content/payload hashes; verify the
decoded packet's full length/hash, prerequisites, commit/tree, complete path
inventory and file hashes in a disposable repository without executing the
candidate. Notes are only a transport: code remains on Git/CI, and source
review, ownership, CI, release and operational qualification stay separate
gates. Use an already-authorized review branch when appropriate; do not weaken
a denied publication gate merely to obtain review bytes.

