# Replit listener-only boot recovery

The reviewed startup design uses the top-level `.replit` entry:

```toml
onBoot = "node --import tsx server/scripts/coordination-listener-boot.ts"
```

The hook must land through the founder-reviewed PR. Do not enable it by
changing the Run button or starting the existing `Project` workflow.

## Scope

Only the coordination inbox listener is launched. It uses the existing
project-local, Git-ignored credential cache for `luca-replit-primary`.
The child environment is allowlisted: it receives neither the bootstrap or
legacy actor token nor database, model-provider, GitHub or SSH credentials.
The existing inbox transport can use the cached broker credential and renew
it; it cannot execute message content.

The boot launcher returns after spawning a detached supervisor. The
supervisor is the real long-lived parent of the listener child. A separate
creation-identity lock prevents duplicate supervisors; the existing
listener ownership guard still prevents duplicate listeners. A live manual
listener is left alone. Unknown identities or stranded guards fail closed.
No automatic guard recovery or repeated child restart loop is added.

## Status and deliberate stop

```sh
node --import tsx server/scripts/coordination-listener-boot.ts status
```

Status is under `.local/coordination-listeners/luca-replit/boot/`.
`supervisor-launched readiness=unverified` does not prove inbox access.
`listening` requires a fresh successful-fetch heartbeat from the actual
identity-matched child. Inspect current process identity and heartbeat age
as well: a persisted status alone cannot establish present health.

Sanitized terminal failures are in `failure-<pid>.json`; supervisor output
is in `supervisor.log`. No raw exceptions, environment, cache contents or
remote response bodies are logged. The `status` command is read-only,
including when its status file is missing.

To explicitly disable startup and stop the listener:

```sh
touch .local/coordination-listeners/luca-replit/boot.disabled
node --import tsx server/scripts/coordination-listener.ts stop \
  --actor luca-replit --url https://getholahola.com \
  --state-dir .local/coordination-listeners/luca-replit
```

Both `boot.disabled` and the existing `stop` marker are honored. Re-enabling
requires deliberate removal of those markers after the operator confirms
that polling is wanted and recovery prerequisites are satisfied. Automatic
startup never uses `--resume` to clear a stop.

## Verification and limits

Hermetic tests use disposable local cache/state and a synthetic child:

```sh
node --import tsx --test server/scripts/lib/coordination-listener-boot.test.ts
npm run typecheck
```

They do not call the broker, application, database or validation workflows.
They prove launcher detachment, a real supervisor parent, deduplication,
stop and disable handling, cache failures and readiness evidence.

They are not the real Replit boot proof. After approved PR landing, record
workflow/writer absence and valid-cache metadata, then perform a
founder-controlled Restart compute. Before any manual listener launch,
inspect the new supervisor/child identities and post-boot successful inbox
fetch. Confirm no held application, validation, capture or canonical-save
service started. Missing dependencies must fail; never install at boot.

Compute cannot renew while stopped. Missing, invalid or expired cache
requires authorized recovery; there is no bootstrap/legacy fallback.
Auto-start reduces relaunch delay but cannot recover after arbitrary
downtime. A running poller also does not prove an inactive Agent receives
or acts on notifications. Neither this hook nor its verification permits a
deploy-key deletion, signer rotation, external service or deployment.
