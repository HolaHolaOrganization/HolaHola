/**
 * episode-content-loss-guard.ts
 *
 * Core, git-runner-agnostic logic that detects when a change to a
 * `docs/episode-<N>.md` file would silently remove real conversation history.
 *
 * Background (task #1529): a commit that bundles unrelated work with a stale
 * read of an episode file can blindly overwrite it, dropping real dialogue
 * that the live chat-capture pipeline appended in the meantime. This has
 * happened twice (confirmed by git-blob forensics):
 *   - 2026-08-31: an unrelated "Update agent memory logs" commit wiped
 *     episode-27.md to 0 bytes and truncated episode-28.md by ~237KB.
 *   - 2026-09-21: an unrelated auth-work commit deleted a real closing
 *     exchange from episode-34.md and replaced it with different content —
 *     the file's *total size grew*, so a shrinkage/size-only check (see
 *     restore-episode-27-from-db.ts / restore-episode-28-from-db.ts) would
 *     not have caught it.
 *
 * Known false-positive class (fixed 2026-09-22, this guard's first day in
 * production): docs/episode-<N>.md paths are also used as throwaway CI test
 * fixtures by scripts written before this guard existed (e.g.
 * server/scripts/test-chat-episode-hook-e2e.ts writes docs/episode-9993.md
 * as setup and unlinks it as teardown). Each task agent runs in its own
 * isolated environment, so nothing forces a commit to wait for another
 * repl's background test to finish cleaning up — a fixture file can be
 * mid-lifecycle (present on disk) at the exact moment an unrelated commit's
 * `git add -A` sweeps it in. A later, unrelated commit made without that
 * stray file then looks, to a path-and-content-only check, exactly like
 * real content loss. See RESERVED_FIXTURE_EPISODE_MIN below for the fix.
 *
 * Detection is content-based, not size-based: every non-trivial line present
 * in the "old" version of a protected episode file must still be present
 * somewhere in the "new" version, unless an explicit override doc is present
 * in the same change. A line that was removed from one place but still
 * exists verbatim elsewhere in the new file (a legitimate dedup) is *not* a
 * violation — plain set-membership already implements that exception
 * correctly, with no separate multiset/counting logic required.
 *
 * This module never mutates git state — it only reads via an injected
 * `GitRunner`, so it can run from a CLI (server/scripts/check-episode-
 * content-loss.ts), be embedded in server/services/source-control-service.ts
 * (the sole authority for git mutations in this repo — see
 * server/scripts/test-source-control-mutation-boundary.ts), or run against a
 * hermetic temp repo in a self-check.
 */

import { verifyEpisodeClaudeAttributionReceipt } from './episode-claude-attribution-repair';
import { runtimeNoticeRelabelReceiptPath, verifyRuntimeNoticeRelabelReceipt } from './runtime-notice-relabel';

/** Matches exactly `docs/episode-<digits>.md` — not gap-analysis docs, not
 *  prequel episodes, not the attribution taxonomy, not `docs/episodes/*`.
 *  Captures the digits so isProtectedEpisodeFile can apply the fixture-range
 *  exclusion below. */
export const EPISODE_FILE_PATTERN = /^docs\/episode-(\d+)\.md$/;

/**
 * Episode numbers at or above this threshold are reserved for CI/test
 * fixtures, never real conversation content — a pre-existing convention
 * independently used by many test scripts written before this guard
 * existed: docs/episode-9993.md (chat-episode-hook e2e), -9994.md (CI
 * sentinel guard, team-room e2e), -9995.md (append trigger), -9997.md /
 * -9998.md (concurrent-write), -9999.md (watcher-fires, several inner-life
 * fixtures), plus a 5-digit random 90000-99999 range in
 * test-inner-life-db-first.ts. Real episodes are sequential from low
 * numbers (27, 28, 34, ...) and will not approach this range.
 *
 * See the module docstring's "Known false-positive class" note for why
 * fixture files need this exclusion even though their own tests correctly
 * clean them up in the normal case.
 */
