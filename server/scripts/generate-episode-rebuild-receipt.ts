/**
 * Read-only: builds the approval receipt for
 * scripts/data-ops/rebuild-episode-ordered.ts (design 4994db25) and prints it
 * to stdout; a summary for the founder goes to stderr.
 *
 * Reads the episode row and every canonical per-turn row since the episode
 * began, computes the ordered merge exactly as the apply will, and records the
 * old content hash, the turns to insert with their positions, and the hash of
 * the exact new content. Nothing is written to the database: the transaction
 * is READ ONLY and always rolls back.
 *
 * Usage:
 *   npx tsx --env-file=.env server/scripts/generate-episode-rebuild-receipt.ts \
 *     --episode-id <id> --until "YYYY-MM-DD HH:MM:SS" > scripts/data-ops/rebuild-episode-ordered.receipt.json
 *
 * --until is naive UTC and inclusive; it is stored with microseconds
 * (.000000) and compared as text, never through a local-time Date. Generate it
 * immediately before the founder's approval: turns after --until are left for
 * the projection, and a turn at or before it that is not in the receipt makes
 * the apply refuse.
 */
import pg from 'pg';
import { CREATED_AT_SQL, PER_TURN_ARC, PER_TURN_TAG } from '../services/episode-backfill';
import { computeOrderedMerge, orderedMergeReceipt } from '../services/episode-ordered-merge';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

/** reembed-memory's chunking (memory-embedding-indexer CHUNK_CHARS / OVERLAP_CHARS), for the size line only. */
const CHUNK_CHARS = 4500;
const OVERLAP_CHARS = 900;

async function main(): Promise<void> {
  const episodeId = arg('episode-id');
  const untilArg = arg('until');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(untilArg)) throw new Error('--until must be "YYYY-MM-DD HH:MM:SS" (UTC)');
  const until = `${untilArg}.000000`;

  const client = new pg.Client({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const episode = (await client.query(
      `SELECT id, title, content, ${CREATED_AT_SQL} AS created_at FROM conversation_memories WHERE id = $1`, [episodeId],
    )).rows[0];
    if (!episode) throw new Error(`episode ${episodeId} not found`);
    const rows = (await client.query(
      `SELECT id, content, ${CREATED_AT_SQL} AS created_at, arc_name, tags FROM conversation_memories
        WHERE arc_name = $1 AND $2 = ANY(tags) AND ${CREATED_AT_SQL} >= $3`,
      [PER_TURN_ARC, PER_TURN_TAG, episode.created_at],
    )).rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.created_at, arcName: r.arc_name, tags: r.tags }));

    const merge = computeOrderedMerge(episode.content, rows, episode.created_at, until);
    if (merge.status !== 'merge') {
      console.error(`[rebuild-receipt] no receipt: ${merge.status}${merge.status === 'refused' ? ` (${merge.reason}${merge.rowId ? `, ${merge.rowId}` : ''})` : ''}`);
      process.exitCode = 1;
      return;
    }
    const receipt = orderedMergeReceipt({ id: episode.id, title: episode.title, createdAt: episode.created_at, content: episode.content }, until, merge);
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');

    const later = rows.filter((r) => r.createdAt > until).length;
    const interior = merge.entries.filter((e) => e.insertBefore !== null).length;
    const chunks = Math.max(1, Math.ceil((receipt.newContentLength - OVERLAP_CHARS) / (CHUNK_CHARS - OVERLAP_CHARS)));
    console.error([
      `episode: ${episode.title} (${episode.id}), began ${episode.created_at} UTC`,
      `kept unchanged: opening and ${merge.existing.length} existing turn block(s); old content ${receipt.oldContentLength} chars, sha256 ${receipt.oldContentSha256}`,
      `inserting: ${merge.entries.length} turn(s), ${interior} between existing blocks and ${merge.entries.length - interior} at the end; first ${merge.entries[0].createdAt}, last ${merge.entries.at(-1)!.createdAt} UTC`,
      `until ${until} UTC; ${later} later turn(s) left for the projection`,
      `new content ${receipt.newContentLength} chars, sha256 ${receipt.newContentSha256}`,
      `list sha256 ${receipt.listSha256}`,
      `re-embed: about ${chunks} chunk(s) of ${CHUNK_CHARS} chars (overlap ${OVERLAP_CHARS}); the whole-memory arm embeds its first 8192 chars`,
    ].join('\n'));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => { console.error(`[rebuild-receipt] ${e?.message ?? e}`); process.exit(1); });
