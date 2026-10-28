---
name: holahola-coordination-recovery
description: Restore HolaHola coordination access and the Replit coordination listener safely. Use when coordination credentials expire, the broker cache is missing, LCC messages are not arriving, a listener is offline after a workspace restart, or the user asks to get coordination creds and the listener back online. Diagnose login, listener ownership, and message delivery separately; preserve active holds.
---

# HolaHola coordination recovery

Use the existing broker, cache and listener tools. This skill is a recovery
runbook, not a new launcher or authority to change runtime permissions.
Start with diagnosis. Do not reset credentials or start processes just because
this skill was loaded.

## 1. Establish scope and holds

- Follow the current session-start runbook and read current application,
  listener, capture and publication holds. Do not infer that an old hold expired.
- Separate the requested actions: inspect status, recover the existing login,
  resume the coordination listener. Permission for one is not permission for all.
  An explicit request to bring both online can authorize both unless a standing
  hold still needs explicit release.
- Never restart the application, capture/backfill, change policies, enroll a
  new runtime, issue central grants or publish source as part of recovery.
- Use only this runtime's own identity. For Luca [Replit], the established
  binding is actor `luca-replit`, runtime `luca-replit-primary`, cache root
  `.local/coordination-cli-credentials`. Verify it against current configuration;
  do not silently substitute another hat, a home-directory cache or a new ID.
- Use the currently verified coordination API URL. The examples below use the
  established `https://getholahola.com` endpoint; recheck if configuration changed.

## 2. Inspect the cache without exposing credentials

From the repository root:

```bash
node --import tsx --input-type=module <<'JS'
import {FileCoordinationCliCredentialCache} from './server/services/coordination-cli-credential-cache.ts';
const actor = 'luca-replit', runtimeId = 'luca-replit-primary';
const cache = new FileCoordinationCliCredentialCache('.local/coordination-cli-credentials');
const row = await cache.load(actor, runtimeId);
console.log(JSON.stringify({
  actor, runtimeId, cachePresent: !!row, expiresAt: row?.expiresAt ?? null,
  expired: row ? Date.parse(row.expiresAt) <= Date.now() : null
}));
JS
```

Never print or read out the cache file, token, bootstrap, hashes used for
authentication, environment dump, request headers or secret-bearing errors.
Use the credential-cache API, not ad hoc JSON edits.

If the cache is valid, make one fresh cache-only broker probe:

```bash
node --import tsx --input-type=module <<'JS'
import {createCoordinationActorClient} from './server/services/coordination-actor-client.ts';
import {FileCoordinationCliCredentialCache} from './server/services/coordination-cli-credential-cache.ts';
const client = createCoordinationActorClient('luca-replit', {
  apiUrl: 'https://getholahola.com',
  credentialCache: new FileCoordinationCliCredentialCache('.local/coordination-cli-credentials'),
  environment: { COORDINATION_RUNTIME_ID: 'luca-replit-primary' }
});
try {
  await client.request('show', '/api/coordination/threads');
  console.log(JSON.stringify({brokerReadVerified: true}));
} catch (error) {
  const status = String(error?.message ?? '').match(/\((\d{3})\)/)?.[1];
  console.error(JSON.stringify({brokerReadVerified: false, httpStatus: status ?? null}));
  process.exitCode = 1;
}
JS
```

The explicit environment excludes both bootstrap and legacy authentication.
An ordinary probe can renew this runtime's existing credential and record normal
use/audit data; it does not reissue a bootstrap, create a grant or expand scopes.

### Interpret failure before choosing recovery

- A failed optional endpoint is not proof of an expired coordination login.
  If the core coordination probe succeeds, investigate that endpoint's own
  authentication/authorization instead.
- A renewal401 can mean another process advanced the shared cache. Inspect only
  expiry metadata, then try one fresh client against the same actor/runtime/cache.
  Do not reset a runtime whose fresh cache-only probe succeeds.
- Missing/expired credentials, consumed bootstrap, wrong API target, unavailable
  server and disabled runtime are different failures. Do not repeatedly retry
  the same failure, switch identities or fall back to a legacy actor token.

## 3. Recover only the existing login, when authorized

