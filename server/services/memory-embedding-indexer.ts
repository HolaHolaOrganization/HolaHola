/**
 * Memory Embedding Indexer
 *
 * Background worker that generates Gemini text-embedding-004 vectors for all
 * memory records that don't yet have an embedding. Runs every 2 hours.
 *
 * Covers these memory stores:
 *   - student_insights       (deep observations, confidence-scored)
 *   - hive_snapshots         (relationship_moment, session_summary, breakthrough, teaching_moment)
 *   - daniela_growth_memories (Daniela's own pedagogical learnings)
 *   - learner_personal_facts  (bi-temporal personal facts)
 *   - collaboration_messages (Express Lane / Hive team messages)
 *   - agent_notes            (Alden/David/Claude Code <-> Agent engineering handoffs)
 *   - conversation_memories  (full narrative session memories)
 *
 * Safe to run repeatedly — generateAndStoreEmbedding() is idempotent and skips
 * memories whose content hasn't changed since the last run.
 *
 * Rate limiting: 10 embeddings per batch, 600ms pause between batches.
 * Gemini text-embedding-004 free tier: 1500 RPM, well within budget.
 */

import { getSharedDb, getUserDb } from '../db';
import {
  studentInsights,
  hiveSnapshots,
  danielaGrowthMemories,
  learnerPersonalFacts,
  collaborationMessages,
  agentNotes,
  memoryEmbeddings,
  conversationMemories,
  users,
} from '@shared/schema';
import { eq, notExists, sql } from 'drizzle-orm';
import { generateAndStoreEmbedding } from './semantic-memory-service';
import { neon } from '@neondatabase/serverless';
import {
  countUnembeddedConversationMemories as countUnembeddedViaHttp,
  getTopUnembeddedConversationMemoryIds as getTopUnembeddedViaHttp,
  runPostCycleWarning,
} from './straggler-detector';

const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 600;
const INDEXER_INTERVAL_MS = 2 * 60 * 60 * 1000;

const DAVID_USER_ID = '49847136';
const CHUNK_CHARS = 4500;
const OVERLAP_CHARS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * SPEAKER ATTRIBUTION FORMAT (June 2026 — Gemini-recommended "Script-Naturalist" format):
 * Transforms bracketed timestamp headers into inline NAME (Date): prefixes.
 *
 * Before: [Jan 20, 2026, 03:27 AM — DANIELA]
 * After:  DANIELA (Jan 20, 2026 — 03:27 AM):
 *
 * Why: LLMs treat [brackets] as metadata/log markers (attention weakens across them).
 * Putting the speaker name FIRST in a NAME (Date): pattern matches screenplay/chat
 * training data — the strongest pattern-match for speaker attribution.
 * Applied at chunk-storage time AND at retrieval time (neural-memory-search.ts)
 * so both new and existing indexed chunks get the better format.
 */
export function reformatSpeakerHeaders(text: string): string {
  // Pass 1: Timestamped brackets — [Jan 20, 2026, 03:27 AM — DANIELA] -> DANIELA (Jan 20, 2026 — 03:27 AM):
  let formatted = text.replace(
    /\[([A-Z][a-z]{2} \d{1,2}, \d{4})(?:, (\d{1,2}:\d{2} (?:AM|PM)))? — ([A-Z]+)\]/g,
    (_match, date: string, time: string | undefined, speaker: string) => {
      const timePart = time ? ` — ${time}` : '';
      return `${speaker} (${date}${timePart}):`;
    }
  );
  // Pass 2: Bare labels — [LUCA], [DANIELA], [AGENT], [DAVID] -> Luca:, Daniela:, Agent:, David:
  // Gemini: brackets signal metadata; "Name: text" matches screenplay/chat training data.
  // The optional \n? absorbs the newline that typically follows bare speaker labels.
  formatted = formatted.replace(
    /^\[(LUCA|DANIELA|AGENT|DAVID|WREN|ALDEN)\]\n?/gm,
    (_match, name: string) => `${name.charAt(0) + name.slice(1).toLowerCase()}: `
  );
  return formatted;
}

/**
 * Split text into overlapping chunks for verbatim semantic indexing.
 * Tries to snap chunk boundaries to sentence endings (newline or ". ")
 * so chunks don't cut mid-sentence.
 *
 * SPEAKER ATTRIBUTION FIX: Chunk starts are snapped to the nearest turn header
 * "[Date — SPEAKER]" so every chunk begins at a clear speaker boundary. Without
 * this, chunks starting mid-turn cause Daniela to misattribute quotes (e.g.,
 * saying David made a joke that she actually made).
 */
