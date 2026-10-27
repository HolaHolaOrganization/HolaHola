// Source publication through the Git data API (stage 1, design dc6f8927
// revision 4, section 4): blob.put -> tree.create -> commit.create ->
// ref.update, plus ref.create for a new branch at the exact live base.
//
// This module holds the pure parts: strict payload validation, path rules,
// branch prefixes and the commit-message trailer. The gateway does the live
// checks, the single dispatch and reconciliation.
//
// Every publication payload names its own repository objects; the repository
// itself is fixed by the instance configuration, never by the caller. All five
// operations carry no envelope PR or head (pr = null, headSha = null).

import { gitBlobSha } from './policy.ts';

export const PUBLICATION_OPERATIONS = ['blob.put', 'tree.create', 'commit.create', 'ref.create', 'ref.update'] as const;
export type PublicationOperation = (typeof PUBLICATION_OPERATIONS)[number];

/**
 * Each actor publishes only under its own branch prefix, derived by the
 * broker from the authenticated actor, never from the request. An actor with
 * no prefix cannot create or update any branch.
 */
export const ACTOR_BRANCH_PREFIXES: Readonly<Record<string, string>> = {
  'luca-claude-code': 'lcc/',
  'luca-replit': 'lr/',
};

/** The default branch: ref.create may only start a branch at its live head, and nothing may write it. */
export const BASE_REF = 'main';
export const ZERO_OID = '0'.repeat(40);
export const MAX_TREE_ENTRIES = 100;
export const FILE_MODES = ['100644', '100755'] as const;

const SHA1_HEX = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!refs\/)[A-Za-z0-9._/-]{1,200}$/;
/** RFC 4648 with padding and no whitespace. Round-tripping below also rejects non-zero padding bits. */
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/**
 * Workflow files are a founder or manual exception (design section 2), never
 * broker publication. An entry AT an ancestor path also counts: replacing
 * `.github` or `.github/workflows` with a file, or deleting it, removes every
 * workflow beneath it (luca-replit PR #124 review, B-WORKFLOW). Compared
 * case-insensitively.
 */
const WORKFLOW_ANCESTORS = ['.github', '.github/workflows'];
const WORKFLOW_DIR = '.github/workflows/';

export function touchesWorkflows(path: string): boolean {
  const lower = path.toLowerCase();
  return WORKFLOW_ANCESTORS.includes(lower) || lower.startsWith(WORKFLOW_DIR);
}

type Payload = Record<string, unknown>;

export type TreeEntry = { path: string; mode: (typeof FILE_MODES)[number]; blobSha: string | null };

function exact(payload: unknown, keys: string[]): Payload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const present = Object.keys(payload);
  if (present.length !== keys.length || !keys.every((key) => present.includes(key))) return null;
  return payload as Payload;
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && SHA1_HEX.test(value);
}

function commitOid(value: unknown): value is string {
  return sha(value) && value !== ZERO_OID;
}

/** A branch under the actor's own prefix, never the default branch, never the bare prefix. */
export function ownBranch(actor: string, value: unknown): value is string {
  const prefix = ACTOR_BRANCH_PREFIXES[actor];
  return prefix !== undefined && typeof value === 'string' && BRANCH.test(value) && !value.endsWith('/')
    && value !== BASE_REF && value.startsWith(prefix) && value.length > prefix.length;
}

/** Canonical base64 decode, or null. */
export function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64_CANONICAL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

/** A normalized relative path: no leading or trailing slash, no empty, "." or ".." segment, no NUL. */
export function treePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400 || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function treeEntries(value: unknown): TreeEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TREE_ENTRIES) return null;
  const entries: TreeEntry[] = [];
  for (const item of value) {
    const entry = exact(item, ['path', 'mode', 'blobSha']);
    if (!entry || !treePath(entry.path) || !(FILE_MODES as readonly unknown[]).includes(entry.mode)) return null;
    if (entry.blobSha !== null && !sha(entry.blobSha)) return null;
    if (touchesWorkflows(entry.path)) return null;
    entries.push({ path: entry.path, mode: entry.mode as TreeEntry['mode'], blobSha: entry.blobSha as string | null });
  }
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) return null;
  // No path may be both a file and a directory prefix of another entry.
  if (paths.some((a) => paths.some((b) => b.startsWith(`${a}/`)))) return null;
  return entries;
}

/**
 * Strict validation of one publication payload. `text` is the gateway's caller
 * text rule (bounded, no broker marker). Returns the payload or null.
 */
export function validatePublication(operation: PublicationOperation, actor: string, payload: unknown, text: (value: unknown) => boolean): Payload | null {
  switch (operation) {
    case 'blob.put': {
      const p = exact(payload, ['blobSha', 'rawSize', 'contentBase64']);
      if (!p || !sha(p.blobSha) || !Number.isSafeInteger(p.rawSize) || (p.rawSize as number) < 0) return null;
      const bytes = decodeCanonicalBase64(p.contentBase64);
      return bytes && bytes.length === p.rawSize && gitBlobSha(bytes) === p.blobSha ? p : null;
    }
    case 'tree.create': {
      const p = exact(payload, ['parentCommitSha', 'baseTreeSha', 'entries', 'expectedTreeSha']);
      return p && commitOid(p.parentCommitSha) && sha(p.baseTreeSha) && sha(p.expectedTreeSha) && treeEntries(p.entries) ? p : null;
    }
    case 'commit.create': {
      const p = exact(payload, ['treeOperationId', 'treeSha', 'parentCommitSha', 'message', 'target', 'origin']);
      if (!p || typeof p.treeOperationId !== 'string' || !OPERATION_ID.test(p.treeOperationId)) return null;
      if (!sha(p.treeSha) || !commitOid(p.parentCommitSha) || !text(p.message)) return null;
      const target = exact(p.target, ['pr', 'branch']);
      if (!target || !(target.pr === null || (Number.isSafeInteger(target.pr) && (target.pr as number) > 0)) || !ownBranch(actor, target.branch)) return null;
      // Founder decision F2: relay authorship is trailer-only in stage 1, so
      // every commit is self-origin. Origin attestations are not accepted yet.
      return p.origin === null ? p : null;
    }
    case 'ref.create': {
      const p = exact(payload, ['branch', 'afterOid', 'baseRef']);
      return p && ownBranch(actor, p.branch) && commitOid(p.afterOid) && p.baseRef === BASE_REF ? p : null;
    }
    case 'ref.update': {
      const p = exact(payload, ['branch', 'beforeOid', 'afterOid', 'commitOperationId']);
      // A zero afterOid would delete; a zero beforeOid is reserved for ref.create.
      return p && ownBranch(actor, p.branch) && commitOid(p.beforeOid) && commitOid(p.afterOid)
        && typeof p.commitOperationId === 'string' && OPERATION_ID.test(p.commitOperationId) ? p : null;
    }
  }
}

/**
 * Appends the broker trailer. If the message already ends in a trailer block
 * (for example Co-Authored-By or Origin-Author), the broker trailer joins that
 * block so git still recognises every trailer; otherwise it starts one.
 */
export function withTrailer(message: string, trailer: string): string {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split('\n\n');
  const last = paragraphs[paragraphs.length - 1];
  const inBlock = paragraphs.length > 1 && last.split('\n').every((line) => /^[A-Za-z0-9-]+: \S/.test(line));
  return `${body}${inBlock ? '\n' : '\n\n'}${trailer}\n`;
}
