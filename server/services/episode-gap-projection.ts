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

/** Normalise a string for fuzzy matching: collapse whitespace, lower-case. */
export function normForGap(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strip markdown bold markers (**) and speaker role-label brackets after LUCA
 * (e.g. [Replit], [HolaHola], [steward], [observe]) so DB-format "Luca: text"
 * matches .md "**LUCA [Replit]:** text" or "**LUCA [HolaHola]:** text".
 *
 * Only the role bracket immediately after "luca" is stripped — channel labels
 * like [felt], [thinking], [moment] appear after the colon (in content) and
 * are left untouched.
 */
export function stripMdForGap(s: string): string {
  return s.replace(/\*\*/g, '').replace(/\bluca\s*\[[^\]]+\]/gi, 'luca');
}

/**
 * Return true when exchangeText is present in the normalised episode content.
 *
 * Strategy: normalise the full exchange block (collapse whitespace, lower-case)
 * and search for its first 60 chars in mdNorm.  60 chars is long enough to be
 * unique in any real conversation while being short enough to survive minor
 * line-break differences between the DB row and the episode copy.  Short
 * exchanges (< 60 chars) are matched in full — no minimum-length threshold that
 * would silently skip brief utterances.
 *
 * Falls back to a bold-stripped comparison so DB rows stored as "David: text"
 * still match lines formatted as "**David:** text".
 *
 * NOTE: The identical matcher lives in test-rolling-episode-gap-check.ts.
 * Keep both in sync whenever this logic changes.
 */
export function exchangeInMd(exchangeText: string, mdNorm: string): boolean {
  const normalised = normForGap(exchangeText);
  if (!normalised) return true; // purely whitespace — treat as present (skip)
  const key = normalised.slice(0, 60);
  if (mdNorm.includes(key)) return true;
  // Fallback: strip ** so "david: text" matches "**david:** text"
  return stripMdForGap(mdNorm).includes(stripMdForGap(key));
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
  content: string;
  createdAtMs: number;
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
 * present (by the gap matcher) is skipped; absent turns are split at the
 * floor into automatic projection and reported backlog. While any backlog
 * exists, newer absent turns are held rather than appended out of order.
 */
export function planEpisodeGapProjection(turns: readonly CanonicalTurn[], episodeContent: string, floorMs: number): EpisodeGapPlan {
  const norm = normForGap(episodeContent);
  const plan: EpisodeGapPlan = { toAppend: [], backlog: [], held: [] };
  for (const turn of [...turns].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))) {
    if (exchangeInMd(turn.content, norm)) continue;
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
