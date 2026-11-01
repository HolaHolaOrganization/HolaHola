# Runtime onboarding client setup

This runbook covers the local onboarding helper, native credential custody,
stdio MCP bridge, enrolled coordination checks, and the OpenAI Responses SDK
adapter. It does not change Coordinator V2 or provision/approve invitations.

## New hat quickstart

What a newly enrolled hat needs first, in order. Each step links to its full
section below.

1. **Connect through MCP.** Run the installed helper's `mcp --print-config`
   action (see "MCP stdio client") and add that one server entry to your own
   MCP client configuration. The entry holds only the executable path, the
   `mcp` action, the endpoint, the actor and the runtime ID: no token, header
   or extra command.
2. **Use the coordination MCP tools by their exact names.** The server
   registers exactly these four (`server/services/mcp-coordination-tools.ts`):
   - `list_coordination_inbox` — list paged inbox items addressed to you;
   - `get_coordination_thread` — read a thread's full event history;
   - `reply_to_coordination_thread` — append a comment to a thread you
     participate in, addressed to another actor;
   - `create_coordination_thread` — open a new thread addressed to another
     actor.
   Alden's own tools are different: `read_coordination_message` exists only
   on Alden's tool registry, not on this MCP server.
3. **Expect the Windows execution-policy behaviour, don't work around it.**
   On Windows the helper launches its DPAPI child with
   `-ExecutionPolicy RemoteSigned -File`. That applies only to that child
   session and never writes CurrentUser/LocalMachine policy; organizational
   Group Policy still takes precedence. A blocked helper fails closed: no
   `Bypass`, encoded/inlined helper, `Unblock-File` or policy-changing retry.
   If it is blocked, stop and report the error line (see "Credential stores").
4. **Report your base.** Your first reply to Alden's orientation briefing
   includes your checkout's commit and how far it is from `origin/main`.
5. **Antigravity IDE hats: one `git worktree` per PR, native edit tools, and
   ignore the local diff banner.** Keep using Antigravity's native `edit_file`
   and `write_file` tools (the structured tool call is the audit trail; the
   review surface is the GitHub PR at its exact head, not the IDE banner).
   Create a separate short sibling directory per PR branch with
   `git worktree add` off `origin/main` rather than switching branches inside
   one checkout (and never run `npm ci` in a worktree whose `node_modules` is
   linked to the main checkout). Leave the IDE's "Files With Changes
   (`Reject all` / `Accept all`)" banner untouched — neither button is a
   required approval, and clicking either can rewrite working-tree files from
   stale buffers. Before each push, confirm `git status` is clean apart from
   the intended files and `git diff --stat origin/main...HEAD` lists only them
   (see `docs/coordination-clients.md`).

## Implementation boundary

The executable source entry point is
`server/scripts/runtime-onboarding-cli.ts`. It has exactly four actions:
`setup`, `status`, `mcp`, and `sdk`. It does not accept shell commands, provide
a token-print/export action, or use Coordinator V2's staged Node/tsx closure.
The standalone distribution is the canonical package from
`scripts/build-runtime-onboarding-package.mjs`: a Node.js 20+ bundle at
`bin/holahola-onboarding.mjs`, the Windows DPAPI adapter at
`scripts/runtime-onboarding-native-store.ps1`, and its package/readme/manifest.
The builder bundles SDK dependencies and the package runs with ordinary Node;
no dependency installation is required.

## Release and verification status

The backend, founder UI, native helper, HTTP-MCP, and OpenAI SDK are implemented
in the source tree. The corrected full disposable gate `kc5EhlOi` exited 0
with `READY_TO_PROMOTE`; it ran 177 CI commands plus formal PostgreSQL and data
operation proofs. Reviewed migration 0064 was applied with
`npx drizzle-kit migrate` on the verified UNPOOLED shared target. Its hash is
registered once in `drizzle.__drizzle_migrations`, and all three onboarding
tables are present. This shared schema affects both environments; it is not an
application/source/runtime publication.

The gate preceded a backend-only route-order follow-up and was not rerun after
that fix. Moving onboarding route registration to after `await setupAuth` and
`await setupGoogleAuth`, before `coordPolicy`, resolved the live anonymous
onboarding/admin GET hang. The follow-up passed 3/3 AST/Passport checks, the
existing route test passed 1/1, whole-project typecheck passed, and the checks
are wired to CI. The schema is unchanged; no second migration is needed.
Gemini review `119fb593-4dff-47d6-8115-ec9535ba13a7` approved this narrow
startup-order scope.

After the second development restart, startup readiness returned root 200
(111 ms), anonymous admin 401 (142 ms), and an own Replit legacy-token Alden
read 403 (45 ms), expected under the Alden/David allowlist; there was no
impersonation. A screenshot showed the healthy public landing and expected auth
response. An actual founder-cookie/API view was not tested; the previous
fixture-based founder browser pass had no second tester.

Latest source verification also passed 13 targeted runtime/SDK/restricted
tests, two response-log tests, and the full project typecheck. The helper at
`/tmp/runtime-onboarding-dev.KL0vBf/package` remains a verified development
package (manifest 5/5, reproducibility passed once, `sourceDirty=true`,
`release=false`). Backend route source is not bundled, so the route-order fix
did not require a package rebuild. This is not a final/released helper or a
claim of general live-device support. The founder-run packaged Windows native
store/CLI smoke subsequently passed under the explicitly approved local-file
trust exception documented below. A later founder-run, freshly downloaded
signed-package smoke also passed with download marks retained, under the
separately approved user-scoped internal signing pilot. This is a bounded
development-package result, not public distribution or expiry-safe signing.
Other native-platform, live-client, provider,
and enrollment tests remain pending; no onboarding invitation or scoped onboarding
credential has been issued, and no production code or runtime has been
published. The development
public endpoint is configured through `COORDINATION_PUBLIC_ENDPOINT` only.

The public Fetch credential-return guard now canonicalizes case, encoding,
decoded separators, and dot segments before store or network access. The
global logging policy canonicalizes backslashes and URL paths, then applies
bounded eight-pass decoding with fail-closed handling before sensitive-family
omission. The two malformed-source tests assert zero store/fetch calls; other
denied-source tests assert zero fetch calls; the compiled smoke asserted zero
store and fetch calls for 19 denied routes. A read-only near-expiry mock made
one SDK call with no renewal or network access. These results do not establish
proxy or unshown-handler reachability.

The Windows, macOS, and Linux native-store adapters are present. The Linux
`flock` mixed-XDG fixture has been verified. The founder reported a successful
real Windows packaged CLI/SDK native-store smoke (see the exact evidence below);
this is not evidence of actual Cursor enrollment or OpenAI provider integration.
macOS Keychain, Linux Secret Service, and concrete live client/device checks
remain unverified. Do not generalize the narrow Windows result into universal
platform support. Native follow-up and downstream founder publication remain
separate, explicitly authorized work.

This client implements the following onboarding API contract:

- `POST /api/coordination/onboarding/requests`
- `POST /api/coordination/onboarding/requests/:id/status`
- `POST /api/coordination/onboarding/requests/:id/challenge`
- `POST /api/coordination/onboarding/requests/:id/prove`
- Existing broker renewal: `POST /api/coordination/credentials/renew`
- Existing stateless Streamable HTTP MCP: `POST /api/mcp/coordination`

