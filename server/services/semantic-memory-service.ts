/**
 * Semantic Memory Service
 *
 * Provides embedding-based similarity search over Daniela's memory stores.
 * Uses OpenAI text-embedding-3-small (768-dimensional, via dimensions param)
 * stored in the memory_embeddings table. Cosine similarity computed in
 * JavaScript so no pgvector extension is needed.
 *
 * Advantages over keyword search (ILIKE / tsvector):
 * - Finds conceptually related memories without exact word match
 * - "spontaneity" surfaces "improvisation", "jazz", "going off-script"
 * - "pride" surfaces memories tagged "accomplishment", "breakthrough", "tears"
 * - Language-agnostic (Spanish and English queries find the same memory)
 *
 * Usage:
 *   const results = await semanticSearch(userId, 'his relationship with music', 5);
 */

import { createHash } from 'crypto';
import { getSharedDb } from '../db';
import { memoryEmbeddings, learnerPersonalFacts } from '@shared/schema';
import { eq, and, isNull, inArray, desc, sql, type SQL } from 'drizzle-orm';
import { computeDecayMultiplier } from './memory-decay-service';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 768;
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
const OPERATION_SKILL_MIN_SIMILARITY = 0.4;

/**
 * Returns { apiKey, embedUrl } for the embedding call.
 *
 * Uses USER_OPENAI_API_KEY, the owner-managed direct OpenAI credential.
 * HolaHola intentionally does not use the Replit AI integration proxy.
 */

export interface SemanticSearchResult {
  memoryType: string;
  memoryId: string;
  similarity: number; // 0-1 cosine similarity
  contentHash: string;
}

// ─── Core math ────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 64);
}

// ─── OpenAI embedding API ─────────────────────────────────────────────────────

function getEmbedConfig(): { apiKey: string; embedUrl: string } | null {
  const directKey = process.env.USER_OPENAI_API_KEY;
  if (directKey) {
    return { apiKey: directKey, embedUrl: OPENAI_EMBED_URL };
  }
  return null;
}

