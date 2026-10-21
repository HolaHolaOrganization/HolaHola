/**
 * Build section 3.1 provenance for a Claude Code assistant turn
 * (attribution design f5d77712, revision 9a294bc3).
 *
 * Input: the transcript's assistant entries for the turn, in order, as
 * { text, model }, where text is that entry's `type: "text"` blocks joined
 * with "\n\n" exactly as .claude/hooks/record-stop-turn.mjs extracts them.
 * The hook's assistantText is those non-empty texts joined with "\n\n" and
 * then trimmed; offsets here are computed on exactly those bytes.
 *
 * Output provenance is self-checked with the step-4 verifier. If it would
 * not verify, null is returned: no provenance is better than invalid
 * provenance, and the turn's model is then simply unknown.
 */
import { createHash } from 'node:crypto';
import { MAX_ATTRIBUTED_RUNS, MODEL_PATTERN, verifyProvenance } from './canonical-attribution';
import { MODEL_VENDOR_MAP_V1_EVIDENCE, vendorForModelV1 } from './model-vendor-map';

export interface TranscriptSegment {
  text: string;
  model: unknown;
}

const SEPARATOR = '\n\n';
const CLAUDE_CODE_MODEL_EVIDENCE = 'claude-code-transcript:message.model';
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The exact assistantText the Stop hook sends for these segments. */
export function flattenAssistantText(segments: readonly TranscriptSegment[]): string {
  return segments.map(s => s.text).filter(Boolean).join(SEPARATOR).trim();
}

interface Attribution { model: string; modelEvidence: string; provider: string; providerEvidence: string }

function attributionFor(model: unknown): Attribution {
  if (typeof model !== 'string' || model.length === 0) {
    return { model: 'unknown', modelEvidence: 'none', provider: 'unknown', providerEvidence: 'none' };
  }
  if (!MODEL_PATTERN.test(model)) {
    return { model: 'unknown', modelEvidence: 'invalid', provider: 'unknown', providerEvidence: 'none' };
  }
  const vendor = vendorForModelV1(model);
  return vendor
    ? { model, modelEvidence: CLAUDE_CODE_MODEL_EVIDENCE, provider: vendor, providerEvidence: MODEL_VENDOR_MAP_V1_EVIDENCE }
    : { model, modelEvidence: CLAUDE_CODE_MODEL_EVIDENCE, provider: 'unknown', providerEvidence: 'none' };
}

const sameAttribution = (a: Attribution, b: Attribution) =>
  a.model === b.model && a.modelEvidence === b.modelEvidence && a.provider === b.provider && a.providerEvidence === b.providerEvidence;

/**
 * Build provenance for the claude-code hat. Returns the assistantText it is
 * bound to, and the provenance or null if none can be honestly built.
 */
export function buildClaudeCodeProvenance(segments: readonly TranscriptSegment[]): { assistantText: string; provenance: Record<string, unknown> | null } {
  const kept = segments.filter(s => s.text);
  const full = kept.map(s => s.text).join(SEPARATOR);
  const assistantText = full.trim();
  if (!assistantText) return { assistantText, provenance: null };
  const lead = full.length - full.trimStart().length;

  // Character ranges of each segment within `full`; the separator before a
  // segment belongs to that (following) segment (design 3.1 contiguity).
  const pieces: { start: number; end: number; attribution: Attribution }[] = [];
  let pos = 0;
  kept.forEach((segment, i) => {
    const start = i === 0 ? 0 : pos;
    pos += (i === 0 ? 0 : SEPARATOR.length) + segment.text.length;
    // Map into the trimmed string and clamp; fully-trimmed pieces vanish.
    const s = Math.max(0, start - lead);
    const e = Math.min(assistantText.length, pos - lead);
    if (e > s) pieces.push({ start: s, end: e, attribution: attributionFor(segment.model) });
  });
  if (pieces.length === 0) return { assistantText, provenance: null };
  // Coverage must be exact: the first piece starts at 0 and the last ends at the text end.
  pieces[0].start = 0;
  pieces[pieces.length - 1].end = assistantText.length;

  // A run is consecutive pieces sharing the same attribution.
  const merged: typeof pieces = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && sameAttribution(last.attribution, piece.attribution)) last.end = piece.end;
    else merged.push({ ...piece });
  }
  // Overflow: runs 0..14 attributed, run 15 covers all remaining bytes, unattributed.
  if (merged.length > MAX_ATTRIBUTED_RUNS) {
    const tail = merged.splice(MAX_ATTRIBUTED_RUNS - 1);
    merged.push({
      start: tail[0].start,
      end: tail[tail.length - 1].end,
      attribution: { model: 'unknown', modelEvidence: 'overflow-unattributed', provider: 'unknown', providerEvidence: 'overflow-unattributed' },
    });
  }

  const encoder = new TextEncoder();
  const bytes = encoder.encode(assistantText);
  const byteAt = (charIndex: number) => encoder.encode(assistantText.slice(0, charIndex)).length;
  const provenance = {
    version: 1,
    encoding: 'utf8-bytes',
    textSha256: sha256Hex(bytes),
    runs: merged.map((run, index) => {
      const start = byteAt(run.start);
      const end = byteAt(run.end);
      return {
        index, start, end,
        rangeSha256: sha256Hex(bytes.subarray(start, end)),
        hat: 'claude-code', hatEvidence: 'capture-source',
        ...run.attribution,
      };
    }),
  };
  // Never emit provenance the readers would reject.
  return verifyProvenance(provenance, assistantText, 'claude-code').status === 'valid'
    ? { assistantText, provenance }
    : { assistantText, provenance: null };
}
