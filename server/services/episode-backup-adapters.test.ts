import assert from "node:assert/strict";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createEpisodeBackupS3Store, decodeEpisodeSnapshot, EPISODE_BACKUP_SNAPSHOT_SQL } from "./episode-backup-adapters";
import { backupHash } from "./episode-backup";

function fakeClient(send: (command: GetObjectCommand | PutObjectCommand) => Promise<unknown>): S3Client {
  return { send } as unknown as S3Client;
}
const body = (bytes: Buffer) => ({ Body: { transformToByteArray: async () => bytes } });
const bytes = Buffer.from('{"exact":"café\\r\\n🌎"}');
const key = `episode-backups/v1/objects/${backupHash(bytes)}.json`;

test("conditional create is mandatory, private, and preceded by authorization", async () => {
  let authorized = false, writes = 0;
  const client = fakeClient(async command => {
    assert.ok(authorized);
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.IfNoneMatch, "*");
    assert.equal(command.input.CacheControl, "private, no-store");
    assert.equal(command.input.ACL, undefined);
    writes++;
    return {};
  });
  await createEpisodeBackupS3Store(client, "private-backup", async () => { authorized = true; }).putNew(key, bytes);
  assert.equal(writes, 1);
});

test("a denied authorization reaches neither storage nor its credentials", async () => {
  const store = createEpisodeBackupS3Store(fakeClient(async () => { assert.fail("network reached"); }),
    "private-backup", async () => { throw new Error("ownership blocked"); });
  await assert.rejects(store.putNew(key, bytes), /ownership blocked/);
  await assert.rejects(store.putNew("../wrong", bytes), /Invalid/);
});

test("existing exact object is reusable; different existing bytes fail closed", async () => {
  for (const existing of [bytes, Buffer.from("different")]) {
    let writes = 0;
    const store = createEpisodeBackupS3Store(fakeClient(async command => {
      if (command instanceof PutObjectCommand) {
        writes++;
        throw { $metadata: { httpStatusCode: 412 } };
      }
      return body(existing);
    }), "private-backup", async () => {});
    if (existing.equals(bytes)) await store.putNew(key, bytes);
    else await assert.rejects(store.putNew(key, bytes), /Refusing/);
    assert.equal(writes, 1);
  }
});

test("unsupported conditional writes, permission failures and conflicts have no overwrite fallback", async () => {
  for (const code of [403, 409, 500, 501]) {
    let calls = 0;
    const store = createEpisodeBackupS3Store(fakeClient(async () => {
      calls++;
      throw { $metadata: { httpStatusCode: code } };
    }), "private-backup", async () => {});
    await assert.rejects(store.putNew(key, bytes));
    assert.equal(calls, 1);
  }
});

test("R2 lock-before-condition responses allow exact readback only, not an overwrite", async () => {
  for (const existing of [bytes, Buffer.from("changed")]) {
    let writes = 0;
    const store = createEpisodeBackupS3Store(fakeClient(async command => {
      if (command instanceof PutObjectCommand) {
        writes++;
        throw { name: "ObjectLockedByBucketPolicy", $metadata: { httpStatusCode: 409 } };
      }
      return body(existing);
    }), "private-backup", async () => {});
    if (existing.equals(bytes)) await store.putNew(key, bytes);
    else await assert.rejects(store.putNew(key, bytes), /Refusing/);
    assert.equal(writes, 1);
  }
});

test("snapshot includes full metadata/hidden rows and has no catalog limit", () => {
  const row = { id: "hidden", content: "source\r\n", tags: ["fixture"], recorded_at: "2026-10-30T00:00:00.123456" };
  assert.deepEqual(decodeEpisodeSnapshot([{ row_json: JSON.stringify(row) }]), [row]);
  assert.match(EPISODE_BACKUP_SNAPSHOT_SQL, /HolaHola Stories/);
  assert.match(EPISODE_BACKUP_SNAPSHOT_SQL, /episode-story/);
  assert.doesNotMatch(EPISODE_BACKUP_SNAPSHOT_SQL, /\bLIMIT\b|\bOFFSET\b|\bhidden\b/i);
  assert.throws(() => decodeEpisodeSnapshot([{ row_json: '{"id":"x","content":null}' }]), /Invalid/);
});
