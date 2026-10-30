/**
 * Read-only Phase B readiness census. Does not upload, save source content,
 * create a branch, mutate a DB or claim a passed restore drill.
 * Usage: node --import tsx server/scripts/episode-backup-inventory.ts
 */
import { neon } from "@neondatabase/serverless";
import { backupHash } from "../services/episode-backup";
import { decodeEpisodeSnapshot, EPISODE_BACKUP_SNAPSHOT_SQL } from "../services/episode-backup-adapters";

async function main() {
  if (process.argv.slice(2).length) {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log("Read-only episode/story inventory; no arguments, no writes, no source content output.");
      return;
    }
    throw new Error("Unsupported inventory argument");
  }
  const url = process.env.NEON_SHARED_DATABASE_URL;
  if (!url) throw new Error("NEON_SHARED_DATABASE_URL is required");
  const sql = neon(url);
  const [snapshot] = await sql.transaction([sql(EPISODE_BACKUP_SNAPSHOT_SQL)], {
    isolationLevel: "RepeatableRead", readOnly: true,
  });
  const records = decodeEpisodeSnapshot(snapshot as { row_json: string }[]);
  if (!records.length) throw new Error("Empty snapshot: cannot establish backup baseline");
  const inventory = records.map(row => ({
    id: row.id, bytes: Buffer.byteLength(row.content),
    sha256: backupHash(Buffer.from(row.content, "utf8")),
  }));
  console.log(JSON.stringify({
    status: "READ_ONLY_INVENTORY",
    capturedAt: new Date().toISOString(),
    records: inventory.length,
    contentBytes: inventory.reduce((sum, row) => sum + row.bytes, 0),
    inventorySha256: backupHash(Buffer.from(JSON.stringify(inventory), "utf8")),
    scope: "All episode/story arc rows plus tagged stories, including hidden rows; not the messages table or embeddings",
    liveExportPerformed: false, disposableDatabaseRestorePerformed: false,
  }, null, 2));
}

main().catch(error => {
  // Driver errors may contain connection URLs or source data; never dump them.
  console.error(`Episode backup inventory failed (${error instanceof Error ? error.name : "unknown error"}). No backup or restore was performed.`);
  process.exitCode = 1;
});
