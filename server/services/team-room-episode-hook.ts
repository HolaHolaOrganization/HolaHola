/**
 * team-room-episode-hook.ts
 *
 * Fires whenever Luca posts a message to the HolaHola Team Room.
 * If a rolling episode is currently active (a conversation_memories row tagged
 * "rolling" in the "HolaHola Episodes" arc), the message is appended to the
 * episode .md via the .local/.episode_append trigger file.
 *
 * Attribution label: LUCA [HolaHola]:  (per the episode source attribution taxonomy)
 *
 * Collision guard: writes are serialised through an in-process promise queue
 * so two rapid Team Room posts cannot race and lose each other's content.
 * Each write also reads the existing trigger file before writing, so any
 * content the autosave watcher has not yet drained is merged rather than
 * overwritten.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getUserDb } from '../db';
import { sql } from 'drizzle-orm';
import { workspaceResolution } from './workspace-root';
import { rollingEpisodeNameFromTitle } from './episode-gap-projection';

const WORKSPACE    = workspaceResolution.root;
const TRIGGER_PATH = join(WORKSPACE, '.local', '.episode_append');

// ---------------------------------------------------------------------------
// In-process write queue — serialises safeWriteTrigger calls so two rapid
// Team Room posts cannot interleave their read-modify-write sequences.
// ---------------------------------------------------------------------------

let _writeQueue: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Rolling episode cache — one DB round-trip per minute, not per message
// ---------------------------------------------------------------------------

interface RollingEpisodeCache {
  /** Episode name without .md suffix, e.g. "episode-27". null = no active rolling episode. */
  name: string | null;
  expiresAt: number;
}

let _cache: RollingEpisodeCache | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Look up the current rolling episode from the DB.
 * Returns the episode name without .md suffix (e.g. "episode-27"), or null.
 * Cached for 60 s so rapid Team Room messages share one DB query.
 *
 * Exported so sibling hooks (chat-episode-hook, etc.) can reuse the same
 * shared cache without duplicating the DB query or the cache state.
 */
