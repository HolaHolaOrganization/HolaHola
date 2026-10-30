# Episode/story backup and isolated restore

This is a one-shot operator procedure, not a scheduled service. It never restores the shared database or retires Markdown records. The application does not import or activate the runner.

## Authorization and custody

Use the real assigned task artifact and its founder-approved ownership receipt. The runner verifies a new server nonce and local key signature at each S3 write, canary mutation, branch creation/deletion and database restore boundary. A prior successful proof is not cached authority. Approval expiry/revocation stops further mutations.

Only explicit S3 object credentials are supplied to the exporter. It has no lock-configuration operation. The founder retains control of the indefinite R2 lock on **only** `episode-backups/v1/`; never broaden the rule to the whole bucket or media prefixes. Never provide bucket-administration credentials to the exporter.

## Run

After approval in Command Center → System → Ownership:

```sh
node --import tsx server/scripts/episode-backup-drill.ts \
  --task-ref TASK_NUMBER --receipt-id APPROVED_RECEIPT_UUID \
  --app-url https://getholahola.com --initial-baseline
```

For a later snapshot replace `--initial-baseline` with:

```text
--previous-receipt docs/operations/episode-backup-drills/PASSED_REPORT.json
```

The runner refuses an initial baseline if a manifest already exists. Listing is never used to choose a trusted backup. A supplied prior receipt is checked against the stored manifest and every referenced object.

Required process configuration uses the existing own-actor coordination credential, Neon API/project configuration, shared Neon source URL and explicit S3 endpoint/bucket/object credentials. Do not print connection URIs, credentials, source rows or raw provider exceptions. No environment file or persistent source URL is rewritten.

## Evidence

### Fresh approval and restore-only resume

If export succeeded but the approved receipt expired before branch creation,
do not repeat `begin`, use `renew` against an approved decision, or reset the
baseline. Request an explicit **new founder review**:

```sh
node --import tsx server/scripts/task-ownership-cli.ts reapprove \
  --task-ref TASK_NUMBER --actor luca-replit --app-url https://getholahola.com \
  --challenge-id PREVIOUS_APPROVED_CHALLENGE --receipt-id PREVIOUS_RECEIPT
```

This preserves the original task artifact, key, challenge, receipt and decision.
It creates only a pending request, never authority. A deterministic idempotency
key records predecessor challenge/receipt lineage; retries converge on the same
request, including after its approval. The founder must approve the new request
in Command Center → System → Ownership. That decision replaces active receipts
for this task (across actors), using the existing audited server transaction.
Receipt lifetime is unchanged: **ten minutes after approval**. The default
thirty-minute request window is only time to make the decision.

Prepare and test before requesting that approval. Independently retain the
export-time manifest key/checksum in a separate record; do not discover a
"latest" manifest or derive a trust anchor from a newly read report.

After approval, use the separate restore-only entrypoint:

```sh
node --import tsx server/scripts/episode-backup-restore-resume.ts \
  --task-ref TASK_NUMBER --challenge-id NEW_CHALLENGE --receipt-id NEW_RECEIPT \
  --app-url https://getholahola.com --restore-from FAILED_EXPORT_REPORT.json \
  --manifest-key INDEPENDENT_MANIFEST_KEY --manifest-sha256 INDEPENDENT_SHA256
```

Only a verified export that failed at branch creation with no recorded branch
is eligible. The new run preserves the failed report, hashes its bytes, repeats
full backup-only verification, authenticates schema evidence from the pinned
manifest and compares current schema catalogs without recapturing source rows.
It refuses an original or earlier resume branch left behind. It performs no
S3 writes, canary mutation, new export or source-content write.

New reports include phase timestamps, original report provenance, new approval,
manifest reference, full inventory and cleanup result. A passed resume with
confirmed deletion is intentionally eligible as a later `--previous-receipt`.
Fresh proofs gate every mutation. Minimum remaining-time checks do not extend
authority or guarantee worst-case completion; the one-hour branch expiry is
the backstop. Ambiguous branch-creation responses trigger exact-name/parent
recovery checks, never an inferred absence. A reporting failure does not block
guarded cleanup.

Each run writes a small, content-free report under `docs/operations/episode-backup-drills/`. Keep this report independently from R2: its manifest key and checksum are the verification anchor. Reports retain phase/failure categories, source schema and migration provenance, inventory checksum, canary outcomes, restore result and branch cleanup status.

Permanent synthetic canaries live under `episode-backups/v1/canaries/`. Both unconditional overwrite and deletion must receive the **specific R2 bucket-lock error**, followed by exact byte readback. Generic permission errors do not prove the lock. No destructive canary ever uses an episode object.

Source capture includes every episode/story arc row and tagged story, including hidden rows and full metadata, in one read-only repeatable-read transaction. Source and target serialization settings match. New objects use conditional creation; the manifest is written last only after every upload/readback completes. At most eight uploads run concurrently, each with its own fresh authorization.

The schema-only Neon branch receives a one-hour expiry as a crash backstop. Creation is recorded before readiness polling. The runner confirms its parent matches the shared source endpoint, verifies that its own endpoint differs, rejects unexpected triggers/generated columns or foreign-key dependencies, and proves the entire restore table is empty. The transaction locks and rechecks emptiness before inserting, then verifies the entire read-back inventory with exact content and metadata. It never truncates, upserts, disables constraints or fetches missing live dependencies.

## Failure handling

An uploaded object without a committed manifest is an orphan, **not a backup**. A flagged snapshot is not promoted to last-known-good. A verified export is not a passed restore drill. A passed restore without confirmed branch cleanup is not an overall passed run.

Do not retry a failed run as a new initial baseline if a manifest was published. Preserve the independently retained manifest receipt and report for an explicitly authorized recovery decision. Do not replace founder approvals, weaken ownership checks, or use the CI migration gate as a shortcut. If cleanup fails, the report retains the exact owned branch identity and the one-hour expiry remains the backstop; guarded operator cleanup still requires current approval.

## Checks

```sh
node --import tsx --test server/services/episode-backup.test.ts \
  server/services/episode-backup-adapters.test.ts \
  server/services/episode-backup-drill.test.ts server/services/episode-backup-resume.test.ts \
  scripts/neon-branch.test.ts
npm run typecheck
node --import tsx server/scripts/verify-system-health.ts
```

The focused tests are registered in the canonical CI runner. No app-server restart is needed for this standalone operator script; preserve any existing server/capture hold.