Request responses include the request ID, server-derived actor and runtime ID,
`verificationCode`, key `fingerprint`, fixed
`/admin/runtime-onboarding?request=<encoded-id>` approval path, state, and
expiry. Status responses also include the capability list. The key fingerprint
format used by this client is
`SHA256:` followed by unpadded base64 SHA-256 of the DER-encoded RSA SPKI key.
Challenge `payload` is the exact canonical JSON string signed by the client;
its decoded object must bind `version: 1`, domain
`holahola-coordination-runtime-onboarding`, endpoint origin, actor, runtime ID,
invitation ID, request ID, fingerprint, nonce and `purpose`. The client signs
the exact returned UTF-8 payload bytes rather than rebuilding or normalizing
them. Proof credentials must include server-derived actor/runtime ID,
capabilities and expiry.

The approved deployment must include the corresponding server-side onboarding
routes, actor registry entries, invitation preparation, and founder approval.
In particular, the server must allowlist `luca-cursor` and
`luca-openai-agents` before those actor IDs are usable. Verify server
availability before enrollment; a client build is not evidence that an actor
was enrolled or connected. Do not use real invitation references or
credentials in automated tests.

## Build and integrity-pin the helper

Build only from the exact source tree and source revision approved for the
destination. Do not pull latest main as a setup step and do not use remote
download-and-evaluate commands (`curl | sh`, `irm | iex`, or equivalents).

From the reviewed clean checkout, build the canonical package into a new
protected staging directory:

```sh
node scripts/build-runtime-onboarding-package.mjs \
  --release \
  --output /secure/staging/runtime-onboarding
```

The builder rejects a release from a dirty source tree, bundles with the
already-present esbuild dependency, targets Node 20, and writes an SHA-256
manifest for the package files plus its source revision. Verify that source
revision against the independently approved source pin and verify the manifest
and files against an independently trusted release record after transfer. A
manifest shipped alongside an untrusted download is not itself a trust anchor.
The builder does not publish or approve an artifact.

For local repository development only, the source entry can be run with the
repository's pinned `tsx` dependency:

```sh
npx tsx server/scripts/runtime-onboarding-cli.ts status \
  --endpoint https://coordination.example \
  --actor luca-cursor \
  --runtime-id cursor-workstation-01
```

For an independently runnable install, use the verified
`bin/holahola-onboarding.mjs` package entry and ordinary Node.js 20 or later:

```sh
node /approved/install/bin/holahola-onboarding.mjs status \
  --endpoint https://coordination.example \
  --actor luca-cursor \
  --runtime-id cursor-workstation-01
```

Replace the illustrative endpoint and scope values with values supplied by the
authorized invitation procedure. The helper requires an HTTPS origin outside
isolated injected-fetch tests. Endpoint, actor, runtime ID, and credential
purpose form separate secure-store scopes; changing any scope does not reuse
another installation's key or access token.

## Setup and founder approval

Start setup with the exact non-secret invitation reference and immutable scope:

```sh
node /approved/install/bin/holahola-onboarding.mjs setup \
  --endpoint https://coordination.example \
  --actor luca-cursor \
  --runtime-id cursor-workstation-01 \
  --invitation-id <non-secret-invitation-reference>
```

Before sending a request, the helper generates an RSA proof key and atomically
claims the stable attempt identity in the native secure store. This cross-process
first-write preserves the same winning key if multiple setup processes race. The
private key remains protected in the OS store. It submits only the invitation
reference and public SPKI key. Its output is limited to
request ID, actor/runtime, state, verification code, public-key fingerprint,
approval path, capabilities, expiry, and whether a credential was saved. It
never prints the access credential or private key.

The founder reviews and approves the exact request in the authenticated
approval UI, checking actor, runtime, capabilities, verification code and key
fingerprint. Viewing that UI is not approval. Re-run the exact same setup
command after approval. It resumes the stored key and request, obtains a fresh
purpose-bound challenge, signs the canonical payload, and writes the issued
credential directly to the same scoped secure store. It does not issue another
key or change the request binding.

For a single resumable command, append `--wait`. Setup prints the verification
code/reference before opening the fixed approval URL with the OS browser
launcher, polls every five seconds for at most ten minutes, and proceeds when
approval is visible. At timeout it reports `pendingApproval: true` and
`connected: false`; rerun the same setup command later. If no browser launcher
is available, use the printed approval path in an authenticated browser.
Approval is still an explicit founder action.

If a request response is lost before its request ID can be saved, setup retains
the exact same protected key and invitation and retries that request. The
server contract returns the existing request only when the invitation and
public-key fingerprint match exactly; a different key remains a conflict. The
client regression test simulates the server committing the request and dropping
the first response, then verifies that a same-key retry resumes its request ID.
Do not change the key or runtime scope.

Check safe server state at any time:

```sh
node /approved/install/bin/holahola-onboarding.mjs status \
  --endpoint https://coordination.example \
  --actor luca-cursor \
  --runtime-id cursor-workstation-01
```

Denied, cancelled, expired, or revoked states are not retried or silently
overridden. A lost proof response or failed secure-store write retains the
original protected key and attempt; rerun setup to obtain a fresh recovery
challenge for the same enrolled request. Recovery after the original invitation
expires relies on the server allowing a `recover` challenge for that still
enrolled request; verify that server behavior before relying on post-expiry
recovery. A lost proof key requires explicit reauthorization.

## Credential stores

The helper has no plaintext or repository-file fallback:

- **Windows:** CurrentUser DPAPI with a new
  `%LOCALAPPDATA%\HolaHola\coordination-runtime-onboarding` namespace,
  restrictive owner-only ACLs, protected ACL inheritance, and reparse-point
  validation. This is separate from Coordinator V2 and Gate 3 storage.
  PowerShell receives secret values over stdin; command arguments contain only
  the fixed operation, adapter path, and fixed launch options. With explicit
  founder authorization, the helper launches its child with
  `-ExecutionPolicy RemoteSigned -File`. This applies only to that child
  session; it never writes CurrentUser/LocalMachine policy. MachinePolicy and
  UserPolicy (organizational Group Policy) still take precedence. A blocked
  helper fails closed: no `Bypass`, encoded/inlined helper, `Unblock-File`,
  or policy-changing retry. Internet-marked unsigned helpers may still be
  blocked under RemoteSigned; use an independently approved signed distribution
  or ask the organization for approval, not an automatic unblock.
- **macOS:** Generic passwords in the OS Keychain, accessed through the
  installed Swift toolchain and Security framework. Values go to the helper
  process over stdin, never argv.
- **Linux:** Secret Service via `secret-tool`; lookup/store data is scoped by a
  digest and values are supplied on stdin. A running Secret Service session is
  required. An exit-1 empty lookup is treated as a missing item only after a
  random non-secret store/lookup/clear health round-trip succeeds. Atomic
  first-write is serialized between processes with the `flock` utility (from
  util-linux) in a validated user-private runtime directory; inability to lock
  fails closed.
- **Hosted/process use:** `HostedRuntimeOnboardingStore` accepts an explicitly
  injected adapter only when it asserts `runtimeRestricted: true` and implements
  atomic `setIfAbsent`. The local CLI does not configure hosted secret services.

