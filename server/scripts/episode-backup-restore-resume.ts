/**
 * Restore an independently pinned, already exported backup. No export,
 * canary mutation, chain listing or canonical-row capture path exists here.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { createBranch, deleteBranchByNameOrId, fetchConnectionUri, listBranches, resolveBranch } from "../../scripts/neon-branch";
import { backupHash } from "../services/episode-backup";
import { createEpisodeBackupS3Store } from "../services/episode-backup-adapters";
import { createEpisodeBackupOwnership } from "../services/episode-backup-ownership";
import { assertEpisodeBackupSchema, assertIsolatedEpisodeTarget, restoreEpisodeBackupPostgres } from "../services/episode-backup-postgres";
import { resumeArguments, validateResumeReport, verifyResumeBackup } from "../services/episode-backup-resume";
import { TaskOwnershipHttpClient } from "../services/task-ownership-client";
import { ownershipEndpoint } from "../services/task-ownership-attempt";
import { assertEpisodeRestoreBranch } from "../services/episode-backup-branch";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Restore only: --task-ref N --challenge-id NEW_UUID --receipt-id NEW_UUID --app-url ORIGIN --restore-from FAILED_REPORT.json --manifest-key INDEPENDENT_KEY --manifest-sha256 INDEPENDENT_SHA256. Requires fresh founder approval; never writes production or S3.");
    return;
  }
  const options = resumeArguments(args), taskRef = options["--task-ref"];
  const priorBytes = await readFile(options["--restore-from"]);
  const prior = JSON.parse(priorBytes.toString("utf8"));
  const reference = { key: options["--manifest-key"], sha256: options["--manifest-sha256"] };
  validateResumeReport(prior, taskRef, reference);
  const runId = `restore-${taskRef}-${randomUUID()}`;
  const directory = "docs/operations/episode-backup-drills", reportPath = join(directory, `${runId}.json`);
  const report: Record<string, any> = {
    format: "holahola-episode-restore-drill", version: 1, mode: "restore-resume", taskRef, runId,
    startedAt: new Date().toISOString(), status: "running", phase: "ownership", phases: [],
    resumedFrom: { runId: prior.runId, path: options["--restore-from"], sha256: backupHash(priorBytes) },
    approval: { challengeId: options["--challenge-id"], receiptId: options["--receipt-id"] },
    reference, liveExportPerformed: false, sourceRecaptured: false, restoreVerified: false,
    schemaEvidenceRechecked: false, cleanup: "not-created",
    canary: { rerun: false, original: prior.canary },
    originalReadbackEvidence: "Inferred from failed branch-create boundary in original runner; independently repeated below.",
    excluded: ["S3 writes", "source row recapture", "production restore", "Markdown retirement", "scheduling"],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const phase = async (name: string) => {
    report.phase = name;
    report.phases.push({ phase: name, at: new Date().toISOString() });
    const temporary = `${reportPath}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, reportPath);
    console.log(JSON.stringify({ runId, phase: name, status: report.status, reportPath }));
  };
  let client: S3Client | undefined;
  let branch: Awaited<ReturnType<typeof createBranch>> | undefined;
  let guard: ReturnType<typeof createEpisodeBackupOwnership> | undefined;
  let branchAttempted = false;
  let expectedParentId: string | undefined;
  let expectedExpiry: string | undefined;
  try {
    const ownership = new TaskOwnershipHttpClient(
      ownershipEndpoint(options["--app-url"]), required("COORDINATION_LUCA_REPLIT_TOKEN"),
    );
    const status: any = await ownership.status(options["--challenge-id"]);
    if (status.status !== "approved" || status.taskRef !== taskRef ||
        status.intendedActor !== "luca-replit" || status.receipt?.id !== options["--receipt-id"]) {
      throw new Error("New approval challenge does not identify this task and receipt");
    }
    guard = createEpisodeBackupOwnership({ taskRef, actor: "luca-replit", receiptId: options["--receipt-id"], client: ownership });
    await guard.authorize(`backup:resume:${runId}`);
    const endpoint = new URL(required("AWS_S3_ENDPOINT"));
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("Expected configured HTTPS R2 endpoint");
    }
    client = new S3Client({
      endpoint: endpoint.origin, region: "auto", maxAttempts: 1,
      credentials: { accessKeyId: required("AWS_S3_ACCESS_KEY_ID"), secretAccessKey: required("AWS_S3_SECRET_ACCESS_KEY") },
    });
    const adapter = createEpisodeBackupS3Store(client, required("AWS_S3_DESTINATION_BUCKET"), async () => {
      throw new Error("Restore-only runner forbids S3 writes");
    });
    const store = { read: adapter.read, putNew: async () => { throw new Error("Restore-only store"); } };
    await phase("backup-only-readback");
    const backup = await verifyResumeBackup(store, prior, taskRef, reference);
    report.backupOnlyReadbackCompleted = true;
    report.records = backup.records.length;
    report.contentBytes = backup.contentBytes;
    report.contentInventorySha256 = backup.inventory;
    report.manifestStatus = "verified";
    report.sourceEvidence = backup.evidence;
    const sourceUrl = required("NEON_SHARED_DATABASE_URL");
    await phase("schema-preflight");
    await assertEpisodeBackupSchema(sourceUrl, backup.evidence);
    report.schemaEvidenceRechecked = true;
    const branches = await listBranches();
    if (branches.some(b => b.name === prior.runId || b.name.startsWith(`restore-${taskRef}-`))) {
      throw new Error("An original or earlier resume branch remains; do not create another");
    }
    report.originalBranchAbsent = true;
    const parent = branches.find(b => b.name === "production") ?? branches.find(b => b.default);
    if (!parent) throw new Error("Cannot establish production parent identity");
    expectedParentId = parent.id;
    const parentUrl = new URL(await fetchConnectionUri(parent.id, true));
    if (parentUrl.hostname.replace(/-pooler(?=\.)/, "") !== new URL(sourceUrl).hostname.replace(/-pooler(?=\.)/, "")) {
      throw new Error("Branch parent differs from source endpoint");
    }
    // Minimum start budgets, not a worst-case runtime guarantee. Fresh proofs
    // still gate writes/cleanup; the one-hour Neon expiry is the crash backstop.
    await guard.requireRemainingMs(5 * 60_000);
    expectedExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    report.creationRequest = { name: runId, parentId: parent.id, schemaOnly: true, expiresAt: expectedExpiry };
    await phase("branch-create");
    branchAttempted = true;
    branch = await createBranch({
      name: runId, parent: parent.id, schemaOnly: true, taskRef, probeOwnership: guard.probe,
      expiresAt: expectedExpiry,
      onCreated: async created => {
        branch = created;
        report.branch = { id: created.id, name: created.name, parentId: created.parent_id };
        report.cleanup = "pending";
        await phase("branch-created");
      },
    });
    assertEpisodeRestoreBranch(branch, { id: branch.id, name: runId, parentId: expectedParentId, expiresAt: expectedExpiry });
    const targetUrl = await fetchConnectionUri(branch.id, false);
    assertIsolatedEpisodeTarget(sourceUrl, targetUrl);
    await guard.requireRemainingMs(3 * 60_000);
    await phase("restore");
    await restoreEpisodeBackupPostgres({
      sourceUrl, targetUrl, records: backup.records, sourceColumns: backup.evidence.columns,
      sourceConstraints: backup.evidence.constraints,
      authorize: () => guard!.authorize(`postgres:restore:${runId}:${branch!.id}`),
    });
    report.restoreVerified = true;
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = { phase: report.phase, category: error instanceof Error ? error.name : "UnknownFailure" };
  } finally {
    // A lost POST response may hide a created branch. Never report absence
    // merely because createBranch did not return.
    if (branchAttempted && !branch) {
      try {
        const candidates = (await listBranches()).filter(b => b.name === runId);
        if (candidates.length > 1 || !expectedParentId || !expectedExpiry) {
          throw new Error("Ambiguous branch identity after create failure");
        }
        if (candidates.length === 1) {
          assertEpisodeRestoreBranch(candidates[0], { id: candidates[0].id, name: runId, parentId: expectedParentId, expiresAt: expectedExpiry });
          branch = candidates[0];
          report.branch = { id: branch.id, name: branch.name, parentId: branch.parent_id };
          report.cleanup = "pending";
        } else {
          report.cleanup = "not-observed-needs-operator";
          report.status = "failed";
        }
      } catch {
        report.cleanup = "unknown-needs-operator";
        report.status = "failed";
      }
    }
    if (branch && guard) {
      try { await phase("cleanup"); }
      catch { report.reportWriteFailed = true; }
      try {
        const current = await resolveBranch(branch.id);
        if (!expectedParentId || !expectedExpiry) throw new Error("Missing branch creation identity");
        assertEpisodeRestoreBranch(current, { id: branch.id, name: runId, parentId: expectedParentId, expiresAt: expectedExpiry });
        await deleteBranchByNameOrId(branch.id, false, taskRef, guard.probe);
        if ((await listBranches()).some(b => b.id === branch!.id || b.name === runId)) {
          throw new Error("Deleted branch still appears in control plane");
        }
        report.cleanup = "deleted";
      } catch {
        report.cleanup = "failed-needs-operator";
        report.status = "failed";
      }
    }
    client?.destroy();
    report.finishedAt = new Date().toISOString();
    await phase("finished");
  }
  if (report.status !== "passed" || report.cleanup !== "deleted") process.exitCode = 1;
}

if (basename(process.argv[1] ?? "") === "episode-backup-restore-resume.ts") {
  main(process.argv.slice(2)).catch(() => {
    console.error("Restore resume setup/reporting failed; no success claimed.");
    process.exitCode = 1;
  });
}