export function splitIntoChunks(text: string, chunkSize: number = CHUNK_CHARS, overlap: number = OVERLAP_CHARS): string[] {
  if (text.length <= chunkSize) return [text];

  // Regex that matches turn headers like "[Jan 20, 2026, 03:27 AM — DANIELA]"
  // or "[Jun 18, 2026, 07:00 PM — DAVID]" — any "[" followed by a date-like prefix.
  const TURN_HEADER_RE = /\[[A-Z][a-z]{2} \d{1,2}, \d{4}/g;

  /**
   * Given a position inside the text, scan forward up to maxScan chars for
   * the next turn header. Returns the position of the "[" if found, else -1.
   */
  function nextTurnHeader(pos: number, maxScan: number = 800): number {
    TURN_HEADER_RE.lastIndex = pos;
    const m = TURN_HEADER_RE.exec(text);
    if (m && m.index < pos + maxScan) return m.index;
    return -1;
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // Snap END to a sentence boundary in the final 20% of the chunk
    if (end < text.length) {
      const snapZoneStart = start + Math.floor(chunkSize * 0.8);
      const searchStr = text.slice(snapZoneStart, Math.min(end + 200, text.length));
      const snapOffset = Math.max(searchStr.lastIndexOf('\n'), searchStr.lastIndexOf('. '));
      if (snapOffset > 0) end = snapZoneStart + snapOffset + 1;
    }

    chunks.push(text.slice(start, end));

    // Move start back by overlap, then snap FORWARD to the next turn header so
    // the following chunk never starts mid-speaker-turn.
    const rawNext = end - overlap;
    if (rawNext <= 0 || rawNext >= text.length) break;

    const headerPos = nextTurnHeader(rawNext);
    // Use the header snap only if it's within a reasonable distance; otherwise
    // use the raw overlap position to avoid giant un-indexed gaps.
    const nextStart = (headerPos > 0 && headerPos < rawNext + 1200) ? headerPos : rawNext;
    // Guard against non-advancing/regressing cursor (can happen with pathological
    // header spacing) which would otherwise loop forever and OOM the process.
    start = nextStart > start ? nextStart : end;
    if (start >= text.length) break;
  }
  return chunks;
}

export interface IndexTarget {
  id: string;
  userId: string | null;
  content: string;
  // When set, content is loaded lazily (one at a time) instead of held in RAM.
  // The caller sets content = '' and runIndexer() resolves this before embedding.
  contentLoader?: () => Promise<string>;
  memoryType: string;
  initialStrength?: number;
  // Source importance from conversation_memories.importance (1–10).
  // Passed to generateAndStoreEmbedding so memory_embeddings.importance reflects the
  // original row priority and the importance-first global pool ORDER BY is data-derived.
  importance?: number;
}

export async function collectUnindexedMemories(): Promise<IndexTarget[]> {
  const db = getSharedDb();
  const targets: IndexTarget[] = [];

  // Helper: check if embedding exists for a (type, id) pair
  const hasEmbedding = (type: string, idCol: any) =>
    db.select({ id: memoryEmbeddings.id })
      .from(memoryEmbeddings)
      .where(
        sql`memory_type = ${type} AND memory_id = ${idCol}`
      );

  // student_insights — observationCount feeds initial embedding strength
  try {
    const rows = await db
      .select({
        id: studentInsights.id,
        userId: studentInsights.studentId,
        content: studentInsights.insight,
        observationCount: studentInsights.observationCount,
      })
      .from(studentInsights)
      .where(
        notExists(
          db.select({ x: memoryEmbeddings.id })
            .from(memoryEmbeddings)
            .where(sql`memory_type = 'student_insight' AND memory_id = ${studentInsights.id}`)
        )
      )
      .limit(200);
    for (const r of rows) {
      if (r.content) targets.push({
        id: r.id, userId: r.userId, content: r.content, memoryType: 'student_insight',
        initialStrength: Math.min(1.0, 0.7 + (r.observationCount ?? 1) * 0.06),
      });
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] student_insights scan failed:', err.message);
  }

  // hive_snapshots (only high-signal types)
  try {
    const rows = await db
      .select({
        id: hiveSnapshots.id,
        userId: hiveSnapshots.userId,
        title: hiveSnapshots.title,
        content: hiveSnapshots.content,
      })
      .from(hiveSnapshots)
      .where(sql`
        snapshot_type IN ('relationship_moment', 'session_summary', 'breakthrough', 'teaching_moment', 'life_context')
        AND NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'hive_snapshot' AND memory_id = ${hiveSnapshots.id}
        )
      `)
      .limit(200);
    for (const r of rows) {
      const content = [r.title, r.content].filter(Boolean).join('. ');
      if (content.trim().length > 10) {
        targets.push({ id: r.id, userId: r.userId, content, memoryType: 'hive_snapshot' });
      }
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] hive_snapshots scan failed:', err.message);
  }

  // daniela_growth_memories
  try {
    const rows = await db
      .select({
        id: danielaGrowthMemories.id,
        lesson: danielaGrowthMemories.lesson,
        title: danielaGrowthMemories.title,
      })
      .from(danielaGrowthMemories)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'growth_memory' AND memory_id = ${danielaGrowthMemories.id}
        )
      `)
      .limit(100);
    for (const r of rows) {
      // Combine title + lesson into the embeddable content string
      const content = [r.title, r.lesson].filter(Boolean).join('. ');
      if (content) targets.push({ id: r.id, userId: null, content, memoryType: 'growth_memory' });
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] growth_memories scan failed:', err.message);
  }

  // learner_personal_facts — mentionCount feeds initial embedding strength
  try {
    const rows = await db
      .select({
        id: learnerPersonalFacts.id,
        studentId: learnerPersonalFacts.studentId,
        fact: learnerPersonalFacts.fact,
        context: learnerPersonalFacts.context,
        mentionCount: learnerPersonalFacts.mentionCount,
      })
      .from(learnerPersonalFacts)
      .where(sql`
        is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'personal_fact' AND memory_id = ${learnerPersonalFacts.id}
        )
      `)
      .limit(200);
    for (const r of rows) {
      const content = [r.fact, r.context].filter(Boolean).join('. ');
      if (content.trim().length > 5) {
        targets.push({
          id: r.id, userId: r.studentId, content, memoryType: 'personal_fact',
          initialStrength: Math.min(1.0, 0.7 + (r.mentionCount ?? 1) * 0.06),
        });
      }
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] personal_facts scan failed:', err.message);
  }

  // collaboration_messages (Express Lane) — founder/Daniela/team messages
  // Stored with userId = null (globally-scoped, not per-student).
  // semanticSearch() includes userId IS NULL records so these surface in all sessions.
  try {
    const rows = await db
      .select({
        id: collaborationMessages.id,
        role: collaborationMessages.role,
        content: collaborationMessages.content,
      })
      .from(collaborationMessages)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'collaboration_message' AND memory_id = ${collaborationMessages.id}
        )
        AND length(content) > 20
      `)
      .limit(300);
    for (const r of rows) {
      // Prepend role so the embedding captures speaker context ("founder: ..." vs "daniela: ...")
      const content = `${r.role}: ${r.content}`;
      targets.push({ id: r.id, userId: null, content, memoryType: 'collaboration_message' });
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] collaboration_messages scan failed:', err.message);
  }

  // agent_notes (Alden <-> Agent, David -> Agent, Claude Code -> Luca handoffs)
  // Operational/engineering messages, not personal student data — always globally
  // scoped (userId = null), same as collaboration_messages. Low volume relative to
  // collaboration_messages (a few notes per session vs. 23k+ Hive messages), so
  // this type is included in semanticSearch()'s default global pool (see
  // GLOBAL_RECALL_TYPES in semantic-memory-service.ts) rather than excluded like
  // collaboration_message is.
  try {
    const rows = await db
      .select({
        id: agentNotes.id,
        fromAgent: agentNotes.fromAgent,
        toAgent: agentNotes.toAgent,
        subject: agentNotes.subject,
        body: agentNotes.body,
      })
      .from(agentNotes)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'agent_handoff' AND memory_id = ${agentNotes.id}
        )
        AND length(body) > 10
      `)
      .limit(300);
    for (const r of rows) {
      const content = `${r.fromAgent} -> ${r.toAgent}: ${r.subject}\n\n${r.body}`;
      targets.push({ id: r.id, userId: null, content, memoryType: 'agent_handoff' });
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] agent_notes scan failed:', err.message);
  }

  // conversation_memories — full narrative memories of meaningful sessions
  // These are the richest memories: full transcripts, breakthrough moments, the podcast.
  //
  // Scoping rule:
  //   - Memories tagged 'founder-chat' or 'founder-private' contain verbatim David-Daniela
  //     conversations and must be scoped to DAVID_USER_ID so they appear only in his personal
  //     embedding pool and never leak into other students' global recall context.
  //   - All other memories remain globally scoped (userId = null).
  //
  // Two embeddings per entry:
  //   1. conversation_memory  — title + summary + full content (summary first so it survives token truncation)
  //   2. conversation_summary — title + summary only (~200 tokens, sharp keyword anchor, no truncation risk)
  //
  // The summary embedding is the key fix for "summarization loss": specific words like "toy" or "juguete"
  // appear prominently in the distilled summary but get diluted in the full-transcript vector.
  // Semantic search now hits both vectors, so a targeted query ("toy") finds the summary anchor
  // even when the full-content vector misses it.
  try {
    const db = getSharedDb();

    // Arm A: full-content embeddings for not-yet-indexed conversations only.
    // LAZY LOADING: fetch IDs + metadata only here (no content), content is loaded
    // one-at-a-time in runIndexer() via contentLoader to avoid bulk RAM usage.
    // Some conversation_memories entries are 146KB+ — loading 50 at once was OOM.
    const fullRows = await db
      .select({
        id: conversationMemories.id,
        title: conversationMemories.title,
        summary: conversationMemories.summary,
        importance: conversationMemories.importance,
        tags: conversationMemories.tags,
      })
      .from(conversationMemories)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'conversation_memory' AND memory_id = ${conversationMemories.id}
        )
      `)
      .limit(200);

    // Arm B: summary-only anchor embeddings — sharp, keyword-rich, never truncated
    const summaryRows = await db
      .select({
        id: conversationMemories.id,
        title: conversationMemories.title,
        summary: conversationMemories.summary,
        importance: conversationMemories.importance,
        tags: conversationMemories.tags,
      })
      .from(conversationMemories)
      .where(sql`
        NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'conversation_summary' AND memory_id = ${conversationMemories.id}
        )
        AND ${conversationMemories.summary} IS NOT NULL
        AND length(${conversationMemories.summary}) > 10
      `)
      .limit(200);

    // Arm C: verbatim content chunks — the heart of the fix.
    // For conversations longer than CHUNK_CHARS, the full transcript is sliced into
    // overlapping segments (~1000 tokens each). Every segment gets its own embedding,
    // pointing back to the parent conversation_memory via a stable chunk ID.
    //
    // This guarantees that EVERY moment of every conversation is semantically searchable
    // regardless of where it falls in the transcript — a 3 AM remark at token 12000
    // surfaces just as easily as the opening line.
    //
    // Performance note: content is fetched per-conversation (not in bulk) to avoid
    // pulling megabytes of data in one query. Some conversations are 100KB+ so the
    // bulk approach caused query timeouts.
    const unchunkedIds = await db
      .select({
        id: conversationMemories.id,
        title: conversationMemories.title,
        importance: conversationMemories.importance,
        tags: conversationMemories.tags,
      })
      .from(conversationMemories)
      .where(sql`
        length(${conversationMemories.content}) > ${CHUNK_CHARS}
        AND NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'conversation_chunk'
          AND memory_id = (${conversationMemories.id}::text || ':chunk:0')
        )
      `)
      .limit(20);

    // ── Batch-resolve actual owner for every founder-tagged row ──────────────
    // Instead of using a hard-coded administrator ID, extract the conversationId
    // from each row's cid: tag and look up conversations.user_id in a single
    // batch query.  A row with no matching conversation row is left null-scoped
    // (which is safe — null means globally visible, not leaked to a specific wrong user).
    const convOwnerMap = new Map<string, string>(); // conversationId → userId
    {
      const convIdsToLookup = new Set<string>();
      for (const rowSet of [fullRows, summaryRows, unchunkedIds]) {
        for (const r of rowSet) {
          const tags = r.tags ?? [];
          if (tags.includes('founder-chat') || tags.includes('founder-private')) {
            // Support both cid: (standard) and backfill-cid: (game-session backfill rows)
            const cidTag = tags.find(t => t.startsWith('cid:') || t.startsWith('backfill-cid:'));
            if (cidTag) {
              const convId = cidTag.startsWith('backfill-cid:')
                ? cidTag.slice('backfill-cid:'.length)
                : cidTag.slice('cid:'.length);
              convIdsToLookup.add(convId);
            }
          }
        }
      }
      if (convIdsToLookup.size > 0) {
        try {
          const userDb = getUserDb();
          const idList = [...convIdsToLookup]
            .map(id => `'${id.replace(/'/g, "''")}'`)
            .join(', ');
          const convRows = await userDb.execute(
            sql.raw(`SELECT id, user_id FROM conversations WHERE id IN (${idList})`),
          );
          for (const row of ((convRows as any).rows ?? [])) {
            if (row.id && row.user_id) convOwnerMap.set(row.id as string, row.user_id as string);
          }
        } catch (lookupErr: any) {
          console.warn(
            '[EmbedIndexer] owner lookup failed — founder embeddings will be null-scoped:',
            lookupErr.message,
          );
        }
      }
    }

    // Returns the owning userId for founder-tagged rows, or null for all others.
    // Handles both cid: (standard) and backfill-cid: (game-session backfill) tags.
    const resolveOwner = (tags: string[]): string | null => {
      if (!tags.includes('founder-chat') && !tags.includes('founder-private')) return null;
      // 1. Explicit owner: tag — multi-founder safe; takes precedence over all other rules.
      //    Rows tagged owner:USER_ID don't need a cid: tag.
      const ownerTag = tags.find(t => t.startsWith('owner:'));
      if (ownerTag) return ownerTag.slice('owner:'.length);
      // 2. Standard cid: → data-derived lookup ONLY; no hard-coded fallback.
      //    These rows can belong to any founder, so we must never assign a wrong user.
      //    Unresolvable cid: rows return null → skip-guard prevents global disclosure.
      const cidTag = tags.find(t => t.startsWith('cid:'));
      if (cidTag) {
        const convId = cidTag.slice('cid:'.length);
        return convOwnerMap.get(convId) ?? null;
      }
      // 3. backfill-cid: rows are David-specific by construction (seeded only by
      //    backfill-all-david-conversations.ts and backfill-game-sessions.ts).
      //    For real rows convOwnerMap will carry David's actual user_id.
      //    Fall back to DAVID_USER_ID when convOwnerMap misses (e.g. CI test fixtures
      //    with synthetic conv IDs, or rows whose conversation was later deleted).
      const backfillTag = tags.find(t => t.startsWith('backfill-cid:'));
      if (backfillTag) {
        const convId = backfillTag.slice('backfill-cid:'.length);
        return convOwnerMap.get(convId) ?? DAVID_USER_ID;
      }
      // 4. Founder-tagged but no owner:/cid:/backfill-cid: → unresolvable; skip guard
      //    will prevent creating a null-scoped global embedding.
      return null;
    };

    // Helper: is this row founder-private?
    const isFounderTagged = (tags: string[]): boolean =>
      tags.includes('founder-chat') || tags.includes('founder-private');

    // Process Arm A
    for (const r of fullRows) {
      const rowId = r.id;
      const rowTitle = r.title;
      const rowSummary = r.summary;
      const rowImportance = r.importance ?? 7;
      const strength = Math.min(1.0, rowImportance / 10);
      const tags = r.tags ?? [];
      const rowUserId = resolveOwner(tags);

      // Skip founder-tagged rows whose owner cannot be resolved — a null-scoped
      // founder embedding would expose private transcripts in the global pool.
      if (isFounderTagged(tags) && rowUserId === null) {
        console.warn(
          `[EmbedIndexer] Skipping Arm A for ${rowId} — founder-tagged but owner unresolvable (no cid: tag). ` +
          `Add cid:<conversationId> tag to enable embedding.`,
        );
        continue;
      }

      targets.push({
        id: rowId,
        userId: rowUserId,
        content: '',
        // Content is fetched lazily in runIndexer() — one at a time to avoid OOM.
        // Summary goes BEFORE content so keyword-rich anchor survives token truncation.
        contentLoader: async () => {
          const dbInner = getSharedDb();
          const row = await dbInner
            .select({ content: conversationMemories.content })
            .from(conversationMemories)
            .where(sql`${conversationMemories.id} = ${rowId}`)
            .limit(1);
          const fullContent = row[0]?.content ?? '';
          return [rowTitle, rowSummary, fullContent].filter(Boolean).join('\n\n');
        },
        memoryType: 'conversation_memory',
        initialStrength: strength,
        importance: rowImportance,
      });
    }

    // Process Arm B
    for (const r of summaryRows) {
      const tags = r.tags ?? [];
      const summaryUserId = resolveOwner(tags);

      // Skip unresolvable founder-tagged rows (same rule as Arm A).
      if (isFounderTagged(tags) && summaryUserId === null) {
        console.warn(
          `[EmbedIndexer] Skipping Arm B for ${r.id} — founder-tagged but owner unresolvable (no cid: tag).`,
        );
        continue;
      }

      const summaryContent = [r.title, r.summary].filter(Boolean).join('\n\n');
      targets.push({
        id: r.id,
        userId: summaryUserId,
        content: summaryContent,
        memoryType: 'conversation_summary',
        initialStrength: Math.min(1.0, (r.importance ?? 7) / 10),
        importance: r.importance ?? 7,
      });
    }

    // Process Arm C
    for (const r of unchunkedIds) {
      const contentRow = await db
        .select({ content: conversationMemories.content })
        .from(conversationMemories)
        .where(sql`id = ${r.id}`)
        .limit(1);
      const content = contentRow[0]?.content;
      if (!content) continue;

      const chunkTags = r.tags ?? [];
      const chunkUserId = resolveOwner(chunkTags);

      // Skip unresolvable founder-tagged rows (same rule as Arms A and B).
      if (isFounderTagged(chunkTags) && chunkUserId === null) {
        console.warn(
          `[EmbedIndexer] Skipping Arm C for ${r.id} — founder-tagged but owner unresolvable (no cid: tag).`,
        );
        continue;
      }

      const chunks = splitIntoChunks(content);
      const total = chunks.length;
      const chunkImportance = r.importance ?? 7;

      // Fetch existing chunks for this conversation only (targeted, not all chunks)
      const existingForThis = new Set(
        (await db
          .select({ memoryId: memoryEmbeddings.memoryId })
          .from(memoryEmbeddings)
          .where(sql`memory_type = 'conversation_chunk' AND memory_id LIKE ${r.id + ':chunk:%'}`)
        ).map(row => row.memoryId)
      );

      for (let i = 0; i < total; i++) {
        const chunkId = `${r.id}:chunk:${i}`;
        if (existingForThis.has(chunkId)) continue;
        const chunkContent = `[Memory: ${r.title ?? 'Untitled'} | Part ${i + 1} of ${total}]\n\n${reformatSpeakerHeaders(chunks[i])}`;
        targets.push({
          id: chunkId,
          userId: chunkUserId,
          content: chunkContent,
          memoryType: 'conversation_chunk',
          initialStrength: Math.min(1.0, chunkImportance / 10),
          importance: chunkImportance,
        });
      }
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] conversation_memories scan failed:', err.message);
  }

  return targets;
}