export async function getRollingEpisodeName(): Promise<string | null> {
  const now = Date.now();
  if (_cache && now < _cache.expiresAt) return _cache.name;

  try {
    const db   = getUserDb();
    const rows = await db.execute(sql`
      SELECT title FROM conversation_memories
      WHERE arc_name = 'HolaHola Episodes'
        AND 'rolling' = ANY(tags)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = (rows as any).rows?.[0] ?? (rows as any)[0];
    let name: string | null = null;
    if (row?.title) {
      // The same mapping as the projection, so a subtitled rolling title
      // ("Episode 35: Alden's Entry into the Record") is still episode-35.
      name = rollingEpisodeNameFromTitle(row.title as string);
    }
    _cache = { name, expiresAt: now + CACHE_TTL_MS };
    return name;
  } catch (err: any) {
    console.error('[TeamRoomEpisodeHook] Failed to look up rolling episode:', err.message);
    return null;
  }
}

/**
 * Invalidate the rolling episode cache.
 * Call after creating a new episode or changing the "rolling" tag on any row.
 */
export function invalidateRollingEpisodeCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Collision-safe trigger file writer
// ---------------------------------------------------------------------------

/**
 * Write (or merge into) the episode append trigger file.
 *
 * Calls are serialised through an in-process promise queue so that two
 * concurrent invocations cannot interleave their read-modify-write sequences.
 * If the file already contains a non-empty JSON payload that the autosave
 * watcher has not yet consumed, the new exchange is merged into the existing
 * exchange string (blank-line separator) rather than overwriting it.
 *
 * Returns a Promise that resolves once the write is complete, so callers that
 * need ordered guarantees can await it.  The production route caller ignores
 * the return value (fire-and-forget).
 *
 * @param exchange    Formatted exchange text (e.g. "**LUCA [HolaHola]:** …")
 * @param episodeName Episode name without .md suffix (e.g. "episode-27")
 * @param triggerPath Override the trigger file path (defaults to TRIGGER_PATH).
 *                    Injected by tests so the production logic runs against a
 *                    temp file rather than the live workspace file.
 */
export function safeWriteTrigger(
  exchange: string,
  episodeName: string,
  triggerPath: string = TRIGGER_PATH,
): Promise<void> {
  const task = (): void => {
    try {
      let priorExchange = '';

      if (existsSync(triggerPath)) {
        const raw = readFileSync(triggerPath, 'utf-8').trim();
        if (raw && raw.startsWith('{')) {
          try {
            const prior = JSON.parse(raw) as { exchange?: string; episode?: string };
            if (prior.exchange) priorExchange = prior.exchange.trimEnd();
          } catch {
            // Corrupted / partial write — treat as empty; new exchange wins
          }
        }
      }

      const finalExchange = priorExchange
        ? priorExchange + '\n\n' + exchange
        : exchange;

      const payload = JSON.stringify({ exchange: finalExchange, episode: episodeName });
      writeFileSync(triggerPath, payload, 'utf-8');
      console.log(
        `[TeamRoomEpisodeHook] ✓ Trigger written → ${triggerPath}` +
        ` (${exchange.length} chars, merged: ${!!priorExchange}, episode: ${episodeName})`,
      );
    } catch (err: any) {
      console.error('[TeamRoomEpisodeHook] Failed to write trigger file:', err.message);
    }
  };

  // Chain through the shared queue — even if the prior task threw, this one runs
  _writeQueue = _writeQueue.then(task, task);
  return _writeQueue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call fire-and-forget from the Team Room message handler after Luca posts a
 * message.  Checks for an active rolling episode; if one exists, the message
 * is appended to the trigger file with "LUCA [HolaHola]:" attribution so the
 * autosave watcher picks it up (< 20 s) and writes it into the episode .md
 * and DB.
 */
export async function maybeAppendTeamRoomMessage(
  content: string,
  episodeNameForTest?: string,
  triggerPathForTest?: string,
): Promise<void> {
  try {
    const episodeName = episodeNameForTest ?? await getRollingEpisodeName();
    if (!episodeName) return; // No rolling episode active — nothing to do

    // Canonical attribution label per episode source taxonomy.
    // safeWriteTrigger enqueues the write and returns immediately; the queue
    // ensures concurrent calls are serialised.
    const exchange = `**LUCA [HolaHola]:** ${content.trim()}`;
    await safeWriteTrigger(exchange, episodeName, triggerPathForTest);
  } catch (err: any) {
    console.error('[TeamRoomEpisodeHook] Unexpected error:', err.message);
  }
}

/**
 * Append a pre-formatted delegation exchange to the rolling episode.
 *
 * Called by luca-delegation.ts after the full delegation loop completes.
 * The exchange string already contains both Luca's task and Alden's response
 * with canonical attribution labels — this function only resolves the
 * active episode and writes the trigger file.
 *
 * Returns the episode name that was written to, or null if no rolling episode
 * is active (so callers can include it in their result metadata).
 *
 * Race guard: delegation calls are infrequent but Alden can take several
 * seconds to respond. A new rolling episode may be activated in that window.
 * To avoid the 60-second stale-null-cache drop, the cache is always
 * invalidated before the lookup so a fresh DB query is guaranteed.
 *
 * @param exchange    Formatted exchange text with attribution labels.
 * @param triggerPath Override the trigger file path (defaults to TRIGGER_PATH).
 *                    Injected by tests so the production logic runs against a
 *                    temp file rather than the live workspace file.
 */
export async function maybeAppendDelegationExchange(
  exchange: string,
  triggerPath: string = TRIGGER_PATH,
): Promise<string | null> {
  try {
    // Always invalidate before lookup — delegation exchanges are infrequent
    // (one per Alden call) so the extra DB round-trip is negligible. This
    // eliminates the 60-second window where a newly-activated episode would
    // be missed if the cache was primed as null before the episode started.
    invalidateRollingEpisodeCache();
    const episodeName = await getRollingEpisodeName();
    if (!episodeName) return null; // No rolling episode active

    await safeWriteTrigger(exchange.trim(), episodeName, triggerPath);
    return episodeName;
  } catch (err: any) {
    console.error('[TeamRoomEpisodeHook] maybeAppendDelegationExchange error:', err.message);
    return null;
  }
}
