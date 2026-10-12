## Backgrounding a process: always use the tool's own run_in_background

Never append a manual trailing `&` to a command string passed to the shell-exec tool's own
`run_in_background: true` option, and never rely on a manual `nohup ...  &`/`disown` alone
(without `run_in_background: true`) to survive past the end of the current call. Both mistakes
have independently reproduced multiple times:

**Combining `&` with `run_in_background: true`:** `run_in_background: true` already runs the
given command as the tracked background task and returns a task id immediately — that IS the
backgrounding mechanism. Adding your own `&` on top makes the *tracked* process just a launcher:
it forks the real command into a second, untracked detached process and then exits right away
(falling through to any trailing `echo`/etc.), so the tool immediately reports the tracked task
as "exited with code 0" while the real work is still starting up. The child can then be silently
orphaned/reaped along with the launcher's process group — confirmed by re-running the identical
command without the manual `&` and seeing it behave correctly (log file populated, `ps aux` shows
it alive) where the double-backgrounded version left no process and no log output at all.

**Manual `nohup ... &` instead of `run_in_background: true`:** a plain shell-exec call (no
`run_in_background: true`) that itself runs `nohup some-long-command > log 2>&1 &` and then
returns does NOT leave that command running — the log file is never created and no process
survives past the call. Confirmed directly: `bash server/scripts/run-validation-suite.sh >
/tmp/out.log 2>&1 &` issued inside a plain (non-backgrounded) call produced no log file and no
live process once the call returned; re-issuing the identical plain command (no `nohup`, no
trailing `&`) through the tool's own `run_in_background: true` parameter worked correctly instead.
The same teardown hits `pg_ctl -D <datadir> ... start` (which daemonizes/detaches the postmaster
itself) run inside a normal foreground call — it reports "server started" successfully but is
gone by the next call, with a clean "database system was shut down" in its own log. The sandbox
appears to tear down the whole process group when a foreground shell call completes, regardless
of what the child itself did to try to detach.

**The tell when this has happened:** `ps aux` shows no matching process at all (not even a
zombie) after a call that *appeared* to background something has returned — no error, no crash
log, just silence and zero further log growth.

**How to apply:** when a command needs to run in the background, pass the plain command (no
`nohup`, no trailing `&`) with `run_in_background: true` and read its state via `Monitor`/the
background-task-end notification/its log file. Never combine the tool's backgrounding with
shell-level `&`, and never substitute shell-level `nohup`/`&`/`disown` for it.


## Standing up a disposable local Postgres

Postgres 16.x binaries are already available via the nix store (find them with e.g.
`find /nix/store -maxdepth 1 -iname '*postgresql-16.1*'` then use `<store-path>/bin/`). This
makes it possible to fully replicate GitHub Actions' `test-unit`/`test-guards`
local-Postgres-service setup (`postgresql://postgres:postgres@127.0.0.1:5432/<db>`, `CI=true`)
for manual verification instead of waiting on a real CI run.

