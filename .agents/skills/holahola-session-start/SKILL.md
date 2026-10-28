---
name: holahola-session-start
description: HolaHola session start checklist — follow the single canonical runbook before touching code.
---

# HolaHola Session Start

The single canonical session-start runbook is
`docs/agent-workflows.md` → **Session Start Checklist**. Follow it in order
before touching code.

Do not treat this skill as a second checklist. Its purpose is to direct every
agent — including Claude Code and Replit Agent sessions — to the same live
state checks, personal continuity files, handoffs, canonical conversation
record, and rolling-episode capture status.

## Critical reminders

- For expired coordination credentials, missing LCC messages or an offline
  coordination listener, use `holahola-coordination-recovery`. A working login
  is not proof that the listener is running; preserve active holds.

- A compacted summary never replaces the Step 0 stale-channel-alert check.
- A rolling episode captures debugging, planning, and bug fixes as well as
  explicit episode-writing work; read `.local/episode-capture-status.md` at
  session start whenever a rolling episode is active.
- `NEON_SHARED_DATABASE_URL` is the application database connection. Never use
  `DATABASE_URL`.
- Shared lobe is for durable cross-session facts; the handoff is for current
  session context.