An unavailable native store, corrupt entry, unsafe Windows path/ACL, or failed
write stops the operation explicitly. There is no downgrade to files, `.env`,
shell profiles, process arguments, or printed credentials. OS encryption does
not protect against malicious code running as the same user, live process
memory inspection, or an enrolled client that intentionally discloses its own
credential.

## MCP stdio client

Generate non-secret client configuration from the installed executable:

```sh
node /approved/install/bin/holahola-onboarding.mjs mcp --print-config \
  --endpoint https://coordination.example \
  --actor luca-cursor \
  --runtime-id cursor-workstation-01
```

Merge the emitted JSON into the client's MCP configuration. The configuration
contains only the executable path and fixed `mcp` action plus endpoint, actor,
and runtime ID. It has no bearer header, token, private key, invitation, or
arbitrary command field. The IDE starts the verified helper executable. That
process reads/renews the scoped credential internally and forwards MCP JSON-RPC
to `/api/mcp/coordination` using an internal `Authorization: Bearer` header.
Protocol messages alone go to stdout; bounded, secret-free diagnostics go to
stderr.

Do not claim an IDE integration is connected merely because its configuration
was generated. Run the authenticated `sdk` action below and then verify the
actual client's connection independently.

## CLI authenticated coordination check (`sdk`)

The CLI `sdk` action is an authenticated read-only coordination check: it
confirms the actor identity from the coordination feed, initializes MCP, lists
registered tools, and calls `list_coordination_inbox` with a one-item limit.
It prints only actor/runtime and safe connection evidence; inbox contents are
not printed:

```sh
node /approved/install/bin/holahola-onboarding.mjs sdk \
  --endpoint https://coordination.example \
  --actor luca-openai-agents \
  --runtime-id openai-agent-local-01
```

It obtains the broker credential from the scoped secure store and renews it
through the existing broker renewal endpoint when needed. The isolated
fake-endpoint test needs no OpenAI user API key and does not call the OpenAI
platform API. REST coordination routes receive the supported
`x-coordination-token`; the MCP surface receives `Authorization: Bearer ...`.
The transport rejects other origins/paths. A separate OpenAI platform API key,
if required for model inference, remains the consumer's independent concern
and must never be substituted for or stored as a coordination credential.

The renewal exchange uses the existing broker API internally with
`x-coordination-token`; renewed credentials are persisted in the secure store.
The old credential is never printed or exported. Expired credentials use the
approved-key recovery challenge path.

### OpenAI Responses SDK adapter

The package also exports `createRuntimeOpenAIResponsesClient` from
`lib/runtime-onboarding-sdk.mjs`. It wraps an already-authorized OpenAI SDK
instance supplied by the host; it neither creates nor receives the host's
OpenAI API key. A caller uses the returned `responses.create(...)` method in
place of calling that SDK method directly:

```js
import OpenAI from "openai";
import {
  createNativeRuntimeOnboardingStore,
  createRuntimeOpenAIResponsesClient,
} from "/approved/install/lib/runtime-onboarding-sdk.mjs";

const sdk = new OpenAI(); // Configure its API key through the host's normal secret mechanism.
const store = createNativeRuntimeOnboardingStore();
const coordination = createRuntimeOpenAIResponsesClient({
  endpoint: "https://coordination.example",
  actor: "luca-openai-agents",
  runtimeId: "openai-agent-local-01",
  store,
  sdk,
});

const response = await coordination.responses.create({
  model: "your-configured-model",
  input: "Use the approved coordination tools if needed.",
});
```

The example's endpoint, actor, runtime, model, store, and SDK setup are
illustrative, not provisioned values. The caller must complete founder-approved
enrollment first and supply its own authorized SDK/store. The adapter obtains
the coordination credential only from that scoped store, renews/recoveries it
through the existing broker flow as permitted, and supplies it solely as the
fixed bearer header for the trusted `/api/mcp/coordination` remote MCP server.
It never returns, exports, or prints the coordination credential. User-supplied
MCP tools cannot replace the coordination tool; MCP approval is always
`require_approval: "always"`. `policy.allowedTools` can only narrow the remote
tool set; it cannot disable approval or grant broader authority. Calls still
depend on the actual OpenAI SDK and service being available; the hermetic tests
do not make a real OpenAI API call.

## Verification boundary

### Authorized Windows launch verification

The founder authorized the process-only RemoteSigned strategy on 2026-10-01
(Denver). The native script's ACL, CurrentUser DPAPI, reparse checks, and atomic
`[NullString]::Value` replacement are unchanged. This authorization is not
publication, enrollment, or proof of Windows compatibility.

Build a **development-only** package from the reviewed local source (no
`--release`, no push or publication), then transfer it and
`scripts/test-runtime-onboarding-windows.mjs` through an approved local transfer.
Independently verify the package manifest SHA-256 and smoke-runner SHA-256
supplied by the builder/operator; a bundled manifest alone is not a trust anchor.
Keep the package files together and do not patch, automatically unblock, or
wrap the helper with an extra execution-policy command for the test. A
downloaded unsigned helper remains blocked unless a separately authorized,
hash-verified local-file trust exception is made as described below:

```sh
node scripts/build-runtime-onboarding-package.mjs --output /secure/staging/onboarding-dev
```

On native Windows with trusted Node.js 20+, from an ordinary PowerShell prompt:

```powershell
node .\test-runtime-onboarding-windows.mjs C:\approved-staging\onboarding-dev
```

This runs the unmodified packaged CLI and SDK's default native factory. It
uses a random scope at `https://native-smoke.invalid`, dummy values only, and
no enrollment/network calls. It checks all three purposes, first-write winner
preservation, DPAPI ciphertext, owner-only protected file ACLs, atomic
replacement, client/CLI corrupt-state rejection and corrupt-envelope failure.
It also gives only its dummy file an extra ACL principal and checks that both
read and adapter delete reject it; owned-path cleanup then removes that file.
Its `finally` cleanup deletes only three preflight-absent random-scope files;
it never removes the namespace or other entries. Cleanup failure is a test
failure, not success; process termination cannot guarantee cleanup. It compares
execution-policy scopes before/after without writing them. Group Policy or
download-mark restrictions must result in failure, not an alternate launch or
an automatic policy/trust-metadata change.

The source Windows check is part of
`npx tsx --test server/scripts/runtime-onboarding-native-store.test.ts` and
uses the same smoke with the default source factory/client/CLI.
Linux skips native Windows execution; source scans, a package build, and a
skip are **not** a real Windows pass. Record the native run's source revision,
manifest hash, checks and cleanup result before calling this launch verified.

#### Founder-reported native Windows result — 2026-10-03

The first downloaded-package invocation failed at `cli-empty-status`. An
unmodified-helper diagnostic then reported the unsigned-script rejection.
The founder supplied a policy table with all five scopes `Undefined` and a
`Zone.Identifier` stream on the extracted helper. Thus downloaded-script
signature enforcement blocked the helper before its own code ran; the
process-only RemoteSigned option was not a signing exemption.

The founder separately authorized removing the download mark from **only that
extracted test helper copy**, after verifying SHA-256 pins for the helper,
smoke runner and manifest. The manual command did not change file bytes,
execution-policy scopes, Group Policy, signing trust, the archive, or other
files. The production helper has no automatic unblock or bypass logic.

The subsequent **unmodified packaged** CLI/SDK smoke returned exit code `0`:

