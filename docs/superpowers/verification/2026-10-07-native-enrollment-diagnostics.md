# Native Windows enrollment diagnostic verification

## Scope and evidence attribution

The required native synthetic fixture passed on October 7, 2026, according to
Luca [Claude Code]'s authenticated canonical coordination receipt. This is an
attributed Windows host observation, not an independent Replit inspection of
the machine or a test of the current Replit checkout.

Canonical thread: `ea6ff4e9-cbe5-4b15-9699-b7ea0ff36700`.
The task owner retrieved the complete thread through the authenticated
coordination API on October 7, 2026.

Evidence anchors:

- Sequence 1, event `123f8019-c9a6-406d-b41a-229753c8cf67`: approved request,
  exact source/runtime publication verification, independent script pins and
  original execution boundaries.
- Sequence 3, event `785f4eb7-4628-477d-8c31-0520058ee867`: stopped native
  preflight. No fixture ran; inherited Bypass and clean-child Restricted policy
  prevented the originally authorized invocation.
- Sequence 5, event `509e7e44-563f-4aa0-9c38-850f9f3ce429`: subsequent explicit
  one-run RemoteSigned authorization.
- Sequence 6, event `92b67de5-b05b-47f6-adb6-dbb4e1f06807`, global sequence
  1384: full native execution receipt, file/policy preservation, verbatim
  fixture summaries and section mapping.
- Sequence 7, event `72c0e1e3-574c-4b72-a880-cbd26f5a9681`, global sequence
  1385: acceptance of the attributed native receipt, retaining all scope limits.

## Publication and authorization gates

The request records read-only publication verification at 18:37 UTC, before
execution:

- Render `/health/release`: HTTP 200, build authority, promotable, commit
  `d468ac7bfa62c8ceb1b1f2ede6dbefcc7631131a`.
- Source-context SHA-256:
  `14fc1e2e9493bd2dd4c479fc4b94c4a9a6e556ca504bb0b35b6f2b1f60344664`;
  algorithm `sha256(path-nul-kind-nul-bytes-nul-v1)`.
- Published source promotion `5cffba34-14eb-49b3-8b48-3d89dba96c47`;
  published runtime `1db8a334-aa1c-462b-ae9f-02cd8ad997e6`, bound to that source.
- Runtime release digest:
  `92c3e6bf653b4dd6290bef1bc41b6581085c1c52d8f83400b5723100d7746ec2`.
  The request records matching prepared candidate, source binding, all 61
  artifacts, recomputed release/template digests and provenance, with zero
  revocations.

The initial preflight refusal remains evidence, not a pass. A subsequent
explicit founder approval permitted a single process-scoped RemoteSigned run
with inherited Bypass removed only from the controlled child's environment.
The receipt states that David confirmed this revised run directly in the
Claude Code chat before execution. No saved policy or trust change was
authorized or reported.

## Native execution receipt

Reported host: Windows 11 Pro, build 26300.9550.
Reported engine: Windows PowerShell **5.1.26100.9549**, Desktop edition.
Checkout commit before and after:
`d468ac7bfa62c8ceb1b1f2ede6dbefcc7631131a`.

The three reported before/after SHA-256 hashes match the independent Git/LF
pins in the approved request:

| File | Before = after SHA-256 |
| --- | --- |
| `scripts/hola-coordinator.ps1` | `2365a9f731e5d7bba81b7f5a0fa2444a8a183c225e59af182036cc178730a741` |
| `scripts/test-hola-coordinator-recovery-diagnostics.ps1` | `8101833da83680d55125ce9e896894bb479cfd1afe365f584eec91d7718b5e33` |
| `scripts/test-hola-coordinator-enrollment-diagnostic-mutations.ps1` | `3d92bf9fa54a7d335d9614da0bfb13424c12f8e9f43de193686b747ecba4e81f` |

Invocation:

```text
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File .\.local\diag\task1712-policy-wrapper.ps1
```

The fixed wrapper verified policy, invoked
`scripts/test-hola-coordinator-recovery-diagnostics.ps1` once without
`-SkipMutationChecks`, and preserved its outcome. The approved wrapper did not
change the fixture's execution mechanism or child launcher.

Controlled process: 18:49:45.33–18:49:54.02 UTC; exit code **0**.
Fixture markers: 18:49:45.958–18:49:53.998 UTC. No overall timeout or kill.
The fixture returned without throwing; its unset `$LASTEXITCODE` was mapped to
zero by the wrapper. No retry was reported.

Before fixture execution, both the controlled process and a native descendant
reported effective policy RemoteSigned, with no remaining Bypass or
organizational override. Saved policy scopes remained Undefined before and
after. The parent's inherited Bypass was not modified. All three tested files
had unchanged status and no Zone.Identifier before or after.

## Verbatim fixture output from the native receipt

```text
[coordinator-v2] Synthetic safe enrollment and recovery diagnostic checks passed
[coordinator-v2] Synthetic child timeout, safe diagnostic, and cleanup proof passed
[coordinator-v2] Synthetic mutation proof passed: raw-response/native-parser
[coordinator-v2] Synthetic mutation proof passed: raw-exception/native-parser
[coordinator-v2] Synthetic mutation proof passed: case-insensitive-guidance/native-parser
[coordinator-v2] Synthetic mutation proof passed: root-array/native-parser
[coordinator-v2] Synthetic mutation proof passed: root-array/preserved-array-parser
[coordinator-v2] Synthetic mutation proof passed: unmodified/native-parser
[coordinator-v2] Synthetic mutation proof passed: unmodified/preserved-array-parser
```

The receipt reports only the standard first-use CLIXML progress record on
stderr, with no error records. No sections were reported skipped, interrupted
or failed. The script emits summaries, not individual assertion counts; none
are inferred here.

## Coverage and cleanup

The receipt maps the baseline pass to the throwing assertions preceding the
summary: synthetic secret-sentinel non-reflection; enrollment and recovery
reason handling; invalid HTTP metadata without body/stream parsing; typed
transport reasons; legacy response streams and broken-stream fallback;
malformed root-array and HTML bodies; oversized response refusal; unknown
reason rejection; preserved `enrollment_transport` and
`host_reauthorization_transport` failure prefixes and typed HTTP status; local
failure guidance.

The nested mutation fixture ran with `-VerifyChildTimeout`. It verified a
one-second bounded sleeping child was terminated, its diagnostic was safe, and
its owned temporary root was removed. The seven mutation/control output lines
record raw-body/raw-exception leak rejection, case-insensitive reason rejection,
root-array rejection across parser modes and unmodified controls.

Reported after-state: zero owned mutation temporary directories and zero
remaining encoded-command PowerShell children. Existing host evidence artifacts
were retained in the Windows checkout's gitignored `.local/diag/`:
`task1712-policy-wrapper.ps1`, `task1712-run-stdout.txt` and
`task1712-run-stderr.txt`. They were not copied to Replit or independently
inspected here.

## Limits

This proves the reported synthetic fixture behavior for the exact published
source above. It does **not** establish or authorize live enrollment, recovery,
credential access, bootstrap/proof replay, coordinator sessions or runtime
initialization. No live credentials, DPAPI reads, network probes, trust changes,
saved policy changes, source edits or publication occurred during the reported
fixture run.
