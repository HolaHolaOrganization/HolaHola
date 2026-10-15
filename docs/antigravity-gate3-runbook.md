# Windows coordinator and historical Gate 3 runbook

## Current Coordinator V2 operator path

Do not begin a current run with the legacy Gate 3 Phase A/Phase B procedure.
After protected publication, production verification, founder policy approval,
operator grant, compatible host enrollment, and same-user local credential
preparation, run:

```powershell
Invoke-HolaCoordinator -TaskRef <task reference>
```

Run it once. Do not copy any preparation, session, attempt, lease, claim,
challenge, receipt, digest, provider, host, path, command, or credential
identifier into the command. The server creates and reconciles those values
from PostgreSQL.

Founder policy approval and operator launch are separate actions. Policy
approval defines provider order, adapters, budgets, paths, commands, and host
constraints. Launch selects only the task and, optionally, an already approved
policy. The host cannot select providers, retries, fallback, or execution
authority.

The command may report:

`preparing`, `ready`, `running`, `waiting_for_host`, `verifying`, `succeeded`,
`failed`, `exhausted`, `expired`, `revoked`, `cleanup_pending`,
`preflight_failed`, `host_unavailable`, or `invalid_request`.

Exit `0` requires `succeeded` plus acknowledged cleanup. Retry and recovery use
the classifications `resume_transport`, `fresh_attempt_same_provider`,
`fresh_attempt_next_provider`, `terminal_failure`, and `cleanup_repair`.

When Antigravity itself needs to reason between lifecycle steps — rather than
letting the single unattended `Invoke-HolaCoordinator` command run start to
finish — it drives the same host lifecycle one subcommand at a time through
`server/scripts/coordination-v2-interactive-cli.ts`. See the
[interactive host CLI guide](coordination-v2-interactive-cli-guide.md).

See:

- [Coordinator V2 architecture](coordination-v2-architecture.md)
- [Host protocol](coordination-v2-host-protocol.md)
- [Recovery runbook](coordination-v2-recovery-runbook.md)
- [Interactive host CLI guide](coordination-v2-interactive-cli-guide.md)

## Windows custody boundary

The fixed launcher requires Windows PowerShell 5.1 and protects its local
credential with DPAPI `CurrentUser`. The credential can be used only by the
same Windows user who prepared it. This does not establish containment against
malicious software already running as that user.

Linux validation proves source, protocol, and fail-closed behavior. It cannot
prove real DPAPI execution, Windows ACL behavior, or PowerShell 5.1 acceptance;
that evidence belongs to the later real-Windows milestones.

## Historical Gate 3 record

The former Gate 3 path used
`server/scripts/coordination-runtime-antigravity.ts`,
`scripts/antigravity-gate3.ps1`, a public preparation bundle, founder-approved
challenge, Phase A/Phase B provisioning, and a bounded driver. Its receipts,
challenges, registrations, windows, claims, digests, grants, bootstrap
exchanges, and acceptance logs remain preserved provenance.

They are not current authority. They cannot:

- approve a Coordinator V2 policy;
- satisfy an operator grant;
- enroll or authorize a V2 host;
- launch, resume, retry, or fall back a V2 session;
- authorize cleanup;
- satisfy fresh real-Windows acceptance.

Do not transfer a historical public bundle or non-secret identifiers into V2.
Do not replay an uncertain bootstrap or child effect. A current V2 run creates
fresh authority only after the reviewed implementation is promoted and
production is verified.

Cancelled legacy activation work remains cancelled. Separately owned work
remains untouched and provides no Coordinator V2 authority.

### Frozen historical validation

Gate 3's original approved source/artifact pairs are reproducibility evidence,
not a supported initialization path from evolving main. Do not run or install
the archived bundles, replay historical credentials, or transfer their approval
to Coordinator V2. The archived launcher retains its original pins. The live
launcher separately retains main's selected run pin `b80917ae…` and preparation
pin `06ce0e36…`; this reconciliation does not repin either artifact.

The historical integrity check rebuilds exact frozen source and compiler
configuration with the dedicated esbuild 0.25.9 alias, then verifies the original
run and preparation hashes against the archived launcher only. It never
executes historical output. A separate live check rebuilds current source with
the application's compiler API and compares both outputs to the live launcher
pins. Neither check substitutes for the other. Current-source
entrypoint behavior is tested separately, with no claim that its evolving bytes
have historical approval. Existing launcher security guards remain enforced.
See [frozen fixture policy](../server/scripts/fixtures/gate3-approved-origin/README.md)
for source provenance, immutable artifact preservation and build-only commands.

Any historical-record correction requires explicit founder approval and an
independent review of the exact correction; routine dependency upgrades, changed
source inputs or a failing hash test are not permission to refresh a pin.
No migration, installation or credential reinitialization is authorized here.
