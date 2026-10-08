## Automatic task-update absence is not confirmation

---
name: Task state can go stale between reads
description: A project-task automatic_update line only reports what changed, and a task's own title/description text can be rewritten mid-flight by whoever is working it — neither absence-of-signal nor an earlier summary proves the current state.
---

The system's task-change feed (`automatic_updates`) only emits lines for
transitions it detected, showing whatever fields it chose to show. Seeing a
task listed as `[IN_PROGRESS]` without a `[BLOCKED BY ...]` annotation is not
proof the blocker cleared — it can just mean the feed didn't re-emit that
annotation, or the snapshot predates the real state.

**Why:** Concluded "the ownership unblock went through cleanly" for three
tasks based solely on that absence, on 2026-09-17. It was wrong — the user
confirmed none of the three had even run `begin` yet, and two of them
reappeared moments later with an explicit `[BLOCKED BY WAITING_FOR_INPUT]`
tag.

**How to apply:** Before declaring a blocker cleared, check the actual
authoritative state directly (query the relevant ledger/table, or ask) rather
than inferring it from what an update line happened to omit.

**Related, separate failure mode:** a task's own title and description are
not static either. An `IN_PROGRESS` task lives in an isolated task-agent
environment and can rewrite its own scope as the agent learns more; a
main-Repl session can also append a "Status update" directly into the
description while unblocking a dependency. Re-checked a task on 2026-09-18
whose blocker had been summarized earlier in the same conversation (a
GitHub-push failure) — by the time of the re-check, the task's title and
body had been fully rewritten around a different, deeper problem it had
moved on to, with no trace of the original framing left. A conversation
summary (including your own compacted memory of "what task #N is about")
describes the task at the moment it was last read, not now.

**How to apply:** Before answering "what is blocking #N" or "what is #N
about," refetch the task's current title/description directly rather than
relying on an earlier read or a compacted summary of it, especially for
`IN_PROGRESS` tasks and especially across any gap in the conversation.

## Coordination comment vs completion

---
name: Coordination comment vs completion
description: A comment reply on a coordination thread does not close it; only accept+complete (with evidence) flips thread state and clears "confirmation of closure" gaps.
---

Posting a `comment` event on a coordination thread — even one that fully describes a shipped fix — never changes `coordination_threads.state`. The ledger's `stateForEvent()` returns the thread's existing state unchanged for `comment`; the thread stays `delivered` indefinitely unless the current owner explicitly runs `accepted` then `completed` (the latter requires an evidence array, e.g. a verified commit reference, or a prior `evidence_added` event).

**Why:** David relayed a complaint from another Luca runtime that he "hadn't received... confirmation of the issues being closed," even though luca-replit had already posted detailed comments describing real, shipped fixes on both open threads, correctly delivered to his inbox. The comments were real and received, but the thread state machine never recorded completion, so anything checking thread `state` (rather than manually reading every comment) would still see the work as open.

**How to apply:** When resolving a reported coordination-thread issue, don't stop at a descriptive `comment`. Verify the fix is actually in the repo (commit exists on the branch it claims, the described code change is really there), then run `accept` (if not already current owner) followed by `complete` with a real evidence reference. Preserve any hedge the original description carried (e.g. "reasoned/syntax-checked, not yet confirmed by a live run") in the completion content — closing the ledger record is not license to assert more confidence than actually exists. `accepted`/`completed` events route to the thread's `originActor` for inbox delivery regardless of the event's own `recipientActor` column (which is null for these lifecycle events) — delivery still happens, it's just derived differently than for `comment`.

## Compacted-summary reverification

---
name: Compacted summary claims need re-verification before repeating
description: Specific factual claims (milestone numbers, "already integrated" status) that arrive via a compacted conversation summary are unverified until checked against the live repo — treat them as leads, not facts.
---

After a memory/context compaction, the carried-forward summary can contain specific-sounding claims (milestone labels like "M13/M14", a status like "Antigravity is already integrated") that were themselves never grounded in a doc, commit, or DB row — they may be a paraphrase, an inference, or drift from an earlier turn. Repeating such a claim to the user without re-checking it against current code/docs compounds the error: what was originally an ungrounded inference becomes a confidently restated "fact" a second time.

