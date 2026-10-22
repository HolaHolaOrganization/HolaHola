/**
 * Claude Code transcript projection (recording-gap design R6.5 §2 of revision 3,
 * §3a and §3b), stage R-P2. Pure: no database, no clock.
 *
 * Input: the mirrored entries of one session, by original transcript position.
 * Output: exchanges, each with its turn-start kind and a publication state:
 * - certified: closed by a later resolved turn start, no holes, nothing open
 *   (the only state that may ever be published canonically, R6.4 §3b.2);
 * - provisional-candidate: the terminal exchange with nothing open; it becomes
 *   provisional only after challenge-bound quiescence (§3b.3), decided elsewhere;
 * - open: something still open (reasons given);
 * - retained: never published (unresolved boundary, no reply, conflicting variants).
 * Segmentation comes only from provenance fields, never from text shape.
 */
import { canonicalJson, sha256Hex } from '@shared/claude-code-mirror-core.mjs';

export interface MirroredEntry {
  position: number;
  uuid: string;
  entry: Record<string, unknown>;
  /** True when the server holds more than one observation at this position. */
  conflicted?: boolean;
}

export type StartKind = 'human' | 'absorbed-human' | 'runtime' | 'unresolved-boundary';
export type ExchangeState = 'certified' | 'provisional-candidate' | 'open' | 'retained';

export interface ProjectedExchange {
  openingPosition: number;
  captureId: string;
  kind: StartKind;
  basis: string;
  userText: string;
  replyText: string;
  apiErrorCount: number;
  state: ExchangeState;
  reasons: string[];
  versionSha256: string;
  lastPosition: number;
}

type Role =
  | { role: 'start'; kind: StartKind; basis: string; text: string }
  | { role: 'reply'; text: string; apiError: boolean; toolUses: string[] }
  | { role: 'tool-results'; ids: string[] }
  | { role: 'hook-feedback' }
  | { role: 'meta-fold' }
  | { role: 'unresolved'; why: string }
  | { role: 'ignore' };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('\n\n');
}

function blocksOf(content: unknown, type: string, key: string): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === type)
    .map((b) => (b as Record<string, unknown>)[key])
    .filter((v): v is string => typeof v === 'string');
}

/** PR #81's provenance classifier, applied to a mirrored user entry. */
export function classifyUserEntry(entry: Record<string, unknown>): { founder: boolean; basis: string } {
  if (entry.isMeta === true) return { founder: false, basis: 'isMeta' };
  if (entry.isCompactSummary === true) return { founder: false, basis: 'isCompactSummary' };
  const originKind = (entry.origin as { kind?: unknown } | undefined)?.kind;
  if (typeof originKind === 'string') return { founder: originKind === 'human', basis: `origin:${originKind}` };
  if (typeof entry.turnOrigin === 'string') return { founder: entry.turnOrigin === 'human', basis: `turnOrigin:${entry.turnOrigin}` };
  if (entry.promptSource === 'sdk') return { founder: true, basis: 'promptSource:sdk' };
  if (entry.promptSource === 'system') return { founder: false, basis: 'promptSource:system' };
  return { founder: true, basis: 'no provenance fields (legacy rule)' };
}

function isFeedbackWitness(e: Record<string, unknown> | undefined): boolean {
  return e?.type === 'attachment' && (e.attachment as { type?: unknown } | undefined)?.type === 'hook_blocking_error';
}

function isStopSummary(e: Record<string, unknown> | undefined): boolean {
  return e?.type === 'system' && e.subtype === 'stop_hook_summary';
}

/**
 * Projects one session. `held` maps position to entry; positions not present are
 * holes (not yet synced). `sessionId` forms the v1 capture id cc-<session>-<position>.
 */
