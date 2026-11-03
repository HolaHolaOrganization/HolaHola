/**
 * Runs one episode backup (Phase B, server/services/episode-backup.ts).
 *
 *   npx tsx server/scripts/episode-backup.ts --dry-run   inventory and compare only; no writes anywhere
 *   npx tsx server/scripts/episode-backup.ts             upload, verify, publish, advance last-good
 *
 * Reads the shared database (read-only transaction) and writes only to the
 * backup bucket. Exit 0 when the run advanced or was a dry run, 2 when it was
 * flagged (last-good not advanced), 1 on error.
 */
import { getSharedDb } from '../db';
import { runEpisodeBackup, takeInventory } from '../services/episode-backup';
import { s3BackupStoreFromEnv } from '../services/episode-backup-s3';
import { isDirectCliInvocation } from './lib/cli-entrypoint';

export async function episodeBackupCli(argv = process.argv.slice(2)): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(' ')}`);
  const db = getSharedDb();
  const store = dryRun
    ? { get: async () => null, putNew: async () => { throw new Error('dry run writes nothing'); }, list: async () => [] }
    : s3BackupStoreFromEnv().store;
  const result = await runEpisodeBackup({ store, inventory: () => takeInventory(db), dryRun });
  console.log(JSON.stringify(result, null, 2));
  return result.outcome === 'flagged' ? 2 : 0;
}

if (isDirectCliInvocation('episode-backup.ts')) {
  episodeBackupCli().then((code) => { process.exitCode = code; }, (error) => {
    console.error('[EpisodeBackup] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
