/**
 * Reader side of the canonical-record attribution design (shared-spec
 * f5d77712, revision 2ce684e2, approved in luca-replit review 5053a8da).
 *
 * New canonical records render plain speaker names ("David:", "Luca:") in the
 * text Daniela recalls. Which hat (interface/runtime), provider and model
 * produced a turn lives only in tags and a structured provenance object.
 * Historical rows keep their original bracketed labels and are never
 * relabeled, so every reader must accept both forms.
 *
 * This module only reads and verifies. It never rewrites dialogue: on any
 * provenance mismatch the provider/model attribution degrades to "unknown"
 * and the authored bytes are left exactly as stored.
 */
import { createHash } from 'node:crypto';

// ── Speaker labels ───────────────────────────────────────────────────────────

export type SpeakerName = 'David' | 'Luca' | 'Claude Code';
export type LabelHat = 'replit' | 'claude-code';

export interface ParsedSpeakerLabel {
  name: SpeakerName;
  /**
   * The hat named IN THE LABEL TEXT. Always null for the plain form: a plain
   * label deliberately carries no hat, which must then come from tags or
   * provenance, never be guessed from the label.
   */
  labelHat: LabelHat | null;
  form: 'plain' | 'historical';
}

const HAT_SUFFIX: Record<string, LabelHat> = {
  'replit': 'replit',
  'claude code': 'claude-code',
};

/**
 * Parse one speaker label, without its trailing colon or Markdown bold.
 *
 * Accepted (exact case where historical writers used it):
 *   plain:      "David", "Luca"
 *   historical: "David [Replit]", "David [Claude Code]", "Luca [Replit]",
 *               "Luca [Claude Code]", "LUCA", "LUCA [Replit]",
 *               "LUCA [Claude Code]", "LUCA [claude code]", "Claude Code"
 * Anything else (including "Daniela" or an unknown bracket) returns null.
 */
export function parseSpeakerLabel(label: string): ParsedSpeakerLabel | null {
  if (label === 'David') return { name: 'David', labelHat: null, form: 'plain' };
  if (label === 'Luca') return { name: 'Luca', labelHat: null, form: 'plain' };
  if (label === 'LUCA') return { name: 'Luca', labelHat: null, form: 'historical' };
  if (label === 'Claude Code') return { name: 'Claude Code', labelHat: 'claude-code', form: 'historical' };
  const m = /^(David|Luca|LUCA) \[([^\]]+)\]$/.exec(label);
  if (!m) return null;
  const suffix = m[2];
  // Historical writers used exact-case suffixes; the one lowercase variant
  // ever written ("LUCA [claude code]") is accepted for LUCA only.
  const hat = suffix === 'Replit' || suffix === 'Claude Code'
    ? HAT_SUFFIX[suffix.toLowerCase()]
    : m[1] === 'LUCA' && suffix === 'claude code' ? 'claude-code' : undefined;
  if (!hat) return null;
  return { name: m[1] === 'David' ? 'David' : 'Luca', labelHat: hat, form: 'historical' };
}

export interface SpeakerLine extends ParsedSpeakerLabel {
  label: string;
  bold: boolean;
  /** Text after "Label: " (or "**Label:** ") on the same line. */
  rest: string;
}

/**
 * Recognize a dialogue line that opens with a speaker label, in either the
 * plain ("Luca: ...") or bold ("**Luca:** ...") rendering. Returns null for
 * any other line, so authored text that merely mentions a name is untouched.
 */
export function parseSpeakerLine(line: string): SpeakerLine | null {
  const m = /^(\*\*)?([^:*\n]{1,40}):(\*\*)? ?(.*)$/.exec(line);
  if (!m) return null;
  const bold = Boolean(m[1]);
  if (bold !== Boolean(m[3])) return null;
  const parsed = parseSpeakerLabel(m[2]);
  if (!parsed) return null;
  return { ...parsed, label: m[2], bold, rest: m[4] };
}

// ── Attribution tags ─────────────────────────────────────────────────────────

