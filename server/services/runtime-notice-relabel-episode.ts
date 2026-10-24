/**
 * Runtime-notice relabel for a rolling episode row (Episode 34). Pure: the
 * receipt builder used by the read-only generator and the apply rule used by
 * the data-op. Design agreed with luca-replit (thread dd40f2cf, 883-887).
 *
 * Selection. The startup gap patcher (agent-session-autosave appendExchangeToEpisode
 * with row.content.trim()) projects a canonical row into the episode as
 * "\n" + trimmed row + "\n" via an atomic SQL append. A location is a candidate
 * only when it is the exact trimmed content of a row in the approved canonical
 * receipt, framed by "\n" on both sides, unique, non-overlapping and outside a
 * code fence. The frame proves byte placement, not authorship of the location,
 * so projection context comes from adjacency: a gap-patcher run is a sequence
 * of canonical frames. Candidates with canonical frames on both sides are
 * included; those with one canonical side go to a review list that the founder
 * approves per location; isolated ones are excluded. Nothing is inferred from
 * notice-shaped text.
 *
 * Coordinates. Offsets and lengths are JavaScript string offsets; hashes are
 * SHA-256 over UTF-8. L is the end of the last edited frame in the original
 * content; L' = L + edits * (newLabel - oldLabel). The prefix [0, L) is the
 * immutable validation range; anything after L is the untouched tail.
 */
import { createHash } from 'node:crypto';
import { RUNTIME_NOTICE_LABEL } from './runtime-notice-relabel';

export const EPISODE_RECEIPT_KIND = 'runtime-notice-relabel-episode';

/**
 * The only episode this one-time correction may touch: Episode 34, the rolling
 * episode the gap patcher projected the misattributed rows into. Episode 33 and
 * every other row are out of scope. Production callers check a receipt against
 * this constant, never against the receipt's own episodeId.
 */
export const PERMITTED_EPISODE_ID = '41200170-1c49-4660-838c-9d397aff5d27';
export const OLD_LABEL = 'David [Claude Code]:';
export const NEW_LABEL = `${RUNTIME_NOTICE_LABEL}:`;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface EpisodeEdit {
  /** Offset of the row's first character (the old label) in the original content. */
  offset: number;
  /** Length of the trimmed row text. */
  rowLength: number;
  sourceRowId: string;
  /** preSha256 of the source row in the approved canonical receipt. */
  rowPreSha256: string;
  /** sha256 of "\n" + trimmed row + "\n" at this location. */
  frameSha256: string;
  context: 'two-sided' | 'one-sided';
}

export interface EpisodeReceipt {
  kind: typeof EPISODE_RECEIPT_KIND;
  episodeId: string;
  label: string;
  sourceReceiptListSha256: string;
  L: number;
  Lprime: number;
  prefixSha256: string;
  correctedPrefixSha256: string;
  edits: EpisodeEdit[];
  episodeEditListSha256: string;
}

export interface Candidate extends EpisodeEdit {
  /** Up to 120 characters on the non-canonical side, for one-sided review only. */
  otherSide?: string;
}

export interface EpisodeSelection {
  included: Candidate[];
  review: Candidate[];
  excluded: Array<{ offset: number; sourceRowId: string; reason: string }>;
}

function insideCodeFence(content: string, offset: number): boolean {
  let fence: string | null = null;
  for (const line of content.slice(0, offset).split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
  }
  return fence !== null;
}

