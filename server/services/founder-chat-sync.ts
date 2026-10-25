/**
 * Founder Chat Sync Worker
 *
 * Problem: David's live chat conversations with Daniela live only in the
 * `messages` table. Daniela's memory tools (recall, search, introspect) can
 * only reach `conversation_memories`. So when Carol walked in with a zucchini
 * and David laughed about it with Daniela — that moment was invisible to her
 * on the next session.
 *
 * This worker makes every David↔Daniela conversation searchable by Daniela.
 *
 * Three layers:
 *
 *   1. IMMEDIATE — notifyConversationUpdated(id) is called by routes.ts after
 *      every assistant message save. A per-conversation debounce (30s) batches
 *      the user+assistant pair and syncs within seconds of the exchange.
 *
 *   2. SWEEP — every 5 minutes, catches any conversation updated in the last
 *      15 minutes (covers reconnects, multi-language sessions, rapid learners).
 *
 *   3. RETROACTIVE — 5 minutes after boot, walks the ENTIRE conversations
 *      table in batches of 200 (no cap) so day-one memories are reachable.
 *      Subsequent boots skip already-indexed conversations in O(1) via tag check.
 */

import { getUserDb } from '../db';
import { sql } from 'drizzle-orm';
import {
  ALDEN_NARRATIVE_POLICY_VERSION, buildAldenClusters, exchangeLabelKey, groupAldenExchanges, prefilterExchange,
  reconcileAldenClusters, sha256Utf8, type AldenCluster, type AldenExchange, type AldenMessageRow,
} from './alden-chat-transcript';
import { ALDEN_CLASSIFIER_MODEL, ALDEN_CLASSIFIER_PROMPT_SHA256, classifyAldenExchange } from './alden-exchange-classifier';

// Fallback owner for legacy rows created before the 'owner:USER_ID' tag was
// introduced.  New rows carry an explicit 'owner:USER_ID' tag derived from the
// actual conversation's user_id column, so this constant is only needed for the
// rare case where we cannot determine the owner from context.
const LEGACY_DAVID_USER_ID = '49847136';

const SWEEP_INTERVAL_MS     =  5 * 60 * 1000; // every 5 minutes
const SWEEP_INITIAL_DELAY   =  3 * 60 * 1000; // 3 min after boot
const RETROACTIVE_DELAY_MS  =  5 * 60 * 1000; // 5 min after boot
const SWEEP_WINDOW_MINUTES  = 15;              // look back 15 min on each sweep
const RETROACTIVE_BATCH     = 200;             // rows per DB page — no total cap
const NOTIFY_DEBOUNCE_MS    = 30 * 1000;       // batch user+assistant pair

// Per-conversation debounce map: conversationId → timeout handle
const pendingNotifications = new Map<string, ReturnType<typeof setTimeout>>();

let retroactiveRunning = false;
let sweepRunning       = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip artifact patterns that sometimes leak into messages.content:
 *
 * 1. Tool call blobs — `self_write{action:..., params_json:...}` — these are
 *    raw tool invocations that were stringified into the content field instead
 *    of being executed silently.
 *
 * 2. Tool result wrappers — `response:self_write{result:{...}}` — the result
 *    payload echoed back into content before the real text follows.
 *
 * 3. Leaked thought tokens — `thought\n<internal reasoning>` prefixes that
 *    appear when Gemini's includeThoughts:true output bleeds into the message.
 *
 * 4. Thinking Process blocks — `Thinking Process (post-tool-call): ...`
 *    sections that Daniela occasionally surfaced verbatim.
 *
 * Returns null if the entire content was artifact (skip the message entirely).
 */
