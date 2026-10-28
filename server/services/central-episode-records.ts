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

type CentralEpisodeQuery = (text: string, params: unknown[]) => Promise<Record<string, any>[]>;

// Display-only exclusions for the three inventoried fixtures. Never infer
// fixtures from episode numbers/titles or mutate their canonical rows.
const HIDDEN_EPISODE_FIXTURE_IDS = [
  "9939a73b-0a99-42fd-874b-54e50e969a2d",
  "06fa6956-5213-4ce6-8dbc-8ab0f75c6c80",
  "a5782e96-79b4-4695-91a2-1eca49c754ad",
];

async function createReadQuery(): Promise<CentralEpisodeQuery> {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.NEON_SHARED_DATABASE_URL;
  if (!url) throw new Error("Central record database is not configured");
  const query = neon(url);
  return (text, params) => query(text, params);
}

export async function createCentralEpisodeRepository(
  options: { query?: CentralEpisodeQuery } = {},
): Promise<CentralEpisodeRepository> {
  const query = options.query ?? await createReadQuery();
  // Stories are only exposed as stories when linked to an actual episode.
  // An episode's extends_memory_id is history, NOT a story-parent relation.
  const from = (hiddenParameter: 2 | 3) => `
    FROM conversation_memories m
    LEFT JOIN conversation_memories p ON p.id = m.extends_memory_id
    WHERE m.id <> ALL($${hiddenParameter}::text[]) AND (
      (m.entry_type = 'episode' AND m.arc_name = 'HolaHola Episodes'
        AND NOT ('episode-story' = ANY(COALESCE(m.tags, '{}'))))
      OR ('episode-story' = ANY(COALESCE(m.tags, '{}'))
        AND p.entry_type = 'episode' AND p.arc_name = 'HolaHola Episodes'
        AND p.id <> ALL($${hiddenParameter}::text[]))
    )`;
  // recorded_at is timestamp WITHOUT time zone, with UTC wall-clock values.
  // Format it in Postgres so driver/host TZ cannot shift it or drop microseconds.
  const columns = `m.id, m.title, m.tags, m.entry_type,
    to_char(m.recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at_iso,
    m.extends_memory_id, p.title AS parent_title, octet_length(m.content) AS bytes`;
  function map(row: Record<string, any>): CentralEpisodeRow {
    return {
      id: row.id, title: row.title, content: row.content ?? "",
      recordedAt: row.recorded_at_iso,
      tags: row.tags ?? [], entryType: row.entry_type,
      parentId: row.extends_memory_id ?? null, parentTitle: row.parent_title ?? null,
      bytes: Number(row.bytes),
    };
  }
  return {
    async list(limit, offset) {
      // Do not transfer multi-megabyte contents just to display the catalog.
      const rows = await query(`SELECT ${columns} ${from(3)}
        ORDER BY m.recorded_at DESC, m.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset, HIDDEN_EPISODE_FIXTURE_IDS]);
      return rows.map(map);
    },
    async find(id) {
      const rows = await query(`SELECT ${columns}, m.content ${from(2)} AND m.id = $1`,
        [id, HIDDEN_EPISODE_FIXTURE_IDS]);
      return rows[0] ? map(rows[0]) : null;
    },
  };
}
