import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { backupHash, exportEpisodeBackup, verifyRestoredEpisodeInventory } from "./episode-backup";
import { resumeArguments, validateResumeReport, verifyResumeBackup } from "./episode-backup-resume";

async function fixture() {
  const objects = new Map<string, Buffer>();
  let writes = 0;
  const store = {
    read: async (key: string) => objects.get(key)!,
    putNew: async (key: string, bytes: Buffer) => { writes++; objects.set(key, bytes); },
  };
  const records = [{ id: "a", content: "ñ\n故事", tags: ["hidden"], attribution: { author: "synthetic" } }];
  const evidence = { columns: [{ name: "id", type: "text", generated: "", identity: "" }], constraints: [], triggers: [] };
  const runId = "drill-900003-10000000-0000-4000-8000-000000000001";
  const exported = await exportEpisodeBackup({
    store, records, snapshotId: runId, createdAt: new Date().toISOString(), previous: null, sourceEvidence: evidence,
  });
  const prior = {
    format: "holahola-episode-restore-drill", version: 1, taskRef: "900003", runId,
    status: "failed", failure: { phase: "branch-create" }, liveExportPerformed: true,
    manifestStatus: "verified", restoreVerified: false, cleanup: "not-created",
    reference: exported.reference, records: records.length,
    contentBytes: Buffer.byteLength(records[0].content), sourceEvidence: evidence,
    contentInventorySha256: backupHash(Buffer.from(JSON.stringify(records.map(r => ({
      id: r.id, bytes: Buffer.byteLength(r.content), sha256: backupHash(Buffer.from(r.content)),
    }))))),
    canary: { overwrite: "ObjectLockedByBucketPolicy", deletion: "ObjectLockedByBucketPolicy" },
  };
  return { store, objects, records, prior, anchor: exported.reference, writes: () => writes };
}
test("restore-only verification authenticates all backup metadata/content and never writes", async () => {
  const f = await fixture(), before = f.writes();
  const result = await verifyResumeBackup(f.store, f.prior, "900003", f.anchor);
  assert.deepEqual(result.records, f.records);
  assert.equal(f.writes(), before);
});
test("restore comparison never treats distinct Date timestamps as equal empty objects", () => {
  assert.throws(() => verifyRestoredEpisodeInventory(
    [{ id: "synthetic", content: "", recorded_at: new Date(0) }],
    [{ id: "synthetic", content: "", recorded_at: new Date(1) }],
  ), /plain JSON/);
  assert.throws(() => verifyRestoredEpisodeInventory(
    [{ id: "synthetic", content: "", value: 1n }],
    [{ id: "synthetic", content: "", value: 1n }],
  ), /plain JSON/);
});
test("manifest anchor is independently required and tampering fails", async () => {
  const f = await fixture();
  await assert.rejects(verifyResumeBackup(f.store, f.prior, "900003", { ...f.anchor, sha256: "a".repeat(64) }));
  f.objects.set(f.anchor.key, Buffer.from("{}"));
  await assert.rejects(verifyResumeBackup(f.store, f.prior, "900003", f.anchor), /checksum/);
});
for (const patch of [
  { taskRef: "900004" }, { status: "passed" }, { failure: { phase: "export" } },
  { cleanup: "pending" }, { branch: { id: "synthetic" } }, { manifestStatus: "flagged" },
  { liveExportPerformed: false }, { restoreVerified: true },
  { canary: { overwrite: "AccessDenied", deletion: "ObjectLockedByBucketPolicy" } },
]) {
  test(`unresumable prior report refused: ${JSON.stringify(patch)}`, async () => {
    const f = await fixture();
    assert.throws(() => validateResumeReport({ ...f.prior, ...patch }, "900003", f.anchor), /resumable/);
  });
}
test("inventory, count, byte length and schema evidence are rechecked", async () => {
  const f = await fixture();
  for (const patch of [
    { records: 2 }, { contentBytes: 999 }, { contentInventorySha256: "a".repeat(64) },
    { sourceEvidence: { ...f.prior.sourceEvidence, columns: [] } },
  ]) await assert.rejects(verifyResumeBackup(f.store, { ...f.prior, ...patch }, "900003", f.anchor));
});
test("corrupted backup object blocks restore before target creation", async () => {
  const f = await fixture();
  const key = [...f.objects.keys()].find(k => k.includes("/objects/"))!;
  f.objects.set(key, Buffer.from('{"content":"tampered"}'));
  await assert.rejects(verifyResumeBackup(f.store, f.prior, "900003", f.anchor), /verification/);
});
test("arguments require explicit new approval and independent anchor; no export modes", () => {
  const valid = [
    "--task-ref", "900003", "--receipt-id", "10000000-0000-4000-8000-000000000001",
    "--challenge-id", "10000000-0000-4000-8000-000000000002", "--app-url", "https://example.com",
    "--restore-from", "failed.json", "--manifest-key", "episode-backups/v1/manifests/synthetic.json",
    "--manifest-sha256", "a".repeat(64),
  ];
  assert.ok(resumeArguments(valid));
  assert.throws(() => resumeArguments(valid.slice(0, -2)));
  assert.throws(() => resumeArguments([...valid, "--initial-baseline"]));
  assert.throws(() => resumeArguments([...valid, "--receipt-id", "other"]));
});
test("resume entrypoint has no capture/export/canary mutation and keeps guarded target writes", async () => {
  const source = await readFile(new URL("../scripts/episode-backup-restore-resume.ts", import.meta.url), "utf8");
  for (const forbidden of ["captureEpisodeBackup(", "exportEpisodeBackup(", "verifyEpisodeBackupLock(", "PutObjectCommand", "DeleteObjectCommand"]) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
  for (const required of ["requireRemainingMs", "probeOwnership: guard.probe", "restoreEpisodeBackupPostgres(", "deleteBranchByNameOrId("]) {
    assert.ok(source.includes(required), required);
  }
});
