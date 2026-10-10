# Luca session notification operations

The central delivery design is independently approved in shared-spec:
document `69668936-2c4b-454a-9175-85939dc2166a`,
revision `3a025a66-c3c9-4cd7-bf41-b779b7f8c81e`,
review `f61491b6-cbdc-41cc-b87c-e50edb510703`.
This operating guide implements that contract; publication and execution
authority are separate. No schema, credential, platform-hook or model-launch
changes are required.

The slow-host reader and lifecycle observer were built directly in the main
Replit session. LCC approved source snapshotbca30648 and reported57 passing
native Windows tests, CIM identity equivalence and normal cold/warm query timings.
The subsequent atomic guard-publication fix has66 passing local tests and
requires targeted review; the older approval does not cover its changed bytes.
Desktop close/archive and the unusually slow CI cold-runner case remain unproven.

## Policy for every hat

Listen to the authenticated recipient's **whole canonical inbox** throughout
the active working session, not just one review or task. Before yielding:

1. Read newly notified threads with the existing coordination CLI.
2. Mark each receipt **observed** if a reply/work is still owed, or **processed**
   if intake is finished. Observed receipts remain visible but do not wake you
   repeatedly. Track the work separately; do not silently delete owed replies.
3. Re-arm the runtime's supported notification mechanism and record its native
   task ID. If arming fails, report the failure; do not claim notification.
4. Review `status` for observed-but-open work, stale health, and incomplete
   legacy coverage.

Inbox storage, notification availability, a runtime event actually observed,
finished intake, and a substantive response are different states. None grants
execution authority. This listener never remotely acknowledges a window.
Use `ack-inbox` separately only after processing the complete exact paged
window, as described in `docs/coordination-clients.md`.

Only Replit's monitor adapter and Claude Code's completion adapter have active
runtime evidence. Another hat must verify its own supported mechanism before
claiming automatic awareness. Durable offline replay is supported; waking an
ended session is not established.

## CLI and credentials

Run from the checkout root with the existing installed `tsx` dependency:

```text
node --import tsx server/scripts/coordination-listener.ts <command>
  --actor <your-own-actor> --url <coordination-api-origin>
  --state-dir <runtime-local-directory> [command options]
```

Always pass actor, API origin and state directory explicitly. State is bound
to the actor and origin. Use a separate directory for each runtime; do not
share a local cursor across hats or origins. Keep it under ignored `.local/`.
Authenticated API transport uses the existing `coordination-cli`, its inherited
runtime environment, and `FileCoordinationCliCredentialCache`. Credentials never
appear in listener logs or local receipts. No new `.env` or credentials are
created. Windows may launch Node with its existing approved `--env-file` option
if that runtime needs it; do not put secrets in command arguments.

Commands:

| Command | Extra options | Meaning |
|---|---|---|
| `listen` | `--mode continuous\|once --parent-pid <stable-parent> [--after <initial-sequence>] [--resume]` | Intake/notify until new receipts, explicit stop, parent absence or failure |
| `status` | none | Cursor, all pending/observed receipts, coverage, health and reported arming |
| `observed` | `--event-id <UUID>` | Retain open work without re-firing |
| `processed` | `--event-id <UUID>` | Remove exactly one finished local receipt; no remote ack |
| `arming` | `--state armed\|unarmed --task-id <native-task-id>` | Record runtime report only; not proof of awareness |
| `stop` | none | Persist stop request; new listens require explicit `--resume` |
| `recover-lock` | none | Remove abandoned listener lock only when owner creation identity is confirmed absent |
| `recover-guard` | none | Recover abandoned guard/recovery markers only after confirming owner absence |

`--after` is required only for a fresh directory. Read the existing runtime's
saved position explicitly when migrating; never invent a new high-water to
discard unread history. Existing scoped state always resumes its saved cursor.
Unscoped historical state fails closed: preserve it and migrate into a new
directory with a verified boundary, carrying any unfinished receipts.

The listener stores body-free receipts before updating the fetch cursor,
replays in ascending sequence, and makes duplicate event writes idempotent.
Self-authored receipts are retained but do not trigger notifications.
Interrupted pagination keeps the original cursor. Observing/removing a receipt
does not change that cursor.

## Replit adapter

Start **one** `continuous` listener via the platform's background shell tool.
Within that command, pass the persistent task wrapper PID, for example the
shell's `$$` while it waits for Node (do not replace that shell with `exec`).
The listener records and checks its creation identity.

Arm a one-shot platform monitor on that exact background task ID:

```text
^LUCAMSG_(ALERT|ERROR|FATAL|PARENT_GONE|STOP)
```

