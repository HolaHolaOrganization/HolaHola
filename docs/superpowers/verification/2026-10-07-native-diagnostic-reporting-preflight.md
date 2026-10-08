# Native verification of changed diagnostic reporting: blocked preflight

Owner: Luca [Replit], main workspace. No Windows run is claimed here.
The previous attributed native receipt remains unchanged.

## Exact changed source

Replit checkout examined:
`1fb54907722db7d807ca9c1fab9a895ff34834a2`.

| File | SHA-256 of examined bytes |
| --- | --- |
| `scripts/hola-coordinator.ps1` | `2365a9f731e5d7bba81b7f5a0fa2444a8a183c225e59af182036cc178730a741` |
| `scripts/test-hola-coordinator-recovery-diagnostics.ps1` | `bb76543e6e5f2bac1946248db06a68029b60c9a5503abb545e7affcc05a09199` |
| `scripts/test-hola-coordinator-enrollment-diagnostic-mutations.ps1` | `bf6f3d100cdafc89a8c5f5368565126d6f656bd70455c5fe91694064307f999f` |

## Verified blocker

The read-only Render `/health/release` response reports published source
`d468ac7bfa62c8ceb1b1f2ede6dbefcc7631131a`, with source-context SHA-256
`14fc1e2e9493bd2dd4c479fc4b94c4a9a6e556ca504bb0b35b6f2b1f60344664`.
That is the old release recorded in the former native receipt; the two
diagnostic fixture hashes there differ from those above.

Fresh matching source/runtime publication has therefore **not** been
established. A local commit, successful Linux checks, or a previous one-run
policy authorization does not satisfy that gate. This Linux workspace also
cannot itself execute native Windows PowerShell 5.1.

## Next native request — only after prerequisites are verified

1. Founder publishes through the existing shared source/Render/runtime
   release path. Verify promotable release authority, exact commit/context,
   source/runtime binding, artifact digests and revocation state. This task
   does not authorize the agent to publish.
2. Verify the Windows checkout already has those exact approved bytes.
   Pulling, source transfer, checkout cleanup and edits require their own
   applicable authorization; do not do them under a read-only preflight.
3. Obtain fresh approval for the bounded invocation and any process-only
   policy/environment handling. Do not reuse the prior one-run approval.
   No persistent policy/trust/mark changes or inherited Bypass workaround
   are implied.
4. Run the actual fixture once without `-SkipMutationChecks`, using native
   Windows PowerShell 5.1. No Linux or PowerShell 7 substitution, retries,
   live enrollment/recovery, credentials/DPAPI, or coordinator session.
5. Preserve attributed engine, command, UTC start/end, exact before/after
   hashes, policy/mark metadata, process exit/completeness, all diagnostic
   result lines, stderr classification, timeout proof and owned cleanup.
   Baseline inventory: 224 cases / 935 assertions; seven mutation/control
   runs; nested timeout-only SKIP must not be confused with a skipped outer
   mutation suite. FAIL, timeout, incomplete output or changed after-state
   is not a pass.
6. Retain the old receipt and issue a separate new receipt for these bytes.

This document is a prepared verification boundary, **not** execution
authorization or successful native evidence.