export async function embedText(text: string): Promise<number[]> {
  const cfg = getEmbedConfig();
  if (!cfg) throw new Error('No OpenAI API key available for embeddings. Set USER_OPENAI_API_KEY.');

  const res = await fetch(cfg.embedUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8192),
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embedding failed (${res.status}): ${err}`);
  }

  const json = await res.json() as { data: { embedding: number[] }[] };
  const values = json.data?.[0]?.embedding;
  if (!values || values.length === 0) throw new Error('OpenAI returned empty embedding');
  return values;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Generate and store an embedding for a single memory.
 * Idempotent: skips if an embedding with matching contentHash already exists.
 * Returns true if a new embedding was generated, false if skipped.
 */
export async function generateAndStoreEmbedding(
  memoryType: string,
  memoryId: string,
  userId: string | null,
  content: string,
  initialStrength?: number,
  importance?: number,
  dbOverride?: any,
): Promise<boolean> {
  if (memoryType === 'operation_skill' && userId !== null) {
    throw new Error('operation_skill embeddings must be global and cannot be user-scoped');
  }

  const db = dbOverride ?? getSharedDb();
  const hash = hashContent(content);

  // Check if already up-to-date
  const existing = await db
    .select({ contentHash: memoryEmbeddings.contentHash, userId: memoryEmbeddings.userId })
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.memoryType, memoryType),
      eq(memoryEmbeddings.memoryId, memoryId),
    ))
    .limit(1);

  if (existing.length > 0 && existing[0].contentHash === hash) {
    // Hash matches — content unchanged. Still check if userId needs correcting.
    // This ensures a scoping fix (e.g. NULL→ownerUserId for founder-chat memories)
    // propagates on the next indexer cycle without waiting for content to change.
    const existingUserId = existing[0].userId;
    const userIdMismatch = existingUserId !== userId;
    if (userIdMismatch || importance !== undefined) {
      const patch: Record<string, unknown> = {};
      if (userIdMismatch) patch.userId = userId;
      if (importance !== undefined) patch.importance = importance;
      await db
        .update(memoryEmbeddings)
        .set(patch as any)
        .where(and(
          eq(memoryEmbeddings.memoryType, memoryType),
          eq(memoryEmbeddings.memoryId, memoryId),
        ));
    }
    return false; // Content unchanged (no re-embed needed)
  }

  let embedding: number[];
  try {
    embedding = await embedText(content);
  } catch (err: any) {
    // Gracefully skip when no valid embedding key/endpoint is available.
    // This covers: no key set, proxy that doesn't support /embeddings, etc.
    // Auth failures (401) and transient errors still propagate so callers
    // know a real key is present but broken.
    const msg: string = err?.message ?? '';
    const isConfigGap =
      msg.includes('No OpenAI API key') ||
      msg.includes('INVALID_ENDPOINT') ||
      msg.includes('is not supported');
    if (isConfigGap) {
      console.warn(
        `[SemanticMemory] Skipping embedding for ${memoryType}:${memoryId} — ` +
        `no valid embedding endpoint configured (set USER_OPENAI_API_KEY).`
      );
      return false;
    }
    throw err;
  }

  if (existing.length > 0) {
    // Update stale embedding — include userId and importance so they are always in sync
    await db
      .update(memoryEmbeddings)
      .set({
        embedding, contentHash: hash, userId, createdAt: new Date(),
        ...(importance !== undefined ? { importance } : {}),
      })
      .where(and(
        eq(memoryEmbeddings.memoryType, memoryType),
        eq(memoryEmbeddings.memoryId, memoryId),
      ));
  } else {
    // Insert new — use initialStrength and importance if provided
    await db.insert(memoryEmbeddings).values({
      memoryType,
      memoryId,
      userId,
      embedding,
      contentHash: hash,
      strength: Math.min(1.0, Math.max(0.05, initialStrength ?? 1.0)),
      importance: importance ?? 5,
    });
  }
  return true;
}

// ─── North Star principle embedding cache ─────────────────────────────────────

const NORTH_STAR_MEMORY_TYPE = 'north_star_principle';

/**
 * Return the embedding vector for a North Star principle, reading from the
 * memory_embeddings cache first.  If no cached entry exists (or the principle
 * text has changed since it was cached), the embedding is computed via OpenAI
 * and stored so future calls are free.
 *
 * Callers in processReachNorthStar should use this instead of calling
 * embedText(p.principle) directly — principles are static, so the embedding
 * never changes and should be paid for at most once.
 */
export async function getCachedPrincipleEmbedding(
  principleId: string,
  principleText: string,
): Promise<number[]> {
  const db = getSharedDb();
  const hash = hashContent(principleText);

  const [cached] = await db
    .select({ embedding: memoryEmbeddings.embedding, contentHash: memoryEmbeddings.contentHash })
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.memoryType, NORTH_STAR_MEMORY_TYPE),
      eq(memoryEmbeddings.memoryId, principleId),
    ))
    .limit(1);

  if (cached && cached.contentHash === hash) {
    // Cache hit — no OpenAI call needed
    return cached.embedding as number[];
  }

  // Cache miss or stale — compute and store
  const embedding = await embedText(principleText);

  if (cached) {
    await db
      .update(memoryEmbeddings)
      .set({ embedding, contentHash: hash, createdAt: new Date() })
      .where(and(
        eq(memoryEmbeddings.memoryType, NORTH_STAR_MEMORY_TYPE),
        eq(memoryEmbeddings.memoryId, principleId),
      ));
  } else {
    await db.insert(memoryEmbeddings).values({
      memoryType: NORTH_STAR_MEMORY_TYPE,
      memoryId: principleId,
      userId: null, // global — not per-student
      embedding,
      contentHash: hash,
      strength: 1.0,
    });
  }

  return embedding;
}

// ─── Search ───────────────────────────────────────────────────────────────────

// Global memory types that are always safe to include in student recall searches.
// collaboration_message is intentionally excluded from this default set — it is 23k+ rows
// of Hive messages that are only relevant for Express Lane / Hive-specific searches.
// Including it in every student memory recall loaded ~356MB of JSONB per call, causing
// the 10-second memory lookup delays observed in voice sessions.
//
// Access-control model for conversation_memory / conversation_summary / conversation_chunk:
//   - Genuinely global memories (episodes, Daniela teaching notes, team decisions) are
//     stored with userId=NULL and are globally accessible — this is correct and intentional.
//   - Private conversations (e.g. founder ↔ Daniela chat transcripts) MUST be stored with
//     the owning founder's userId so they appear ONLY in that user's recall pool (not the
//     global pool). The write path in reembedConversationMemory() accepts a userId parameter
//     for this purpose. The founder-chat-sync service passes David's userId when triggering
//     re-embeds, ensuring new transcripts are user-scoped from the moment they are indexed.
// Existing null-scoped private rows can be migrated with migrate-private-conversation-embeddings.ts.
const GLOBAL_RECALL_TYPES = [
  'daniela_tool', 'hive_snapshot', 'growth_memory', 'goal_capability', 'teaching_skill',
  'conversation_memory', 'conversation_summary', 'conversation_chunk',
  // agent_handoff = Alden/David/Claude Code <-> Agent engineering notes (agent_notes
  // table). Low volume (a handful per session, not per-user), unlike
  // collaboration_message's 23k+ rows, so it's safe to include by default rather
  // than requiring an explicit opt-in.
  'agent_handoff',
];
const EMBED_SELECT = {
  memoryType: memoryEmbeddings.memoryType,
  memoryId: memoryEmbeddings.memoryId,
  embedding: memoryEmbeddings.embedding,
  contentHash: memoryEmbeddings.contentHash,
  strength: memoryEmbeddings.strength,
  lastReinforcedAt: memoryEmbeddings.lastReinforcedAt,
  pinned: memoryEmbeddings.pinned,
  importance: memoryEmbeddings.importance,
} as const;

/**
 * Dedicated operation-catalogue search.
 *
 * operation_skill is deliberately excluded from GLOBAL_RECALL_TYPES so these
 * engineering operations never enter Daniela's ordinary student-memory recall.
 * This path accepts only globally scoped, pinned records from the indexer's
 * protected namespace. The static catalogue remains authoritative: callers
 * must map returned IDs back to code-defined manifests before presenting them.
 */
export async function semanticSearchOperationSkills(
  query: string,
  limit: number = 5,
): Promise<SemanticSearchResult[]> {
  const db = getSharedDb();
  const boundedLimit = Math.max(1, Math.min(10, limit));
  const rows = await db
    .select(EMBED_SELECT)
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.memoryType, 'operation_skill'),
      isNull(memoryEmbeddings.userId),
      eq(memoryEmbeddings.pinned, true),
    ))
    .orderBy(desc(memoryEmbeddings.importance), desc(memoryEmbeddings.lastReinforcedAt))
    .limit(500);

  if (rows.length === 0) return [];

  const queryVec = await embedText(query);
  return rows
    .map(row => ({
      memoryType: row.memoryType,
      memoryId: row.memoryId,
      similarity: cosineSimilarity(queryVec, row.embedding as number[]),
      contentHash: row.contentHash,
    }))
    // The operation catalogue is a tiny, tightly controlled corpus. Its
    // paraphrase scores are materially lower than long-form memory scores, so
    // it uses a measured operation-specific threshold rather than Daniela's
    // broader-memory 0.65 threshold. Returned rows remain candidates only.
    .filter(row => row.similarity > OPERATION_SKILL_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, boundedLimit);
}

export interface ScoredCandidate {
  memoryType: string;
  memoryId: string;
  contentHash: string;
  similarity: number;
  effectiveScore: number;
}

// ─── Stored-vector search (memory_embeddings.embedding_vec, migration 0077) ───
//
// Scoring in Postgres over the stored pgvector column avoids pulling every candidate
// row (768 floats each, ~67 MB for one user's conversation pool) into Node. It is used
// only for type sets whose rows are all filled; until the backfill data-op finishes,
// or where pgvector is absent, callers keep the jsonb path. Readiness is checked in the
// background so a lookup never waits on it.

export interface SemanticSearchOptions {
  /** Score in Postgres over embedding_vec once every row of the requested types has one. */
  storedVectors?: boolean;
}

const STORED_VECTOR_TOP_K = 50;
const STORED_VECTOR_RECHECK_MS = 60_000;
const EMBEDDING_VEC = sql.raw('"memory_embeddings"."embedding_vec"');

interface StoredVectorReadiness { ready: boolean; checkedAt: number; checking?: Promise<void> }
const storedVectorReadiness = new Map<string, StoredVectorReadiness>();

async function storedVectorsFilled(types: string[]): Promise<boolean> {
  const db = getSharedDb();
  const column: any = await db.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_embeddings' AND column_name = 'embedding_vec'`);
  if ((column.rows ?? column).length === 0) return false;
  const unfilled = await db
    .select({ one: sql<number>`1` })
    .from(memoryEmbeddings)
    .where(and(
      inArray(memoryEmbeddings.memoryType, types),
      sql`${EMBEDDING_VEC} IS NULL`,
      sql`jsonb_typeof(${memoryEmbeddings.embedding}) = 'array'`,
      sql`jsonb_array_length(${memoryEmbeddings.embedding}) = 768`,
    ))
    .limit(1);
  return unfilled.length === 0;
}

