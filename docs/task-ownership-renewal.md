# Task ownership approval and renewal

Replit task acceptance queues the work. HolaHola ownership approval is a
separate founder authorization bound to one task artifact, actor and custody
key. Neither a queue entry nor a registry status proves ownership.

## Where to approve

Sign in to HolaHola with the founder account, open **Command Center**
(`/admin`), then **System → Ownership**. Match the task reference and actor.
Approve only after checking the task scope and artifact digest. Approval issues
a receipt; the builder must then prove possession of the bound private key.
An expired challenge cannot be approved.

## Explicit renewal

```sh
npx tsx server/scripts/task-ownership-cli.ts renew \
  --task-ref 1723 --actor luca-replit \
  --challenge-id <expired-challenge-id> \
  --app-url <HolaHola-server-origin>
```

`renew` defaults to a **30-minute** approval window, the existing server maximum.
Use `--approval-minutes 1` through `--approval-minutes 30` to request a shorter
window. The CLI prints the new challenge, expiry and approval-screen path.
The new request still requires a fresh founder decision and normal proof:

```sh
npx tsx server/scripts/task-ownership-cli.ts status \
  --task-ref 1723 --actor luca-replit \
  --challenge-id <new-challenge-id> --app-url <HolaHola-server-origin>

npx tsx server/scripts/task-ownership-cli.ts prove \
  --task-ref 1723 --actor luca-replit \
  --receipt-id <approved-receipt-id> --app-url <HolaHola-server-origin>
```

The server must expose the public task/actor/artifact/key binding fields in its
authenticated status response. Older servers fail closed with upgrade guidance;
local source changes do not update a published server.

## Retry and custody rules

- Repeat the **same renewal command**, including predecessor and approval window,
  after a lost response or interrupted process. It returns the same challenge,
  even if that replacement has since been approved, rejected or expired.
- To renew a replacement that itself expired, explicitly name that **newer
  expired challenge** as the predecessor. Repeating the older command never
  silently starts another attempt.
- Pending, approved and rejected predecessors are refused. Any predecessor with
  a receipt is also refused, including an expired receipt; this command does not
  replace an approved authorization or revive a rejection.
- `begin` retains its original ten-minute request and legacy retry key. Repeating
  `begin` does not renew its expired result.
- Renewal loads the existing custody key; it never creates or rotates one.
  Missing keys require custody recovery, not regeneration as a workaround.
- Immutable attempt records are published before the request in
  `.local/task-ownership-attempts/`, scoped by endpoint, actor and reference.
  Preserve them across retries. Changed artifact bytes, keys, approval windows
  and unreadable records are explicit errors, never overwritten.
- Complete-file exclusive linking and file flushing protect process-interruption
  and concurrent-submission cases. Staging remnants do not become authority.
  This is not a claim of storage-hardware power-loss durability.

## Verification and publication

The existing ownership-client CI entrypoint includes pure retry/concurrency
tests and actual CLI subprocess tests against a synthetic HTTP service. No real
credentials, shared database or live task artifacts are used by those fixtures.
Native Windows execution must be recorded separately; Linux success is not
Windows verification.

Source promotion, published-server update and shared task-registry implementation
are separate authorizations. Verified task-scope UI integration still requires
the canonical registry; no unverified bootstrap labels are canonical metadata.
