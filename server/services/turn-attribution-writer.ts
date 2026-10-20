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
 * provider-/model- tags for search (design section 4, "bones"). One evidenced
 * model and vendor across every assistant run gives model-<m> and
 * provider-<p>; no evidenced model gives the explicit unknown tags. Several
 * different models in one row get no single model tag at all: picking one
 * would misattribute the rest, and per-run detail is in the attribution column.
 */
function modelTagsFor(verified: Record<string, unknown>[]): string[] {
  const runs = verified.flatMap(p => (p.runs as Array<Record<string, unknown>>) ?? []);
  const models = new Set(runs.map(r => String(r.model)));
  const providers = new Set(runs.map(r => String(r.provider)));
  if (runs.length === 0 || (models.size === 1 && models.has('unknown'))) return ['provider-unknown', 'model-unknown'];
  if (models.size === 1 && providers.size === 1) {
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
  const verifiedProvenance: Record<string, unknown>[] = [];
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
      verifiedProvenance.push(provenance);
    }
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
  return { content, attribution: { turnAttribution }, modelTags: modelTagsFor(verifiedProvenance) };
}
