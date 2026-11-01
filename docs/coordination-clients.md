# Coordination clients

## Coordinator V2 operator path

For a founder-approved policy, active operator grant, compatible enrolled host,
and prepared same-user Windows credential, the complete Coordinator V2
lifecycle starts with:

```powershell
Invoke-HolaCoordinator -TaskRef <task reference>
```

`-Policy` may select an already approved policy. `-Format text|json` changes
output only. The operator does not supply or transfer preparation, session,
attempt, lease, claim, challenge, receipt, digest, provider, host, path,
command, or credential identifiers. PostgreSQL creates and reconciles all
authority from the task reference and approved policy.

Founder policy approval is separate from operator launch. Launch cannot approve
or amend policy, expand an operator grant, choose providers, change retry or
fallback order, or broaden the host boundary. Exit `0` requires both session
state `succeeded` and durable cleanup acknowledgement.

Provider/model/adapter, host/lease/holder, repository, and Git provenance are
one execution lineage for Luca. They describe how and where the work ran; they
do not split Luca's identity by provider or runtime.

The current Windows launcher uses DPAPI `CurrentUser`, so its protected local
credential is usable only by the same Windows user who prepared it. It does not
protect against malicious software already running as that user.

All earlier Gate 3 challenges, receipts, windows, claims, digests, grants,
bootstrap exchanges, and acceptance evidence are historical and
non-authorizing for Coordinator V2. Internal identifiers may be inspected in
authorized diagnostics but must never be copied into a launch or manually
transferred between hosts.

Canonical references:

- [Architecture](coordination-v2-architecture.md)
- [Policy](coordination-v2-policy-reference.md)
- [Host protocol](coordination-v2-host-protocol.md)
- [Provider adapters](coordination-v2-provider-adapters.md)
- [Stable diagnostics](coordination-v2-error-codes.md)
- [Recovery](coordination-v2-recovery-runbook.md)
- [Interactive host CLI guide](coordination-v2-interactive-cli-guide.md)


## Coordinator V2 interactive host path

An intelligent host agent that must reason between lifecycle steps instead of
running inside the unattended PowerShell loop — for example Antigravity —
drives the same host lifecycle directly through one subcommand per process:

```
npx tsx server/scripts/coordination-v2-interactive-cli.ts <start|poll|claim|renew|submit-result|cleanup|status> --task-ref <task reference>
```

It calls the exact same `CoordinationWindowsHostDependencies` methods as the
automated path above and adds no new authority — only local state between
invocations and secret redaction on stdout. See the
[interactive host CLI guide](coordination-v2-interactive-cli-guide.md) for the
full start → poll → claim → submit-result → cleanup sequence, the JSON output
contract, how to feed a result on stdin, and how to react to each
`terminalState`.

## Antigravity: headless vs. interactive Coordinator V2 onboarding

An intelligent host agent — Antigravity today, potentially another hat later —
can drive the Coordinator V2 lifecycle two different ways. Both dispatch onto
the exact same protocol methods; they differ only in whether the agent's own
reasoning has to run *between* lifecycle steps, and that difference is also
what makes one of them lower-risk.

### Headless (unattended, lower-risk)

The headless path is the same one-shot command the operator path above
already uses. No new wrapper needs to be built for Antigravity:

```powershell
Invoke-HolaCoordinator -TaskRef <task reference>
```

or, directly:

```bash
npx tsx server/scripts/coordination-v2-cli.ts --task-ref <task reference> --format json
```

Either form runs the entire lifecycle — reserve/prepare/acknowledge, acquire
lease, the poll → claim → execute → submit-result loop, and cleanup — inside
one OS process's single call to `runCoordinationWindowsHost`
(`server/scripts/coordination-windows-host.ts`), then exits with a bounded
status/exit code. `Invoke-HolaCoordinator` (`scripts/hola-coordinator.ps1`) is
already host/actor-generic: `Assert-ExecutionHost` only validates the enrolled
Windows host's approved node/tsx/manifest/signature/git-HEAD before shelling
out to that same command, then forwards safe stdout and a bounded exit code.
None of it is Antigravity-specific, or specific to any other actor — whichever
actor's DPAPI-protected credential is bootstrapped on that host is who the
command acts as.

To trigger this unattended from Antigravity's own headless mode, use `agy -p`
(alias `--print`) or the equivalent SDK call as the *trigger*, not as a
substitute for the command above:

```powershell
agy --print-timeout 120s --output-format json -p "Run exactly this command and report its stdout and exit code verbatim, taking no other action: Invoke-HolaCoordinator -TaskRef <task reference>"
```

Two things matter about that framing:

- **Give it a fixed instruction, not an open-ended one.** A non-interactive
  `agy -p`/`--print` run auto-approves every tool call the model decides to
  make; there is currently no read-only/plan-mode equivalent for it. Prompting
  it to "handle the coordination task" itself would let its own improvised
  tool calls run unattended with no approval gate at all — a far larger write
  surface than the lifecycle's own operation adapter, which is fixed to
  `git_status`, `git_diff`, `run_test`, `read_file`, and `replace_once` against
  one target file (`WindowsHostOperationAdapter` / `Gate3Executor` in
  `server/scripts/coordination-runtime-antigravity.ts`). An instruction to run
  exactly one named command keeps Antigravity's own auto-approved reasoning
  out of the loop entirely; the bounded adapter is the only thing that ever
  touches files.
- **Read the invoked command's own stdout as the result, not `agy`'s free-text
  response.** `--output-format json` wraps the model's answer in its own
  envelope (`status`, `response`, `usage`, …) — the coordination outcome is
  whatever JSON `Invoke-HolaCoordinator` itself printed, which the model is
  only relaying. Verify against Antigravity's current CLI changelog that
  `--print` output reaches a non-TTY consumer (piped or redirected) on the
  installed build before relying on this in production; older builds have
  shipped with that path silently returning empty stdout and exit `0`, which
  is indistinguishable from a real empty success unless the response is also
  checked for non-emptiness.

### Interactive (`coordination-v2-interactive-cli.ts`)

`server/scripts/coordination-v2-interactive-cli.ts` gives the agent's own
reasoning a subcommand per lifecycle step — `start`, `poll`, `claim`, `renew`,
`submit-result`, `cleanup`, `status` — so it can act between an interactive
session's separate turns instead of inside one unattended process. Every
subcommand dispatches onto the exact same `CoordinationWindowsHostDependencies`
methods the headless path calls; it adds no new protocol authority, only local
state persistence between the separate OS processes each subcommand runs as.

