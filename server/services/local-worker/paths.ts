/**
 * Local Read-only Worker v1 — path expansion and staging selection (design §6.1).
 *
 * Pure: operates on a `git ls-tree -r -l <commit>` listing, never the filesystem.
 * Order is fixed: expand job patterns -> charter allowlist -> charter denylist and
 * the fixed minimum denylist. Any unsafe entry fails the whole selection.
 */
import { WORKER_MINIMUM_DENYLIST } from '../../../shared/worker-contracts';

export type TreeEntry = { mode: string; type: 'blob' | 'tree' | 'commit'; size: number | null; path: string };

export const STAGING_LIMITS = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxRelativePathLength: 180,
});

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Compiles a bounded glob (`*`, `?`, `**` segments) into an anchored RegExp. */
export function globToRegExp(pattern: string, flags = ''): RegExp {
  const segments = pattern.split('/');
  let re = '';
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    let s = '';
    for (const ch of seg) {
      if (ch === '*') s += '[^/]*';
      else if (ch === '?') s += '[^/]';
      else s += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    re += s + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`, flags);
}

/** Allowlist / job patterns: anchored at the repository root, case-sensitive (git paths). */
export function matchesAnchored(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Denylist patterns: case-insensitive, and a pattern without '/' matches the
 * basename at any depth; a pattern with '/' matches any suffix of the path that
 * starts at a segment boundary (so `.claude/**` also denies `x/.claude/y`).
 */
export function matchesDeny(path: string, pattern: string): boolean {
  const re = globToRegExp(pattern, 'i');
  const parts = path.split('/');
  if (!pattern.includes('/')) return re.test(parts[parts.length - 1]);
  for (let i = 0; i < parts.length; i += 1) {
    if (re.test(parts.slice(i).join('/'))) return true;
  }
  return false;
}

export type PathCheck = { ok: true } | { ok: false; reason: string };

/** Windows-safety and traversal checks for one repository-relative path. */
export function checkStagingPath(path: string): PathCheck {
  if (path.length === 0 || path.length > STAGING_LIMITS.maxRelativePathLength) return { ok: false, reason: 'path_length' };
  if (path.includes('\\') || path.includes('\0') || path.includes(':')) return { ok: false, reason: 'path_forbidden_character' };
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { ok: false, reason: 'path_absolute' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F<>"|?*]/.test(path)) return { ok: false, reason: 'path_windows_invalid_character' };
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return { ok: false, reason: 'path_traversal' };
    if (/[ .]$/.test(seg)) return { ok: false, reason: 'path_trailing_dot_or_space' };
    if (RESERVED.test(seg)) return { ok: false, reason: 'path_reserved_name' };
  }
  return { ok: true };
}

export type StagingSelection =
  | { ok: true; files: { path: string; size: number }[]; totalBytes: number }
  | { ok: false; reason: string; path?: string };

/**
 * Selects the files to stage for a job. Fails closed on: no match, a matched
 * symlink/submodule/tree, any unsafe path, a case-insensitive collision, a path
 * outside the allowlist or inside a denylist, or any size bound exceeded.
 */
export function selectStagingFiles(input: {
  tree: readonly TreeEntry[];
  jobPatterns: readonly string[];
  allowlist: readonly string[];
  denylist: readonly string[];
}): StagingSelection {
  const deny = [...new Set([...WORKER_MINIMUM_DENYLIST, ...input.denylist])];
  const matched = input.tree.filter((e) => input.jobPatterns.some((p) => matchesAnchored(e.path, p)));
  if (matched.length === 0) return { ok: false, reason: 'paths_no_match' };

  const files: { path: string; size: number }[] = [];
  const lowerSeen = new Map<string, string>();
  let total = 0;
  for (const e of matched) {
    if (e.mode === '120000') return { ok: false, reason: 'path_symlink', path: e.path };
    if (e.mode === '160000' || e.type === 'commit') return { ok: false, reason: 'path_submodule', path: e.path };
    if (e.type !== 'blob') continue; // directories never stage by themselves
    if (!['100644', '100755'].includes(e.mode)) return { ok: false, reason: 'path_unsupported_mode', path: e.path };
    const check = checkStagingPath(e.path);
    if (!check.ok) return { ok: false, reason: check.reason, path: e.path };
    if (!input.allowlist.some((p) => matchesAnchored(e.path, p))) return { ok: false, reason: 'path_not_allowlisted', path: e.path };
    if (deny.some((p) => matchesDeny(e.path, p))) return { ok: false, reason: 'path_denylisted', path: e.path };
    const lower = e.path.toLowerCase();
    const prior = lowerSeen.get(lower);
    if (prior !== undefined && prior !== e.path) return { ok: false, reason: 'path_case_collision', path: e.path };
    lowerSeen.set(lower, e.path);
    // Directory prefixes must not collide case-insensitively either.
    const dirs = e.path.split('/').slice(0, -1);
    for (let i = 1; i <= dirs.length; i += 1) {
      const d = dirs.slice(0, i).join('/');
      const pd = lowerSeen.get(`${d.toLowerCase()}/`);
      if (pd !== undefined && pd !== `${d}/`) return { ok: false, reason: 'path_case_collision', path: e.path };
      lowerSeen.set(`${d.toLowerCase()}/`, `${d}/`);
    }
    const size = e.size ?? -1;
    if (size < 0 || size > STAGING_LIMITS.maxFileBytes) return { ok: false, reason: 'path_file_too_large', path: e.path };
    total += size;
    files.push({ path: e.path, size });
    if (files.length > STAGING_LIMITS.maxFiles) return { ok: false, reason: 'staging_too_many_files' };
    if (total > STAGING_LIMITS.maxTotalBytes) return { ok: false, reason: 'staging_too_large' };
  }
  if (files.length === 0) return { ok: false, reason: 'paths_no_files' };
  return { ok: true, files, totalBytes: total };
}

/** Parses `git ls-tree -r -l -z <commit>` output into entries (NUL-separated). */
export function parseLsTreeZ(output: string): TreeEntry[] {
  return output.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    if (tab < 0) throw new Error('ls_tree_malformed');
    const [mode, type, , sizeRaw] = rec.slice(0, tab).trim().split(/\s+/);
    if (!['blob', 'tree', 'commit'].includes(type)) throw new Error('ls_tree_malformed');
    return { mode, type: type as TreeEntry['type'], size: sizeRaw === '-' ? null : Number(sizeRaw), path: rec.slice(tab + 1) };
  });
}
