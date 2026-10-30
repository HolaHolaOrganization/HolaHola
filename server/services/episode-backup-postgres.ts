import { neon } from "@neondatabase/serverless";
import { backupHash, type EpisodeBackupRecord, verifyRestoredEpisodeInventory } from "./episode-backup";
import { decodeEpisodeSnapshot, EPISODE_BACKUP_SNAPSHOT_SQL } from "./episode-backup-adapters";

// Both source and target use the same transaction-local serialization settings.
const SETTINGS = `SELECT set_config('TimeZone','UTC',true), set_config('DateStyle','ISO, YMD',true),
  set_config('IntervalStyle','postgres',true), set_config('extra_float_digits','3',true),
  set_config('bytea_output','hex',true), set_config('lock_timeout','5s',true),
  set_config('statement_timeout','120s',true)`;
const COLUMNS = `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
  a.attgenerated AS generated, a.attidentity AS identity
  FROM pg_attribute a WHERE a.attrelid='public.conversation_memories'::regclass
  AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
const TRIGGERS = `SELECT tgname FROM pg_trigger
  WHERE tgrelid='public.conversation_memories'::regclass AND NOT tgisinternal`;
const CONSTRAINTS = `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint WHERE conrelid='public.conversation_memories'::regclass ORDER BY conname`;
const ALL = `SELECT row_to_json(m)::text AS row_json FROM public.conversation_memories m ORDER BY id`;

export function assertIsolatedEpisodeTarget(source: string, target: string): void {
  const a = new URL(source), b = new URL(target);
  const endpoint = (url: URL) => url.hostname.replace(/-pooler(?=\.)/, "");
  // Different database names on the SAME endpoint are not a disposable branch.
  if (!/^ep-[a-z0-9-]+\./.test(b.hostname) || endpoint(a) === endpoint(b)
      || a.pathname !== b.pathname || a.protocol !== b.protocol) {
    throw new Error("Restore target is not a distinct Neon endpoint for the application database");
  }
}

export async function captureEpisodeBackup(sourceUrl: string) {
  const sql = neon(sourceUrl);
  const migration = await sql(`SELECT schemaname, tablename FROM pg_tables
    WHERE tablename='__drizzle_migrations' ORDER BY schemaname`);
  if (migration.length !== 1 || !/^[a-z_][a-z0-9_]*$/.test(migration[0].schemaname)) {
    throw new Error("Cannot resolve exactly one source migration ledger");
  }
  const results = await sql.transaction([
    sql(SETTINGS), sql(EPISODE_BACKUP_SNAPSHOT_SQL),
    sql(COLUMNS), sql(TRIGGERS), sql(CONSTRAINTS),
    sql(`SELECT hash, created_at::text FROM "${migration[0].schemaname}".__drizzle_migrations
      ORDER BY created_at DESC LIMIT 1`),
  ], { isolationLevel: "RepeatableRead", readOnly: true });
  const records = decodeEpisodeSnapshot(results[1] as { row_json: string }[]);
  if (!records.length) throw new Error("Empty source inventory");
  if (results[3].length || results[2].some(c => c.generated || c.identity)) {
    throw new Error("Unexpected source triggers/generated/identity columns; manual review required");
  }
  if (results[4].some(c => c.contype === "f")) {
    // Do not fetch dependent live rows or weaken constraints to make a drill pass.
    throw new Error("Source restore dependencies require explicit schema review");
  }
  return {
    records,
    evidence: {
      selectionSha256: backupHash(Buffer.from(EPISODE_BACKUP_SNAPSHOT_SQL)),
      columns: results[2], constraints: results[4], triggers: results[3],
      migrationHead: results[5],
      serialization: "UTC; ISO,YMD; postgres intervals; extra_float_digits=3; hex bytea",
    },
  };
}

export async function restoreEpisodeBackupPostgres(input: {
  sourceUrl: string; targetUrl: string; records: EpisodeBackupRecord[];
  sourceColumns: unknown; authorize: () => Promise<void>;
}): Promise<void> {
  assertIsolatedEpisodeTarget(input.sourceUrl, input.targetUrl);
  if (!input.records.length) throw new Error("Refusing empty restore");
  const sql = neon(input.targetUrl);
  const preflight = await sql.transaction([
    sql(SETTINGS), sql("SELECT count(*)::int AS count FROM public.conversation_memories"),
    sql(COLUMNS), sql(TRIGGERS),
  ], { isolationLevel: "RepeatableRead", readOnly: true });
  if (preflight[1][0].count !== 0) throw new Error("Restore target is not empty");
  if (JSON.stringify(preflight[2]) !== JSON.stringify(input.sourceColumns)
      || preflight[3].length || preflight[2].some(c => c.generated || c.identity)) {
    throw new Error("Target schema or trigger compatibility failed");
  }
  await input.authorize();
  // ACCESS EXCLUSIVE locks before the second empty check, removing the preflight
  // race. No truncate, DELETE, upsert, trigger disabling or production fallback.
  await sql.transaction([
    sql(SETTINGS),
    sql("LOCK TABLE public.conversation_memories IN ACCESS EXCLUSIVE MODE"),
    sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.conversation_memories)
      THEN RAISE EXCEPTION 'Restore target became nonempty'; END IF; END $$`),
    sql(`INSERT INTO public.conversation_memories
      SELECT * FROM json_populate_recordset(NULL::public.conversation_memories, $1::json)`,
    [JSON.stringify(input.records)]),
  ]);
  const results = await sql.transaction([sql(SETTINGS), sql(ALL)], {
    isolationLevel: "RepeatableRead", readOnly: true,
  });
  verifyRestoredEpisodeInventory(input.records, decodeEpisodeSnapshot(results[1] as { row_json: string }[]));
}
