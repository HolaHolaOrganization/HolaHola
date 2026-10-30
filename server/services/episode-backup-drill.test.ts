import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { verifyEpisodeBackupLock } from "./episode-backup-canary";
import { assertIsolatedEpisodeTarget } from "./episode-backup-postgres";
import { exportEpisodeBackup, restoreEpisodeBackup } from "./episode-backup";
import { createEpisodeBackupOwnership } from "./episode-backup-ownership";
import type { TaskOwnershipHttpClient } from "./task-ownership-client";
import { drillArguments } from "../scripts/episode-backup-drill";

test("canary accepts only lock-specific overwrite AND delete denial with exact readbacks", async () => {
  for (const outcome of ["locked", "403", "generic409", "overwrite-allowed", "delete-allowed", "changed"]) {
    const calls: string[] = [];
    let bytes = Buffer.alloc(0);
    const client = { send: async (command: any) => {
      if (command instanceof GetObjectCommand) {
        calls.push("get");
        return { Body: { transformToByteArray: async () => outcome === "changed" ? Buffer.from("wrong") : bytes } };
      }
      if (command instanceof PutObjectCommand && command.input.IfNoneMatch === "*") {
        calls.push("create");
        bytes = command.input.Body as Buffer;
        return {};
      }
      calls.push(command instanceof DeleteObjectCommand ? "delete" : "overwrite");
      if (outcome === "overwrite-allowed" && command instanceof PutObjectCommand) return {};
      if (outcome === "delete-allowed" && command instanceof DeleteObjectCommand) return {};
      throw { name: outcome === "403" || outcome === "generic409" ? "AccessDenied" : "ObjectLockedByBucketPolicy",
        $metadata: { httpStatusCode: outcome === "403" ? 403 : 409 } };
    } } as unknown as S3Client;
    let authorizations = 0;
    const run = () => verifyEpisodeBackupLock({ client, bucket: "test", runId: "synthetic", authorize: async () => { authorizations++; } });
    if (outcome === "locked") {
      const result = await run();
      assert.equal(result.deletion, "ObjectLockedByBucketPolicy");
      assert.deepEqual(calls, ["create", "get", "overwrite", "get", "delete", "get"]);
      assert.equal(authorizations, 3);
    } else await assert.rejects(run());
    if (outcome === "overwrite-allowed") assert.ok(!calls.includes("delete"));
  }
});

test("canary denied before creation never reaches object store", async () => {
  await assert.rejects(verifyEpisodeBackupLock({
    client: { send: async () => assert.fail("network reached") } as unknown as S3Client,
    bucket: "test", runId: "synthetic", authorize: async () => { throw new Error("denied"); },
  }), /denied/);
});

test("restore refuses same Neon endpoint even across pooler alias or a different database", () => {
  const source = "postgresql://u:p@ep-source-123.us-east-2.aws.neon.tech/app";
  for (const target of [
    source, source.replace("ep-source-123.", "ep-source-123-pooler."),
    source.replace("/app", "/different"), source.replace("ep-source-123", "localhost"),
    source.replace("ep-source-123", "ep-disposable").replace("/app", "/wrong"),
  ]) assert.throws(() => assertIsolatedEpisodeTarget(source, target));
  assert.doesNotThrow(() => assertIsolatedEpisodeTarget(source, source.replace("ep-source-123", "ep-disposable")));
});

test("runner requires an explicit baseline or prior receipt, never silently chooses newest", () => {
  const common = ["--task-ref", "1745", "--receipt-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.throws(() => drillArguments(common));
  assert.throws(() => drillArguments([...common, "--initial-baseline", "--previous-receipt", "report.json"]));
  assert.throws(() => drillArguments([...common, "--initial-baseline", "--initial-baseline"]));
  assert.throws(() => drillArguments([...common, "--initial-baseline", "--force"]));
  assert.ok(drillArguments([...common, "--initial-baseline"]));
  assert.ok(drillArguments([...common, "--previous-receipt", "report.json"]));
});

test("bounded parallel exporter drains failed batch and never publishes a manifest", async () => {
  const objects = new Map<string, Buffer>();
  let running = 0, peak = 0, finished = 0;
  const store = {
    read: async (key: string) => objects.get(key)!,
    putNew: async (key: string, bytes: Buffer) => {
      assert.ok(!key.includes("/manifests/"));
      peak = Math.max(peak, ++running);
      await new Promise(r => setTimeout(r, 5));
      running--; finished++;
      if (JSON.parse(bytes.toString()).id === "1") throw new Error("synthetic upload failure");
      objects.set(key, bytes);
    },
  };
  await assert.rejects(exportEpisodeBackup({
    store, records: Array.from({ length: 8 }, (_, i) => ({ id: String(i), content: "café\r\n🌎" })),
    snapshotId: "test", createdAt: new Date().toISOString(), previous: null, concurrency: 4,
  }), /synthetic/);
  assert.equal(peak, 4); assert.equal(running, 0); assert.equal(finished, 4);
});

test("parallel export keeps inventory order and full metadata on backup-only restore", async () => {
  const objects = new Map<string, Buffer>();
  const store = { read: async (key: string) => objects.get(key)!, putNew: async (k: string, b: Buffer) => { objects.set(k, b); } };
  const result = await exportEpisodeBackup({
    store, records: [{ id: "b", content: "b", attribution: { author: "synthetic" } }, { id: "a", content: "a" }],
    snapshotId: "parallel", createdAt: new Date().toISOString(), previous: null, concurrency: 8,
    sourceEvidence: { migrationHead: "synthetic" },
  });
  assert.deepEqual(result.manifest.records.map(r => r.id), ["a", "b"]);
  assert.deepEqual(result.manifest.sourceEvidence, { migrationHead: "synthetic" });
  assert.equal((await restoreEpisodeBackup(store, result.reference)).length, 2);
});

test("ownership rejects wrong task/actor, missing artifact and symlink before server proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "backup-ownership-"));
  try {
    const client = {} as TaskOwnershipHttpClient;
    const guard = createEpisodeBackupOwnership({ taskRef: "1745", actor: "luca-replit", receiptId: "synthetic", client, rootDir: root });
    await assert.rejects(guard.probe("1746"), /binding/);
    await assert.rejects(guard.probe("1745", "luca-claude-code"), /binding/);
    await assert.rejects(guard.authorize("synthetic:write"));
    await mkdir(join(root, ".local/tasks"), { recursive: true });
    await writeFile(join(root, "original.md"), "synthetic artifact");
    await symlink(join(root, "original.md"), join(root, ".local/tasks/task-1745.md"));
    await assert.rejects(guard.authorize("synthetic:write"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
