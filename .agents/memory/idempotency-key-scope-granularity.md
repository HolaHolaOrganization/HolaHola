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


## Fresh authorization for delayed reconciliation

Keep authorization freshness separate from the immutable identity of an already-claimed operation. A fresh credential or status request may authorize inspection/reconciliation of that original claim; it must not silently become permission to execute the mutation again or replace the original claim digest.

**Why:** Individually correct expiry and idempotency guards can make recovery unreachable in composition: the original execution authorization expires before reconciliation becomes eligible, while renewing signed timestamps changes the digest and triggers a conflict. Direct calls to an internal reconciler can pass while the real authenticated route can never reach it.

**How to apply:** For any delayed recovery protocol, prove the complete authenticated entry path after the original authorization has expired. Test fresh authorization plus exact original actor/claim binding, positive-only evidence, unavailable evidence and exactly one effect. Never extend expired mutation authority or weaken the immutable digest merely to enable recovery.


## Exchange identity is not a unique projected-speaker identity

**Rule:** Match idempotency identity to the entity actually being projected. When one source event contains several participant turns, source receipt identity alone is not a unique per-entry key; include the participant/role or derive a stable role-qualified identity.

**Why:** An exchange-level receipt can legitimately be shared by both sides of a conversation. Deduplicating projected speaker entries by that receipt alone makes the second side appear to be a conflicting retry instead of a separate voice.

**How to apply:** Preserve the original source linkage and source namespace. Test the complete multi-speaker event, exact whole-event retry, one-side retry, changed-one-side conflict and concurrent independent events. Do not generate fresh identities on retry, compare text alone, or merge different voices.


## Mutually exclusive outcomes need a crash-stable winner

Per-outcome idempotency does not enforce mutual exclusion between outcomes. When a late event can change which outcome would be selected, persist one authoritative decision before applying effects, or commit a cross-outcome decision transactionally with the effect. Recovery must retain that winner rather than rerun selection against newly arrived events.

**Why:** Independent-input capture review exposed a concrete failure: a timeout committed a user-only row, the process crashed before recording completion, then a reply arrived. Re-running selection could create a paired row too, because keys including the outcome kind allowed both. The approved design records the decision before effects and distinguishes that pending decision from completed projection. Canonical source: shared-spec document `97df12be-ea7f-4e82-86b3-5519710428c9`.

**How to apply:** For timeout/arrival races, test late arrival after a crash both before and after the effect commits. Verify one cross-outcome winner, idempotent effect recovery, and no success acknowledgement before the required effects complete. Same-kind deduplication alone is not proof.


## Derived effect identities must not alias source identities

Derived effect keys must occupy a namespace disjoint from every permitted raw source identity. Adding a readable suffix does not establish uniqueness across record roles.

**Why:** Independent capture review demonstrated that a late reply's suffixed identity could equal a different, valid exchange's raw identity. Each exchange was internally valid, but the shared idempotency lookup silently treated the second exchange as a replay and omitted its words.

**How to apply:** Check collisions across atomic exchanges, multipart pairs and late effects, in both insertion orders. Use collision-safe typed keys or enforce a reserved namespace across every intake path. Keep human-readable reply links separate from the key used to suppress duplicate effects. Do not assume current clients' naming habits are an enforced invariant.

