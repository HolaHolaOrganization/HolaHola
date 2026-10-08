# Individually identified synthetic diagnostic results

The reporting change preserves the existing diagnostic assertions and mutation
proofs. It does not change the coordinator, enroll a host, read credentials or
DPAPI, alter policy/trust, or authorize a native rerun.

## Output contract

Each bounded line starts with `[coordinator-v2] diagnostic-result ` followed by
JSON. Baseline records identify the case, capture mode and each assertion:

```json
{"case":"enrollment/root-array/legacy-stream","status":"PASS","checks":[{"name":"sentinel-confidentiality","status":"PASS"},{"name":"fixed-allowlisted-report","status":"PASS"},{"name":"detail-bound","status":"PASS"},{"name":"raw-content-exclusion","status":"PASS"},{"name":"failure-prefix","status":"PASS"}]}
```

An assertion failure emits a FAIL case with the checks actually reached
(including the failed check), then throws the original bounded failure message.
Later checks absent from that record were not executed; their absence is never
a pass. A case PASS is emitted only after every assertion in that case returns.
An unexpected exception or interruption before that point leaves no case PASS;
the nonzero/incomplete process outcome must be retained.

Mutation/control, timeout, source-preservation and cleanup records use fixed
check-name lists. PASS confirms those listed conditions; FAIL does not claim
individual conditions passed. A timeout-only invocation explicitly records its
omitted mutation selection as `timeout/mutation-suite` SKIP. The normal outer
fixture subsequently runs the actual mutation suite.

`-SkipMutationChecks` emits `mutation-suite` SKIP and never `complete-suite`
PASS. Without that switch, the outer complete-suite PASS comes only after both
nested proof scripts return successfully. The legacy summary strings remain
available to existing consumers. Exit code and completeness still govern the
run; a previously printed PASS is not proof of subsequent cleanup or success.

All IDs and check names come from the fixed synthetic fixture, never from
server error bodies, credentials, exception messages or arbitrary status values.
Invalid-status and malformed-metadata cases use descriptive names rather than
printing their supplied values.

## Verification in this workspace

Command:

```text
npx tsx --test server/scripts/test-coordination-diagnostic-results.test.ts
```

Observed on **Linux PowerShell 7.4.2**, not Windows PowerShell 5.1:

- Exact independent inventory: 224 distinct baseline cases and 935 named
  assertions passed, with no duplicate case/assertion IDs.
- Seven expected mutation/control executions passed, including the preserved
  singleton-array parser modes.
- Owned sleeping-child termination, safe timeout reporting, temporary cleanup,
  and unchanged source/fixture checks passed.
- Explicit mutation skipping reported SKIP and no complete-suite PASS.
- Deliberate first-assertion failure reported only its actual case/check FAIL,
  returned nonzero, and emitted no later success.
- Captured output did not contain either synthetic secret/error canary.

The Node driver gives children a minimal environment with an owned synthetic
LOCALAPPDATA path and explicitly imports standard PowerShell modules. It copies
only fixture source for fault injection and removes only its owned temporary
directories. If PowerShell is unavailable, tests explicitly skip; skipped tests
are not native evidence. The reporting tests are registered in
scripts/run-ci-test-steps.mjs; the existing Windows CI entrypoint also invokes the
updated diagnostic fixture.

The October 7 native execution receipt remains in
`2026-10-07-native-enrollment-diagnostics.md`, attributed to Luca [Claude Code]
and pinned to its original script hashes. It cannot verify these modified
bytes. Any native rerun requires its own applicable approval and exact-source,
engine, policy, completeness and before/after evidence.
