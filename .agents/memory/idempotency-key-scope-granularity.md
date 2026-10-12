---
name: Idempotency key scope granularity
description: an idempotency key's dedupe scope is (operation, actor, key) only, not per-call content — reusing one literal key across distinct requests from the same actor collides.
---

An idempotency key's dedupe scope is `(operation-name, actorId, key)`. Two
different requests from the same actor, on the same operation, sharing one
literal key string are not treated as two independent calls — the second one
is compared against the first's stored request and rejected as a mismatch
(surfaces as an error like "idempotency key was reused with a different
request"), never silently treated as new.

**Why:** the guard exists to make retries safe (same key + same request =
return the original result, no duplicate side effect), but that mechanism
can't distinguish "this is a retry of the same logical request" from "this is
a different request that happens to reuse the same key" without help — the
key itself is the only signal it has.

**How to apply:** when a caller issues the same kind of request multiple
times in one run (e.g. a loop creating N distinct documents/rows), derive a
distinct key per iteration from something that varies per request (a target
path, an ID, a slug) — never reuse one constant literal across the loop, even
when each call is conceptually "the same one-off operation." Seen in the
shared-spec live-instruction-document seeding script, where one literal key
reused across two `createDocument()` calls (for two different documents)
collided on the second call.


## Founder-authorized renewal bootstrap

An expired ownership challenge can block the repair of the renewal client itself.
Treat a founder-authorized, bounded fresh request through the existing API as a
separate operator action, not permission to weaken the ownership gate.

**Why:** The repair was unable to start after both the original bootstrap request
and the repair task's request expired. An explicitly authorized replacement
request with the same artifact, actor and custody key allowed ordinary founder
approval and proof to proceed; it did not authorize an automatic approval.

**How to apply:** Ask for that bounded operator authorization when the renewal
client is itself blocked. Persist its new request identity before transmitting,
preserve the exact bound artifact and existing key, and require fresh founder
approval/proof before source edits. Never rotate keys, change scope, or alter
the server's exact-retry contract to escape the block.