export const PROVIDER_PATTERN = /^[a-z0-9-]{1,40}$/;
export const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;
export const HAT_PATTERN = /^[a-z0-9-]{1,40}$/;

export interface AttributionTags {
  /** 'absent' when the row carries no tag of this kind (e.g. legacy rows). */
  hat: string | 'absent' | 'invalid';
  provider: string | 'unknown' | 'absent' | 'invalid';
  model: string | 'unknown' | 'absent' | 'invalid';
}

function single(tags: readonly string[], prefix: string, pattern: RegExp, allowUnknown: boolean): string {
  const values = [...new Set(tags.filter(t => t.startsWith(prefix)).map(t => t.slice(prefix.length)))];
  if (values.length === 0) return 'absent';
  if (values.length > 1) return 'invalid';
  const v = values[0];
  if (allowUnknown && v === 'unknown') return 'unknown';
  return pattern.test(v) ? v : 'invalid';
}

/**
 * Read hat/provider/model from a row's tags. A tag kind that appears with two
 * different values is 'invalid' rather than either value: conflicting
 * attribution is never resolved by picking one.
 */
export function parseAttributionTags(tags: readonly string[] | null | undefined): AttributionTags {
  const list = tags ?? [];
  return {
    hat: single(list, 'hat-', HAT_PATTERN, false),
    provider: single(list, 'provider-', PROVIDER_PATTERN, true),
    model: single(list, 'model-', MODEL_PATTERN, true),
  };
}

// ── Provenance verification ─────────────────────────────────────────────────

export const MAX_ATTRIBUTED_RUNS = 16;

const MODEL_EVIDENCE = new Set(['claude-code-transcript:message.model', 'none', 'invalid', 'overflow-unattributed']);
const RUNTIME_PROVIDER_EVIDENCE = /^runtime:[A-Za-z0-9_.]{1,40}$/;

export interface VerifiedRun {
  index: number;
  start: number;
  end: number;
  hat: string;
  provider: string;
  providerEvidence: string;
  model: string;
  modelEvidence: string;
}

