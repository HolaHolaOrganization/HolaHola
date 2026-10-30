/**
 * Read-only: builds the approval receipt for scripts/data-ops/backfill-episode-turns.ts.
 *
 * Lists every per-turn canonical row (arc david-luca-chat, tag per-turn) created
 * since the episode began, up to --until, that the episode does not yet hold
 * (same presence rule as the projection), oldest first, with each row's
 * content hash. Nothing is written to the database.
 *
 * Usage:
 *   npx tsx --env-file=.env server/scripts/generate-episode-backfill-receipt.ts \
 *     --episode-id <id> --until <ISO UTC> --out scripts/data-ops/backfill-episode-turns.receipt.json
 *
 * created_at is a naive UTC timestamp, so it is read as UTC text, never through
 * a local-time Date conversion.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { captureIdFromTags, turnPresentInEpisode } from '../services/episode-gap-projection';
import { EPISODE_BACKFILL_RECEIPT_KIND, sha256, type EpisodeBackfillEntry, type EpisodeBackfillReceipt } from '../services/episode-backfill';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

const utc = (naive: string) => new Date(naive.replace(' ', 'T') + 'Z').toISOString();

async function main(): Promise<void> {
  const episodeId = arg('episode-id');
  const until = new Date(arg('until'));
  if (!Number.isFinite(until.getTime())) throw new Error('--until must be an ISO timestamp');
  const out = arg('out');

  const client = new pg.Client({ connectionString: process.env.NEON_SHARED_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const episode = (await client.query(
      `SELECT id, title, content, created_at::text AS created_at FROM conversation_memories WHERE id = $1`, [episodeId],
    )).rows[0];
    if (!episode) throw new Error(`episode ${episodeId} not found`);
    const rows = (await client.query(
      `SELECT id, content, created_at::text AS created_at, tags FROM conversation_memories
        WHERE arc_name = 'david-luca-chat' AND 'per-turn' = ANY(tags)
          AND created_at >= $1::timestamp AND created_at <= $2::timestamp
        ORDER BY created_at ASC, id ASC`,
      [episode.created_at, until.toISOString().replace('T', ' ').replace('Z', '')],
    )).rows;
    const entries: EpisodeBackfillEntry[] = [];
    for (const r of rows) {
      const captureId = captureIdFromTags(r.tags as string[] | null) ?? null;
      const createdAt = utc(r.created_at);
      const turn = { id: r.id, captureId: captureId ?? undefined, content: r.content, createdAtMs: Date.parse(createdAt) };
      if (turnPresentInEpisode(turn, episode.content)) continue;
      entries.push({ rowId: r.id, captureId, createdAt, contentSha256: sha256(r.content) });
    }
    const receipt: EpisodeBackfillReceipt = {
      kind: EPISODE_BACKFILL_RECEIPT_KIND,
      episodeId: episode.id,
      episodeTitle: episode.title,
      entries,
      listSha256: sha256(JSON.stringify(entries)),
    };
    writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    const chars = rows.filter((r) => entries.some((e) => e.rowId === r.id)).reduce((n, r) => n + r.content.length, 0);
    console.log(`receipt: ${entries.length} absent of ${rows.length} turns since ${utc(episode.created_at)} up to ${until.toISOString()}; ` +
      `${chars} chars; first ${entries[0]?.createdAt ?? '-'}, last ${entries.at(-1)?.createdAt ?? '-'}; listSha256 ${receipt.listSha256}`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => { console.error(`[backfill-receipt] ${e?.message ?? e}`); process.exit(1); });
