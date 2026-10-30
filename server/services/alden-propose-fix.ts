/**
 * Alden's propose_fix (gated-fixes design e4f8e988, P1, approved 2026-10-30):
 * a reviewable change, never a write.
 *
 * - Edits are `{path, find, replace}`. Several may name one path; each `find`
 *   must occur exactly once in the pinned original, matched ranges must not
 *   overlap, and replacements are applied to the pinned original by position,
 *   never re-searched against partly edited text. A path counts once toward
 *   the 3-file limit.
 * - Paths go through the read policy (P2) after resolution, the auto-repair
 *   blocklist, and the read-only directories, which are never an edit target.
 * - Only `high` confidence produces a pinned diff. `low` and `medium` store one
 *   description-only proposal. A missing or unknown confidence is refused.
 * - The pin: `release` (production) reads the release manifest and hashes the
 *   deployed source copy; `dev-head` (dev) reads the bytes from the immutable
 *   HEAD commit and requires the working file to be clean. Any other role
 *   refuses. The pin is re-verified just before the proposal row commits.
 * - Nothing is written to any file. The diff and hashes are computed in memory.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALDEN_READ_ONLY_DIRS, resolveAldenReadPath } from './alden-read-policy';
import { loadReleaseIdentity } from './release-identity';
import { resolveInstanceRole } from './instance-role';

export const PROPOSE_FIX_MAX_FILES = 3;
export const PROPOSE_FIX_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type ProposeFixConfidence = (typeof PROPOSE_FIX_CONFIDENCES)[number];

// The auto-repair blocklist (alden-auto-repair.ts), matched on resolved paths.
export const PROPOSE_FIX_BLOCKED_PATTERNS: readonly string[] = Object.freeze([
  'streaming-voice-orchestrator', 'unified-ws-handler', 'schema.ts', 'routes.ts', 'index.ts', '/auth',
  'billing', 'stripe', 'payment', 'guardian', 'alden-build-service', 'alden-auto-repair',
]);

export interface ProposeFixEdit { path: string; find: string; replace: string }
export interface PinnedFile { path: string; beforeSha256: string; afterSha256: string; gitMode?: string; objectType?: string }
export interface ProposalPin {
  kind: 'release' | 'dev-head';
  commit: string;
  sourceDigest: string | null;
  files: PinnedFile[];
}
export interface PinnedChange { pin: ProposalPin; diff: string }

export class ProposeFixRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposeFixRefusal';
  }
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export function parseConfidence(value: unknown): ProposeFixConfidence {
  if (typeof value === 'string' && (PROPOSE_FIX_CONFIDENCES as readonly string[]).includes(value)) return value as ProposeFixConfidence;
  throw new ProposeFixRefusal('confidence is required and must be low, medium or high');
}

export function parseEdits(value: unknown): ProposeFixEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw new ProposeFixRefusal('edits must be a non-empty array of {path, find, replace}');
  return value.map((edit, i) => {
    if (!edit || typeof edit.path !== 'string' || typeof edit.find !== 'string' || typeof edit.replace !== 'string') {
      throw new ProposeFixRefusal(`edit ${i + 1} needs string path, find and replace`);
    }
    if (edit.find.length === 0) throw new ProposeFixRefusal(`edit ${i + 1} has an empty find`);
    return { path: edit.path, find: edit.find, replace: edit.replace };
  });
}

/**
 * Resolve every edit's path under the read policy and the edit-target rules,
 * group the edits by resolved path, and enforce the file limit on the
 * resolved paths (not on what the model wrote).
 */