- `platform`: `win32`
- `checks`: `unmodified-cli-empty-status`,
  `dpapi-roundtrip-first-write-atomic-replace-owner-only-acl-all-purposes`,
  `client-cli-corrupt-state-and-native-corruption-fail-closed`,
  `unsafe-owned-file-acl-read-delete-rejected`
- `ownedScopeCleanup`: `true`
- `executionPoliciesUnchanged`: `true`
- `sourceRevision`: `0f9318010690a1a089e79907a7698feae1b86969`
- `sourceDirty`: `true`; `release`: `false`
- manifest SHA-256:
  `f84a1c4d04971cba99fefb67d86d48247936d8c46b16cb673a04304b11965539`
- helper SHA-256:
  `04feff0bfaeb5bde6018f02df5fbac94ffff6432b0ff63467cd0f215008d1e4c`
- smoke-runner SHA-256:
  `5fc23a98396029645cef1b1f7dd6b2d556c14289603b9bc39722ee9333397cde`
- development test archive SHA-256:
  `437327b8730c1b0520785377d1c31e361bed69e3ccf8820a63dd5e0ee4c87f2a`

The development archive is at `docs/runtime-onboarding-windows-test.zip` for
the founder's requested local download. Its manifest's revision describes the
base checkout; `sourceDirty=true` means it is not a released source pin. The
manifest and file hashes identify the actual tested package.

This proves the packaged native-store/client path on this Windows machine
**after explicit local trust approval**, not an untouched browser-downloaded
unsigned installation. Future downloaded unsigned copies can still be blocked.
Reusable signing/distribution, machines with enforced organizational policy,
live enrollment, concrete IDE/provider integration, macOS/Linux native checks,
and publication remain outside this evidence. Source Windows tests were skipped
on Linux; the receipt above is a founder-run package result, not a claimed
source-checkout Windows test. No invitations or live credentials were issued.

#### Selected self-signed internal pilot — founder-reported signed-download pass

The founder subsequently asked for alternatives to paid accounts and approved
the recommendation to start with a self-signed pilot on founder-controlled
Windows machines. This supersedes the public-CA route as the current pilot
direction; the comparison below remains an alternative, not a purchase plan.
Selecting the pilot does not itself authorize certificate creation, signing,
trust-store imports, transfer or publication. The separately authorized receipts
below establish personal-store certificate creation, user-scoped trust, helper
signing, local archive verification, independent uploaded-byte verification
and the founder-reported actual signed-download native smoke.

**Certificate-creation authorization.** The founder explicitly authorized
creation of the dedicated 90-day, non-exportable pilot certificate on
**LITTLENEMO**, in the signing Windows user's `CurrentUser\My` store.
No signing, root/publisher imports, policy changes, export/transfer or
publication is authorized by this creation approval. The founder subsequently
reported successful creation using the commands below on native Windows;
this is founder-provided evidence, not an Agent-run Windows verification.