/** Non-blocking: answers from the cache and refreshes it in the background. */
export function storedVectorsReady(types: string[], check = storedVectorsFilled, now = Date.now): boolean {
  const key = [...types].sort().join(',');
  let state = storedVectorReadiness.get(key);
  if (!state) storedVectorReadiness.set(key, state = { ready: false, checkedAt: -Infinity });
  if (state.ready) return true;
  if (!state.checking && now() - state.checkedAt >= STORED_VECTOR_RECHECK_MS) {
    const current = state;
    current.checking = check(types)
      .then(ready => { current.ready = ready; })
      .catch(err => console.warn('[SemanticSearch] Stored-vector readiness check failed:', (err as Error).message))
      .finally(() => { current.checkedAt = now(); current.checking = undefined; });
  }
  return false;
}

export function resetStoredVectorReadinessForTests(): void {
  storedVectorReadiness.clear();
}

export async function scoreWithStoredVectors(
  queryVec: number[],
  userCondition: SQL,
  globalTypes: string[],
): Promise<ScoredCandidate[]> {
  const db = getSharedDb();
  const literal = `[${queryVec.map(v => (Number.isFinite(v) ? v : 0)).join(',')}]`;
  const distance = sql`(${EMBEDDING_VEC} <=> ${literal}::vector)`;
  const select = {
    memoryType: memoryEmbeddings.memoryType,
    memoryId: memoryEmbeddings.memoryId,
    contentHash: memoryEmbeddings.contentHash,
    strength: memoryEmbeddings.strength,
    lastReinforcedAt: memoryEmbeddings.lastReinforcedAt,
    pinned: memoryEmbeddings.pinned,
    similarity: sql<number>`1 - ${distance}`,
  };
  const nearest = (pool: SQL) => db.select(select).from(memoryEmbeddings)
    .where(and(pool, sql`${EMBEDDING_VEC} IS NOT NULL`))
    .orderBy(distance).limit(STORED_VECTOR_TOP_K);
  // Also take the nearest rows inside the window the jsonb path scores (same caps and
  // ordering), so a recent, moderately similar memory that decay would rank first can
  // never be crowded out of the top-k by many older, closer matches. The result is a
  // superset of what the jsonb path would consider for ranking.
  const nearestInWindow = (pool: SQL, order: SQL[], cap: number) => db.select(select).from(memoryEmbeddings)
    .where(and(sql`${EMBEDDING_VEC} IS NOT NULL`, inArray(memoryEmbeddings.id,
      db.select({ id: memoryEmbeddings.id }).from(memoryEmbeddings).where(pool).orderBy(...order).limit(cap))))
    .orderBy(distance).limit(STORED_VECTOR_TOP_K);
  // Same ownership guard as the jsonb path: userId IS NULL and GLOBAL_RECALL_TYPES only.
  const globalPool = globalTypes.length > 0
    ? and(isNull(memoryEmbeddings.userId), inArray(memoryEmbeddings.memoryType, globalTypes))!
    : null;
  const batches = await Promise.all([
    nearest(userCondition),
    nearestInWindow(userCondition,
      [desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.lastReinforcedAt), desc(memoryEmbeddings.strength)], 8000),
    ...(globalPool ? [
      nearest(globalPool),
      nearestInWindow(globalPool,
        [desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.importance), desc(memoryEmbeddings.strength), desc(memoryEmbeddings.lastReinforcedAt)], 5000),
    ] : []),
  ]);
  const unique = new Map<string, (typeof batches)[number][number]>();
  for (const row of batches.flat()) unique.set(`${row.memoryType}:${row.memoryId}`, row);
  return [...unique.values()].map(row => {
    const similarity = Number(row.similarity) || 0;
    return {
      memoryType: row.memoryType,
      memoryId: row.memoryId,
      contentHash: row.contentHash,
      similarity,
      effectiveScore: similarity * computeDecayMultiplier(row.strength ?? 1.0, row.lastReinforcedAt ?? null, row.pinned ?? false),
    };
  });
}


