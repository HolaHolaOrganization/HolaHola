## Coordinator reachability and LLM consumption

---
name: Coordinator reachability and LLM consumption
description: Evidence rules for runtime addresses, cloud wake capabilities, and durable consumption by compacting LLM seats.
---

Runtime reachability is observed, expiring state. A URL that worked in an earlier
exchange is not a currently reachable seat, and a session-local scheduler is not
evidence that a runtime can wake while the user's laptop or original session is
offline.

**Why:** During independent review of the Unified Agent Coordinator design, Luca
[Claude Code] hash-verified the exact revision but could not claim it because the
previous Replit development URL had already become a 404. He also verified that
Claude's CronCreate is tied to the current session, fires only while idle, expires
within seven days, and therefore cannot satisfy laptop-off execution. RemoteTrigger
appears to create durable webhook- or schedule-fired cloud sessions, but its exact
relationship to Anthropic Managed Agents remains unverified.

**How to apply:** Treat every runtime address and wake adapter as capability state
with freshness, verification evidence, and expiry. Label current development
addresses honestly; do not promote them to durable endpoints. Prove each adapter's
lifecycle from its live tool or official product contract before assigning
`scheduled`, `push`, or `cloud_start` capability.

For an LLM runtime, `consumed` must be an explicit self-reported receipt tied to
the exact message and the action or reasoning that used it. Merely injecting a
message into a context window is not consumption evidence because later context
compaction can remove its effective influence.

**Why:** A message can be present at an early turn and effectively forgotten after
compaction even though a transport or context assembler would still report that it
was delivered.

**How to apply:** Keep `runtime_received`, `consumed`, `acknowledged`, and
`acted_on` separate. Require an exact-message receipt and record the linked action
or disposition; use replay or re-grounding when later work depends on information
whose continued presence cannot be proven.


## Credential rotation recovery authority

---
name: Credential rotation recovery authority
description: Safety rule for staged runtime credential replacement, emergency revocation, and overlapping rotations.
---

A staged credential rotation must derive recovery authority from its immutable
rotation record, not from whether the source or replacement registration still
looks healthy. Rollback must be able to close the rotation after emergency
revocation and idempotently revoke whatever replacement authority remains.

One runtime may participate in only one active rotation across both roles. A
runtime cannot be a replacement in one active rotation while acting as the
source in another.

**Why:** Requiring mutable endpoint health for rollback can strand an active
rotation after emergency revocation. Role-specific uniqueness alone can permit
an overlapping chain whose rollback or completion leaves orphaned authority.

**How to apply:** Lock all runtime identities involved before testing active
participation. Bind readiness and terminal transitions to the exact persisted
pair and authority snapshot. Let completion require healthy cutover
preconditions, but let rollback close the record even after either endpoint was
already disabled.


## Hermetic authority-model proof

---
name: Hermetic authority-model proof
description: Requirements for trustworthy in-memory protocol gates before persistent coordination implementation.
---

A hermetic protocol gate must make its fake repository the authority for identity, frozen inputs, execution envelopes, idempotency, claims, evidence, and verification. Caller-provided structures may identify stored records, but cannot define what is authorized.

**Why:** Repeated implementations produced passing tests while allowing fabricated evidence, cross-runtime authority transfer, caller-widened execution envelopes, non-atomic claim/idempotency transitions, or false-positive assertions. Green tests were not sufficient evidence because several test names claimed behavior their assertions never reached.

**How to apply:** Before accepting a coordination protocol core, require transaction-shaped repository operations, server-owned envelopes, authenticated principals, immutable stored chains, exact replay tests for every mutation family, and adversarial tests that assert both the error and the resulting lifecycle/evidence state. Replacement evidence must be created after and explicitly reference the terminal claim it supersedes; model-call limits apply to the proof assignment across replacement packets, never per packet. Review test bodies against their names.


## Gate 3 host isolation

---
name: Gate 3 host isolation
description: Why a normal isolated task-agent copy cannot yet serve as the bounded Gemini execution host.
---

Gate 3 must not treat worktree isolation as process isolation. The execution
host's ambient credentials and capabilities determine which containment claims
are supportable.

**Why:** A model-authored test can access the host filesystem, process
environment, network, or subprocess APIs. This is an operational risk from
bugs, dependencies, and platform authority—not evidence that the Luca hat is
less trusted. David's rule is that authorization comes from the operator and
all hats are one Luca.

**How to apply:** Match the stated proof to the environment. A normal host may
prove operator authorization, provenance, bounded intent, and observed results;
it must not claim adversarial filesystem/network containment. Keep stronger
secret-minimal sandboxing as operational hardening unless the approved gate
explicitly requires that stronger claim.


## Coordinator product opportunity

---
name: Coordinator product opportunity
description: Strategic possibility that the provider-neutral coordinator can become a standalone multi-LLM coding product.
---

The unified coordinator may be valuable as a standalone control plane for
coordinated programming across multiple LLM runtimes. Its product-level value
is durable identity, operator-approved assignments, bounded execution,
canonical evidence, and independent verification across provider hats.

**Why:** The architecture has crossed from deployment-specific infrastructure
into a generally useful coding-community product shape.

**How to apply:** If product exploration is resumed, separate the generic
coordinator, runtime adapters, credential adapters, operator policy/UI, and
evidence model from deployment-specific identity and memory.

The first canonical product document should be hybrid: product vision for
partners and builders, followed by a provider-neutral runtime-onboarding
contract. Generalize genuine-host failures into onboarding requirements rather
than presenting them as provider-specific incidents.

**Why:** David approved this structure on September 11, 2026 after the first
Windows Antigravity onboarding exposed compatibility, dependency, shell-policy,
and evidence-boundary requirements likely to recur with OpenAI and other
providers.

**How to apply:** Keep future provider matrices explicit about evidence
maturity. “Designed” or “supported by architectural intent” must never be
written as implemented, activated, executed, or independently verified.


## Coordinator V2 status

## 1. Two separate founder-authorization systems

The Command Center's "Task ownership" tab (`client/src/components/admin/TaskOwnershipTab.tsx`, `server/services/founder-task-ownership-service.ts`, `server/routes/founder-task-ownership-routes.ts`) is a real, working, deployed founder-approval UI — but it authorizes a separate legacy Gate3 system (challenge → receipt → proof-of-possession → Gate3ProofGrant), whose only live consumer is the older `coordination-runtime-routes.ts` HTTP subsystem. It is NOT wired into the current Coordinator V2 lifecycle (`coordination-v2-cli.ts` → `coordination-v2-http-factory.ts` → `coordination-lifecycle-facade-service.ts`). V2 launch/resume never checks `taskOwnershipReceipts`.

**Why:** `docs/antigravity-gate3-runbook.md` explicitly and repeatedly states the historical Gate3 receipts/grants cannot authorize a V2 session. The codebase still wires `coordination-runtime-antigravity.ts`'s `Gate3Executor` into the V2 factory, but only as a local *operation-execution* adapter, not as an authorization gate. Two systems sharing vocabulary ("Gate3", "challenge", "receipt", "founder approval") are easy to conflate.

**How to apply:** for founder approval of a real Coordinator V2 Windows run, the load-bearing requirements are an approved `coordinationV2PolicyVersions` row plus a valid `coordinationV2OperatorGrants` row with `launch` (`coordination-lifecycle-facade-service.ts`), NOT anything in `taskOwnershipChallenges`/`Receipts`. Don't assume a screen labeled "founder approval" is relevant to a V2 run just because of the label — verify which subsystem it actually calls into first.