export function projectSession(sessionId: string, entries: MirroredEntry[]): ProjectedExchange[] {
  const byPos = new Map(entries.map((e) => [e.position, e]));
  const positions = [...byPos.keys()].sort((a, b) => a - b);
  if (positions.length === 0) return [];
  const maxPos = positions[positions.length - 1];

  // Pass 1: roles. A user isMeta entry after reply text depends on the next two
  // positions (the hook-feedback triple); until both are held it is unresolved.
  const roles = new Map<number, Role>();
  let replySinceStart = false;
  for (const pos of positions) {
    const e = byPos.get(pos)!.entry;
    let role: Role = { role: 'ignore' };
    if (e.type === 'user') {
      const message = e.message as { content?: unknown } | undefined;
      const text = textOf(message?.content).trim();
      const toolResults = blocksOf(message?.content, 'tool_result', 'tool_use_id');
      if (e.isCompactSummary === true) {
        role = { role: 'ignore' };
      } else if (e.isMeta === true) {
        if (!replySinceStart) role = { role: 'meta-fold' };
        else {
          const n1 = byPos.get(pos + 1)?.entry;
          const n2 = byPos.get(pos + 2)?.entry;
          if (n1 === undefined || n2 === undefined) role = { role: 'unresolved', why: 'feedback lookahead not held' };
          else if (isFeedbackWitness(n1) && isStopSummary(n2)) role = { role: 'hook-feedback' };
          else role = { role: 'start', kind: 'runtime', basis: 'isMeta after reply', text };
        }
      } else if (text) {
        const c = classifyUserEntry(e);
        role = { role: 'start', kind: c.founder ? 'human' : 'runtime', basis: c.basis, text };
      } else if (toolResults.length) {
        role = { role: 'tool-results', ids: toolResults };
      }
    } else if (e.type === 'assistant') {
      const message = e.message as { content?: unknown } | undefined;
      role = { role: 'reply', text: textOf(message?.content).trim(), apiError: e.isApiErrorMessage === true, toolUses: blocksOf(message?.content, 'tool_use', 'id') };
    } else if (e.type === 'attachment' && (e.attachment as { type?: unknown } | undefined)?.type === 'queued_command') {
      const a = e.attachment as { origin?: { kind?: unknown }; commandMode?: unknown; prompt?: unknown };
      if (a.origin?.kind === 'human' && a.commandMode === 'prompt' && typeof a.prompt === 'string') {
        role = { role: 'start', kind: 'absorbed-human', basis: 'queued_command:human', text: a.prompt.trim() };
      } else if (a.origin?.kind === 'task-notification' && a.commandMode === 'task-notification') {
        role = { role: 'start', kind: 'runtime', basis: 'queued_command:task-notification', text: typeof a.prompt === 'string' ? a.prompt.trim() : '' };
      } else {
        role = { role: 'start', kind: 'unresolved-boundary', basis: 'queued_command:unresolved', text: '' };
      }
    }
    if (role.role === 'start') replySinceStart = false;
    if (role.role === 'reply' && role.text && !role.apiError) replySinceStart = true;
    roles.set(pos, role);
  }

  // Pass 2: exchanges between consecutive starts.
  const starts = positions.filter((p) => roles.get(p)!.role === 'start');
  const out: ProjectedExchange[] = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const next = k + 1 < starts.length ? starts[k + 1] : null;
    const end = next ?? maxPos + 1;
    const start = roles.get(s) as Extract<Role, { role: 'start' }>;
    const reasons = new Set<string>();
    const replies: string[] = [];
    let apiErrorCount = 0;
    const openTools = new Set<string>();
    let lastPosition = s;
    let trailingFeedback = false;
    for (let p = s; p < end; p++) {
      const held = byPos.get(p);
      if (!held) { reasons.add('hole'); continue; }
      lastPosition = p;
      if (held.conflicted) reasons.add('conflicting-variants');
      const r = roles.get(p)!;
      if (r.role === 'reply') {
        if (r.apiError) apiErrorCount++;
        else if (r.text) replies.push(r.text);
        for (const id of r.toolUses) openTools.add(id);
        trailingFeedback = false;
      } else if (r.role === 'tool-results') {
        for (const id of r.ids) openTools.delete(id);
      } else if (r.role === 'hook-feedback') {
        trailingFeedback = true;
      } else if (r.role === 'unresolved') {
        reasons.add('unresolved-lookahead');
      }
    }
    if (openTools.size) reasons.add('unmatched-tool-call');
    if (next === null) {
      if (trailingFeedback) reasons.add('trailing-hook-feedback');
    } else {
      // Certified closure needs an unambiguous, resolved closing witness (R6.5 §3b.2):
      // a human, absorbed-human or runtime start, held exactly once.
      const closing = roles.get(next) as Extract<Role, { role: 'start' }>;
      if (closing.kind === 'unresolved-boundary') reasons.add('unresolved-closing-boundary');
      if (byPos.get(next)!.conflicted) reasons.add('conflicted-closing-boundary');
    }
    const replyText = replies.join('\n\n');
    let state: ExchangeState;
    if (start.kind === 'unresolved-boundary') state = 'retained';
    else if (reasons.has('conflicting-variants')) state = 'retained';
    else if (reasons.size) state = 'open';
    else if (next === null) state = replyText ? 'provisional-candidate' : 'open';
    else state = replyText ? 'certified' : 'retained';
    if (state === 'retained' && !replyText && start.kind !== 'unresolved-boundary') reasons.add('no-reply');
    if (start.kind === 'unresolved-boundary') reasons.add('unresolved-boundary');
    const versionSha256 = sha256Hex(canonicalJson({
      positions: positions.filter((p) => p >= s && p < end).map((p) => [p, byPos.get(p)!.uuid]),
      user: start.text, reply: replyText,
    }));
    out.push({
      openingPosition: s, captureId: `cc-${sessionId}-${s}`, kind: start.kind, basis: start.basis,
      userText: start.text, replyText, apiErrorCount, state, reasons: [...reasons].sort(), versionSha256, lastPosition,
    });
  }
  return out;
}