function sanitizeContent(raw: string): string | null {
  let text = (raw ?? '').trim();

  // Strip leading tool call blob: self_write{...} or any tool name followed by {
  // These appear at the start of content before real text, or as the whole message
  text = text.replace(/^[a-z_]+\{[^}]*(?:\{[^}]*\}[^}]*)?\}[\n\r]*/gi, '');

  // Strip response wrapper: response:toolname{result:{...}}
  text = text.replace(/^response:[a-z_]+\{.*?\}[\n\r]*/gi, '');

  // Strip leaked thought token block: lines starting with "thought" followed by reasoning
  // Pattern: "thought\n<text until a blank line or natural speech begins>"
  text = text.replace(/^thought\n[\s\S]*?(?=\n\n|\n[A-Z]|$)/i, '');

  // Strip "Thinking Process (post-tool-call):" blocks
  text = text.replace(/Thinking Process \(post-tool-call\):[\s\S]*?(?=\n\n[A-Z]|$)/gi, '');

  // Strip bracketed system markers that are not conversation
  // e.g. [ARCHIVE GUARDIAN: ...], [PRIOR TURN CONTEXT: ...], [DANIELA_STATE]
  text = text.replace(/\[(?:ARCHIVE GUARDIAN|PRIOR TURN CONTEXT|DANIELA_STATE|SESSION ANCHOR|LUCA[^\]]*)[^\]]*\]/gi, '');

  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 0 ? text : null;
}

function formatTranscript(
  messages: Array<{ role: string; content: string }>
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const clean = sanitizeContent(m.content);
    if (!clean) continue; // entire message was artifact — skip
    const speaker = m.role === 'user' ? 'David' : 'Daniela';
    lines.push(`${speaker}: ${clean}`);
  }
  return lines.join('\n\n');
}

function buildSummary(
  messages: Array<{ role: string; content: string }>,
  topic: string | null,
  language: string
): string {
  const firstUser     = messages.find(m => m.role === 'user')?.content?.slice(0, 300)     ?? '';
  const firstDaniela  = messages.find(m => m.role === 'assistant')?.content?.slice(0, 200) ?? '';
  const count         = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;

  const parts: string[] = [];
  if (topic) parts.push(`Topic: ${topic}.`);
  parts.push(`Language: ${language}. ${count} exchanges.`);
  if (firstUser)    parts.push(`David opened: "${firstUser.replace(/\n/g, ' ')}"`);
  if (firstDaniela) parts.push(`Daniela: "${firstDaniela.replace(/\n/g, ' ')}"`);
  return parts.join(' ');
}

// Bump this when the sanitizer logic changes — any saved entry missing this
// tag will be re-processed on the next sweep or retroactive pass.
const SANITIZER_VERSION = 'sanv:1';

function buildTags(conv: {
  id: string;
  language: string;
  topic: string | null;
  message_count: number;
  user_id: string | null;
}): string[] {
  const tags = [
    'founder-chat',
    'daniela-chat',
    conv.language,
    `cid:${conv.id}`,
    `msgcount:${conv.message_count}`,
    SANITIZER_VERSION,
  ];
  // Explicit owner tag — deriveConvMemoryOwner() reads this to scope embeddings
  // to the correct founder's personal pool rather than guessing from 'founder-chat'.
  // Omitted when user_id is null (edge case; correctFounderEmbeddingScopes will quarantine).
  if (conv.user_id) tags.push(`owner:${conv.user_id}`);
  if (conv.topic) tags.push(conv.topic.toLowerCase().slice(0, 40));
  return tags;
}

// ── Core: sync one conversation ───────────────────────────────────────────────