/**
 * Incremental message archive step.
 *
 * On each 2h indexer run, picks up to 30 conversations from the messages table
 * that don't yet have a conversation_memories entry tagged 'message-archive'.
 * Creates those entries so collectUnindexedMemories() can embed them on the
 * same or next run.
 *
 * This keeps the archive current without requiring a separate cron job.
 * The one-time backfill script (index-message-archive.ts) seeds the bulk;
 * this function handles all conversations going forward.
 */
async function archiveUnindexedConversations(): Promise<number> {
  const db = getSharedDb();
  const MIN_MESSAGES = 3;
  const PER_RUN_LIMIT = 30;

  let archived = 0;
  try {
    const result = await db.execute(sql`
      SELECT
        c.id,
        c.title,
        c.language,
        c.created_at,
        COUNT(m.id) AS msg_count
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversation_memories cm
        WHERE 'message-archive' = ANY(cm.tags)
          AND c.id = ANY(cm.tags)
      )
      GROUP BY c.id, c.title, c.language, c.created_at
      HAVING COUNT(m.id) >= ${MIN_MESSAGES}
      ORDER BY c.created_at DESC
      LIMIT ${PER_RUN_LIMIT}
    `);

    const rows = result.rows as Array<{
      id: string;
      title: string | null;
      language: string | null;
      created_at: Date | string;
      msg_count: string;
    }>;

    for (const conv of rows) {
      try {
        const msgsResult = await db.execute(sql`
          SELECT role, content, created_at
          FROM messages
          WHERE conversation_id = ${conv.id}
          ORDER BY created_at ASC
        `);
        const messages = msgsResult.rows as Array<{ role: string; content: string; created_at: Date | string }>;
        if (messages.length < MIN_MESSAGES) continue;

        const transcript = messages.map(m => {
          const speaker = m.role === 'assistant' ? 'DANIELA' : m.role.toUpperCase();
          const d = m.created_at ? new Date(m.created_at) : new Date();
          const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          return `[${dateStr}, ${timeStr} — ${speaker}]\n${m.content}`;
        }).join('\n\n');

        const lang = conv.language ? conv.language.charAt(0).toUpperCase() + conv.language.slice(1) : 'Language';
        const d = new Date(conv.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const title = (conv.title && conv.title.trim().length > 3)
          ? conv.title.trim()
          : `${lang} session — ${d} (${messages.length} messages)`;
        const firstStudent = messages.find(m => m.role === 'user');
        const summary = firstStudent
          ? `${lang} session (${messages.length} messages). Student: "${firstStudent.content.slice(0, 120)}"`
          : `${lang} session with ${messages.length} messages.`;

        await db.execute(sql`
          INSERT INTO conversation_memories
            (id, recorded_at, title, summary, content, tags, importance, entry_type, arc_name, created_at)
          VALUES
            (gen_random_uuid(), ${new Date(conv.created_at)}, ${title}, ${summary}, ${transcript},
             ARRAY['message-archive', ${conv.id}]::text[], 5, 'conversation', 'Message Archive', NOW())
        `);
        archived++;
      } catch (err: any) {
        console.warn(`[EmbedIndexer] archiveUnindexedConversations: failed for ${conv.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] archiveUnindexedConversations scan failed:', err.message);
  }

  if (archived > 0) {
    console.log(`[EmbedIndexer] Archived ${archived} conversation(s) from messages table → conversation_memories`);
  }
  return archived;
}

/**
 * Correct userId scope for any existing founder-chat / founder-private embeddings
 * that were stored with userId=NULL (global pool).
 *
 * Why this runs every indexer cycle:
 *   collectUnindexedMemories() only selects rows with NO embedding yet.  A
 *   NULL-scoped founder embedding that already exists is never selected as a
 *   target, so generateAndStoreEmbedding()'s userId-correction path (hash-match
 *   early return with userId update) cannot fire for it.  This explicit pass
 *   catches those already-indexed rows and corrects their scope directly — no
 *   re-embedding needed since only userId changes.
 */
/**
 * Read-only: how many founder-tagged conversation memories still have
 * null-scoped embeddings (the rows correctFounderEmbeddingScopes would repair).
 * Same predicate as the repair below; SELECT only.
 */
export async function countUnscopedFounderEmbeddings(): Promise<number> {
  const result = await getSharedDb().execute(sql`
    SELECT COUNT(DISTINCT cm.id)::int AS n
    FROM conversation_memories cm
    WHERE (
      cm.tags @> ARRAY['founder-chat']::text[]
      OR cm.tags @> ARRAY['founder-private']::text[]
    )
    AND EXISTS (
      SELECT 1 FROM memory_embeddings me
      WHERE me.user_id IS NULL
        AND me.memory_type IN ('conversation_memory', 'conversation_summary', 'conversation_chunk')
        AND SPLIT_PART(me.memory_id, ':chunk:', 1) = cm.id::text
    )
  `);
  return Number(((result as any).rows ?? [])[0]?.n ?? 0);
}

export async function correctFounderEmbeddingScopes(): Promise<void> {
  try {
    const sharedDb = getSharedDb();

    // Find all conversation_memories tagged founder-chat/founder-private that have
    // null-scoped embeddings needing correction.
    const cmResult = await sharedDb.execute(sql`
      SELECT DISTINCT cm.id, cm.tags
      FROM conversation_memories cm
      WHERE (
        cm.tags @> ARRAY['founder-chat']::text[]
        OR cm.tags @> ARRAY['founder-private']::text[]
      )
      AND EXISTS (
        SELECT 1 FROM memory_embeddings me
        WHERE me.user_id IS NULL
          AND me.memory_type IN ('conversation_memory', 'conversation_summary', 'conversation_chunk')
          AND SPLIT_PART(me.memory_id, ':chunk:', 1) = cm.id::text
      )
    `);
    const cmRows = (cmResult as any).rows ?? [];
    if (!cmRows.length) return;

    // Batch-resolve actual owner for each conversation via cid: / backfill-cid: tag
    // → conversations.user_id.  backfill-cid: tags are used by game-session backfill
    // rows that pre-date the cid: convention; both forms are handled identically.
    const convOwnerMap = new Map<string, string>(); // conversationId → userId
    const convIdsToLookup = new Set<string>();
    for (const row of cmRows) {
      const tags = (row.tags ?? []) as string[];
      const cidTag = tags.find(t => t.startsWith('cid:') || t.startsWith('backfill-cid:'));
      if (cidTag) {
        const convId = cidTag.startsWith('backfill-cid:')
          ? cidTag.slice('backfill-cid:'.length)
          : cidTag.slice('cid:'.length);
        convIdsToLookup.add(convId);
      }
    }
    if (convIdsToLookup.size > 0) {
      const userDb = getUserDb();
      const idList = [...convIdsToLookup]
        .map(id => `'${id.replace(/'/g, "''")}'`)
        .join(', ');
      const convRows = await userDb.execute(
        sql.raw(`SELECT id, user_id FROM conversations WHERE id IN (${idList})`),
      );
      for (const row of ((convRows as any).rows ?? [])) {
        if (row.id && row.user_id) convOwnerMap.set(row.id as string, row.user_id as string);
      }
    }

    // Update or delete null-scoped embeddings, one conversation at a time.
    // - Resolved owner: UPDATE user_id to the actual owner (user-scoped, safe).
    // - Unresolvable owner: DELETE the null-scoped embedding entirely.
    //   A null-scoped embedding for a founder-tagged row is a privacy breach:
    //   it appears in every student's semantic recall pool.  Deleting it quarantines
    //   the private content until the row is re-embedded with the correct cid: tag.
    let corrected = 0;
    let quarantined = 0;
    for (const row of cmRows) {
      const tags = (row.tags ?? []) as string[];
      const cidTag = tags.find(t => t.startsWith('cid:') || t.startsWith('backfill-cid:'));
      const convId = cidTag
        ? (cidTag.startsWith('backfill-cid:') ? cidTag.slice('backfill-cid:'.length) : cidTag.slice('cid:'.length))
        : undefined;
      const ownerId = convId ? convOwnerMap.get(convId) : undefined;
      const memId = row.id as string;

      if (ownerId) {
        // Resolved: update to the actual owner
        const updateResult = await sharedDb.execute(sql`
          UPDATE memory_embeddings
          SET user_id = ${ownerId}
          WHERE user_id IS NULL
            AND memory_type IN ('conversation_memory', 'conversation_summary', 'conversation_chunk')
            AND SPLIT_PART(memory_id, ':chunk:', 1) = ${memId}
        `);
        corrected += (updateResult as any).rowCount ?? 0;
      } else {
        // Unresolvable: DELETE to prevent global disclosure
        // (no cid: or backfill-cid: tag, or conversation row missing from DB)
        const deleteResult = await sharedDb.execute(sql`
          DELETE FROM memory_embeddings
          WHERE user_id IS NULL
            AND memory_type IN ('conversation_memory', 'conversation_summary', 'conversation_chunk')
            AND SPLIT_PART(memory_id, ':chunk:', 1) = ${memId}
        `);
        const deleted = (deleteResult as any).rowCount ?? 0;
        if (deleted > 0) {
          console.warn(
            `[EmbedIndexer] QUARANTINE: deleted ${deleted} null-scoped embedding(s) for founder-tagged row ${memId} ` +
            `(no cid: tag or conversation not found). Add cid:<conversationId> tag and re-run indexer to restore.`,
          );
          quarantined += deleted;
        }
      }
    }

    if (corrected > 0) {
      console.log(`[EmbedIndexer] Corrected ${corrected} NULL-scoped founder embedding(s) → actual owner userId`);
    }
    if (quarantined > 0) {
      console.warn(`[EmbedIndexer] Quarantined ${quarantined} unresolvable founder embedding(s) — add cid: tags to restore`);
    }
  } catch (err: any) {
    // Treat scope-correction failure as a security failure: a failed correction
    // leaves founder-tagged embeddings in the global pool where any student's
    // semanticSearch() can surface them.  Rethrow so runIndexer() surfaces the
    // error rather than silently completing with a privacy regression in place.
    throw new Error(`[EmbedIndexer] correctFounderEmbeddingScopes failed — scope integrity cannot be guaranteed: ${err.message}`);
  }
}

// ── Post-cycle straggler detection ───────────────────────────────────────────

const MAX_STRAGGLER_PATCH_PER_CYCLE = 20;   // kept well below OOM threshold
const STRAGGLER_PATCH_PAUSE_MS = 800;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Returns a neon() HTTP SQL tag for the straggler check.
 * The straggler check is periodic monitoring (runs every 2h) — HTTP latency
 * is acceptable, and using the same driver as CI ensures consistent results.
 */
function getStragglerSql() {
  const dbUrl = process.env.NEON_SHARED_DATABASE_URL ?? '';
  return neon(dbUrl);
}
/**
 * Counts how many conversation_memories rows have no embedding of any type.
 * Core liveness signal: > 0 after a cycle means the indexer left rows dark.
 * Delegates to straggler-detector.ts so the SQL is canonical and shared with CI.
 */
async function countUnembeddedConversationMemories(): Promise<number> {
  return countUnembeddedViaHttp(getStragglerSql());
}

/**
 * Returns the top `limit` conversation_memory IDs that have no embedding.
 * Ordered by highest importance first so critical memories are patched first.
 * Delegates to straggler-detector.ts so the SQL is canonical and shared with CI.
 */
async function getTopUnembeddedConversationMemoryIds(limit: number): Promise<string[]> {
  return getTopUnembeddedViaHttp(getStragglerSql(), limit);
}

/**
 * Patch a single straggler conversation_memory row.
 *
 * Exported so CI regression tests can call it directly without running the
 * full 2-hour indexer cycle.
 *
 * Ownership rules (identical to Arms A/B/C):
 *   - founder-tagged row with valid cid: → embed under the resolved userId
 *   - founder-tagged row with no cid: or unresolvable cid: → SKIP (do not create a global embedding)
 *   - non-founder row → embed with userId=null (globally accessible — correct for episodes etc.)
 *
 * Returns:
 *   'patched'   — embedding(s) written successfully
 *   'skipped'   — row was founder-tagged with unresolvable owner; no embedding written
 *   'not_found' — no row exists for the given id
 */
export async function patchSingleStraggler(id: string): Promise<'patched' | 'skipped' | 'not_found'> {
  const dbInner = getSharedDb();
  const rows = await dbInner
    .select({
      id: conversationMemories.id,
      title: conversationMemories.title,
      summary: conversationMemories.summary,
      content: conversationMemories.content,
      importance: conversationMemories.importance,
      tags: conversationMemories.tags,
    })
    .from(conversationMemories)
    .where(sql`${conversationMemories.id} = ${id}`)
    .limit(1);

  const row = rows[0];
  if (!row) return 'not_found';

  // Data-derived ownership: resolve userId via cid: tag → conversations.user_id,
  // mirroring the Arms A/B/C logic.  NEVER use a hard-coded administrator ID.
  const rowTags = row.tags ?? [];
  let userId: string | null;
  if (rowTags.includes('founder-chat') || rowTags.includes('founder-private')) {
    // Recognize both cid: (standard) and backfill-cid: (backfill-all-david-conversations.ts).
    const cidTag = rowTags.find((t: string) => t.startsWith('cid:') || t.startsWith('backfill-cid:'));
    if (!cidTag) {
      // Founder-tagged but no cid:/backfill-cid: — owner unresolvable; skip to prevent global disclosure.
      console.log(
        `[EmbedIndexer] Straggler: skipping ${id} — founder-tagged but no cid:/backfill-cid: tag. ` +
        `Add cid:<conversationId> to enable embedding.`,
      );
      return 'skipped';
    }
    const convId = cidTag.startsWith('backfill-cid:') ? cidTag.slice('backfill-cid:'.length) : cidTag.slice('cid:'.length);
    let resolvedUserId: string | undefined;
    try {
      const userDb = getUserDb();
      const convRows = await userDb.execute(
        sql.raw(`SELECT user_id FROM conversations WHERE id = '${convId.replace(/'/g, "''")}' LIMIT 1`),
      );
      const convRow = ((convRows as any).rows ?? [])[0];
      resolvedUserId = convRow?.user_id as string | undefined;
    } catch (lookupErr: any) {
      console.warn(`[EmbedIndexer] Straggler owner lookup failed for ${id}: ${lookupErr.message} — skipping`);
      return 'skipped';
    }
    if (!resolvedUserId) {
      // cid: present but conversation not found — skip rather than embed globally.
      console.log(
        `[EmbedIndexer] Straggler: skipping ${id} — cid:${convId} not found in conversations. ` +
        `Row will remain dark until conversation record exists.`,
      );
      return 'skipped';
    }
    userId = resolvedUserId;
  } else {
    userId = null; // non-founder row: null scope (correct for general memories)
  }

  const importance = row.importance ?? 7;
  const strength = Math.min(1.0, importance / 10);
  const fullContent = [row.title, row.summary, row.content].filter(Boolean).join('\n\n');

  if (fullContent.trim().length > 10) {
    await generateAndStoreEmbedding('conversation_memory', id, userId, fullContent, strength, importance);
  }
  if (row.summary && row.summary.length > 10) {
    const summaryContent = [row.title, row.summary].filter(Boolean).join('\n\n');
    await generateAndStoreEmbedding('conversation_summary', id, userId, summaryContent, strength, importance);
  }
  return 'patched';
}
/**
 * Post-cycle straggler check + inline auto-patch.
 *
 * Runs after each runIndexer() cycle:
 *   1. Counts any conversation_memories rows still missing embeddings.
 *   2. Logs a ⚠ WARNING visible in server logs if any are found.
 *   3. Auto-patches up to MAX_STRAGGLER_PATCH_PER_CYCLE stragglers by
 *      re-queueing them into the indexer's own lazy-load path.
 *
 * Never throws — a straggler check failure must not abort the indexer cycle.
 */
async function postCycleStragglerCheck(): Promise<void> {
  try {
    // runPostCycleWarning() is exported from straggler-detector.ts so CI scripts can call
    // it with a capture logger and assert warned === true after injecting a dark row.
    // This makes the warning branch directly testable without importing the full indexer.
    const { count: totalCount, warned } = await runPostCycleWarning(
      getStragglerSql(),
      console.warn,
    );
    if (!warned) {
      console.log('[EmbedIndexer] ✓ Straggler check: all conversation_memories rows are embedded.');
      return;
    }

    // Supplementary context line — runPostCycleWarning already logged the ⚠ WARNING above.
    console.warn(
      `[EmbedIndexer] To manually patch all missing rows run: ` +
      `npx tsx server/scripts/test-backfill-embeddings-complete.ts --patch`
    );

    // Auto-patch the top stragglers inline (high-importance first).
    const ids = await getTopUnembeddedConversationMemoryIds(MAX_STRAGGLER_PATCH_PER_CYCLE);
    console.log(`[EmbedIndexer] Auto-patching ${ids.length} straggler(s) now...`);
    let patched = 0;
    let patchErrors = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const outcome = await patchSingleStraggler(id);
        if (outcome === 'patched') patched++;
        // 'skipped' and 'not_found' are non-error outcomes — no patchErrors increment.
      } catch (err: any) {
        patchErrors++;
        console.warn(`[EmbedIndexer] Straggler patch failed for ${id}: ${err.message}`);
      }
      if (i < ids.length - 1) await sleep(STRAGGLER_PATCH_PAUSE_MS);
    }

    const remaining = await countUnembeddedConversationMemories();
    console.log(
      `[EmbedIndexer] Straggler patch done — patched: ${patched}, errors: ${patchErrors}, ` +
      `remaining dark: ${remaining}` +
      (remaining > 0 ? ` (will continue on next 2h cycle)` : ` ✓ all clear`)
    );
  } catch (err: any) {
    // Non-fatal: log and continue — the indexer must not crash on a monitoring failure
    console.warn('[EmbedIndexer] Straggler check failed (non-fatal):', err.message);
  }
}