export type Comparison = 'match' | 'mismatch' | 'missing' | 'ambiguous' | 'not-applicable';

/** The exact canonical body the drain writes for one Claude Code exchange (transcript-parser buildDialogueChunk). */
export function expectedCanonicalBody(userText: string, replyText: string): string {
  return `David [Claude Code]: ${userText}\n\nClaude Code: ${replyText}`;
}

/**
 * Compares a certified exchange with the canonical rows that carry its capture id.
 * Pure. "match" requires exactly one row, a sole source tag of source-claude-code,
 * and a body equal to the exact two-speaker form, so each side is checked in its
 * place and order. Anything else names why it is not a match.
 */
export function compareWithCanonical(
  exchange: Pick<ProjectedExchange, 'state' | 'userText' | 'replyText'>,
  rows: Array<{ id: string; content: string; tags: string[] }>,
): { comparison: Comparison; detail: string | null; rowId: string | null } {
  if (exchange.state !== 'certified') return { comparison: 'not-applicable', detail: null, rowId: null };
  if (rows.length === 0) return { comparison: 'missing', detail: null, rowId: null };
  if (rows.length > 1) return { comparison: 'ambiguous', detail: `${rows.length} rows share this capture id`, rowId: null };
  const [row] = rows;
  const sources = row.tags.filter((t) => t.startsWith('source-')).sort();
  if (sources.length !== 1 || sources[0] !== 'source-claude-code') return { comparison: 'mismatch', detail: `source:${sources.join(',') || 'none'}`, rowId: row.id };
  const body = row.content.replace(/\s+$/, '');
  if (body === expectedCanonicalBody(exchange.userText, exchange.replyText)) return { comparison: 'match', detail: null, rowId: row.id };
  if (body === expectedCanonicalBody(exchange.replyText, exchange.userText)) return { comparison: 'mismatch', detail: 'sides-swapped', rowId: row.id };
  if (/\[turn (truncated|omitted)/.test(body)) return { comparison: 'mismatch', detail: 'truncated', rowId: row.id };
  const userPrefix = `David [Claude Code]: ${exchange.userText}\n\n`;
  if (!body.startsWith(userPrefix)) return { comparison: 'mismatch', detail: 'user-side', rowId: row.id };
  return { comparison: 'mismatch', detail: 'reply-side', rowId: row.id };
}