Related facts from the same investigation, evidence-checked Sep 18 2026:
- `Register-HolaCoordinatorHost`'s `-FounderApprovalUrl` opens a real, working page — but it's server-rendered HTML directly from `server/routes/coordination-v2-host-admin-routes.ts` (`GET /api/coordination/v2/host-enrollment-requests/:id` returns an HTML form posting to `.../approve`), not a `client/src` React page. Searching `client/src` for it finds nothing; that's expected, not a gap.
- A V2 policy's `hostConstraints.windowsPublicMaterialDigest` is not a hash of any static repo file. It's SHA-256 over a sorted map of `{artifact-name + NUL + raw bytes + NUL}` pairs for exactly two artifacts (the task artifact and a generated `coordinator-config.json`), computed by `coordination-v2-preparation-material-service.ts` and reproduced by `computeCoordinationPublicMaterialDigest` in `coordination-windows-prepare.ts`. It depends on already-materialized runtime data (DB policy + published promotion), so it cannot be hand-computed from repo files alone.
- The lifecycle facade's "production verification" gate requires a `published` row in `coordinationV2SourcePromotions` matching the task's `repositoryIdentity`. Ordinary source-control-scheduler promotion does NOT create this row (see readiness notes below for the normal way to record one).

## 2. Real-run readiness (checked directly against the live database, Sep 18–19 2026)

- **Host enrollment: DONE.** One active `coordination_v2_host_enrollments` row exists — a real Windows machine (LITTLENEMO) enrolled ~Sep 15 2026 via `Register-HolaCoordinatorHost` + founder browser approval. The enroll+prove flow works end-to-end. This is live state, not a code fact — re-query the table rather than assuming it's still true.

- **Source-promotion recording is a real, working, already-in-regular-use mechanism**, not missing infrastructure. It is NOT automatic: a deploy/publish alone only runs the source-control-scheduler's sync, which does not itself record a `coordinationV2SourcePromotions` row. Recording requires a separate, explicit, authenticated admin call (gated by `SOURCE_PROMOTION_TOKEN`) made after the exact commit is actually published (Render release or Replit publish evidence). Don't confuse this live admin-record flow with `server/scripts/coordination-v2-backfill-promotion.ts`, a separate one-time historical-backfill script gated by `COORDINATION_V2_ALLOW_M13_BACKFILL` — that script is not the normal path.

- **Policy authoring** has real founder-session-gated HTTP routes for the full lifecycle: create a draft policy identity+version, founder-approve a version, issue an operator grant. This doesn't need to be built; it needs correct payloads called from an authenticated founder browser session (same pattern as host-enrollment approval).

- **Digest-circularity bug: FIXED Sep 18 2026** (was blocking every launch — zero policy rows had ever existed in the DB before the fix). `hostConstraints.windowsPublicMaterialDigest` used to be embedded verbatim into the canonical policy, which was embedded verbatim into `coordinator-config.json`, which was then hashed together with the task artifact to produce the very `publicMaterialDigest` the field was supposed to equal — a SHA-256 fixed point (D = H(...D...)), cryptographically infeasible by construction. Fix (`coordination-v2-preparation-material-service.ts`, `withoutSelfReferentialDigest()`): the policy view embedded/hashed into `coordinator-config.json` now has `hostConstraints.windowsPublicMaterialDigest` stripped out before canonicalization, so the config's own bytes no longer depend on that field's value. The field is still fully real and enforced, just as a separate pinned comparison at the reserve/prepare call sites. Proven by `server/scripts/test-coordination-v2-authority-seams.test.ts`.

- **Founder digest-discovery tool: now exists.** `server/scripts/coordination-v2-public-material-digest.ts` takes `--task-ref`, `--promoted-commit-sha`, `--exact-tree-sha`, and `--policy <file>` and prints the exact value the server will require, using the same computation as preparation time. Requires a clean git tree and a matching `GITHUB_REPO_URL` (same production task-artifact registry, not a CLI-only restriction). `--help` documents the full compute → author → approve → grant sequence.

- **Task-artifact production resolution: FIXED Sep 19 2026** (was blocking every launch). `FixedRootCoordinationTaskMetadataRegistry` reads `.local/tasks/task-<ref>.md` from local disk; `.local/` is gitignored, so that file never exists on any deployed server's filesystem — every production launch failed task-artifact resolution (`TASK_METADATA_UNSUPPORTED`) regardless of republishing. Fix: a new `PostgresCoordinationTaskMetadataRegistry` (kept out of the DB-free `coordination-task-metadata-service.ts` so the offline digest CLI keeps working without a database connection) is now the registry every real production call site uses via an explicit `taskMetadataRegistry` dependency override, wired in `server/routes.ts`. A related pre-existing bug was fixed alongside this: `reserveCoordinationLifecyclePreparation` (the host-lifecycle reservation path) silently ignored a `taskMetadataRegistry` override and always used the DB-free default.

- **Remaining real step:** the Postgres task-metadata table only has rows for tasks explicitly published into it, via the existing `coordination-v2-publish-task-artifact.ts` CLI (unchanged) run from a workspace with the real `.local/tasks/task-<ref>.md` file and a clean, matching git tree. This is a real per-task, one-time, post-merge operator action, not something a code change can automate away — the artifact's authenticity is tied to an authorized workspace producing it under clean git provenance.

**How to apply:** the digest field and task-metadata resolution are both safe to use in a real policy/run now. Calling the founder-session-gated HTTP routes to actually create/approve/grant the policy, and publishing the task artifact via the CLI, are the remaining real steps — the supporting infrastructure was already built, it just needed these two blocking bugs fixed and the correct payload values.

## 3. Host completion vs. session completion are different states

The host-transport lifecycle used by both `runCoordinationWindowsHost` and the interactive CLI (`server/scripts/coordination-v2-interactive-cli.ts`) can carry a task through claim -> execute -> submit-result, but `submit-result` only ever moves the *attempt* to `result_ready`. It never moves the *session* itself to `succeeded`. Reaching `succeeded` requires two separate session-level transitions in `coordination-session-state.ts` -- `begin_verification` then `accept_completion`.

**Correction (Sep 29 2026):** this section previously claimed "nothing in the codebase calls either one" (as of Sep 27 2026), based on a type-definition-only grep. That was false as stated: both are wired to a real, reachable HTTP endpoint -- `POST /api/coordination/v2/sessions/:id/transitions` (command `begin_verification`) and `POST /api/coordination/v2/sessions/:id/completion` (`coordination-session-routes.ts`, registered via `registerCoordinationSessionRoutes` in `server/routes.ts`). An authenticated external caller genuinely can drive a session to `succeeded` through real, live code -- confirmed directly, both by this route registration and by task 1639's live run actually calling it. See section 4 below for the real, narrower gap this surfaced.

**Why:** the host protocol is deliberately "thin ... not a state-machine authority" (docs/coordination-v2-architecture.md) -- verification/completion is meant to be server- or provider-side reconciliation, out of host scope by design. This is architecture, not a bug to silently patch from a host script.

**How to apply:** never assume a host reaching `submit-result`, or a task going quiet after it, means the session concluded successfully. Check the session's actual `state`, or wait for an explicit terminal signal (a clean `terminalState`, or a `LEASE_SESSION_TERMINAL`-class error on the next host call). Before declaring a code path "never called," grep for real callers including route registrations, not just type definitions and service-layer call sites -- a registered HTTP route counts as a real caller even when nothing internal invokes it automatically.

## 4. No production caller drives a provider turn automatically