**Recipe:** launch Postgres itself (not `pg_ctl` — see the backgrounding topic above for why)
as a genuine backgrounded task: ShellExec with `run_in_background: true` running
`postgres -D <datadir> -p <port> -k /tmp -h 127.0.0.1` directly. Then use a separate foreground
call (or `Monitor` on the background task's log for "ready to accept connections") to `createdb`,
run `drizzle-kit migrate` (point `NEON_SHARED_DATABASE_URL` at the instance), and run the target
test file with `CI=true CI_DATABASE_URL=... NEON_SHARED_DATABASE_URL=...` (all three must satisfy
`server/ci-database.ts`'s `getVerifiedCiDatabaseUrl` gate: loopback host, and
`NEON_SHARED_DATABASE_URL` exactly equal to `CI_DATABASE_URL`). Tear down with `ShellKill` on the
background task (or a clean `pg_ctl ... stop` first) and remove the scratch data directory.

**Omitting `CI=true` fails silently, not loudly:** setting `CI_DATABASE_URL` and
`NEON_SHARED_DATABASE_URL` to a local disposable instance without also setting `CI=true` does not
fail loudly. `server/db.ts`'s `getDb()` only routes through the plain `pg` driver when
`server/ci-database.ts`'s `getVerifiedCiDatabaseUrl()` returns a value, which requires
`CI==='true'` **and** `NEON_SHARED_DATABASE_URL===CI_DATABASE_URL` together — both conditions, not
just a matching URL. Omit `CI=true` and it silently falls through to the
`@neondatabase/serverless` driver, which speaks a different wire protocol than plain Postgres and
produces an unrelated-looking, mismatched error shape instead of a clean connection failure —
looking exactly like a cascade of application-level test failures. Always set all three
(`CI`, `CI_DATABASE_URL`, `NEON_SHARED_DATABASE_URL`) together.

**Check for an existing local-DB test harness before hand-rolling one:** before manually
following the recipe above, check `package.json` for a `test:*-local`-style script (e.g.
`test:coordination-ledger`, backed by `scripts/run-coordination-ledger-local.mjs`) — several test
families already have a one-shot script that stands up a disposable local Postgres, applies
migrations, seeds fixtures, runs the full relevant test suite (including any CI self-checks), and
tears everything down automatically. These scripts spawn Postgres directly as a real child
process (not `pg_ctl`/`nohup` in a foreground shell), so launch them with your own shell tool's
true background-task support rather than a trailing `&`. Prefer an existing script like this over
the manual recipe whenever one matches the area under test; fall back to the manual recipe only
where no such harness exists. If a Neon-branch-gate (or similar) job dies mid-run from the
backgrounding mistake above, check `neon-branch.ts list` for an orphaned `test/migration-*`
branch and delete it before retrying — the gate's own cleanup step never got to run.


## ss is unavailable -- use lsof for port checks

`ss` is not installed in this Replit container's shell (`bash: ss: command not found`). If you
check a listening port with `ss -ltnp 2>/dev/null`, the `2>/dev/null` swallows the "command not
found" error and you see empty output indistinguishable from "nothing is listening" — a healthy,
actively-serving process can look crashed.

Use `lsof -i :<port>` instead (confirmed available); it reports `LISTEN` and any `ESTABLISHED`
connections directly. If you do try `ss` or `netstat`, run it with `2>&1` (not `2>/dev/null`) at
least once so a missing binary surfaces as visible text instead of silent empty output.

This surfaced while verifying a workflow restart after a schema migration: two differently-named
`Start_application_*.log` files (both starting with the same one-time boot preamble) briefly
looked like a crash-and-retry, and an `ss` check with stderr suppressed then looked like
confirmation. `lsof -i :5000` plus `ps aux` plus a `curl` 200 showed the single real process was
healthy the whole time — the WorkflowsRestart tool's own success return already meant the
platform had confirmed serving; the extra log archaeology was true but non-essential given that
guarantee.


## A workflow's 'finished' status can arrive with the log tail truncated

Observed running the "Validation suite" workflow (`run-validation-suite.sh`, ~110+ chained
checks, run-to-completion script rather than a persistent server). Polling with RefreshAllLogs
showed steady progress with zero failures, then a later poll reported the workflow status as
"finished" with "no new content" to drain — but the most recent drained snapshot file's tail
stopped mid-check: a check header had printed, its result line never appeared, and the script's
own trailing summary ("ALL VALIDATION SUITE CHECKS PASSED", always printed on exit 0) was missing
entirely. Reading that exact file directly from disk (bypassing RefreshAllLogs' incremental
"since last cursor" semantics) showed the same truncated tail, and no further snapshot file
appeared even several minutes later.

**Why:** the workflow status tracker (which reports "finished"/exit code) and the
log-drain-to-file mechanism are not perfectly synchronized for process-style (run-to-completion)
workflows. The last buffered stdout chunk written at/after process exit can be dropped from the
snapshot files even though the process supervisor correctly recorded completion. `ps aux`
confirmed no process for the script or any of its sub-checks was still running, which ruled out a
genuine hang and pointed at a log-capture artifact instead.

**How to apply:** if a script-workflow's drained log tail ends abruptly mid-check while its
status already reads "finished" (not "running"), do not assume a hang or silent failure, and do
not immediately re-run the entire (possibly many-minutes-long) suite from scratch to find out
what happened. First confirm via `ps aux` (and `lsof -i :<port>` for any port the check might
bind) that nothing from the suite is still executing. If genuinely stopped, read the runner
script to identify exactly which check(s) after the last captured line remain unconfirmed, and
directly re-invoke just those specific check commands via ShellExec to get their real pass/fail
result. That is far cheaper than a full re-run and, combined with the zero-failures evidence
already captured up to the truncation point, is just as conclusive.


## Ambient sandbox tools/secrets are absent in CI

Replit's nix-based dev sandbox ships tools and ambient secrets that a bare CI runner does not. Code or tests that implicitly depend on either will pass locally every time and fail only when run in the other environment. The failure is not flaky; it is a real environment-parity gap that surfaces as soon as the right code path is exercised there.

**Why:** Two confirmed instances in the same investigation. (1) ripgrep (rg) is present by default in the Replit nix sandbox but absent from GitHub's ubuntu-latest runner image, so a test that forces the rg-available branch of a search tool (to prove parity with its own JS fallback) only fails on GitHub. (2) SESSION_SECRET is always set as an ambient secret in the Replit sandbox, so a service (coordination-inbox-service.ts) that signs tokens with COORDINATION_INBOX_TOKEN_SECRET || SESSION_SECRET and requires >=32 chars never hits its own "not configured" error locally, but GitHub Actions' job env sets neither.

**How to apply:** When a test or code path only fails in GitHub Actions (or any external CI) and passes locally on Replit, suspect an ambient-tool or ambient-secret gap before suspecting flakiness or a logic bug. Fix by making the CI environment match the real contract (install the missing tool in the workflow) when the dependency is legitimate infrastructure, or by generating a disposable/run-scoped value inside the test harness itself (matching how disposable test databases are already generated) when the dependency is just a signing/config secret that a hermetic test run shouldn't need to share with the real app.

## Coordination-inbox activation required for real-notification-sink Postgres tests

## A real coordination-inbox-backed notification sink needs the inbox activated, not just migrated

A Postgres-gated test that goes through the *real* `getHolaHolaSharedSpecNotificationSink()`
(or any other real notification sink backed by `coordination-inbox-service.ts`) needs more than
`drizzle-kit migrate` against a fresh disposable database. `assertSupportedWriterActivation()`
requires a `coordination_inbox_activation` row with `state = 'active'`; a freshly migrated
database has this row in a non-active state (e.g. `'preparing'`), so any recipient-addressed
write throws `'Coordination inbox is not active and recipient-addressed writes are paused'`
even though every other precondition (reviewer policy, document/revision fixtures, git working
tree) is correctly set up.

**Why:** the two real invocation paths for this class of test already guarantee activation
without the test file doing anything itself: GitHub Actions' job-local database is seeded by
`server/scripts/setup-ci-test-database.ts`, which calls `activateCoordinationInbox()` as its last
step; and `scripts/neon-branch.ts`'s migration-gate branch is created `from: 'production'`, so it
inherits production's already-active row. A hand-rolled disposable Postgres (e.g. the recipe
above) gets neither for free.

