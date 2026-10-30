/**
 * Read-only: builds the approval receipt for scripts/data-ops/backfill-episode-turns.ts
 * and prints it to stdout (a summary line goes to stderr).
 *
 * Lists every canonical per-turn row (arc david-luca-chat, tag per-turn)
 * created since the episode began, up to --until, that the episode does not
 * yet hold (same presence rule as the projection), oldest first, with each
 * row's capture id, exact created_at and content hash. Nothing is written to
 * the database.
 *
 * Usage:
 *   npx tsx --env-file=.env server/scripts/generate-episode-backfill-receipt.ts \
 *     --episode-id <id> --until "YYYY-MM-DD HH:MM:SS" > scripts/data-ops/backfill-episode-turns.receipt.json
 *
 * --until and all times are naive UTC, compared as Postgres text, never
 * through a local-time Date conversion. Ties order by id in code-unit order
 * (COLLATE "C"), the same order the receipt validator and planner use.
 */
import pg from 'pg';
import { captureIdFromTags, turnPresentInEpisode } from '../services/episode-gap-projection';
import {
  CREATED_AT_SQL, EPISODE_BACKFILL_RECEIPT_KIND, PER_TURN_ARC, PER_TURN_TAG, sha256,
  type EpisodeBackfillEntry, type EpisodeBackfillReceipt,
} from '../services/episode-backfill';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const episodeId = arg('episode-id');
  const until = arg('until');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(until)) throw new Error('--until must be "YYYY-MM-DD HH:MM:SS" (UTC)');

  const client = new pg.Client({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const episode = (await client.query(
      `SELECT id, title, content, ${CREATED_AT_SQL} AS created_at FROM conversation_memories WHERE id = $1`, [episodeId],
    )).rows[0];
    if (!episode) throw new Error(`episode ${episodeId} not found`);
    const rows = (await client.query(
      `SELECT id, content, ${CREATED_AT_SQL} AS created_at, tags FROM conversation_memories
        WHERE arc_name = $1 AND $2 = ANY(tags)
          AND ${CREATED_AT_SQL} >= $3 AND created_at <= $4::timestamp
        ORDER BY created_at ASC, id COLLATE "C" ASC`,
      [PER_TURN_ARC, PER_TURN_TAG, episode.created_at, until],
    )).rows;
    const entries: EpisodeBackfillEntry[] = [];
    let chars = 0;
    for (const r of rows) {
      const captureId = captureIdFromTags(r.tags as string[] | null) ?? null;
      const turn = { id: r.id, captureId: captureId ?? undefined, content: r.content, createdAtMs: 0 };
      if (turnPresentInEpisode(turn, episode.content)) continue;
      entries.push({ rowId: r.id, captureId, createdAt: r.created_at, contentSha256: sha256(r.content) });
      chars += r.content.length;
    }
    const receipt: EpisodeBackfillReceipt = {
      kind: EPISODE_BACKFILL_RECEIPT_KIND,
      episodeId: episode.id,
      episodeTitle: episode.title,
      entries,
      listSha256: sha256(JSON.stringify(entries)),
    };
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    console.error(`receipt: ${entries.length} absent of ${rows.length} turns since ${episode.created_at} UTC up to ${until} UTC; ` +
      `${chars} chars; first ${entries[0]?.createdAt ?? '-'}, last ${entries.at(-1)?.createdAt ?? '-'}; listSha256 ${receipt.listSha256}`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => { console.error(`[backfill-receipt] ${e?.message ?? e}`); process.exit(1); });
