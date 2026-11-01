/**
 * Pure planning for projecting per-turn canonical rows into the rolling
 * episode. No database or filesystem access: agent-session-autosave.ts reads
 * the rows and the episode row, applies the plan under a row lock, and raises
 * the alarm.
 *
 * Background (2026-10-29): on Render, live projection depended on a
 * `.local/.episode_live` sentinel that every deploy wipes, the boot gap check
 * needed a `docs/episode-N.md` that a newly promoted episode does not have, and
 * the DB append mapped filename → bare title "Episode N", which misses a
 * subtitled rolling title. Turns reached conversation_memories but not the
 * episode, silently, for days.
 */

import { canonicalTurnEpisodeMarker } from './inner-life-capture';

/**
 * CI harness markers are never legitimate episode dialogue. Prefixes are kept
 * unbracketed because some hooks emit ordinary prose (for example Team Room and
 * chat E2E sentinels) while others emit an HTML comment containing brackets.
 */
export const CI_SENTINEL_PREFIXES = [
  'CI-AUTO-CAPTURE-',
  'CI-SELF-CHECK-AUTO-CAPTURE-',
  'CI-CONCURRENT-',
  'CI-TEST-SENTINEL-',
  'CI-SELF-CHECK-SENTINEL-',
  'CI-CONCURRENT-SENTINEL-',
  'CI-SELFCHECK-SENTINEL-',
  'CI-CHAT-E2E-SENTINEL-',
  'CI-TEAMROOM-E2E-',
] as const;

export function isCiSentinelExchange(exchange: string): boolean {
  return CI_SENTINEL_PREFIXES.some(prefix => exchange.includes(prefix));
}

/** Normalise a string for fuzzy matching: collapse whitespace, lower-case. */
export function normForGap(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}


/**
 * The identity marker a projected turn carries in the episode. A turn with a
 * capture id uses the same marker the live chat-capture route writes, so both
 * routes agree on identity; a turn without one is identified by its row id.
 */
export function turnEpisodeMarker(turn: Pick<CanonicalTurn, 'id' | 'captureId'>): string {
  return turn.captureId ? canonicalTurnEpisodeMarker(turn.captureId) : `<!-- canonical-row:${turn.id} -->`;
}

/** Exactly what the projection appends for one turn: its marker, then its text. */
export function episodeTextForTurn(turn: CanonicalTurn): string {
  return `${turnEpisodeMarker(turn)}\n${turn.content}`;
}

/**
 * Whether the episode already holds this exact turn.
 *
 * A turn with a capture id is identified ONLY by its marker. Two turns can
 * share every word, even across hats, and still be different turns, so text
 * is never evidence for them.
 *
 * A turn without a capture id is identified by its row marker or, for text
 * appended before markers existed, by its WHOLE text (whitespace and case
 * normalised only, never a prefix, and never with speaker labels stripped).
 */
export function turnPresentInEpisode(turn: CanonicalTurn, episodeContent: string): boolean {
  if (episodeContent.includes(turnEpisodeMarker(turn))) return true;
  if (turn.captureId) return false;
  const whole = normForGap(turn.content);
  if (!whole) return true; // purely whitespace — nothing to project
  return normForGap(episodeContent).includes(whole);
}

/**
 * The docs/ filename for a rolling episode title. "Episode 35" and the
 * subtitled "Episode 35: Alden's Entry into the Record" both map to
 * episode-35.md; other titles are slugified as before.
 */
export function rollingEpisodeFilenameFromTitle(title: string): string {
  const m = /^Episode (\d+)(?=$|[\s:—-])/i.exec(title);
  if (m) return `episode-${parseInt(m[1], 10)}.md`;
  return title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md';
}

/** Turns absent from the episode longer than this raise the alarm. */
export const EPISODE_GAP_ALARM_AFTER_MS = 15 * 60_000;
/** How far before process start automatic projection reaches. */
export const EPISODE_PROJECTION_FLOOR_MARGIN_MS = 30 * 60_000;