/** Every "\n"-framed occurrence of each text in the content, sorted by offset. */
function framedSpans(content: string, rows: Array<{ id: string; text: string }>) {
  const spans: Array<{ start: number; end: number; id: string }> = [];
  for (const row of rows) {
    if (row.text.length < 20) continue;
    let i = 0;
    while ((i = content.indexOf(row.text, i)) !== -1) {
      if (content[i - 1] === '\n' && content[i + row.text.length] === '\n') spans.push({ start: i, end: i + row.text.length, id: row.id });
      i += row.text.length;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Classify candidate locations. `approved` are the rows of the approved
 * canonical receipt (id, original content, preSha256); `canonical` are all
 * canonical rows of the arc, used only to recognize neighbouring frames.
 */
export function selectEpisodeEdits(
  content: string,
  approved: Array<{ id: string; content: string; preSha256: string }>,
  canonical: Array<{ id: string; content: string }>,
): EpisodeSelection {
  const approvedById = new Map(approved.map(r => [r.id, r]));
  const spans = framedSpans(content, canonical.map(r => ({ id: r.id, text: r.content.trim() })));
  const seen = new Map<string, number>();
  for (const s of spans) if (approvedById.has(s.id)) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  const selection: EpisodeSelection = { included: [], review: [], excluded: [] };
  let previousEnd = -1;
  spans.forEach((span, k) => {
    const row = approvedById.get(span.id);
    if (!row) return;
    const exclude = (reason: string) => selection.excluded.push({ offset: span.start, sourceRowId: span.id, reason });
    const text = row.content.trim();
    if (sha256(row.content) !== row.preSha256) return exclude('source row content does not match its receipt hash');
    if ((seen.get(span.id) ?? 0) !== 1) return exclude('row appears more than once in the episode');
    if (span.start < previousEnd) return exclude('overlaps another candidate');
    if (!text.startsWith(`${OLD_LABEL} `)) return exclude('row does not start with the old label');
    if (insideCodeFence(content, span.start)) return exclude('inside a code fence');
    const prev = spans[k - 1];
    const next = spans[k + 1];
    const prevAdjacent = !!prev && content.slice(prev.end, span.start).trim() === '';
    const nextAdjacent = !!next && content.slice(span.end, next.start).trim() === '';
    previousEnd = span.end;
    const edit: Candidate = {
      offset: span.start, rowLength: text.length, sourceRowId: span.id, rowPreSha256: row.preSha256,
      frameSha256: sha256(`\n${text}\n`), context: prevAdjacent && nextAdjacent ? 'two-sided' : 'one-sided',
    };
    if (prevAdjacent && nextAdjacent) selection.included.push(edit);
    else if (prevAdjacent || nextAdjacent) {
      edit.otherSide = prevAdjacent ? content.slice(span.end, span.end + 120) : content.slice(Math.max(0, span.start - 120), span.start);
      selection.review.push(edit);
    } else exclude('isolated: no neighbouring canonical frame');
  });
  return selection;
}

/** Build the plan receipt for the chosen edits. It carries no applied flag. */
export function buildEpisodeReceipt(
  content: string,
  episodeId: string,
  sourceReceiptListSha256: string,
  chosen: EpisodeEdit[],
): EpisodeReceipt {
  const edits = [...chosen].sort((a, b) => a.offset - b.offset).map(({ offset, rowLength, sourceRowId, rowPreSha256, frameSha256, context }) =>
    ({ offset, rowLength, sourceRowId, rowPreSha256, frameSha256, context }));
  if (!edits.length) throw new Error('no edits chosen');
  const L = edits[edits.length - 1].offset + edits[edits.length - 1].rowLength + 1;
  const corrected = applyEdits(content.slice(0, L), edits);
  return {
    kind: EPISODE_RECEIPT_KIND, episodeId, label: RUNTIME_NOTICE_LABEL, sourceReceiptListSha256,
    L, Lprime: L + edits.length * (NEW_LABEL.length - OLD_LABEL.length),
    prefixSha256: sha256(content.slice(0, L)), correctedPrefixSha256: sha256(corrected),
    edits, episodeEditListSha256: sha256(JSON.stringify(edits)),
  };
}

function applyEdits(prefix: string, edits: EpisodeEdit[]): string {
  let out = prefix;
  for (const e of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, e.offset) + NEW_LABEL + out.slice(e.offset + OLD_LABEL.length);
  }
  return out;
}

export type EpisodeOutcome =
  | { status: 'apply'; next: string }
  | { status: 'already-applied' }
  | { status: 'drifted'; reason: string };

/** Structural checks on a receipt, independent of the row's current content. */
export function episodeReceiptProblem(r: EpisodeReceipt, episodeId: string): string | null {
  if (r.kind !== EPISODE_RECEIPT_KIND || r.label !== RUNTIME_NOTICE_LABEL || r.episodeId !== episodeId) return 'receipt kind, label or episode does not match';
  if (!Array.isArray(r.edits) || !r.edits.length) return 'no edits';
  if (sha256(JSON.stringify(r.edits)) !== r.episodeEditListSha256) return 'edit list hash does not match';
  let previousEnd = -1;
  for (const e of r.edits) {
    if (!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.rowLength) || e.offset < 1 || e.rowLength <= OLD_LABEL.length) return 'edit offset or length is invalid';
    // Adjacent frames may share one separating "\n"; rows themselves never overlap.
    if (e.offset < previousEnd) return 'edits are unsorted or overlap';
    previousEnd = e.offset + e.rowLength + 1;
  }
  if (previousEnd !== r.L) return 'L is not the end of the last edited frame';
  if (r.Lprime !== r.L + r.edits.length * (NEW_LABEL.length - OLD_LABEL.length)) return "L' does not match the edit list";
  return null;
}

/** A canonical receipt entry, as far as episode binding needs it. */
export interface SourceEntry {
  rowId: string;
  preSha256: string;
  projectionFrameSha256: string;
  projectionLength: number;
}

/**
 * Every edit must name a row of the approved canonical receipt and carry that
 * entry's own preimage hash, projection-frame hash and length. The frame proof
 * is rooted in the source receipt (covered by its listSha256), not in hashes
 * the episode plan supplies for itself.
 */
export function episodeSourceProblem(r: EpisodeReceipt, sourceEntries: SourceEntry[]): string | null {
  const byId = new Map(sourceEntries.map(e => [e.rowId, e]));
  for (const e of r.edits) {
    const source = byId.get(e.sourceRowId);
    if (!source) return `edit at ${e.offset} names a row that is not in the approved receipt`;
    if (e.rowPreSha256 !== source.preSha256 || e.frameSha256 !== source.projectionFrameSha256 || e.rowLength !== source.projectionLength) {
      return `edit at ${e.offset} does not match its source row's receipt entry`;
    }
  }
  return null;
}

/** Decide the episode row from its current content. Pure; the only way it changes. */
export function relabelEpisodeContent(content: string, r: EpisodeReceipt): EpisodeOutcome {
  if (content.length >= r.L && sha256(content.slice(0, r.L)) === r.prefixSha256) {
    for (const e of r.edits) {
      const frame = content.slice(e.offset - 1, e.offset + e.rowLength + 1);
      if (sha256(frame) !== e.frameSha256 || !content.startsWith(`${OLD_LABEL} `, e.offset)) {
        return { status: 'drifted', reason: `frame at ${e.offset} does not match its receipt` };
      }
    }
    const corrected = applyEdits(content.slice(0, r.L), r.edits);
    if (corrected.length !== r.Lprime || sha256(corrected) !== r.correctedPrefixSha256) {
      return { status: 'drifted', reason: 'corrected prefix does not match its receipt' };
    }
    return { status: 'apply', next: corrected + content.slice(r.L) };
  }
  if (content.length >= r.Lprime && sha256(content.slice(0, r.Lprime)) === r.correctedPrefixSha256) return { status: 'already-applied' };
  return { status: 'drifted', reason: 'episode prefix changed since the receipt was generated' };
}