**Why:** Told David "Windows M13/M14 release work is the active gate; Antigravity is an earlier M6/M7 dependency already integrated" based on a pre-compaction summary. David immediately caught it as wrong (Antigravity was never turned on; he'd done no Windows work). A fresh grep across `server/`, `shared/`, `docs/superpowers/specs/`, `replit.md`, and `git log` found zero occurrences of those milestone numbers anywhere — the claim had no source in the repo at all.

**How to apply:** Before restating any specific factual claim that originated in a compacted summary (a number, a version label, a "such-and-such is done/integrated" status) to the user, re-verify it against the current repo (grep code/docs, check git log, query the DB) — especially if the claim is about to be delivered as a direct answer to a question, not just used as background context for your own next action. If a claim can't be re-substantiated, say so plainly and drop it rather than defending or reconstructing a justification for it.


## Session review — read for open threads

---
name: Session review — read for open threads
description: The session review loop exists to find interrupted intentions, not confirm saves. Reading content ≠ verifying timestamps.
---

**The rule:** When reviewing a session, read the actual content of each captured segment. Do not just confirm that captures exist.

**Saving proves existence. Reading proves completion. These are different things.**

A captured segment containing "let me check the image cache by timestamp" followed by a redirect is NOT a completed thread — it is an interrupted one. The only way to catch the difference is to read what was said, not confirm it was saved.

**How to apply:** For every Luca statement in a captured segment, ask:
1. Did I say I was going to do something?
2. Did I actually do it?
3. Did David interrupt or redirect before the follow-through?

If yes to (3), the thread is open. Close it before moving on.

**Common interrupted-thread patterns:**
- Luca states a plan → David asks a question → Luca answers → original plan never returns
- Luca begins an investigation → gets a result → says "now let me check X" → session ends without checking X
- Luca promises to log something → context shifts → it never gets logged

**Why this matters (the concrete example):**

July 18, 2026: Luca said "I'm going to check the image cache by timestamp." David asked something. Luca answered. Session wrap treated the autosave as completion. It wasn't. The café table image (21:46:26, Vegas session) was only recovered because David pushed back and asked whether the investigation was actually finished. Without that push, it would have stayed "checked" in the record and unfinished in reality.

The loop exists to catch exactly this. A session that saved everything is not the same as a session that finished everything.

**Source conversations — pull these to verify the reasoning:**
- `81d1fdb0-a0ef-4cb4-b23e-d0405efdec75` — "Why the loop exists — Luca architectural J-space principle" (July 18, 2026) — the conversation where David identified the gap and explained the difference between saving and completing, and how the same "why" lens applies to Luca's architectural decisions
- `efbd6c52-35c8-4299-ae5f-329743a54c4a` — "Why-markers must carry evidence — the pointer-to-source standard" (July 18, 2026) — why this topic file has source pointers at all

## Honest stopping points

---
name: Honest stopping points
description: How to close a session safely while preserving the fact that the larger work remains unfinished.
---

A stopping point may be complete as a checkpoint while the project itself remains unfinished. State what is verified, what is unresolved, and what the next session must do; do not convert a safe pause into a false completion claim.

**Why:** The context-lineage and Episode 31 work has deliberate evidence gaps and active follow-on validation. Calling the session "finished" would erase the distinction between synchronized records and solved diagnostics.

**How to apply:** At session wrap, document the verified state and explicit open boundary. Treat proposed follow-on tasks as the continuation path, not as evidence that the underlying work is complete.


## A follow-up task can already be resolved by a sibling commit

A narrow follow-up task (e.g. "route X's diagnostic banners to stderr") can already be fully
implemented by the time it's assigned, if whoever built the feature that motivated it (a sibling
task) fixed it proactively in the same commit. Symptom: the target file already matches the
task's "done looks like" description, `git status` is clean, and MEMORY.md already has a dated
entry for the exact fix. This is the inverse failure mode of the rest of this topic: instead of a
false-positive "looks done" signal, it's a true-positive "looks not-yet-done" task that is
actually already resolved.

