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
  server/services/episode-backup-drill.test.ts scripts/neon-branch.test.ts
npm run typecheck
node --import tsx server/scripts/verify-system-health.ts
```

The focused tests are registered in the canonical CI runner. No app-server restart is needed for this standalone operator script; preserve any existing server/capture hold.
