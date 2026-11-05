/**
 * The restore drill for the episode backup (design fc90e95a, Phase B): prove
 * the last good backup can be restored, byte for byte, into an EMPTY database
 * table before anything relies on it. The founder asked for it on 2026-11-04:
 * "start the restore drill".
 *
 * One drill:
 *   1. reads the last-good manifest (episode-backup.ts verifies its hash);
 *   2. fetches every object it names and checks its length and sha256;
 *   3. writes every row into an empty drill table in the TARGET database
 *      (a disposable Neon branch, never the shared database);
 *   4. reads every row back and checks that the full inventory returned:
 *      each manifest id present once, each with the manifest's length and
 *      sha256, and nothing else.
 * The drill never writes to the backup bucket or to the shared database.
 */
import { createHash } from 'node:crypto';
import { readLastGood, type BackupStore } from './episode-backup';

/** The drill table in the disposable target database. */
export const RESTORE_DRILL_TABLE = 'episode_restore_drill';

/** The few database operations the drill needs; a pg Client satisfies it. */
export interface RestoreTarget {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface RestoreDrillFailure {
  kind: 'object_missing' | 'object_mismatch' | 'row_missing' | 'row_mismatch' | 'row_unexpected' | 'row_duplicated';
  id: string;
  detail?: string;
}

export interface RestoreDrillReport {
  outcome: 'passed' | 'failed' | 'no_backup';
  manifestKey: string | null;
  takenAt: string | null;
  expectedRows: number;
  restoredRows: number;
  totalBytes: number;
  failures: RestoreDrillFailure[];
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function runRestoreDrill(deps: { store: BackupStore; prefix: string; target: RestoreTarget }): Promise<RestoreDrillReport> {
  const lastGood = await readLastGood(deps.store, deps.prefix);
  if (!lastGood) {
    return { outcome: 'no_backup', manifestKey: null, takenAt: null, expectedRows: 0, restoredRows: 0, totalBytes: 0, failures: [] };
  }
  const { manifest, manifestKey, takenAt } = lastGood;
  const failures: RestoreDrillFailure[] = [];

  // 1. Every object the manifest names, verified before anything is written.
  const fetched: { id: string; arcName: string; entryType: string; title: string | null; createdAt: string | null; recordedAt: string | null; content: string }[] = [];
  for (const entry of manifest.entries) {
    const object = await deps.store.get(entry.objectKey);
    if (!object) { failures.push({ kind: 'object_missing', id: entry.id, detail: entry.objectKey }); continue; }
    if (object.bytes.length !== entry.bytes || sha256(object.bytes) !== entry.sha256) {
      failures.push({ kind: 'object_mismatch', id: entry.id, detail: `${object.bytes.length} bytes, expected ${entry.bytes}` });
      continue;
    }
    fetched.push({ id: entry.id, arcName: entry.arcName, entryType: entry.entryType, title: entry.title,
      createdAt: entry.createdAt, recordedAt: entry.recordedAt, content: object.bytes.toString('utf8') });
  }

  // 2. Restore into an empty table; refuse a table that already holds rows.
  await deps.target.query(`create table if not exists ${RESTORE_DRILL_TABLE} (
    id text primary key, arc_name text not null, entry_type text not null, title text,
    created_at text, recorded_at text, content text not null)`);
  const existing = await deps.target.query(`select count(*)::int as n from ${RESTORE_DRILL_TABLE}`);
  if (Number(existing.rows[0]?.n ?? 0) !== 0) throw new Error(`restore drill: ${RESTORE_DRILL_TABLE} is not empty; the drill only restores into an empty table`);
  for (const row of fetched) {
    await deps.target.query(
      `insert into ${RESTORE_DRILL_TABLE} (id, arc_name, entry_type, title, created_at, recorded_at, content) values ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.arcName, row.entryType, row.title, row.createdAt, row.recordedAt, row.content],
    );
  }

  // 3. Read everything back and compare with the manifest, not with what was written.
  const restored = (await deps.target.query(`select id, content from ${RESTORE_DRILL_TABLE}`)).rows;
  const byId = new Map<string, string[]>();
  for (const row of restored) byId.set(row.id, [...(byId.get(row.id) ?? []), row.content]);
  for (const entry of manifest.entries) {
    const copies = byId.get(entry.id);
    if (!copies) {
      if (!failures.some((f) => f.id === entry.id)) failures.push({ kind: 'row_missing', id: entry.id });
      continue;
    }
    if (copies.length > 1) failures.push({ kind: 'row_duplicated', id: entry.id });
    const bytes = Buffer.from(copies[0], 'utf8');
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      failures.push({ kind: 'row_mismatch', id: entry.id, detail: `${bytes.length} bytes, expected ${entry.bytes}` });
    }
  }
  const expected = new Set(manifest.entries.map((e) => e.id));
  for (const id of byId.keys()) if (!expected.has(id)) failures.push({ kind: 'row_unexpected', id });

  return {
    outcome: failures.length === 0 && restored.length === manifest.entries.length ? 'passed' : 'failed',
    manifestKey, takenAt, expectedRows: manifest.rowCount, restoredRows: restored.length, totalBytes: manifest.totalBytes, failures,
  };
}
