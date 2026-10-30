import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { backupHash, type EpisodeBackupRecord, type EpisodeBackupStore } from "./episode-backup";

/**
 * Includes hidden/test rows and every row in the episode/story arcs. Tagged
 * stories outside those arcs are included too. The human reader's filters,
 * pagination and parent-link requirements are intentionally not used.
 * row_to_json keeps original metadata/timestamp precision rather than a
 * handpicked subset of columns. This is not a backup of messages/embeddings.
 */
export const EPISODE_BACKUP_SNAPSHOT_SQL = `
  SELECT row_to_json(m)::text AS row_json
  FROM conversation_memories m
  WHERE m.arc_name IN ('HolaHola Episodes', 'HolaHola Stories')
     OR 'episode-story' = ANY(COALESCE(m.tags, '{}'::text[]))
  ORDER BY m.id
`;

export function decodeEpisodeSnapshot(rows: { row_json: string }[]): EpisodeBackupRecord[] {
  return rows.map(row => {
    const record = JSON.parse(row.row_json) as EpisodeBackupRecord;
    if (!record || typeof record.id !== "string" || !record.id || typeof record.content !== "string") {
      throw new Error("Invalid canonical episode snapshot row");
    }
    return record;
  });
}

/**
 * Caller must supply a real, verified infrastructure authorization guard.
 * Storage-policy/custody verification is a separate prerequisite: this
 * adapter cannot infer lack of destructive permissions from an S3 403.
 * No ambient credentials, deletion, overwrite fallback, public ACL or
 * bucket-policy mutation is supplied here.
 */
export function createEpisodeBackupS3Store(
  client: S3Client,
  bucket: string,
  authorizeWrite: (key: string) => Promise<void>,
): EpisodeBackupStore {
  if (!bucket || typeof authorizeWrite !== "function") throw new Error("Backup write authorization is required");
  const validKey = (key: string) => {
    if (!/^episode-backups\/v1\/(?:objects\/[a-f0-9]{64}|manifests\/[a-zA-Z0-9_-]{1,100})\.json$/.test(key)) {
      throw new Error("Invalid episode backup key");
    }
  };
  const read = async (key: string): Promise<Buffer> => {
    validKey(key);
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error("Backup object has no body");
    return Buffer.from(await result.Body.transformToByteArray());
  };
  return {
    read,
    async putNew(key, bytes) {
      validKey(key);
      await authorizeWrite(key);
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: "*",
          ContentType: "application/json", CacheControl: "private, no-store",
        }));
      } catch (error) {
        // An existing exact object is idempotent; every other failure stops.
        // Never retry with an unconditional PUT.
        // R2 checks its bucket lock before If-None-Match, returning its
        // specific lock error instead of 412. Generic 409 remains a failure.
        const failure = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
        const status = failure.$metadata?.httpStatusCode;
        const locked = status === 409
          && (failure.name === "ObjectLockedByBucketPolicy" || failure.Code === "ObjectLockedByBucketPolicy");
        if (status !== 412 && !locked) throw error;
        const existing = await read(key);
        if (existing.length !== bytes.length || backupHash(existing) !== backupHash(bytes)) {
          throw new Error("Refusing to replace an existing backup object");
        }
      }
    },
  };
}
