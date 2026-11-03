/**
 * Phase B of the one-copy episodes design (shared-spec fc90e95a, approved
 * 2026-10-30; build approved by the founder 2026-11-03): an independent,
 * one-way, verified backup of the episode and story arcs in S3-compatible
 * storage. The database stays the only writer; nothing here ever writes to it.
 *
 * One run:
 *   1. takes a coherent inventory (one read-only REPEATABLE READ transaction)
 *      of every row in BACKUP_ARCS: id, exact content, sha256, length;
 *   2. compares it with the previous last-good manifest. A missing id, a row
 *      that shrank or changed other than by prefix extension, or a catalog
 *      that emptied or fell sharply is flagged;
 *   3. uploads each row's bytes as a content-addressed object that is never
 *      overwritten, then reads each one back and verifies length and sha256;
 *   4. publishes the complete manifest and only then, when nothing was
 *      flagged, advances the last-good pointer by writing a new pointer object.
 *      A flagged run stores its manifest beside the last good one and never
 *      replaces it.
 * All writes go through BackupStore.putNew, which refuses to replace an object,
 * so the export cannot overwrite or delete anything.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';

/** The arcs Phase B backs up (Phase 0 inventory, 2026-11-03: 844 rows, about 12 MB). */
export const BACKUP_ARCS: readonly string[] = Object.freeze(['HolaHola Episodes', 'HolaHola Stories', 'HolaHola Episode Snapshots']);
export const BACKUP_PREFIX_DEFAULT = '.private/episode-backup/v1';
/** A catalog smaller than this fraction of the last good one is flagged. */
export const SHRINK_ALERT_RATIO = 0.9;

export interface InventoryRow {
  id: string;
  arcName: string;
  entryType: string;
  title: string | null;
  createdAt: string | null;
  recordedAt: string | null;
  content: string;
}

export interface ManifestEntry {
  id: string;
  arcName: string;
  entryType: string;
  title: string | null;
  createdAt: string | null;
  recordedAt: string | null;
  bytes: number;
  sha256: string;
  objectKey: string;
}

export interface BackupManifest {
  format: 'holahola-episode-backup';
  version: 1;
  takenAt: string;
  arcs: string[];
  rowCount: number;
  totalBytes: number;
  entries: ManifestEntry[];
  flags: BackupFlag[];
  previousManifestKey: string | null;
}

export type BackupFlag =
  | { kind: 'missing'; id: string }
  | { kind: 'shrank'; id: string; previousBytes: number; bytes: number }
  | { kind: 'rewritten'; id: string; previousSha256: string; sha256: string }
  | { kind: 'catalog_shrank'; previousCount: number; count: number }
  | { kind: 'catalog_empty' };

export interface StoredObject { bytes: Buffer; metadata: Record<string, string> }

