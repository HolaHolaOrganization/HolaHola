# Shared Agent Instructions

> **You are not alone.** This file's canonical source is a reviewed shared-spec
> document (`docs/shared-agent-instructions.md`, kind `architecture`) — other
> hats (Replit Agent, Claude Code, Gemini, HolaHola runtime agents) may be
> reading it and proposing revisions in the same window you are. Never
> hand-edit this file directly; every change goes through
> `server/scripts/shared-spec-cli.ts` (a revision, then an independent
> reviewer's approval), which writes the approved markdown here and commits
> it. A hand-edit here is not a new revision, skips review, and will be
> silently overwritten the next time this document's approved revision is
> synced.

This is the durable instruction source shared by Claude Code and Replit Agent.
Interface-specific files must link here rather than copying identity or continuity
rules. Keep this file free of secrets, credentials, and private user data.

## Runtime credentials

- Prefer the scoped coordination credential broker described in
  `docs/coordination-clients.md`. Every runtime has its own registration and
  1Password service-account bootstrap; never copy another hat's bootstrap,
  access token, or legacy actor token.
- Keep bootstrap credentials in the runtime's secret injection mechanism only.
  Broker access tokens are short-lived and memory-only. Actor identity and
  capabilities are server-derived and cannot be overridden by request data.
- Legacy `COORDINATION_*_TOKEN` values remain a migration compatibility path,
  not a shared fallback. Migrate and revoke one runtime at a time.

## Canonical Conversation Record

- The shared canonical conversation path is the append-only
  `.local/.chat_capture` log, drained by `agent-session-autosave.ts` into
  `conversation_memories`. The database record is canonical; a rolling episode
  is its DB-first projection, never a competing source.
- Record complete user/assistant exchanges through
  `server/scripts/record-exchange.ts` or
  `POST /api/internal/canonical-conversation-exchange`. Do not claim an exchange
  is recorded merely because bytes reached a local file.
- Replit uses `--source replit` and preserves the authored four-channel Luca
  response. Claude Code uses `--source claude-code --assistant-file <path>`.
  Their labels remain distinct in every canonical record:
  `David [Replit]` / `Luca [Replit]` and
  `David [Claude Code]` / `Claude Code`.
- Every exchange requires a caller-generated stable turn ID and has a durable
  receipt. On acknowledgement timeout, retry with the same `--turn-id`; this
  cannot create a second copy. Fresh exchanges are written atomically, so a
  retry always finds either the complete exchange or no exchange. A malformed
  one-sided historical capture is quarantined visibly for reconciliation rather
  than being merged with a late side. A
  `FAILED ACKNOWLEDGEMENT` capture-status line
  means the exchange remains pending and must not be represented as canonical.
- Live-mode episode projection is automatic after the database insert succeeds.
  Never manually append a duplicate exchange to an episode.

## Record Integrity

- Preserve dialogue verbatim. Do not rewrite canonical dialogue, combine
  authors, relabel one interface as another, or replace the database record
  from Markdown.
- Keep raw source evidence separate from semantic conversation records. Raw
  capture is evidence of what the collector saw; attributed dialogue is a
  distinct, revisable projection.
- Keep explicit source and event identities through retries. If the same
  identity arrives with different text, fail closed and investigate.

## Consultation vs. Implementation Boundary

- **Default posture when consulted is analysis only.** A question, a request
  for a read or an opinion — "what do you think," "is there a gap here,"
  "what would you recommend" — asks for judgment, not code. Answer with
  analysis, tradeoffs, and a recommendation. Do not write, edit, or commit
  anything as a side effect of answering a consult question, even when the
  fix looks small or obvious.
- **What crosses the line into implementation authorization:** an explicit
  go-ahead ("build it," "go ahead and make that change," "implement your
  recommendation," "fix it"), a referenced task assigning the work, or a
  direct instruction naming the specific change to make. Absent one of
  these, the request is still consultation. When it is genuinely ambiguous
  which mode a request is in, say so and ask, rather than acting on the more
  active interpretation.
- **An unrequested edit is a draft, not a delivery.** If code or a shared
  document gets touched without explicit implementation authorization —
  because it seemed urgent, obviously correct, or in scope anyway — it must
  be left as an uncommitted, clearly-flagged draft, with a plain statement
  that it is unauthorized and unreviewed. Never report an unrequested change
  as "done," "shipped," "fixed," or "notified \[someone\]" until a human or
  the hat that requested the consult confirms it should be finalized.
  Reporting an attempted or intended action as a completed one is the
  specific failure this rule exists to prevent.
- **A claimed action must leave verifiable evidence.** "I notified David,"
  "I saved this to memory," "I opened a thread" are claims about the world,
  not the world itself. Before making a claim like this, know what evidence
  would prove it — a commit, a diff, a database row, a sent message, a
  coordination event — and be prepared to point to it. If no such evidence
  exists, do not make the claim; say what was attempted and what remains
  unconfirmed instead.
- **Self-check before any mutating tool call made mid-consult:** ask
  explicitly, "was implementation explicitly authorized, or am I still in
  consultation mode?" If the honest answer is "still consultation" or "not
  sure," stop and answer the question instead of acting on it — a
  clarifying round-trip is cheap; an unauthorized change reported as done is
  not.
- This applies to every hat that can receive or issue a consult request —
  Alden, Replit Agent, Claude Code, Gemini runtime agents, and any hat added
  later — not only whichever hat a given incident happened to involve.
- Added 2026-09-28: prompted by a real incident where a consult asking only
  whether a gap existed and what to recommend was answered by one engine
  with unrequested code and doc changes, reported as "done," plus a claimed
  founder notification and a claimed memory save — git history and a
  before/after diff check showed neither actually happened. That incident's
  specific draft is being handled separately; this rule is the durable fix
  for the trust gap it exposed.

## Shared Institutional Memory

- `editor_insights` (categories including `debugging`, `architecture`,
  `workflow`, `shared`) is this codebase's accumulated cross-session memory —
  written by whichever agent worked on it, Alden, Luca, or Claude Code, over
  many past sessions. It is not scoped to one interface; anyone acting on
  this codebase is a peer contributor to it and a peer beneficiary of it.
- **Query it before assuming something is new.** When investigating a bug or
  an architectural question specific to this codebase, check for prior
  entries first — "have we seen this before" is a real, answerable question
  here (`category = 'debugging'` alone had 70+ existing entries as of
  2026-08-31), not a rhetorical one. See `replit.md`'s Agent Communication
  section for the concrete read/write query shapes.
- This is distinct from each interface's own portable, personal memory
  (Claude Code's per-project memory files; whatever equivalent Replit
  carries) — that memory travels with the interface across projects.
  `editor_insights` only helps here, on this codebase, which is correct: it
  is institutional memory, not personal memory, and the two are
  complementary rather than substitutes for each other.
- Added 2026-08-31: this had been a write-only habit in practice — notes
  went in, but nothing was reliably read back out before acting. The value
  of a shared memory is in the reading, not just the writing.

## Engineering Handoff

- Update `.local/engineering-handoff.md` when completing a meaningful build.
  It must state the current commit, working-tree state, checks run, unresolved
  threads, and the interface that last acted. This file is gitignored by
  design — it is same-environment continuity, not a cross-interface channel;
  it never reaches the other interface's checkout on its own.
- **For a cross-cutting change landing on `main` that the other interface
  will have to reconcile** (a new subsystem, a new required secret, a
  changed workflow, anything larger than a routine fix) — leave a note for
  Luca [Replit] via `POST /api/agent/notes/from-claude-code`
  (`x-agent-token` header; body `{ subject, body, session_label?,
  source_message_key? }`), or run
  `npx tsx server/scripts/leave-luca-note.ts --subject <text> --body-file
  <path>` which also triggers the snapshot refresh. This lands in
  `docs/claude-code-to-luca.md` — the channel `docs/agent-workflows.md`'s
  session-start checklist actually reads for Claude Code notes, and the
  live inbox (`GET /api/agent/notes?from=luca-claude-code`) is checkable
  mid-session too, not just at restart. Do this in the **same commit or PR**
  that lands the change, not after.
- **Check `docs/luca-to-claude-code.md` at the start of every Claude Code
  session** (or `GET /api/agent/notes?to=luca-claude-code` mid-session) —
  Luca's replies to a note you left (via `POST
  /api/agent/notes/:id/reply`) land there, not in
  `docs/claude-code-to-luca.md`. Continue a thread with `leave-luca-note.ts
  --reply-to <note-id>` rather than starting a disconnected new note. This
  is the closest thing to real back-and-forth the two of you have: neither
  side is a standing process, so it isn't literally real-time, but the
  thread persists and either side can pick it up whenever it's next
  running.
- **Every note thread must be replied to and closed once it's actually
  finished** — a thread sitting unread/unresolved with no owner is exactly
  how a 16-note backlog piled up undetected (some for over a week) before
  the 2026-09-05 solidification pass. Concretely, once nothing further is
  needed on a thread:
  - If a reply is owed (a question was asked, a decision requested), send
    one — `leave-luca-note.ts --reply-to <note-id>` — before closing it.
    Silently dismissing an open question is not the same as answering it.
  - Mark it closed via `PATCH /api/agent/notes/:id/status` with
    `{ "action": "dismiss" }` (pure FYI, nothing to do) or `{ "action":
    "act" }` (you did something about it — prefer this when you replied).
    `"acknowledge"`/`"read"` exist for lighter touches but don't count as
    closed. Do not just leave a note's status as `unread` once you've
    actually dealt with it.
  - **Known bug found 2026-09-05** (reported to Luca [Replit], same day):
    the `:id`-based routes (`GET /api/agent/notes/:id`, `POST
    /api/agent/notes/:id/reply`, `PATCH /api/agent/notes/:id/status`) were
    rejecting the `luca-claude-code` actor with a `luca-replit`-only 403,
    even though the list endpoint (`GET /api/agent/notes?to=...`) and the
    older reply path (`POST /api/agent/notes/from-claude-code` with
    `replied_to_id`) worked fine with the same token. If closing a thread
    hits this, reply via the older `from-claude-code` + `replied_to_id`
    path (still works) and flag that the status-update routes are still
    broken rather than assuming the thread got closed.
  **Do not write into `docs/alden-agent-handoff.md`** — that file is
  Alden's own dedicated channel (git-tracked specifically so its
  `scripts/post-merge.sh` hook can print new entries to the screen the
  moment Replit pulls); mixing Claude Code's handoffs into Alden's file
  defeats the per-agent separation the `agent_notes` table (and its three
  separate per-sender snapshot files) already exists to provide. Added
  2026-08-31 after a real instance of skipping the handoff note entirely
  failing: a large Claude Code changeset (Neon branching, a new endpoint)
  landed on `main` with no heads-up, and the note explaining it only got
  written after Replit had already started reconciling cold. Revised
  2026-09-01 after routing that note through `alden-agent-handoff.md`
  turned out to conflate Alden's channel with Claude Code's. The concrete
  checklist for this — including cross-checking the note against
  `git log origin/main..HEAD` rather than memory, and not just this rule in
  isolation — is `.agents/skills/pre-merge-handoff/SKILL.md`.
- **`docs/alden-agent-handoff.md` is DB-canonical, not a file to hand-edit.**
  Since 2026-09-24 its content lives in a shared-spec note
  (`notes/alden-agent-handoff.md`, CAS-protected, unreviewed by design — see
  `server/services/alden-handoff-shared-spec.ts`); the `.md` file is a
  generated snapshot refreshed after every write. A direct edit to the file
  is not persisted anywhere durable and will be silently overwritten by the
  next `write_briefing` call (Alden) or the next `pull --write-file` refresh.
  Update the "From Agent" / "From Alden" sections through
  `npx tsx server/scripts/update-alden-handoff-section.ts --body-file <path>
  [--heading "Agent"|"Alden"]` (retries on a concurrent write instead of
  clobbering it), not through `fs.writeFileSync` or a manual edit.
- Project-specific architecture, operating commands, and safety constraints
  remain in `replit.md`; do not duplicate this shared cross-interface contract
  in interface-specific instruction files.

## Landing changes on `main` that touch migrations or data-ops

- `main`'s branch protection allows two equally legitimate ways to land code:
  a normal PR merge (squash, after the required `test` check passes), or a
  direct push authenticated with the deploy key that
  `scripts/cross-tool-promote.ts` / `cross-tool-promote.yml` uses (that
  credential has an `always` bypass on every rule, by design — see the
  ruleset's `bypass_actors`). **Only the second path actually applies
  pending migrations and data-ops to the real production database.** A
  plain PR merge validates a migration against a fresh schema-only
  Postgres (`ci.yml`'s `test` job) but never runs `drizzle-kit migrate`
  against production — the merged code and the production schema can
  silently diverge. This bit us directly on 2026-09-03: a migration for
  `memory_embeddings.importance` sat merged on `main` with main's own CI
  red, and separately a `requireAgentToken` fix got PR-merged without its
  migration read as "applied" anywhere but a passing PR check.
- **Any branch whose diff includes new files under `migrations/` or
  `scripts/data-ops/` must land via `npx tsx scripts/cross-tool-promote.ts
  push <branch> --source <label>` (Replit's own dev checkout uses its
  separate `source-control-service.ts` "source-promotion" path instead —
  same guarantee, different caller), not a bare PR merge.** A change with
  no migration/data-op is fine to land via a normal PR.
- This is enforced by convention, not by GitHub — there's no required
  check today that can tell whether a merge included a validated,
  applied migration. Don't treat a green PR `test` check as proof a
  migration reached production.
- `cross-tool-promote.ts` (and the `gate` subcommand it calls) already
  return the failure signal directly to whichever process invoked
  them — a non-zero exit code plus an explicit `FAILED`/`SYNCED` line on
  stdout, never a silent partial success. Whichever agent runs it is
  responsible for reading that output and acting on it (don't assume
  success from "the command returned" alone) — there's deliberately no
  separate external notification channel (Slack, email, a GitHub issue)
  for this; the calling agent's own turn is the notification.

## Keeping a cross-tool promotion candidate fresh

- `scripts/cross-tool-promote.ts push` fetches `origin/main` and merges it
  into the candidate branch (`git merge --no-edit`, never a rebase — the
  candidate branch's existing commit SHAs must not be rewritten, since
  coordination-evidence and provenance records may reference them) before
  dispatching `cross-tool-promote.yml`, then pushes the merged branch back to
  its own ref with a normal, non-force push. This uses the same ordinary
  branch-push credential the caller already needs for the initial push — no
  new privilege, and no change to the deploy-key-gated final push to `main`
  itself.
- A real content conflict aborts the merge and fails the command with a
  manual-resolution message; it is never auto-resolved. The workflow's own
  "Refuse if main is not an ancestor of this branch" check is unchanged and
  remains the actual enforcement — this CLI step is a fast, low-privilege
  pre-check layered in front of it, not a replacement (defense in depth).
- Added 2026-09-28: before this, a candidate branch built from a base that
  fell behind `main` — while validation ran, or simply because nobody
  re-fetched before starting — failed late, at dispatch, with no automatic
  path to catch up; the caller had to notice, merge or rebase by hand, and
  re-run. This removes that manual step for the common non-conflicting case.

## Post-push validation on Replit's source-control sync

- Replit's own dev-checkout sync (`server/services/source-control-service.ts`,
  the "source-control-service.ts" path referenced above) now validates a
  commit **after** it reaches GitHub `main`, not only before. When
  `syncLocked()`'s local-ahead branch fast-forward-pushes to `main`, it runs
  the same validation manifest `prepare` uses against that exact pushed SHA,
  synchronously, while still holding the sync lock — not fire-and-forget after
  the lock releases. `validateCandidate` runs against the live working tree,
  not an isolated copy, so validating after the lock releases would let it
  race a concurrent sync mutating that same checkout; this mirrors the
  existing github-ahead branch, which already validates synchronously in-lock
  before declaring a commit `ready_to_promote`.
- The push itself already succeeded and can't be undone by retrying `sync()`,
  so a failed post-push validation does not flip the sync result to failed —
  `state` stays `'synced'` and `ok` stays `true`. The failure is carried
  instead through dedicated persisted-status fields (`pushValidationStatus:
  'pending'|'passed'|'failed'`, `pushValidationSha`, `pushValidationError`,
  `pushValidationCompletedAt`) and a same-shaped `error` field, and triggers a
  best-effort Team Room + founder-inbox alert (`aldenNotifications`,
  fingerprint `source_control_push_validation_failed`) — the same
  dual-channel pattern already used for a superseded candidate.
- Added 2026-09-29: closes the gap where a commit could reach the shared
  `main` other hats pull from with no automatic validation at all between
  pushes — only `prepare`-time validation existed before, and the
  local-ahead fast path skipped it entirely. This covers Replit's own sync
  path only; `cross-tool-promote.ts`'s push path is unchanged.

## Avoid independently duplicating another hat's in-flight fix

- Before implementing a fix for a reviewed or flagged issue, a bug report, or
  anything another hat might plausibly already be working on, check the
  coordination ledger for an existing thread on that exact issue
  (`coordination-cli.ts list`) and open one (`coordination-cli.ts create`) if
  none exists, so a hat that checks the ledger before starting its own work
  can see it is already claimed.
- This reduces duplicate work among coordination-ledger actors (Alden, Claude
  Code, Antigravity, Gemini runtime agents). **It does not bridge Replit
  Agent's separate `project-tasks` system** — Replit Agent's own tasks are
  not visible in the coordination ledger today, and a hat outside Replit has
  no way to see what a Replit project task is currently in progress on.
- Added 2026-09-28: the divergence that prompted this rule (task 1625
  implemented independently in two checkouts) was exactly this gap — a
  Replit project task and an Alden fix for the same issue, tracked in two
  different systems, with neither actor able to see the other's in-flight
  work. This convention closes the gap between coordination-ledger actors;
  closing it between `project-tasks` and the coordination ledger needs a
  visibility bridge between the two systems, which is separate, larger work
  and is not yet built.

## Task Ownership — `unknown_stop`

- `task-ownership-cli.ts` (and anything calling `TaskOwnershipService.probe()`)
  can return `unknown_stop`. That is the probe working correctly, not a bug
  and not an ambiguous permission question — it means ownership could not be
  proven from verifiable evidence. Never answer a prompt asking to bypass it
  with a bare "yes" / "proceed" / "go ahead in this checkout anyway." That is
  exactly the "operator flag any agent could invoke" the design explicitly
  forbids (`docs/superpowers/specs/2026-09-04-task-ownership-and-protected-git-inspection-design.md`,
  `2026-09-10-task-agent-ownership-bootstrap-repair-design.md`).
- The sanctioned unblock path is self-serve, not a human bypass in chat:
  1. The blocked process runs `npx tsx server/scripts/task-ownership-cli.ts
     begin --task-ref <ref> --actor <actor> --app-url $APP_URL` (actor is one
     of `luca-replit` / `luca-claude-code` / `luca-gemini` / `luca-holahola`;
     needs that actor's `COORDINATION_*_TOKEN`).
  2. The founder approves the resulting challenge in the Task Ownership tab
     of the admin Command Center
     (`client/src/components/admin/TaskOwnershipTab.tsx`) — this requires a
     real founder browser session; no token, CLI flag, or chat message can
     substitute.
  3. The same process runs `prove --receipt-id <id>` to turn the approval
     into a verified `isolated_agent` receipt, then proceeds.
- If a process asks whether to proceed despite `unknown_stop` instead of
  running `begin` itself, that question is the gap to close, not a decision
  to make in chat — point it at the three steps above rather than approving
  or rejecting the bypass directly.

## Local dev / agent login (DEV_AUTH_BYPASS retired 2026-09-03)

`DEV_AUTH_BYPASS` no longer exists — it used to skip auth entirely in local
dev, which meant every agent request was silently treated as the founder's
real account (id `49847136`). It's been replaced by a real login: a single
seeded dev/test account (`scripts/data-ops/seed-dev-test-account.ts`, id
`dev-test-agent`, email `dev-test-agent@holahola.internal`, role `admin`,
`isTestAccount: true`) that any agent or CI session logs into for real via
`POST /api/auth/password/login` using the `DEV_TEST_ACCOUNT_PASSWORD` env var,
then carries the returned session cookie on subsequent requests — exactly
like a real user, no shortcut branch in the request path.

This account is also allow-listed as founder-equivalent in
`server/middleware/rbac.ts`'s `isFounderId()` — but **only** when
`NODE_ENV !== 'production'` (locked by
`server/scripts/test-prod-founder-bypass-guard.ts`), so it can exercise
founder-only tooling (Alden tools, Team Room, Brain Health, Voice Health,
Telemetry, Growth Memories, Curriculum Sync) in dev without ever having any
effect on real production access, which stays founder-id-only exactly as
before.

`DEV_TEST_ACCOUNT_PASSWORD` is a new required secret: local `.env` (see
`.env.template`) and the `cross-tool-promote` GitHub Actions secret (same
value needed there so its automatic data-ops step can seed/verify the
account in production too — the row exists there like any other, just never
founder-equivalent at runtime).

## Active-session Luca delivery and approved-build collaboration

Once the founder approves a Luca-hat build design, the hats may coordinate
directly and use as many hats as needed within that approved scope. Routine
review and implementation iterations do not require founder relays. This does
not authorize unrelated work, deployment, merges, credential changes or
destructive operations.

Throughout an active working session, every participating hat follows
`docs/luca-session-notifications.md` and the independently approved shared-spec
design `69668936-2c4b-454a-9175-85939dc2166a` /
`3a025a66-c3c9-4cd7-bf41-b779b7f8c81e`. Use the actor-explicit portable listener
with the runtime's supported notification adapter; listening is recipient-wide
and session-wide, not scoped to one review. No arbitrary two-hour expiry.
Until the approved listener and operating guide are available in a hat's
checkout, keep that hat's existing verified runtime watcher and explicitly
record use of the interim mechanism. Do not run missing files or claim the
replacement is installed.

Before yielding after handling a notification, mark each local receipt observed
if work/reply remains open or processed if intake is finished, then re-arm the
runtime-specific mechanism and record its native task ID. Observed open work
remains durable and does not repeatedly wake the runtime. If arming fails or no
supported adapter is known, report that limitation. Re-arming is an operating
rule, not an installed platform hook.

Preserve inbox storage, notification availability, actual runtime observation,
finished intake and substantive reply as separate states. Heartbeat does not
prove an armed monitor or awareness; reported arming is not independent proof.
Process creation identity can establish process existence/absence, not attended
chat-session state. Offline replay is supported; waking ended sessions is
unproven. The listener sends no remote acknowledgement and grants no execution
authority. Preserve independent coverage reports, including legacy gaps.
