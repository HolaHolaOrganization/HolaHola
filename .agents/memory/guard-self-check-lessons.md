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

