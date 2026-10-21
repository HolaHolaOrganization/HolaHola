/**
 * Writer side of section 3.3 per-turn attribution for canonical exchange rows
 * (attribution design f5d77712, revision 9a294bc3). Used only when
 * ATTRIBUTION_WRITERS_V1 is on.
 *
 * Builds a row's content in exact 3.3 framing (label + body, "\n\n" between
 * turns, nothing after the last body) together with its turnAttribution, and
 * self-checks the result with the step-4 reader. Returns null whenever a turn
 * cannot be framed honestly (no durable capture id or source, a duplicated
 * entry key, or a failed self-check); the caller then writes the row exactly
 * as before, without per-turn attribution, which readers treat as legacy.
 */
import { createHash } from 'node:crypto';
import { canonicalProvenanceJson, verifyProvenance } from './canonical-attribution';
import { formatChatCaptureSpeakerLabel, type DialogueTurn } from './transcript-parser';
import { verifyTurnAttribution } from './turn-attribution';

export type AttributableTurn = Pick<DialogueTurn, 'speaker' | 'text' | 'captureId' | 'source' | 'provenance'>;

const SEPARATOR = '\n\n';
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface CanonicalRowAttribution {
  content: string;
  attribution: { turnAttribution: Record<string, unknown> };
  /** provider-/model- tags evidenced by the turns' verified provenance. */
  modelTags: string[];
}

/**
 * provider-/model- tags for search (design section 4, "bones"), computed over
 * EVERY assistant turn in the row. A turn with absent or unverifiable
 * provenance counts as an unknown model, as does an unknown or overflow run.
 * - every assistant run has the same known model and vendor: model-<m>, provider-<p>;
 * - nothing known at all: the explicit unknown tags;
 * - anything else (several models, or known mixed with unknown): no single
 *   model tag, because one tag would attribute other authored text to a model
 *   that did not write it. Per-run detail is in the attribution column.
 */
function modelTagsFor(assistantProvenance: Array<Record<string, unknown> | null>): string[] {
  const runs = assistantProvenance.flatMap(p => p === null
    ? [{ model: 'unknown', provider: 'unknown' }]
    : (p.runs as Array<Record<string, unknown>>) ?? [{ model: 'unknown', provider: 'unknown' }]);
  const models = new Set(runs.map(r => String(r.model)));
  const providers = new Set(runs.map(r => String(r.provider)));
  if (runs.length === 0 || (models.size === 1 && models.has('unknown'))) return ['provider-unknown', 'model-unknown'];
  if (models.size === 1 && providers.size === 1 && !models.has('unknown') && !providers.has('unknown')) {
    return [`provider-${[...providers][0]}`, `model-${[...models][0]}`];
  }
  return [];
}

export function buildCanonicalRowAttribution(
  turns: readonly AttributableTurn[],
  options: { bold: boolean },
): CanonicalRowAttribution | null {
  if (turns.length === 0) return null;
  const encoder = new TextEncoder();
  const keys = new Set<string>();
  const assistantProvenance: Array<Record<string, unknown> | null> = [];
  const entries: Record<string, unknown>[] = [];
  let content = '';

  for (const [index, turn] of turns.entries()) {
    if (!turn.captureId || (turn.source !== 'replit' && turn.source !== 'claude-code')) return null;
    const frame = turn.speaker === 'DAVID' ? 'david' : 'luca';
    const key = JSON.stringify([turn.source, turn.captureId, frame]);
    if (keys.has(key)) return null;
    keys.add(key);

    const name = formatChatCaptureSpeakerLabel(turn);
    const label = options.bold ? `**${name}:** ` : `${name}: `;
    if (index > 0) content += SEPARATOR;
    const labelStart = encoder.encode(content).length;
    content += label;
    const bodyStart = encoder.encode(content).length;
    content += turn.text;
    const bodyEnd = encoder.encode(content).length;

    // Only verified provenance is written; an unverifiable one means the
    // model is unknown for this turn, never a guessed one.
    let provenance: Record<string, unknown> | null = null;
    if (frame === 'luca' && turn.provenance !== undefined
      && verifyProvenance(turn.provenance, turn.text, turn.source).status === 'valid') {
      provenance = JSON.parse(canonicalProvenanceJson(turn.provenance)) as Record<string, unknown>;
    }
    if (frame === 'luca') assistantProvenance.push(provenance);
    entries.push({
      index, kind: 'attributed', source: turn.source, sourceEventId: turn.captureId, frameKey: frame,
      labelStart, bodyStart, bodyEnd,
      speaker: frame, hat: turn.source, hatEvidence: 'capture-source',
      captureId: turn.captureId, provenance,
    });
  }

  const bytes = encoder.encode(content);
  for (const entry of entries) {
    entry.labelSha256 = sha256Hex(bytes.subarray(entry.labelStart as number, entry.bodyStart as number));
    entry.bodySha256 = sha256Hex(bytes.subarray(entry.bodyStart as number, entry.bodyEnd as number));
  }
  const turnAttribution = {
    version: 1, encoding: 'utf8-bytes', legacyPrefixEnd: 0,
    coveredEnd: bytes.length, coveredSha256: sha256Hex(bytes), separator: SEPARATOR, turns: entries,
  };
  if (verifyTurnAttribution(content, turnAttribution).status !== 'valid') return null;
  return { content, attribution: { turnAttribution }, modelTags: modelTagsFor(assistantProvenance) };
}

/**
 * Writer 1 (design 3.4): the episode-mirror event for one canonical exchange,
 * framed exactly as the canonical row frames it but with the episode's bold
 * labels. Returns null unless every turn carries the SAME durable capture id
 * and a canonical source, so one event = one (source, captureId). A batch that
 * cannot be framed is held by the caller, never appended as unframed text.
 */
export function buildCanonicalEpisodeEvent(turns: readonly AttributableTurn[]): import('./projection-append').AppendEvent | null {
  const row = buildCanonicalRowAttribution(turns, { bold: true });
  if (!row) return null;
  const entries = row.attribution.turnAttribution.turns as Record<string, unknown>[];
  const ids = new Set(entries.map(entry => `${entry.source}\u0000${entry.sourceEventId}`));
  if (ids.size !== 1) return null;
  const bytes = new TextEncoder().encode(row.content);
  const decoder = new TextDecoder();
  return {
    source: entries[0].source as string,
    sourceEventId: entries[0].sourceEventId as string,
    frames: entries.map(entry => ({
      kind: 'attributed' as const,
      frameKey: entry.frameKey as string,
      label: decoder.decode(bytes.subarray(entry.labelStart as number, entry.bodyStart as number)),
      body: decoder.decode(bytes.subarray(entry.bodyStart as number, entry.bodyEnd as number)),
      speaker: entry.speaker as 'david' | 'luca',
      hat: entry.hat as string,
      hatEvidence: entry.hatEvidence as string,
      captureId: entry.captureId as string,
      provenance: entry.provenance as Record<string, unknown> | null,
    })),
  };
}