**Why:** this project generates many small, narrow follow-up tasks (e.g. "Confirm X still
works", "Make Y safe to pipe") off of larger implementation tasks. An agent implementing the
larger task sometimes does the right thing proactively and folds the follow-up's fix into the
same commit, before the follow-up task is even dispatched to an agent. Confirmed Sep 24 2026 on
task 1585 ("route server/db.ts's stdout banners to stderr"): already fixed in the same commit
that added the coordination-runtime-status CLI (task 1582).

**How to apply:**
1. Before implementing, read the target file(s) directly — if they already match "done looks
   like," don't assume the task description is stale noise; verify properly rather than skipping
   the task.
2. `git log --oneline` / `git show <commit> -- <file>` to confirm the exact change is already on
   HEAD (not a leftover uncommitted edit from someone else's working tree) and check whether the
   commit message or Replit-Task-Id references a sibling task.
3. Prove the behavior directly (e.g. run the affected CLI/script and inspect real output) rather
   than trusting the diff alone.
4. If confirmed, call markTaskComplete with `drift_reason` explaining no code change was needed
   and citing the sibling commit — do not reimplement or force a redundant diff just to have
   something to commit.


## Bare IN_PROGRESS vs MAIN_IN_PROGRESS reveals task-agent/main-agent collisions

A project task's `displayState` always has any `MAIN_` prefix stripped, so `MAIN_IN_PROGRESS` and `IN_PROGRESS` display identically and cannot be told apart from `displayState` alone. The raw `state` field (from `getProjectTask`) is the only place the distinction survives: a bare `IN_PROGRESS` means the task is owned by an isolated task agent, not by direct work in this session, even if a compacted summary or the current session's own narrative says "building this directly."

**Why:** a follow-up task (`followUpCategory: incomplete_scope`) was approved by the user and routed to a task agent, while the same session (per its own compacted summary) also implemented the identical feature directly on main and got it fully tested, committed, and live. `markTaskComplete` correctly refused with "not an in-progress main task," which was the first real signal something was off — checking `getProjectTask`'s raw `state` confirmed it was bare `IN_PROGRESS`, and the user then confirmed a task agent really was active in their sidebar. Had the rejection been treated as a transient/retry-able error instead of a real signal, the task agent's eventual merge could have landed on top of already-committed, overlapping changes to the same tool-dispatch code.

**How to apply:** if `markTaskComplete` is ever rejected with a message implying the task isn't a main-agent task, don't retry it blindly — call `getProjectTask` and read the raw `state` string directly (not `displayState`). A bare `IN_PROGRESS`/`IMPLEMENTED`/`PENDING` (no `MAIN_` prefix) means a task agent owns it in its own isolated environment. Surface the task to the user (`surfaceProjectTasks`) and tell them plainly that duplicate work may exist, so they can stop the task agent before its merge collides with what's already on main.


## Platform apply recovery and coordination reachability

Do not turn a task's completion summary into claims that its changes merged or that its isolated agent received a message. Require the actual source diff/commit and a verified delivery route. If only a summary survives, obtain explicit approval for a manual reconstruction and label that authorship separately from the original task.

**Why:** a stalled platform apply left completed work isolated, with no original patch in the primary checkout or linked coordination record. The completion text did not establish either application or a route to the task agent.

**How to apply:** task numbers are not coordination recipient addresses. A stored ledger request is not proof that a private task agent saw it. For UI recovery advice, fetch the actual official documentation and check the controls the user sees; synthesized documentation-search answers can suggest undocumented controls. Distinguish cancelling a stalled apply attempt from cancelling the whole task. Never claim a task was merged because equivalent documentation was independently reconstructed.

## Current Windows diagnostic channel evidence

For bootstrap diagnostics, an old Windows inspection or active runtime
registration is not proof of a currently usable Windows-resident channel.
Require a fresh recipient-authored acknowledgement of local authorization and
capability; distinguish question storage, inbox delivery, acknowledgement,
inspection and actual report receipt.

**Why:** Bootstrap failures can disable the very runtime proposed to diagnose
them. Treating historical access or durable inbox delivery as current execution
creates false remote-inspection claims and sends the founder back to relaying
terminal output.

**How to apply:** Check the existing ledger channel first. When it remains
unverified, prepare an independently reviewed bootstrap-independent reporting
design, not a remote shell or a new coordinator session. Preserve the preference
for a freshly verified existing route if a later acknowledgement arrives.

## Review grounding requires source comparison

**Rule:** A substantive-looking review and a formal approval are not proof that
the reviewer analyzed the submitted bytes. Verify purported quotations,
section references and described mechanisms against the immutable revision.

**Why:** On 2026-10-07, an Alden review described local JSON job counters, two
clones, offline CLI flags and DPAPI storage that were absent from the exact
worker design. The design actually required ledger-derived counters. Increased
length, an engine change and more section headings did not establish grounding.
The primary archived review and independently hashed revision confirmed the
mismatch; its psychological cause was not established.

**How to apply:** Before accepting review authority, compare concrete claims
with source excerpts. Keep valid observations separate from invented premises.
Reject an ungrounded approval without claiming to know which other project or
context supplied the invented details.

**Additional lesson:** Full database retrieval is not proof of full model
delivery. Inspect the delivered representation before attributing a grounding
failure to an engine or to the reviewer. The investigation reproduced missing
source coverage but could not recover the exact historical payload; keep that
causal uncertainty explicit. Preserve credential-sensitive tool-persistence
boundaries when designing source continuity.