That persistence is the concrete cost of the interactive shape. Because each
step is its own process invocation, the lifecycle's bound state — including
the live `sessionToken`, `cleanupSessionToken`, and `cleanupCredentialId` —
has to survive between them. It is written after `start`/`poll`/`claim`/
`renew`/`submit-result` to
`.coordination-v2-interactive-session/<sha-256 of the task reference>.json`
with owner-only (`0600`) permissions, and removed once `cleanup` is
acknowledged (an unacknowledged cleanup rewrites the file with whatever state
came back instead). Only non-secret fields (`sessionId`, `attemptId`,
`leaseId`, `leaseEpoch`) ever reach stdout, from `status` or any other
subcommand — the session file is the only place the real credentials exist
outside server memory, and only for the window between the agent's own
reasoning steps.

### Choosing between them

Headless needs no on-disk session state at all: the whole lifecycle runs
inside one process's memory, and `coordination-windows-host.ts` makes no
filesystem calls, so there is nothing to persist between steps that never
become separate processes. That is the lower-risk default — use it whenever
the work fits the operation adapter's fixed, narrow surface and needs no
judgment call about whether to claim an offered operation or how to satisfy
it.

Reach for the interactive CLI only when the agent's own reasoning genuinely
has to run between steps — deciding whether an offered operation is worth
claiming, or doing work the fixed adapter can't express before
`submit-result`. That need is exactly what forces credentials onto disk
between processes; it is the deliberate cost of letting reasoning happen
between lifecycle steps, not an oversight.