async function syncConversation(conv: {
  id: string;
  user_id: string | null;  // Owning founder's userId — passed to reembedAsync for user-scoped embedding
  title: string | null;
  topic: string | null;
  language: string;
  message_count: number;
  created_at: string;
  last_message_at: string | null;
}): Promise<'saved' | 'updated' | 'skipped' | 'empty'> {
  const db = getUserDb();

  const msgResult = await db.execute(sql.raw(`
    SELECT role, content, created_at
    FROM messages
    WHERE conversation_id = '${conv.id.replace(/'/g, "''")}'
    ORDER BY created_at ASC
    LIMIT 5000
  `));
  const messages = msgResult.rows as Array<{ role: string; content: string; created_at: string }>;
  const real = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (real.length < 2) return 'empty';

  const transcript = formatTranscript(messages);
  const summary    = buildSummary(messages, conv.topic, conv.language);
  const tags       = buildTags(conv);
  const title      = conv.title
    || (conv.topic ? `Chat: ${conv.topic}` : null)
    || `David + Daniela — ${conv.created_at.slice(0, 10)}`;

  // Check for existing entry via cid: tag
  const existing = await db.execute(sql.raw(`
    SELECT id, tags
    FROM conversation_memories
    WHERE tags @> ARRAY['cid:${conv.id.replace(/'/g, "''")}']
    LIMIT 1
  `));

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as { id: string; tags: string[] };
    const existingTags = row.tags ?? [];
    const existingMsgCount = existingTags.find((t: string) => t.startsWith('msgcount:'));
    const hasSanitizerVersion = existingTags.includes(SANITIZER_VERSION);
    // Skip only if message count AND sanitizer version both match
    if (existingMsgCount === `msgcount:${conv.message_count}` && hasSanitizerVersion) return 'skipped';

    // Conversation has grown — update in place
    await db.execute(sql.raw(`
      UPDATE conversation_memories SET
        title   = '${title.replace(/'/g, "''")}',
        summary = '${summary.replace(/'/g, "''")}',
        content = '${transcript.replace(/'/g, "''")}',
        tags    = ARRAY[${tags.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')}]
      WHERE id = '${row.id}'
    `));
    reembedAsync(row.id, conv.user_id ?? null);
    return 'updated';
  }

  // New entry
  const insertResult = await db.execute(sql.raw(`
    INSERT INTO conversation_memories
      (title, summary, content, participants, entry_type, tags, importance, arc_name)
    VALUES (
      '${title.replace(/'/g, "''")}',
      '${summary.replace(/'/g, "''")}',
      '${transcript.replace(/'/g, "''")}',
      'David + Daniela',
      'conversation',
      ARRAY[${tags.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')}],
      7,
      'david-daniela-chats'
    )
    RETURNING id
  `));
  const newId = (insertResult.rows[0] as { id: string })?.id;
  if (newId) reembedAsync(newId, conv.user_id ?? null);
  return 'saved';
}
function reembedAsync(id: string, userId: string | null): void {
  // Embed under the conversation's owning userId so the embedding is user-scoped
  // (accessible only to that user's session) rather than globally visible.
  import('../scripts/reembed-memory')
    .then(mod => mod.reembedConversationMemory(id, userId))
    .catch(() => { /* non-fatal */ });
}

// ── Founder user IDs (cached after first load) ────────────────────────────────

let cachedFounderIds: string[] | null = null;

async function getFounderUserIds(): Promise<string[]> {
  if (cachedFounderIds) return cachedFounderIds;
  const db = getUserDb();
  const result = await db.execute(sql.raw(`
    SELECT id FROM users WHERE role IN ('admin', 'developer') ORDER BY created_at ASC
  `));
  cachedFounderIds = (result.rows as Array<{ id: string }>).map(r => r.id);
  return cachedFounderIds;
}

// ── Immediate hook (called by routes.ts) ──────────────────────────────────────

/**
 * Call this after every assistant message is saved for a conversation.
 * A 30-second debounce batches the user+assistant pair into one sync.
 * Fire-and-forget — never throws.
 */