**How to apply:** when manually verifying a Postgres-gated test that exercises a real
notification sink end to end, run `CI_DATABASE_URL=... NEON_SHARED_DATABASE_URL=... npx tsx
server/scripts/setup-ci-test-database.ts` against the scratch database before running the test
(mirrors real CI exactly; harmless unrelated fixtures aside). That standalone script does not
call `closeDbConnections()` after its own `activateCoordinationInbox()` call and can appear to
hang the shell past its actual completion -- check the `coordination_inbox_activation` row
directly (or just proceed to the next command) rather than assuming the activation didn't happen.
Tests that only exercise a fake/stub notification sink (most existing shared-spec Postgres tests)
never hit this gate and need no such step.


## PowerShell module discovery on Nix

PowerShell module auto-discovery in this Nix sandbox can traverse the entire Nix store and make even a trivial command time out. Disabling module auto-loading and explicitly loading only the required standard modules by their exact PSHOME paths avoids the scan without changing execution policy.

**Why:** A trivial output command repeatedly timed out; a syscall trace showed mass directory enumeration under the store. Direct console output with auto-loading disabled succeeded, and the hermetic suite completed after explicit standard-module imports.

**How to apply:** For local PowerShell test runners on Nix, distinguish a module-discovery timeout from script failure. Keep this workaround in the local test invocation only; do not add execution-policy overrides or change native Windows recovery behavior.


## PowerShell runtime startup availability

Installing a PowerShell runtime does not establish that it can execute fixtures in a Replit Linux workspace. Verify a trivial noninteractive command before relying on it. If startup hangs independently of the project script, classify fixture execution as unavailable rather than treating a source check as an execution pass.

**Why:** On October 5, 2026 the Nix PowerShell 7.4 runtime hung before emitting output even for a trivial command; reduced processor count and a minimal environment did not restore startup. The project diagnostics fixture could not be executed locally.

**How to apply:** Separate runtime availability, synthetic fixture execution and native Windows PowerShell 5.1 verification. Never infer the latter from either package installation or Linux execution; it remains behind its separately authorized Windows path.


## Implicit shell exec invalidates parent binding

A noninteractive shell can implicitly exec its last command. Passing its `$$`
to that last Node command may therefore record Node itself as the parent,
even without an explicit `exec`.

**Why:** The actual ownership record showed equal listener and parent PIDs
under the original background launch. Keeping a trailing exit-status capture
and shell exit produced two distinct, creation-verified live processes.

**How to apply:** When a listener must track its waiting shell, launch Node
followed by `listener_exit=$?; exit "$listener_exit"`. Verify owner and parent
PIDs differ and both creation identities are present before reporting a valid
wrapper-bound launch. This still does not establish attended chat-session state.


## Restart loss of temporary ownership custody

Workspace restarts can discard the temporary ownership-key custody directory
while durable challenge rows and local request records remain.

**Why:** After a reported workspace restart, the message-listener process/log
was lost and the previously used ownership private-key files were absent at
Node's current temp-directory custody path. The surviving request record could
not supply the missing private key.

**How to apply:** After a restart, check key-file existence before promising a
renewal or proof. Do not read or display private key contents during diagnosis,
and never regenerate a missing key as a retry workaround. Recover original
custody if available, or obtain explicit authorization for new custody and a
fresh founder-approved request; that is not renewal of the old key binding.

