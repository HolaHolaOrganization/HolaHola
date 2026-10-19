# Listener boot boundary diagnostic — prepared, not activated

This diagnostic is limited to the Replit coordination listener. It does not
change application startup, deployment, broker policy, credential custody,
listener ownership, cursor handling, retries or the live process holds.

The current listener was restored manually after a failed actual restart
test. The reviewed default launcher also failed to leave a surviving detached
supervisor when invoked manually. Direct `supervise` under a persistent native
background task worked. These observations do not establish a platform cause.

## Candidate hook (requires exact-source independent review)

```toml
onBoot = "/bin/sh /home/runner/workspace/server/scripts/coordination-listener-boot-diagnostic.sh"
```

This line is prepared in the PR only. Do not replace the active workspace
hook, start the wrapper against live state or restart compute just to prepare
the diagnostic. Existing manually restored listener and holds stay unchanged.

The exact candidate line is also in
`server/scripts/coordination-listener-boot-diagnostic.onboot.toml` and pinned
by a focused test. The absolute path is deliberate: startup's working directory
is not assumed to be the workspace. CI checks the actual PR `.replit` against
this template; local tests leave the active hook untouched.

## Design and privacy

The fixed-target POSIX shell wrapper accepts no arguments. It creates a private
per-invocation directory under
`.local/coordination-listeners/luca-replit/boot/diagnostics/`, already ignored
by Git, and records only UTC time, a fixed phase and PID in `events.log`.
It records `shell-invoked`, then `node-exec-attempt`, or `node-unavailable`
when Node cannot be resolved. It execs the existing launch command without
waiting, piping, changing launch mode or adding a restart loop.

An opaque directory basename opts the direct launcher into a fixed `node-entry`
marker after its imports load. The helper verifies the expected canonical
local path, owner, private permissions and an existing regular non-symlink,
single-link append target. It never creates a substitute file. A marker failure
prints only a fixed warning and leaves the launcher's actual result unchanged.
No tag means no diagnostic write. `status`, imported modules and direct
`supervise` remain uninstrumented. The existing child-environment allowlist
drops the opt-in tag.

No credentials, environment dumps, arguments, arbitrary output, raw exceptions
or remote response bodies enter the records. Node output remains on its
original streams; this change does not capture it.

An exec wrapper was selected instead of a waiting parent/output pipeline
because those alternatives could change the lifetime being investigated.
Alden approved the corrected listener-only design before implementation;
Luca [Claude Code] must independently review the exact source before activation.

## Evidence interpretation

- `shell-invoked`: the shell reached its successful marker write.
- `node-unavailable`: Node could not be resolved using that invocation's PATH.
- `node-exec-attempt`: shell reached the exec attempt; this does NOT prove exec
  succeeded or that the process survived.
- `node-entry`: the actual launcher CLI completed its imports and reached the
  direct launch entry. This does NOT prove supervision, readiness or survival.
- No marker is ambiguous: absent invocation, failed shell/tool/path lookup,
  local permissions or failed writes are all possible.

Compare same-invocation PIDs and times with current process creation identities,
supervisor/child parentage and a fresh successful inbox-fetch heartbeat. Old
files and spawn acknowledgements are never current liveness proof. Manual
invocation is always manual recovery, even if a reused protocol says post-boot.

Read the markers together with supervisor lock/log state, not in isolation.
After diagnosis and a reviewed retirement decision, retain any needed evidence
and remove only obsolete diagnostic invocation directories with no invocation
in flight. Never remove listener cursors, receipts, ownership guards or caches.
There is no automatic pruning or diagnostic retirement in this change.

## Verification and activation boundary

```sh
node --import tsx --test server/scripts/lib/coordination-listener-boot-diagnostic.test.ts
node --import tsx --test server/scripts/lib/coordination-listener-boot.test.ts
npm run typecheck
```

Tests use temporary synthetic roots, fake Node executables and a copied CLI
status operation; they do not access live credentials, listeners or databases.
The normal CI registry includes the focused test. Held validation workflows
must not be started for this work.

After exact-source independent review and founder activation authorization,
copy only the approved hook through schema-validated configuration replacement.
Then perform one founder-controlled restart and inspect diagnostic boundaries,
current listener identities, fresh inbox fetch and held-service absence before
any manual restoration. This diagnostic does not itself fix automatic startup.