export function groupEditsByResolvedPath(edits: ProposeFixEdit[], root: string): Map<string, ProposeFixEdit[]> {
  const groups = new Map<string, ProposeFixEdit[]>();
  for (const edit of edits) {
    const decision = resolveAldenReadPath(edit.path, root);
    if (!decision.ok) throw new ProposeFixRefusal(`${edit.path}: ${decision.reason}`);
    if (decision.kind !== 'dir' && decision.kind !== 'file') throw new ProposeFixRefusal(`${edit.path} is not a file`);
    const rel = decision.rel;
    if (ALDEN_READ_ONLY_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) {
      throw new ProposeFixRefusal(`${rel} is in a read-only directory and can never be an edit target`);
    }
    if (PROPOSE_FIX_BLOCKED_PATTERNS.some((p) => `/${rel}`.includes(p))) {
      throw new ProposeFixRefusal(`${rel} is on the blocklist; describe the change with queue_build_proposal instead`);
    }
    const list = groups.get(rel) ?? [];
    list.push(edit);
    groups.set(rel, list);
  }
  if (groups.size > PROPOSE_FIX_MAX_FILES) {
    throw new ProposeFixRefusal(`a proposal may touch at most ${PROPOSE_FIX_MAX_FILES} files; this one touches ${groups.size}`);
  }
  return groups;
}

interface Located { start: number; end: number; replace: string }

/**
 * Apply one file's edits to its pinned original: each find exactly once,
 * no overlapping ranges, replacements applied by position.
 */
