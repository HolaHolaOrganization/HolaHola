import { createHash } from "node:crypto";

/**
 * One-way episode backup protocol. This module has no database, credential,
 * scheduler or deletion access. The adapter must make putNew atomic
 * (S3 If-None-Match: *); an existence check followed by PUT is not sufficient.
 * A verified manifest is the commit marker, never a successful upload alone.
 */
export interface EpisodeBackupStore {
  putNew(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
}

export interface EpisodeBackupRecord {
  id: string;
  content: string;
  [column: string]: unknown;
}

interface InventoryEntry {
  id: string;
  key: string;
  objectHash: string;
  objectBytes: number;
  contentHash: string;
  contentBytes: number;
}

export interface BackupReference {
  key: string;
  sha256: string;
}

export interface EpisodeBackupManifest {
  format: "holahola-episode-backup";
  version: 1;
  snapshotId: string;
  createdAt: string;
  previous: BackupReference | null;
  status: "verified" | "flagged";
  issues: string[];
  records: InventoryEntry[];
  sourceEvidence?: Record<string, unknown>;
}

export const backupHash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");
const HASH = /^[a-f0-9]{64}$/;
const PREFIX = "episode-backups/v1";

function assertRecord(record: EpisodeBackupRecord): void {
  if (!record || typeof record.id !== "string" || !record.id
    || typeof record.content !== "string") {
    throw new Error("Backup records require a non-empty id and exact string content");
  }
}

function assertManifest(value: unknown): asserts value is EpisodeBackupManifest {
  const m = value as EpisodeBackupManifest;
  if (!m || m.format !== "holahola-episode-backup" || m.version !== 1
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.snapshotId)
    || !Number.isFinite(Date.parse(m.createdAt))
    || !["verified", "flagged"].includes(m.status)
    || !Array.isArray(m.issues) || m.issues.some(i => typeof i !== "string")
    || !Array.isArray(m.records) || !m.records.length
    || (m.status === "verified" && m.issues.length !== 0)
    || (m.status === "flagged" && m.issues.length === 0)) {
    throw new Error("Invalid or empty backup manifest");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const r of m.records) {
    if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id)
      || typeof r.key !== "string"
      || r.key !== `${PREFIX}/objects/${r.objectHash}.json` || keys.has(r.key)
      || !HASH.test(r.objectHash) || !HASH.test(r.contentHash)
      || !Number.isSafeInteger(r.objectBytes) || r.objectBytes < 1
      || !Number.isSafeInteger(r.contentBytes) || r.contentBytes < 0) {
      throw new Error("Invalid or duplicate inventory entry");
    }
    ids.add(r.id);
    keys.add(r.key);
  }
  if (m.previous !== null && (!m.previous || !HASH.test(m.previous.sha256)
    || !/^episode-backups\/v1\/manifests\/[a-zA-Z0-9_-]{1,100}\.json$/.test(m.previous.key))) {
    throw new Error("Invalid previous manifest reference");
  }
}

/** Hash comes from an independently retained receipt, not from this object. */
export async function readBackupManifest(
  store: EpisodeBackupStore, reference: BackupReference,
): Promise<EpisodeBackupManifest> {
  if (!HASH.test(reference.sha256)
    || !/^episode-backups\/v1\/manifests\/[a-zA-Z0-9_-]{1,100}\.json$/.test(reference.key)) {
    throw new Error("Invalid backup reference");
  }
  const bytes = await store.read(reference.key);
  if (backupHash(bytes) !== reference.sha256) throw new Error("Manifest checksum mismatch");
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  assertManifest(manifest);
  if (reference.key !== `${PREFIX}/manifests/${manifest.snapshotId}.json`) {
    throw new Error("Manifest identity mismatch");
  }
  return manifest;
}

async function readRecord(
  store: EpisodeBackupStore, entry: InventoryEntry,
): Promise<EpisodeBackupRecord> {
  const bytes = await store.read(entry.key);
  if (bytes.length !== entry.objectBytes || backupHash(bytes) !== entry.objectHash) {
    throw new Error(`Backup object verification failed for ${entry.id}`);
  }
  const row: EpisodeBackupRecord = JSON.parse(bytes.toString("utf8"));
  assertRecord(row);
  const content = Buffer.from(row.content, "utf8");
  if (row.id !== entry.id || content.length !== entry.contentBytes
    || backupHash(content) !== entry.contentHash) {
    throw new Error(`Backup content verification failed for ${entry.id}`);
  }
  return row;
}

/**
 * Reads ONLY the backup store. Does not consult the live DB or silently fill
 * missing rows from it. Caller inserts these into an EMPTY disposable target
 * transactionally, then compares the entire resulting inventory.
 */
export async function restoreEpisodeBackup(
  store: EpisodeBackupStore, reference: BackupReference,
): Promise<EpisodeBackupRecord[]> {
  const manifest = await readBackupManifest(store, reference);
  if (manifest.status !== "verified") throw new Error("Flagged snapshot is not last-known-good");
  const records: EpisodeBackupRecord[] = [];
  for (const entry of manifest.records) records.push(await readRecord(store, entry));
  return records;
}

