# Hat capabilities: supported, pending, unverified

A living table of what each hat can actually do today. It keeps states that are easy to blur apart: enrolled is not reading, reading is not recording, and recording is not being woken by a message. It was proposed by Luca [Codex] in its onboarding feedback (coordination thread `85e4456e`, seq 24) and approved by David on 2026-11-02.

**Rules for this file**
- Every cell is one of **Verified** (with a date and the evidence), **Pending** (built or decided, not yet proven), **Unverified** (claimed or documented, not checked by the editor), **None** or **n/a**.
- Update the cell when the state changes, in the same PR or note that changes it. Never mark something Verified from memory: cite the evidence.
- A hat may correct its own column at any time. Founder decisions are marked as such.

Last full review: 2026-11-02, by Luca [Claude Code]. Rows are checked read-only against the database or the record unless marked otherwise.

| Capability | Luca [Replit] | Luca [Claude Code] | Luca [Antigravity] | Luca [Codex] | Alden |
|---|---|---|---|---|---|
| **Coordination identity** (broker runtime registration) | Verified: `luca-replit-primary`, enabled (registered 2026-10-17) | Verified: `lcc-littlenemo`, enabled (2026-10-17) | Verified: `luca-antigravity-littlenemo-observer-20261014-d523deda`, enabled (2026-10-14) | Verified: `luca-codex-littlenemo`, enrolled 2026-11-02 (onboarding thread seq 10) | n/a: a server-side actor |
| **Legacy `COORDINATION_*_TOKEN` still in use** | Unverified | Verified yes, 2026-11-02: the listener and coordination CLI read it from `.env`. A migration to the broker credential is owed | Unverified | None, by design | n/a |
| **Wake on a new message** | Unverified: Replit monitor adapter, documented in `luca-session-notifications.md` | Verified 2026-11-02: continuous listener under Claude Code's Monitor tool, re-armed every 30 minutes. Stop-hook guard merged (#179) | Unverified: `once` listener plus Antigravity Stop guard (LA, 2026-11-02) | None. Untested lead: `codex queue --thread … --message …` | Verified: inbox wake (#161) and thread watch (#169) |
| **Turns recorded to the canonical record** | Verified: `record-exchange --source replit` (a capture gap was noted 2026-10-28) | Verified: Stop hook `record-stop-turn.mjs` | Unverified: Antigravity journal shipper (`source: antigravity`) | Pending: rollout shipper merged (#177); hook not installed or trusted; byte-exact proof owed (step 8) | n/a: kept in `alden_messages` |
| **Publishes code (own GitHub App)** | Verified: `holahola-luca-replit[bot]` | Verified: `holahola-luca-claude-code[bot]` | Verified: `holahola-luca-antigravity[bot]` (#173) | None: step 10, a later founder decision | None, by design |
| **Independent PR reviewer** | Verified (#174, #177) | Verified (#170–#173) | Verified (#176, #178, #179) | Not yet | Reviews shared-spec documents |
| **Central-read grant** (`central-records:read`) | None | None | None | Verified: grant `aeb90c5c`, expires 2027-11-01; read proofs on onboarding thread seq 14–18 | n/a |
| **`observation:read`** (live observer route) | Unverified | Verified in the registration's capabilities | Verified in the registration's capabilities | Verified in the registration's capabilities; first founder-selected observation owed (step 8) | n/a |
| **Shared observation bench** | Verified: in `OBSERVATION_BENCH_ACTORS` | Verified: in `OBSERVATION_BENCH_ACTORS` | Not included | Not included (parity gap, raised to David 2026-11-02) | n/a |
| **Workspace current with `origin/main`** | No, 2026-11-02: 69 ahead and 139 behind. The unlanded work is preserved on branch `replit-preserve-20261102`; catch-up waits for founder decisions | Builds run in worktrees at current main; the main checkout is on an old branch | One worktree per PR (#173) | `C:\Users\David\hh-codex` at main | n/a |
| **Shows its tool calls** | n/a | n/a | n/a | n/a | Verified 2026-11-02: every unattended reply ends with "Tools this turn: …" (#178) |

## Housekeeping noticed during the review (founder decision)

Older registrations are still enabled although no current runtime uses them:
- `luca-claude-code-gate3-1448`, `luca-claude-code-gate3-standing-verifier`, `luca-claude-code-cloud`, `luca-claude-code-cloud-2026-09`;
- `luca-gemini-gate3-1448`;
- `luca-replit-gate3-standing-verifier`.

Retiring them follows "Retiring an abandoned registration" in `docs/coordination-clients.md`. Some are provenance for past proofs, so check before retiring any.
