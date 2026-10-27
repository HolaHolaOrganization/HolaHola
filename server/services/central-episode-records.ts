import { createHash } from "node:crypto";

/** Read-only views of existing records. No filesystem or episode writes. */
export interface CentralEpisodeRow {
  id: string;
  title: string;
  content: string;
  recordedAt: string;
  tags: string[];
  entryType: string;
  parentId: string | null;
  parentTitle: string | null;
  bytes: number;
}

export interface CentralEpisodeRepository {
  list(limit: number, offset: number): Promise<CentralEpisodeRow[]>;
  find(id: string): Promise<CentralEpisodeRow | null>;
}

function episodeNumber(title: string): number | null {
  const match = /^Episode\s+([1-9]\d*)\b/i.exec(title);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

export function centralEpisodeMetadata(row: CentralEpisodeRow) {
  const kind = row.tags.includes("episode-story") ? "story" as const : "episode" as const;
  const number = episodeNumber(kind === "story" ? row.parentTitle ?? "" : row.title);
  return {
    id: row.id,
    title: row.title,
    kind,
    episodeNumber: number,
    filename: number === null
      ? `record-${row.id}.md`
      : `episode-${number}${kind === "story" ? "-story" : ""}.md`,
    recordedAt: row.recordedAt,
    bytes: row.bytes,
    parentId: kind === "story" ? row.parentId : null,
  };
}

export function centralEpisodeRead(row: CentralEpisodeRow) {
  const bytes = Buffer.from(row.content, "utf8");
  return {
    ...centralEpisodeMetadata(row),
    // Compute from the same snapshot as the bytes, not a later database read.
    bytes: bytes.length,
    content: row.content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function createCentralEpisodeRepository(): Promise<CentralEpisodeRepository> {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.NEON_SHARED_DATABASE_URL;
  if (!url) throw new Error("Central record database is not configured");
  const query = neon(url);
  // Stories are only exposed as stories when linked to an actual episode.
  // An episode's extends_memory_id is history, NOT a story-parent relation.
  const from = `
    FROM conversation_memories m
    LEFT JOIN conversation_memories p ON p.id = m.extends_memory_id
    WHERE (
      (m.entry_type = 'episode' AND m.arc_name = 'HolaHola Episodes'
        AND NOT ('episode-story' = ANY(COALESCE(m.tags, '{}'))))
      OR ('episode-story' = ANY(COALESCE(m.tags, '{}'))
        AND p.entry_type = 'episode' AND p.arc_name = 'HolaHola Episodes')
    )`;
  const columns = `m.id, m.title, m.tags, m.entry_type, m.recorded_at,
    m.extends_memory_id, p.title AS parent_title, octet_length(m.content) AS bytes`;
  function map(row: Record<string, any>): CentralEpisodeRow {
    return {
      id: row.id, title: row.title, content: row.content ?? "",
      recordedAt: new Date(row.recorded_at).toISOString(),
      tags: row.tags ?? [], entryType: row.entry_type,
      parentId: row.extends_memory_id ?? null, parentTitle: row.parent_title ?? null,
      bytes: Number(row.bytes),
    };
  }
  return {
    async list(limit, offset) {
      // Do not transfer multi-megabyte contents just to display the catalog.
      const rows = await query(`SELECT ${columns} ${from}
        ORDER BY m.recorded_at DESC, m.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
      return rows.map(map);
    },
    async find(id) {
      const rows = await query(`SELECT ${columns}, m.content ${from} AND m.id = $1`, [id]);
      return rows[0] ? map(rows[0]) : null;
    },
  };
}
