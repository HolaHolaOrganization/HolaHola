/**
 * Read confinement for Alden's file tools (gated-fixes design e4f8e988, P2,
 * approved 2026-10-30).
 *
 * read_file, list_directory, search_code and search_multi share one policy:
 *
 * - An explicit allowed root, not the workspace root: the directories below,
 *   three read-only directories, and an exact list of top-level files.
 *   Everything else (attached_assets/, uploads/, public/, top-level test
 *   scripts and fine-tuning exports among them) is outside it.
 * - The path is joined to the workspace and then realpath'd. Absolute paths,
 *   `..` escapes and symlinks that resolve outside the allowed root are refused.
 * - Secret exclusions apply after resolution, by path and by content.
 *
 * The read-only directories are readable here; 2c makes them refused as an
 * edit target.
 */
import fs from 'node:fs';
import path from 'node:path';

export const ALDEN_READ_DIRS: readonly string[] = Object.freeze(['client', 'server', 'shared', 'scripts', 'docs', 'migrations', 'broker', 'config']);
export const ALDEN_READ_ONLY_DIRS: readonly string[] = Object.freeze(['.agents/memory', '.agents/skills', '.github/workflows']);
export const ALDEN_READ_TOP_FILES: readonly string[] = Object.freeze([
  'Dockerfile', '.dockerignore', 'render.yaml', 'package.json', 'tsconfig.json', 'drizzle.config.ts',
  'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'components.json', 'capacitor.config.ts',
  '.gitattributes', 'replit.md', 'AGENTS.md', 'CLAUDE.md',
]);

const EXCLUDED_SEGMENTS = new Set(['.local', '.git', 'node_modules', 'dist']);
const KEY_FILE = /\.(pem|key|p12|pfx|jks|keystore)$/i;
// Credential and keystore *data* files. Source files that merely mention the
// word (credential-broker.ts) stay readable; their content is still checked.
const CREDENTIAL_WORD = /credential|secret|keystore|service[-_]?account/i;
const DATA_EXTENSIONS = new Set(['', '.json', '.yaml', '.yml', '.txt', '.ini', '.cfg', '.conf', '.properties', '.xml', '.csv', '.env']);
function isCredentialDataFile(base: string): boolean {
  return CREDENTIAL_WORD.test(base) && DATA_EXTENSIONS.has(path.extname(base).toLowerCase());
}

/**
 * High-precision credential shapes, checked before any content is returned.
 * Wren's broad "key = '…'" heuristic is deliberately not reused: it matches
 * ordinary test fixtures and would make most of the codebase unreadable.
 * Its precise patterns (private key, Stripe, GitHub, Slack) are included.
 */
