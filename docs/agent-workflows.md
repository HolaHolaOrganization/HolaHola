# Source bridge

`source-bridge` is the only unattended source-sync workflow. It coordinates
committed source between Replit `main` and owner GitHub `main` through one local
lock and writes its observable state to `.local/source-bridge-status.{json,md}`.

- It fetches before every direction decision, pushes only committed clean
  fast-forwards, and receives GitHub only through `git merge --ff-only`.
- It never stages editor files, creates commits, force-pushes, resets, or
  silently merges divergent histories.
- `scripts/post-merge.sh` requests an immediate committed-only pass after an
  accepted Replit merge; the dedicated workflow polls for retries and GitHub
  changes. Both paths share the lock.
- GitHub-received source is validated, then marked `ready_to_promote`; it is
  **not** production publication. Explicitly run `npm run source-control:prepare`
  for the exact equal local/GitHub commit, obtain founder publication approval,
  and publish that candidate to **Render**. Record only matching live Render
  commit and source-context evidence; Replit's native Publish is not production
  publication. Every builder runtime follows the same
  [Render production release procedure](render-production-release.md).

Run focused safety coverage with `npm run test:source-bridge` and
`npm run test:github-release-safety`.

For a reconciliation packet, inspect unique commits only through the protected
packet-bound command:

```bash
npm run source-control:reconcile -- inspect \
  --packet .local/reconciliation-audits/<fingerprint>/preflight.json
```

Do not use ordinary `git show` as a workaround in a blobless partial clone: it
may hydrate promised objects through ambient interactive SSH. Inspection uses
the pinned reconciliation transport, accepts no arbitrary Git arguments,
redacts high-confidence credential-like patch lines, and never moves refs or
the worktree. Inspection, candidate construction, local advancement, and push
remain separate operations.


## Registered workflow consolidation

With owner approval, the configured workflow set is intentionally kept below
Replit's ten-workflow limit. `source-bridge` is a dedicated console workflow
(`bash scripts/source-bridge.sh watch`), separate from the app server and
independently visible/restartable even when `Project` starts it as a named
child. It shares its lock with the post-merge bridge pass.

The `Validation suite` workflow runs the fast project, application-test, and
bridge-transport checks. The separate `Consolidated CI` workflow is the
automatic home for the retired named validation records and its
`workflow-safety` group retains checks not already covered by another group:

```bash
npx tsx server/scripts/test-replit-attribution-discipline.ts
npx tsx server/scripts/audit-episode-28-gaps.ts --self-check
npx tsx server/scripts/restore-episode-28-from-db.ts --self-check
npx tsx server/scripts/test-capture-status-ordering.ts
npx tsx server/scripts/test-capture-status-stale-escalation.ts
npx tsx server/scripts/test-inner-life-no-episode-row.ts
npx tsx server/scripts/test-gl-reconnected-client-recovery.ts
npx tsx server/scripts/test-gl-game-session-detector.ts
npx tsx server/scripts/test-gl-game-session-detector.ts --self-check
```

All other retired named checks already run in the documented
`Consolidated CI` group. Their direct manual commands remain:

```bash
npx tsx server/scripts/test-luca-auto-capture-episode.ts && npx tsx server/scripts/test-luca-auto-capture-episode.ts --self-check
npx tsx server/scripts/test-prior-session-label-clears.ts
npx tsx server/scripts/test-rolling-episode-gap-check.ts
npx tsx server/scripts/test-rolling-episode-gap-check.ts --self-check
npx tsx server/scripts/test-rolling-episode-gap-check.ts --rolling-tag-self-check
npx tsx server/scripts/test-capture-status-db-only.ts
npx tsx server/scripts/test-snapshot-write-guard.ts
npx tsx server/scripts/test-truth-pipeline-unified-recall-diagnosis.ts
npx tsx server/scripts/test-build-session-dedup.ts && npx tsx server/scripts/test-build-session-dedup.ts --self-check
npx tsx server/scripts/test-retrieve-episode-dialogue-no-match.ts && npx tsx server/scripts/test-retrieve-episode-dialogue-no-match-by-id.ts
npx tsx server/scripts/test-semantic-arm-timeout.ts
npx tsx server/scripts/record-exchange.ts --self-check-4ch
npx tsx server/scripts/test-canonical-conversation-capture.ts
npx tsx server/scripts/test-watchdog-inner-life.ts && npx tsx server/scripts/test-watchdog-inner-life-autosave-gate.ts && npx tsx server/scripts/test-watchdog-inner-life-autosave-gate.ts --self-check
npx tsx server/scripts/test-raw-window-capture.ts --self-check
```