export function notifyConversationUpdated(conversationId: string): void {
  const existing = pendingNotifications.get(conversationId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(async () => {
    pendingNotifications.delete(conversationId);
    try {
      const founderIds = await getFounderUserIds();
      if (!founderIds.length) return;

      const idList = founderIds.map(id => `'${id}'`).join(', ');
      const db = getUserDb();
      const result = await db.execute(sql.raw(`
        SELECT id, user_id, title, topic, language, message_count, created_at, last_message_at
        FROM conversations
        WHERE id = '${conversationId.replace(/'/g, "''")}' AND user_id IN (${idList})
        LIMIT 1
      `));
      if (!result.rows.length) return; // not a founder conversation — skip

      const conv = result.rows[0] as {
        id: string; user_id: string | null; title: string | null; topic: string | null;
        language: string; message_count: number;
        created_at: string; last_message_at: string | null;
      };
      const outcome = await syncConversation(conv);
      if (outcome === 'saved' || outcome === 'updated') {
        console.log(`[FounderChatSync] Immediate sync: ${outcome} — conv ${conversationId.slice(0, 8)}`);
      }
    } catch (err) {
      console.warn('[FounderChatSync] Immediate sync error:', err instanceof Error ? err.message : err);
    }
  }, NOTIFY_DEBOUNCE_MS);

  pendingNotifications.set(conversationId, handle);
}

// ── Sweep (recent conversations) ──────────────────────────────────────────────

async function runSweep(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const founderIds = await getFounderUserIds();
    if (!founderIds.length) return;

    const idList = founderIds.map(id => `'${id}'`).join(', ');
    const db = getUserDb();
    const result = await db.execute(sql.raw(`
      SELECT id, user_id, title, topic, language, message_count, created_at, last_message_at
      FROM conversations
      WHERE user_id IN (${idList})
        AND message_count >= 2
        AND (
          last_message_at > NOW() - INTERVAL '${SWEEP_WINDOW_MINUTES} minutes'
          OR created_at    > NOW() - INTERVAL '${SWEEP_WINDOW_MINUTES} minutes'
        )
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT 100
    `));

    const convs = result.rows as Array<{
      id: string; user_id: string | null; title: string | null; topic: string | null;
      language: string; message_count: number;
      created_at: string; last_message_at: string | null;
    }>;

    let saved = 0, updated = 0;
    for (const conv of convs) {
      // Skip if already being handled by a pending immediate notification
      if (pendingNotifications.has(conv.id)) continue;
      try {
        const outcome = await syncConversation(conv);
        if (outcome === 'saved')   saved++;
        if (outcome === 'updated') updated++;
      } catch { /* non-fatal */ }
      await new Promise(r => setTimeout(r, 30));
    }
    if (saved + updated > 0) {
      console.log(`[FounderChatSync] Sweep complete — saved: ${saved}, updated: ${updated}`);
    }
  } catch (err) {
    console.error('[FounderChatSync] Sweep error:', err instanceof Error ? err.message : err);
  } finally {
    sweepRunning = false;
  }
}

// ── Retroactive pass (no cap, paginated) ──────────────────────────────────────