When it fires, mark arming unarmed, inspect the outcome and `status`, fetch the
threads, mark/remove the corresponding receipts, and arm the monitor again on
the same still-running task before yielding. Record reported arming only after
the platform accepted the monitor call. Monitor only matches future output;
inspect status for messages emitted before arming. New pending alerts repeat
while listening so an unarmed gap does not silently erase them.

There is no review-completion or two-hour expiry. Stop explicitly at session
shutdown or an intentional pause. The task-wrapper process is **not evidence
the chat session remains active**: this adapter cannot independently determine
whether Replit has ended an Agent conversation. Heartbeat proves neither an
armed monitor nor model awareness.

## Claude Code adapter

Use **one foreground `once` listener** launched by the native background-task
tool. It performs its own intake loop; no detached continuous process/waiter
pair. Output while it is running is not the completion notification.

Discover the nearest ancestor agent CLI whose executable path contains
`\claude-code\`; capture its PID and CIM `CreationDate`. Pass that PID explicitly.
Refuse if this agent ancestor cannot be identified; never fall back to the
long-lived desktop app or assume the immediate Bash wrapper is session-scoped.
No hard-coded PID survives a session restart.

The listener captures creation identity and exits when the agent process is
confirmed absent/reused. Unknown identity cannot authorize lock recovery.
Process existence does not establish attended/archived-session state; that
desktop lifecycle behavior is unverified.

On native completion, inspect the body-free outcome line and exit code:

| Code | Outcome |
|---|---|
| `0` | New pending receipts available; inspect threads |
| `64` | Invalid input/state or unproven startup identity; repair, do not blindly re-arm |
| `70` | Six consecutive intake failures; investigate |
| `71` | Captured parent is gone/reused; session-bound wait ended |
| `72` | Explicit stop/signal |
| `73` | Listener lock already held; inspect the existing owner |
| `74` | Ownership guard/recovery marker blocks intake; inspect before explicit recovery |

Mark pending receipts observed/finished **before** starting the next once-wait.
Starting a once-wait with new pending receipts intentionally returns immediately;
starting with only observed open receipts waits for a new message. Record the
new native task ID after each re-arm. This is an operating rule, not an installed
Stop hook: `.claude/settings.json` and user-wide configuration remain unchanged.

## Failure and recovery

Intake subprocesses have a 45-second deadline and 4-MiB stdout limit. Stderr is
not echoed. Nonzero/timeout/malformed/oversize output, invalid windows, cyclic
continuation and failed writes are visible failures; six consecutive failures
end intake. Successful complete intake resets the count.

Atomic replacement retries Windows `EPERM`, `EBUSY`, and `EACCES` at most five
times (25/50/100/200-ms delays). Exhaustion cannot advance an unwritten cursor.
An error after a cursor has successfully persisted can affect heartbeat
publication, but does not reverse durable intake.

Exclusive `watch.lock` records owner PID/creation identity and parent identity.
Do not delete a lock because a heartbeat is old. First inspect its metadata and
query the owner. `recover-lock` refuses live, unknown, unscoped or malformed
identity; it serializes with new listener acquisition using `ownership.guard`.
Missing creation evidence is not permission to guess. A leftover ownership
guard from a hard crash is reported separately as code74, never as a confirmed
live listener. Its metadata includes owner PID and creation identity.
`recover-guard` recovers it only after confirming absence. Live, unknown,
malformed or legacy identity is refused. Unique identity-bearing recovery
markers prevent concurrent recovery from deleting a newly acquired owner's
guard; abandoned markers are recovered explicitly by the same command.
There is no automatic timestamp-based deletion.
Preserve cursor and receipt files in all recovery paths.

Guard and recovery-marker identity records are now completely written and closed
in a unique same-directory staging file, then exclusively hard-linked to their
final name. No overwrite/rename fallback is allowed. The final name is therefore
absent or contains complete metadata after a process crash, never newly empty.
Normal cleanup removes only the caller's unique staging file. A hard kill may
leave a `.tmp` file, but it is not an authoritative guard/recovery marker and does
not block intake. Existing empty/identity-less legacy guard files still fail
closed; this fix never automatically deletes them.

`status` reports recent/stale/stopped heartbeat health separately from
`reportedArming`. A reported-armed task ID is self-reported runtime evidence,
not independently verified monitor state or reading. Coverage dimensions remain
separate: core inbox completeness does not repair truncated historical legacy
notes. Pending and observed receipts survive stop, failure and restart.

## Verification

The portable suite is registered in consolidated CI:

```bash
node --import tsx --test server/scripts/lib/coordination-listener.test.ts server/scripts/lib/coordination-listener-transport.test.ts
npm run typecheck
```

Tests cover scope isolation, fixed windows, receipt-before-cursor ordering,
interruption/replay, observed-not-refired, self-notification suppression, parent
identity/PID reuse/unknown, distinct exits, lock recovery, Windows write retries,
retry exhaustion, explicit stop/resume and non-timed session lifetime.
Heartbeat is updated on every validated page, not just after a multi-page
window completes. The 90-second stale label means no recent heartbeat, not proof
of failure. `parentIdentity` also records present/absent/unknown independently of
heartbeat age.
Synthetic Windows contention tests are not native Windows coverage; retain
LCC's exact-source native receipts separately.

## Slow Windows process-query handling

The reader now owns one persistent PowerShell worker, rather than starting a
new PowerShell/CIM query for every PID. A bounded cold-start handshake has a
60-second maximum; each warm query has the existing 10-second maximum. These
are configured safety caps, not measured Windows startup promises.

The worker uses native .NET process lookup and start time without CIM or JSON
cmdlet autoloading. Integer requests are serialized and correlated by unique ID;
no PID identity is cached. UTC creation strings preserve the former CIM
microsecond precision. LCC reported byte-equal native CIM comparisons for his
agent CLI and two fresh processes on the previously approved reader bytes.
First query261ms; ten warm queries5ms total. Those are observed normal-host
results, not worst-case promises. The unusually slow CI cold startup was not
reproduced. Protected process StartTime denial yields unknown, not absence.

Malformed/cross-correlated output, access failures, timeout, oversized output,
or startup failure yield **unknown**, never absence. Only the specific native
not-found result establishes absence. A failed worker is terminated through its
own child handle and a later query can restart it. It cannot kill the queried
parent or recover a lock on unknown evidence. Queue length and output are
bounded; an idle worker cannot hold its Node CLI open. No execution-policy flag,
saved host setting, new credential or desktop hook is installed.

Additional suites, also registered in consolidated CI:

```bash
node --import tsx --test server/scripts/lib/coordination-listener-windows-reader.test.ts server/scripts/lib/coordination-listener-lifecycle.test.ts server/scripts/lib/coordination-listener-ownership.test.ts
```

Ownership tests kill real disposable children at open-before-write,
complete-before-link and after-link boundaries for both guard and recovery marker.
They verify complete-record recovery through actual native creation-identity
queries, nonblocking staging remnants, preservation of existing final/staging winners and
cleanup after partial-write/link failures. Windows review of this follow-up is
separate from the earlier native57-test approval.

## Native Desktop closure/archival evidence

`server/scripts/coordination-listener-lifecycle-probe.ts` is a **read-only
observer**, not a Desktop controller. It never creates a session, launches a
model, archives a conversation, kills an application, or mutates listener state.
Run it in a separate terminal that remains open when Desktop closes, against an
already-authorized disposable session and its actual scoped listener directory.
Do not close a founder's live session as a test.

From the checkout root, replace the state directory below with the existing
runtime's directory. Use new action/output names for each closed/archived run:

```powershell
node --import tsx server/scripts/coordination-listener-lifecycle-probe.ts observe --actor luca-claude-code --url https://getholahola.com --state-dir .local/lucamsg-listener --action-file .local/lifecycle-checks/closed.action.json --output .local/lifecycle-checks/closed.evidence.json
```

Wait for `LUCAMSG_LIFECYCLE_READY`: the captured listener and parent must both
be live with matching PID/creation identity and a clear guard. Then perform the
actual authorized close/archive action in Desktop. In another independent
terminal, mark that action:

```powershell
node --import tsx server/scripts/coordination-listener-lifecycle-probe.ts mark --action closed --action-file .local/lifecycle-checks/closed.action.json
```

For archival, use `--action archived` and fresh `archived.*.json` paths. Action
publication is atomic and refuses overwrites. It is explicitly
**operator-reported**, not independently verified Desktop telemetry.

The observation window defaults to two minutes, configurable with
`--timeout-ms` from 10 seconds to five minutes. In-flight bounded identity queries
can extend that window; the report discloses this. This is a measurement deadline,
not a listener lifetime expiry.

Evidence contains body-free process samples, exact ownership binding, cursor
and pending counts, host platform and checkout source hashes. Hashes describe
the observer checkout, **not** an attestation of the already-running listener's
loaded code. No credentials, message bodies or process command lines are saved.

- Exit0 / `parent-gone-listener-clean`: captured parent and listener both absent,
  captured lock missing, guards clear and cursor not regressed.
- Exit2: retained listener, unknown identities, changed owner, incomplete cleanup,
  cursor regression or no action report. Inspect the JSON; no automatic repair.
- Exit64: invalid options, preexisting action, unproven baseline or bad evidence.

A report with `platform: linux` is not Windows evidence. A surviving parent after
a reported archive is a retained-listener finding, not proof of shutdown. If
native evidence shows archival retains the agent CLI, process existence alone
cannot enforce that Desktop lifecycle: a separately approved supported lifecycle
adapter would be needed. Do not infer one from transcript changes or install a
hook silently. Native Desktop closure/archival remains pending.
