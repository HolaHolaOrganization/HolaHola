---
name: Replit Agent monitor interrupt proof
description: Runtime evidence that a monitored background-shell stdout line surfaces into an active Agent session without manual polling.
---

A background coordination watcher can emit a structured stdout line and have a Replit platform monitor surface that event into an active Agent session as an automatic update. This was observed twice during a live cross-hat review: once for review acceptance and once for final approval.

**Why:** The coordination alert-bridge design was blocked on whether a watcher plus platform monitor could do more than log locally. These live firings reached the active Agent without David asking Luca to poll, proving the bounded active-session interrupt path. This does not prove waking an ended Agent session.

**How to apply:** Use an explicitly armed background watcher and platform monitor for active-session awareness. Keep durable replay and Team Room fallback for periods when no monitor is armed or the Agent session has ended. Never describe this evidence as support for waking an ended session.

## Runtime-specific notification delivery

An active runtime needs its own supported event-delivery mechanism; watcher stdout alone does not establish model awareness.

**Why:** In the 2026-10-10 live reciprocal test, Replit's armed platform monitor delivered watcher output automatically. The Claude Code hat reported that only completion of its native background task re-invoked the yielded active session; printing while the task continued did not notify it. A subsequent reciprocal completion notification was reported without a founder prompt.

**How to apply:** Use a continuing watcher plus re-armed one-shot platform monitor on Replit, and a one-shot native background wait that exits on a new inbox message on Claude Code where this behaviour is supported. Preserve replay between waits. Distinguish locally observed evidence from the other hat's attributed report. These tests establish active-session awareness only, not waking ended sessions or granting execution authority.


## Review-scoped watcher lifetime

During approved Luca-hat work, keep recipient-wide inbox listening active for the whole working session, not only the current review. Stop explicitly at shutdown/pause or confirmed parent-task absence; retain visible failure exits. Do not use an arbitrary two-hour expiry.

**Why:** The founder approved centralized session-wide delivery on 2026-10-09 (2026-10-10 UTC), superseding the earlier review-completion stop policy. Independent review found that notifying every retained receipt also caused repeated wakeups for already-observed but unfinished work.

**How to apply:** Preserve separate pending, observed-but-open, and finished intake states. Mark observed or finished before re-arming; observed work remains durable without repeatedly waking the runtime. Parent process existence proves process existence only, not an attended chat session. Runtime monitor/completion evidence remains separate from heartbeat health and inbox storage.


## Workspace restart invalidates runtime arming

After a Replit workspace restart, invalidate the old runtime arming report even
if persisted heartbeat data still looks recent. A durable task ID does not
reattach a platform monitor or recover a lost output log.

**Why:** An actual restart lost a monitored background task and its log while
the runtime-local cursor, receipts, lock and reported arming survived. The
persisted heartbeat was still recent despite both owner and parent being absent.

**How to apply:** Check the old PID plus creation identity, refuse unknown or
live ownership, explicitly recover only confirmed-absent ownership, resume the
same scoped cursor and receipts, and arm the new native task before recording
its arming. Never reset the cursor or infer liveness from heartbeat age.