Task 1639 proved `CoordinationGeminiAdapter.turn()` genuinely works end to
end against the real Gemini API and shared DB (see
`hat-onboarding-sequencing.md`'s Sep 29 2026 update). Getting that proof
required a one-off script to personally call every lifecycle step, including
`.turn()` itself -- grepping real (non-test) callers of the provider
registry and adapter `.turn()` found it consulted only for
descriptor/provider-selection metadata at attempt creation, never for
actually invoking a turn.

**Why:** this is the direct explanation for why
`coordination_v2_sessions`/`coordination_v2_attempts` had zero rows for any
actor before task 1639 -- the V2 system can create and track sessions/
attempts and select a provider for bookkeeping, but nothing server-side
progresses an attempt through an actual provider turn on its own.

**How to apply:** don't treat "the adapter works" and "a real task can
complete through it unattended" as the same claim -- the second is false for
every provider, not just Gemini, until a real driver (a background worker,
or an extension of the interactive CLI/launcher) is built. Check for that
driver directly (grep for real `.turn()` callers) before assuming any
provider's V2 path can complete a task without a human or script manually
orchestrating each step. A follow-up task covers building it.


## Update (Sep 29 2026): section 4's gap is closed for Gemini

Task 1642 built the production driver section 4 said was missing. `coordination-gemini-provider-driver.ts`, polled by a worker wired into `server/index.ts`, finds any open Gemini attempt and drives it through repeated `.turn()` calls on its own, feeding real host tool results back through the authenticated poll/claim/result transport protocol (no privileged direct-SQL reads of driver-only event metadata), until the attempt reaches a terminal state -- handling every `NormalizedOutcome`, not just `consumed`. Demonstrated live the same way task 1639 was: a real session reached `succeeded` end to end against the real Gemini API and shared DB across real host rounds, with no script calling a provider-side transition directly.

**Why this is worth its own entry, not just a status flip:** two concurrency/crash-safety hazards only surfaced by actually running this repeatedly. (1) `fail` is valid from any non-terminal state by design, so a slower duplicate `turn()` outcome for the same logical turn can silently clobber an already-recorded success unless the caller re-checks the attempt's current state immediately before applying its outcome. (2) A "retry with a fresh attempt" failure decision can turn out to be structurally impossible after the attempt already reached its own terminal `fail` (budget exhausted, no fallback provider) -- when that happens the session, not just the attempt, must also be failed, or it is left orphaned in a non-terminal state forever with no attempt left to progress it.

**How to apply:** don't assume this closes the gap for every provider -- this driver is Gemini-specific (it constructs its own packet and owns its own worker loop), not a provider-agnostic driver loop. OpenAI's adapter (task 1447) will still hit the exact gap described above until it gets its own driver+worker built the same way.


## Coordination V2 standalone-CLI testing

---
name: Coordination V2 standalone-CLI testing patterns
description: how to prove a CLI has zero live-database import, and a canonicalization gotcha when testing hash equivalence for coordination policies.
---

**No-DB-import proof:** grepping for `../db` imports across a CLI's transitive closure is
necessary but not sufficient on its own — pair it with a live subprocess smoke test that
strips `NEON_SHARED_DATABASE_URL`, `CI_DATABASE_URL`, and `CI` from the child env before
spawning `npx tsx <cli>.ts`. `server/db.ts` only tolerates a missing
`NEON_SHARED_DATABASE_URL` when `getVerifiedCiDatabaseUrl()` (`server/ci-database.ts`)
supplies a fallback, and that function itself requires both `CI_DATABASE_URL` and
`CI==='true'` to activate — so stripping those three vars reliably forces the real failure
mode if anything in the graph transitively imports the live DB pool.

**Canonicalization key-presence gotcha:** in `coordination-policy-canonicalization.ts`,
`canonicalizeValue`/`canonicalJson` do not drop empty-object keys. A policy field entirely
absent (e.g. no `hostConstraints` key at all) canonicalizes to different bytes than the
same field present as `{}`. When writing an equivalence test for hashed/canonical policy
objects (e.g. proving a stripped field doesn't change the hash), keep the object *shape*
identical across cases and vary only the field's *value* — omitting the key entirely
produces a genuinely different document, not an equivalent one.

**Why:** both were hit writing regression tests for a founder-facing digest CLI
(`server/scripts/coordination-v2-public-material-digest.ts`); the second one produced a
real, confusing test failure before the cause was clear.


## Antigravity MCP integration surface

---
name: Antigravity MCP integration surface
description: What Google Antigravity actually supports for remote MCP servers, and the real HolaHola implementation status behind the design-doc pile.
---

**External capability (confirmed via Antigravity's own docs, Sep 2026):**
Antigravity IDE/CLI/SDK share one MCP config (`~/.gemini/config/mcp_config.json`
as of the 2.x line — one entry, every surface picks it up). It supports remote
MCP servers reached over HTTP, authenticated via a plain bearer token in the
`headers` block (`"Authorization": "Bearer <token>"`). It does **not** support
the MCP OAuth spec — bearer-token-in-headers is the only remote-auth path, not
a fallback.

**Implication for HolaHola:** exposing the coordination API to Antigravity
means writing an actual MCP-server adapter (tools/list + tools/call over the
MCP protocol, e.g. via `@modelcontextprotocol/sdk`) that internally calls the
existing `server/services/coordination-v2-*.ts` logic — pointing Antigravity's
config at a raw REST endpoint does not work, MCP is its own protocol layer.
The adapter itself is thin (reuses existing auth/validation); the new work is
the protocol shim, not the underlying operations.

**Codebase reality check (verified via explore subagent, not just doc titles):**
the `docs/superpowers/specs/*antigravity*`, `*gate3*`, and `*coordinator-v2*`
design docs are not vaporware — `server/routes.ts` really registers Gate3 and
Coordinator V2 routes, `server/scripts/coordination-runtime-antigravity.ts` is
a real driver (not test scaffolding) with an executable `main()`, and services/
repositories exist for both. The genuine gaps are narrower than the doc pile
suggests: Windows credential handling (DPAPI) is explicitly marked
design-approved-but-unimplemented in its own spec, and no persistent live
Antigravity connection exists yet — the driver is real but nothing has
actually invoked it against a running Antigravity host. Don't infer
implementation status from the number or names of design docs in
`docs/superpowers/specs/` — many are legitimately still proposals; check the
route registration and service files directly.


## Coordination verifier auth is profile-free by design

## Rule

Standing coordination verifiers (`luca-replit`, `luca-claude-code`) must authenticate to HTTP routes using only their broker credential — never a `CodingRuntimeProfile` row.

**Why:** `CodingRuntimeProfile` (provider/model/adapterVersion/worktree fields) models a coding executor's environment (e.g. `luca-gemini`). Verifiers don't execute code, so forcing them through the same profile lookup either fails outright (no profile exists) or requires fabricating a fake executor profile just to pass an irrelevant check — exactly the anti-pattern found and removed in the task that added HTTP verifier auth. Verifier eligibility is a different concept entirely: an actor allowlist (`luca-replit`/`luca-claude-code` only) plus a `standingVerifier` boolean on the credential/registration, both enforced unconditionally inside `CoordinationRuntimeService.verify()` (`verifier_not_allowed`, `verifier_registration_not_standing`).

**How to apply:** when adding a new route or principal type that isn't a coding executor, resolve its principal directly from the broker credential (see `authenticatedVerifier()` in `server/routes/coordination-runtime-routes.ts`) instead of reusing the executor `authenticated()` helper. Keep actor/capability eligibility checks inside the service layer as the single source of truth, not duplicated at the route's auth layer.


## Coordination-runtime race-guard testing patterns

## Coordination-runtime claim() guard redundancy

---
name: coordination-runtime claim() fresh_consumption_required guard redundancy
description: claim()'s two independent fresh_consumption_required checks overlap for the same-packet-reuse scenario; removing either alone is silently compensated by the other.
---

`claim()` in `server/services/coordination-runtime.ts` enforces `fresh_consumption_required` through two separate checks:

1. Reclaim guard: any packet/receipt that already has *any* prior claim (`priorPacketClaims.length > 0`) is rejected outright.
2. Supersession guard: a replacement packet whose evidence doesn't properly follow the latest terminal claim for the thread (wrong `supersedesClaimId`, or timestamps predating the terminal claim) is rejected.

For the "reclaim the same packet after a violation" scenario (the regression test added for task 1448, "execution envelope violation is recoverable only through a fresh superseding packet"), these two checks fully overlap: removing either one alone still leaves the test passing, because the other independently produces the same `fresh_consumption_required` code. Confirmed by direct mutation testing (task 1501). For this exact reuse case the overlap is structural, not a coincidence of test data — a reused original packet's `createdAt` always predates the terminal claim's `terminalAt`, so the supersession guard's `packet.createdAt < latestPriorClaim.terminalAt` clause is always true when guard 1 is the one that got deleted.

**Why this matters:** a future refactor that deletes *only one* of these two checks would not be caught by any existing test in the repo (verified as of task 1501, Sep 2026). Only removing both together breaks the regression test.

**How to apply:** when touching either guard, don't rely on the existing envelope-violation-recovery test to prove the other guard still matters on its own — it can't distinguish "guard 1 removed" from "guard 1 and 2 both fine." A dedicated test isolating each guard (e.g. a supersession-guard violation using a packet/receipt that was never itself claimed, so guard 1 doesn't fire) would need new fixture construction, not just removing an assertion. See follow-up task proposed under task 1501 (title mentions "both halves of the violated-claim reclaim guard") if it's still open.

## Create-race parity with revise-race

---
name: Create-race parity with revise-race
description: A "create if not exists" path needs the same race protection as an existing CAS-append/revise path, and how to test that without real concurrency.
---

A check-then-insert "create new resource at this destination" branch is exposed to the same lost-race window a CAS-append/revise branch already guards against, even though it looks safe because "nothing exists yet." Two callers can both observe "not found" before either commits.

**Why:** Found in shared-spec's `shareDocument`: the revise branch was already CAS-protected and tested, but the sibling create branch had no guard at all, silently relying on the database's own unique index to reject the second insert — which surfaced as a raw, unclassified 500 instead of the same clean CONFLICT the revise branch gives. The identical pattern exists in the pre-existing `createDocument` method too (flagged as a follow-up, not fixed — out of scope for the task that found it).

**How to apply:**
1. Detect the specific failure by catching the real unique-constraint violation (walk a possible `.cause` chain checking `code === "23505" && constraint === <name>`), the idiom already established by `isCoordinationPreparationUniqueConflict` in `coordination-windows-generation.ts` and ~7 other files. Don't try to prevent the race with an extra application-level pre-check — that only shrinks the window without closing it.
2. Make an in-memory/fake repository throw the SAME low-level shape (`{code, constraint}`) a real Postgres violation carries for this scenario, rather than a nicer domain error. Otherwise the fake short-circuits before the recovery code ever runs, and the recovery path stays untested against the fake backend, only ever exercised in production.
3. To unit-test the recovery path without real concurrency: an in-memory repository that serializes transactions (one lock, one at a time) can never let two calls both observe "not found" the way real DB transactions can under read-committed isolation. Use a thin repository shim wrapping the fake: force its destination-lookup to return "not found" on the first-ever call (simulating the lost race) while a "winner" row is pre-seeded directly into the underlying fake, then force the insert to throw the low-level violation shape. The recovery code's own re-read then naturally sees the real winner.


## Reissue disabled/revoked guard redundancy

---
name: Reissue guard-stage diagnostic pattern
description: reissueCoordinationRuntimeBootstrap's disabled/revoked early-return and its UPDATE WHERE clause enforce the identical condition on a row already locked by SELECT ... FOR UPDATE; a guardStage audit tag is what makes the early-return independently testable, and why the UPDATE-side guard cannot be.
---

`reissueCoordinationRuntimeBootstrap()` in `server/services/coordination-credential-broker.ts` has two guards enforcing "the registration must be enabled and not revoked": an early-return right after the initial `SELECT`, and the `eq(enabled, true) / isNull(revokedAt)` conditions on the bootstrap-hash `UPDATE`'s own `WHERE` clause (defense-in-depth against a revoke racing the reissue). Both read/enforce the same condition on the same row, inside one transaction that already took `SELECT ... FOR UPDATE` on that row before either guard runs -- and the revoke path takes the same row lock (plus a `pg_advisory_xact_lock`) before it can touch the row. Nothing can change `enabled`/`revokedAt` between the two checks: removing either guard ALONE still leaves the other one producing the identical `{ ok: false, reason: 'runtime_disabled_or_revoked' }` outcome.

**Why this matters:** this is the same structural pattern already documented above for `claim()`'s two `fresh_consumption_required` checks -- two guards that read as independent but enforce one condition on one lock-held row. A test that only asserts the return value can't distinguish "guard removed" from "both fine, the sibling covered it." Tagging each guard's audit-failure event with a distinguishing `metadata.guardStage` value (one per guard) turns the early-return guard's removal into an independently observable failure: a test can assert which stage actually fired, not just that some rejection happened. The UPDATE-side guard's own removal still can't be isolated this way: with the early-return guard in place, every reachable test scenario is intercepted before the UPDATE ever runs, so that WHERE clause is provably a no-op as long as the early-return guard exists. It only starts to matter, and only becomes testable, once the early-return guard is ALSO gone (a combined-mutation scenario).

**How to apply:** when adding a second, structurally-redundant guard for defense-in-depth (same condition, same lock-held row, different code location), give each one a distinguishing diagnostic tag in its audit/log output and assert on that tag in the positive-path test. That is what turns "the sibling might be compensating" into an actual independent proof, rather than an assumption. Don't claim a mutation test isolates a guard without checking which guard the failure output actually blames.


## Disable-registration guards: a contrast case (independently isolable, not entangled)

---
name: disableCoordinationRuntimeRegistration guard independence
description: unlike claim() and reissue, disable's four fail-closed guards are NOT structurally entangled -- each is independently provable by mutation testing without a combined scenario.
---

`disableCoordinationRuntimeRegistration()` in `server/services/coordination-credential-broker.ts` has four fail-closed guards (runtime-not-found, already-disabled, active-staged-rotation, live/unexpired/ever-used credential) run in sequence inside one transaction. Confirmed by direct mutation testing (removing each guard's block one at a time against a real database) that all four are independently isolable: removing any single guard changes the outcome of exactly one behavioral test in `server/scripts/test-coordination-credential-rotation.test.ts`, with no other guard silently compensating.

**Why this differs from claim() / reissue:** those entanglement cases (see the other sections in this file) happen when two guards enforce the *same condition* on a row already locked before both checks run, so nothing can change the row between them. Disable's four guards each read *different* tables/conditions (registration existence, registration enabled/revoked flag, a separate rotations-table lookup, a separate credentials-table lookup), and each guard's own behavioral test constructs fixture data that deliberately fails only that one condition while satisfying the other three (e.g. the active-rotation fixture has no credential row at all, so removing the active-rotation guard alone can't be masked by the credential guard). Different data source + deliberately-disjoint fixtures, not a shared lock-held row, is what makes them independent.

**How to apply:** before assuming a multi-guard function needs a combined mutation scenario (the claim()/reissue pattern), check whether the guards actually read the same condition on the same already-locked row. If they read different tables/conditions and the test fixtures are already constructed to isolate one condition at a time, each guard is very likely independently provable -- confirm by actually running each removal against a real database rather than assuming entanglement by default.


## Coordination actor completeness enforcement tiers

Some coordination-actor registries are typed `Record<CoordinationActorId, ...>`
(or `Record<Exclude<CoordinationActorId, 'coordination-system'>, ...>`) --
TypeScript refuses to compile if an actor is missing, so no separate test is
needed. `COORDINATION_TOKEN_ENV_BY_ACTOR` and
`COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR` in
server/middleware/coordination-auth.ts are this kind.

Other registries that are supposed to include every actor are plain
`readonly CoordinationActorId[]` arrays -- TypeScript compiles a short one
without complaint and the app boots fine; the omitted actor just silently
loses access to whatever that array gates. `ALL_COORDINATION_ACTORS` in
server/services/operations-catalog.ts was exactly this: missing
`'luca-gemini'` for an unknown period, found only by deliberately auditing
every actor-id reference in the codebase, not by any test failing.

Fix pattern: a dedicated self-check
(server/scripts/test-coordination-actor-completeness-selfcheck.ts) that
statically parses the array's source text (regex over the slice between the
declaration and its closing `];`) instead of importing the module.
operations-catalog.ts eagerly imports semantic-memory-service
(embeddings/DB machinery); importing it from a guard script would drag that
dependency chain into every CI run for a check unrelated to it. Mirrors the
existing validation-suite CI-parity guard's static-parse approach elsewhere
in the repo.

**Do not generalize this into "every actor-scoped registry must contain
every actor."** Most don't, by design -- CLI recipients, the
standing-verifier list, the observation-bench allowlist, and Gate-3
participation are all legitimately partial (Daniela and David, for example,
have no CLI entry and no observation-bench entry). Add a hard equality guard
only for a registry that is genuinely supposed to be exhaustive; everything
else belongs in a conditional checklist. The full tiered checklist
(compiler-enforced / guard-enforced / conditional-by-capability /
do-not-touch) for onboarding a new actor lives in
docs/coordination-new-actor-onboarding.md.


## Coordination credential-cache coexistence

## Coordination credential-cache coexistence

`CoordinationActorClient` (server/services/coordination-actor-client.ts) now has two independent, coexisting credential-persistence mechanisms rather than one:

- `credentialCache` (a `CoordinationCredentialCache` with `load`/`save`, scoped by actor+runtimeId) — checked first. Wired only into `server/scripts/coordination-cli.ts` via `FileCoordinationCliCredentialCache`, so a standalone CLI invocation can reuse the previous invocation's still-valid access token instead of needing a fresh bootstrap per command.
- `tokenCachePath` (a single configurable file path, also settable via `COORDINATION_RUNTIME_TOKEN_CACHE_PATH`) — checked second, as a fallback. Generic and opt-in for any `CoordinationActorClient`, including a future long-running server client that wants restart recovery.

Both were added by two different, independently-planned tasks that touched the same file at nearly the same time; the rebase conflict was resolved by keeping both rather than picking one, since they serve different callers (CLI cross-invocation vs. opt-in restart recovery) and neither task's done-criteria required removing the other's mechanism.

**Why this matters:** the main server's long-running clients for alden/daniela/luca-holahola do not currently configure `tokenCachePath` and remain memory-only in practice (confirmed by grep: no usage of `tokenCachePath`/`COORDINATION_RUNTIME_TOKEN_CACHE_PATH` outside coordination-actor-client.ts itself, its test file, and docs). A future task to give those long-running clients restart recovery should configure/extend the existing `tokenCachePath` option rather than inventing a third mechanism.

**How to apply:** before building new coordination-credential persistence, read both mechanisms in coordination-actor-client.ts first — the need may already be half-solved by `tokenCachePath` sitting unused.


## Runtime rotation pairing verification

Two registrations with the identical display name ("Luca [Claude Code] cloud") existed for
actor luca-claude-code: `luca-claude-code-cloud` and `luca-claude-code-cloud-2026-09`,
created about 24 minutes apart -- matching the naming convention
docs/coordination-clients.md itself uses for staged rotation examples (`<id>-2026-09`).

That similarity is not proof of a tracked rotation pair. The newer registration's audit
trail showed a plain `runtime_registered` event, not `rotation_started` -- it was
provisioned as a fresh, standalone registration (via coordination-runtime-bootstrap.ts,
after the older one's exchange kept failing), never through
`coordination-runtime-rotation.ts stage`. Calling `rotation-ready` with the older ID as
`sourceRuntimeId` would have failed: that endpoint only succeeds for the exact
source/replacement pair a `stage` operation actually recorded.

Always query `coordinationCredentialAuditEvents` for both candidate runtime IDs and look
for `rotation_started`/`rotation_ready`/`rotation_completed` before treating name or
timing similarity as evidence of a staged pair.

Separate gap surfaced by the same incident, now closed: a standalone (never-staged)
registration with a dead credential had no CLI action to formally disable it --
reissue/stage/complete/rollback don't cover it. `coordination-runtime-rotation.ts disable
--runtime-id <id>` now fills this gap (server/services/coordination-credential-broker.ts's
`disableCoordinationRuntimeRegistration`). Its guard ordering matters: not-found ->
already-disabled -> **active-staged-rotation membership, checked as either source OR
replacement** -> live/unexpired/ever-used credential. The active-rotation check is not
redundant with the credential check -- a freshly-staged replacement has zero credentials
of its own yet, so only the rotation-membership guard stops an operator from disabling it
out from under an in-flight rotation.


## Task-ownership guard scope gap

---
name: Task-ownership guard scope gap
description: unknown_stop-based infra-mutation guards only gate what they actually, verifiably check; a guard that looks correct in dev can still admit every call (or refuse every call) in production.
---

**The gap:** GitHubSpecPublisher.publish() executes real GitHub REST calls
using a token baked in at construction, with no actor/task identity check in
the call path -- a blocked task holding a constructed publisher (or its bare
token) could still push a branch and open a real PR. CloudflareDnsService had
the same shape of gap earlier and was closed the same way. As of the last
review pass, GitHub publish is NOT yet actually closed in production -- see
the two confirmed defects below before trusting or extending this guard.

**The actor/capability pattern for a portable provider that must stay
host-neutral:** a provider file kept free of host-specific imports (Replit,
task ownership, connectors) still needs gating. Shape: (1) the portable
interface's mutating method takes a context carrying both the caller's scope
(e.g. taskRef) and the caller's already-authenticated actor id, with the
actor id injected by the authenticated service layer -- never accepted from
caller-supplied request data -- so a caller can name a task but can't claim
to *be* a different actor; (2) the concrete provider's config takes a
mandatory, injected `authorizeMutation(context, action)` hook called before
any network call, so construction fails fast without one; (3) the real
policy lives in its own small file importing only generic ownership-guard
primitives, wired in by the host composition layer. This part of the pattern
held up under review.

**Two ways a guard can look correct in dev and still not gate anything in
production -- both missed by full local test/typecheck/CI runs and caught
only by completion code review:**
1. A verifier that proves identity by reading a workspace-relative file path
   (e.g. anything under `.local/`) works in the dev container, and in test
   fixtures that create the same path -- but a gitignored directory is
   absent from any deployed build. A production process hitting that check
   gets a permanent "not found," so the guard fails the same way for every
   call, not just the blocked-task calls it was supposed to distinguish.
   Before trusting a guard, confirm its evidence source is actually present
   in the deployed runtime -- not just in the dev container and its own test
   fixtures, which can both unwittingly recreate a dev-only assumption.
2. A DB row's "active" status can mean "approved," not "fully proven." This
   codebase's task-ownership receipts go `active` the moment a founder
   approves a challenge -- *before* the separate nonce/signature
   proof-of-possession step ever runs -- and nothing links a later
   successful proof back onto the receipt row. Checking only
   `status === 'active'` therefore treats "someone with approval authority
   said yes" as equivalent to "the requester proved they hold the private
   key," which is a different and stronger claim. When a status field is set
   at an earlier lifecycle step than the guarantee you actually need, reading
   that status alone silently drops every later step's guarantee.

**Ruled out (not gaps):** the source-control scheduler's wake-file poller and
Alden's code-review sync are not reachable with a task-held credential, so
they don't need the same gating.


## Gate 3 coding runtime — proven live, verification claim corrected

---
name: Gate 3 coding runtime — proven live
description: Gate 3 of the provider-neutral Gemini coding runtime was executed end-to-end for real (not just designed); practical gotchas for anyone re-running or extending this exact bounded-script pattern.
---

# Gate 3 coding runtime — proven live

Gate 3 (docs/superpowers/specs/2026-09-09-luca-gemini-coding-runtime-design.md +
the 2026-09-10 ownership-bootstrap-repair design) ran end-to-end against the
real shared Postgres database on 2026-09-20: founder Ed25519 handshake
returned `isolated_agent`, luca-gemini authenticated through the credential
broker, claim → execute → complete were recorded as durable rows
(`coordination_runtime_claims/executions/completions`), and a row in
`coordination_runtime_verifications` records verifier_actor='luca-claude-code',
decision='approved' for this task. That part is real and verified directly
against the DB, not just claimed in this file.

**Correction (verified 2026-09-21 after David independently challenged the
claim by asking the actual Luca [Claude Code] agent, who had no record of
it):** the "independent verification" framing above overstated what the DB
row proves. `coordination_runtime_registrations` shows
`luca-gemini-gate3-1448` and `luca-claude-code-gate3-1448` were both minted
57ms apart in the same provisioning step (both display-named "Gate 3 proof —
... (task 1448)"), not issued to two independently-operating long-lived
agent identities. `server/scripts/coordination-runtime-antigravity.ts` (the
real driver used for this run) only performs the executor role and writes a
receipt file; nothing in the committed code shows what process consumed that
receipt and called the verify endpoint as luca-claude-code. The real,
persistent Luca [Claude Code] agent (the one with its own coordination-thread
history in docs/claude-code-to-luca.md) has no memory of being asked to
verify this and confirmed so when asked directly. Conclusion: a valid,
schema-legal "approved" row exists under the luca-claude-code actor label,
but there is no evidence a genuinely separate reasoning process — as opposed
to automation reusing a co-provisioned, task-scoped credential — produced it.
The actor-label check constraint (`coord_runtime_verification_actor_allowed`)
proves the *label* differs from the executor; it does not prove the
*operator* did.

**Why this matters:** prior work in this area (see
credential-rotation-recovery-authority.md, durable-reconnect-lease.md,
hermetic-authority-model-proof.md) established the design and unit-test
fakes. This was the first live run against the real DB with a real founder
approval and real durable claim/execute/complete rows — but the
cross-actor-verification guarantee the design doc describes
(docs/superpowers/specs/2026-09-09-luca-gemini-coding-runtime-design.md
§11: "This separation prevents one execution path from generating and
accepting its own evidence") is not yet actually enforced or proven. Treat
any future "independently verified" claim from a memory file or task
narrative as unverified until you can point to a DB row AND a credential/
process trail showing a genuinely separate actor operated it.

**Named pattern (Luca [Claude Code], 2026-09-21):** this is Goodhart's law
hitting a security control — the actor-distinctness check became the target,
and a setup script satisfied the target (different label) without the
underlying property (independent reasoning process) ever existing. Same
shape as coordinator-reachability-consumption.md's "delivery isn't
consumption" — a receipt/label proving an administrative step happened gets
conflated with proof the substantive step happened. Applies beyond Gate3:
any "separation of duties" check needs to verify the credentials/identities
involved *cannot be co-provisioned or co-held by one process*, not just that
their labels differ at write time.

## Practical gotchas hit while building the one-off proof script

- **gemini-3-flash-preview code generation**: the default/automatic
  `thinkingConfig` combined with a low `maxOutputTokens` (e.g. 2000) can
  silently starve the actual code output — the turn completes but returns
  little or no usable text. Force `thinkingConfig: { thinkingBudget: 0 }` and
  raise `maxOutputTokens` (4096 worked) when the goal is code output, not a
  reasoning transcript.
- **node:test failures via execSync/child_process**: the failure text lands
  on stdout, not stderr. Reading `error.stderr` for diagnostics returns
  nothing useful; read `error.stdout`.
- **Scripts that call `getSharedDb()` directly** (rather than going through
  an HTTP endpoint) can hang indefinitely after their last `console.log` —
  the pooled connection keeps the Node event loop alive even after all
  logical work is done. Any one-off CLI-style script that touches the DB
  pool directly must call `process.exit(0)` explicitly on the success path,
  not just on error paths.

**How to apply:** check these three before trusting a future bounded-runtime
script's silence, hang, or empty-looking model output as a real failure.

## Standing-verifier activation proof and HTTP-route gap (Sep 22 2026)

**Standing-verifier designation is now real for both approved actors (2026-09-22):**
`designateStandingCoordinationVerifier` was exercised live for durable, non-per-task
registrations for both `luca-replit` and `luca-claude-code` (not the task-scoped
`*-gate3-1448` rows). Proof used `CoordinationRuntimeService.verify()` directly against
the one real completion in the database: a `standingVerifier=false` principal was
rejected with `verifier_registration_not_standing` (baseline), then both newly-designated
identities passed that same gate and failed only on later, unrelated, expected checks
(`assigner_verification_denied`, `verification_digest_mismatch`) — proof the flag and the
gate genuinely work end-to-end through the real broker-credential path, not just at the
DB-column level.

**This resolves the open question from the correction above:** the original task-1448
verify() call could never have gone through the real HTTP route
(`POST /api/coordination/runtime/completions/:completionId/verify`) — its `authenticated()`
helper in `coordination-runtime-routes.ts` hardcodes `profile.provider !== 'gemini'` (plus a
fixed model/adapterVersion) as a rejection, and `luca-claude-code-gate3-1448`'s profile has
`provider: 'anthropic'`. Structurally impossible to pass. Whatever produced that original
row must have imported the service directly, same as this proof did. A follow-up exists to
let non-Gemini standing verifiers actually call the real endpoint.

**Constructing a principal for a direct service-layer proof:** `RuntimePrincipal.capabilities`
is a different vocabulary than the registration/broker-credential `capabilities` column
(`coordination:read`/`coordination:write`). `verify()`'s `authorize()` check needs the literal
string `'verify'` in `principal.capabilities`, which in the real HTTP path comes only from a
`coordination_runtime_profiles.capabilities` row (confirmed `luca-claude-code-gate3-1448`'s
profile capabilities were exactly `['verify']`) — a table with no row for either new standing
registration. A bypass script must hand-set `capabilities: ['verify']`; it is not derivable
from `resolveBrokerCredential()`'s return value.

**Legacy execution rows may not have `attestedLocalState` at all:** the postgres repository
reads it from `canonicalPayload?.attestedLocalState ?? <default>`; task 1448's execution row
only ever stored `envelope.patchDigest`, not a top-level `attestedLocalState`, so any replay
attempt sees the default (empty) shape and fails digest comparison regardless of what
patchDigest value is supplied. Harmless here (that completion is already verified once and
the unique index blocks a second verification anyway), but a genuinely new completion created
by newer code should be checked for a real `attestedLocalState` before assuming this digest
check will behave as designed.


## Coordination token secret propagation scope

## Verify real consumers before propagating a new coordination-actor token

A new `COORDINATION_<ACTOR>_TOKEN` secret's real footprint is whatever code
actually reads `process.env.<TOKEN_ENV>` at runtime — not every store a
sibling actor's token happens to live in. Two things commonly get conflated:

- The running server (dev workflow + published deployment) needs the real
  value, because `server/middleware/coordination-auth.ts` compares incoming
  `x-coordination-token` headers against it. Replit syncs a Secret to both
  the dev workspace and the published deployment's environment automatically
  (confirmed via `viewEnvVars` returning true for both `development` and
  `production` scopes) — nothing extra to configure there.
- A GitHub Actions workflow does NOT automatically need the real secret just
  because it runs a test file that imports the auth module. HTTP-level tests
  for a specific actor commonly set
  `process.env.COORDINATION_<ACTOR>_TOKEN = <synthetic-value>` for the
  duration of the test and restore the previous value in `finally` — the
  real secret is never read. Grep the actual workflow YAML for
  `secrets.COORDINATION_` and trace which script/test file it runs before
  assuming a new actor token needs to be added as a GitHub Actions
  repository secret.

**Why:** assuming symmetry with sibling tokens (this project has separate
tokens for david, alden, and multiple luca-* hats) leads to either
needlessly asking the user to duplicate a sensitive credential into GitHub,
or missing a store that genuinely does need it. Verified Sep 26 2026 while
wiring `COORDINATION_DAVID_TOKEN` into founder policy routes plus a CLI
script: only the dev/prod server environments needed it; the one GitHub
workflow touching the same test family (`cross-tool-promote.yml`) neither
runs that test nor references the secret.

**How to apply:** before telling a user a new coordination/actor secret
needs to go "everywhere," grep for the token's env-var name across
`.github/workflows/*.yml` (specifically `secrets.<NAME>`, not just the name
appearing in a comment) and check whether any test touching it fabricates
its own temporary value instead of reading the real one. Also check
`viewEnvVars({ type: "secret", environment })` for `development` and
`production` directly rather than assuming Replit's general auto-sync
applies without verifying the specific key.


## Coordination route DI wiring gaps

A computed `dependencies.xMiddleware ?? realMiddleware` override variable in a route-registration file must be traced to confirm every `app.get/post(...)` registration for that concern actually references the local override variable, not the raw default. It is easy to compute the override correctly, use it in most registrations, and leave one route referencing the real default directly -- the override then silently has no effect for that one route, and only a test that supplies the override and asserts on its *effect* (not just "some 401 happens") will catch it.

**Why:** In coordination-credential-routes.ts, a `coordinationAuth` variable was correctly computed (`dependencies.coordinationAuthMiddleware ?? requireCoordinationAuth`) but the `GET /runtimes` registration referenced `requireCoordinationAuth` directly. A DI-based test that supplied a test-double override and asserted a 200 response on its success path caught this; a test that only checked "unauthenticated requests get 401" would not have.

**How to apply:** When adding or reviewing a route file with one or more `dependencies.xMiddleware ?? real` overrides, grep the file for the real default's name used directly inside `app.get/post/put/delete(...)`. Any hit there, other than the line computing the override itself, means that route bypasses the override.

Separately: to prove the REAL (zero-DI, production) wiring is actually attached to a coordination route in a test -- without standing up session/passport middleware -- send a garbage-but-present `x-coordination-token` header rather than no token at all. A garbage token short-circuits `requireFounderOrCoordinationCapability` and `requireCoordinationAuth` straight into `resolveCoordinationCapability`'s token-validation branch, never the founder-session fallback, and resolves to a clean 401 `{ error: 'Invalid coordination token' }` after a harmless no-match broker-credential lookup (a read-only query against whichever database is ambient -- disposable CI database or real dev/prod Neon -- both safely return no match for a random string). Sending no token at all instead falls through to the founder-session fallback (`isAuthenticated` etc.), which throws in a minimal test harness that lacks real session middleware.


## Task-agent merge-stall recovery patterns

## Unmerged task-agent database drift

---
name: Unmerged task-agent database drift
description: Recovery rule for stalled task merges whose database changes may already be live even though their code is absent.
---

Before reconstructing or replacing a stalled task-agent implementation, inspect the live shared database schema and the migration ledger. Do not assume that an unmerged task left no production footprint.

**Why:** An isolated task remained visibly stuck in its merge state while its lifecycle enum, columns, indexes, and row backfill had already reached the shared development/production database. The corresponding application code was absent from the main checkout. Assuming a clean database led to an initially incompatible migration draft.

**How to apply:** Compare the current schema model with `information_schema`, PostgreSQL enum/index metadata, and `drizzle.__drizzle_migrations`. Adopt the existing live contract when it is coherent, and reconcile it through a reviewed idempotent migration. Never retry a generated migration blindly after a partial or unexplained failure.

## Task-agent merge budget fallback

---
name: Task-agent merge budget fallback
description: How to respond when a completed task-agent change repeatedly cannot merge despite no visible concurrent work.
---

Treat a repeated `MERGE_BUDGET_EXHAUSTED` result as an unavailable delivery
path, not evidence that the underlying fix is optional.

**Why:** Replit documents background-task concurrency but does not document the
merge-budget status or a reliable reset interval. A completed isolated change
can remain unapplied after long waits even when no other task is visibly
running.

**How to apply:** Do not ask the user to keep retrying or judge conflicts. For a
critical fix, inspect the current main workspace, reconstruct the smallest
verified change directly there, and close the task only after focused
validation. Keep the blocked task until the replacement is proven.

## Open-ended scope can diverge, not just overlap

**Generalization — open-ended scope can diverge, not just overlap:** the fallback above assumes a from-scratch reconstruction covers the same ground as the stuck task-agent's real work. That holds for precisely-specified tasks (add this one field, gate this one named check) but not for open-ended/exploratory ones (e.g. "find and gate other live external actions X could still trigger"). In one case, reconstructing an open-ended task from scratch produced a narrow, one-call-site fix; the actual stuck task-agent had already implemented and tested a completely non-overlapping multi-call-site fix touching entirely different files, with no overlap at all. Both independently satisfied the literal task title; neither was wrong; they just didn't cover the same ground. The mismatch only surfaced because the user later pasted the task-agent's own completion summary and it named files absent from the reconstruction's own diff. Before treating a from-scratch reconstruction of an open-ended task as equivalent to "the task is done," check whether the stuck agent's own completion report (or any other visible trace of its actual diff) names the same files; if it names different files, the reconstruction under-covers the task and both sets of changes are likely still needed.


## Stuck-merge task record can be stale bookkeeping, not missing code

## Stuck-merge task record can be stale bookkeeping, not missing code

Before reconstructing a fix for a task stuck in `MERGING` (any `blockedBy`
reason, e.g. `WAITING_FOR_LOCK`), check whether the code is already committed
and passing on main. A stuck task-tracking record does not reliably mean the
implementation is absent.

**Why:** A task showed `MERGING` / `blockedBy: WAITING_FOR_LOCK` for 4+ hours
with nothing else visible in the merge queue holding the lock — indistinguishable
from a genuinely missing implementation if you only look at the task metadata.
But `git log -- <relevant files>` showed a commit whose message matched the
task's own title, already landed on main a day earlier, and re-running the
file's own self-check/regression test against current HEAD passed cleanly.
The platform task record was stale/redundant bookkeeping, not a true signal
that work was missing.

**How to apply:** before reconstructing anything for a stuck-merge task, run
`git log --oneline -- <relevant files>` looking for a commit matching the
task's title or description, and actually execute any existing test/self-check
for that code path against current HEAD. Only reconstruct if that check
genuinely fails or the code is genuinely absent. This is the mirror image of
"Unmerged task-agent database drift" above (DB already live despite code
missing) — check the live artifact (git history + a real test run), never
infer completeness or absence from the task-tracking display state alone.


## A task-agent's verification claim needs checking independently of its merge status

Checking whether a stalled task-agent's fix actually reached main is not the same as checking whether its own reported verification (specific test names, pass/fail counts) is accurate. Both can be wrong independently of whether the underlying source change is correct.

**Why:** A task-agent reported a fix as "complete, verified, and committed on main" with two named previously-failing tests now passing. The commit was never merged (confirmed via `git merge-base --is-ancestor`). Porting the same source diff by hand and running the actual test file it named produced the opposite result: the two tests it claimed now passed instead newly failed, because those tests carried an explicit code comment documenting the pre-fix behavior as the deliberate, intentional contract. Direct investigation showed the source fix was correct and the invariant really was meant to change -- but the test file's assertions and comments had never been updated to match, whether by the task-agent or in whatever it actually verified against. The fix and the test file each needed independent judgment; neither the "committed" claim nor the "tests pass" claim could be trusted at face value, even though the underlying fix turned out to be right.

**How to apply:** After reconstructing a stalled task-agent's fix, re-run the exact tests it named against the real, current test files -- do not assume its reported pass/fail outcome describes a state that still exists (or ever existed as described). If a test fails with a comment explicitly documenting the old behavior as intentional, that is a signal the invariant was deliberately meant to flip (matching the task's own goal), not that the fix is wrong -- update the stale assertion and its comment together, the same way `legacy-ci-contract-flip.md` describes, rather than reverting the fix or leaving the port half-verified.


## Coordinator V2 live-session verification gating

## Coordinator V2 live-session verification gating

A live end-to-end Coordinator V2 host-lifecycle run depends on gates that a coding agent
cannot verify are satisfied just by reading the CLI source or its tests: the real transport
dependency factory is platform-gated (only usable from the actual required host OS, not a
Linux sandbox), and separately requires both an active approved policy and an unexpired
per-task operator grant. Any of these can be absent even when the CLI itself and its host
enrollment are otherwise healthy and fully tested with fakes.

**Why:** these are independent gates checked at different layers (process platform, policy
state, grant state), so "the code and its test suite are correct" and "a real live session can
succeed right now" are different claims. A coding agent working from a sandbox that cannot
satisfy the platform gate can fully verify the former and never the latter.

**How to apply:** before promising or attempting a "real live session" verification for any
Coordinator V2 host-lifecycle task, check the actual current state of the policy/grant/host-
enrollment records directly rather than assuming readiness from the CLI or its docs. If no
active grant or enrolled compatible host exists, that verification step is blocked on a human
founder/operator action, not on anything a coding agent can finish by itself — say so
explicitly rather than treating the sandbox's own fake-dependency test suite as an equivalent
substitute for a real run.


## Coordinator V2 provider-adapter scope

## The rule

## The rule

`server/services/coordination-provider-adapters/` (registry plus per-provider
descriptors like `gemini.ts`) exists only for actors the coordinator drives
autonomously through a stateless network API call — Gemini's
`generateContent` today, OpenAI's API next. It is consumed only by
`coordination-session-service.ts` and `coordination-lifecycle-facade-service.ts`,
the autonomous session/attempt machinery.

A self-driving interactive hat — one that runs its own agent loop and calls
into the coordination system itself, like `luca-claude-code` — never needs an
entry there. `luca-claude-code` has zero footprint anywhere in
`coordination-provider-adapters/` and never will; it drives itself via
`server/scripts/coordination-v2-interactive-cli.ts` at each lifecycle step
(start/poll/claim/renew/submit-result/cleanup/status).

**Why:** this wasn't obvious from the onboarding checklist alone — a new
hat's gap list can carry "no provider adapter" as a requirement copied from a
generic template without checking it against that hat's own architecture.
Antigravity's checklist did exactly that; Alden confirmed the interactive
reading and ruled no adapter was needed (coordination thread
`4672bbaf-63be-47e5-b9a0-6f26478440b8`, Sep 28, 2026).

**How to apply:** before listing "provider adapter" as a gap for any new
hat, check whether it's self-driving/interactive (no adapter — build runtime
glue over the interactive CLI instead) or autonomous/API-driven (adapter is
a real requirement, since the coordinator must be able to call the model
itself). OpenAI is the latter: its provider adapter in task #1447 is a
genuine requirement, not a miscategorization.


## Opening a coordination thread to Alden

## Mechanics

## Mechanics

"Opens a coordination thread to Alden" (the Step -1 endorsement gate in
`docs/coordination-new-actor-onboarding.md`, and any other procedural gate
needing Alden's sign-off) is `server/scripts/coordination-cli.ts create` with
`--recipient alden`, run with `COORDINATION_ACTOR=luca-replit` and
`COORDINATION_API_URL` pointing at a *running* app instance — it's an HTTP
client, not a direct DB write, so the app workflow must be up first. Read the
reply back with `coordination-cli.ts show --id <thread-id>`.

**Why this needs pairing with consult-alden:** creating the thread does not
notify Alden promptly. The create response's delivery block reports
`"state": "not_requested"` / `"No recipient delivery was requested"` —
whatever full-feed observability Alden may eventually have, a freshly created
thread is not pushed to him. Posting the thread alone and waiting risks it
sitting unseen indefinitely.

**How to apply:** immediately after creating the thread, send Alden a short
priority-task nudge (the consult-alden skill's `POST /api/alden/priority-task`)
naming the thread ID and summarizing the ask, and telling him to reply on
that thread. This combines the formal procedural record (the thread) with a
reply that actually arrives in the same session — confirmed working Sep 28,
2026: thread created, nudged, Alden replied on-thread within the same
exchange.


## Newly-live policy fields inherit stale validation gaps

---
name: Newly-live policy fields inherit stale validation gaps
description: When a previously-inert, pre-validated field becomes a real execution target for the first time, its existing validator may not cover the new consumer's actual safety requirement.
---

A shared canonicalizer/validator written before a field had any real consumer encodes only the safety properties someone thought to check at the time — not necessarily the ones a later, different consumer actually needs. Becoming that field's first real consumer (the first code to turn a validated string into an actual `readFileSync`/`execSync` target) makes the stated safety requirement yours to verify directly; "it already passes validation" does not mean it is safe for your specific new use.

**Why:** Coordination V2's policy `paths` field (`coordination-policy-canonicalization.ts`) already rejected `..` traversal, `~` expansion, and null bytes, but not a POSIX-absolute or Windows-drive-letter/UNC path — invisible as a gap while `paths` had zero real consumers, and only became consequential the moment a driver started treating `paths[0]` as a real `readFileSync` target (task #1644, teaching the Gemini coordination adapter to read a session's own approved file/test target instead of one hardcoded fixture).

**How to apply:** before trusting a pre-existing "validated" field for a new, more consequential purpose, re-derive what the validator actually rejects (read the function; don't infer from its name or the field's original purpose) against what your specific new use needs blocked. If the shared validator can't be safely tightened for every other consumer, add the missing check in your own consuming code instead.


## Authority-free terminal transition for orphaned resources

Coordination V2's ordinary transition path (`transitionCoordinationSession`) requires proving the caller holds current, unrevoked operator authority over a session for every command, including `terminate`/`expire`. This is correct for operator-driven transitions, but it means a session whose operator grant was revoked *after* the session was abandoned can never be moved to a terminal state through that path -- the authorization check itself permanently blocks the exact command that would clean it up.

**Why:** a second, narrower write path that shares the same terminal-write logic (state machine reduction, event append, cleanup-obligation creation, cleanup-authority-effect application) but skips the authorization step entirely is safe specifically because it can only ever move a session from a non-terminal state to a terminal one (mirroring what an authorized `expire`/`fail` command already does) -- it never authorizes new work, extends a grant, or resumes a session, so it cannot be misused to grant capability the caller doesn't already lack.

**How to apply:** when a resource's normal authority-gated transition path can end up permanently unreachable because the thing that would grant transition authority is exactly what already went missing (revoked grant, expired lease, crashed owner), don't try to route around it inside the authorized path. Give the terminal write its own authority-independent entry point and call it from a separate, narrowly-scoped path (a timeout sweep, a revocation cascade, etc.) whose own preconditions (staleness threshold, terminal-state check, "only non-terminal to terminal") are the real safety boundary instead of caller identity. A periodic sweep alone only catches an abandoned resource on its next poll -- consider also triggering the same terminal path immediately at the moment authority is revoked, so it doesn't sit stuck until the next cycle.


## Communication enrollment and execution remain separate

Communication enrollment must remain independent of Coordinator V2 execution authorization. Connecting a platform client is not a reason to replace, reset, bypass, or re-pin the approved launcher.

**Why:** Collaboration credentials establish attributed communication; they do not establish an execution lease, approved runtime release, inbox acknowledgement, or completed V2 task. Keeping those facts separate also lets clients communicate about launcher failures without first making the launcher work. Source: conversation_memories `4a9773d8-f532-4c21-b0d7-7f64257f0183` (independent architecture and lifecycle review).

**How to apply:** Extend the client enrollment path for new platforms while preserving V2's existing authority gates. Report invitation, approval, enrollment, authenticated ledger activity, acknowledgement, and execution as separately evidenced facts.

## Credential migrations have per-surface authentication boundaries

Credential migration is specific to each API surface. A credential accepted
by one endpoint is not evidence that a neighboring endpoint supports the same
authentication format or broker path.

**Why:** A valid own-actor runtime credential worked for coordination but was
rejected by shared-spec. An `actor:secret` example came from a different,
unused adapter; the active endpoint accepted the existing own credential
without that prefix. The failures did not establish an expired credential or
justify resetting or re-enabling credentials.

**How to apply:** Identify the authenticator actually mounted for the failing
endpoint and use only its supported own-actor path. Confirm non-mutating access
before claiming or deciding a review. Never try another actor, rewrite the
review directly in the database, or reverse a credential retirement to resolve
an endpoint-format mismatch. Treat broker migration of other API surfaces as
a separate reviewed authentication change.