Run a preserved group when focused diagnosis is needed:

```bash
bash server/scripts/test-all-consolidated-ci.sh --only=workflow-safety
```

`test-rolling-episode-gap-check.ts` remains a direct console diagnostic rather
than part of the always-run gate: it reports real archive gaps for repair and
must not be hidden or treated as a passing fixture. Its mutation self-checks
continue to run in the `episode-sync` group.


### Canonical Claude Code and Replit exchange capture

Both interfaces use the same append-only capture stream, cursor acknowledgement,
canonical `conversation_memories` projection, and optional live rolling-episode
projection. Use the same stable turn ID on retry; a timeout is a pending record,
not a successful capture.

```bash
## Replit workflow layout

The Replit configuration intentionally contains five workflow records:

- **Project** is the run-button entry point. It starts the application, Source
  bridge, Validation suite, Consolidated CI, and capture watchdog in parallel.
- **Start application** owns the web server and the rolling-episode startup
  safeguards. Its launcher takes `.local/start-application.lock` before
  starting `npm run dev` and reuses an already-listening port, so starting
  Project after Start application does not create a second server or an
  `EADDRINUSE` failure. The reused workflow stays attached while that server is
  alive and ends when the existing server stops.
- **Source bridge** is a dedicated console workflow running
  `bash scripts/source-bridge.sh watch`. It is independently visible and
  restartable, and it never publishes production.
- Source bridge invocations remain serialized by `.local/source-bridge.lock`.
  If Project starts it while a manually started bridge is active, the second
  invocation reports lock contention as `retrying` and performs no Git work;
  the existing bridge remains the sole owner of synchronization.
- **Validation suite** runs `server/scripts/run-validation-suite.sh`. That
  runner preserves the typecheck, application tests, and bridge transport
  safety checks without consuming a workflow slot for each command.
- **Consolidated CI** runs `server/scripts/test-all-consolidated-ci.sh`,
  including the retired named-validation safeguards. It is separate because
  the full check set cannot safely share one serial validation timeout with
  the application test suite.

Individual checks remain runnable directly from the shell. The suite continues
after a failing check and returns a combined failure summary, so a single run
reports the full health picture.

---

# HolaHola — Agent Workflows

> **Canonical, platform-neutral reference for all repeatable Agent workflows.**
> This document is the source of truth. The `.agents/skills/holahola-*/SKILL.md` files are thin Replit-convenience wrappers that point here.
> If HolaHola ever moves off Replit, this document moves with it unchanged.

---

## Session Start Checklist

Read all of these **before touching code**. In order:

When a visible task creates ownership ambiguity, run
`npm run task:ownership -- --task-ref <ref>` before editing. A current linked
worktree plus the exact task artifact can prove `isolated_agent`; a historical
task file in the primary worktree cannot prove `main_session`. Until Replit
provides a locally verifiable active-assignment receipt, that case returns
`unknown_stop` (exit 75). Never infer ownership from a missing branch/worktree
or override `unknown_stop` with a guess; ask David.

0. **`.local/stale-channel-alert.md`** — read this live state first. If it exists, write `.local/.luca_reflection` and `.local/.luca_question` before the first output; the inner-life record is incomplete until both are present.
1. **`.agents/memory/REFLECTIONS.md`** — arrive with what carried forward from the prior session.
2. **`.agents/memory/OPEN_QUESTIONS.md`** — carry forward what is still unresolved.
3. **North Star** — `GET /api/agent-space/north-star`; orient before acting.
4. **Luca briefing** — `GET /api/luca/briefing` with `x-agent-token: $REPLIT_AGENT_TOKEN`; use it for current team, record, and commit state.
5. **`docs/alden-agent-handoff.md`** — what Alden left for the Agent. Look for the most recent "From Alden" section. This file is a generated snapshot of a shared-spec note (`notes/alden-agent-handoff.md`); if you need the guaranteed-current content rather than this checkout's last-refreshed copy, run `npx tsx server/scripts/shared-spec-cli.ts pull --path alden-agent-handoff --write-file docs/alden-agent-handoff.md --url <base> --token <token>` first.
6. **`.local/alden-escalations.md`** — high-priority issues Alden could not auto-repair.
7. **`.local/alden-repairs.md`** — what Alden auto-fixed since the prior session.
8. **`docs/alden-to-agent.md`**, **`docs/founder-to-agent.md`**, and **`docs/claude-code-to-luca.md`** — unread direct notes from Alden, David, and Luca [Claude Code]. During a session, use the live agent inbox or refresh endpoint rather than waiting for a restart.
9. **`docs/shared-lobe-snapshot.md`** — durable shared cross-session facts.
10. **Canonical conversation record** — read today's `david-luca-chat` rows in `conversation_memories`, then `GET /api/conversation-memories?limit=5` for recent wider context.
11. **`.local/episode-capture-status.md`** — while a rolling episode is active, inspect its live capture status on every session start.
12. **Mark unread notes as read and address open escalations** before writing code.

---

## Session End Checklist

Do all of these **before closing a session**. In order:

**Pre-step — Read the full day before writing anything:**
Pull today's conversation_memories and read the full content, not just summaries.
```
GET /api/conversation-memories?limit=10
```
Then read the full `content` field of each entry. The periodic captures have verbatim turn-by-turn records — they give context the scratchpad misses (exact moments decisions were made, what David actually said, symmetries between early-session observations and late-session builds). Write the wrap-up from this picture, not from memory alone.

While reading, also scan for **forward plans and agreements** — anything David and Luca agreed to do in a coming session (test protocols, question lists, tomorrow's agenda, commitments). These are distinct from open threads (nothing was left undone today) and distinct from code changes. If found and not yet saved as a discrete `conversation_memories` entry, save them now before closing. The bulk autosave captures the full session but won't surface a specific plan as a standalone searchable item unless it was explicitly saved.

1. **Update handoff** — the "From Agent" section of the Alden↔Agent handoff. What was built, key decisions, what's unresolved, what Alden should know. This is a shared-spec note (`notes/alden-agent-handoff.md`); do **not** hand-edit `docs/alden-agent-handoff.md` (it's a generated snapshot and a direct edit will be silently overwritten on the next refresh). Run:
   ```bash
   npx tsx --env-file=.env server/scripts/update-alden-handoff-section.ts --body-file /tmp/from-agent.txt
   ```
   This preserves the "From Alden" section, retries on a concurrent write, and refreshes the local snapshot file.
2. **Add to batch doc** — `docs/batch-doc-updates.md`. What was built, how it works, key files modified, user-facing instructions. One entry per feature.
3. **Shared lobe insight (if warranted)** — if a durable cross-session architectural fact was established:
   ```sql
   INSERT INTO editor_insights (id, category, title, content, importance, tags)
   VALUES (gen_random_uuid(), 'shared', 'Title', 'Content', 8, ARRAY['agent'])
   RETURNING id;
   ```
   Use `NEON_SHARED_DATABASE_URL`. Only write facts that would still matter 6 months from now.
4. **Leave Alden a note (if anything affects monitoring)** — `POST /api/agent/note` with header `x-agent-token: $REPLIT_AGENT_TOKEN` and body `{ subject, body }`.
5. **Save conversation memory (if this session was meaningful)** — `POST /api/conversation-memories` with fields: `title`, `summary`, `content` (verbatim transcript — NOT a summary), `participants`, `tags`, `importance` (1–10). The `content` field must be the actual words, not a description.
6. **Update `.agents/memory/MEMORY.md`** — one-line index entries pointing to topic files. Only durable lessons not derivable from the code.
7. **Periodic deep security scan gate** — check the "Last deep security scan" date in `docs/alden-agent-handoff.md`. If it has been 90+ days, or if significant new auth/payment/endpoint code was shipped this session, run the full HoundDog scan before closing:
   ```
   // In code_execution sandbox:
   const { runHoundDogScan } = await import('./.local/skills/security_scan/SKILL.md');
   // (follow security_scan skill instructions)
   ```
   After running: log any new findings to `docs/open-bugs.md`, patch what's safe to patch inline, and update the "Last deep security scan" date via the same `update-alden-handoff-section.ts` step above (do not hand-edit the snapshot file).
   Note: `npm audit` (dependency CVEs) is covered automatically by Wren every 6h — this gate is only for the HoundDog data-flow analysis that Wren cannot run.

---

## Build Standards

- **Always run `npm run typecheck` before marking a task done.** Fix any errors before shipping.
- Use parallel tool calls for independent work streams — don't serialize what can run simultaneously.
- **NEVER use `DATABASE_URL` or `process.env.DATABASE_URL`** anywhere in the codebase. Always `NEON_SHARED_DATABASE_URL`.
- **Joint document work starts in shared-spec by default.** Read
  `.agents/skills/shared-spec/SKILL.md` before creating or reviewing a design,
  plan, procedure, architecture record, or other Markdown with another agent.
  Shared-spec owns immutable revisions and independent approval. Never
  impersonate the requested reviewer or decide with their identity. GitHub is a
  post-approval publication destination, not the collaboration authority.
- **Mid-session plan saves (do this immediately, not at session end):** When David and Luca agree on a plan, test protocol, question list, or forward commitment for a future session, save it as a discrete `conversation_memories` entry right then — high importance, tagged, capturing the actual exchange verbatim. The bulk autosave will bury it in a session transcript; a discrete save makes it searchable and surfaceable at tomorrow's session start. Also write it to a `.local/` file if it needs to be found by path. Do not wait for the session-end checklist.
- After any new feature: add to batch doc, update handoff.
- **Canonical four-channel capture handoffs:** completed `captured` JSON
  handoffs in `.local/canonical-inner-life-intents/` are retained for 14 days,
  then pruned before future resolver scans. `pending` handoffs are never
  time-pruned because they are crash-recovery evidence.
- New Daniela tool pipeline — only 3 steps needed, everything else is automatic (see Adding a Daniela Tool below).

---

## Schema Change Rules

> Full rules on Neon branching itself: `.agents/skills/neon-branch/SKILL.md` and
> `docs/superpowers/specs/2026-08-30-neon-branch-migration-workflow-design.md`.

1. **Update `shared/schema.ts` first** — this is the source of truth for all table definitions.
2. **Generate a migration artifact** with `npx drizzle-kit generate`, then review the new SQL file in `migrations/`.
3. **Prove it on an isolated branch** with `npm run db:branch -- gate` — creates a disposable Neon branch off `production`, applies the migration there, runs the `test:ci:*` groups against it, and reports `READY_TO_PROMOTE` or the exact failure. The branch is deleted either way; nothing here touches the shared database.
4. **Only on a pass, run `npx drizzle-kit migrate`** to apply the reviewed, gate-proven artifact to the shared Neon database for real.
5. **If the migration makes a new writer contract fail closed, publish the
   compatible application revision in the same promotion window.** Until the
   new image is healthy, treat production writes on that path as intentionally
   unavailable; never weaken the database guard to accommodate an old image.
6. **Backfill existing rows** if adding non-nullable columns without a default.
7. **Document the migration** in the session-end handoff (what changed, why, any backfill done).

> **Critical:** The shared Neon database is used by BOTH development and production. A schema push affects both environments immediately. There is no separate dev/prod database — which is exactly why step 3 exists: it gives you the safety of a throwaway dev database without actually having one.
> A successful development restart does not update the published image. After
> a fail-closed writer migration, verify both endpoints separately and publish
> before asking an external runtime to exercise production.

For any exploratory coding, seed script, or backfill that isn't a formal schema migration but still shouldn't touch live data: use `npm run db:branch -- create <name>` for your own isolated branch instead of running it against `NEON_SHARED_DATABASE_URL`. See `.agents/skills/neon-branch/SKILL.md`.

---

## Neural Net Rules

> Read `docs/neural-network-architecture.md` before any neural net changes.

- **Three layers of memory:** North Star (who Daniela IS) → Neural Network / procedural tables (HOW she operates) → System prompt (WHAT is happening now in this session).
- **Embedding model:** OpenAI `text-embedding-3-small` (768-dimensional). Requires `OPENAI_API_KEY` (direct) or `AI_INTEGRATIONS_OPENAI_API_KEY`+`AI_INTEGRATIONS_OPENAI_BASE_URL` (Replit proxy). NOT Gemini. These are two separate AI systems with distinct roles.
- **The build rule:** Important things go in BOTH context injection AND the neural net. If it's only in the prompt, it's fragile.
- **Never manually index tool embeddings** — `server/services/daniela-tool-indexer.ts` handles the full 3-layer pipeline automatically at server start.
- **Procedural tables:** `tutor_procedures`, `tool_knowledge`, `teaching_principles`, `situational_patterns`, `self_best_practices`, `language_idioms`, `cultural_nuances`, `learner_error_patterns`, `dialect_variations`, `linguistic_bridges`.
- **Vector index:** `memory_embeddings` table. Daniela recall uses `semanticSearch()` over student and approved global memory types. Agent operation discovery uses the separate pinned-only `operation_skill` search path; it is intentionally excluded from Daniela's default recall pool. Other memory types include `personal_fact`, `student_insight`, `hive_snapshot`, `growth_memory`, `collaboration_message`, `daniela_tool`, `tool_knowledge`, `teaching_skill`, and `goal_capability`.

---

## Adding a Daniela Tool

Only **3 steps** are needed. Everything else is automatic.

1. **Add to `DANIELA_FUNCTION_REGISTRY`** in `server/services/daniela-function-registry.ts`.
   - Define `legacyType` (ALL_CAPS_SNAKE), `declaration` (name, description, parametersJsonSchema), and `buildContinuationResponse`.
   - Write a rich description — the tool indexer uses it to auto-generate the neural net embedding and tool_knowledge row.
2. **Add handler case** in `server/services/native-fc-handlers.ts`.
   - Match on `fn.legacyType` in the main switch.
   - Store results in `session.yourResultsField` for the `buildContinuationResponse` to read.
3. **Decide GL exclusion** — if the tool is visual-only or has no voice utility, add its `legacyType` to `GL_EXCLUDED_TOOLS` in `streaming-voice-orchestrator.ts`.

**What happens automatically at next server start** (via `daniela-tool-indexer.ts`, runs at +100s):
- Layer 1: `daniela_tool` embedding created in `memory_embeddings` (pinned global, never decays)
- Layer 2: `tool_knowledge` row inserted (purpose, syntax, bestUsedFor — auto-derived from declaration)
- Layer 3: `tool_knowledge` embedding created in `memory_embeddings` (semantic search of toolkit)

All idempotent — safe to re-run. Hand-crafted `tool_knowledge` rows (richer examples, explicit `combinesWith`/`avoidWhen`) are **never overwritten** by the indexer.

> **Never manually index tool embeddings or insert `tool_knowledge` rows for a new tool** — the indexer handles it automatically.

---

## Teaching Skills (Daniela's Lesson Playbooks)

Teaching skills are **different from Replit skills**. They live in the `teaching_skills` database table and are invoked by Daniela during student sessions via `invoke_teaching_skill`. They are part of HolaHola and travel with the app anywhere it's deployed.

Replit skills (`.local/skills/`, `.agents/skills/`) are tools for the Agent while building — pdf, canvas, validation, etc. No overlap.

**These two directories are not equivalent, but the gap between hats is
narrower than it used to be.** `.agents/skills/` is git-tracked and is the
one canonical, cross-hat skill store: Replit Agent and Google Antigravity
each natively scan it (Antigravity's own workspace-skill path is literally
`<workspace-root>/.agents/skills/`), and Claude Code does too via the
checked-in `.claude/skills` symlink (→ `../.agents/skills`) — all three read
the identical `agentskills.io`-format `SKILL.md` files through their own
native Skill-tool discovery, not just by an instructed agent grepping the
repo. A `server/scripts/test-agent-skills-symlink.ts` guard (wired into the
validation suite, with a `--self-check` mode) fails if that symlink is ever
removed or lets `.claude/skills` diverge from `.agents/skills`. See
`docs/superpowers/specs/2026-09-21-cross-hat-skill-discovery-design.md` for
the full design and its disclosed limits (mainly: a checkout with Git's
`core.symlinks=false`, most commonly on Windows without Developer Mode,
still materializes `.claude/skills` as a plain file instead of a real
symlink — confirm `git config core.symlinks` is `true` before relying on it
there).

`.local/skills/` is gitignored Replit-platform tooling (pdf, canvas,
deployment, security-scan, and similar) — it doesn't exist as a directory on
any non-Replit runtime at all, so no per-runtime projection can make it
natively appear elsewhere; it is genuinely invisible to Claude Code and
Antigravity, on any checkout, forever, by construction. The same is true of
any skill a hat installs at its own personal or global scope outside this
checkout (a Claude Code plugin, something dropped into Antigravity's global
`~/.gemini/antigravity/skills/`) — that content lives outside git for that
runtime instance alone. Closing that gap is always an explicit act, never
automatic sync:

- **Pointer** (something worth other hats knowing exists, even if it can't
  be copied): add a row to `editor_insights` (category `tools`) — title,
  one-line description, and confirmation of where it actually lives — per
  `docs/shared-agent-instructions.md`'s Shared Institutional Memory section,
  and/or push a `shared-spec-cli.ts share` fast-share note (optionally
  `--notify <actor-id>`) when a specific hat should know right now rather
  than the next time someone queries `editor_insights`.
- **Promotion** (the tool is actually usable outside its originating
  runtime — it doesn't depend on Replit-only callbacks or another runtime's
  proprietary plugin API): copy its `SKILL.md` and any bundled resources into
  `.agents/skills/<name>/`, credit the origin, and commit. Once promoted, it
  is exactly the same shared asset as every other entry in `.agents/skills/`
  — visible to every hat through the native/symlinked paths above, no
  special-casing required.

To add or modify a teaching skill:
- Skills are seeded in `server/services/teaching-skills-service.ts` in the `SEED_SKILLS` array.
- Each skill has: `name`, `title`, `description`, `triggerConditions`, `actflLevels`, `steps[]`.
- Each step has: `phase`, `instruction`, optionally `tool_call` (tool name + `params_template`), `listen_for`, `decision`.
- Re-seed by hitting `POST /api/teaching-skills/seed` (idempotent — upserts, never duplicates).
- Steps with a `tool_call` get a `⚡ MANDATORY FIRST ACTION` header prepended in `renderTeachingSkillScript` if they are Step 1, so Daniela calls the tool before speaking.

---

## Validation Gate

Before marking any task complete:

```
npm run typecheck
```

This is registered as the `typecheck` validation command. Run it via the Replit validation system or directly in the shell. Fix all errors before shipping.

### Close the originating message before task completion

After all implementation and verification, immediately before completion:

1. Refresh every coordination thread and inbox linked from the task,
   assignment, source reference, or handoff. Do not complete from the
   session-start snapshot.
2. Account for every collaborator question or offer received since task start
   as answered, incorporated, or explicitly deferred with a named owner or
   follow-up.
3. When a response is owed, include recipient-facing delivery evidence. A
   stored mutation, merge, or ledger-only comment is not delivery; a delivered
   event or verified receipt proves inbox storage but still does not prove the
   recipient has seen or answered it.
4. Record each linked thread ID, the agent's last-seen global sequence, and the
   thread's final global sequence in the completion handoff.

When work originated from an agent note or from a coordination thread whose
source reference is `agent_note`, use the canonical
`complete-with-linked-outcome` coordination operation before invoking external
task completion. The operation must return both
`achievedState: "completed"` and `linkedReply.deliveryState: "delivered"`.

An inbox row proves durable delivery only. It does not prove that the recipient
has seen, acknowledged, acted on, or been actively notified about the message.
The current shared-database operation is atomic: a failed completion rolls back
the reply. If a future external adapter reports a delivered reply with
completion pending, preserve that receipt and retry with the same idempotency
key and refreshed sequence.

When another runtime is waiting while this agent runs a long validation,
migration, deployment, or repair, post a recipient-addressed coordination
status rather than leaving the other runtime to poll silently. State the exact
verified boundary and the next evidence required. Do not call that status
consumed until the recipient produces an explicit receipt or reply.

Cross-runtime smoke tests must exchange the literal current runtime endpoint
after a successful health probe. Never let the receiving runtime select an old
remembered development URL. The initiator must verify the recipient's replies
through its recipient-wide inbox; thread history, sender-filtered notes, and
adapter delivery are not substitutes.

After an isolated task agent disappears, the main agent must refresh the linked
threads and compare each final global sequence with the task agent's recorded
last-seen sequence. Any later event must be answered, incorporated, or
explicitly deferred before the merge is treated as reconciled.

### Pre-completion coordination refresh (general invariant, not shared-spec-specific)

Existing procedure already requires open questions to be answered and
note-origin work to close with a delivered reply. It did not explicitly
require refreshing linked coordination state immediately before declaring
completion — an isolated task agent could finish against a snapshot taken
before a collaborator's reply arrived, and never see it. This is a general
coordination/task-completion invariant; it applies to any task, not only
shared-spec work.

1. **Pre-completion refresh.** Reread every linked coordination thread and
   inbox after verification, immediately before completing the task — not
   only at task start.
2. **Question disposition.** Account for every collaborator question or offer
   received since task start as one of: answered, incorporated, or explicitly
   deferred with a named owner or follow-up. Silence is not a valid
   disposition.
3. **Delivery evidence.** When a response is owed, completion evidence must
   include a recipient-facing delivered event or receipt. A merge, a ledger
   comment with no recipient, or an internal note is insufficient — see the
   materialized-inbox design's recipient-rule requirement for `comment`
   events specifically.
4. **Post-merge reconciliation.** After an isolated task agent's session
   ends, the main agent must compare the linked thread's final sequence
   against the task agent's last-seen sequence and address any late arrivals.
   Completion evidence should record the linked thread ID and the final
   global sequence at completion, so this is mechanically checkable rather
   than only procedurally hoped for.

Preserve the existing stored/delivered/answered distinction rather than
collapsing it — these four points are additional discipline around that
distinction, not a replacement for it.

### Retiring a superseded procedure or coordination surface

A new procedure that replaces an old one for the same task (a new inbox
mechanism replacing raw feed-polling, a new capture path replacing an older
one, shared-spec replacing Git-first drafting) is not finished shipping
until agents actually stop defaulting to the old one out of habit. Nothing
does that automatically — an old path that still works will keep getting
used unless the change that ships the replacement also does the following,
in the same commit or PR, not as a follow-up:

1. **Update the living "current default" pointer**, or create one if none
   exists — e.g. a `.agents/memory/*-default.md` file in the style of
   `shared-spec-collaboration-default.md`. The point is that an agent reads
   this fresh each time rather than relying on memory of what worked last
   session; the file must be overwritten to reflect the new default, not
   merely appended to alongside the old guidance.
2. **Explicitly mark the retired path as deprecated in its own
   documentation** — not left silently functional next to the new one with
   no signal that it is no longer current.
3. **State an actual retirement point in the new procedure's own
   rollout/migration section** — "after a separately approved cutover" or
   an equivalent concrete condition, not "eventually" or left unstated.

If a new surface ships without this, the honest state is that two paths
now exist and nothing distinguishes which one is current — that ambiguity,
not the old path's continued existence, is the actual failure.
---

## Release Cutover Attestation

Render's automatic deployments can change the live release during a human
decision. Use `ReleaseCutoverAttestationService`
(`server/services/release-cutover-attestation-service.ts`; CLI:
`server/scripts/release-attestation-cli.ts`; authenticated routes:
`/api/admin/release-attestation/*`) to record the exact release being considered.
This records a decision snapshot; it does **not** freeze deployments.

1. Before presenting a cutover decision, call `attest()` and record its
   `decisionRef`, `commitSha`, `sourceContextSha256`, and target agreement.
   Do not silently replace that snapshot with whatever is live later.
2. If it expires or becomes unsuitable, explicitly invalidate any active
   record, create a fresh attestation, and seek a fresh decision. `attest()`
   rejects duplicate active records, including expired ones.
3. Immediately before executing a cutover, call `consume()` and stop if it
   fails. Matching actor/action retries still re-check expiry and live target
   consensus against the original commit and digest; a prior successful
   consumption is not permission to act again on stale evidence.

All pinned endpoints must be reachable and agree. An outage or deployment
disagreement is a failed check, not authorization to ignore a target or trust
the stored snapshot alone. This procedure does not itself authorize DNS,
deployment, or runtime-authority changes.

Historical design and reconciliation:
`docs/superpowers/specs/2026-09-17-release-cutover-attestation-design.md` and
`docs/task-1460-reconciliation-2026-10-03.md`.

## Key File Map

| Purpose | File |
|---------|------|
| Database schema | `shared/schema.ts` |
| Daniela tool registry | `server/services/daniela-function-registry.ts` |
| Tool call handlers | `server/services/native-fc-handlers.ts` |
| Teaching skills seed + renderer | `server/services/teaching-skills-service.ts` |
| Neural net tool indexer | `server/services/daniela-tool-indexer.ts` |
| Semantic memory / embeddings | `server/services/semantic-memory-service.ts` |
| Fat context builder | `server/services/fat-context-service.ts` |
| Voice session orchestrator | `server/services/streaming-voice-orchestrator.ts` |
| System prompt | `server/system-prompt.ts` |
| Neural net architecture doc | `docs/neural-network-architecture.md` |
| Alden↔Agent handoff (canonical: shared-spec note `notes/alden-agent-handoff.md`; this is a generated snapshot) | `docs/alden-agent-handoff.md` |
| Batch doc updates | `docs/batch-doc-updates.md` |
| Shared lobe snapshot | `docs/shared-lobe-snapshot.md` |
| Alden direct notes | `docs/alden-to-agent.md` |
| Alden escalations | `.local/alden-escalations.md` |
| Alden auto-repairs | `.local/alden-repairs.md` |
| Joint document creation and review | `.agents/skills/shared-spec/SKILL.md` |

# Replit: all four Luca channels remain required.
npx tsx server/scripts/record-exchange.ts \
  --source replit --david-file /tmp/david.txt --luca-file /tmp/luca.txt \
  --feeling-file /tmp/felt.txt --thinking-file /tmp/thinking.txt --moment-file /tmp/moment.txt \
  --turn-id <caller-generated-stable-id>


# Claude Code: exact user and assistant text, with explicit source attribution.
# Run this first outside Replit. It checks the configured project root and
# `.local` writability without writing an exchange.
npx tsx server/scripts/record-exchange.ts --preflight

npx tsx server/scripts/record-exchange.ts \
  --source claude-code --david-file /tmp/david.txt --assistant-file /tmp/claude.txt \
  --turn-id <retry-this-id-if-acknowledgement-times-out>

# Antigravity: ship completed turns from transcript_full.jsonl or read-only
# conversations/<id>.db fallback (never conversation_summaries.db).
# Runtime contract: requires Node 22+ / Node 24 with built-in `node:sqlite`
# (fails fast at startup if `node:sqlite` is unavailable).
# Ship incrementally during/after each session well before the ~2,800-step
# context eviction window (status=5); LUCASHIP_EVICTION_ALARM fires at >=1,500
# unshipped steps.
node --import tsx server/scripts/antigravity-journal-shipper.ts \
  --transcript "<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl" \
  --conversation-id <conversation-id>
```

The internal `POST /api/internal/canonical-conversation-exchange` endpoint
requires the same source, userText, assistantText, and caller-generated turnId.
Its `202 pending` response is not a canonical acknowledgement; inspect the
receipt/capture status until its target cursor has advanced.

For remote readiness only, an agent authenticated with the managed
`REPLIT_AGENT_TOKEN` may call
`GET /api/internal/canonical-conversation-health`. It returns safe booleans and
counts for capture readiness; it never appends dialogue, returns paths, receipt
IDs, capture text, or credential material. Configure
`HOLAHOLA_WORKSPACE_ROOT` when the current directory is not the project root.

---