/**
 * Deferred startup liveness check — fires 4h after server start.
 *
 * By 4h the 2h indexer has had two scheduled runs.  If conversation_memories
 * rows are still dark, something is wrong (OOM, API key failure, etc.).  This
 * surfaces the gap as a server-log warning so it does not go unnoticed for
 * hours or days.
 *
 * Count-only — no embedding work — to avoid heap pressure near boot.
 */
/**
 * Inner body of the startup liveness check — extracted so CI can inject a
 * mock countFn (e.g. one that throws) without waiting 4h.
 *
 * @param countFn  Defaults to the real countUnembeddedConversationMemories.
 *                 Pass a stub in tests.
 */
export async function runStartupLivenessCheckInner(
  countFn: () => Promise<number> = countUnembeddedConversationMemories,
): Promise<void> {
  try {
    const count = await countFn();
    if (count > 0) {
      console.warn(
        `[EmbedIndexer] ⚠ STARTUP LIVENESS CHECK (4h): ${count} conversation_memories row(s) ` +
        `still have no embedding after two indexer cycles. ` +
        `Run: npx tsx server/scripts/test-backfill-embeddings-complete.ts --patch`
      );
    } else {
      console.log('[EmbedIndexer] ✓ Startup liveness check (4h): all conversation_memories rows embedded.');
    }
  } catch (err: any) {
    console.warn('[EmbedIndexer] Startup liveness check failed (non-fatal):', err.message);
  }
}

