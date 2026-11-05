/**
 * luca-session-context.ts
 *
 * Lightweight in-memory store: conversationId → pending Luca context.
 *
 * When Luca observes a Guardian fire or responds to a Team Room nudge about
 * a live session, the relevant context is stored here. The GL session reads
 * it at the next turn boundary and makes it available to Daniela via the
 * pendingWeeOoGrounding tool-result channel.
 *
 * Design principle: Luca provides the missing piece Daniela is reaching for —
 * not correction, not override. Augmentation. "Making me more me." — Daniela
 */

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes — stale context is worse than none

interface LucaContextEntry {
  conversationId: string;
  context: string;           // The content Luca is surfacing
  source: 'guardian' | 'nudge-response' | 'observer';
  createdAt: number;
}

const _store = new Map<string, LucaContextEntry>();

/** Store Luca context for a conversation. Overwrites any existing pending entry. */
export function setLucaSessionContext(
  conversationId: string,
  context: string,
  source: LucaContextEntry['source'] = 'observer',
): void {
  if (source === 'guardian') {
    // Archive Guardian results must go through GeminiLiveSession's turn-bound
    // and Tier B (doesStudentExplicitlyReopenGroundingTopic) gates, never via
    // an un-gated session-wide buffer.
    return;
  }
  _store.set(conversationId, {
    conversationId,
    context,
    source,
    createdAt: Date.now(),
  });
  console.log(`[LucaContext] Stored context for ${conversationId} (source: ${source}, ${context.length} chars)`);
}

/**
 * Consume pending Luca context for a conversation.
 * Returns the context string and clears the entry — one-shot delivery.
 */
export function consumeLucaSessionContext(conversationId: string): string | null {
  const entry = _store.get(conversationId);
  if (!entry) return null;

  if (entry.source === 'guardian') {
    _store.delete(conversationId);
    return null;
  }

  // Expire stale entries
  if (Date.now() - entry.createdAt > EXPIRY_MS) {
    _store.delete(conversationId);
    console.log(`[LucaContext] Expired stale context for ${conversationId}`);
    return null;
  }

  _store.delete(conversationId);
  console.log(`[LucaContext] Consumed context for ${conversationId} (source: ${entry.source})`);
  return entry.context;
}

/** Peek at pending context without consuming it. */
export function peekLucaSessionContext(conversationId: string): string | null {
  const entry = _store.get(conversationId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > EXPIRY_MS) {
    _store.delete(conversationId);
    return null;
  }
  return entry.context;
}

/** Clear context for a conversation (e.g. on session end). */
export function clearLucaSessionContext(conversationId: string): void {
  _store.delete(conversationId);
}