/**
 * The complete input must come from ONE read-only repeatable-read snapshot,
 * including hidden rows. Never pass the reader's paginated/filtered catalog.
 * All fields are retained; UTF-8 content is hashed independently of metadata.
 * Previous MUST be the externally recorded last-good receipt, not a listing's
 * newest object. No destructive operation or mutable last-good pointer exists.
 */
export async function exportEpisodeBackup(input: {
  store: EpisodeBackupStore;
  records: EpisodeBackupRecord[];
  snapshotId: string;
  createdAt: string;
  previous: BackupReference | null;
  sourceEvidence?: Record<string, unknown>;
  concurrency?: number;
}): Promise<{ reference: BackupReference; manifest: EpisodeBackupManifest }> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.snapshotId)
    || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("Invalid snapshot identity");
  if (!input.records.length) throw new Error("Refusing empty episode snapshot");
  const concurrency = input.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Backup concurrency must be between 1 and 8");
  }
  const rows = new Map<string, EpisodeBackupRecord>();
  for (const row of input.records) {
    assertRecord(row);
    if (rows.has(row.id)) throw new Error("Duplicate source record id");
    rows.set(row.id, row);
  }
  const issues: string[] = [];
  if (input.previous) {
    // Verify the full prior snapshot, not only its manifest.
    const prior = await restoreEpisodeBackup(input.store, input.previous);
    for (const old of prior) {
      const row = rows.get(old.id);
      if (!row) issues.push(`missing:${old.id}`);
      else if (!Buffer.from(row.content, "utf8").subarray(0, Buffer.byteLength(old.content))
        .equals(Buffer.from(old.content, "utf8"))) issues.push(`non-prefix-change:${old.id}`);
    }
  }
  const manifest: EpisodeBackupManifest = {
    format: "holahola-episode-backup", version: 1,
    snapshotId: input.snapshotId, createdAt: input.createdAt,
    previous: input.previous, status: issues.length ? "flagged" : "verified",
    issues, records: [],
    ...(input.sourceEvidence ? { sourceEvidence: input.sourceEvidence } : {}),
  };
  const sorted = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  const upload = async (row: EpisodeBackupRecord) => {
    const bytes = encode(row), content = Buffer.from(row.content, "utf8");
    const objectHash = backupHash(bytes), key = `${PREFIX}/objects/${objectHash}.json`;
    // A content-addressed object may already exist from an earlier snapshot.
    // Adapter's putNew must allow an exact-existing object only after readback.
    await input.store.putNew(key, bytes);
    const entry = {
      id: row.id, key, objectHash, objectBytes: bytes.length,
      contentHash: backupHash(content), contentBytes: content.length,
    };
    await readRecord(input.store, entry);
    return entry;
  };
  for (let i = 0; i < sorted.length; i += concurrency) {
    // Drain the entire batch on failure; never publish a manifest while writes
    // are still running. Order remains stable regardless of network completion.
    const results = await Promise.allSettled(sorted.slice(i, i + concurrency).map(upload));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      manifest.records.push(result.value);
    }
  }
  assertManifest(manifest);
  const bytes = encode(manifest);
  const reference = {
    key: `${PREFIX}/manifests/${input.snapshotId}.json`, sha256: backupHash(bytes),
  };
  // Commit marker published last; failures above leave only orphaned objects.
  await input.store.putNew(reference.key, bytes);
  await readBackupManifest(input.store, reference);
  return { reference, manifest };
}

/** Verifies an isolated target's FULL inventory, not just exported-row matches. */
export function verifyRestoredEpisodeInventory(
  expected: EpisodeBackupRecord[], actual: EpisodeBackupRecord[],
): void {
  if (actual.length !== expected.length) throw new Error("Restored inventory count mismatch");
  const seen = new Set<string>();
  const byId = new Map(expected.map(row => [row.id, row]));
  for (const row of actual) {
    assertRecord(row);
    const original = byId.get(row.id);
    if (!original || seen.has(row.id) || row.content !== original.content) {
      throw new Error("Restored inventory identity/content mismatch");
    }
    seen.add(row.id);
    // Verify metadata too without relying on PostgreSQL JSONB key ordering.
    const stable = (v: unknown): string => {
      if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
      if ((v && typeof v === "object" && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) ||
          typeof v === "bigint" || typeof v === "undefined" || typeof v === "function" ||
          typeof v === "symbol" || (typeof v === "number" && !Number.isFinite(v))) {
        throw new Error("Restore comparison requires plain JSON values");
      }
      if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) =>
        a.localeCompare(b)).map(([k, value]) => `${JSON.stringify(k)}:${stable(value)}`).join(",")}}`;
      return JSON.stringify(v);
    };
    if (stable(row) !== stable(original)) throw new Error("Restored metadata mismatch");
  }
}