function scheduleStartupLivenessCheck(): void {
  setTimeout(() => runStartupLivenessCheckInner(), FOUR_HOURS_MS);
}

export async function runIndexer(): Promise<void> {
  // Step 0: promote any un-archived conversations into conversation_memories
  // (up to 30 per run — drains the backlog incrementally and picks up new sessions)
  await archiveUnindexedConversations();

  // Step 0b: correct any NULL-scoped founder embeddings left by previous indexer runs
  // (already-indexed rows are not selected by collectUnindexedMemories, so this
  //  explicit pass is the only way to propagate scoping fixes to existing data)
  await correctFounderEmbeddingScopes();

  const targets = await collectUnindexedMemories();

  if (targets.length === 0) {
    console.log('[EmbedIndexer] All memories already indexed');
    return;
  }

  console.log(`[EmbedIndexer] Indexing ${targets.length} new memories...`);

  let generated = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);

    // Process batch sequentially when any item has a contentLoader (lazy content).
    // Parallel loading of multiple large conversation transcripts risks OOM.
    const hasLazy = batch.some(t => t.contentLoader);

    if (hasLazy) {
      for (const t of batch) {
        try {
          const content = t.contentLoader ? await t.contentLoader() : t.content;
          if (!content || content.trim().length <= 10) continue;
          const isNew = await generateAndStoreEmbedding(t.memoryType, t.id, t.userId, content, t.initialStrength, t.importance);
          if (isNew) generated++;
        } catch (err: any) {
          errors++;
          if (errors <= 3) {
            console.warn(`[EmbedIndexer] Failed to embed ${t.memoryType}/${t.id}:`, err.message);
          }
          if (err.message?.includes('OpenAI embedding failed') && errors === 1) {
            const { reportEmbeddingApiError } = await import('./sofia-billing-monitor');
            reportEmbeddingApiError({ source: 'EmbedIndexer', error: err.message }).catch(() => {});
          }
        }
      }
    } else {
      await Promise.all(
        batch.map(async (t) => {
          try {
            const isNew = await generateAndStoreEmbedding(t.memoryType, t.id, t.userId, t.content, t.initialStrength, t.importance);
            if (isNew) generated++;
          } catch (err: any) {
            errors++;
            if (errors <= 3) {
              console.warn(`[EmbedIndexer] Failed to embed ${t.memoryType}/${t.id}:`, err.message);
            }
            if (err.message?.includes('OpenAI embedding failed') && errors === 1) {
              const { reportEmbeddingApiError } = await import('./sofia-billing-monitor');
              reportEmbeddingApiError({ source: 'EmbedIndexer', error: err.message }).catch(() => {});
            }
          }
        })
      );
    }

    if (i + BATCH_SIZE < targets.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log(`[EmbedIndexer] Done — generated: ${generated}, errors: ${errors}, already fresh: ${targets.length - generated - errors}`);

  // Step 3: Post-cycle straggler check.
  // Detects any conversation_memories rows left dark (e.g. by OOM or rate-limit failures)
  // and auto-patches up to MAX_STRAGGLER_PATCH_PER_CYCLE of them before the next 2h run.
  await postCycleStragglerCheck();
}

