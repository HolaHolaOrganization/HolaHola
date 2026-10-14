Three independent Windows-environment gotchas hit while building HolaHola's Windows-side tooling (Gate 3 executor, coordination-token provisioning, Codespace file transfer). None share a root cause — grouped here only because each is Windows-specific and narrow enough not to warrant its own index line.

## PowerShell pipe corrupts files sent to a remote shell

Never pipe a text file through Windows PowerShell into an external process (`ssh`, `gh codespace ssh`, anything writing the bytes elsewhere) when the receiving side must parse those bytes exactly. PowerShell's default pipeline text encoding for `Get-Content | external-command` adds a UTF-8 BOM at the start and can convert LF line endings to CRLF. Route the same operation through Bash (git-bash/MSYS) instead — its pipes are binary-safe and add nothing.

**Why:** Copying a local `.env` into a fresh GitHub Codespace with `Get-Content -Raw .env | gh codespace ssh -c <name> -- "cat > .env"` produced a `.env` that `file` reported as `Unicode text, UTF-8 (with BOM), CRLF line terminators` — even though the source file was plain ASCII with no BOM. Node's `--env-file`/`--env-file-if-exists` parser choked on the leading BOM and silently returned every variable as unset (not an error — a quiet, total parse failure). `npm run dev` and `scripts/neon-branch.ts` both failed with "Missing NEON_SHARED_DATABASE_URL" even though `grep` on the remote file showed the variable's line was present with a value. Re-running the exact same copy through Bash instead (`sed 's/\r$//' .env | gh codespace ssh -c <name> -- "cat > .env"`) produced a clean `ASCII text` file with no BOM, and the variable loaded correctly.

**How to apply:** any time a file's exact bytes matter for a downstream parser (`.env`, JSON, a script with a shebang), do the transfer through Bash, not PowerShell's `Get-Content | ...` pipeline — even from a Windows machine, since both tools are available side by side. Don't trust `grep`/`cat` output alone to rule out corruption (a BOM at byte 0 doesn't show up when a line-oriented tool prints a later line's content looking fine) — use `file <path>` to check encoding/line-endings directly.

## Generating a random credential on Windows PowerShell (no openssl)

Windows PowerShell (both 5.1 and 7+) has no `openssl` binary by default, so `openssl rand -base64 32` — the usual recipe for a coordination-actor bootstrap token or any other 32+ character random secret — fails with `CommandNotFoundException`. The natural-looking one-line substitute also fails in a confusing way:

```powershell
[Convert]::ToBase64String((New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes(32))
```

`RNGCryptoServiceProvider.GetBytes(byte[] data)` fills an existing array **in place** and returns nothing — it is not the newer `RandomNumberGenerator.GetBytes(int count)` static helper that returns a new array. Passing `32` (an int) where a `byte[]` is expected silently resolves to a call that produces no output, so `ToBase64String` then throws `Value cannot be null. Parameter name: inArray` — the error surfaces on the wrapping call, not the real cause.

**Why:** this is a genuine, repeatable trap for anyone provisioning a new `COORDINATION_*_TOKEN`-style secret from a Windows PowerShell prompt, since neither failure mode is obvious from the error text alone.

**How to apply:** pre-size the array, then fill it:

```powershell
$bytes = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes); [Convert]::ToBase64String($bytes)
```

If that still misbehaves (older execution policy, restricted crypto APIs), a zero-dependency fallback with no namespace resolution risk at all is two concatenated GUIDs, which comfortably clears any 32-character minimum:

```powershell
[Guid]::NewGuid().ToString() + [Guid]::NewGuid().ToString()
```

## Windows console child-process lifetime

Windows delivers `CTRL_CLOSE_EVENT` (same signal family as Ctrl+C/Ctrl+Break) to every process attached to a console when that console's window is closed or its tab is reused for something else. A console child process with no custom handler installed terminates by default on receiving it — silently, no crash dump, no stderr. This hit HolaHola's Gate 3 Windows executor: the launcher PowerShell script started the real work as a child `node` process without detaching it, so closing/reusing the terminal mid-run killed an in-progress run with no trace.