Both paths currently require the Windows launcher's DPAPI-protected credential
(`process.platform === 'win32'` in both CLIs' own entrypoints) and act as
whichever actor is bootstrapped on that enrolled host. See
`docs/coordination-new-actor-onboarding.md` for Antigravity's own broader
onboarding status — a live Coordinator V2 provider adapter and a confirmed
real-Windows launch are tracked separately from what this section documents.

### Antigravity IDE editing, worktree isolation, and review banner

When working interactively as `luca-antigravity` inside the Antigravity IDE:

1. **Use native `edit_file` / `write_file` tools.** No hook or rule asks for
   shell edits instead, and structured tool calls record the cleaner audit
   trail in the Antigravity transcript. The authoritative review surface is
   always the GitHub PR at its exact pushed head, never the IDE's local review
   banner.
2. **One `git worktree` per PR.** Never switch branches inside a single
   checkout (`git checkout -b` / `git switch`). Instead, create a dedicated
   worktree directory per branch off `origin/main` with `git worktree add`, so
   open in-memory editor buffers from an earlier branch can never be flushed
   onto a later branch. Keep worktree paths short and siblings of the main
   repository (e.g., `C:\Users\David\hh-<short-slug>`) to stay well under
   Windows `MAX_PATH`, and never run `npm ci` inside a worktree whose
   `node_modules` is linked to the main checkout.
3. **Leave the "Files With Changes (`Reject all` / `Accept all`)" banner
   alone.** That banner is Antigravity's local cumulative diff view across tool
   calls in the conversation, not an approval gate anyone needs. Neither the
   founder nor the agent needs to click `Accept all` (which can flush stale
   open buffers from earlier branches onto disk) or `Reject all` (which can
   also rewrite files on disk).
4. **Pre-push contamination check.** Before every commit and push, verify that
   `git status` in the PR's worktree is clean apart from the intended files and
   that `git diff --stat origin/main...HEAD` lists only the files belonging to
   that PR.

## Direct coordination ledger clients

The canonical coordination ledger is available to Alden, Daniela, and Luca
[HolaHola] without routing through Luca [Replit]. All three use
`server/services/coordination-actor-client.ts`; operators can invoke the same
client through `server/scripts/coordination-cli.ts`.

Historical Gate 3 trusted Phase B provisioning used one transaction in registration
→ profile → receipt → challenge row order, with full rollback on ownership
failure. Protected executor/verifier mutations acquire the credential advisory
lock and then hold registration → profile → credential → receipt → challenge
→ grant.

The server derives identity only from `x-coordination-token`. The client does
not accept a token argument and does not read `COORDINATION_API_TOKEN`,
`REPLIT_AGENT_TOKEN`, or another actor's credential as a fallback.

## Remote MCP (Model Context Protocol) clients

`POST /api/mcp/coordination` exposes the same coordination ledger operations
above through the open MCP tool-calling standard instead of REST, for any
MCP-speaking client — the Antigravity IDE, an OpenAI Agents/Responses API
remote-MCP connection, Claude Desktop/Code, or a future platform. This is a
protocol adapter over the existing service layer
(`server/services/mcp-coordination-tools.ts` and
`server/routes/mcp-coordination-route.ts`), not a new capability or a new
authorization model; there is nothing platform-specific in it.

Authenticate exactly as any other coordination surface: `Authorization: Bearer
<token>` (preferred) or `x-coordination-token: <token>`, using either a legacy
`COORDINATION_*_TOKEN` or a broker-issued credential for the calling actor —
see "Scoped credential broker" below for how to obtain one. Every valid actor
gets the four tools listed below; a credential without `coordination:write`
still connects and can call the two read tools, but the two write tools
return a tool-level error (`isError: true`), not a transport-level rejection.

The four tools, matching `coordination-actor-client.ts`'s own operations:

| Tool | Purpose |
| --- | --- |
| `create_coordination_thread` | Open a new thread addressed to another actor. |
| `reply_to_coordination_thread` | Append a comment to a thread you participate in. |
| `list_coordination_inbox` | List paged inbox items addressed to you. |
| `get_coordination_thread` | Read a thread's full event history. |

The endpoint runs the MCP SDK's "Streamable HTTP" transport in stateless mode
(one `McpServer` per request, `sessionIdGenerator: undefined`) — coordination
tool calls are plain request/response with no need for server-initiated
pushes, so there is no session state a restart could lose. `GET` and `DELETE`
both return `405`: stateless mode has no standalone SSE stream to open and no
session to end.

Two SDK behaviors any hand-rolled client (i.e. not an official MCP client
SDK) must account for, since they are transport requirements of
`@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`, not something
this route can relax:

- The request must send `Accept: application/json, text/event-stream` —
  **both** values. Sending only `application/json` gets a `406`.
- A successful response comes back SSE-framed
  (`content-type: text/event-stream`, body shaped as `event:
  message\ndata: {...}`) even for a single non-streaming JSON-RPC call. Every
  official MCP client SDK parses this natively; a raw `fetch`/`curl` caller
  must extract the JSON payload from the `data:` line itself, e.g.:

  ```bash
  curl -s -X POST "$COORDINATION_API_URL/api/mcp/coordination" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -H "authorization: Bearer $ACTOR_ACCESS_TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  ```

## Scoped credential broker

**Default cross-runtime vault:** 1Password Secrets Automation. It supports
separate service accounts and vault ACLs, and lets operators revoke one runtime
without exposing the other actors' items. 1Password holds bootstrap credentials;
HolaHola remains the authority for runtime registration, actor binding,
capabilities, and short-lived coordination credentials.

The historical bounded Windows Antigravity Gate 3 path used Windows DPAPI `CurrentUser`
instead because its approved operator does not have 1Password. The fixed-action
launcher in `scripts/antigravity-gate3.ps1` generates the bootstrap internally,
stores only ciphertext outside the repository, and atomically consumes it on
the first bounded launch. This changes the local credential source only; it
does not change broker, actor, capability, founder-approval, or task authority.

Each runtime registration has exactly one immutable actor, one bootstrap hash,
an allowlisted capability set, and a token TTL from 60 to 3,600 seconds
(15 minutes by default). Bootstrap and access-token plaintext are never stored
in PostgreSQL. The broker stores SHA-256 hashes, returns an opaque access token
only in the exchange/renew response, and records registration, issuance,
renewal, expiration, revocation, invalid bootstrap/token use, and insufficient
capability attempts. Source IPs are hashed before audit storage.
Source IP pseudonyms use keyed HMAC when the server-only
`COORDINATION_AUDIT_HMAC_KEY` (at least 32 characters) is configured; without
that key, the broker records the attempt without storing an IP-derived value.
An existing runtime ID cannot be reprovisioned or rebound to another actor.
Bootstrap rotation uses a staged replacement registration so a running process
can finish or renew short-lived work while its replacement proves readiness.
The broker copies the actor, capabilities, and token TTL exactly; callers cannot
use rotation to expand authority.

Broker capabilities are:

- `coordination:read`
- `coordination:write`
- `coordination:inbox:ack`
- `coordination:credential:renew`
- `coordination:credential:revoke`

Actor identity and capabilities always come from the registration and credential
rows. They are never accepted from request JSON. A broker response attributed
to a different actor is rejected by the client, preventing one Luca hat from
silently becoming another.

### Provision a runtime

An operator runs this once from the trusted HolaHola server environment:

```bash
npx tsx server/scripts/coordination-runtime-bootstrap.ts \
  --runtime-id luca-replit-primary \
  --actor luca-replit \
  --display-name "Luca [Replit] primary" \
  --capabilities coordination:read,coordination:write,coordination:inbox:ack,coordination:credential:renew,coordination:credential:revoke
```

The command prints the bootstrap token once. Paste it directly into a new
1Password item in a vault readable by only that runtime's service account, then
clear the terminal scrollback. Never place it in a repository file, shell
profile, shared `.env`, command argument, chat, or coordination message.

### Recovering a stranded bootstrap (in-place reissue)

A bootstrap is consumed forever on its first successful exchange (the exact
exchange and renewal mechanics are explained at the end of the next section).
If a runtime process restarts after that point with no
cached credential -- a crash, a redeploy, a cloud container recycle -- it is
stranded: the original bootstrap will never work again, and there is no other
live credential worth protecting. This is the common recovery case, not a
zero-downtime concern, and it does not need a second runtime ID.

Reissue a fresh bootstrap for the *same* runtime ID from the trusted HolaHola
server environment:

```bash
npx tsx server/scripts/coordination-runtime-rotation.ts reissue \
  --runtime-id luca-claude-code-cloud
```

This overwrites only the registration's bootstrap secret. The runtime ID,
actor, display name, capabilities, and token TTL are unchanged, so nothing
else needs to be reprovisioned, re-approved, or updated at any other caller.
It never reads, revokes, or otherwise touches a credential the runtime already
holds, so a process that is actually still alive and renewing normally keeps
working exactly as before -- reissue is safe to run even when you are not
certain whether the old bootstrap was ever consumed. Store the newly printed
bootstrap in that runtime's existing 1Password item, replacing the old value,
then restart the process. If a suspected-duplicate or compromised process
might still be using the runtime's last issued credential, pair this with a
credential revoke call; reissue by itself does not force anything out.

Every call is audited as `bootstrap_reissued` (or `bootstrap_reissue_failed`
with a `runtime_not_found` or `runtime_disabled_or_revoked` reason), and the
success event records whether a still-valid credential existed at the moment
of reissue, so a later review can distinguish a routine restart recovery from
a reissue performed while the runtime was still live.

Reach for staged rotation instead only when the runtime is still live and its
current credential must keep working without interruption during the
changeover, or when the runtime's identity itself needs to change -- see
below.


### Retiring an abandoned registration

Sometimes a runtime is abandoned outright rather than recovered or rotated --
for example, a registration that kept failing bootstrap exchange and was
replaced by registering a brand new runtime ID from scratch, with the old one
never staged into a formal rotation pair. That old registration has no
supported way back: reissue only replaces its bootstrap secret in place, and
`complete`/`rollback` both require an actual staged
`coordination_runtime_rotations` row naming it, which never existed for a
registration nobody ever staged. Left alone it stays `enabled` forever.

Disable it from the trusted HolaHola server environment:

```bash
npx tsx server/scripts/coordination-runtime-rotation.ts disable \
  --runtime-id luca-claude-code-cloud
```

This sets `enabled = false` and `revokedAt` on the registration, the same
terminal state `complete` leaves a retired source registration in, and revokes
any of its credential rows that are not already revoked. It refuses to run,
returning the given reason instead of touching anything, when:

- the runtime ID does not exist (`runtime_not_found`);
- the registration is already disabled or revoked (`runtime_already_disabled`);
- the registration is currently the source or replacement side of an active
  staged/ready rotation (`runtime_has_active_rotation`) -- disabling either
  half out from under an in-flight rotation would strand it, so finish or roll
  back that rotation first;
- the registration has a credential that is still live (unexpired and not
  revoked) or that was ever actually used to authenticate a request
  (`runtime_has_live_or_used_credential`) -- that is a real in-service runtime,
  not an abandoned one, and must go through `revokeRuntimeCredentials` or a
  full staged rotation instead.

Every call is audited as `runtime_disabled`, or `runtime_disable_failed` with
the specific reason above, so a later review can tell a deliberate retirement
apart from a live runtime that was mistakenly targeted.

### Zero-downtime bootstrap rotation

Use rotation only when the source registration currently holds a valid,
renewable credential that real traffic depends on staying uninterrupted --
that is the specific problem rotation solves.

If the source's bootstrap was already consumed without the client ever
authenticating a request with the resulting credential (for example, an
access token was issued but lost before anything used it), there is nothing
live to protect, and usually no operator action is needed at all: the broker
accepts the exact same bootstrap value again and mints a fresh credential
automatically -- see "Recovering a lost access token" below. Reach for the
in-place reissue command ("Recovering a stranded bootstrap" above) only when
the bootstrap value itself is also gone (never recorded, or recorded
somewhere now unrecoverable); it keeps the same runtime ID and needs no
staging or completion either way. The dead source registration can never be
exchanged past the point something it issued is actually used, and can be
disabled later at leisure with the `disable` command below if you provision a
replacement under a new runtime ID for some other reason; it poses no ongoing
risk beyond its own short-lived, already-orphaned access token expiring on
schedule.

Run rotation only from the trusted HolaHola server environment. The bootstrap
is never passed as a command argument. First stage a new immutable runtime ID:

```bash
npx tsx server/scripts/coordination-runtime-rotation.ts stage \
  --from-runtime-id luca-replit-primary \
  --runtime-id luca-replit-primary-2026-09 \
  --display-name "Luca [Replit] primary — September 2026"
```

Store the one-time output directly in a new 1Password item restricted to the
replacement runtime's service account. During this overlap, both registrations
remain valid. Update the replacement runtime's `COORDINATION_RUNTIME_ID` and
injected bootstrap together and start it. After exchange, the replacement must
call the dedicated broker-authenticated readiness operation with its
short-lived access token:

```bash
curl -X POST "$COORDINATION_API_URL/api/coordination/credentials/rotation-ready" \
  -H "x-coordination-token: $REPLACEMENT_ACCESS_TOKEN" \
  -H "content-type: application/json" \
  --data '{"sourceRuntimeId":"luca-replit-primary"}'
```

Do not put the access token in shell history; the example names an injected
process environment value. Readiness succeeds only for the exact immutable
source/replacement pair recorded by the stage operation. A normal denied or
failed request cannot mark a replacement ready.

After readiness is proven, retire the source:

```bash
npx tsx server/scripts/coordination-runtime-rotation.ts complete \
  --from-runtime-id luca-replit-primary \
  --runtime-id luca-replit-primary-2026-09
```

Completion fails closed until the replacement has an explicit successful
readiness receipt. It then revokes the source registration and every remaining
source credential immediately. Old bootstrap exchange and new credential
admission stop when the completion transaction commits; a request admitted
before that cutover may finish. Remove the old 1Password item only after the
completion audit is visible.

Before completion, rollback revokes only the replacement registration and its
credentials. It leaves the source state unchanged and never re-enables a source
that an emergency revocation already disabled:

```bash
npx tsx server/scripts/coordination-runtime-rotation.ts rollback \
  --from-runtime-id luca-replit-primary \
  --runtime-id luca-replit-primary-2026-09
```

The command reports whether the source remains active. If the source was already
revoked, rollback still closes the staged rotation and revokes the replacement,
so neither runtime in the pair remains active. Do not treat that result as
continuity: stage recovery from another active registration for the same actor.
After completion, revoked registrations are never re-enabled. Recovery creates
another replacement runtime ID from an active registration. Audit events
`rotation_started`, `rotation_ready`, `rotation_completed`, and
`rotation_rolled_back` link the source and replacement IDs without containing
bootstrap plaintext; rejected readiness, completion, and rollback attempts are
audited separately.

Configure only these non-secret/secret values in the runtime:

```text
COORDINATION_API_URL=https://getholahola.com
COORDINATION_ACTOR=luca-replit
COORDINATION_RUNTIME_ID=luca-replit-primary
COORDINATION_RUNTIME_BOOTSTRAP_TOKEN=<injected by that runtime's 1Password service account>
COORDINATION_RUNTIME_TOKEN_CACHE_PATH=<optional -- see "Recovering a lost access token">
```

The actor client exchanges the bootstrap at first use, keeps the access token
in memory, and renews it within 60 seconds of expiration. Renewal rotates the
token; the prior token is revoked. The bootstrap itself is consumed on that
first successful exchange and can never be exchanged again once something it
issued is actually used to authenticate a request. A restart before that
point can still retry the exchange automatically, and a restart after it can
recover without operator involvement too if a token cache is configured --
see "Recovering a lost access token" below for both mechanisms. Reissue in
place for the same runtime ID ("Recovering a stranded bootstrap" above) only
when the bootstrap value itself is unrecoverable; reserve a brand new runtime
ID or a staged rotation for when the runtime's identity itself is changing or
its current credential must keep serving traffic during the changeover.

For the long-running in-process client -- the main HolaHola server's own
`CoordinationActorClient` instances for alden, daniela, and luca-holahola --
none currently configure `COORDINATION_RUNTIME_TOKEN_CACHE_PATH`, so in
practice a restart still has no persisted credential to fall back on today:
the access token lives only in that process's memory, so it needs a new
bootstrap (or a grace re-exchange, while eligible) before it can authenticate
again. Reissue one in place for the same runtime ID ("Recovering a stranded
bootstrap" above); reserve a brand new runtime ID or a staged rotation for
when the runtime's identity itself is changing or its current credential must
keep serving traffic during the changeover.

`server/scripts/coordination-cli.ts` is different: it starts a brand-new OS
process for every invocation, so a memory-only credential would strand it
after exactly one successful command -- an ordinary second CLI action in the
same session, not just a restart, would otherwise need its own bootstrap
reissue. Rather than relying on an operator to configure
`COORDINATION_RUNTIME_TOKEN_CACHE_PATH` by hand for every runtime that might
invoke it, the CLI unconditionally caches its exchanged (or renewed) access
token on local disk via `FileCoordinationCliCredentialCache`
(`server/services/coordination-cli-credential-cache.ts`), scoped to the exact
actor + `COORDINATION_RUNTIME_ID` pair: a hashed filename plus a same-actor,
same-runtime check inside the file, owner-only file and directory permissions,
written under the OS temp directory by default (override with
`COORDINATION_CLI_CREDENTIAL_CACHE_DIR`). The next CLI invocation loads that
cached token instead of exchanging the bootstrap again, subject to the same
short TTL and 60-second renewal window as the in-memory case -- this is a
cross-process cache for the same still-expiring token, not a new long-lived
secret. A cached token already past its expiry is discarded and treated as if
no cache existed, falling through to a fresh bootstrap exchange (and, if the
bootstrap was already consumed, the same in-place reissue recovery above).
This caching is always on for the CLI; the server's own long-running actor
clients keep the memory-only behavior described above unless an operator
separately opts one into `COORDINATION_RUNTIME_TOKEN_CACHE_PATH`.

### Checking runtime status

`coordination-runtime-status.ts` is a read-only surface over
`coordination_runtime_registrations` and `coordination_runtime_rotations`:
which actor/provider/model combination is registered under a given runtime
ID, whether it is enabled, and its rotation lineage (what it replaced, and
what replaced it). It never sets or infers provider/model -- a registration
made without `--provider`/`--model` prints `"unknown"` in text output and
`null` in JSON, distinct from a real value.

```bash
npx tsx server/scripts/coordination-runtime-status.ts --actor luca-replit --json
npx tsx server/scripts/coordination-runtime-status.ts --runtime-id luca-replit-primary --all
```

By default only active (enabled, non-revoked) registrations are shown; `--all`
includes disabled/revoked ones too. `--runtime-id` restricts to one exact
registration regardless of `--actor`.

The HTTP equivalent is:

```text
GET /api/coordination/runtime-status?actor=<actor>&runtimeIds=<id>&runtimeIds=<id>&includeDisabled=true
```

All three query parameters are optional and match the CLI's filters:
`actor` (a known coordination actor id), `runtimeIds` (repeat the parameter
for more than one id -- combined with `actor` as an AND, not an OR), and
`includeDisabled` (`"true"` to include disabled/revoked registrations;
omitted or any other value behaves like the CLI's default of active-only).
Any other query parameter fails closed with `unsupported_query_parameter`.
Requires `coordination:read`, the same capability as the other coordination
read routes (`/api/coordination/threads`, `/api/coordination/operations`).
The response is `{ actor, filter, runtimes }`, where `runtimes` reuses the
CLI's own JSON formatter -- `provider`/`model` are `null` (not omitted) when
never set, and `rotatedFrom`/`rotatedTo` carry the same rotation lineage
fields as the CLI.

### Diagnosing a failed exchange

Check this first: `CoordinationActorClient`'s `exchangeBootstrap()` validates
the configured bootstrap token's shape locally, before any HTTP call. A valid
bootstrap is `cb_` followed by exactly 43 base64url characters (46 characters
total) -- the exact shape `generateCoordinationSecret` in
coordination-credential-broker.ts produces. A value that fails this check
throws immediately with a description of what looks wrong (wrong prefix or
wrong length) instead of reaching the server at all. This is almost always a
bad copy/paste into the runtime's secret store, not a server-side problem,
and costs nothing to fix locally -- it is never a reason to ask an operator
for a reissue. To check by hand, run
`echo -n "$COORDINATION_RUNTIME_BOOTSTRAP_TOKEN" | wc -c` in the runtime's own
environment and compare against 46. Only move on to the codes below once the
token's shape passes locally and the exchange still fails.

`POST /api/coordination/credentials/exchange` returns `401` with a JSON body
`{ "error": "...", "reason": "<code>" }` for every failure, so a runtime
without database access can self-diagnose instead of guessing. The `reason`
codes are:

| `reason` | Meaning | Client action |
| --- | --- | --- |
| `missing_credentials` | The request omitted `runtimeId` or the `x-coordination-bootstrap` header. | Fix the request; this is a client-side bug, not a credential problem. |
| `unknown_runtime` | No registration exists for the given `runtimeId`. | Check the runtime ID for typos, or confirm the runtime was actually provisioned with `coordination-runtime-bootstrap.ts`. |
| `invalid_bootstrap` | A registration exists, but the presented bootstrap does not match its current unconsumed hash, or its capabilities are misconfigured. | Check the bootstrap token you were given; do not blindly retry with the same value. |
| `bootstrap_already_consumed` | The presented bootstrap exactly matches the one already consumed for this runtime. | Do not retry. This runtime already completed its one-time exchange (successfully or not) and any access token from that exchange may be lost -- ask an operator for a new bootstrap: a fresh registration or a staged rotation. |
| `consumed_bootstrap_digest_conflict` | The bootstrap's hash collides with another runtime's already-consumed tombstone. | Rare internal collision; ask an operator to investigate rather than retrying. |

Every code is also the literal value written to the server-side audit log
(`coordinationCredentialAuditEvents.reason`), so operators reading the audit
trail and clients reading the HTTP response share the same vocabulary.
Revealing these codes does not weaken the broker: `bootstrap_already_consumed`
requires cryptographic proof of possessing the exact consumed secret,
`unknown_runtime` only reveals whether a non-secret operator-assigned ID
exists, and the endpoint stays rate-limited to 10 requests/hour per source IP.
`server/services/coordination-actor-client.ts`'s `exchangeBootstrap()` already
includes `reason` in the error it throws.

### Recovering a lost access token

A restart, crash, or a series of one-off command invocations loses whatever
access token lived only in the previous process's memory. A properly
configured client recovers from this on its own, through either or both of:

- **A local token cache.** Set `COORDINATION_RUNTIME_TOKEN_CACHE_PATH` (or pass
  `tokenCachePath` to `createCoordinationActorClient`) to a file path outside
  the repository. The client writes its current broker-issued token there
  (mode `0600`, atomic rename) after every exchange and renewal, and reads it
  back before exchanging a new one. A cache entry is used only when it names
  the same runtime ID and actor and has not expired; anything else -- a
  missing file, unparsable JSON, a mismatched runtime/actor, or a legacy
  static token -- is ignored and falls back to a normal exchange, logging a
  warning but never throwing and never logging the token itself. Treat this
  file with the same handling care as the bootstrap: never in the repository,
  shell history, or logs. This is opt-in and off by default; an unconfigured
  client behaves exactly as before (in-memory only).
- **Grace re-exchange.** Even without a configured cache, the broker itself
  accepts the exact same bootstrap value again -- and mints a genuinely new
  credential -- for as long as nothing it has ever issued for that runtime has
  actually authenticated a request. This covers the specific case that used to
  require a human to re-provision: an exchange succeeds, but the resulting
  token is lost before anything persists or uses it. Grace requires
  reproducing the original bootstrap value byte-for-byte (it is gated on the
  bootstrap's own SHA-256 tombstone hash), so it never grants a caller any
  capability it did not already have by possessing that secret. Each grace
  re-exchange also revokes every not-yet-used credential previously issued for
  that runtime, so a stale copy from an earlier, abandoned process can never
  resurface and authenticate alongside the replacement; the two outcomes are
  serialized against each other so that whichever of "an old credential's
  first use" or "a new grace re-exchange" reaches the broker first is the one
  that wins. It closes permanently, with no time limit otherwise, the moment
  any issued credential authenticates one request; from then on a restart
  depends on a working token cache or a renewal that happened before the
  loss, or otherwise needs the in-place reissue below -- exactly as before
  this recovery path existed.

Neither mechanism helps if the bootstrap value itself was never recorded
anywhere recoverable. That case still needs the in-place reissue command
("Recovering a stranded bootstrap" above), which keeps the same runtime ID
and needs no staging or completion; reserve a fresh
`coordination-runtime-bootstrap.ts` registration under a new runtime ID for
when the runtime's identity itself is changing, or a staged rotation if a
live credential depends on continuity.

### Runtime-specific setup

- **Replit:** create a dedicated 1Password service account/vault for
  `luca-replit-primary`. Inject only its bootstrap item into Replit Secrets.
- **Claude Code:** use a different service account/vault and runtime ID such as
  `luca-claude-code-primary`; inject through the process launcher, not a checked
  in `.env`.
- **Antigravity/Gemini Gate 3 on Windows (historical/retired):** the task-1448
  Gate 3 proof registered under actor `luca-gemini` with runtime IDs such as
  `luca-gemini-antigravity-primary`. Current path is Coordinator V2 — see
  `docs/antigravity-gate3-runbook.md`. Those `luca-gemini-antigravity-*`
  registrations, credentials, and profiles remain live provenance rows in the
  database; never repoint or rename them, and never derive a new one — they
  are immutable history for that specific proof, not a template for the hat
  below.
- **Antigravity (IDE hat):** register the standalone actor `luca-antigravity`
  with its own runtime ID (e.g. `luca-antigravity-primary`) and dedicated
  service account/vault, same pattern as Claude Code. This is the live,
  ongoing attribution surface for the Antigravity IDE — unrelated to the
  historical Gate 3 bullet above, which is bound to `luca-gemini` for good.
- **Future runtimes:** if this is another runtime for an *existing* hat
  (another machine running as `luca-claude-code`, say), just create a new
  registration and service account as above. If it's a genuinely *new* hat
  (a new attributed identity, not covered by any existing
  `CoordinationActorId`), follow
  `docs/coordination-new-actor-onboarding.md` first — adding the actor id
  touches several registries beyond this one, some compiler-enforced, one
  guard-enforced, several conditional on what the hat needs to do.

For emergency revocation, an existing legacy token may call
`POST /api/coordination/credentials/revoke` with `{ "runtimeId": "..." }`.
It can revoke only a registration bound to the same actor. A broker token can
call the same endpoint without a body to revoke itself.

### Incremental migration

Legacy `COORDINATION_*_TOKEN` bindings remain accepted and keep their current
permissions. Migrate one runtime at a time: provision it, configure its two
runtime values, restart it, verify its authenticated actor and inbox, then
remove that runtime's legacy token from its local secret store. Keep the server's
legacy binding until every client for that actor has migrated and rollback is
no longer needed. Never copy a legacy actor token into the new bootstrap field.

## Runtime placement and scope

| Actor | Runtime | Credential | Client actions |
| --- | --- | --- | --- |
| Luca [Replit] | Replit Agent runtime | `COORDINATION_LUCA_REPLIT_TOKEN` | Read his inbox and coordination feed; create and manage participating work; send actor-derived linked replies; atomically close agent-note-origin work with a verified outcome. |
| Luca [Claude Code] | Claude Code runtime | `COORDINATION_LUCA_CLAUDE_CODE_TOKEN` | Read his inbox and coordination feed; create and manage participating work; send actor-derived linked replies; atomically close agent-note-origin work with a verified outcome. |
| Luca [Gemini] | Gemini API/CLI runtime | broker registration (`luca-gemini`) or migration-only `COORDINATION_LUCA_GEMINI_TOKEN` | Read its canonical inbox/feed; create and manage participating work under dedicated attribution. Legacy `agent_notes` linked replies remain Replit/Claude-specific. Also the actor bound to the historical/retired task-1448 Gate 3 Antigravity-on-Windows proof — see the Runtime-specific setup section above. |
| Luca [Antigravity] | Antigravity IDE runtime | `COORDINATION_LUCA_ANTIGRAVITY_TOKEN` | Read its canonical inbox/feed; create and manage participating work under dedicated attribution. Independent of Luca [Gemini] despite both ultimately running a Gemini model — the hat names the IDE, not the model. |
| Luca [HolaHola] | HolaHola server/live-observation runtime | `COORDINATION_LUCA_HOLAHOLA_TOKEN` | Poll and read the full coordination feed; create handoffs; comment; delegate or reassign. He observes and coordinates but does not accept or complete another actor's work. |
| Alden | Alden service/runtime | `COORDINATION_ALDEN_TOKEN` | Poll and read the full coordination feed system-wide; accept, report progress, attach evidence, block, or complete threads he owns; comment on participating threads; interject with a steward_comment on any thread system-wide, even ones he doesn't participate in; reassign work he owns; acknowledge outcomes for threads he originated; brief a new actor on the access it already has. |
| Daniela | Daniela service/runtime | `COORDINATION_DANIELA_TOKEN` | Poll and read participating threads; accept; report progress; attach evidence; block or complete owned work; comment. She cannot originate or reassign operational work. |

The lifecycle service enforces these scopes again on the server. The client
profile is a safe interface, not the security boundary. Normal participant,
owner, origin, sequence, evidence, and state-transition checks still apply.

Luca [HolaHola] and Alden both read the full coordination feed —
`FULL_FEED_READ_ACTORS` in `coordination-ledger-service.ts` — instead of only
threads where they are the origin, intended recipient, or current owner. Luca
[HolaHola] is the coordination observer and delegator. Alden is the steward of
the code (see `docs/alden-steward-role-design.md`): full-feed access gives him
system-wide visibility, but it is read-only observability. It does not let him
accept, complete, or reassign a thread he doesn't already own. His one
write-side exception is `steward_comment`, emitted only through
`interject_on_coordination_thread`, which lets him comment on any thread
without being a participant; every other event type he can emit — `accepted`,
`progress`, `evidence_added`, `blocked`, `completed`, `outcome_acknowledged`,
`reassigned`, plain `comment` — stays exactly as participant-gated as
Daniela's. Daniela receives only threads where she is the origin, intended
recipient, or current owner, with no full-feed access at all.

## CLI operation

Configure the actor in the runtime environment, alongside only that actor's
credential:

> **Approved, pending activation:** The Materialized Unified Agent Inbox
> procedure below becomes the completeness path only once it is active. This
> document does not claim activation or successful smoke testing.

```bash
export COORDINATION_API_URL=https://getholahola.com
export COORDINATION_ACTOR=alden
# COORDINATION_ALDEN_TOKEN is supplied by the runtime's secret store.

npx tsx server/scripts/coordination-cli.ts inbox --limit 50
npx tsx server/scripts/coordination-cli.ts accept \
  --id <thread-id> \
  --expected-sequence <sequence> \
  --idempotency-key <stable-action-key>
```

### Materialized Unified Agent Inbox

Once active, `inbox` and `ack-inbox` are the only completeness path for an
actor's coordination intake. Begin a processing window with `inbox`, process
the materialized entries returned for that authenticated actor, then acknowledge
the completed window with its completed read-window token:

```bash
npx tsx server/scripts/coordination-cli.ts inbox --limit 50
# Process every entry in the returned read window.
npx tsx server/scripts/coordination-cli.ts inbox \
  --token '<window.nextToken>' \
  --limit 50
# Repeat with each returned nextToken until window.complete is true.
npx tsx server/scripts/coordination-cli.ts ack-inbox \
  --window-token <completed-read-window-token>
```

The HTTP equivalent is:

```text
GET /api/coordination/inbox?token=<URL-encoded window.nextToken>&limit=50
```

`token` is the only continuation query parameter. Partial responses include
`window.continuation.queryParameter = "token"` and
`window.continuation.cliOption = "--token"` so clients do not have to guess.
Unknown query parameters fail with `unsupported_query_parameter` rather than
silently starting a different window. Use the final complete page's
`window.token` for acknowledgement; incomplete page tokens cannot be
acknowledged.

Reading and acknowledgement are different operations. Reading makes the window
available but never records completion. `ack-inbox` records completed intake
only for the exact processed window represented by its returned token; the
token is not an arbitrary cursor and must not come from another actor, runtime,
or refresh. Do not acknowledge a partial, unread, failed, or differently
refreshed window. Acknowledgement does not accept work, mutate lifecycle state,
prove recipient reading, or prove action.

Core inbox completeness and overlays are reported separately. A complete core
window may coexist with incomplete linked-state or legacy coverage; report each
dimension exactly as returned and never describe incomplete overlay coverage as
complete. When historical legacy coverage is truncated, use an explicit
`--after` high-water for a bounded new proof and do not advance the actor's
historical cursor merely to simplify the test.

`list` and `show` remain detail and investigation tools. They may inspect a
known thread, sequence, or history, but cannot substitute for `inbox` and do
not establish complete intake. `agent_notes` remains a compatibility surface
only; once the inbox is active, it is not a completeness path.

For a direct reply that is not itself closing coordinated work:

```bash
npx tsx server/scripts/coordination-cli.ts reply-and-verify \
  --id <parent-agent-note-id> \
  --body "The outcome, addressed directly to the original sender." \
  --idempotency-key <stable-reply-key>
```

Use the parent `agent_notes` ID here, not the coordination thread ID.
`reply-and-verify` is the default path whenever another actor should actually
receive the response.

Comments require explicit delivery intent. Recipient-facing comments must pass
`--recipient`:

```bash
npx tsx server/scripts/coordination-cli.ts comment \
  --id <thread-id> \
  --expected-sequence <current-sequence> \
  --content "Question for the intended recipient" \
  --recipient <actor> \
  --idempotency-key <stable-comment-key>
```

Ledger-only comments are deliberately record-only and must pass
`--ledger-only`:

```bash
npx tsx server/scripts/coordination-cli.ts comment \
  --id <thread-id> \
  --expected-sequence <current-sequence> \
  --content "Canonical internal observation" \
  --ledger-only \
  --idempotency-key <stable-comment-key>
```

The CLI prints a separate delivery summary after mutations. Treat `delivered`
as verified recipient inbox storage, `queued` as not yet verified, and
`not_requested` as ledger-only. Do not interpret a successfully recorded
ledger event as proof that a colleague received a message.

For work whose coordination thread has an `agent_note` source reference, close
the direct communication and ledger lifecycle together:

```bash
npx tsx server/scripts/coordination-cli.ts complete-with-linked-outcome \
  --id <thread-id> \
  --expected-sequence <current-sequence> \
  --idempotency-key <stable-completion-key> \
  --content "Canonical completion summary" \
  --evidence '[{"type":"commit","provider":"github","identifier":"<sha>"}]' \
  --causal-parent-event-id <evidence-or-progress-event-id> \
  --reply-body "Direct outcome for the sender of the originating note"
```

Both commands derive sender and recipient from the authenticated actor and
parent note. Callers cannot provide either identity. A successful reply returns
`delivered` only after the exact row is reread from the recipient inbox.

Ordinary `complete` remains valid for threads without an `agent_note` origin.
For note-origin threads it fails with `linked_outcome_required` unless a valid
reciprocal reply already exists. The combined operation is preferred because
it prevalidates completion before delivery and makes retries idempotent.

The shared-database implementation is atomic: a failed completion rolls back
the reply. If a future non-transactional external adapter returns
`delivery_succeeded_completion_pending`, keep the delivered reply, refresh the
thread sequence, and retry with the same idempotency key. This state is not
completion.

Do not pass credentials on the command line or write them into this repository.
Once active, use `ack-inbox` and the completed `inbox` read-window token for
intake acknowledgement; `list`, `show`, and `agent_notes` reads are not
acknowledgement evidence. Mutations replayed after a crash must reuse the same
idempotency key.

Inbox delivery, feed cursor acknowledgement, note acknowledgement, note action,
and coordination outcome acknowledgement are independent evidence. None may be
used to infer another, and this system does not claim a `notified` state.

## Two-runtime Luca smoke protocol

Use this protocol for every smoke test between Luca [Replit] and Luca [Claude
Code]. A previous successful run is not evidence that a new run succeeded.

1. The Replit Agent runtime configures only
   `COORDINATION_LUCA_REPLIT_TOKEN` in its own secret store. The Claude Code
   runtime configures only `COORDINATION_LUCA_CLAUDE_CODE_TOKEN` in its own
   secret store. Neither hat shares, copies, prints, requests, or uses the
   other's credential.
2. Before the first mutation, the initiating runtime names the exact target
   environment, obtains that runtime's current endpoint, verifies a health
   request through that exact endpoint, and sends the literal endpoint to the
   other runtime in a recipient-addressed message. The receiving runtime must
   use that literal URL rather than a remembered or preferred URL. A development
   health check proves nothing about the published production image.
3. If a shared-database migration introduced a fail-closed writer contract,
   verify that the compatible application revision is published before using
   production for the proof. Do not weaken the database guard when an old
   published image fails; align the image and rerun from a fresh bounded window.
3. Each runtime independently calls `inbox --limit 50` as itself and records
   only its own read-window metadata. `show` may investigate an inbox entry,
   but neither `show` nor `list` establishes completeness.
4. Each runtime reads and processes its own complete returned window. Neither
   Luca hat acknowledges, replies, acts, or impersonates the other. A
   recipient-facing comment passes `--recipient`; an internal record passes
   `--ledger-only`.
5. Each runtime calls `ack-inbox` only with the completed read-window token
   returned by its own inbox response. It must not use a fabricated,
   cross-runtime, stale, or partially processed token.
6. The recipient reports the inbox-item IDs for the named coordination events
   and replies with new explicit-recipient events. The initiator independently
   proves those replies appeared in its recipient-wide inbox. Ledger transport,
   adapter delivery, and thread visibility are insufficient.
7. During any long gate, migration, or external wait, the waiting runtime posts
   a recipient-addressed status update before the other actor is left silently
   polling. A status event proves storage and delivery only; LLM consumption
   still requires the recipient's explicit receipt or reply.
8. Record the two runtimes' separate results, including explicit failure or
   pending states. Inbox storage, reading, acknowledgement, and action remain
   separate evidence and must not be inferred from one another.

Database-backed tests against production snapshots must capture recipient
high-waters before inserting fixtures and read only `(after, through]`.
Production activity may continue while the snapshot is created; tests must
never assume a recipient inbox is empty at sequence zero.

## Credential rotation

Rotate one actor at a time:

1. Generate a new random credential of at least 32 characters in the secret
   manager for the ledger server and that actor's runtime only.
2. Replace the actor's dedicated `COORDINATION_*_TOKEN` binding in both places.
   Do not copy it into `COORDINATION_API_TOKEN` or another actor's binding.
3. Restart the ledger server and the one affected actor runtime.
4. Poll the feed with the new credential and confirm the authenticated actor in
   the response.
5. Confirm the previous credential now receives `401`.

If two actor bindings are accidentally set to the same credential, the server
fails all coordination authentication with `503` until the ambiguity is fixed.
This fail-closed behavior prevents cross-actor attribution.

## Shared-spec workspace client

The shared-spec API is a separate, portable PostgreSQL collaboration surface
mounted at `/api/shared-spec` by the host application. Use
`server/scripts/shared-spec-cli.ts` with an explicit API URL and token; do not
put the token in shell history or repository files:

```bash
npx tsx server/scripts/shared-spec-cli.ts list \
  --url https://getholahola.com/api/shared-spec \
  --token "$SHARED_SPEC_TOKEN"
```

The CLI sends `x-shared-spec-token` and sends `idempotency-key` for every
mutation. HolaHola's optional adapter also accepts `x-coordination-token` and
derives the actor from the existing coordination credential; a different host
can supply its own `SharedSpecActorAuthenticator`. Actor identity is never
accepted in request JSON.

For the canonical creation, immutable-revision, independent claim/decision,
publication, and reconciliation procedure, read
`.agents/skills/shared-spec/SKILL.md`. Shared-spec is the default surface for
joint document work. Never impersonate a requested reviewer: the named actor
must claim and decide the exact revision under that actor's own credential.

For fast, unreviewed cross-hat sharing (a note, a memory-file update, a
finding) instead of a full reviewed spec, use the CLI's `share` and `pull`
commands against the separate `notes/` namespace — see "Fast-share notes" in
the same skill file. This is the default path for a hat to share or co-edit a
document with another hat without a git merge; it never goes through review
or GitHub publication.

GitHub publication occurs only after approval and is optional host
configuration, not a core dependency or an alternative review authority.
Configure `SHARED_SPEC_GITHUB_REPOSITORY` (`owner/repository`),
`SHARED_SPEC_GITHUB_TOKEN`, and optionally `SHARED_SPEC_GITHUB_BASE_REF`
(defaults to `main`) in the host secret store. The publisher uses GitHub REST,
creates a deterministic `shared-spec/...` branch and pull request, and never
pushes directly to the base branch.

Current limitations: the bundled CLI covers drafting, review, approval, and
export but not publication operations; the HolaHola adapter has a fixed
`docs/superpowers/specs/` destination namespace for reviewed `design`/
`architecture` documents (fast-share notes use the separate `notes/`
namespace instead, see above); and publication remains unavailable until the
two required GitHub settings are present.
