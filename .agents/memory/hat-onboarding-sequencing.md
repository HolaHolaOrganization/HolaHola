---
name: Hat onboarding sequencing — Antigravity before OpenAI
description: David's decision to bring on Antigravity and OpenAI as live coordination hats in succession, not parallel, and where the full per-hat gap detail lives.
---


## The decision and where the detail lives

## The decision and where the detail lives

David decided (Sep 26, 2026) to bring on Antigravity and OpenAI as live
Coordinator V2 hats in succession rather than in parallel: Antigravity first,
OpenAI immediately after. Neither was ready as of that date — a fresh
investigation (not a recitation of past claims, since a prior "Gate 3 proven
live" claim had already been found false on 2026-09-21) found real gaps for
each: no live V2 provider adapter for either, no Alden Step-1 endorsement
opened for either, OpenAI not yet even a registered coordination actor, and
Antigravity's real-Windows verification via LITTLENEMO still incomplete.

**Update (Sep 28, 2026):** Antigravity's Step-1 endorsement is done — Alden
posted an explicit endorsement as a `comment` event on the coordination
thread (see the mechanics block below). He flagged that the Tier 1 secret had
already been provisioned before the endorsement request went out, a real
deviation from the design's intended order, but endorsed anyway given clear
intent and technical readiness. Two items remain for Antigravity: no live V2
provider adapter yet (Gemini is still the only hat with one), and
real-Windows verification via LITTLENEMO hasn't completed.

**Why:** onboarding a new hat is real engineering work (a provider adapter,
real-host verification) plus a procedural gate (Alden's Step-1 endorsement),
not a configuration flag — doing two at once would make it harder to tell
which hat a given failure belongs to, and Antigravity's work was already
further along.

**How to apply:** don't start OpenAI's Step-1 endorsement thread or push its
onboarding to completion until Antigravity's remaining two items close. For
OpenAI, provision its Tier 1 secret only after opening its endorsement
thread, not before — Antigravity did it in the wrong order and Alden noticed.
Don't assume "provider adapter" is automatically part of that bar — see the
coordination-v2-provider-adapter-scope topic file for why Antigravity never
needed one. `docs/coordination-new-actor-onboarding.md` was fully rewritten
Sep 24, 2026 into a generic Tier 1/Tier 3 static-analysis checklist and no
longer has a "Current onboarding queue" section or any per-hat gap tracking —
treat that doc as structural/procedural reference only, not a live-status
source. The live per-hat gap detail instead lives in
`docs/batch-doc-updates.md` and `docs/alden-agent-handoff.md`'s Sep 26, 2026
entries (historical record, not updated in place) plus this memory file.


## Mechanics: opening a Step-1 endorsement thread and actually getting a reply

Opening the thread and getting Alden to answer are two separate actions —
nothing watches the feed automatically, so a thread that just sits there
never gets endorsed.

1. Open it as a real Coordination V2 thread, not a chat message:
   `COORDINATION_ACTOR=luca-replit npx tsx server/scripts/coordination-cli.ts
   create --url http://localhost:5000 --recipient alden --title "..."
   --description "..." --priority high --idempotency-key "..."`. Describe
   what the hat is and what it needs to do, per
   docs/alden-steward-role-design.md section 3.3.
2. Separately prompt Alden to go read it — a consult-alden priority-task call
   naming the exact thread id works. His endorsement needs to land as a
   `comment` event on that thread (recipient-facing reply), not
   `steward_comment` (that event type is only for Alden interjecting on
   threads where he isn't the primary recipient).
3. Verify the reply actually landed on the ledger — don't trust the chat
   response alone: `COORDINATION_ACTOR=luca-replit npx tsx
   server/scripts/coordination-cli.ts show --url http://localhost:5000 --id
   <thread-id>` and check for an `alden`-authored `comment` event.

**Why:** the design doc (section 3.3) only specifies the gate's intent
("opens a coordination thread... Alden posts an explicit endorsement
reply"), not the mechanism — there was no working precedent to copy when
Antigravity's thread was opened Sep 28, 2026. Alden's own tools
(`interject_on_coordination_thread`, `brief_new_actor`) don't run
automatically either; some agent always has to point him at the thread.

**How to apply:** reuse this exact sequence for OpenAI's Step-1 endorsement
thread when that starts.


## Update (Sep 28, 2026): the provider-adapter gap is closed

Task #1636 investigated the "no live Coordinator V2 provider adapter" item
from the Sep 26 entry and found it was the wrong requirement, not just an
unfinished one.

**What the DB actually shows.** `coordination_v2_sessions` and
`coordination_v2_attempts` — the Windows-DPAPI-gated host/session/attempt
system that `coordination-provider-adapters/gemini.ts` feeds — have zero rows
for any actor, ever, including Gemini. Only one host
(`LITTLENEMO`) is enrolled in `coordination_v2_host_enrollments`. That system
has never carried real work for anyone. Meanwhile `coordination_events` (the
ledger behind `coordination-cli.ts` / `coordination-actor-client.ts`) shows
heavy real usage by `luca-claude-code` and `luca-replit` — creates, accepts,
progress, evidence, completions, comments. "The same lifecycle other hats
use" means the ledger, not the V2 host system.

**What this confirms.** The `coordination-v2-provider-adapter-scope` topic's
rule already predicted this: Antigravity is a self-driving interactive hat
like `luca-claude-code`, not an autonomous API-driven one like Gemini, so it
never needed an entry in `coordination-provider-adapters/`. Alden's ruling on
this (thread `4672bbaf-63be-47e5-b9a0-6f26478440b8`) is the primary source;
this update adds the DB evidence that makes it conclusive.

**What was actually fixed.** `server/middleware/coordination-auth.ts`
(token env, legacy capabilities), `coordination-actor-client.ts`'s
`CoordinationClientActor` type/`assertAllowed`, and
`coordination-ledger-service.ts`'s participant/lifecycle checks already
supported `luca-antigravity` fully — zero changes needed. The only gap was
two hardcoded client-side allowlists in `server/scripts/coordination-cli.ts`
(`supportedActors` in `main()`, `supportedRecipients` in
`requiredRecipient()`) that didn't yet list `luca-antigravity`. Adding it to
both is the entire code change.

**Proof.** Ran a real thread through the full lifecycle on the live server
with the real `COORDINATION_LUCA_ANTIGRAVITY_TOKEN`: created by
`luca-replit` → accepted, progressed, evidence-attached, and completed by
`luca-antigravity` → outcome acknowledged by `luca-replit`. No mocks, no
simulated calls.

**What's still open.** Real-Windows verification through LITTLENEMO (tasks
#1482, #1483) — unaffected by this fix and unrelated to it, since that
verification target was always the separate host-enrollment/DPAPI path, not
the ledger. Once that closes, Antigravity's onboarding is fully done and
OpenAI's Step-1 thread can open per the sequencing rule above.


## Update (Sep 29, 2026): Gemini's V2 adapter proven live end-to-end

Task 1639 checked whether "Gemini is the only hat with a working V2 adapter"
(the comparison point used throughout this file) had ever been exercised
against real usage, not just checked against code existing --
`coordination_v2_sessions`/`coordination_v2_attempts` had zero rows for any
actor before this. A one-off script
(`server/scripts/verify-gemini-v2-adapter-live.ts`, not wired into CI) drove
real sessions through the actual production call sequence against the live
shared database and the real Gemini API -- no mocks.

**What held up.** The adapter itself works: real `gemini-3-flash-preview`
calls genuinely request tool calls, real host execution and result
submission complete, and the full session/attempt/lease/cleanup lifecycle
reaches `succeeded` -- independently confirmed against the DB, not just the
script's own self-check.

**What the first pass got wrong, and the real lesson.** The first version
declared success right after the FIRST provider call, without validating
whether the SECOND (continuation) call actually produced anything usable.
Fixing that validation immediately caught a real failure on a later run: a
continuation turn came back `malformed_function_call` -- proof the gap was
real, not theoretical. Separately, a successful continuation is not always
plain text ready to finish -- it can request ANOTHER real tool call, and the
attempt state machine genuinely supports looping back for exactly that
(`provider_continuation -> provider_resumed -> intent_ready`), up to the
adapter's own 4-turn cap. The corrected script now loops through real rounds
instead of force-completing after one; a fully-looped run exhausted all 4
turns before completing.

**Why:** an adapter reporting success on an intermediate step is not the same
claim as "the task actually finished" -- multi-turn protocols need every
turn checked, and one happy-path run proves less than it looks like it does.

**What this also corrects.** `coordination-v2-consolidated-lessons.md`'s
"Host completion vs. session completion" section claimed (Sep 27 2026) that
"nothing in the codebase calls `begin_verification`/`accept_completion`" --
false as stated: both are wired to a real, reachable HTTP endpoint. See that
topic's corrected section 3, and its section 4, for the real and narrower gap
(no automatic production driver) this uncovered.

**How to apply:** when verifying any provider-adapter path, validate every
turn's outcome, not just the first, and check whether a "successful"
continuation is final or asks for more work before declaring completion.
Real usage now exists in `coordination_v2_sessions`/`coordination_v2_attempts`
from repeated verification runs, including one legitimate non-deterministic
failure left in place as evidence rather than deleted -- don't expect a
single tidy row pair, and re-query current state directly rather than
trusting any specific count written here.


## Update (Sep 29, 2026): a production driver now completes Gemini attempts automatically

Task 1642 closed the gap the block above left open. A production driver (`coordination-gemini-provider-driver.ts`), polled by a worker wired into `server/index.ts`, now finds any open Gemini attempt and drives it through repeated `.turn()` calls on its own -- feeding real host tool results back in through the authenticated poll/claim/result transport protocol, never a privileged direct read of driver-only metadata -- until the attempt reaches a terminal state. It handles every `NormalizedOutcome`, not just `consumed`.

Demonstrated the same way task 1639 was: a real session reached `succeeded` end to end against the real Gemini API and shared DB, across three real host rounds, with the demo script never calling a provider-side transition directly -- only starting the worker.

**Why this took more than wiring `.turn()` into a loop:** two hazards only surfaced by actually running it repeatedly, not by reading the code. `fail` is valid from any non-terminal state by design, so a slower duplicate `turn()` outcome for the same logical turn can silently overwrite an already-recorded success unless the caller re-checks the attempt's current state immediately before applying its outcome. And a "retry with a fresh attempt" decision can turn out to be structurally impossible after the attempt already reached its own terminal `fail` (budget exhausted, no fallback provider) -- when that happens the session itself, not just the attempt, must also be failed, or it is left orphaned in a non-terminal state forever with nothing left to progress it.

**How to apply:** this driver is Gemini-specific, not provider-agnostic -- OpenAI's adapter (task 1447) will hit this identical gap on its own until it gets its own driver+worker built the same way. See `coordination-v2-consolidated-lessons.md` section 4 for the fuller technical detail.


## Update (Sep 30, 2026): the interactive-CLI path is a third, still-untouched path — real LITTLENEMO has zero V2 sessions

Task #1614 ("confirm a real Antigravity run can finish one coordination task
using only the new [interactive-CLI] commands") checked whether prior proof
already covered this. It doesn't — `server/scripts/coordination-v2-interactive-cli.ts`'s
seven subcommands (start/poll/claim/renew/submit-result/cleanup/status) are a
third, distinct path from both of the previous two: the ledger (#1636,
proven) and Gemini's V2 host/session/attempt autonomous adapter+driver
(#1639/#1642, proven). The interactive CLI drives the *same* V2
host/session/attempt system as Gemini's adapter, but through a human/IDE-agent
manually running commands rather than an autonomous API loop — and it has
never been exercised by anyone, for any actor, real or synthetic.

**What a direct DB query found (Sep 30, 2026):** every `coordination_v2_sessions`
row that has ever existed (16 total, all from #1639/#1642 verification
scripts) was bound to a disposable per-test-run host created just for that
script (`task-1639-gemini-live-<ts>-<hash>-host`, etc.), never to the one real
enrolled host, LITTLENEMO (`b28c5081-1a1d-4390-a720-36be0ce71cb7`). Zero
sessions, zero attempts, ever bound to the real host. Every
`coordination_v2_operator_grants` row ever issued is now revoked/expired (all
were single-test-run fixtures); there is currently no live founder-approved
policy + operator grant combination at all, for any actor.

**Why:** the host-credential reauthorization (separate work, same day) only
satisfies one of the interactive-CLI's documented prerequisites (a
DPAPI-protected credential for the host). It does not create a policy, grant,
or task-artifact-bound session — those are independent gates and none
currently exist for a real LITTLENEMO run.

**How to apply:** don't treat "the host credential works" or "Gemini's V2
adapter is proven" as evidence that #1614 is closer to done — check
`coordination_v2_sessions.enrolled_host_id` against the real host's id
directly before crediting any claim that a V2-system run touched real
hardware. Real "done" for #1614 additionally needs a live policy+grant scoped
to the real host, and Antigravity itself invoking the CLI from Windows
(LITTLENEMO) — the CLI's real dependency factory throws `windows_required`
off win32, and the task's acceptance criteria requires no other agent driving
it, so this cannot be attempted or simulated from the Replit container.


## External Codex scope

The OpenAI runtime extension means an external Codex coding runtime, not an OpenAI model provider running inside HolaHola.

**Why:** The user explicitly selected the external runtime surface and reaffirmed that Antigravity is not fully onboarded yet.

**How to apply:** Follow the existing Antigravity-first sequencing rule before resuming Codex work. Reuse the proven end-to-end onboarding and authority controls; do not treat an MCP connection alone as completed onboarding.


## Standing requirement: Alden-led adaptive onboarding

Every new runtime should receive guided onboarding from Alden: instruction,
project/team orientation, and customization for the LLM/runtime's actual needs.
A fixed checklist or a one-time briefing is not sufficient by itself.

**Why:** On 2026-10-06 the founder explicitly required the system to be as
flexible as possible and asked Alden to walk any newly added runtime through
the process, including whatever customization its LLM/runtime needs.

**How to apply:** Adapt the guidance to verified execution capabilities,
available tools/transports, and the runtime's instruction-loading behavior.
Keep shared identity, authentication, authorization, attribution, and delivery
verification boundaries consistent. Complete an actual addressed-message,
read, and reply exchange rather than declaring onboarding complete from a
registry entry or claimed briefing. This requirement does not authorize
credential issuance, automatic trust/policy changes, or bypassing actor setup.


## Established Windows test host and current-status baseline

LITTLENEMO is an established native Windows testing host, not a new execution environment that the founder needs to choose or invent. Previous tests have been run repeatedly, usually manually through a shell.

**Why:** On 2026-10-06 the founder clarified that he had already run tests on LITTLENEMO several times, normally through the shell, and that repeated fixes had made the current state unclear. His clarification and the request for a consolidated baseline are recorded in coordination event `73d9f17c-2e12-480a-969a-ffa4fddeaa02`; Luca [Claude Code] separately reported native Windows availability in event `87ae3cda-ac56-49c0-9161-cb35f592e169`.

**How to apply:** Coordinate helper/version identification and test-material inventory directly with Luca [Claude Code], instead of asking the founder to assemble technical prerequisites. Separate host readiness, source validation, production publication, installed-helper identity, and actual native test receipts. An available host or a historical successful shell run does not approve new signing, trust/cache changes, transfers, or a new native fixture matrix.


## Ordinary participation is not V2 host onboarding

Ordinary coding-hat participation in HolaHola messaging and shared documents is distinct from Coordinator V2 host enrollment. Do not make V2 Windows recovery, DPAPI custody, signed runtime installation, or a live V2 provider adapter prerequisites for the ordinary participation path.

**Why:** On 2026-10-07 David clarified that Claude Code already codes, coordinates through messaging, and shares documents without special Windows-environment setup, and asked for the same path for Antigravity, Codex, or another tool. Earlier V2-first onboarding sequencing must not be applied to that narrower goal.

**How to apply:** Start with a repository copy, the tool’s project instructions, its own attributed coordination identity/credential, and verification of canonical inbox/message and shared-spec access. Treat V2 execution-host acceptance as a separately requested capability. Do not impersonate Claude Code or reuse its credentials for another hat. The reported working Claude Code baseline is product evidence; it is not proof that another runtime’s credentials or access have already been verified.


## Hosted-runtime readiness before founder setup

Prove the actual hosted runtime can securely enroll and renew before giving the founder App-creation or credential-grant steps. Desktop or generic Linux SDK support does not establish hosted Replit readiness, and platform Secrets are not automatically an SDK-native credential store.

**Why:** During review on 2026-10-17, an onboarding draft assumed the Replit hat could follow the desktop flow and keep its credential in platform Secrets. The inspected host lacked the Secret Service tool required by the SDK’s Linux adapter, and its broker-runtime configuration had not been established. Sending the founder into App creation first would not have produced a usable client.

**How to apply:** Inspect the real host’s approved storage, enrollment and renewal path without reading secret values. Prefer an already-supported path; if none fits, report the capability gap and reconsider the smallest useful proof rather than building a credential subsystem by implication. Keep runtime readiness, App installation and native review-authority proof as separate evidence boundaries.


## Proof-only credentials versus unattended identity

A manually recoverable short-lived credential may be accepted for a bounded native-identity proof without approving it as the permanent unattended identity model. Keep those two approvals separate.

**Why:** The GitHub App proof deliberately reused the existing headless credential path and accepted founder recovery after cold idle expiry rather than building a desktop-store adapter or keepalive service. This kept the proof small; it did not solve continuous identity or remove the founder’s future recovery burden.

**How to apply:** State the proof-only recovery limitation explicitly. Persistent credential files do not extend server-side validity. Before recommending a permanent authority model, separately assess unattended renewal and founder workload; do not transfer a narrow proof concession into routine operations or silently expand permissions, token lifetimes or background services.