export const SECRET_CONTENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'Stripe secret key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { name: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'OpenAI or Anthropic key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'database URL with password', pattern: /\bpostgres(?:ql)?:\/\/[^\s:/@'"`]+:[^\s@'"`]{8,}@[^\s'"`]+/ },
]);

export type ReadKind = 'file' | 'dir' | 'root' | 'ancestor';
export type AldenReadDecision =
  | { ok: true; abs: string; rel: string; kind: ReadKind }
  | { ok: false; reason: string };

/** The secret-content finding for a text, or null. */
export function secretContentReason(text: string): string | null {
  for (const { name, pattern } of SECRET_CONTENT_PATTERNS) if (pattern.test(text)) return name;
  return null;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Why a workspace-relative (posix) path is excluded as secret, or null. */
export function secretPathReason(rel: string): string | null {
  const segments = rel.split('/');
  for (const segment of segments) {
    if (EXCLUDED_SEGMENTS.has(segment)) return `${segment}/ is excluded`;
    if (/^\.env/i.test(segment)) return '.env files are excluded';
  }
  const base = segments[segments.length - 1];
  if (KEY_FILE.test(base)) return 'key and certificate files are excluded';
  if (/^id_/.test(base)) return 'SSH key files are excluded';
  if (isCredentialDataFile(base)) return 'credential and keystore files are excluded';
  return null;
}

/** Where a workspace-relative (posix) path sits in the allowed root. */
export function classifyAldenReadPath(rel: string): ReadKind | null {
  if (rel === '') return 'root';
  if (ALDEN_READ_TOP_FILES.includes(rel)) return 'file';
  const top = rel.split('/')[0];
  if (ALDEN_READ_DIRS.includes(top)) return 'dir';
  for (const dir of ALDEN_READ_ONLY_DIRS) {
    if (rel === dir || rel.startsWith(`${dir}/`)) return 'dir';
    if (dir.startsWith(`${rel}/`)) return 'ancestor';
  }
  return null;
}

function realRoot(root: string): string {
  return fs.realpathSync(root);
}

/**
 * Resolve a model-supplied path under the policy. `kind` is 'dir' for anything
 * inside an allowed directory (file or directory), 'file' for an allowed
 * top-level file, 'root' for the workspace itself and 'ancestor' for a parent
 * of a read-only directory (.agents, .github); the last two are listable but
 * hold nothing readable themselves.
 */
export function resolveAldenReadPath(input: unknown, root: string): AldenReadDecision {
  if (typeof input !== 'string') return { ok: false, reason: 'a path is required' };
  const raw = input.trim() === '' ? '.' : input.trim();
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    return { ok: false, reason: 'absolute paths are refused; use a path relative to the workspace' };
  }
  const lexical = toPosix(path.normalize(raw)).replace(/\/+$/, '');
  if (lexical === '..' || lexical.startsWith('../')) return { ok: false, reason: 'paths outside the workspace are refused' };
  const rootReal = realRoot(root);
  let real: string;
  try {
    real = fs.realpathSync(path.join(root, lexical === '.' ? '' : lexical));
  } catch {
    return { ok: false, reason: `not found: ${raw}` };
  }
  const relNative = path.relative(rootReal, real);
  if (relNative.startsWith('..') || path.isAbsolute(relNative)) return { ok: false, reason: 'the path resolves outside the workspace' };
  const rel = toPosix(relNative);
  const secret = secretPathReason(rel);
  if (secret) return { ok: false, reason: secret };
  const kind = classifyAldenReadPath(rel);
  if (!kind) return { ok: false, reason: `${rel} is outside Alden's readable root` };
  return { ok: true, abs: real, rel, kind };
}

/**
 * Whether a workspace-relative (posix) result path may be shown, by path and
 * then by the file's content. `contentCache` avoids rereading a file per line.
 */
export function aldenReadablePath(rel: string, root: string, contentCache: Map<string, boolean> = new Map()): boolean {
  const cached = contentCache.get(rel);
  if (cached !== undefined) return cached;
  const decision = resolveAldenReadPath(rel, root);
  let ok = decision.ok && (decision.kind === 'dir' || decision.kind === 'file');
  if (ok && decision.ok) {
    try {
      ok = fs.statSync(decision.abs).isFile() && !secretContentReason(fs.readFileSync(decision.abs, 'utf8'));
    } catch {
      ok = false;
    }
  }
  contentCache.set(rel, ok);
  return ok;
}

/**
 * The readable search roots under a resolved directory: the directory itself
 * when it is inside an allowed directory, or the allowed directories and
 * top-level files beneath the workspace root or a read-only ancestor.
 */
export function aldenSearchRoots(decision: Extract<AldenReadDecision, { ok: true }>, root: string): string[] {
  if (decision.kind === 'dir' || decision.kind === 'file') return [decision.rel];
  const prefix = decision.kind === 'root' ? '' : `${decision.rel}/`;
  const candidates = [...ALDEN_READ_DIRS, ...ALDEN_READ_ONLY_DIRS, ...ALDEN_READ_TOP_FILES].filter((p) => p.startsWith(prefix));
  return candidates.filter((p) => resolveAldenReadPath(p, root).ok);
}