Run the following directly in an ordinary interactive **Windows PowerShell**
console on LITTLENEMO, as the Windows user who will own the signing key. Do not
save/download this block as a script requiring its own trust exception.
Windows may display a key-protection dialog; do not share its protection
password/PIN. Stop on errors, unsupported protection or a duplicate certificate,
without retrying with weaker settings or deleting/recreating the key.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    if ($env:COMPUTERNAME -ne 'LITTLENEMO') {
        throw 'Certificate creation is authorized only on LITTLENEMO.'
    }
    $subject = 'CN=HolaHola Internal Helper Pilot'
    $existing = @(Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $subject })
    if ($existing.Count -gt 0) {
        throw 'A pilot certificate already exists. Stop; inspect it before any retry.'
    }
    $parameters = @{
        Type = 'CodeSigningCert'
        Subject = $subject
        FriendlyName = 'HolaHola Internal Helper Pilot'
        CertStoreLocation = 'Cert:\CurrentUser\My'
        Provider = 'Microsoft Software Key Storage Provider'
        KeyAlgorithm = 'RSA'
        KeyLength = 3072
        KeyUsage = 'DigitalSignature'
        KeyUsageProperty = 'Sign'
        HashAlgorithm = 'SHA256'
        KeyExportPolicy = 'NonExportable'
        KeyProtection = 'ProtectHigh'
        NotAfter = (Get-Date).AddDays(90)
    }
    $certificate = New-SelfSignedCertificate @parameters
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $certificateSha256 = [BitConverter]::ToString(
            $sha.ComputeHash($certificate.RawData)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
    # Public certificate evidence only, even if the later key-policy check fails.
    [pscustomobject]@{
        machine = $env:COMPUTERNAME
        store = 'CurrentUser\My'
        subject = $certificate.Subject
        thumbprint = $certificate.Thumbprint
        certificateSha256 = $certificateSha256
        expiresUtc = $certificate.NotAfter.ToUniversalTime().ToString('o')
        hasPrivateKey = $certificate.HasPrivateKey
    } | ConvertTo-Json
    $key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey(
        $certificate)
    try {
        if ($key -isnot [Security.Cryptography.RSACng]) {
            throw 'Unexpected key provider. Stop; do not recreate or weaken the key.'
        }
        if ($key.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) {
            throw 'Non-exportability verification failed. Stop.'
        }
        if (($key.Key.UIPolicy.ProtectionLevel -band
            [Security.Cryptography.CngUIProtectionLevels]::ForceHighProtection) -eq 0) {
            throw 'High key-use protection verification failed. Stop.'
        }
        [pscustomobject]@{
            privateKeyExportPolicy = $key.Key.ExportPolicy.ToString()
            keyUseProtection = $key.Key.UIPolicy.ProtectionLevel.ToString()
            certificateCreationChecksPassed = $true
        } | ConvertTo-Json
    } finally {
        if ($null -ne $key) { $key.Dispose() }
    }
}
```

Only return the two public/metadata JSON outputs (or the error message), never
key material, a PFX, a protection password or a PIN. A failure after creation
can leave the personal-store certificate/key present; that is not permission
to delete it or create another. Inspect it with a separately prepared read-only
step.

**Founder-reported certificate creation receipt — 2026-10-03.**

- Machine/store: `LITTLENEMO`, `CurrentUser\My`.
- Subject: `CN=HolaHola Internal Helper Pilot`.
- Certificate thumbprint: `AE523E990FF3D3AD1271D5A668709489A8EFB13A`.
- Public DER certificate SHA-256:
  `5527baca5c8c9db7c8343d3e36b625cc8d4ddc23bd3a203e2c66b322df9404ad`.
- Expiry: `2027-01-01T23:35:28.0000000Z`.
- `hasPrivateKey=true`, `privateKeyExportPolicy=None`,
  `keyUseProtection=ForceHighProtection`,
  `certificateCreationChecksPassed=true`.

The public fingerprint is supplied by the founder separately from any package.
Before using it for trust or signing, independently reread that exact personal-
store certificate and match the DER SHA-256, subject, Code Signing EKU,
non-CA/digital-signature scope and validity. No key material was supplied.
This receipt is not root/publisher trust, a signed-helper receipt, package
integrity, distribution authorization or a native smoke result. Root/publisher
trust requires a separate exact-certificate, user/machine-scoped approval.

**User-scoped trust authorization — 2026-10-03.** The founder explicitly
authorized importing only the above public certificate, after independently
rechecking its exact DER SHA-256, into `CurrentUser\Root` and
`CurrentUser\TrustedPublisher` for the same Windows user on **LITTLENEMO**.
This is not machine-wide trust, signing, export/transfer, publication or policy
authorization. Use a public-only certificate object constructed from its DER
bytes; the private key remains in the personal store. Verify certificate
identity, current validity, Code Signing-only EKU, DigitalSignature-only key
usage and non-CA scope before any trust write. Record already-present versus
newly added trust separately for each store and confirm unchanged policy scopes.
Stop on a mismatch or store/policy error; if one store succeeds and the other
fails, retain the partial result as evidence without automatic rollback,
certificate deletion or a broader-scope retry. Any later removal requires a
separate authorization targeting this exact public certificate in those two
stores, not the personal-store signing key.

**Founder-reported trust installation receipt — 2026-10-03.** The founder
reported newly added entries (`alreadyPresent=false`) in both
`CurrentUser\Root` and `CurrentUser\TrustedPublisher`, each with
`publicCertificateVerified=true` and the exact independently supplied DER
SHA-256 `5527baca5c8c9db7c8343d3e36b625cc8d4ddc23bd3a203e2c66b322df9404ad`.
The receipt identifies `LITTLENEMO`, `userScopedTrustInstalled=true`,
`executionPoliciesUnchanged=true`. The policy table reports `Undefined` for
all five scopes: MachinePolicy, UserPolicy, Process, CurrentUser and
LocalMachine. No private-key export, machine-wide trust or policy change is
reported. This is certificate-store evidence, not proof that an actual
downloaded signed helper executes. At this trust-receipt stage, signing and
signed-download verification were still pending; later receipts follow below.

**Pilot scope and trust model.** Use one dedicated, non-CA code-signing
certificate with the Code Signing extended key usage, SHA-256 signatures and
a non-exportable private key in the designated Windows signing user's personal
certificate store. For an initial pilot, propose a 90-day certificate lifetime
as a bounded review window; expiry/renewal must be planned, not treated as
permanent trust. Strong key-use protection and availability of the selected
Windows key provider need confirmation on that machine. A non-exportable
software key is not hardware isolation and can still be abused by a process
running with the signing user's authority.

Only the public certificate may leave the signing machine. Independently
verify its DER certificate SHA-256 and keep the private key out of Replit,
packages, chat and test receipts. Never export a PFX/private key for clients.
Certificate creation is a separately approved operation in `CurrentUser\My`,
not an import into a root or publisher store, and does not sign the helper.

Microsoft describes self-signed PowerShell certificates as testing-only rather
than suitable for general distribution. This route is therefore a controlled
internal pilot, not publicly trusted distribution or a production CA program.
For a maintained internal program, separately design a dedicated private CA
with protected root custody, separate code-signing issuance, expiry/rotation,
revocation and client trust administration, or use an existing organizational
CA. No CA, new account, root authority or enrollment is created by this pilot.

**Separate trust approval is essential.** The receiving Windows user/machine
must trust the self-signed public certificate as an anchor and approve it as a
publisher before the unchanged noninteractive child can reliably execute it.
For the proposed user-scoped pilot, the intended stores are
`CurrentUser\Root` and `CurrentUser\TrustedPublisher`, subject to Windows and
organizational policy. Importing a self-signed signer into Root is a deliberate
new trust anchor, not a harmless file copy. The founder must separately approve
the exact certificate SHA-256, user/machine and both store scopes after
certificate creation and independent public-certificate verification.

Do not perform these imports automatically, request machine-wide trust as a
fallback, or change policy to make user-scoped trust work. Publisher trust
applies to other code signed by the same key, not only this helper. Use the
same approved signer for subsequent pilot builds only within its approved
scope/lifetime; signer rotation can require a new publisher approval. Stop if
Group Policy or other application controls reject the pilot.

**Signing and packaging remain separately approved.** Sign only the exact
reviewed staged helper after verifying the unsigned helper/package pins; retain
the native-store logic unchanged. Finalize all package hashes after signing,
then pin the signed helper, signer certificate, manifest, archive and runner
through an independent approved channel before any test distribution.
The unsigned builder does not finalize an externally signed package; do not
reuse its pre-signing manifest as if it covered signed bytes. The separately
reviewed [offline finalizer](runtime-onboarding-offline-finalization.md) now
provides an explicit post-signing operation with independent approval/file/
signer pins. It does not sign, change trust or authorize distribution.

**Pilot signing/finalization authorization — 2026-10-03.** The founder explicitly
approved signing the existing pinned development helper on LITTLENEMO with the
above pilot certificate, **without a timestamp**, and updating that local
package's manifest to reflect the signed bytes. The founder identified the
existing extracted test package as the target. The package must first match
original manifest SHA-256
`f84a1c4d04971cba99fefb67d86d48247936d8c46b16cb673a04304b11965539`
and unsigned helper SHA-256
`04feff0bfaeb5bde6018f02df5fbac94ffff6432b0ff63467cd0f215008d1e4c`;
all five original manifest file pins must verify before signing.
Stop on an unexpected file set, unsafe path, already-signed/changed helper,
signer/trust mismatch or signature failure. Preserve helper logic and record
Windows Authenticode validity, exact signer fingerprint, absent timestamp and
new helper/manifest pins. Keep `sourceDirty=true`, `release=false` and the base
source revision unchanged. This is founder-run pilot finalization, not a
new automated builder signing feature. No archive transfer, browser download,
test invocation, enrollment, live credential, V2 edit or publication is
authorized by this step.

**Founder-reported signed-helper/finalization receipt — 2026-10-03.**

- Machine: `LITTLENEMO`; Windows Authenticode `signatureStatus=Valid`.
- Signer certificate SHA-256:
  `5527baca5c8c9db7c8343d3e36b625cc8d4ddc23bd3a203e2c66b322df9404ad`.
- `timestampPresent=false`; certificate expiry
  `2027-01-01T23:35:28.0000000Z`.
- `helperLogicUnchanged=true`.
- Signed helper SHA-256:
  `8e0f0233b7be513bf814f1536599df32800e00cc58e907c808fe38dec3737c59`.
- Finalized manifest SHA-256:
  `fdd81d7fee54795143e8e4771a61090398200f6567fec3c13c3550de011dcbe2`.
- Base source revision `0f9318010690a1a089e79907a7698feae1b86969`;
  `sourceDirty=true`, `release=false`, `executionPoliciesUnchanged=true`.

These independent founder-supplied public pins describe a locally signed,
finalized development package. They do not authenticate an archive not yet
created, prove Internet-mark propagation, establish a downloaded-package smoke
pass or authorize distribution. Keep the earlier unsigned receipt distinct;
the signed helper and new manifest no longer match its original file hashes.

**Signed test distribution and dummy-smoke authorization — 2026-10-03.**
The founder separately approved creating a ZIP of the signed development
package plus the independently pinned smoke runner, uploading it through this
chat, and downloading it through the workspace back to LITTLENEMO. Include
only the six package files (five manifest entries plus manifest.json) and
`test-runtime-onboarding-windows.mjs`; no certificate-store files, private key,
PFX, live credential or unrelated file. Record the newly created archive SHA-256
independently before transfer and verify it again after upload/download.
Do not overwrite the earlier unsigned archive or an existing output ZIP.

The founder also separately approved invoking the pinned smoke runner against
the fresh, verified downloaded/extracted signed package on LITTLENEMO. Retain
and inspect actual archive/helper download marks, independently verify all
package/signer/runner pins before execution, and require dummy-only owned-scope
cleanup. This does not authorize publication, source/runtime promotion, V2
changes, enrollment, live credentials, trust/policy changes or marking files
as downloaded by hand. Local ZIP, transfer and signed native-smoke receipts
are recorded below.

**Founder-reported packaging failure — 2026-10-03.** The initial packaging
attempt failed resolving `[IO.Compression.ZipArchive]` after opening the output
file. Loading `System.IO.Compression.FileSystem` alone did not make this type
available in that Windows PowerShell session. No successful archive receipt,
transfer or native smoke was produced. An empty output file may remain;
preserve it and retry only at a new, non-existing output filename. Explicitly
load both `System.IO.Compression` and `System.IO.Compression.FileSystem` and
resolve the required types before opening a new archive. The signed package,
certificate stores and execution policies do not need changes for this retry.

**Founder-reported existing signed ZIP verification — 2026-10-03.** A later
create-new attempt stopped because the retry ZIP already existed. Rather than
delete or overwrite it, the founder ran read-only verification and reported:

- Archive: `runtime-onboarding-windows-signed-pilot-retry1.zip`.
- Archive SHA-256:
  `9996ebbfefa1032a3194d6b4bffcfbdf0f10c862326403ec0f22e3e5b6075151`.
- `existingArchiveVerified=true`, `archiveEntriesVerified=7`.
- Signed helper, manifest, runner and signer certificate hashes match the
  independently supplied pins recorded above.
- `signatureStatus=Valid`,
  `signatureCheckedAgainstByteIdenticalLocalHelper=true`,
  `timestampPresent=false`, `nativeSmokeRun=false`.

This is a founder-run verification of an existing local archive, with signature
validity checked on the byte-identical local helper. It is not an Agent-run
archive verification or signature check on a newly downloaded/extracted helper.
At this local-verification stage, no upload receipt, fresh browser-download
marks or signed native-smoke result had been supplied.
The archive hash above is the independent transfer pin;
do not infer it from an uploaded archive's own manifest.

**Independent uploaded-byte verification — 2026-10-03 (Denver).** The founder
uploaded `runtime-onboarding-windows-signed-pilot-retry1_1791082041766.zip`
through the approved chat transfer. Agent independently verified its 33,732
bytes against the previously supplied archive SHA-256
`9996ebbfefa1032a3194d6b4bffcfbdf0f10c862326403ec0f22e3e5b6075151`,
the exact seven unique entries, all three external file pins, all five manifest
file lengths/hashes and the recorded development provenance. The four unchanged
package files and smoke runner are byte-identical to the pinned original ZIP.
Helper logic before the appended signature block matches the original after
normalizing CRLF and trailing line endings. The signature block contains one
public certificate whose DER SHA-256 matches the independent signer pin.

These are actual workspace byte/certificate checks, not a Windows Authenticode
validation, publisher-trust check or native execution. At this upload stage, a
fresh browser download, archive/helper Internet marks, Windows signature/trust
verification on the extracted helper and dummy native-smoke receipt were still
required; the subsequent founder-run result follows below. Download the
verified uploaded file through the workspace file menu; do not publish a route
or change source/runtime distribution to obtain the test download. Signed pilot
transfer ZIPs in `attached_assets` are excluded from Git publication.

A timestamp must be verified if one is used; do not assume a public timestamp
provider supports this private signer. A no-timestamp, time-bounded pilot can
be considered only with explicit founder approval and evidence that Windows
accepts it during the certificate's validity. It must not be represented as
expiry-safe. This is a specific alternative to the timestamp-required public
distribution design below, not a silent relaxation of that design.

**Required signed-download receipt.** All dummy-only cleanup and independent
pin checks described below still apply. Record the private-trust nature of
the signer, its expiry, timestamp presence/validation or explicitly approved
absence, exact approved certificate/store scopes, and download marks alongside
the Windows signature result and unchanged-policy/native-smoke receipt.
Retain the marks on the actual downloaded/extracted signed helper. No
`Bypass`, automatic `Unblock-File`, saved policy change, enrollment, live
credential, V2 edit or publication is part of this pilot.

**Founder-reported actual downloaded signed-package result — 2026-10-03
(Denver).** After the approved workspace browser download and Windows File
Explorer extraction into a fresh directory, the founder supplied the native
smoke output and the final `signed-download-test-complete` wrapper receipt.
The independently pinned package and runner were not modified or unblocked.

- Platform: `win32`; native smoke exit code `0`.
- Archive SHA-256:
  `9996ebbfefa1032a3194d6b4bffcfbdf0f10c862326403ec0f22e3e5b6075151`.
- Manifest SHA-256:
  `fdd81d7fee54795143e8e4771a61090398200f6567fec3c13c3550de011dcbe2`.
- Checks: `unmodified-cli-empty-status`,
  `dpapi-roundtrip-first-write-atomic-replace-owner-only-acl-all-purposes`,
  `client-cli-corrupt-state-and-native-corruption-fail-closed`,
  `unsafe-owned-file-acl-read-delete-rejected`.
- Dummy scope: endpoint `https://native-smoke.invalid`, actor `luca-cursor`,
  runtime ID `native-smoke-7ce54245-7741-4df0-86e7-cd842ec51e31`.
