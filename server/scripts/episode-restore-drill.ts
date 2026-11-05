/**
 * Runs one episode restore drill (server/services/episode-restore-drill.ts).
 *
 *   npx tsx --env-file=.env server/scripts/episode-restore-drill.ts --target-url <postgres url>
 *
 * The target must be a disposable database, such as a schema-only Neon branch
 * from `npm run db:branch -- create <name> --schema-only --task-ref <ref>`. It
 * is refused when it points at the same host and database as
 * NEON_SHARED_DATABASE_URL (or DATABASE_URL), and when neither is set. The
 * backup is read with the same store as the export (episode-backup-s3.ts),
 * read-only. Exit 0 when the drill passed, 2
 * when it failed or there is no backup, 1 on error.
 */
import pg from 'pg';
import { BACKUP_PREFIX_DEFAULT } from '../services/episode-backup';
import { s3BackupStoreFromEnv } from '../services/episode-backup-s3';
import { runRestoreDrill } from '../services/episode-restore-drill';
import { isDirectCliInvocation } from './lib/cli-entrypoint';

/** host + database of a postgres URL, for refusing the shared database. */
export function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname.replace(/-pooler(?=\.)/, '')}/${parsed.pathname.replace(/^\//, '')}`;
}

export async function episodeRestoreDrillCli(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const at = argv.indexOf('--target-url');
  const targetUrl = at >= 0 ? argv[at + 1] : undefined;
  if (!targetUrl) throw new Error('--target-url <postgres url of a disposable database> is required');
  // Fail closed: without the shared database's URL the drill can't prove the target isn't it.
  const shared = [env.NEON_SHARED_DATABASE_URL, env.DATABASE_URL].filter((u): u is string => Boolean(u));
  if (shared.length === 0) throw new Error('NEON_SHARED_DATABASE_URL is not set, so the target cannot be checked against it; run with --env-file=.env');
  if (shared.some((u) => databaseIdentity(u) === databaseIdentity(targetUrl))) {
    throw new Error('refusing to restore into the shared database; use a disposable Neon branch');
  }
  const target = new pg.Client({ connectionString: targetUrl });
  await target.connect();
  try {
    const report = await runRestoreDrill({ store: s3BackupStoreFromEnv().store, prefix: BACKUP_PREFIX_DEFAULT, target });
    console.log(JSON.stringify({ ...report, failures: report.failures.slice(0, 50), failureCount: report.failures.length }, null, 2));
    return report.outcome === 'passed' ? 0 : 2;
  } finally {
    await target.end();
  }
}

if (isDirectCliInvocation('episode-restore-drill.ts')) {
  episodeRestoreDrillCli().then((code) => { process.exitCode = code; }, (error) => {
    console.error('[EpisodeRestoreDrill] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
