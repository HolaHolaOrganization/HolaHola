import {
  backupHash, readBackupManifest, restoreEpisodeBackup,
  type BackupReference, type EpisodeBackupStore,
} from "./episode-backup";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function resumeArguments(args: string[]) {
  const values: Record<string, string> = {};
  const names = ["--task-ref", "--receipt-id", "--app-url", "--restore-from", "--manifest-key", "--manifest-sha256", "--challenge-id"];
  for (let i = 0; i < args.length; i++) {
    const name = args[i], value = args[++i];
    if (!names.includes(name) || name in values || !value || value.startsWith("--")) {
      throw new Error("Unsupported, duplicate or missing restore-resume argument");
    }
    values[name] = value;
  }
  if (names.some(n => !values[n]) || !/^[1-9][0-9]*$/.test(values["--task-ref"]) ||
      !UUID.test(values["--receipt-id"]) || !UUID.test(values["--challenge-id"]) ||
      !/^[a-f0-9]{64}$/.test(values["--manifest-sha256"]) ||
      !/^episode-backups\/v1\/manifests\/[a-zA-Z0-9_-]{1,100}\.json$/.test(values["--manifest-key"])) {
    throw new Error("Require exact task, new approval/receipt, failed report and independently retained manifest key/checksum");
  }
  return values;
}

export function validateResumeReport(prior: any, taskRef: string, anchor: BackupReference): void {
  if (!prior || prior.format !== "holahola-episode-restore-drill" || prior.version !== 1 ||
      prior.taskRef !== taskRef || !/^drill-[1-9][0-9]*-[a-f0-9-]{36}$/.test(prior.runId) ||
      prior.status !== "failed" || prior.failure?.phase !== "branch-create" ||
      prior.liveExportPerformed !== true || prior.manifestStatus !== "verified" ||
      prior.restoreVerified !== false || prior.cleanup !== "not-created" || prior.branch !== undefined ||
      !Number.isSafeInteger(prior.records) || prior.records < 1 ||
      !Number.isSafeInteger(prior.contentBytes) || prior.contentBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(prior.contentInventorySha256) ||
      prior.reference?.key !== anchor.key || prior.reference?.sha256 !== anchor.sha256 ||
      prior.canary?.overwrite !== "ObjectLockedByBucketPolicy" || prior.canary?.deletion !== "ObjectLockedByBucketPolicy") {
    throw new Error("Not a resumable verified export with an uncreated restore branch and matching independent anchor");
  }
}

/** No write capability is used. The hash anchor must not be derived from the report. */
export async function verifyResumeBackup(store: EpisodeBackupStore, prior: any, taskRef: string, anchor: BackupReference) {
  validateResumeReport(prior, taskRef, anchor);
  const manifest = await readBackupManifest(store, anchor);
  const evidence = manifest.sourceEvidence;
  if (manifest.snapshotId !== prior.runId || !evidence || !Array.isArray(evidence.columns) || !evidence.columns.length ||
      !Array.isArray(evidence.triggers) || evidence.triggers.length ||
      !Array.isArray(evidence.constraints) || evidence.constraints.some(c => !c || c.contype === "f") ||
      evidence.columns.some(c => !c || c.generated || c.identity) ||
      JSON.stringify(evidence) !== JSON.stringify(prior.sourceEvidence)) {
    throw new Error("Verified manifest schema evidence does not match retained export evidence");
  }
  const records = await restoreEpisodeBackup(store, anchor);
  const contentBytes = records.reduce((n, r) => n + Buffer.byteLength(r.content), 0);
  const inventory = backupHash(Buffer.from(JSON.stringify(records.map(r => ({
    id: r.id, bytes: Buffer.byteLength(r.content), sha256: backupHash(Buffer.from(r.content)),
  })))));
  if (records.length !== prior.records || contentBytes !== prior.contentBytes || inventory !== prior.contentInventorySha256) {
    throw new Error("Backup-only inventory differs from retained export receipt");
  }
  return { records, evidence, inventory, contentBytes };
}