- `ownedScopeCleanup=true`, `executionPoliciesUnchanged=true`,
  `downloadMarksPreserved=true`, `helperAndRunnerPinsUnchanged=true`.
- Base source revision `0f9318010690a1a089e79907a7698feae1b86969`;
  `sourceDirty=true`, `release=false`.

The delivered wrapper gates native execution on independently supplied
archive/manifest/helper/runner hashes, every manifest file hash/length, actual
archive and extracted-helper Internet marks (`ZoneId` 3 or 4), a `Valid`
Authenticode signature on the extracted helper with the pinned signer and no
timestamp, and the same certificate in both approved CurrentUser trust stores.
It rechecks marks, pins and unchanged policy after the smoke. The founder's
final completion receipt reports those postconditions passed. The separately
printed preflight JSON was not included in the pasted receipt: do not invent
its exact zone integers or describe its raw signature output as independently
observed by Agent. Native evidence is founder-run, not an Agent-run Windows
test; independent workspace byte/certificate checks are documented separately.

**Completion boundary.** Separate creation, signing, exact user-scoped trust,
test distribution and dummy-test authorizations were obtained. The founder-run
marked downloaded signed development package passed without a repeated
download-mark removal or policy exception. This verifies the selected internal
pilot on this Windows machine/user, with this signer during its validity.
It does not establish public-CA distribution, unattended publisher rotation,
other users/machines or organizational controls, repeated future builds, live
enrollment/provider integration, V2 changes, source/runtime publication or
expiry-safe signing. The explicitly untimestamped pilot certificate expires
`2027-01-01T23:35:28Z`; a new signer/trust/distribution operation requires its
own approval. The builder and native helper source remain unchanged; manual
approved signing must precede manifest finalization for any later pilot build.

Reference: [PowerShell 5.1 signing, self-signed certificates and publisher
approval](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_signing?view=powershell-5.1).

