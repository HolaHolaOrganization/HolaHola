import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";

import {
  assertIndependentReplica,
  normalizeReplicaRegion,
  receiptContent,
  replicate,
  upload,
} from "./reconciliation-history-object-storage.ts";
import { InfraMutationBlockedError } from "../server/services/infra-mutation-guard";
import type { TaskOwnershipResult } from "../server/services/task-ownership-service";

function ownershipResult(state: TaskOwnershipResult["state"]): TaskOwnershipResult {
  return {
    ok: state !== "unknown_stop",
    state,
    taskRef: "1470",
    evidence: {
      taskRef: "1470",
      taskArtifact: { path: "/dev/null", exists: false, regularFile: false },
      checkout: { kind: "primary_worktree", gitMetadataPath: "/dev/null" },
      verifiedActiveMainReceipt: state === "main_session",
    },
    contradictions: [],
    explanation: `stub:${state}`,
  };
}

const primary = {
  bucket: "primary-history",
  prefix: "history-archives/reconciliation-2026-08-21",
  region: "primary-region",
  accessKeyId: "primary-access-key",
  secretAccessKey: "primary-secret-key",
  endpoint: "https://primary.example.test",
  accountLabel: "primary-archive",
};

const replica = {
  bucket: "independent-history",
  prefix: "history-archives/reconciliation-2026-08-21",
  region: "replica-region",
  accessKeyId: "replica-access-key",
  secretAccessKey: "replica-secret-key",
  endpoint: "https://replica.example.test",
  accountLabel: "independent-replica",
};

test("independent replica guard accepts separate account configuration", () => {
  assert.doesNotThrow(() => assertIndependentReplica(primary, replica));
});

test("independent replica guard rejects primary credential reuse", () => {
  assert.throws(
    () => assertIndependentReplica(primary, { ...replica, accessKeyId: primary.accessKeyId }),
    /must not reuse the primary archive access key/,
  );
});

test("independent replica guard rejects an unchanged destination", () => {
  assert.throws(
    () => assertIndependentReplica(primary, {
      ...replica,
      bucket: primary.bucket,
      endpoint: primary.endpoint,
    }),
    /must use a different bucket or endpoint/,
  );
});

test("independent replica guard rejects a manifest-breaking prefix", () => {
  assert.throws(
    () => assertIndependentReplica(primary, {
      ...replica,
      prefix: "other-history-archive",
    }),
    /replica prefix must match/,
  );
});

test("Cloudflare R2 location labels normalize to the S3 API region", () => {
  assert.equal(
    normalizeReplicaRegion(
      " Eastern North America (ENAM) ",
      "https://account.r2.cloudflarestorage.com",
    ),
    "auto",
  );
});

test("non-R2 region values are only whitespace-trimmed", () => {
  assert.equal(
    normalizeReplicaRegion(" us-east-1 ", "https://s3.example.test"),
    "us-east-1",
  );
});

test("replication receipt records checksums without recording credentials", () => {
  const receipt = receiptContent(primary, replica, {
    bundleSha256: "bundle-sha",
    bundleBytes: 123,
    manifestSha256: "manifest-sha",
    manifestBytes: 456,
  });

  assert.match(receipt, /^bundle_sha256=bundle-sha$/m);
  assert.match(receipt, /^manifest_sha256=manifest-sha$/m);
  assert.match(receipt, /^credentials=not-recorded$/m);
  assert.match(receipt, /^recovery_rule=never-force-push-or-overwrite-github-main$/m);
  assert.doesNotMatch(receipt, /primary-secret-key|replica-secret-key|primary-access-key|replica-access-key/);
});

test("upload() never touches S3 when ownership is unknown_stop", async () => {
  let sendCalls = 0;
  const fakeClient = {
    send: async () => {
      sendCalls += 1;
      throw new Error("S3 must not be called when ownership is unknown_stop");
    },
  } as unknown as S3Client;

  await assert.rejects(
    () => upload(
      fakeClient,
      primary,
      "/nonexistent/reconciliation-2026-08-21.bundle",
      "/nonexistent/manifest.txt",
      "1470",
      async () => ownershipResult("unknown_stop"),
    ),
    (error: unknown) => error instanceof InfraMutationBlockedError
      && error.state === "unknown_stop"
      && error.action === `s3:reconciliation_archive_upload:${primary.accountLabel}`,
  );
  assert.equal(sendCalls, 0, "the gate must refuse before any S3 call is attempted");
});