Obtain explicit founder authorization for a same-runtime credential reissue
unless a current standing authorization covers it. Explain that it writes shared
authentication state. Do not ask the user to paste a credential.

Use a reviewed operator recovery executor compatible with the **serving code and
actual shared schema**. The existing service operation is
`reissueCoordinationRuntimeBootstrap`; registering a replacement runtime is not
the recovery operation. Before using an executor:

1. Verify the exact runtime exists, belongs to this actor and is enabled/not
   revoked. Record non-secret identity, capabilities and enabled/revoked state.
2. Check schema compatibility read-only. Unpublished local broker changes can
   reference a column the shared database does not have.
3. If incompatible, use an independently established compatible recovery
   implementation or stop for a reviewed executor. Never apply the proposed
   migration, strip a guard or invent direct SQL auth writes to make recovery work.
   If using earlier source, verify its provenance and exact bytes; do not assume
   a temporary `.local/` script or an old commit is still safe.
4. Keep the one-time bootstrap in process memory. Exchange it for this exact
   runtime and save only through the established credential-cache implementation.
5. Compare identity, capabilities and enabled/revoked state before/after.
6. Prove a second, fresh cache-only client works with no bootstrap or legacy
   fallback. A successful bootstrap exchange alone is not this proof.

Do not confuse a working login with a running listener.

## 4. Inspect and, only if allowed, resume the listener

- Inspect the canonical boot status:
  `node --import tsx server/scripts/coordination-listener-boot.ts status`.
  A missing status file is an observation, not permission to delete state.
- Cross-check actual processes and ownership using the existing listener
  status/identity tools. A PID or stale status file alone is not proof of life.
  Do not dump process environments or secret-bearing command arguments.
- Read the current approved boot binding, runtime/PATH and launch guards.
  Reuse the existing approved startup chain, including
  `server/scripts/coordination-listener-boot-diagnostic.sh` and the boot supervisor.
  Do not overwrite a locally approved hook with a different main-branch version.
- Preserve the actor/API-scoped state directory, cursor, local receipts and
  parent-process creation identity. Use existing resume/ownership handling.
  Do not manufacture `--after`, run duplicate owners, use manual `&`/`nohup`,
  or delete locks, guards, receipts or cursor files.
- If direct listener CLI use is appropriate, first read its current arguments in
  `server/scripts/coordination-listener.ts`. `--parent-pid` must identify the
  actual living owner; do not copy a PID from a previous session.
- Launch broker-only: listener and CLI must share the exact runtime/cache.
  The cache override is `COORDINATION_CLI_CREDENTIAL_CACHE_DIR`.
  Exclude `COORDINATION_LUCA_REPLIT_TOKEN` and
  `COORDINATION_RUNTIME_BOOTSTRAP_TOKEN`; a retained legacy secret for other
  operations is not a reason to let this listener use it.
- If a listener hold remains, leave it stopped and report that plainly.
  Directly read the current coordination thread/inbox to catch up; this is not
  a listener restart. Do not leave messages unread while debating the hold.

## 5. Verify and report the three results separately

Report:

1. **Login:** cache-only request verified, or the precise remaining blocker.
2. **Listener:** running and ownership verified, stopped by hold, or failed.
3. **Delivery:** actual canonical event/thread read and, separately, any proven
   listener notification. Preserve author and sequence; acknowledge messages in
   the canonical thread when appropriate. Readability is not remote read-ack.

Record non-secret receipts and the exact actions taken. Do not claim continuous
delivery from a single successful read. Renewal continuity needs observation
beyond the original credential expiry and a later fresh own-client read.
Do not stop the only renewal process merely because a review finished.
If capture is held, any separate renewal-only process requires its own permitted
launch; do not use credential continuity as a reason to restart held capture.
No cache placement or running listener guarantees recovery after arbitrary
downtime, cache loss or server outage.

## Maintenance and safety checks

Keep this project-local skill as the recovery entry point, not a duplicate
session-start checklist. Update command examples if canonical tooling changes.
See `evals/evals.json` for non-live scenarios. Do not run privileged recovery or
start a real listener as a skill evaluation.