#### Pilot expiry and replacement review — manual recovery, 2026-10-04

This documentation-only plan was reconstructed in the main checkout from the
founder-supplied completion summary of task 1698 after its platform apply
attempts failed. It is not the recovered original task diff, a successful task
merge, an implemented renewal service, or evidence that a replacement works.
The historical pilot and its receipts above remain unchanged.

The explicitly untimestamped pilot certificate expires
**2027-01-01T23:35:28Z**. Its existing trust-store entries do not extend that
validity. Do not assume the old signed helper remains usable after expiry or
that adding a timestamp to a later package validates the old package.

These are **manual review checkpoints**, not configured reminders or automatic
renewal jobs:

| Checkpoint | UTC review deadline | Required review |
| --- | --- | --- |
| 30 days before expiry | 2026-12-02T23:35:28Z | Choose a proposed replacement route, confirm provider eligibility and timestamp support, and request the separate authorizations below. If approval is unavailable, plan to stop using the pilot at expiry. |
| 7 days before expiry | 2026-12-25T23:35:28Z | Review the independently pinned replacement, any approved signer/trust changes, and available native verification receipts. An unfinished or untested replacement is not usable. |
| 1 day before expiry | 2026-12-31T23:35:28Z | Confirm a replacement has actually passed the marked-download dummy-only smoke and is separately approved for its intended use. Otherwise retain the blocked status; do not bypass expiry or policy. |

**Read-only certificate inspection.** On a separately approved Windows host
and user profile, inspect only the independently pinned pilot's public
certificate in the already approved `CurrentUser\Root` and
`CurrentUser\TrustedPublisher` stores. Match the SHA-256 of its DER `RawData`
against the independent certificate pin; a subject name or thumbprint alone
does not replace that pin. Record store presence and `NotBefore`/`NotAfter`
converted to UTC. Missing or mismatched entries stop the review. Do not create,
import, remove or renew certificates, export private keys/PFX, change policy,
or execute the helper as part of this inspection. Metadata inspection alone
does not establish valid Authenticode trust or timestamp verification.

**Replacement choices.**

- A stable, appropriately approved publisher identity reduces repeated
  operator decisions, but public-CA chain trust is not publisher approval.
  Confirm the selected provider's eligibility, lifetime, supported signing
  tooling and trusted timestamp service before acquisition.
- Certificate rotation changes the exact certificate pin even when the
  publisher name stays the same. Independently approve the new certificate
  and any exact user-scoped trust-store changes; never treat the old approval
  as blanket permission to trust a replacement.
- A provider-supported trusted timestamp may permit later validation of a
  signature made within the signer's validity period, subject to actual
  Windows chain, countersigner and applicable policy checks. It is not an
  unconditional expiry guarantee and does not retrofit the untimestamped
  pilot. Preserve the offline finalizer's cache-only and fail-closed limits.

**Separate authorizations and acceptance.** Certificate acquisition/account
setup, signing, each exact trust-store change, package transfer and publication
remain separate founder decisions. This plan authorizes none of those
operations. Prepare any approved replacement from reviewed source and deliver
independent source, development/release status, signer certificate, signed
helper, runner, manifest and archive pins through the approved channel.
Signing changes bytes: follow the reviewed post-signing finalization process
instead of retaining an old manifest or normalizing the signed helper.

Before claiming replacement usability, collect a fresh native Windows receipt
from the approved marked-download/extraction and dummy-only smoke. Verify
actual download marks, exact package/signer pins, native signature and the
approved timestamp policy; require owned-scope cleanup and unchanged execution
policies and marks afterward. Do not reuse the earlier pilot receipt as proof
for a new signer, package, host or the stricter offline verifier.

No helper or signed artifact was changed for this documentation recovery.
There was no Windows trust, signing, renewal, transfer, publication, enrollment,
credential or source-pin operation. Replacement usability remains
**unverified**; task 1701's new native receipts remain separately gated.

#### Publicly trusted signing alternative — preparation only, 2026-10-03

The founder authorized this checkout and preparation of a **new publicly
trusted signer** route. This is not authorization to acquire a certificate,
create a signing-service account, submit identity documents, incur charges,
sign files, install signing tooling, change machine trust, transfer a package,
or publish source/runtime artifacts. The signed-download verification remains
**pending**. The earlier unsigned-package pass after a one-file trust exception
is not signed-download evidence.

**Provider comparison.** A hardware-backed public-CA Authenticode certificate
is the preferred candidate for this helper. DigiCert KeyLocker documents
hardware-backed key custody and Windows SignTool support for `.ps1` files;
confirm the actual certificate lifetime, eligible legal identity, price,
timestamp support and signing permissions with the provider before acquisition.
Keep its private key in the provider's protected signing system, not in this
checkout, a package, chat, or an exported PFX. Provider/account setup and any
required signing-tool installation each need explicit founder authorization.

Microsoft Azure Artifact Signing Public Trust is an alternative, not an
already configured service. Microsoft documents Authenticode integration,
identity/geographic eligibility restrictions, daily certificate renewal and
three-day signing-certificate validity. Timestamping is essential, and Microsoft
explicitly warns that pinning an individual certificate is not durable across
renewal. Per-package exact signer pins remain useful, but must not be confused
with a stable cross-release trust identity.

**Public CA trust is not PowerShell publisher trust.** Windows must validate the
certificate chain, signature and timestamp, and PowerShell may additionally
require approval of the publisher. The existing helper child is noninteractive,
so it cannot resolve an untrusted-publisher prompt. Do not promise prompt-free
downloads merely because a public CA issued the certificate. A stable signer
can reduce recurring publisher approvals within that certificate's lifetime;
renewal/rotation requires renewed independent verification and may require
another separately authorized publisher approval. Daily leaf rotation is a
specific concern for the Microsoft alternative.

If publisher approval is required, stop and obtain separate explicit founder
authorization identifying the exact verified public certificate, target user/
machine, trust store, scope and removal procedure. No trust operation is
performed by the package, builder or smoke runner. Never import a private key
on the client, install a new root as a shortcut for this public-CA route, or
approve an unknown publisher. The separately approved internal-pilot design
above explicitly identifies its different private-trust requirements.
If the founder declines trust approval or organizational policy disallows the
helper, report a blocked result. RemoteSigned, Group Policy and other Windows
application-control restrictions remain authoritative.

**Packaging review.** `scripts/build-runtime-onboarding-package.mjs` currently
copies the unsigned source helper and then hashes the package. Its `--release`
flag checks source cleanliness; it is not proof of Authenticode signing,
founder release approval or distribution authorization. Do not sign an existing
output and retain its old manifest: signing changes the helper's bytes.
The approved implementation, once separately authorized, must:

1. Build from a reviewed source revision into an isolated staging directory.
   Keep `server/scripts/runtime-onboarding-native-store.ps1` logic unchanged;
   signing applies to the staged copy, not a rewritten native-store protocol.
2. Have the authorized operator sign that exact helper with SHA-256 and a
   provider-supported timestamp, using narrowly scoped signing authority.
   No setup-time download-and-evaluate commands or embedded service credentials.
3. Independently verify the staged helper with Windows Authenticode trust
   APIs; require a valid signature, expected signer identity, exact signer
   certificate SHA-256 and valid timestamp. Text resembling a signature block
   or a certificate bundled with the download is not validation.