test("upload() reaches a real S3 mutation once ownership is proven", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "reconciliation-upload-test-"));
  const bundlePath = join(workDir, "reconciliation-2026-08-21.bundle");
  const manifestPath = join(workDir, "manifest.txt");
  await writeFile(bundlePath, "fake bundle contents");
  await writeFile(manifestPath, "fake manifest contents");

  const sendCalls: string[] = [];
  const fakeClient = {
    send: async (command: { constructor: { name: string } }) => {
      sendCalls.push(command.constructor.name);
      if (command.constructor.name === "HeadObjectCommand") {
        const notFound = new Error("not found") as Error & { $metadata: { httpStatusCode: number } };
        notFound.$metadata = { httpStatusCode: 404 };
        throw notFound;
      }
      throw new Error("STOP-AFTER-GATE");
    },
  } as unknown as S3Client;

  try {
    await assert.rejects(
      () => upload(
        fakeClient,
        primary,
        bundlePath,
        manifestPath,
        "1470",
        async () => ownershipResult("main_session"),
      ),
      /STOP-AFTER-GATE/,
    );
    assert.ok(
      sendCalls.includes("CreateMultipartUploadCommand"),
      "the gate must allow a real S3 mutation to be attempted once ownership is proven",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// The reference Cloudflare DNS implementation's tests only ever exercise an
// injected probeOwnership stub, never the real default (new
// TaskOwnershipService().probe(taskRef), no overrides) -- a task #1470
// review finding was that this leaves the actual production code path
// unverified. These two tests omit probeOwnership entirely, so they go
// through the real default. There is no .local/tasks/task-999999999.md in
// this checkout and no verified receipt/proof callback is wired in, so the
// honest, correct answer is unknown_stop -- proving the real default fails
// closed rather than merely proving an injected stub does.
test("upload() fails closed through the *real* default ownership probe for a task with no local artifact", async () => {
  let sendCalls = 0;
  const fakeClient = {
    send: async () => {
      sendCalls += 1;
      throw new Error("S3 must not be called when the real default probe resolves to unknown_stop");
    },
  } as unknown as S3Client;

  await assert.rejects(
    () => upload(fakeClient, primary, "/nonexistent/reconciliation-2026-08-21.bundle", "/nonexistent/manifest.txt", "999999999"),
    (error: unknown) => error instanceof InfraMutationBlockedError && error.state === "unknown_stop",
  );
  assert.equal(sendCalls, 0);
});

test("replicate() fails closed through the *real* default ownership probe for a task with no local artifact", async () => {
  await assert.rejects(
    () => replicate("999999999"),
    (error: unknown) => error instanceof InfraMutationBlockedError && error.state === "unknown_stop",
  );
});

test("replicate() never resolves storage config or touches S3 when ownership is unknown_stop", async () => {
  // No archive-storage env vars are set up for this test. If the gate did not
  // run first, this would instead fail inside primaryConfig() with a missing
  // -env-var error -- getting InfraMutationBlockedError here proves the gate
  // is the very first thing replicate() does.
  await assert.rejects(
    () => replicate("1470", async () => ownershipResult("unknown_stop")),
    (error: unknown) => error instanceof InfraMutationBlockedError
      && error.state === "unknown_stop"
      && error.action === "s3:reconciliation_archive_replicate",
  );
});

test("replicate() proceeds past the ownership gate when ownership is proven", async () => {
  // Force primaryConfig() to fail deterministically right after the gate, so
  // this test can never reach a real S3 call regardless of which archive
  // credentials happen to be configured in the running environment.
  // A fixture bucket name is set so the failure is the credential check, not
  // "no bucket configured" -- CI receives no storage secrets at all.
  const keys = ["AWS_S3_ACCESS_KEY_ID", "AWS_S3_REGION", "RECONCILIATION_ARCHIVE_BUCKET"] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.AWS_S3_ACCESS_KEY_ID;
  delete process.env.AWS_S3_REGION;
  process.env.RECONCILIATION_ARCHIVE_BUCKET = "fixture-reconciliation-archive";
  try {
    await assert.rejects(
      () => replicate("1470", async () => ownershipResult("main_session")),
      (error: unknown) => !(error instanceof InfraMutationBlockedError)
        && error instanceof Error
        && /AWS_S3_REGION|AWS_S3_ACCESS_KEY_ID/.test(error.message),
    );
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});