export const RESERVED_FIXTURE_EPISODE_MIN = 9900;

/**
 * A small number of CI fixtures predate the 9900+ range convention above and
 * use a bare low episode number instead. Confirmed member:
 * server/scripts/test-rolling-sync-guard.ts writes real content directly to
 * `docs/episode-99.md` in the actual repo checkout (not a temp dir; DB
 * fixture id `99000000-0000-4000-8000-000000000099`) as part of exercising
 * rolling-episode DB-vs-file sync. Same false-positive mechanics as the
 * 9900+ class: its normal create/delete lifecycle can be swept into an
 * unrelated commit by that commit's own `git add -A` while the fixture is
 * mid-lifecycle on disk. Confirmed 2026-09-25: exactly this blocked two
 * consecutive, otherwise-unrelated task merges on this file/content
 * (`# Episode 99` + the fixture's literal `B`-repeat body). Kept as an
 * explicit allowlist (not folded into the range) because there is no open
 * convention here — just this one legacy fixture number.
 */
export const LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS: ReadonlySet<number> = new Set([99]);

/** Presence (not content) of a matching file in the same change authorizes
 *  removal of real content — mirrors the exact convention already
 *  established by scripts/gemini-gate-check.sh's docs/gemini-audit-*.md
 *  presence check. The override is logged: it stays in git history and is
 *  named in the guard's own output. */
export const OVERRIDE_DOC_PATTERN = /^docs\/episode-content-loss-override-.*\.md$/;

/**
 * A line that carries no narrative content of its own: blank/whitespace,
 * a markdown horizontal rule, or a single-line HTML comment (episode files
 * carry volatile per-sync metadata as HTML comments, e.g.
 * `<!-- chat-capture-range:422877:423895 -->` — these are regenerated
 * bookkeeping, not conversation history).
 */
export function isTrivialLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (line === '') return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return true;
  if (/^<!--.*-->$/.test(line)) return true;
  return false;
}

/** Trailing-whitespace/CR normalization only — leading whitespace and case
 *  are left untouched since markdown indentation and quoted text can be
 *  meaningful in episode dialogue. */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').replace(/[ \t]+$/, '');
}

/** Non-trivial lines of `content`, normalized, duplicates preserved in
 *  order (callers that need membership-only semantics should use a Set). */
export function nonTrivialLines(content: string): string[] {
  return content
    .split('\n')
    .map(normalizeLine)
    .filter((line) => !isTrivialLine(line));
}

/**
 * Returns every non-trivial line present in `oldContent` that is absent
 * from *anywhere* in `newContent` — i.e. real content that was removed and
 * not merely relocated or de-duplicated. Order-preserving, deduplicated.
 */
export function findContentLossViolations(oldContent: string, newContent: string): string[] {
  const oldLines = nonTrivialLines(oldContent);
  const newLineSet = new Set(nonTrivialLines(newContent));
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const line of oldLines) {
    if (!newLineSet.has(line) && !seen.has(line)) {
      violations.push(line);
      seen.add(line);
    }
  }
  return violations;
}

export function isProtectedEpisodeFile(path: string): boolean {
  const match = EPISODE_FILE_PATTERN.exec(path);
  if (!match) return false;
  const episodeNumber = Number(match[1]);
  if (LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS.has(episodeNumber)) return false;
  return episodeNumber < RESERVED_FIXTURE_EPISODE_MIN;
}

export function isOverrideDoc(path: string): boolean {
  return OVERRIDE_DOC_PATTERN.test(path);
}

/** Minimal git command shape both a real repo runner and a hermetic
 *  temp-repo runner can satisfy. Read-only commands only (diff/show/
 *  ls-tree/rev-parse) — this module must never issue a mutating git
 *  command. */
export type GitRunner = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

