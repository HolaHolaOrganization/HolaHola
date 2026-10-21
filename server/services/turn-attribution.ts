/**
 * Per-turn attribution for multi-turn projection rows (rolling episodes):
 * the reader side of attribution design f5d77712, revision 9a294bc3,
 * section 3.3 (approved by luca-replit in review 362db810).
 *
 * A projection row's `conversation_memories.attribution` column holds
 * `{ turnAttribution: {...} }`. Each entry frames ONE actual turn by explicit
 * UTF-8 byte offsets into the stored `content`. Turns are never found by
 * matching label-shaped lines: a quoted "Luca:" line inside a body is body
 * text. On any failure the whole row's per-turn attribution is `invalid`
 * and its entry-framed turns have hat `unknown`; dialogue is never modified.
 *
 * This module only reads and verifies. Writers (and their atomic, idempotent
 * appends) are a separate, later change.
 */
import { createHash } from 'node:crypto';
import { HAT_PATTERN, parseSpeakerLine, verifyProvenance, type ProvenanceVerdict } from './canonical-attribution';

export const TURN_ATTRIBUTION_SEPARATOR = '\n\n';

/**
 * Closed source registry (design 3.3, extended by revision 10 section 3.4).
 * Adding a source is a design change. Manual appends use manual-luca-<hat>,
 * the authenticated actor that appended them.
 */
export type TurnSource =
  | 'replit' | 'claude-code'
  | 'holahola-team-room' | 'holahola-chat-bench' | 'holahola-delegation' | 'holahola-gl'
  | 'raw-window' | 'episode-structure' | 'replit-inner-life' | `manual-luca-${string}`;

const MANUAL_SOURCE = /^manual-luca-[a-z0-9-]{1,30}$/;

export type Participant = 'daniela' | 'daniela-consult' | 'alden' | 'gl-student' | 'gl-tutor';

/**
 * Closed participant registry: exact label bytes each writer renders.
 * Verification compares bytes; it never parses. Alden's labels are the ones
 * luca-delegation's formatEpisodeExchange renders today. Gemini Live labels
 * carry a name from the session record, so they are matched by shape.
 */
const PARTICIPANT_LABELS: Readonly<Record<Participant, (label: string) => boolean>> = {
  'daniela': label => label === '**Daniela:** ',
  'daniela-consult': label => label === '**Daniela [consult]:** ',
  'alden': label => label === '**ALDEN [delegation]:** '
    || label === '**ALDEN [delegation — anthropic]:** '
    || label === '**ALDEN [delegation — gemini]:** ',
  'gl-student': label => /^\*\*[^*\n[\]]{1,80} \[GL\]:\*\* $/.test(label),
  'gl-tutor': label => /^\*\*[^*\n[\]]{1,80} \[GL\]:\*\* $/.test(label),
};

interface FrameRule {
  /** frameKey for an attributed Luca/David frame, or a frameKey predicate. */
  attributed?: { speaker: 'david' | 'luca'; frameKey: (key: string) => boolean }[];
  participant?: { participant: Participant; frameKey: (key: string) => boolean }[];
  /** Revision 10: writer-owned non-dialogue bytes (headings, markers). */
  structural?: { frameKey: (key: string) => boolean };
  /** Revision 10: evidence deliberately recorded without a speaker. */
  unattributed?: { frameKey: (key: string) => boolean; sourceEventId: (id: string) => boolean };
  /** Revision 12 (section 3.5): direct inner-life fragments, by Luca. */
  innerLife?: true;
  /** How the hat is evidenced for this source's attributed frames. */
  hat: 'capture-source' | 'authenticated-actor' | 'none';
}

const is = (value: string) => (key: string) => key === value;