/** The only storage operations the export uses. None of them replaces or deletes. */
export interface BackupStore {
  get(key: string): Promise<StoredObject | null>;
  /** Writes a new object. Must refuse (throw) if the key already exists. */
  putNew(key: string, body: Buffer, metadata: Record<string, string>, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const objectKeyFor = (prefix: string, contentSha256: string) => `${prefix}/objects/${contentSha256}.md`;

/** Pointer keys sort by time, so the newest pointer is the last good one. */
const pointerPrefix = (prefix: string) => `${prefix}/last-good/`;

export function buildManifest(rows: readonly InventoryRow[], prefix: string, takenAt: string, previous: BackupManifest | null, previousManifestKey: string | null): BackupManifest {
  const entries = rows.map((row): ManifestEntry => {
    const bytes = Buffer.from(row.content, 'utf8');
    const digest = sha256(bytes);
    return {
      id: row.id, arcName: row.arcName, entryType: row.entryType, title: row.title,
      createdAt: row.createdAt, recordedAt: row.recordedAt,
      bytes: bytes.length, sha256: digest, objectKey: objectKeyFor(prefix, digest),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: 'holahola-episode-backup', version: 1, takenAt, arcs: [...BACKUP_ARCS],
    rowCount: entries.length, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    entries, flags: compareWithPrevious(rows, entries, previous), previousManifestKey,
  };
}

/**
 * Flags anything that is not pure growth since the last good manifest. A row
 * may only gain bytes at its end: its previous bytes must still be its prefix.
 */
export function compareWithPrevious(rows: readonly InventoryRow[], entries: readonly ManifestEntry[], previous: BackupManifest | null): BackupFlag[] {
  const flags: BackupFlag[] = [];
  if (entries.length === 0) flags.push({ kind: 'catalog_empty' });
  if (!previous) return flags;
  if (entries.length < previous.rowCount * SHRINK_ALERT_RATIO) flags.push({ kind: 'catalog_shrank', previousCount: previous.rowCount, count: entries.length });
  const current = new Map(entries.map((e) => [e.id, e]));
  const content = new Map(rows.map((r) => [r.id, r.content]));
  for (const before of previous.entries) {
    const now = current.get(before.id);
    if (!now) { flags.push({ kind: 'missing', id: before.id }); continue; }
    if (now.sha256 === before.sha256) continue;
    if (now.bytes < before.bytes) { flags.push({ kind: 'shrank', id: before.id, previousBytes: before.bytes, bytes: now.bytes }); continue; }
    const prefixBytes = Buffer.from(content.get(before.id)!, 'utf8').subarray(0, before.bytes);
    if (sha256(prefixBytes) !== before.sha256) flags.push({ kind: 'rewritten', id: before.id, previousSha256: before.sha256, sha256: now.sha256 });
  }
  return flags;
}

/** One coherent, read-only snapshot of the backed-up arcs. */
export async function takeInventory(db: any, arcs: readonly string[] = BACKUP_ARCS): Promise<InventoryRow[]> {
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    const result = await tx.execute(sql`
      select id, arc_name, entry_type::text as entry_type, title, content,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
        to_char(recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
      from conversation_memories
      where arc_name in (select value from jsonb_array_elements_text(${JSON.stringify(arcs)}::jsonb) as value)
      order by id`);
    return ((result as any).rows ?? result).map((r: any): InventoryRow => ({
      id: r.id, arcName: r.arc_name, entryType: r.entry_type, title: r.title ?? null,
      createdAt: r.created_at ?? null, recordedAt: r.recorded_at ?? null, content: r.content ?? '',
    }));
  });
}

export async function readLastGood(store: BackupStore, prefix: string): Promise<{ manifest: BackupManifest; manifestKey: string } | null> {
  const pointers = (await store.list(pointerPrefix(prefix))).sort();
  const newest = pointers.at(-1);
  if (!newest) return null;
  const pointer = await store.get(newest);
  if (!pointer) throw new Error(`episode backup: pointer ${newest} vanished`);
  const { manifestKey, manifestSha256 } = JSON.parse(pointer.bytes.toString('utf8'));
  const stored = await store.get(manifestKey);
  if (!stored || sha256(stored.bytes) !== manifestSha256) throw new Error(`episode backup: last-good manifest ${manifestKey} failed verification`);
  return { manifest: JSON.parse(stored.bytes.toString('utf8')), manifestKey };
}

/** Writes an object unless an identical one already exists, then reads it back and verifies it. */
async function putVerified(store: BackupStore, key: string, body: Buffer, contentType: string, metadata: Record<string, string> = {}): Promise<'uploaded' | 'present'> {
  const digest = sha256(body);
  const existing = await store.get(key);
  if (existing) {
    if (existing.bytes.length !== body.length || sha256(existing.bytes) !== digest) throw new Error(`episode backup: ${key} exists with different bytes; refusing to replace it`);
    return 'present';
  }
  await store.putNew(key, body, { ...metadata, sha256: digest, bytes: String(body.length) }, contentType);
  const stored = await store.get(key);
  if (!stored || stored.bytes.length !== body.length || sha256(stored.bytes) !== digest) throw new Error(`episode backup: read-back verification failed for ${key}`);
  return 'uploaded';
}

export interface BackupRunResult {
  outcome: 'advanced' | 'flagged' | 'dry_run';
  manifestKey: string | null;
  rowCount: number;
  totalBytes: number;
  uploaded: number;
  alreadyPresent: number;
  flags: BackupFlag[];
}

export async function runEpisodeBackup(deps: {
  store: BackupStore;
  inventory: () => Promise<InventoryRow[]>;
  prefix?: string;
  now?: () => Date;
  dryRun?: boolean;
}): Promise<BackupRunResult> {
  const prefix = deps.prefix ?? BACKUP_PREFIX_DEFAULT;
  const takenAt = (deps.now ?? (() => new Date()))().toISOString();
  const previous = await readLastGood(deps.store, prefix);
  const rows = await deps.inventory();
  const manifest = buildManifest(rows, prefix, takenAt, previous?.manifest ?? null, previous?.manifestKey ?? null);
  const base = { rowCount: manifest.rowCount, totalBytes: manifest.totalBytes, flags: manifest.flags };
  if (deps.dryRun) return { outcome: 'dry_run', manifestKey: null, uploaded: 0, alreadyPresent: 0, ...base };

  let uploaded = 0;
  let alreadyPresent = 0;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const entry of manifest.entries) {
    const body = Buffer.from(byId.get(entry.id)!.content, 'utf8');
    if (await putVerified(deps.store, entry.objectKey, body, 'text/markdown; charset=utf-8') === 'uploaded') uploaded++;
    else alreadyPresent++;
  }
  const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8');
  const stamp = takenAt.replace(/[:.]/g, '-');
  const flagged = manifest.flags.length > 0;
  const manifestKey = `${prefix}/${flagged ? 'flagged' : 'manifests'}/${stamp}-${sha256(manifestBody).slice(0, 16)}.json`;
  await putVerified(deps.store, manifestKey, manifestBody, 'application/json');
  if (!flagged) {
    const pointer = Buffer.from(JSON.stringify({ manifestKey, manifestSha256: sha256(manifestBody), takenAt }), 'utf8');
    await putVerified(deps.store, `${pointerPrefix(prefix)}${stamp}.json`, pointer, 'application/json');
  }
  return { outcome: flagged ? 'flagged' : 'advanced', manifestKey, uploaded, alreadyPresent, ...base };
}
