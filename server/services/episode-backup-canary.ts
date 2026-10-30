import {
  DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client,
} from "@aws-sdk/client-s3";
import { backupHash } from "./episode-backup";

/** Permanent, explicitly synthetic objects. Never tries a destructive call on source data. */
export async function verifyEpisodeBackupLock(input: {
  client: S3Client; bucket: string; runId: string;
  authorize: (action: string) => Promise<void>;
}): Promise<{ key: string; sha256: string; overwrite: string; deletion: string }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.runId)) throw new Error("Invalid canary identity");
  const key = `episode-backups/v1/canaries/${input.runId}.json`;
  const bytes = Buffer.from(JSON.stringify({ synthetic: true, purpose: "permanent lock verification", runId: input.runId }));
  const read = async () => {
    const result = await input.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: key }));
    if (!result.Body || !Buffer.from(await result.Body.transformToByteArray()).equals(bytes)) {
      throw new Error("Canary readback changed or missing");
    }
  };
  await input.authorize(`s3:canary:create:${key}`);
  await input.client.send(new PutObjectCommand({
    Bucket: input.bucket, Key: key, Body: bytes, IfNoneMatch: "*",
    ContentType: "application/json", CacheControl: "private, no-store",
  }));
  await read();
  for (const operation of ["overwrite", "delete"] as const) {
    await input.authorize(`s3:canary:${operation}:${key}`);
    let locked = false;
    try {
      await input.client.send(operation === "overwrite"
        ? new PutObjectCommand({ Bucket: input.bucket, Key: key, Body: Buffer.from("synthetic overwrite probe") })
        : new DeleteObjectCommand({ Bucket: input.bucket, Key: key }));
    } catch (error) {
      const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      locked = e.$metadata?.httpStatusCode === 409
        && (e.name === "ObjectLockedByBucketPolicy" || e.Code === "ObjectLockedByBucketPolicy");
      if (!locked) throw new Error(`Canary ${operation} did not prove the R2 lock`);
    }
    if (!locked) throw new Error(`Canary ${operation} unexpectedly succeeded; stopping before source backup`);
    await read();
  }
  return { key, sha256: backupHash(bytes), overwrite: "ObjectLockedByBucketPolicy", deletion: "ObjectLockedByBucketPolicy" };
}