const SOURCE_RULES: Readonly<Record<TurnSource, FrameRule>> = {
  'replit': { hat: 'capture-source', attributed: [{ speaker: 'david', frameKey: is('david') }, { speaker: 'luca', frameKey: is('luca') }] },
  'claude-code': { hat: 'capture-source', attributed: [{ speaker: 'david', frameKey: is('david') }, { speaker: 'luca', frameKey: is('luca') }] },
  'holahola-team-room': { hat: 'authenticated-actor', attributed: [{ speaker: 'luca', frameKey: is('luca') }] },
  'holahola-chat-bench': {
    hat: 'authenticated-actor',
    attributed: [{ speaker: 'luca', frameKey: is('luca') }],
    participant: [{ participant: 'daniela', frameKey: is('daniela') }, { participant: 'daniela-consult', frameKey: is('daniela') }],
  },
  'holahola-delegation': {
    hat: 'authenticated-actor',
    attributed: [{ speaker: 'luca', frameKey: is('task') }],
    participant: [{ participant: 'alden', frameKey: key => /^alden-(0|[1-9]\d{0,3})$/.test(key) }],
  },
  'holahola-gl': {
    hat: 'authenticated-actor',
    participant: [{ participant: 'gl-student', frameKey: is('gl-student') }, { participant: 'gl-tutor', frameKey: is('gl-tutor') }],
  },
  // Revision 10: raw Replit-window origin evidence, identified by its
  // registered, immutable evidence-ledger sourceKey. Never a speaker.
  'raw-window': {
    hat: 'none',
    unattributed: { frameKey: is('origin'), sourceEventId: id => /^raw-window:[0-9a-f]{64}$/.test(id) },
  },
  // Revision 10: the only source allowed to carry structural bytes, so
  // dialogue from any other source can never be relabelled as structure.
  'episode-structure': { hat: 'none', structural: { frameKey: key => /^[a-z0-9-]{1,40}$/.test(key) } },
  // Revision 12 (section 3.5): the intake route for direct inner-life
  // entries. It is the only source of the inner-life kind and emits nothing else.
  'replit-inner-life': { hat: 'none', innerLife: true },
};