/** Shared tail of semanticSearch: decay ranking, raw-cosine threshold, expired-fact filter. */
async function rankScoredCandidates(scored: ScoredCandidate[], limit: number): Promise<SemanticSearchResult[]> {
  // Sort by effective score (recently reinforced memories rank higher at equal relevance).
  // Threshold applied to raw cosine so highly relevant but faded memories still pass.
  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
  // T001 Ghost Facts fix: post-filter expired personal facts.
  // memory_embeddings has no expiry field — once embedded, a fact lives in the
  // vector index forever even if invalidated via valid_to in learner_personal_facts.
  // This check removes stale entries before they reach the LLM.
  const aboveThreshold = scored.filter(r => r.similarity > 0.65);

  const personalFactIds = aboveThreshold
    .filter(r => r.memoryType === 'learner_personal_fact')
    .map(r => r.memoryId);

  let expiredIds = new Set<string>();
  if (personalFactIds.length > 0) {
    try {
      const db = getSharedDb();
      const now = new Date();
      const facts = await db
        .select({ id: learnerPersonalFacts.id, validTo: learnerPersonalFacts.validTo })
        .from(learnerPersonalFacts)
        .where(inArray(learnerPersonalFacts.id, personalFactIds));
      for (const fact of facts) {
        if (fact.validTo !== null && fact.validTo < now) {
          expiredIds.add(fact.id);
        }
      }
      if (expiredIds.size > 0) {
        console.log(`[SemanticSearch] Filtered ${expiredIds.size} expired personal fact(s) from results`);
      }
    } catch (err: any) {
      console.warn('[SemanticSearch] Ghost facts validity check failed — returning unfiltered:', err.message);
    }
  }

  return aboveThreshold
    .filter(r => !expiredIds.has(r.memoryId))
    .slice(0, limit)
    .map(r => ({ memoryType: r.memoryType, memoryId: r.memoryId, similarity: r.similarity, contentHash: r.contentHash }));
}