async function runRetroactivePass(): Promise<void> {
  if (retroactiveRunning) return;
  retroactiveRunning = true;

  try {
    const founderIds = await getFounderUserIds();
    if (!founderIds.length) { retroactiveRunning = false; return; }

    const idList = founderIds.map(id => `'${id}'`).join(', ');
    const db     = getUserDb();

    let offset = 0;
    let totalSaved = 0, totalUpdated = 0, totalSkipped = 0, totalEmpty = 0;

    while (true) {
      const batch = await db.execute(sql.raw(`
        SELECT id, user_id, title, topic, language, message_count, created_at, last_message_at
        FROM conversations
        WHERE user_id IN (${idList}) AND message_count >= 2
        ORDER BY created_at ASC
        LIMIT ${RETROACTIVE_BATCH} OFFSET ${offset}
      `));

      const convs = batch.rows as Array<{
        id: string; user_id: string | null; title: string | null; topic: string | null;
        language: string; message_count: number;
        created_at: string; last_message_at: string | null;
      }>;

      if (!convs.length) break; // done

      for (const conv of convs) {
        try {
          const outcome = await syncConversation(conv);
          if (outcome === 'saved')   totalSaved++;
          if (outcome === 'updated') totalUpdated++;
          if (outcome === 'skipped') totalSkipped++;
          if (outcome === 'empty')   totalEmpty++;
        } catch (err) {
          console.warn(`[FounderChatSync] Retroactive error on ${conv.id}:`,
            err instanceof Error ? err.message : err);
        }
        // Light throttle — avoid holding the DB connection pool under load
        await new Promise(r => setTimeout(r, 50));
      }

      offset += RETROACTIVE_BATCH;

      // Brief pause between pages
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(
      `[FounderChatSync] Retroactive pass complete — ` +
      `saved: ${totalSaved}, updated: ${totalUpdated}, ` +
      `skipped: ${totalSkipped}, empty: ${totalEmpty}, ` +
      `total processed: ${offset}`
    );
  } catch (err) {
    console.error('[FounderChatSync] Retroactive pass error:', err instanceof Error ? err.message : err);
  } finally {
    retroactiveRunning = false;
  }
}

// ── Alden conversations (alden_messages) ──────────────────────────────────────
//
// David's sessions with Alden live only in alden_conversations / alden_messages.
// Only their conversational part becomes recall: consecutive conversational
// exchanges, kept whole and verbatim, form one conversation_memories row each
// ("cluster"), opening with the Gemini-approved framing line. The technical
// record stays where it is. Labels are derived, stored once per exact source
// and policy (alden_exchange_labels), and every sync reconciles the session's
// derived rows deterministically. Alden is founder-only, so rows are owned by
// (and embedded into) David's pool. Rules: alden-chat-transcript.ts.

const ALDEN_ARC_NAME = 'david-alden-chats';
const pendingAldenNotifications = new Map<string, ReturnType<typeof setTimeout>>();
let aldenSweepRunning = false;
let aldenRetroactiveRunning = false;

/** The founder-chat sanitizer would change this text, so it can't be stored as verbatim. */
const sanitizerAlters = (raw: string) => (sanitizeContent(raw) ?? '') !== (raw ?? '').trim();

type AldenSyncOutcome = { inserted: number; updated: number; retired: number; unchanged: number; pendingLabels: number };

async function syncAldenConversation(conversationId: string): Promise<AldenSyncOutcome | 'empty'> {
  const db = getUserDb();
  const convResult = await db.execute(sql`
    SELECT id, title, started_at FROM alden_conversations WHERE id = ${conversationId} LIMIT 1
  `);
  const conv = convResult.rows[0] as { id: string; title: string; started_at: string | Date } | undefined;
  if (!conv) return 'empty';

  // Rows from one exchange share created_at (one multi-row insert), so the
  // caller's turn sorts first and insertion order (ctid) breaks the rest.
  const msgResult = await db.execute(sql`
    SELECT id, role, content FROM alden_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at ASC, CASE WHEN role IN ('david', 'luca') THEN 0 ELSE 1 END, ctid
    LIMIT 5000
  `);
  const exchanges = groupAldenExchanges(msgResult.rows as AldenMessageRow[]);
  if (exchanges.length === 0) return 'empty';

  // 1. Labels: stored once per exact source and policy; new ones computed here,
  //    outside any transaction (classifier calls are slow).
  const stored = await db.execute(sql`
    SELECT label_key, label FROM alden_exchange_labels WHERE conversation_id = ${conversationId}
  `);
  const labels = new Map((stored.rows as Array<{ label_key: string; label: string }>).map((r) => [r.label_key, r.label]));
  let pendingLabels = 0;
  const labelled: Array<{ exchange: AldenExchange; labelKey: string; label: string }> = [];
  for (const exchange of exchanges) {
    const labelKey = exchangeLabelKey(exchange, ALDEN_CLASSIFIER_MODEL, ALDEN_CLASSIFIER_PROMPT_SHA256);
    let label = labels.get(labelKey);
    if (!label) {
      const pre = prefilterExchange(exchange, sanitizerAlters);
      let reason: string;
      let density: number | null;
      if (pre.decision === 'label') {
        label = pre.label; reason = pre.reason; density = pre.density;
      } else {
        const classified = await classifyAldenExchange(exchange.caller.content, exchange.reply!.content).catch(() => null);
        if (!classified) { pendingLabels++; labelled.push({ exchange, labelKey, label: 'pending' }); continue; }
        label = classified; reason = `classifier: ${classified}`; density = pre.density;
      }
      await db.execute(sql`
        INSERT INTO alden_exchange_labels
          (label_key, conversation_id, caller_message_id, caller_sha256, reply_message_id, reply_sha256,
           policy_version, label, reason, prefilter_density, classifier_model, prompt_sha256)
        VALUES (
          ${labelKey}, ${conversationId}, ${exchange.caller.id}, ${sha256Utf8(exchange.caller.content)},
          ${exchange.reply?.messageIds[0] ?? null}, ${exchange.reply ? sha256Utf8(exchange.reply.content) : null},
          ${ALDEN_NARRATIVE_POLICY_VERSION}, ${label}, ${reason.slice(0, 200)}, ${density},
          ${pre.decision === 'classify' ? ALDEN_CLASSIFIER_MODEL : null},
          ${pre.decision === 'classify' ? ALDEN_CLASSIFIER_PROMPT_SHA256 : null}
        )
        ON CONFLICT (label_key) DO NOTHING
      `);
      labels.set(labelKey, label);
    }
    labelled.push({ exchange, labelKey, label });
  }

  // 2. Clusters, reconciled under a per-session lock so the immediate hook and
  //    the sweep can't both insert the same cluster. Derived rows only.
  const desired = buildAldenClusters(labelled);
  const startedAt = new Date(conv.started_at).toISOString().slice(0, 10);
  const toEmbed: string[] = [];
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'alden-sync:' + conversationId}, 0))`);
    const existingRows = await tx.execute(sql`
      SELECT id, tags FROM conversation_memories
      WHERE arc_name = ${ALDEN_ARC_NAME} AND ${`alden-cid:${conversationId}`} = ANY(tags)
    `);
    const existing = (existingRows.rows as Array<{ id: string; tags: string[] | null }>).map((row) => ({
      id: row.id,
      anchorCallerId: row.tags?.find((t) => t.startsWith('alden-anchor:'))?.slice('alden-anchor:'.length) ?? null,
      clusterSha256: row.tags?.find((t) => t.startsWith('alden-cluster:'))?.slice('alden-cluster:'.length) ?? null,
    }));
    const plan = reconcileAldenClusters(existing, desired);
    const fields = (cluster: AldenCluster) => {
      const index = desired.indexOf(cluster);
      return {
        title: `David + Alden — ${conv.title}${desired.length > 1 ? ` (${index + 1} of ${desired.length})` : ''}`,
        summary: `Conversation with Alden, ${startedAt}. ${cluster.exchangeCount} exchange${cluster.exchangeCount === 1 ? '' : 's'}.`,
        tags: JSON.stringify([
          'founder-chat', 'alden-chat', `alden-cid:${conversationId}`, `alden-anchor:${cluster.anchorCallerId}`,
          `alden-cluster:${cluster.clusterSha256}`, ALDEN_NARRATIVE_POLICY_VERSION, `owner:${LEGACY_DAVID_USER_ID}`,
        ]),
      };
    };
    for (const cluster of plan.insert) {
      const f = fields(cluster);
      const inserted = await tx.execute(sql`
        INSERT INTO conversation_memories (title, summary, content, participants, entry_type, tags, importance, arc_name)
        VALUES (${f.title}, ${f.summary}, ${cluster.content}, 'David + Alden', 'conversation',
          ARRAY(SELECT jsonb_array_elements_text(${f.tags}::jsonb)), 7, ${ALDEN_ARC_NAME})
        RETURNING id
      `);
      const id = (inserted.rows[0] as { id: string } | undefined)?.id;
      if (id) toEmbed.push(id);
    }
    for (const { id, cluster } of plan.update) {
      const f = fields(cluster);
      await tx.execute(sql`
        UPDATE conversation_memories SET title = ${f.title}, summary = ${f.summary}, content = ${cluster.content},
          tags = ARRAY(SELECT jsonb_array_elements_text(${f.tags}::jsonb))
        WHERE id = ${id}
      `);
      toEmbed.push(id);
    }
    for (const id of plan.retire) {
      // A retired cluster takes its embeddings with it, so recall never serves stale text.
      await tx.execute(sql`DELETE FROM memory_embeddings WHERE memory_id = ${id} OR memory_id LIKE ${id + ':chunk:%'}`);
      await tx.execute(sql`DELETE FROM conversation_memories WHERE id = ${id} AND arc_name = ${ALDEN_ARC_NAME}`);
    }
    return { inserted: plan.insert.length, updated: plan.update.length, retired: plan.retire.length, unchanged: plan.unchanged.length, pendingLabels };
  });
  for (const id of toEmbed) reembedAsync(id, LEGACY_DAVID_USER_ID);
  return outcome;
}

/**
 * Call after Alden messages are saved for a conversation (routes.ts, both
 * Alden chat endpoints). Same 30s debounce as Daniela chats. Never throws.
 */
export function notifyAldenConversationUpdated(conversationId: string): void {
  const existing = pendingAldenNotifications.get(conversationId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(async () => {
    pendingAldenNotifications.delete(conversationId);
    try {
      const outcome = await syncAldenConversation(conversationId);
      if (outcome !== 'empty' && outcome.inserted + outcome.updated + outcome.retired > 0) {
        console.log(`[FounderChatSync] Alden immediate sync — conv ${conversationId.slice(0, 8)}: ${JSON.stringify(outcome)}`);
      }
    } catch (err) {
      console.warn('[FounderChatSync] Alden immediate sync error:', err instanceof Error ? err.message : err);
    }
  }, NOTIFY_DEBOUNCE_MS);
  pendingAldenNotifications.set(conversationId, handle);
}

async function runAldenSweep(): Promise<void> {
  if (aldenSweepRunning) return;
  aldenSweepRunning = true;
  try {
    const result = await getUserDb().execute(sql`
      SELECT DISTINCT conversation_id FROM alden_messages
      WHERE created_at > NOW() - (${SWEEP_WINDOW_MINUTES} * INTERVAL '1 minute')
      LIMIT 100
    `);
    for (const { conversation_id } of result.rows as Array<{ conversation_id: string }>) {
      if (pendingAldenNotifications.has(conversation_id)) continue;
      try { await syncAldenConversation(conversation_id); } catch { /* non-fatal */ }
      await new Promise(r => setTimeout(r, 30));
    }
  } catch (err) {
    console.error('[FounderChatSync] Alden sweep error:', err instanceof Error ? err.message : err);
  } finally {
    aldenSweepRunning = false;
  }
}

async function runAldenRetroactivePass(): Promise<void> {
  if (aldenRetroactiveRunning) return;
  aldenRetroactiveRunning = true;
  const counts = { sessions: 0, empty: 0, inserted: 0, updated: 0, retired: 0, pendingLabels: 0 };
  try {
    let offset = 0;
    while (true) {
      const batch = await getUserDb().execute(sql`
        SELECT id FROM alden_conversations ORDER BY started_at ASC, id ASC
        LIMIT ${RETROACTIVE_BATCH} OFFSET ${offset}
      `);
      const ids = (batch.rows as Array<{ id: string }>).map((r) => r.id);
      if (!ids.length) break;
      for (const id of ids) {
        try {
          const outcome = await syncAldenConversation(id);
          counts.sessions++;
          if (outcome === 'empty') counts.empty++;
          else {
            counts.inserted += outcome.inserted; counts.updated += outcome.updated;
            counts.retired += outcome.retired; counts.pendingLabels += outcome.pendingLabels;
          }
        } catch (err) {
          console.warn(`[FounderChatSync] Alden retroactive error on ${id}:`, err instanceof Error ? err.message : err);
        }
        await new Promise(r => setTimeout(r, 50));
      }
      offset += RETROACTIVE_BATCH;
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[FounderChatSync] Alden retroactive pass complete — ${JSON.stringify(counts)}`);
  } catch (err) {
    console.error('[FounderChatSync] Alden retroactive pass error:', err instanceof Error ? err.message : err);
  } finally {
    aldenRetroactiveRunning = false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startFounderChatSyncWorker(): void {
  // Retroactive: full table walk, 5 min after boot
  setTimeout(() => runRetroactivePass(), RETROACTIVE_DELAY_MS);
  setTimeout(() => runAldenRetroactivePass(), RETROACTIVE_DELAY_MS);

  // Sweep: every 5 minutes, starting 3 min after boot
  setTimeout(() => {
    runSweep();
    runAldenSweep();
    setInterval(runSweep, SWEEP_INTERVAL_MS);
    setInterval(runAldenSweep, SWEEP_INTERVAL_MS);
  }, SWEEP_INITIAL_DELAY);

  console.log(
    '[FounderChatSync] Worker registered — ' +
    'Daniela and Alden chats: immediate sync on each message, 5-min sweeps, retroactive pass in 5min'
  );
}
