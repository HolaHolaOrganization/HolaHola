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

For an ongoing cross-hat review, keep the notification watcher running until the review finishes or it is explicitly stopped; do not impose an arbitrary two-hour expiry.

**Why:** On 2026-10-10 the temporary expiry interrupted an unfinished review. The founder explicitly approved replacing it with review-completion or explicit-stop lifetime.

**How to apply:** Resume from the saved inbox cursor, preserve failure reporting and exclusive-process ownership, and stop the watcher when the review is actually complete. A continuing process does not prove notifications can wake an ended Agent session.