/**
 * Find the top-k memories most semantically similar to the query string.
 *
 * Runs two parallel queries — user-specific records + global records — then
 * merges and scores with cosine similarity + decay weighting.
 *
 * Performance notes:
 *   - User-specific: capped at 8000 rows, ordered by pinned → strength → recency.
 *   - Global: only safe, small types loaded by default (191 rows).
 *     collaboration_message (23k+ rows) is excluded unless explicitly requested
 *     via memoryTypes — loading it for every recall caused ~10s delays.
 *   - Type filter is pushed into SQL (not applied post-load).
 */
export async function semanticSearch(
  userId: string,
  query: string,
  limit: number = 5,
  memoryTypes?: string[],
  options?: SemanticSearchOptions,
): Promise<SemanticSearchResult[]> {
  const db = getSharedDb();

  const wantsCollabMessages = memoryTypes?.includes('collaboration_message') ?? false;

  // SQL-level type filter for user rows (push-down avoids loading irrelevant types)
  const userTypeCondition = memoryTypes && memoryTypes.length > 0
    ? inArray(memoryEmbeddings.memoryType, memoryTypes)
    : undefined;

  // Global types: use explicit list when provided, otherwise use safe defaults.
  // Non-bypassable intersection with GLOBAL_RECALL_TYPES: even if a caller
  // explicitly requests conversation_memory / conversation_summary /
  // conversation_chunk, those types are stripped from the global (userId IS NULL)
  // query.  Private transcripts stored globally (userId=NULL) must never be
  // reachable from another user's session — caller intent does not override this.
  const globalTypes = (memoryTypes && memoryTypes.length > 0
    ? (wantsCollabMessages ? memoryTypes : memoryTypes.filter(t => t !== 'collaboration_message'))
    : GLOBAL_RECALL_TYPES
  ).filter(t => GLOBAL_RECALL_TYPES.includes(t));

  if (options?.storedVectors && userTypeCondition && storedVectorsReady([...new Set([...memoryTypes!, ...globalTypes])])) {
    return rankScoredCandidates(
      await scoreWithStoredVectors(await embedText(query), and(eq(memoryEmbeddings.userId, userId), userTypeCondition)!, globalTypes),
      limit,
    );
  }

  // Run both queries in parallel
  const [userRows, globalRows] = await Promise.all([
    // User-specific: ordered by pinned → strength → recency, capped at 8000
    db
      .select(EMBED_SELECT)
      .from(memoryEmbeddings)
      .where(
        userTypeCondition
          ? and(eq(memoryEmbeddings.userId, userId), userTypeCondition)
          : eq(memoryEmbeddings.userId, userId),
      )
      // Sort by pinned first, then by recency (lastReinforcedAt) rather than raw strength.
      // Raw strength is the un-decayed value — a memory reinforced 2 years ago but never
      // touched since can have strength=1.0 while a fresh memory has strength=0.2, causing
      // the stale memory to displace the fresh one in the 8000-row buffer BEFORE JS decay
      // is applied.  Using recency as the primary sort puts recently-active memories first
      // so they are never cut from the buffer by long-forgotten high-strength entries.
      .orderBy(desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.lastReinforcedAt), desc(memoryEmbeddings.strength))
      .limit(8000),

    // Global (userId IS NULL): only safe types unless collaboration explicitly requested.
    // Cap raised from 1000 → 5000: the global pool now holds 73K+ embeddings across
    // conversation_memory / conversation_summary / conversation_chunk alone; 1000 rows
    // sorted by strength was silently cutting older high-importance memories (e.g. game
    // sessions, early David-Daniela conversations) before cosine scoring even ran.
    //
    // Privacy: the userId IS NULL predicate is the ownership guard. NULL scope = globally
    // accessible; userId-scoped = private to that user only. correctFounderEmbeddingScopes()
    // runs at boot to ensure all founder-tagged rows carry the correct userId before any
    // recall query runs — so no strength/importance filter is needed here and none is applied.
    // Strength ≥ X is NOT a privacy signal: the most important private transcripts would
    // pass such a filter. Trust the userId column, not content metadata.
    //
    // Sort order: pinned → importance DESC → strength DESC → lastReinforcedAt DESC.
    // importance DESC ensures high-importance rows always land in the buffer before
    // the cap fires; strength and recency break ties within the same importance tier.
    globalTypes.length > 0
      ? db
        .select(EMBED_SELECT)
        .from(memoryEmbeddings)
        .where(and(
          isNull(memoryEmbeddings.userId),
          inArray(memoryEmbeddings.memoryType, globalTypes),
        ))
        .orderBy(desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.importance), desc(memoryEmbeddings.strength), desc(memoryEmbeddings.lastReinforcedAt))
        .limit(5000)
      : Promise.resolve([]),
  ]);

  const rows = [...userRows, ...globalRows];
  if (rows.length === 0) return [];

  // Embed the query
  const queryVec = await embedText(query);

  // Score all candidates — raw cosine for threshold, decayed score for ranking
  const scored = rows.map(row => {
    const similarity = cosineSimilarity(queryVec, row.embedding as number[]);
    const decay = computeDecayMultiplier(
      row.strength ?? 1.0,
      row.lastReinforcedAt ?? null,
      row.pinned ?? false,
    );
    return {
      memoryType: row.memoryType,
      memoryId: row.memoryId,
      contentHash: row.contentHash,
      similarity,               // raw cosine — used for threshold checks by callers
      effectiveScore: similarity * decay, // decay-weighted — used for ranking only
    };
  });

  return rankScoredCandidates(scored, limit);
}