async function resolveCommit(runGit: GitRunner, ref: string): Promise<string> {
  const result = await runGit(['rev-parse', '--verify', `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !sha) {
    throw new Error(
      `episode-content-loss-guard: could not resolve "${ref}" to a commit — refusing to run ` +
      `the check against an unverified ref rather than silently skipping it.`,
    );
  }
  return sha;
}

export async function listChangedFiles(runGit: GitRunner, oldSha: string, newSha: string): Promise<string[]> {
  const result = await runGit(['diff', '--no-renames', '--name-only', oldSha, newSha]);
  if (result.exitCode !== 0) {
    throw new Error(`episode-content-loss-guard: git diff --name-only failed between ${oldSha} and ${newSha}`);
  }
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export interface TreeEntry {
  mode: string;
  type: string;
  path: string;
}

/**
 * Looks up `path` in the tree at `sha` via `ls-tree`. Unlike `git show`,
 * `ls-tree` only needs tree/commit objects — never the blob's own content —
 * so it stays reliable under a partial clone (`--filter=blob:none`, used by
 * `fetchHeads()`) where blob fetches can fail independently of the tree
 * walk. Returns `null` when the path is genuinely absent at that ref (a
 * real, non-error state: new file, or removed at that ref); throws if the
 * lookup itself fails, since that means we cannot determine the truth and
 * must not guess.
 */
export async function lsTreeEntry(runGit: GitRunner, sha: string, path: string): Promise<TreeEntry | null> {
  const result = await runGit(['ls-tree', sha, '--', path]);
  if (result.exitCode !== 0) {
    throw new Error(
      `episode-content-loss-guard: "git ls-tree ${sha} -- ${path}" failed — refusing to guess whether ` +
      `"${path}" exists at ${sha} rather than risk treating a real lookup failure as "file absent".`,
    );
  }
  const line = result.stdout.split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  const match = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
  if (!match || match[4] !== path) return null;
  return { mode: match[1], type: match[2], path: match[4] };
}

/** A regular file (data or executable blob) — excludes directories
 *  (`tree`), submodules (`commit`), and symlinks (mode `120000`), any of
 *  which would make ".md" pattern-matching alone misleading. */
export function isRegularFileEntry(entry: TreeEntry | null): boolean {
  return entry !== null && entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

/**
 * Reads `path` at `sha`. Returns '' only when `ls-tree` has confirmed the
 * path is genuinely absent from the tree at that ref (new file, or removed
 * at that ref) — never as a stand-in for a read failure. A path that
 * `ls-tree` confirms exists but whose blob content `git show` cannot read
 * (a partial-clone lazy-fetch failure, network error, or missing/corrupt
 * object) throws instead of silently returning '' — the old content this
 * guard's whole comparison depends on must never be scored as "no
 * violation" while it is actually just unknown.
 */
export async function readFileAtRef(runGit: GitRunner, sha: string, path: string): Promise<string> {
  const entry = await lsTreeEntry(runGit, sha, path);
  if (entry === null) return '';
  const result = await runGit(['show', `${sha}:${path}`]);
  if (result.exitCode !== 0) {
    throw new Error(
      `episode-content-loss-guard: "${path}" exists at ${sha} (confirmed via ls-tree) but ` +
      `"git show ${sha}:${path}" failed to read it — likely a partial-clone lazy-fetch or network ` +
      `failure. Refusing to treat this unknown content as empty, which could hide real content loss.`,
    );
  }
  return result.stdout;
}

export interface EpisodeContentLossResult {
  oldSha: string;
  newSha: string;
  /** Protected episode files touched between oldSha and newSha, sorted. */
  changedEpisodeFiles: string[];
  /** Per-file list of removed non-trivial lines, only for files with >0. */
  violations: Record<string, string[]>;
  /** Override docs present in the same change, sorted. */
  overrideDocsPresent: string[];
  /** True when real content would be lost and no override authorizes it. */
  blocked: boolean;
}

/**
 * Only the approved historical label corrections qualify: the Episode 34
 * Claude Code repair, and the runtime-notice relabel of Episodes 33 and 34.
 * Read evidence from the resolved incoming commit, never from mutable
 * working-tree files. Missing/malformed evidence leaves ordinary loss
 * detection intact; unknown Git state must throw rather than authorize a repair.
 */
async function hasVerifiedAttributionRepair(
  runGit: GitRunner,
  newSha: string,
  path: string,
  oldContent: string,
  newContent: string,
): Promise<boolean> {
  const noticeReceiptPath = runtimeNoticeRelabelReceiptPath(path);
  if (noticeReceiptPath && isRegularFileEntry(await lsTreeEntry(runGit, newSha, noticeReceiptPath))) {
    const content = await readFileAtRef(runGit, newSha, noticeReceiptPath);
    let receipt: unknown = null;
    try {
      receipt = JSON.parse(content);
    } catch {
      receipt = null;
    }
    if (verifyRuntimeNoticeRelabelReceipt(path, oldContent, newContent, receipt)) return true;
  }
  if (path !== 'docs/episode-34.md') return false;
  const receiptPaths = [
    'docs/episode-34-attribution-repair-evidence.json',
    'docs/episode-34-attribution-repair-backfill-evidence.json',
    'docs/episode-34-attribution-repair-post-merge-evidence.json',
    'docs/episode-34-attribution-repair-validation-startup-evidence.json',
  ];
  for (const receiptPath of receiptPaths) {
    if (!isRegularFileEntry(await lsTreeEntry(runGit, newSha, receiptPath))) continue;
    const content = await readFileAtRef(runGit, newSha, receiptPath);
    let receipt: unknown;
    try {
      receipt = JSON.parse(content);
    } catch {
      continue;
    }
    if (verifyEpisodeClaudeAttributionReceipt(oldContent, newContent, receipt)) return true;
  }
  return false;
}

/**
 * Orchestrates the full check for one old/new ref pair: resolves both refs
 * to commits (throws rather than silently passing if either is invalid),
 * finds changed protected episode files, diffs each for content loss, and
 * applies the override-doc exception.
 */
export async function checkEpisodeContentLoss(
  runGit: GitRunner,
  oldRef: string,
  newRef: string,
): Promise<EpisodeContentLossResult> {
  const [oldSha, newSha] = await Promise.all([resolveCommit(runGit, oldRef), resolveCommit(runGit, newRef)]);

  const changedFiles = await listChangedFiles(runGit, oldSha, newSha);
  const changedEpisodeFiles = changedFiles.filter(isProtectedEpisodeFile).sort();

  // An override path merely appearing in the changed-files diff is not
  // enough — that list also includes a path that used to be an override doc
  // and was just *deleted*. Only a path that still exists as a regular file
  // at newSha actually authorizes anything landing in this same change.
  const overrideCandidates = changedFiles.filter(isOverrideDoc).sort();
  const overrideDocsPresent: string[] = [];
  for (const path of overrideCandidates) {
    const entry = await lsTreeEntry(runGit, newSha, path);
    if (isRegularFileEntry(entry)) overrideDocsPresent.push(path);
  }

  const violations: Record<string, string[]> = {};
  for (const path of changedEpisodeFiles) {
    const [oldContent, newContent] = await Promise.all([
      readFileAtRef(runGit, oldSha, path),
      readFileAtRef(runGit, newSha, path),
    ]);
    const fileViolations = findContentLossViolations(oldContent, newContent);
    if (fileViolations.length > 0 &&
        !await hasVerifiedAttributionRepair(runGit, newSha, path, oldContent, newContent)) {
      violations[path] = fileViolations;
    }
  }

  const hasViolations = Object.keys(violations).length > 0;
  const blocked = hasViolations && overrideDocsPresent.length === 0;

  return { oldSha, newSha, changedEpisodeFiles, violations, overrideDocsPresent, blocked };
}
