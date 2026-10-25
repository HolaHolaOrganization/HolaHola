## Related scanner and mutation evidence

Related guard/self-check lessons remain in their original topic records:

- [Duplicate detector fixture gaps](duplicate-detector-fixture-gaps.md):
  one detector's mutation check does not prove sibling detectors.
- [Mutation-guard scenario coverage](mutation-guard-scenario-coverage.md):
  test both never-fires and always-fires behavior, not only one direction.
- [Scanner self-test fixture race](scanner-selftest-fixture-race.md):
  live-directory fixtures can race another scanner's directory traversal.
- [Text-scan guards can flag themselves](grep-guard-self-reference-false-positive.md):
  comments or fixture strings in the guard itself can match its target pattern.

**Why:** These related pointers are grouped to keep the shared memory index
below its visibility threshold without deleting or rewriting the original
lessons, evidence, or topic records.

**How to apply:** Open the relevant linked topic when changing a static scanner
or mutation self-check. Index consolidation is not permission to discard the
original source records or treat all four failure modes as the same issue.


## Cross-engine fault injection

A fault-injection test must violate the observable invariant on each supported engine, not merely remove one implementation check.

**Why:** A diagnostic mutation passed its self-check on Linux PowerShell but remained ineffective on Windows PowerShell. Bypassing the root-delimiter check alone could leave array input rejected by a later type check; the surrounding parser's array behavior changed whether the mutation was actually unsafe.

**How to apply:** Preserve the production boundary. In private test copies, deliberately create the unsafe behavior and require the specific assertion to fail. Exercise both scalarized and preserved singleton-array representations, require the unmodified implementation to pass, and retain actual target-engine CI proof. A different error or an unchanged safe result does not prove the intended regression was detected.


## Default security gates need a real positive path

Treat the default caller wiring as a real security boundary: it must prove both legitimate authorization and denial, not merely refuse everything.

**Why:** An infrastructure guard's denial-only tests and injected positive stubs looked reassuring while its shipped default could never consume a valid founder approval. A successful proof in one process did not establish authority in the later mutation process. Fail-closed behavior was necessary but not sufficient for a functional gate.

**How to apply:** Exercise the actual credentialed entrypoint in a fresh process, with private fixtures and real cryptographic proof against a synthetic authenticated service. Verify that legitimate approval works without an injected success result, and that missing, expired, revoked or mismatched authority causes no external mutation. Reverify at each later upload/dispatch boundary after potentially lengthy preparation; do not cache a prior successful verification as authority.


## Structural checks versus closed-context snapshots

Static guards must distinguish a required semantic field from an exact closed source-code snapshot.

**Why:** Adding legitimate review metadata preserved caller-owned engine identity, but old closed-object signature and call-site strings falsely reported the engine as missing. A full gate stopped despite the actual behavior remaining correct.

**How to apply:** Scope structural checks to the real declaration and named callers. Permit ordinary additional metadata while retaining exact supported engine types and literal caller ownership. Reject comment-only decoys and spread/computed overrides. Preserve behavioral mutation proofs alongside the static checks; do not merely relax a substring until it passes.


## Mutation restoration and committed-byte verification

A passing run before a source-mutation self-check does not validate the tree left afterward. Verification claims must cover the committed bytes after restoration, not an earlier local state. Prefer destructive guard mutations in disposable copies.

**Why:** During independent containment review on 2026-10-17, a reported passing suite was followed by a mutation that removed an entrypoint guard. Restoration failed, and the mutated source was committed without rerunning. An independent exact-commit check caught the missing guard; the author confirmed the sequence.

**How to apply:** After mutation tests, verify restoration and the intended source diff before committing. Tie the focused positive verification to the committed source; rerun only checks invalidated by the changed bytes. Keep a reported local result distinct from independently observed exact-commit evidence.


## Independent root oracles and production path resolution

Scanner coverage tests need an independent oracle for mandatory roots and
must exercise the same root-resolution path as the real scan.

**Why:** Building fixtures and expectations from the very list under test
allows a misspelled or removed root to pass: the test adapts to the same bug.
Testing only a recursive file walker also leaves a broken production
root-resolution mapping undetected.

**How to apply:** Keep fixtures outside the source tree, explicitly assert the
externally required root set, and invoke the production root resolver on the
disposable fixture tree. Mutation-check root removal/typos and broken mapping
as well as recursion and extension filtering. A passing walker mutation check
does not establish root selection coverage.


## Expired deadlines do not prove executor termination

Crash-only claim tests do not prove correctness when the original executor is
still alive after its execution deadline.

**Why:** An elapsed deadline does not cancel a worker or fence its external
effect. A reconciler can observe absence and permanently record `not_applied`,
then the original worker can resume and apply the effect. Same-ID execution
uniqueness can hold while durable outcome truth and new-ID retry safety fail.

**How to apply:** Include a deferred, still-live winner in claim/reconciliation
tests; assert actual effect count, persisted outcome, and caller-visible status.
Treat remote absence as ambiguous unless there is proof that the original
executor cannot still cause the effect. Terminal/fencing evidence must hold
across the observation-to-outcome-write interval.


## Aggregate counters can include expected child failures

Aggregate failure counters can include intentionally failing child tests and printed negative fixtures even when the parent checks pass. Do not infer either a real regression or harmlessness from the aggregate number alone.

**Why:** A migration rehearsal reported success alongside three failed tests. Independently recounting same-candidate public guard output with the trusted summarizer reproduced the exact failure count and failure-line count: a mutation probe deliberately failed child tests, restored the code and passed its parent check. Other negative fixture snippets contributed failure-shaped lines.

**How to apply:** Inspect the trusted aggregation rule and the enclosing parent command. Corroborate expected child failures, restoration and parent success with exact-candidate evidence. Keep private production-copy output private; use public synthetic test logs where they establish the explanation. Distinguish process success, diagnostic counters and actual data-operation postconditions.