/**
 * Identical to semanticSearch but accepts a pre-computed query vector instead of a
 * text string.  Use this when the embedding is already known (e.g. from the North
 * Star principle cache) to avoid a redundant OpenAI API call.
 */
export async function semanticSearchByVector(
  userId: string,
  queryVec: number[],
  limit: number = 5,
  memoryTypes?: string[],
): Promise<SemanticSearchResult[]> {
  const db = getSharedDb();

  const wantsCollabMessages = memoryTypes?.includes('collaboration_message') ?? false;

  const userTypeCondition = memoryTypes && memoryTypes.length > 0
    ? inArray(memoryEmbeddings.memoryType, memoryTypes)
    : undefined;

  // Global types: non-bypassable intersection with GLOBAL_RECALL_TYPES — even if a
  // caller explicitly requests conversation_memory / conversation_summary /
  // conversation_chunk, those are stripped from the global (userId IS NULL) query.
  // Private transcripts stored globally (userId=NULL) must never be reachable from
  // another user's session — caller intent does not override this.
  const globalTypes = (memoryTypes && memoryTypes.length > 0
    ? (wantsCollabMessages ? memoryTypes : memoryTypes.filter(t => t !== 'collaboration_message'))
    : GLOBAL_RECALL_TYPES
  ).filter(t => GLOBAL_RECALL_TYPES.includes(t));

  const [userRows, globalRows] = await Promise.all([
    db
      .select(EMBED_SELECT)
      .from(memoryEmbeddings)
      .where(
        userTypeCondition
          ? and(eq(memoryEmbeddings.userId, userId), userTypeCondition)
          : eq(memoryEmbeddings.userId, userId),
      )
      .orderBy(desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.lastReinforcedAt), desc(memoryEmbeddings.strength))
      .limit(8000),

    // Global pool: userId IS NULL is the only ownership guard — same model as semanticSearch.
    // correctFounderEmbeddingScopes() runs at boot to scope private rows before any query runs.
    globalTypes.length > 0
      ? db
        .select(EMBED_SELECT)
        .from(memoryEmbeddings)
        .where(and(
          isNull(memoryEmbeddings.userId),
          inArray(memoryEmbeddings.memoryType, globalTypes),
        ))
        // pinned → importance → strength → recency: importance ensures high-value memories
        // always enter the 5000-row buffer; strength and recency break ties within the same tier.
        .orderBy(desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.importance), desc(memoryEmbeddings.strength), desc(memoryEmbeddings.lastReinforcedAt))
        .limit(5000)
      : Promise.resolve([]),
  ]);

  const rows = [...userRows, ...globalRows];
  if (rows.length === 0) return [];

  const scored = rows.map(row => {
    const similarity = cosineSimilarity(queryVec, row.embedding as number[]);
    const decay = computeDecayMultiplier(
      row.strength ?? 1.0,
      row.lastReinforcedAt ?? null,
      row.pinned ?? false,
    );
    return {
      memoryType: row.memoryType,
      memoryId: row.memoryId,
      contentHash: row.contentHash,
      similarity,
      effectiveScore: similarity * decay,
    };
  });

  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);

  const aboveThreshold = scored.filter(r => r.similarity > 0.65);

  // Ghost-facts expiry check (mirrors semanticSearch)
  const personalFactIds = aboveThreshold
    .filter(r => r.memoryType === 'learner_personal_fact')
    .map(r => r.memoryId);

  let expiredIds = new Set<string>();
  if (personalFactIds.length > 0) {
    try {
      const now = new Date();
      const facts = await db
        .select({ id: learnerPersonalFacts.id, validTo: learnerPersonalFacts.validTo })
        .from(learnerPersonalFacts)
        .where(inArray(learnerPersonalFacts.id, personalFactIds));
      for (const fact of facts) {
        if (fact.validTo !== null && fact.validTo < now) {
          expiredIds.add(fact.id);
        }
      }
    } catch { /* non-fatal — return unfiltered */ }
  }

  return aboveThreshold
    .filter(r => !expiredIds.has(r.memoryId))
    .slice(0, limit)
    .map(r => ({ memoryType: r.memoryType, memoryId: r.memoryId, similarity: r.similarity, contentHash: r.contentHash }));
}