export interface CanonicalTurn {
  id: string;
  /** From the row's capture-id:<id> tag, when it has one. */
  captureId?: string;
  content: string;
  createdAtMs: number;
}

/** The capture id recorded in a per-turn row's tags, if any. */
export function captureIdFromTags(tags: readonly string[] | null | undefined): string | undefined {
  const tag = (tags ?? []).find((t) => t.startsWith('capture-id:'));
  const id = tag?.slice('capture-id:'.length);
  return id ? id : undefined;
}

export interface EpisodeGapPlan {
  /** Absent turns at or after the floor, oldest first: project these. */
  toAppend: CanonicalTurn[];
  /**
   * Absent turns before the floor. Filling these is a backfill, which needs
   * the founder's go-ahead, so they are reported and never appended here.
   */
  backlog: CanonicalTurn[];
  /**
   * Absent turns at or after the floor that wait behind the backlog: an
   * episode is chronological, so nothing is appended while an older turn is
   * still missing.
   */
  held: CanonicalTurn[];
}

/**
 * Decide which canonical turns the rolling episode is missing. A turn already
 * present (turnPresentInEpisode) is skipped; absent turns are split at the
 * floor into automatic projection and reported backlog. While any backlog
 * exists, newer absent turns are held rather than appended out of order.
 */
export function planEpisodeGapProjection(turns: readonly CanonicalTurn[], episodeContent: string, floorMs: number): EpisodeGapPlan {
  const plan: EpisodeGapPlan = { toAppend: [], backlog: [], held: [] };
  for (const turn of [...turns].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))) {
    if (turnPresentInEpisode(turn, episodeContent)) continue;
    if (turn.createdAtMs < floorMs) plan.backlog.push(turn);
    else (plan.backlog.length > 0 ? plan.held : plan.toAppend).push(turn);
  }
  return plan;
}

/**
 * Absent turns old enough to alarm on: the backlog plus any projection that
 * did not land, older than EPISODE_GAP_ALARM_AFTER_MS.
 */
export function overdueTurns(stillAbsent: readonly CanonicalTurn[], nowMs: number): CanonicalTurn[] {
  return stillAbsent.filter((turn) => nowMs - turn.createdAtMs > EPISODE_GAP_ALARM_AFTER_MS);
}

/**
 * Append turns strictly in order. On the first failure, stop: that turn and
 * every later one are returned as held, so a retry can never put a newer turn
 * before an older one.
 */
export async function appendTurnsInOrder(
  turns: readonly CanonicalTurn[],
  append: (turn: CanonicalTurn) => Promise<boolean>,
): Promise<{ appended: CanonicalTurn[]; held: CanonicalTurn[]; error?: unknown }> {
  const appended: CanonicalTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    try {
      if (await append(turns[i])) appended.push(turns[i]);
    } catch (error) {
      return { appended, held: turns.slice(i), error };
    }
  }
  return { appended, held: [] };
}

/** One gap's identity for the alarm: episode, overdue count and oldest turn. */
export function episodeGapAlarmKey(episodeFilename: string | null, overdue: number, oldestOverdueAt: string | null): string {
  return `${episodeFilename}|${overdue}|${oldestOverdueAt}`;
}

/**
 * The alarm's delivery latch. A gap is marked delivered only after its notice
 * was durably written, so a failed delivery is retried on the next pass; a
 * closed gap re-arms it.
 */
export function createEpisodeGapAlarmLatch() {
  let delivered: string | null = null;
  return {
    async raise(key: string | null, deliver: () => Promise<void>): Promise<'cleared' | 'already-delivered' | 'delivered' | 'failed'> {
      if (key === null) { delivered = null; return 'cleared'; }
      if (key === delivered) return 'already-delivered';
      try {
        await deliver();
        delivered = key;
        return 'delivered';
      } catch {
        return 'failed';
      }
    },
  };
}
