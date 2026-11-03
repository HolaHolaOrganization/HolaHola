/**
 * The S3-compatible BackupStore for the episode backup (episode-backup.ts),
 * on the bucket the maintenance archive already uses. Every write is a
 * conditional create (If-None-Match: *), so the storage itself refuses to
 * replace an object, not only this code. There is no delete.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { BackupStore, StoredObject } from './episode-backup';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[EpisodeBackup] ${name} is required.`);
  return value;
}

export function s3BackupStoreFromEnv(): { store: BackupStore; bucket: string } {
  const bucket = process.env.EPISODE_BACKUP_BUCKET?.trim()
    || process.env.AWS_S3_DESTINATION_BUCKET?.trim()
    || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID?.trim();
  if (!bucket) throw new Error('[EpisodeBackup] Set EPISODE_BACKUP_BUCKET, AWS_S3_DESTINATION_BUCKET or DEFAULT_OBJECT_STORAGE_BUCKET_ID.');
  const endpoint = process.env.AWS_S3_ENDPOINT?.trim();
  const client = new S3Client({
    // Cloudflare R2 uses the S3-compatible "auto" region (as maintenanceArchive.ts does).
    region: process.env.AWS_S3_REGION?.trim() || 'auto',
    credentials: {
      accessKeyId: process.env.EPISODE_BACKUP_ACCESS_KEY_ID?.trim() || requiredEnv('AWS_S3_ACCESS_KEY_ID'),
      secretAccessKey: process.env.EPISODE_BACKUP_SECRET_ACCESS_KEY?.trim() || requiredEnv('AWS_S3_SECRET_ACCESS_KEY'),
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  return { store: s3BackupStore(client, bucket), bucket };
}

export function s3BackupStore(client: S3Client, bucket: string): BackupStore {
  return {
    async get(key: string): Promise<StoredObject | null> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        return { bytes: Buffer.concat(chunks), metadata: response.Metadata ?? {} };
      } catch (error: any) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async putNew(key: string, body: Buffer, metadata: Record<string, string>, contentType: string): Promise<void> {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata, IfNoneMatch: '*',
      }));
    },
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