4. Finalize the manifest only after signing. Recompute every packaged file's
   byte length and SHA-256, then the manifest SHA-256. Package all required
   files together and compute the final archive SHA-256. Do not normalize
   line endings, re-sign, or rewrite any file after finalization.
5. Through an independently trusted founder-approved channel, provide the
   source revision, development/release status, archive and manifest SHA-256,
   signed-helper SHA-256, smoke-runner SHA-256, and exact signer certificate
   SHA-256 plus validated publisher identity. A certificate thumbprint may be
   recorded as additional identification; it does not replace the SHA-256
   certificate pin. Any changed signature/package needs new exact pins.

The signing/acquisition/distribution sequence remains a design, **not an
automated signing feature**. Its post-signing manifest step is now implemented
by the separately invoked [offline finalizer](runtime-onboarding-offline-finalization.md).
It requires independent approval/file/signer pins and a byte-exact original
helper prefix, validates native Windows trust with cache-only retrieval, and
refuses stale manifests in read-only verification mode. It neither signs nor
changes trust, packages archives, transfers or publishes. The current builder
and existing unsigned packages remain unsigned. Ordinary
ZIP archives are not made Authenticode-signed merely by containing a signed
script; the independent archive/manifest pins must also authenticate the Node
CLI, SDK and runner before they execute.

**Separate approval checkpoints.**

- Acquisition: founder approves provider, verified legal identity, cost,
  account/key custody, allowed signing scope and tooling installation.
- Signing: founder approves the exact reviewed staging build and signer.
- Trust: if necessary, founder separately approves the exact publisher trust
  operation; acquisition/signing approval never implies client trust approval.
- Test distribution: founder approves a named private transfer/download channel,
  exact pinned artifact and target Windows machine. This is not public
  publication or enrollment.
- Verification: founder approves running the independently pinned dummy-only
  smoke on that machine. Source/runtime publication, enrollment, live
  credentials and Coordinator V2 changes each remain outside these approvals.

**Acceptance evidence from the actual downloaded artifact.** After those
approvals, use the intended browser/download and extraction path on native
Windows with independently trusted Node.js 20+. Retain download marks; inspect
and record the archive/helper `Zone.Identifier` state before testing. Do not
remove, synthesize or alter download marks to manufacture a pass. If extraction
does not propagate the mark to the helper, record that limitation; the result
does not prove execution of an Internet-marked signed helper.

**Offline tool evidence — 2026-10-04.** The new finalizer is separately designed
and tested with hermetic fixtures. It is not a new native Windows, download,
publisher-trust or public-CA acceptance receipt. Exact prefix verification is
stricter than the historical pilot's newline-normalized workspace comparison;
that pilot package is not promised to satisfy the new byte-exact gate.
Offline trust validation can fail on unavailable cached revocation evidence.
Do not silently retry online or alter trust/policy to obtain a pass.
The design was independently approved by Alden in shared-spec:
document `df768822-2334-49ff-a1d7-4b04f0bd9198`, revision
`e24f289d-e3e2-4306-ae0f-4db0850cf454`, review
`3644028c-a9d3-4448-bbb6-d75b6b3d3da8`, content SHA-256
`35090a0605a0897bc2837f30421d4d0980c352a685769853b1b90cb0ee568b60`.
This is design approval, not signing, trust, native-test or publication approval.

Before running any packaged JavaScript, independently match archive, manifest
and runner pins, verify every file against the pinned manifest, and validate
the helper's Authenticode signature and exact signer certificate pin on Windows.
The existing smoke checks manifest file hashes but does **not** independently
validate signer trust or external pins. Perform those checks before invoking
`node .\test-runtime-onboarding-windows.mjs <approved-package-directory>`.
Stop on a missing/mismatched pin, invalid signature, missing/invalid timestamp,
unapproved publisher or policy rejection; no alternate launcher/retry policy.

Run the unchanged CLI/SDK default native factory with dummy values only.
Require exit code zero, every native smoke check, unchanged execution-policy
scopes and successful cleanup of only the three preflight-absent random-scope
files. Preserve unrelated DPAPI entries and the shared store directory. Process
termination leaves cleanup unproven; retain the printed owned paths for a
separately approved, exact-path recovery, never a namespace-wide deletion.

Record in this document: approvals and their precise scopes, tested Windows/
PowerShell/Node versions, source/development status, download/extraction path
and mark evidence, independently verified artifact/signer pins, signature and
timestamp result, publisher-trust state before/after any separately approved
change, policy scopes before/after, smoke checks/exit code and owned-scope
cleanup. Preserve failures as failures. No public-CA signed package or native
pass exists for this alternative. The internal-pilot receipts above establish
only their explicitly stated private-trust evidence; they do not establish this
alternative or a downloaded signed-package pass.

**Primary sources reviewed for this strategy:**

- [PowerShell 5.1 signing and untrusted-publisher behavior](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_signing?view=powershell-5.1).
- [DigiCert KeyLocker protected key custody](https://docs.digicert.com/en/digicert-keylocker.html)
  and [supported signing tools/file types](https://docs.digicert.com/en/digicert-keylocker/overview/compatible-signing-tools.html).
- [Microsoft Artifact Signing overview](https://learn.microsoft.com/en-us/azure/artifact-signing/overview),
  [eligibility/setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
  [Authenticode integrations and timestamp requirement](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations),
  and [certificate renewal/pinning limitation](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management).

The focused server/client test files use isolated fixtures; the client and SDK
tests use fake endpoints/stores, and no test issues real credentials. The
package-builder test covers standalone output. These tests do not establish
live-device or live-provider compatibility:

```sh
npx tsx --test \
  server/services/runtime-onboarding.test.ts \
  server/services/runtime-onboarding-postgres.test.ts \
  server/services/runtime-onboarding-openai-sdk.test.ts \
  server/services/runtime-onboarding-restricted-credential.test.ts \
  server/scripts/runtime-onboarding-client.test.ts \
  server/routes/runtime-onboarding-routes.test.ts
node --test scripts/build-runtime-onboarding-package.test.mjs
```

They cover persist-before-request, interleaved setup/key winner preservation,
idempotent initial-request replay after a dropped response, durable-key
recovery after invitation expiry, Linux empty-store probing and cross-process
first-write, signature and challenge scope validation, secure-store
isolation/failure behavior, fixed MCP config, credential renewal, SDK transport
forwarding and OpenAI Responses tool/approval construction, backend routes and
durability invariants, and stdio protocol forwarding. These are commands for
the main verification pass; this document does not assert that the full suite
has passed. These tests do not perform enrollment or founder approval. The
specific Windows packaged DPAPI/ACL smoke is documented above. macOS Keychain
access, Linux Secret Service availability, broader Windows trust-policy
environments and concrete Cursor/OpenAI clients require separate
native-platform/client smoke tests before being labelled verified.

The admin ledger-read badge is historical, server-derived evidence only: the
successful authenticated read routes (threads/inbox) record
`runtime_onboarding_ledger_read` for the matching enrolled actor/runtime. It is
not inferred from renewal, a client heartbeat, or `lastUsedAt`, and does not
prove a current connection. Inbox acknowledgement is a separate operation; it
does not authenticate the caller by itself and is not Coordinator V2 execution.