/**
 * Post-session incremental indexer.
 * Embeds only the newest student_insights and personal_facts for one user
 * (records created in the last 15 minutes that have no embedding yet).
 * Called immediately after memory extraction at session end so new memories
 * are semantically searchable within the same session — not 2 hours later.
 */
export async function indexNewMemoriesForUser(userId: string): Promise<void> {
  const db = getSharedDb();
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
  const targets: IndexTarget[] = [];

  try {
    const rows = await db
      .select({
        id: studentInsights.id,
        insight: studentInsights.insight,
        details: (studentInsights as any).details,
        category: (studentInsights as any).category,
        observationCount: studentInsights.observationCount,
      })
      .from(studentInsights)
      .where(sql`
        student_id = ${userId}
        AND created_at >= ${fifteenMinsAgo}
        AND NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'student_insight' AND memory_id = ${studentInsights.id}
        )
      `)
      .limit(20);
    for (const r of rows) {
      const content = [r.insight, r.details, r.category].filter(Boolean).join('. ');
      if (content.trim().length > 5) targets.push({
        id: r.id, userId, content, memoryType: 'student_insight',
        initialStrength: Math.min(1.0, 0.7 + (r.observationCount ?? 1) * 0.06),
      });
    }
  } catch (err: any) {
    console.warn('[PostSessionIndex] student_insights scan failed:', err.message);
  }

  try {
    const rows = await db
      .select({
        id: learnerPersonalFacts.id,
        fact: learnerPersonalFacts.fact,
        context: learnerPersonalFacts.context,
        mentionCount: learnerPersonalFacts.mentionCount,
      })
      .from(learnerPersonalFacts)
      .where(sql`
        student_id = ${userId}
        AND is_active = true
        AND created_at >= ${fifteenMinsAgo}
        AND NOT EXISTS (
          SELECT 1 FROM memory_embeddings
          WHERE memory_type = 'personal_fact' AND memory_id = ${learnerPersonalFacts.id}
        )
      `)
      .limit(20);
    for (const r of rows) {
      const content = [r.fact, r.context].filter(Boolean).join('. ');
      if (content.trim().length > 5) targets.push({
        id: r.id, userId, content, memoryType: 'personal_fact',
        initialStrength: Math.min(1.0, 0.7 + (r.mentionCount ?? 1) * 0.06),
      });
    }
  } catch (err: any) {
    console.warn('[PostSessionIndex] personal_facts scan failed:', err.message);
  }

  if (targets.length === 0) {
    console.log(`[PostSessionIndex] Nothing new to index for user ${userId}`);
    return;
  }

  console.log(`[PostSessionIndex] Indexing ${targets.length} new record(s) for user ${userId}...`);
  let indexed = 0;
  for (const t of targets) {
    try {
      const isNew = await generateAndStoreEmbedding(t.memoryType, t.id, t.userId, t.content, t.initialStrength, t.importance);
      if (isNew) indexed++;
    } catch (err: any) {
      console.warn(`[PostSessionIndex] Failed to embed ${t.memoryType}/${t.id}:`, err.message);
    }
  }
  console.log(`[PostSessionIndex] Done — ${indexed} new embedding(s) stored for user ${userId}`);
}