export function applyEditsToOriginal(rel: string, original: string, edits: ProposeFixEdit[]): { after: string; located: Located[] } {
  const located: Located[] = edits.map((edit) => {
    const first = original.indexOf(edit.find);
    if (first < 0) throw new ProposeFixRefusal(`${rel}: find text does not occur in the pinned original`);
    if (original.indexOf(edit.find, first + 1) >= 0) throw new ProposeFixRefusal(`${rel}: find text occurs more than once in the pinned original`);
    return { start: first, end: first + edit.find.length, replace: edit.replace };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < located.length; i++) {
    if (located[i].start < located[i - 1].end) throw new ProposeFixRefusal(`${rel}: two edits overlap in the pinned original`);
  }
  let after = '';
  let cursor = 0;
  for (const edit of located) {
    after += original.slice(cursor, edit.start) + edit.replace;
    cursor = edit.end;
  }
  return { after: after + original.slice(cursor), located };
}

/** Split text into lines that keep their own '\n' terminator. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

type Op = { kind: ' ' | '-' | '+'; line: string };

const MAX_EDIT_DISTANCE = 4000;

/** Myers shortest edit script between two line arrays. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDIT_DISTANCE) throw new ProposeFixRefusal('the change is too large to review as one proposal');
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', line: b[y - 1] });
      else ops.push({ kind: '-', line: a[x - 1] });
    }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

/** A unified diff (3 lines of context) between a file's pinned original and its edited text. */
export function unifiedDiff(rel: string, original: string, after: string): string {
  const ops = myers(splitLines(original), splitLines(after));
  const CONTEXT = 3;
  const out = [`--- a/${rel}`, `+++ b/${rel}`];
  const render = (op: Op) => {
    const rows = [`${op.kind}${op.line.endsWith('\n') ? op.line.slice(0, -1) : op.line}`];
    if (!op.line.endsWith('\n')) rows.push('\\ No newline at end of file');
    return rows;
  };
  let i = 0, oldLine = 1, newLine = 1;
  while (i < ops.length) {
    if (ops[i].kind === ' ') { i++; oldLine++; newLine++; continue; }
    // A hunk starts CONTEXT lines before this change and extends while changes stay within 2*CONTEXT.
    let start = i, back = 0;
    while (start > 0 && back < CONTEXT && ops[start - 1].kind === ' ') { start--; back++; }
    let end = i, unchanged = 0;
    for (let j = i; j < ops.length; j++) {
      if (ops[j].kind === ' ') { unchanged++; if (unchanged > CONTEXT * 2) break; }
      else { unchanged = 0; end = j; }
    }
    const stop = Math.min(ops.length, end + 1 + CONTEXT);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((op) => op.kind !== '+').length;
    const newCount = slice.filter((op) => op.kind !== '-').length;
    const oldStart = oldLine - back, newStart = newLine - back;
    out.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
    for (const op of slice) out.push(...render(op));
    for (const op of ops.slice(i, stop)) { if (op.kind !== '+') oldLine++; if (op.kind !== '-') newLine++; }
    i = stop;
  }
  return out.join('\n');
}

export interface PinSource {
  kind: 'release' | 'dev-head';
  commit: string;
  sourceDigest: string | null;
  /** The pinned original bytes of a workspace-relative path, with git mode/type for dev. */
  read(rel: string): { bytes: Buffer; gitMode?: string; objectType?: string };
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The pin source for this instance's role; any role other than production or dev refuses. */
export function pinSourceForRole(root: string, env: NodeJS.ProcessEnv = process.env): PinSource {
  let role: string;
  try {
    role = resolveInstanceRole(env);
  } catch {
    throw new ProposeFixRefusal('instance role unknown; cannot pin a proposal');
  }
  if (role === 'production') {
    const identity = loadReleaseIdentity(path.join(root, 'dist', 'release-manifest.json'));
    if (!identity.promotable || identity.authority !== 'build' || !identity.commitSha || identity.dirtyWorktree === true) {
      throw new ProposeFixRefusal('cannot pin a proposal to this build');
    }
    return {
      kind: 'release',
      commit: identity.commitSha,
      sourceDigest: identity.sourceContextSha256,
      read: (rel) => ({ bytes: fs.readFileSync(path.join(root, rel)) }),
    };
  }
  if (role === 'dev') {
    let commit: string;
    try {
      commit = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
    } catch {
      throw new ProposeFixRefusal('cannot read the dev HEAD commit');
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new ProposeFixRefusal('cannot read the dev HEAD commit');
    return {
      kind: 'dev-head',
      commit,
      sourceDigest: null,
      read: (rel) => {
        const entry = git(root, ['ls-tree', commit, '--', rel]).toString('utf8').trim();
        const match = /^(\d{6}) (\w+) [0-9a-f]{40}\t/.exec(entry);
        if (!match) throw new ProposeFixRefusal(`${rel} is not in the pinned commit`);
        const [, gitMode, objectType] = match;
        if (objectType !== 'blob' || (gitMode !== '100644' && gitMode !== '100755')) {
          throw new ProposeFixRefusal(`${rel} is a ${gitMode === '120000' ? 'symlink' : objectType === 'commit' ? 'submodule' : 'non-file'} entry and cannot be pinned`);
        }
        try {
          git(root, ['diff', '--quiet', commit, '--', rel]);
        } catch {
          throw new ProposeFixRefusal(`the working copy differs from HEAD for ${rel}`);
        }
        return { bytes: git(root, ['show', `${commit}:${rel}`]), gitMode, objectType };
      },
    };
  }
  throw new ProposeFixRefusal('instance role unknown; cannot pin a proposal');
}

function decodeUtf8(rel: string, bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new ProposeFixRefusal(`${rel} is not valid UTF-8 text`);
  return text;
}

/** Build the pinned diff for a high-confidence proposal. Writes nothing. */
export function buildPinnedChange(groups: Map<string, ProposeFixEdit[]>, source: PinSource): PinnedChange {
  const files: PinnedFile[] = [];
  const diffs: string[] = [];
  for (const [rel, edits] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const { bytes, gitMode, objectType } = source.read(rel);
    const original = decodeUtf8(rel, bytes);
    const { after } = applyEditsToOriginal(rel, original, edits);
    files.push({ path: rel, beforeSha256: sha256(bytes), afterSha256: sha256(after), ...(gitMode ? { gitMode, objectType } : {}) });
    diffs.push(unifiedDiff(rel, original, after));
  }
  return { pin: { kind: source.kind, commit: source.commit, sourceDigest: source.sourceDigest, files }, diff: diffs.join('\n') };
}

/** Re-verify a pin's before-hashes against the pin source (at persistence, and again at conversion). */
export function recheckPin(pin: ProposalPin, source: PinSource): void {
  if (source.kind !== pin.kind || source.commit !== pin.commit) throw new ProposeFixRefusal('stale base: the pinned commit changed');
  for (const file of pin.files) {
    if (sha256(source.read(file.path).bytes) !== file.beforeSha256) throw new ProposeFixRefusal(`stale base: ${file.path} changed since it was pinned`);
  }
}

/** The description-only text for a low or medium proposal: no pinned diff. */
export function describeUnpinnedEdits(edits: ProposeFixEdit[]): string {
  return edits.map((edit, i) => `Edit ${i + 1} (${edit.path}):\n  find:\n${edit.find}\n  replace:\n${edit.replace}`).join('\n\n');
}
