/**
 * Explicit one-shot operator runner; never started by the app or a scheduler.
 * Reports contain checksums/provenance only, never content, credentials or URIs.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createBranch, deleteBranchByNameOrId, fetchConnectionUri, resolveBranch } from "../../scripts/neon-branch";
import { backupHash, exportEpisodeBackup, restoreEpisodeBackup, type BackupReference } from "../services/episode-backup";
import { createEpisodeBackupS3Store } from "../services/episode-backup-adapters";
import { verifyEpisodeBackupLock } from "../services/episode-backup-canary";
import { captureEpisodeBackup, assertIsolatedEpisodeTarget, restoreEpisodeBackupPostgres } from "../services/episode-backup-postgres";
import { createEpisodeBackupOwnership } from "../services/episode-backup-ownership";
import { TaskOwnershipHttpClient } from "../services/task-ownership-client";
import { ownershipEndpoint } from "../services/task-ownership-attempt";
import { assertEpisodeRestoreBranch } from "../services/episode-backup-branch";

export function drillArguments(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!["--task-ref", "--receipt-id", "--app-url", "--previous-receipt", "--initial-baseline"].includes(name)
        || name in values) throw new Error("Unsupported or duplicate drill argument");
    if (name === "--initial-baseline") values[name] = "true";
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing drill argument");
      values[name] = value;
    }
  }
  if (!/^[1-9][0-9]*$/.test(values["--task-ref"] ?? "")
      || !/^[a-f0-9-]{36}$/.test(values["--receipt-id"] ?? "")
      || Boolean(values["--previous-receipt"]) === Boolean(values["--initial-baseline"])) {
    throw new Error("Require task, receipt and exactly one of --initial-baseline or --previous-receipt");
  }
  return values;
}

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") {
    console.log("One-shot drill: --task-ref N --receipt-id UUID --app-url ORIGIN (--initial-baseline | --previous-receipt REPORT.json). Requires founder approval. Writes permanent synthetic canaries, immutable backups and a disposable schema-only branch; never restores production.");
    return;
  }
  const args = drillArguments(process.argv.slice(2));
  const taskRef = args["--task-ref"];
  const runId = `drill-${taskRef}-${randomUUID()}`;
  const directory = "docs/operations/episode-backup-drills";
  const reportPath = join(directory, `${runId}.json`);
  const report: Record<string, any> = {
    format: "holahola-episode-restore-drill", version: 1, runId, taskRef,
    startedAt: new Date().toISOString(), status: "running", phase: "ownership",
    liveExportPerformed: false, restoreVerified: false, cleanup: "not-created",
    custody: "Only explicit S3 object credentials supplied to exporter; founder retains lock-management control. No bucket settings API used.",
    excluded: ["messages", "embeddings", "production restore", "Markdown retirement", "scheduling"],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const save = async () => {
    const temporary = reportPath + ".tmp";
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, reportPath);
    console.log(JSON.stringify({ runId, phase: report.phase, status: report.status, reportPath }));
  };
  let client: S3Client | undefined;
  let ownedBranch: Awaited<ReturnType<typeof createBranch>> | undefined;
  let guard: ReturnType<typeof createEpisodeBackupOwnership> | undefined;
  let expectedParentId: string | undefined;
  let expectedExpiry: string | undefined;
  try {
    guard = createEpisodeBackupOwnership({
      taskRef, actor: "luca-replit", receiptId: args["--receipt-id"],
      client: new TaskOwnershipHttpClient(
        ownershipEndpoint(args["--app-url"] ?? required("COORDINATION_API_URL")),
        required("COORDINATION_LUCA_REPLIT_TOKEN"),
      ),
    });
    await guard.authorize(`backup:preflight:${runId}`);
    const sourceUrl = required("NEON_SHARED_DATABASE_URL");
    const endpoint = new URL(required("AWS_S3_ENDPOINT"));
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com")
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("This drill requires the configured HTTPS R2 endpoint");
    }
    client = new S3Client({
      endpoint: endpoint.origin, region: "auto", maxAttempts: 1,
      credentials: { accessKeyId: required("AWS_S3_ACCESS_KEY_ID"), secretAccessKey: required("AWS_S3_SECRET_ACCESS_KEY") },
    });
    const bucket = required("AWS_S3_DESTINATION_BUCKET");
    const store = createEpisodeBackupS3Store(client, bucket, key => guard!.authorize(`s3:backup:${runId}:${key}`));
    let previous: BackupReference | null = null;
    if (args["--previous-receipt"]) {
      const prior = JSON.parse(await readFile(args["--previous-receipt"], "utf8"));
      if (prior.format !== report.format || prior.status !== "passed" || !prior.restoreVerified || !prior.reference) {
        throw new Error("Previous receipt must be an independently retained passed drill report");
      }
      previous = prior.reference;
      await restoreEpisodeBackup(store, previous!);
    } else {
      // Listing never chooses a last-good receipt. It only prevents accidental
      // reset of a pre-existing chain when the operator says initial baseline.
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: "episode-backups/v1/manifests/", MaxKeys: 1,
      }));
      if (listed.Contents?.length || listed.IsTruncated) {
        throw new Error("A backup chain already exists; supply its independent last-good receipt");
      }
    }
    report.baseline = previous === null ? "first-baseline" : "previous-receipt";
    report.phase = "canary";
    await save();
    report.canary = await verifyEpisodeBackupLock({ client, bucket, runId, authorize: guard.authorize });
    report.phase = "source-snapshot";
    await save();
    const snapshot = await captureEpisodeBackup(sourceUrl);
    report.sourceEvidence = snapshot.evidence;
    report.records = snapshot.records.length;
    report.contentBytes = snapshot.records.reduce((n, r) => n + Buffer.byteLength(r.content), 0);
    report.contentInventorySha256 = backupHash(Buffer.from(JSON.stringify(snapshot.records.map(r => ({
      id: r.id, bytes: Buffer.byteLength(r.content), sha256: backupHash(Buffer.from(r.content)),
    })))));
    report.phase = "export";
    await save();
    const exported = await exportEpisodeBackup({
      store, records: snapshot.records, snapshotId: runId, createdAt: new Date().toISOString(),
      previous, sourceEvidence: snapshot.evidence, concurrency: 8,
    });
    report.reference = exported.reference;
    report.liveExportPerformed = true;
    report.manifestStatus = exported.manifest.status;
    report.phase = "backup-only-readback";
    await save(); // independent receipt survives later restore/cleanup failure
    if (exported.manifest.status !== "verified") throw new Error("Flagged snapshot; last-known-good unchanged");
    const backupRecords = await restoreEpisodeBackup(store, exported.reference, 8);
    const parent = await resolveBranch("production");
    expectedParentId = parent.id;
    const parentUrl = new URL(await fetchConnectionUri(parent.id, true));
    const sourceHost = new URL(sourceUrl).hostname.replace(/-pooler(?=\.)/, "");
    if (parentUrl.hostname.replace(/-pooler(?=\.)/, "") !== sourceHost) {
      throw new Error("Disposable branch parent does not match the source endpoint");
    }
    expectedExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    report.creationRequest = { name: runId, parentId: parent.id, schemaOnly: true, expiresAt: expectedExpiry };
    report.phase = "branch-create";
    await save();
    ownedBranch = await createBranch({
      name: runId, parent: parent.id, schemaOnly: true,
      expiresAt: expectedExpiry, taskRef, probeOwnership: guard.probe,
      onCreated: async branch => {
        ownedBranch = branch;
        report.branch = { id: branch.id, name: branch.name, parentId: branch.parent_id };
        report.cleanup = "pending";
        await save();
      },
    });
    report.branch = { id: ownedBranch.id, name: ownedBranch.name, parentId: ownedBranch.parent_id };
    report.cleanup = "pending";
    await save(); // no connection URI ever enters a report or log
    assertEpisodeRestoreBranch(ownedBranch, { id: ownedBranch.id, name: runId, parentId: expectedParentId, expiresAt: expectedExpiry });
    const targetUrl = await fetchConnectionUri(ownedBranch.id, false);
    assertIsolatedEpisodeTarget(sourceUrl, targetUrl);
    report.phase = "restore";
    await save();
    await restoreEpisodeBackupPostgres({
      sourceUrl, targetUrl, records: backupRecords, sourceColumns: snapshot.evidence.columns,
      sourceConstraints: snapshot.evidence.constraints,
      authorize: () => guard!.authorize(`postgres:restore:${runId}:${ownedBranch!.id}`),
    });
    report.restoreVerified = true;
    report.status = "passed";
  } catch (error) {
    // Provider/driver messages can contain source rows or credentials. Deliberately
    // retain only phase and a non-provider error category, not arbitrary messages.
    report.status = "failed";
    report.failure = { phase: report.phase, category: error instanceof Error ? error.name : "UnknownFailure" };
  } finally {
    if (ownedBranch && guard) {
      report.phase = "cleanup";
      try { await save(); } catch { report.reportWriteFailed = true; }
      try {
        const current = await resolveBranch(ownedBranch.id);
        if (!expectedParentId || !expectedExpiry) throw new Error("Missing branch creation identity");
        assertEpisodeRestoreBranch(current, { id: ownedBranch.id, name: runId, parentId: expectedParentId, expiresAt: expectedExpiry });
        await deleteBranchByNameOrId(ownedBranch.id, false, taskRef, guard.probe);
        report.cleanup = "deleted";
      } catch {
        report.cleanup = "failed-needs-operator";
        report.status = "failed";
      }
    }
    client?.destroy();
    report.finishedAt = new Date().toISOString();
    report.phase = "finished";
    await save();
  }
  if (report.status !== "passed" || report.cleanup !== "deleted") process.exitCode = 1;
}

if (basename(process.argv[1] ?? "") === "episode-backup-drill.ts") {
  main().catch(() => { console.error("Backup drill setup/reporting failed; inspect retained report. No success claimed."); process.exitCode = 1; });
}