export function startMemoryEmbeddingIndexer(): void {
  console.log('[EmbedIndexer] Starting (interval: 2h, no boot run)');

  // NO boot run. The server heap hits ~4GB during startup from background workers
  // (VocabImageSeed at +70s, MadrigalIndexer at +390s, ToolIndexer, etc.). A 10-min
  // delayed first run was landing directly on top of MadrigalIndexer and causing OOM.
  // The 2h setInterval is sufficient — embeddings are not latency-critical.
  setInterval(() => {
    runIndexer().catch(err =>
      console.error('[EmbedIndexer] Periodic run failed:', err.message)
    );
  }, INDEXER_INTERVAL_MS);

  // Deferred startup liveness check: fires 4h after boot.
  // By then the indexer has had two scheduled runs; any remaining dark rows
  // indicate a silent failure (OOM, API key problem, etc.) and are logged.
  scheduleStartupLivenessCheck();
}

/**
 * Derives the embedding owner for a conversation_memory row from its tags.
 *
 * Priority order:
 *   1. `owner:USER_ID` tag — explicit per-founder owner set by founder-chat-sync
 *      on INSERT/UPDATE.  Takes precedence so multi-founder deployments scope
 *      each founder's transcripts to the correct personal pool.
 *   2. `backfill-cid:*` tag — rows written by the David-specific game-session
 *      backfill; always owned by David.
 *   3. Anything else → null (globally scoped shared teaching resource).
 *
 * NOTE: `founder-chat` alone is NOT sufficient to infer ownership; it identifies
 * the row as a private transcript but not WHICH founder owns it.  Rows without
 * an explicit `owner:*` tag are only safe to assign to David because David is
 * currently the only user whose conversations have been synced — future founders
 * will always have the `owner:*` tag (added by founder-chat-sync ≥ Aug 2026).
 *
 * Exported for use by the integration test (test-backfill-scoping.ts).
 */
export function deriveConvMemoryOwner(tags: string[] | null | undefined): string | null {
  if (!tags) return null;
  // 1. Explicit owner tag wins — set by founder-chat-sync for every row it writes.
  const ownerTag = tags.find(t => t.startsWith('owner:'));
  if (ownerTag) return ownerTag.slice('owner:'.length);
  // 2. backfill-cid:* rows are David-specific by construction.
  if (tags.some(t => t.startsWith('backfill-cid:'))) return DAVID_USER_ID;
  // 3. No ownership information — globally scoped.
  return null;
}