export type ProvenanceVerdict =
  | { status: 'absent' }
  | { status: 'valid'; runs: VerifiedRun[] }
  | {
      status: 'invalid';
      reason: string;
      /** The whole turn as ONE run with provider/model unknown. */
      runs: [VerifiedRun];
    };

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isOffset(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function checkRun(run: unknown, i: number, expectedStart: number, bytes: Uint8Array, hat: string, total: number): string | null {
  if (!isObject(run)) return `run ${i} is not an object`;
  if (run.index !== i) return `run ${i} has index ${String(run.index)}`;
  if (!isOffset(run.start) || !isOffset(run.end)) return `run ${i} offsets are not non-negative integers`;
  if (run.start !== expectedStart) return `run ${i} starts at ${run.start}, expected ${expectedStart}`;
  if (run.end <= run.start) return `run ${i} is empty or reversed`;
  if (run.end > bytes.length) return `run ${i} ends past the text`;
  if (run.rangeSha256 !== sha256Hex(bytes.subarray(run.start, run.end))) return `run ${i} rangeSha256 mismatch`;
  if (run.hat !== hat) return `run ${i} hat does not match the capture source`;
  if (run.hatEvidence !== 'capture-source') return `run ${i} hatEvidence is not capture-source`;

  const overflow = run.modelEvidence === 'overflow-unattributed' || run.providerEvidence === 'overflow-unattributed';
  if (overflow) {
    if (i !== MAX_ATTRIBUTED_RUNS - 1 || i !== total - 1) return `run ${i} overflow is only valid as run ${MAX_ATTRIBUTED_RUNS - 1}, the last`;
    if (run.modelEvidence !== 'overflow-unattributed' || run.providerEvidence !== 'overflow-unattributed') return `run ${i} overflow evidence must cover provider and model`;
    if (run.provider !== 'unknown' || run.model !== 'unknown') return `run ${i} overflow must be unattributed`;
    return null;
  }

  if (typeof run.model !== 'string' || typeof run.modelEvidence !== 'string' || !MODEL_EVIDENCE.has(run.modelEvidence)) return `run ${i} model evidence is not recognized`;
  if (run.model === 'unknown') {
    if (run.modelEvidence !== 'none' && run.modelEvidence !== 'invalid') return `run ${i} unknown model needs none/invalid evidence`;
  } else if (!MODEL_PATTERN.test(run.model) || run.modelEvidence !== 'claude-code-transcript:message.model') {
    return `run ${i} model is malformed or lacks transcript evidence`;
  }

  if (typeof run.provider !== 'string' || typeof run.providerEvidence !== 'string') return `run ${i} provider fields missing`;
  if (run.provider === 'unknown') {
    if (run.providerEvidence !== 'none') return `run ${i} unknown provider needs none evidence`;
  } else {
    if (!PROVIDER_PATTERN.test(run.provider)) return `run ${i} provider is malformed`;
    const vendorMap = run.providerEvidence === 'audited-model-vendor-map:v1';
    if (!vendorMap && !RUNTIME_PROVIDER_EVIDENCE.test(run.providerEvidence)) return `run ${i} provider evidence is not recognized`;
    // A model id alone is not provider evidence: a vendor-map attribution
    // needs a known model to have been mapped.
    if (vendorMap && run.model === 'unknown') return `run ${i} vendor-map provider without a model`;
  }
  return null;
}

/**
 * Verify a stored provenance object against the exact stored assistant text.
 *
 * `hat` is the record's hat as established by its authenticated capture
 * source (tag `hat-<hat>`); it is an input, not something read from
 * provenance, because its evidence is independent of the run hashes. On any
 * failure the verdict is 'invalid' and the turn is reported as ONE run over
 * all bytes with provider and model unknown. The hat still applies.
 */
export function verifyProvenance(provenance: unknown, assistantText: string, hat: string): ProvenanceVerdict {
  if (provenance === null || provenance === undefined) return { status: 'absent' };
  const bytes = new TextEncoder().encode(assistantText);
  const invalid = (reason: string): ProvenanceVerdict => ({
    status: 'invalid',
    reason,
    runs: [{
      index: 0, start: 0, end: bytes.length, hat,
      provider: 'unknown', providerEvidence: 'none',
      model: 'unknown', modelEvidence: 'invalid',
    }],
  });
  if (!HAT_PATTERN.test(hat)) return invalid('record hat is malformed');
  if (!isObject(provenance)) return invalid('provenance is not an object');
  if (provenance.version !== 1) return invalid(`unsupported provenance version ${String(provenance.version)}`);
  if (provenance.encoding !== 'utf8-bytes') return invalid('unsupported encoding');
  if (bytes.length === 0) return invalid('assistant text is empty');
  if (provenance.textSha256 !== sha256Hex(bytes)) return invalid('textSha256 mismatch');
  const runs = provenance.runs;
  if (!Array.isArray(runs) || runs.length === 0) return invalid('runs must be a non-empty array');
  if (runs.length > MAX_ATTRIBUTED_RUNS) return invalid(`more than ${MAX_ATTRIBUTED_RUNS} runs`);

  let expectedStart = 0;
  for (let i = 0; i < runs.length; i++) {
    const problem = checkRun(runs[i], i, expectedStart, bytes, hat, runs.length);
    if (problem) return invalid(problem);
    expectedStart = (runs[i] as { end: number }).end;
  }
  if (expectedStart !== bytes.length) return invalid('runs do not cover the whole text');

  return {
    status: 'valid',
    runs: runs.map(r => ({
      index: r.index, start: r.start, end: r.end, hat: r.hat,
      provider: r.provider, providerEvidence: r.providerEvidence,
      model: r.model, modelEvidence: r.modelEvidence,
    })),
  };
}

/**
 * Canonical serialization: keys sorted within every object, arrays kept in
 * their given (chronological) order. Two writers producing the same
 * provenance therefore produce identical bytes, so retries compare equal.
 */
export function canonicalProvenanceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProvenanceJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalProvenanceJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