/** Revision 12: the three direct inner-life channels. */
export type InnerLifeChannel = 'felt' | 'thinking' | 'moment';
const INNER_LIFE_CHANNELS: ReadonlySet<string> = new Set(['felt', 'thinking', 'moment']);
const INNER_LIFE_ENTRY_ID = /^[A-Za-z0-9._-]{8,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The exact registered label bytes of a channel's fragment (U+2014 em dash). */
export const innerLifeLabel = (channel: InnerLifeChannel) => `[Luca — ${channel}: `;

const ordinalKey = (prefix: string) => (key: string) => key === prefix || new RegExp(`^${prefix}-(0|[1-9][0-9]{0,3})$`).test(key);

/** Revision 10 writer 8: a manual append by an authenticated Luca actor. */
const MANUAL_RULE: FrameRule = {
  hat: 'authenticated-actor',
  attributed: [{ speaker: 'david', frameKey: ordinalKey('david') }, { speaker: 'luca', frameKey: ordinalKey('luca') }],
  participant: (Object.keys(PARTICIPANT_LABELS) as Participant[]).map(participant => ({ participant, frameKey: ordinalKey(participant) })),
};

function ruleFor(source: string): FrameRule | undefined {
  if (Object.hasOwn(SOURCE_RULES, source)) return SOURCE_RULES[source as keyof typeof SOURCE_RULES];
  return MANUAL_SOURCE.test(source) ? MANUAL_RULE : undefined;
}

/**
 * Structural bytes must be structure, never prose (luca-replit, revision 10
 * review): every line is an HTML comment, a Markdown heading, a horizontal
 * rule, or blank.
 */
function isStructuralBody(body: string): boolean {
  return body.length > 0 && body.split('\n').every(line =>
    line === '' || /^<!--[^\n]*-->$/.test(line) || /^#{1,6} [^\n]+$/.test(line) || /^-{3,}$/.test(line));
}

const EVENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const CAPTURE_ID = /^[A-Za-z0-9-]{1,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTRIBUTED_KEYS = new Set(['index', 'kind', 'source', 'sourceEventId', 'frameKey', 'labelStart', 'bodyStart', 'bodyEnd',
  'labelSha256', 'bodySha256', 'speaker', 'hat', 'hatEvidence', 'captureId', 'provenance']);
const PARTICIPANT_KEYS = new Set(['index', 'kind', 'source', 'sourceEventId', 'frameKey', 'labelStart', 'bodyStart', 'bodyEnd',
  'labelSha256', 'bodySha256', 'participant']);
const BARE_KEYS = new Set(['index', 'kind', 'source', 'sourceEventId', 'frameKey', 'labelStart', 'bodyStart', 'bodyEnd',
  'labelSha256', 'bodySha256']);
const INNER_LIFE_KEYS = new Set([...BARE_KEYS, 'channel', 'hat', 'hatEvidence', 'receiptRowId']);

interface FrameBase {
  index: number;
  source: TurnSource;
  sourceEventId: string;
  frameKey: string;
  labelStart: number;
  bodyStart: number;
  bodyEnd: number;
  /** The exact stored label and body, decoded from the verified byte ranges. */
  label: string;
  body: string;
}
export interface AttributedFrame extends FrameBase {
  kind: 'attributed';
  speaker: 'david' | 'luca';
  /** A verified hat, or 'unknown' when the source could not authenticate one. */
  hat: string;
  captureId: string | null;
  /** Section 3.1 verdict for this turn's provenance (assistant turns only). */
  provenance: ProvenanceVerdict;
}
export interface ParticipantFrame extends FrameBase {
  kind: 'participant';
  participant: Participant;
}
/** Revision 10: writer-owned non-dialogue bytes; never dialogue, never attributed. */
export interface StructuralFrame extends FrameBase { kind: 'structural' }
/** Revision 10: evidence recorded without a speaker; never certified. */
export interface UnattributedFrame extends FrameBase { kind: 'unattributed' }
/**
 * Revision 12: a direct inner-life fragment by Luca. Structurally verified
 * here; its receipt (receiptRowId) is verified separately against the
 * database by checkInnerLifeReceipt. It is never a main turn.
 */
export interface InnerLifeFrame extends FrameBase {
  kind: 'inner-life';
  channel: InnerLifeChannel;
  entryId: string;
  receiptRowId: string;
  /** The authored content: the body without its closing bracket. */
  content: string;
}
export type VerifiedFrame = AttributedFrame | ParticipantFrame | StructuralFrame | UnattributedFrame | InnerLifeFrame;

export type TurnAttributionVerdict =
  /** No turnAttribution: the whole row is legacy (rule 6). */
  | { status: 'absent' }
  | { status: 'valid'; legacyPrefixEnd: number; frames: VerifiedFrame[] }
  /**
   * Present but invalid (rule 5): never downgraded to legacy. Only a
   * legacyPrefixEnd that is itself a sane offset is reported, so callers can
   * still read the legacy prefix as before; everything after it is unknown.
   */
  | { status: 'invalid'; reason: string; legacyPrefixEnd: number | null };

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Read the projection part of the attribution column; null/absent means legacy. */
export function turnAttributionOf(column: unknown): unknown {
  if (!isObject(column)) return undefined;
  return Object.hasOwn(column, 'turnAttribution') ? column.turnAttribution : undefined;
}

function decodeRange(bytes: Uint8Array, start: number, end: number): string | null {
  try { return decoder.decode(bytes.subarray(start, end)); } catch { return null; }
}

function checkFrame(raw: unknown, i: number, bytes: Uint8Array, keys: Set<string>): string | VerifiedFrame {
  if (!isObject(raw)) return `turn ${i} is not an object`;
  if (raw.index !== i) return `turn ${i} has index ${String(raw.index)}`;
  const kind = raw.kind;
  if (kind !== 'attributed' && kind !== 'participant' && kind !== 'structural' && kind !== 'unattributed' && kind !== 'inner-life') return `turn ${i} kind is not recognized`;
  const allowedKeys = kind === 'attributed' ? ATTRIBUTED_KEYS : kind === 'participant' ? PARTICIPANT_KEYS : kind === 'inner-life' ? INNER_LIFE_KEYS : BARE_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return `turn ${i} carries unexpected field ${key}`;
  }
  const rule = typeof raw.source === 'string' ? ruleFor(raw.source) : undefined;
  if (!rule) return `turn ${i} source is not in the registry`;
  const source = raw.source as TurnSource;
  if (typeof raw.sourceEventId !== 'string' || !EVENT_ID.test(raw.sourceEventId)) return `turn ${i} sourceEventId is malformed`;
  if (typeof raw.frameKey !== 'string') return `turn ${i} frameKey is missing`;
  const key = JSON.stringify([source, raw.sourceEventId, raw.frameKey]);
  if (keys.has(key)) return `turn ${i} repeats an entry key`;
  keys.add(key);

  const { labelStart, bodyStart, bodyEnd } = raw;
  if (!isOffset(labelStart) || !isOffset(bodyStart) || !isOffset(bodyEnd)) return `turn ${i} offsets are not non-negative integers`;
  // Structural and unattributed frames have an empty label range and a
  // non-empty body; every other kind has a non-empty label.
  const bare = kind === 'structural' || kind === 'unattributed';
  const ordered = bare ? labelStart === bodyStart && bodyStart < bodyEnd : labelStart < bodyStart && bodyStart <= bodyEnd;
  if (!ordered || bodyEnd > bytes.length) return `turn ${i} offsets are out of order or past the content`;
  if (raw.labelSha256 !== sha256Hex(bytes.subarray(labelStart, bodyStart))) return `turn ${i} labelSha256 mismatch`;
  if (raw.bodySha256 !== sha256Hex(bytes.subarray(bodyStart, bodyEnd))) return `turn ${i} bodySha256 mismatch`;
  const label = decodeRange(bytes, labelStart, bodyStart);
  const body = decodeRange(bytes, bodyStart, bodyEnd);
  if (label === null || body === null) return `turn ${i} range splits a UTF-8 character`;
  const base = { index: i, source, sourceEventId: raw.sourceEventId, frameKey: raw.frameKey, labelStart, bodyStart, bodyEnd, label, body };

  if (kind === 'inner-life') {
    if (!rule.innerLife) return `turn ${i} inner-life fragments are not allowed for source ${source}`;
    const channel = raw.channel;
    if (typeof channel !== 'string' || !INNER_LIFE_CHANNELS.has(channel)) return `turn ${i} inner-life channel is not recognized`;
    if (raw.frameKey !== channel) return `turn ${i} inner-life frameKey must be its channel`;
    const prefix = `inner-life:${channel}:`;
    const entryId = (raw.sourceEventId as string).startsWith(prefix) ? (raw.sourceEventId as string).slice(prefix.length) : '';
    if (!INNER_LIFE_ENTRY_ID.test(entryId)) return `turn ${i} inner-life sourceEventId must be inner-life:<channel>:<entryId>`;
    // Section 3.5: direct file intake never asserts a hat.
    if (raw.hat !== 'unknown' || raw.hatEvidence !== 'none') return `turn ${i} inner-life hat must be unknown with evidence none`;
    if (typeof raw.receiptRowId !== 'string' || !UUID.test(raw.receiptRowId)) return `turn ${i} inner-life receiptRowId is malformed`;
    if (label !== innerLifeLabel(channel as InnerLifeChannel)) return `turn ${i} label is not the registered ${channel} fragment prefix`;
    if (!body.endsWith(']')) return `turn ${i} inner-life body must end with its closing bracket`;
    return { ...base, kind: 'inner-life', channel: channel as InnerLifeChannel, entryId, receiptRowId: raw.receiptRowId, content: body.slice(0, -1) };
  }
  if (kind === 'structural') {
    if (!rule.structural || !rule.structural.frameKey(raw.frameKey as string)) return `turn ${i} structural frames are not allowed for source ${source}`;
    if (!isStructuralBody(body)) return `turn ${i} structural bytes are not structure`;
    return { ...base, kind: 'structural' };
  }
  if (kind === 'unattributed') {
    if (!rule.unattributed || !rule.unattributed.frameKey(raw.frameKey as string) || !rule.unattributed.sourceEventId(raw.sourceEventId as string)) {
      return `turn ${i} unattributed frames are not allowed for source ${source}`;
    }
    return { ...base, kind: 'unattributed' };
  }
  if (kind === 'participant') {
    const allowed = (rule.participant ?? []).find(p => p.participant === raw.participant && p.frameKey(raw.frameKey as string));
    if (!allowed) return `turn ${i} participant/frameKey is not allowed for source ${source}`;
    if (!PARTICIPANT_LABELS[allowed.participant](label)) return `turn ${i} label is not ${allowed.participant}'s registered label`;
    return { ...base, kind: 'participant', participant: allowed.participant };
  }

  const allowed = (rule.attributed ?? []).find(a => a.speaker === raw.speaker && a.frameKey(raw.frameKey as string));
  if (!allowed) return `turn ${i} speaker/frameKey is not allowed for source ${source}`;
  // The label range must be exactly one rendered speaker label naming this speaker.
  const parsed = parseSpeakerLine(label);
  if (!parsed || parsed.rest !== '' || `${parsed.bold ? `**${parsed.label}:** ` : `${parsed.label}: `}` !== label) {
    return `turn ${i} label range is not exactly one speaker label`;
  }
  if (parsed.name.toLowerCase() !== allowed.speaker) return `turn ${i} label names ${parsed.name}, not ${allowed.speaker}`;

  let hat: string;
  if (rule.hat === 'capture-source') {
    // The authenticated capture source IS the hat for canonical exchanges.
    if (raw.hat !== source || raw.hatEvidence !== 'capture-source') return `turn ${i} hat must be its capture source`;
    hat = source;
  } else if (MANUAL_SOURCE.test(source)) {
    // A manual source names the authenticated actor that appended it; the
    // frame's hat must be exactly that actor's hat (luca-replit review of
    // PR68). Any other claim, including unknown, is inconsistent.
    const manualHat = source.slice('manual-luca-'.length);
    if (raw.hat !== manualHat || raw.hatEvidence !== 'authenticated-actor') return `turn ${i} hat must be the manual source's actor (${manualHat})`;
    hat = manualHat;
  } else if (raw.hat === 'unknown') {
    if (raw.hatEvidence !== 'none') return `turn ${i} unknown hat needs none evidence`;
    hat = 'unknown';
  } else {
    if (typeof raw.hat !== 'string' || !HAT_PATTERN.test(raw.hat) || raw.hatEvidence !== 'authenticated-actor') {
      return `turn ${i} hat lacks authenticated-actor evidence`;
    }
    hat = raw.hat;
  }
  // A label that itself names a hat (historical form) must agree with the entry.
  if (parsed.labelHat !== null && parsed.labelHat !== hat) return `turn ${i} label hat contradicts the entry`;

  if (raw.captureId !== null && (typeof raw.captureId !== 'string' || !CAPTURE_ID.test(raw.captureId))) return `turn ${i} captureId is malformed`;
  if (allowed.speaker === 'david' && raw.provenance !== null) return `turn ${i} David turns carry no provenance`;
  if (raw.provenance === undefined) return `turn ${i} provenance field is missing`;
  // Section 3.1: an invalid provenance makes provider/model unknown for this
  // turn; it does not invalidate the row, and the hat still applies.
  const provenance = raw.provenance === null
    ? { status: 'absent' as const }
    : verifyProvenance(raw.provenance, body, hat);
  return { ...base, kind: 'attributed', speaker: allowed.speaker, hat, captureId: (raw.captureId as string | null) ?? null, provenance };
}

/**
 * Verify a row's turnAttribution against the exact stored content (design
 * 3.3 rules 1-6). `turnAttribution` is the value read via turnAttributionOf.
 */
export function verifyTurnAttribution(content: string, turnAttribution: unknown): TurnAttributionVerdict {
  if (turnAttribution === undefined || turnAttribution === null) return { status: 'absent' };
  const bytes = new TextEncoder().encode(content);
  const saneLegacy = isObject(turnAttribution) && isOffset(turnAttribution.legacyPrefixEnd) && turnAttribution.legacyPrefixEnd <= bytes.length
    && decodeRange(bytes, 0, turnAttribution.legacyPrefixEnd) !== null
    ? turnAttribution.legacyPrefixEnd as number : null;
  const invalid = (reason: string): TurnAttributionVerdict => ({ status: 'invalid', reason, legacyPrefixEnd: saneLegacy });

  if (!isObject(turnAttribution)) return invalid('turnAttribution is not an object');
  const t = turnAttribution;
  if (t.version !== 1) return invalid(`unsupported version ${String(t.version)}`);
  if (t.encoding !== 'utf8-bytes') return invalid('unsupported encoding');
  if (t.separator !== TURN_ATTRIBUTION_SEPARATOR) return invalid('separator must be exactly "\\n\\n"');
  if (saneLegacy === null) return invalid('legacyPrefixEnd is not a valid offset');
  if (!isOffset(t.coveredEnd)) return invalid('coveredEnd is not a valid offset');
  if (typeof t.coveredSha256 !== 'string' || !SHA256.test(t.coveredSha256)) return invalid('coveredSha256 is malformed');
  if (!Array.isArray(t.turns) || t.turns.length === 0) return invalid('turns must be a non-empty array');

  const sep = new TextEncoder().encode(TURN_ATTRIBUTION_SEPARATOR);
  const gapIs = (start: number, end: number, allowEmpty: boolean) => {
    if (end < start) return false;
    if (end === start) return allowEmpty;
    return end - start === sep.length && bytes.subarray(start, end).every((b, k) => b === sep[k]);
  };

  const frames: VerifiedFrame[] = [];
  const keys = new Set<string>();
  let previousEnd = saneLegacy;
  for (let i = 0; i < t.turns.length; i++) {
    const frame = checkFrame(t.turns[i], i, bytes, keys);
    if (typeof frame === 'string') return invalid(frame);
    // Rule 2: nothing or exactly the separator after the legacy prefix,
    // exactly the separator between entries.
    if (!gapIs(previousEnd, frame.labelStart, i === 0)) return invalid(`turn ${i} is not separated by exactly the separator`);
    frames.push(frame);
    previousEnd = frame.bodyEnd;
  }
  if (t.coveredEnd !== previousEnd) return invalid('coveredEnd is not the last bodyEnd');
  if (t.coveredSha256 !== sha256Hex(bytes.subarray(0, previousEnd))) return invalid('coveredSha256 mismatch');
  // Rule 4: an aware row has no uncovered tail.
  if (previousEnd !== bytes.length) return invalid('content after coveredEnd is not covered by any entry');
  return { status: 'valid', legacyPrefixEnd: saneLegacy, frames };
}

/**
 * PRESENCE ONLY: true when the verified row holds at least one frame of
 * (source, sourceEventId). It does NOT mean the event is complete (a row may
 * hold only one side of an exchange), and it is NOT a dedupe or retry
 * receipt. Never use it to skip an append: completion, exact-retry equality
 * and partial-event conflicts are decided only by the common append's
 * planProjectionAppend (luca-replit review of PR68).
 */
export function turnAttributionHasAnyFrameOf(verdict: TurnAttributionVerdict, source: string, sourceEventId: string): boolean {
  return verdict.status === 'valid' && verdict.frames.some(frame => frame.source === source && frame.sourceEventId === sourceEventId);
}