**Why:** `System.Diagnostics.ProcessStartInfo` with `UseShellExecute = $false` (needed to control the child's environment/working directory) makes the child inherit the launcher's console by default unless told otherwise.

**Fix:** set `$startInfo.CreateNoWindow = $true`. This gives the child its own hidden console instead of sharing the launcher's, so the launcher's console closing no longer reaches it. Root file: `scripts/antigravity-gate3.ps1` (`New-ApprovedChild`, `Start-PlainChild`).

**Deliberate non-fix — do not add stdout/stderr redirection as a "belt and braces" companion change.** Piping the child's stdout/stderr back through the launcher's own managed pipe handles recreates the exact coupling `CreateNoWindow` removes: a killed parent closes its pipe handles out from under the child. Keep the child's own console detached and let the launcher report only fixed, non-secret event names — never raw child output — if it needs to signal status.

**How to apply:** any future Windows launcher script in this repo that spawns a long-running child via `ProcessStartInfo` needs `CreateNoWindow = $true` (or equivalent full detachment) before it can be trusted to survive the launcher's own terminal window closing or being reused for another task.


## Host diagnostics never authorize manual replay

Treat host error reports as reporting, not authority to decrypt request state, reveal raw errors, replay proof, or reissue bootstrap material. Preserve local files and continue only through the approved lifecycle and founder gates.

**Why:** A generic transport error does not establish whether a state-changing request reached the server. A prior workaround recommended exposing raw response text and replaying a persisted request; that advice is unsafe when an outcome is ambiguous. Truncation also cannot prevent secret disclosure.

**How to apply:** Use typed metadata, exact allowlisted reasons and fixed guidance to distinguish failure classes. Never recover missing diagnostic context by printing raw bodies or exception messages, or by manually replaying proof. Exact retry authority belongs to the established lifecycle, not its diagnostic formatter.


## PowerShell execution-policy diagnostics

Native PowerShell error classifiers must tolerate wrapped text and must never treat an unrecognized error as proof that a policy restriction is absent. Capture the redacted underlying error before selecting a repair.

**Why:** A real execution-policy rejection split “running scripts is disabled” across lines and reported `SecurityError` / `UnauthorizedAccess` without the literal `PSSecurityException`. A phrase-based classifier consequently returned a false negative and delayed diagnosis.

**How to apply:** Normalize whitespace when classifying captured errors, retain an explicit unknown outcome, and make sanitized process output available when a script exits before its own error handler. Do not change security policy or ACLs based on a negative text match.

## PowerShell null-string binding to .NET

Windows PowerShell can coerce `$null` to an empty string when binding a .NET string parameter. Use `[NullString]::Value` when the method requires a genuine null string; preserve atomic file operations rather than replacing them with delete-then-write sequences.

**Why:** A real Windows test failed during atomic file replacement because the optional backup path was not of a legal form. Changing only that argument from `$null` to `[NullString]::Value` in the temporary adapter made replacement, readback, and cleanup pass.

**How to apply:** Check PowerShell-to-.NET string binding when a valid-path operation fails on an optional null argument. Distinguish successful storage testing under a temporary process execution policy from readiness of a runner that still uses the machine's default policy.

## Native launch evidence

## Native launch evidence must match the delivered invocation

A successful Windows helper test that adds execution-policy flags outside the
production adapter does not verify the delivered client. Verify the client's
default native factory and the complete packaged entry, without patching the
helper or applying policy in an outer wrapper.

**Why:** A real dummy-value DPAPI test passed under a child-only policy while the
actual client still failed before its helper script could execute. Storage
correctness and launch compatibility were separate unproven claims.

**How to apply:** Keep process-only policy authorization separate from permanent
policy changes, respect organizational restrictions, and require native evidence
with owned-scope cleanup before describing a packaged Windows launch as working.

## Downloaded helpers and process policy

Browser download provenance can survive ZIP extraction as a Zone.Identifier
stream on an otherwise byte-identical Windows helper. Child-only RemoteSigned
still rejects that unsigned extracted file. A process-policy option is not a
signature exemption.

**Why:** Native storage worked under approved local test conditions, yet the
unmodified browser-downloaded package failed before script execution. Read-only
policy and alternate-stream inspection distinguished download provenance from
organizational policy. A separately approved, hash-gated one-file trust exception
enabled the actual packaged smoke without changing saved execution policy.

**How to apply:** Diagnose both effective policy scopes and download provenance
before choosing a remedy. Never silently unblock or switch to Bypass. Any manual
trust exception needs explicit authorization and independent hash verification;
success afterward proves only that approved copy, not untouched future downloads.

## Secret-safe child-process capture

Native diagnostic capture must use explicit piped stdio for synchronous child launches. Node's execFileSync can forward child stderr automatically on a failed command when stdio is left implicit, even if the caller catches the exception and only prints an allowlisted report.

**Why:** A secret-safe outer failure handler does not protect against a child-process API forwarding raw diagnostics before that handler runs. Arbitrary helper output may contain store data or credentials.

**How to apply:** Audit the subprocess boundary as well as the final serializer. Keep fixed-category reporting separate from captured child output, require positive evidence before classifying a security restriction, and leave unrecognized failures explicitly unknown. This is not authority to change policy or unblock a downloaded file.

## Windows PowerShell compression assemblies

Windows PowerShell may not expose compression types transitively when only the FileSystem assembly is loaded. Load the core compression assembly explicitly as well, and resolve required types before creating an output file.

**Why:** A real Windows session accepted the FileSystem assembly load but failed to resolve ZipArchive after opening the destination. Assembly availability must be checked before filesystem side effects, not inferred from a related assembly.

**How to apply:** Preflight all required .NET types in Windows instructions before opening outputs. Preserve failed outputs and use a fresh create-new destination rather than silently overwriting or deleting them.

## Execution policy after a new PowerShell session

A Process-scope execution-policy adjustment does not persist into a new PowerShell session. Windows recovery instructions must check the current policy scopes before loading the launcher, rather than assuming an earlier temporary adjustment remains effective.

**Why:** A repeated launcher-loading failure was caused by effective Restricted policy despite a verified source hash and no download-zone marker. Earlier session-only adjustments did not establish a permanent host configuration.

**How to apply:** Put read-only effective-policy, scope, and download-zone checks in the delivered operator commands before any checkout or protected-state changes. Treat this as a blocking prerequisite in every new PowerShell window, not an assumption based on source hashes or a previous successful session. If no Group Policy restriction is shown, verified local source with no download-zone marker may use Process-scope RemoteSigned only after explicit approval for that adjustment. Do not infer authority for Bypass, permanent policy changes, file unblocking, or credential approval.


## Clock freshness during Windows credential recovery

A Windows recovery validation rejection with no saved request can happen before request persistence, during the signed recovery-context lookup. Check clock offset independently before diagnosing a declaration serialization defect or changing protected state.

**Why:** A real host was about 1.5 seconds ahead of an NTP reference and received a declaration-invalid rejection with no local draft. After independent samples showed the offset had disappeared, the unchanged published client and server accepted the next generation. The resync command itself reported failure and a stopped service, so acceptance does not establish what corrected the clock or that ongoing synchronization works.

**How to apply:** Use bounded clock and recovery metadata diagnostics, never decrypted request dumps. Separate observed clock alignment from time-service health and command success. Obtain explicit approval for system-clock adjustments; do not broaden timestamp validation or change time-service configuration based on this incident.


## Self-contained operator diagnostics

Operator-facing Windows diagnostics should be self-contained and read-only. Do not depend on coordinator globals or helper functions having survived in the caller's PowerShell session. Use an explicitly grounded checkout path and standard PowerShell/.NET APIs where possible.

**Why:** A recovery ACL diagnostic could not inspect the checkout because its assumed coordinator path variable was empty in the operator's window. The diagnostic had not cleared that variable; relying on implicit session state introduced a separate failure while investigating the original one.

**How to apply:** Make diagnostic prerequisites explicit, avoid loading lifecycle code solely to inspect filesystem metadata, and represent unresolved identities as unknown rather than trusted. Keep success messages inside the same guarded block as the checks so later pasted commands cannot print a false verification success after an earlier error.


## Primitive filesystem mutation masks

Classify filesystem mutation using primitive mutating rights, not broad composite grants such as FullControl or Modify. Those composites also contain read bits, so including them in a write predicate can reject a legitimately read-only ACL.

**Why:** A native Windows checkout with an untrusted ReadAndExecute/Synchronize ACE was rejected as unsafe write access. Independent architectural review confirmed the integrity boundary is preventing untrusted modification; DPAPI CurrentUser separately protects encrypted custody material against decryption by other users.

**How to apply:** Preserve trusted-owner/writer identities and unrelated custody checks. Test native ACL semantics in disposable Windows fixtures and prove both false-positive and missed-mutation regressions. Do not remove legitimate read-only host permissions to accommodate a classifier defect, and do not claim native success from text scanning alone.


## Tooling checkout hashes versus Git blob line endings

Windows tooling-checkout hashes can differ from reviewed Git-blob hashes solely
because of CRLF line endings. Diagnose this by computing the exact deterministic
CRLF rendering of the reviewed blob and comparing its hash, rather than
assuming either code drift or equivalence.

**Why:** A native Windows tooling inventory produced different hashes from the
reviewed Linux files, but the reported hashes exactly matched their CRLF-only
renderings. An unexplained mismatch and a demonstrated checkout transformation
need different treatment.

**How to apply:** Record both byte representations explicitly in the proposed
tooling approval. Do not rewrite files to force a match, silently accept a
different pin, or infer a checkout revision from a file hash. This diagnosis
does not permit normalization of signed artifacts: approved helper prefixes and
signed-package hashes must still match their exact independent bytes.


## Linux PowerShell evidence boundary

Linux PowerShell parsing is not evidence of Windows DPAPI, ACL, Authenticode,
atomic filesystem, or initializer behavior. Keep parser/structural checks
separate from native execution receipts.

**Why:** On 2026-10-06, the Nix PowerShell executable parsed the full launcher
and exercised core parameter binding, but two synthetic pure-function runs
stalled during cmdlet loading (the traced run stopped at Join-Path). The cause
was not established. The failed runs were not counted as passes.

**How to apply:** Bound child-process execution time, report stalls honestly,
and do not infer a Windows failure or success from a Linux cmdlet stall.
Respect native publication/authorization gates even when native fixtures are
synthetic. Do not add a hanging exploratory check to mandatory CI.


## Windows Time query prerequisite

Do not assume Windows Time configuration queries work while the service is stopped. A native `w32tm /query /configuration` returned service-not-started (0x80070426), not configuration evidence.

**Why:** A nominally read-only diagnostic required a running Windows Time service. Starting that service is a separate host mutation and may synchronize the clock through existing settings.

**How to apply:** Inspect service state/startup type first. If stopped, obtain explicit approval before starting it; do not silently change startup mode, force a resync, or retry credential recovery. A failed configuration query says nothing about the configured time source.


## Desktop-bundled Claude Code executable discovery

The desktop-bundled Claude Code executable on LITTLENEMO is reported to live under version-and-hash directories and is not on PATH. A dispatcher must not rely on one currently observed executable path remaining valid after a desktop update.

**Why:** The local read-only readiness report supplied on 2026-10-07 found multiple bundled versions and identified desktop updates as changing the executable location. This behavior is outside the repository and cannot be established by reading its code.

**How to apply:** Resolve and validate the intended installed executable at launch, or separately approve a stable standalone installation. Do not silently choose an arbitrary version by directory-name sorting. CLI help working is not proof of authenticated noninteractive execution; test a real no-tool invocation on the target host before calling it dispatch-ready.


## Desktop authentication is not standalone worker authentication

Standalone subscription login is conditional on choosing an independent CLI worker; it is not a general requirement for automatic HolaHola inbox handling or for the LCC Desktop session that already works. Do not repeatedly ask for browser login before checking whether the existing authenticated surface can perform the needed automation.

**Why:** The LITTLENEMO comparison showed that Desktop supplies host-managed authentication while the detached probe had neither that authentication nor an API key. David repeatedly questioned why his working LCC session needed another login. Anthropic’s Desktop scheduled-task documentation describes automatic local sessions with file/tool access while Desktop is open and the computer awake; installed-version support and HolaHola access from such a run remain unverified.

**How to apply:** First check the existing Desktop local-task capability when seeking to remove manual inbox prompting. Treat it as a replaceable executor adapter, not a requirement for HolaHola’s owned coordination protocol. If independence from Desktop is required, explicitly choose a supported API-backed or subscription-backed CLI profile; only the latter needs its own subscription authentication. Never extract Desktop credentials, infer lack of all model access from one failed launch, or change billing silently.


## Detached workers still inherit provider and billing configuration

Windows child processes inherit their actual parent process environment; a persistent user-level environment variable is not proof that a particular child received it. Detached launch is not environment isolation, nor does it reload every saved Windows user variable.

**Why:** The LITTLENEMO launch comparison supplied on 2026-10-07 found a persistent user-level API key, but Desktop had excluded it from the hosted session and the detached child inherited that absence. The child did inherit the normal Anthropic endpoint. Earlier inference that the persistent API key would override that particular probe was incorrect.

**How to apply:** Verify variable presence in the intended launch context without revealing values. Construct the worker environment deliberately for its chosen authentication profile instead of loading the full project .env or assuming persistent variables are present. Keep coordination configuration separate and preserve unrelated saved configuration. Centralize provider-profile handling so API and subscription launches do not silently change billing or routing.


## Desktop host approval visibility

Do not use a Desktop scheduled run’s own transcript as proof that no host permission prompts occurred. A model session may not observe approvals collected by the Desktop host.

**Why:** On 2026-10-07, a successful scheduled inbox-read proof reported that no prompts were needed, but the founder had approved two Bash prompts. The corrected report preserved command-output evidence for authentication and inbox access while withdrawing the unattended-permission claim.

**How to apply:** Verify prompts using founder observation or the task’s host-side permission panel. Separate successful manually approved execution from unattended readiness. Configure narrowly scoped per-task approvals only with founder authorization; neither Manual mode nor model self-report proves a run can proceed without intervention.


## Desktop scheduled-run status and persistent approval evidence

Treat Desktop task status as a scheduling signal, not sufficient evidence that its command executed. For persistent narrowly scoped approval, use the in-app permission prompt and verify the host-saved exact-command rule; the Windows notification approval may be allow-once only.

**Why:** The 2026-10-07 native proof required three setup attempts: a host restart interrupted a pending command yet the host recorded succeeded; notification approval ran the command but saved no permission; in-app always-allow saved the exact rule and the subsequent scheduled run needed no intervention. These host behaviors are not visible in repository code.

**How to apply:** Require actual command output plus founder or host-side permission evidence for acceptance. Separate setup attempts from the measured activation. Prefer supported one-shot scheduling for bounded proofs, verify final disabled state, and account for per-run worktree/branch leftovers without deleting them absent authorization. A successful scheduled inbox GET does not establish recurring dispatch, coding readiness, or operation while Desktop is closed or the host asleep.


## Desktop task approval captures variable reply arguments

Desktop task in-app always-allow can save the full observed Bash command, including variable result arguments and quoting, rather than a helper-path prefix rule. Do not assume approving one invocation authorizes later variable-output invocations.

**Why:** In the 2026-10-07 scheduled assignment-return setup, fetching and document reading worked, but host-side approvedPermissions contained the complete reply command with setup answer values. The UI did not offer a helper-scoped argument wildcard. The measured run was therefore not armed or scheduled. This is native host behavior, not a fact discoverable in repository code.

**How to apply:** Inspect the actual saved rule before claiming autonomous variable-result delivery. Distinguish exact-command task approval from a user-settings helper wildcard that applies across sessions. Prefer investigating fixed-command bounded-result mechanisms; any wider settings rule needs explicit founder approval, disclosed cross-session scope, and an agreed removal plan. A setup dry run is not evidence of scheduled execution or actual return delivery.


## Transcript-bound exact-command return is a proof adapter

An exact no-argument reply invocation can carry child-authored variable results by extracting a strictly bounded answer block from that child’s own session transcript. Use this only as an optional proof adapter, not an owned or stable execution interface.

**Why:** Native testing on 2026-10-07 first showed dry-run extraction, then an unattended ordering failure: the child called before authoring its block and tried again despite a no-retry instruction. Guards rejected both calls without sending. A prompt-only correction requiring a separate answer message before the last tool call subsequently produced an actual canonical result received by Replit, without helper or permission changes. This proves a bounded route, not recurring reliability or a stable vendor interface.

**How to apply:** Enforce session/worktree/source-event and ordering checks and bounded payload validation in code; prompt instructions alone are not execution guarantees. Preserve the failed run and count second calls as retry attempts even when no network send occurred. Verify actual canonical receipt separately from helper delivery-summary parsing, which reported unknown despite successful receipt in this proof. Child and parent may share a coordination actor, so distinguish session/transcript provenance from independent authenticated identity. Preserve replaceable standalone/API routes and require separate authorization for recurring operation.


## Agent-tool inherited process execution policy

LCC reported on 2026-10-07 that its Windows PowerShell tool injected PSExecutionPolicyPreference=Bypass, which propagated into child PowerShell processes. Removing that inherited variable for a read-only child check exposed the host's effective Restricted policy. This was a reported native observation, not an independent Replit host inspection or a universal guarantee about every tool version.

**Why:** A native fixture with verified source hashes and no download marks was still blocked: the tool's inherited policy violated the approved no-Bypass scope, while the clean host policy prevented script execution. Neither source verification nor the tool's ability to run commands proved permission to run the fixture.

**How to apply:** Inspect inherited process policy separately from saved scopes and download provenance. Stop rather than silently using the tool's Bypass setting. Any clean-child environment adjustment and one-invocation RemoteSigned option require explicit authorization; verify the effective policy for the authorized child and its descendants. Do not infer authority for saved policy changes, organizational-policy overrides, unblocking, trust changes, or live recovery.


## Job Object startup and console cancellation

Job containment and cancellation must hold from process creation, not just after a successful launch. A suspended root is not contained until it belongs to the job; launcher death before assignment can leave it outside kill-on-close. The last-handle guarantee also requires private, non-inheritable job-handle ownership. Console cancellation is a separate contract: a no-console launch cannot simply promise group Ctrl+Break delivery.

**Why:** The 2026-10-07 Windows worker design review found these API-contract gaps after a Job Object had correctly replaced unsafe PID/tree selection. This was source/API verification, not a claim that a Windows test had run.

**How to apply:** Check startup failure, launcher death and resume failure as well as normal termination. Require native identity-bound containment/cleanup and isolated evidence that no running or suspended owned process survives and unrelated processes are untouched. Do not substitute a PID lookup, broadcast signal or successful setup test for those guarantees.


## Native descendant evidence and PATHEXT

Native Windows descendant tests must assert the intended descendant identities, not merely a process count. Include PATHEXT when building a minimal environment for cmd-launched executable lookup.

**Why:** A native test passed using the PowerShell root and its console host while the intended cmd/ping descendant had failed to launch because PATHEXT was absent. Passing counts falsely supported the claimed descendant-termination evidence; the author later corrected those receipts.

**How to apply:** Require the actual expected descendant image identities before testing containment or termination. Treat console-host membership separately and disclose historical receipts that did not prove the stated topology.


## Persistent PowerShell first-query readiness

Readiness for a persistent PowerShell helper must account for first-query
dependency loading, not just process startup. Keep simple process-identity
protocol parsing independent of optional cmdlet/module autoloading.

**Why:** A real PowerShell check in the Linux workspace emitted readiness and
received the request, then stalled before its first ConvertFrom-Json completed.
Mocked IPC tests had not exposed that delay. A primitive integer protocol and
.NET-only replies subsequently passed a real process-present, process-absent
and warm-identity-stability exchange.

**How to apply:** Exercise the actual helper language as well as mocked child
events. Treat startup, first query and warm queries separately. This Linux
observation is not a Windows timing claim; native Windows cold-host acceptance
and compatibility with stored creation identities still need native evidence.


## Exclusive ownership publication completeness

Exclusive file creation does not establish complete identity metadata. Publish
ownership authority only after the record is fully written and its handle is
closed; preserve atomic no-overwrite semantics.

**Why:** An authenticated native Windows review reproduced process interruption
between exclusive open and write for both guard types. The resulting empty file
correctly failed identity-based recovery and required manual intervention.

**How to apply:** Abrupt-death tests must exercise visibility boundaries, not only
successful writes or caught exceptions. A non-authoritative staging remnant must
not grant recovery authority. New complete-publication guarantees do not justify
automatically deleting unknown or empty legacy ownership records.


## Hermetic Node temp-directory fixtures

On Windows, Node's os.tmpdir() uses TEMP and TMP, not TMPDIR. A hermetic CLI
fixture that places custody files in a private directory but supplies only
TMPDIR can look in the real user temp directory instead.

**Why:** An independent native run reproduced the same proof-harness failures
on unchanged source and the renewal snapshot. The new renewal fixture passed
because it already supplied all three variables; missing custody files were
test isolation failures, not evidence of broken product key handling.

**How to apply:** For synthetic child-process tests that rely on os.tmpdir(),
set TEMP, TMP and TMPDIR to the same private fixture directory, while continuing
to exclude ambient credentials and DB URLs. Verify native results separately;
baseline equality establishes no regression, not a passing test entrypoint.


## Disposable Windows validation policy

For disposable test-environment policy, see
[Windows validation environment](windows-validation-environment.md).
Windows Sandbox is optional for isolated testing, never a HolaHola product or
runtime requirement.

**Why:** A standing project requirement distinguishes disposable validation
facilities from dependencies that would restrict actual Windows users.

**How to apply:** Native Windows verification may use a disposable environment,
but product setup must not require Sandbox. Keep that policy with the other
Windows operational lessons; the linked topic retains the original detail.