/**
 * Find memories that are semantically connected to a source memory.
 * Uses the source memory's stored embedding vector directly — no new AI call needed.
 * This surfaces the associative structure already latent in the embedding space.
 *
 * Returns up to `limit` connected memories sorted by raw cosine similarity (no decay
 * weighting — for association we want the structural connection, not recency).
 */
export async function findConnectedMemories(
  userId: string,
  sourceMemoryId: string,
  sourceMemoryType: string = 'conversation_memory',
  limit: number = 5,
): Promise<Array<{ memoryId: string; memoryType: string; similarity: number }>> {
  const db = getSharedDb();

  const [source] = await db
    .select({ embedding: memoryEmbeddings.embedding })
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.memoryId, sourceMemoryId),
      eq(memoryEmbeddings.memoryType, sourceMemoryType),
    ))
    .limit(1);

  if (!source?.embedding) return [];

  const sourceVec = source.embedding as number[];

  const [userRows, globalRows] = await Promise.all([
    db.select(EMBED_SELECT)
      .from(memoryEmbeddings)
      .where(eq(memoryEmbeddings.userId, userId))
      .orderBy(desc(memoryEmbeddings.strength), desc(memoryEmbeddings.lastReinforcedAt))
      .limit(8000),
    // Global pool: userId IS NULL is the ownership guard — mirrors semanticSearch/semanticSearchByVector.
    // No strength filter: correctFounderEmbeddingScopes() at boot ensures private rows are user-scoped.
    db.select(EMBED_SELECT)
      .from(memoryEmbeddings)
      .where(and(
        isNull(memoryEmbeddings.userId),
        inArray(memoryEmbeddings.memoryType, GLOBAL_RECALL_TYPES),
      ))
      // pinned → importance → strength → recency: mirrors the main search functions so the
      // 5000-row cap always includes high-importance global memories before lower-value content.
      .orderBy(desc(memoryEmbeddings.pinned), desc(memoryEmbeddings.importance), desc(memoryEmbeddings.strength), desc(memoryEmbeddings.lastReinforcedAt))
      .limit(5000),
  ]);

  const rows = [...userRows, ...globalRows].filter(r => r.memoryId !== sourceMemoryId);
  if (rows.length === 0) return [];

  const scored = rows.map(row => ({
    memoryType: row.memoryType,
    memoryId: row.memoryId,
    similarity: cosineSimilarity(sourceVec, row.embedding as number[]),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored
    .filter(r => r.similarity > 0.6)
    .slice(0, limit);
}
