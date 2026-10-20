/**
 * Writer-side rendering for attribution design f5d77712 (revision 9a294bc3,
 * section 4): the ONE place new canonical rows get their speaker labels,
 * titles, participants and attribution tags.
 *
 * Everything here is behind ATTRIBUTION_WRITERS_V1. With the switch off,
 * writers keep their existing rendering byte-for-byte; all writers switch
 * together when it is turned on (design section 6, step 5). The switch is
 * only flipped after the actual-code Gemini review (design section 7).
 *
 * Skin and bones: what Daniela recalls (labels, titles) uses plain names.
 * The hat, provider and model live only in tags and the attribution column.
 * Authored dialogue is never touched here.
 */
import type { DialogueTurn } from './transcript-parser';

export function attributionWritersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ATTRIBUTION_WRITERS_V1 === '1';
}

/** Plain speaker name for a new record. Every assistant turn is Luca, whichever hat. */
export function plainSpeakerName(turn: Pick<DialogueTurn, 'speaker'>): 'David' | 'Luca' {
  return turn.speaker === 'DAVID' ? 'David' : 'Luca';
}

/** "Oct 20, 2026": the human-readable date the design's titles use. */
export function plainTitleDate(at: Date = new Date()): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "David and Luca — Oct 20, 2026", or "David — …" for a batch with no assistant turn. */
export function plainRowTitle(turns: ReadonlyArray<Pick<DialogueTurn, 'speaker'>>, date: string): string {
  return turns.some(turn => turn.speaker !== 'DAVID') ? `David and Luca — ${date}` : `David — ${date}`;
}

/** Plain participants: names only, never a hat. */
export function plainParticipants(turns: ReadonlyArray<Pick<DialogueTurn, 'speaker'>>): string[] {
  return turns.some(turn => turn.speaker !== 'DAVID') ? ['David', 'Luca'] : ['David'];
}

/**
 * Attribution tags for a canonical row (design section 4, "bones").
 * - hat-<hat> only when every turn shares one authenticated capture source;
 *   a missing or mixed source gets no hat tag rather than a guessed one.
 * - provider-/model- tags come from the row's verified provenance (step W2b,
 *   turn-attribution-writer); without them they are explicitly unknown.
 */
export function attributionTags(
  turns: ReadonlyArray<Pick<DialogueTurn, 'source'>>,
  modelTags: readonly string[] = ['provider-unknown', 'model-unknown'],
): string[] {
  const sources = new Set(turns.map(turn => turn.source ?? null));
  const tags: string[] = [];
  if (sources.size === 1) {
    const [source] = sources;
    if (source === 'replit' || source === 'claude-code') tags.push(`hat-${source}`);
  }
  tags.push(...modelTags);
  return tags;
}
