// Claude Code transcript mirror: the privacy filter and the coverage digests
// (recording-gap design R6.5, sections 2 and 3a). Plain ESM with no dependencies
// beyond node:crypto, so the Claude Code hook (plain node) and the server
// (TypeScript, via claude-code-mirror-core.d.mts) use the exact same bytes.
import { createHash } from 'node:crypto';

/** Positions per coverage block. */
export const BLOCK_SIZE = 256;

const USER_FIELDS = ['origin', 'promptSource', 'turnOrigin', 'isMeta', 'isCompactSummary', 'userType', 'timestamp'];

/** JSON with object keys sorted at every level, so equal values give equal bytes. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pick(source, fields) {
  const out = {};
  for (const f of fields) if (source[f] !== undefined) out[f] = source[f];
  return out;
}

function userBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => {
    if (!b || typeof b !== 'object') return [];
    if (b.type === 'text' && typeof b.text === 'string') return [{ type: 'text', text: b.text }];
    if (b.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : null }];
    return [{ type: typeof b.type === 'string' ? b.type : 'unknown' }];
  });
}

function assistantBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => {
    if (!b || typeof b !== 'object') return [];
    if (b.type === 'text' && typeof b.text === 'string') return [{ type: 'text', text: b.text }];
    if (b.type === 'tool_use') return [{ type: 'tool_use', id: typeof b.id === 'string' ? b.id : null }];
    if (b.type === 'thinking' || b.type === 'redacted_thinking') return [];
    return [{ type: typeof b.type === 'string' ? b.type : 'unknown' }];
  });
}

/**
 * The privacy filter. Returns the mirrored form of one parsed transcript entry:
 * - user: provenance fields, timestamp, text blocks; tool_result as an id-only
 *   witness; every other block (image included) as a content-free type marker;
 * - assistant: isApiErrorMessage, model, timestamp, text blocks; tool_use as an
 *   id-only witness; thinking dropped;
 * - queued_command attachment: the whole attachment;
 * - hook_blocking_error attachment and stop_hook_summary system entry: typed
 *   structural witnesses with no text;
 * - anything else: a content-free position placeholder.
 * The entry's uuid is not part of the mirrored content; it travels beside it.
 */
export function filterEntry(raw) {
  if (!raw || typeof raw !== 'object') return { type: 'unparseable' };
  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  if (type === 'user') {
    return { type, ...pick(raw, USER_FIELDS), message: { content: userBlocks(raw.message?.content) } };
  }
  if (type === 'assistant') {
    const message = { content: assistantBlocks(raw.message?.content) };
    if (typeof raw.message?.model === 'string') message.model = raw.message.model;
    return { type, ...pick(raw, ['isApiErrorMessage', 'timestamp']), message };
  }
  if (type === 'attachment') {
    const attachmentType = typeof raw.attachment?.type === 'string' ? raw.attachment.type : 'unknown';
    if (attachmentType === 'queued_command') return { type, ...pick(raw, ['timestamp']), attachment: raw.attachment };
    if (attachmentType === 'hook_blocking_error') return { type, ...pick(raw, ['timestamp']), attachment: { type: attachmentType } };
    return { type, attachment: { type: attachmentType } };
  }
  if (type === 'system' && raw.subtype === 'stop_hook_summary') {
    return { type, subtype: raw.subtype, ...pick(raw, ['level', 'timestamp']) };
  }
  return typeof raw.subtype === 'string' ? { type, subtype: raw.subtype } : { type };
}

/** A mirrored entry is valid only if the filter leaves it unchanged (nothing extra was sent). */
export function isFilterFixedPoint(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return canonicalJson(filterEntry(entry)) === canonicalJson(entry);
}

/** Content hash of a mirrored entry. Excludes position and uuid (R6.2). */
export function contentSha256(entry) {
  return sha256Hex(canonicalJson(entry));
}

export function blockIndexOf(position) {
  return Math.floor(position / BLOCK_SIZE);
}

export function tupleKey(position, uuid, sha) {
  return `${position}\t${uuid ?? ''}\t${sha}`;
}

/** Digest of one block's observation tuples, salted with the session id. */
export function blockDigest(sessionId, tuples) {
  const keys = tuples.map((t) => tupleKey(t.position, t.uuid, t.sha256)).sort();
  return sha256Hex(`${sessionId}\n${keys.join('\n')}`);
}

/** Digest of a session's ordered block digests, salted with the session id. */
export function rootDigest(sessionId, blocks) {
  const lines = [...blocks].sort((a, b) => a.index - b.index).map((b) => `${b.index}:${b.digest}`);
  return sha256Hex(`${sessionId}\n${lines.join('\n')}`);
}
