/**
 * detect-episode-dialogue-loss.ts
 *
 * Detects disappearing episode dialogue automatically instead of relying on
 * manual line-by-line git-history audits.
 *
 * Background: the Sep 21 2026 episode-34 incident (commit 8917df2) deleted a
 * real David/Luca closing exchange ("Good session. Enjoy the rest of your
 * day." and the surrounding Goodhart's-law exchange) while APPENDING
 * unrelated new content in the SAME commit — the file's total byte size
 * actually GREW (297985 → 300823 bytes) even though real dialogue vanished.
 * It sat undetected for ~30 hours because every existing safety net
 * (restore-rolling-episodes-from-db.ts --check-shrinkage, plain size/length
 * comparisons) only fires on NET shrinkage. This tool instead diffs actual
 * paragraph-level CONTENT between two states of a file, regardless of
 * whether the total size grew or shrank.
 *
 * Four independent comparison sources:
 *   1. git history — the current on-disk content vs. the commit(s) that most
 *      recently touched the file. Default mode only evaluates transitions
 *      whose NEWER commit lands within RECENCY_WINDOW_HOURS (72h) of "now" —
 *      this is what makes the check same-day-forward-looking instead of
 *      permanently re-flagging old, already-settled editorial history on
 *      every run (see RECENCY_WINDOW_HOURS below for a real example this
 *      guards against). --full-history walks every consecutive commit pair
 *      in the file's whole history, ignoring recency, for a deliberate
 *      one-time/periodic audit. A transition whose newer side is a deletion
 *      (the file stopped existing at that commit) is NOT skipped — it is
 *      treated as a total loss of everything that existed on the older side.
 *      This is the BLOCKING/PRIMARY signal: it does not depend on any other
 *      system being uncorrupted, and it is what fails the run (exit 2).
 *   2. target-currently-missing — an ALWAYS-ON check (never recency-gated)
 *      that asks "does this target's file exist right now, on disk?" A
 *      target is discovered because it is DB-tagged rolling/rolling-
 *      protected or has any git history at all — either way it is expected
 *      to have a live, current .md. If it does not, that is the single most
 *      severe disappearance case this tool exists to catch (the ENTIRE
 *      episode's dialogue, not just a paragraph within it). This must never
 *      depend on the recency window: recency-gating exists to stop
 *      re-litigating old, ambiguous editorial rewrites, not to give a
 *      permanently-deleted active file a free pass just because nothing
 *      "recent" touched it. Also BLOCKING.
 *   3. working tree vs HEAD — catches a loss that has not been committed
 *      yet. Always checked (not recency-gated: "different from HEAD right
 *      now" is inherently current). Also BLOCKING.
 *   4. conversation_memories DB row (the episode's own whole-content column,
 *      the same row synced by server/scripts/sync-episode-34.ts and friends)
 *      vs the current .md — INFORMATIONAL ONLY, never fails the run on its
 *      own. Caveat: in the real incident, the bad .md was synced INTO this
 *      DB row before the fix, so DB and .md can be corrupted from the same
 *      source and this check alone would show no diff; it also has no
 *      commit-level granularity to tell you which change caused a
 *      difference. It supplements signal #1 as a corroborating data point;
 *      it does not replace it and does not block by itself.
 *
 * Comparison unit: paragraphs (blocks separated by one or more blank lines,
 * ALSO split before any markdown heading line even without a preceding
 * blank line — found necessary against a real "Git commit prior to merge"
 * auto-snapshot commit where a doubled/concatenated file had a paragraph's
 * closing sentence glued directly onto a `# Episode NN — ...` header at the
 * seam between the two copies; without the heading split, that oversized
 * glued unit could never match as a contiguous substring elsewhere even
 * though the paragraph's real text was fully intact). Within each block,
 * lines that are ENTIRELY an HTML comment (e.g.
 * `<!-- inner-life:felt:<timestamp>:<hash> -->`) are stripped before
 * comparison — these carry volatile per-write metadata, and episode-34.md is
 * known to contain legitimate near-duplicate inner-life blocks that differ
 * only in that metadata. This stripping is applied IDENTICALLY to both sides
 * of every comparison (the old block being searched for, and the full new/
 * tip text being searched within) — a metadata comment inserted into an
 * otherwise-unchanged paragraph must never by itself create a false "lost"
 * report by breaking substring contiguity on only one side.
 *
 * A block is reported LOST when its normalized text does not appear ANYWHERE
 * (as a substring) in the normalized full text of the newer version. This is
 * robust to reordering and to blank-line/reflow differences that would
 * confuse a naive line-by-line diff.
 *
 * "Safe revert" guard: if the newer version's full normalized content is
 * byte-identical to some STRICTLY EARLIER commit in the same file's own git
 * history, the transition is a deliberate revert to a known-good state, not
 * silent corruption — losses are not reported for that transition.
 *
 * "Still missing at tip" guard: a block lost in one commit-pair transition
 * but present again in a LATER commit within the same checked window (i.e.
 * a same-day self-heal) does not fail the run — the task this tool exists
 * for asks whether content is absent NOW, and self-healed history is not
 * absent now. It is still logged (non-blocking) so the event stays visible.
 * A CI run at the time of the original loss commit would still have failed,
 * since nothing later existed yet to recover it.
 *
 * Exit codes:
 *   0 — clean (no loss detected)
 *   1 — fatal error (git unavailable, no target files found, fixture missing)
 *   2 — loss detected
 *
 * Usage:
 *   npx tsx server/scripts/detect-episode-dialogue-loss.ts
 *   npx tsx server/scripts/detect-episode-dialogue-loss.ts --full-history
 *   npx tsx server/scripts/detect-episode-dialogue-loss.ts --self-check
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { neon } from '@neondatabase/serverless';
import { LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS } from '../services/episode-content-loss-guard';
import { attributionSha256, verifyEpisodeClaudeAttributionReceipt } from '../services/episode-claude-attribution-repair';
import { RUNTIME_NOTICE_LABEL, runtimeNoticeRelabelReceiptPath, verifyRuntimeNoticeRelabelReceipt } from '../services/runtime-notice-relabel';

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const sep = () => console.log('\n' + '─'.repeat(70));

const REPO_ROOT = process.cwd();

// Explicit receipts for the approved historical repair, never a global
// Claude Code alias or an exemption by filename/label. The verifier requires
// complete old/new snapshot hashes and reconstructs every exact label span.
function readEpisodeAttributionReceipts(repoRoot: string, relPath: string): unknown[] {
  const noticeReceipt = runtimeNoticeRelabelReceiptPath(relPath);
  const notice = noticeReceipt ? readReceiptFiles(repoRoot, [noticeReceipt]) : [];
  if (relPath !== 'docs/episode-34.md') return notice;
  return [...notice, ...readReceiptFiles(repoRoot, [
    'docs/episode-34-attribution-repair-evidence.json',
    'docs/episode-34-attribution-repair-backfill-evidence.json',
    'docs/episode-34-attribution-repair-post-merge-evidence.json',
    'docs/episode-34-attribution-repair-validation-startup-evidence.json',
  ])];
}

function readReceiptFiles(repoRoot: string, filenames: string[]): unknown[] {
  return filenames.flatMap(filename => {
    try {
      return [JSON.parse(readFileSync(join(repoRoot, filename), 'utf8')) as unknown];
    } catch {
      // Missing or malformed evidence never suppresses the ordinary check.
      return [];
    }
  });
}

/**
 * Minimum normalized length (chars) for a paragraph block to be eligible for
 * loss reporting. Filters noise (bare "---" separators, stray markers) while
 * still catching short but real dialogue lines — e.g. the real deleted
 * sign-off "Good session. Enjoy the rest of your day." normalizes to 43
 * chars, comfortably above this floor.
 */
const MIN_BLOCK_CHARS = 25;

/** How many prior commits (fast default mode) form the "is this a safe
 *  revert to a genuinely earlier state" pool, in addition to the one
 *  transition actually being checked. */
const FAST_MODE_HISTORY_WINDOW = 20;

/**
 * Default (non --full-history) mode only evaluates transitions whose NEWER
 * commit lands within this many hours of "now". This is what keeps the tool
 * forward-looking and CI-safe: it catches loss introduced recently ("same
 * day", per the task this tool exists for) without permanently re-flagging
 * old, already-settled editorial history every single run. A large one-time
 * consolidation/dedup commit from weeks ago (real example found while
 * building this: episode-31.md's 2026-09-01 commit removed a 1,696-line
 * verbatim historical-source insert, and episode-33.md had a similar
 * 2026-09-09 rewrite) is exactly the kind of ambiguous historical edit that
 * belongs in a deliberate --full-history audit, not an automatic blocking
 * gate that never stops complaining about it. This window does NOT apply to
 * the target-currently-missing check (see checkFileCurrentlyMissing) — a
 * permanently deleted file is never "old, settled history" in the same
 * sense.
 */
const RECENCY_WINDOW_HOURS = 72;

// ─────────────────────────────────────────────────────────────────────────
// Core comparison logic (pure — no git/DB/fs access). Exported for reuse and
// for direct exercise from --self-check.
// ─────────────────────────────────────────────────────────────────────────

export interface LostBlock {
  /** Normalized (lowercased, whitespace-collapsed, comment-stripped) text
   *  used for matching. */
  normalized: string;
  /** Original block text (pre-normalization) for human-readable reporting. */
  original: string;
}

/** Collapse whitespace and lowercase — matches the `norm()` convention used
 *  elsewhere in this codebase's episode-sync scripts
 *  (test-rolling-episode-gap-check.ts). */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strip lines that are ENTIRELY an HTML comment (e.g.
 * `<!-- inner-life:felt:<timestamp>:<hash> -->`) — these carry volatile
 * per-write metadata, and episode-34.md is known to contain legitimate
 * near-duplicate inner-life blocks that differ only in that metadata.
 *
 * Applied identically on BOTH sides of every comparison (see findLostBlocks
 * and stillMissingAtTip below). Stripping only the "old" side while leaving
 * a raw, un-stripped "new" side would let a bare metadata comment inserted
 * into the middle of an otherwise word-for-word-unchanged paragraph break
 * substring contiguity on the new side only, producing a false "lost"
 * report for content that is fully intact.
 */
function stripCommentLines(content: string): string {
  return content.split('\n').filter(line => !/^\s*<!--.*-->\s*$/.test(line)).join('\n');
}

/**
 * Split content into paragraph blocks (separated by 1+ blank lines), strip
 * HTML-comment-only lines from each block before normalizing, and drop
 * blocks that normalize to fewer than MIN_BLOCK_CHARS characters.
 *
 * Blank lines are also NOT trusted as the only boundary: a markdown heading
 * (`# ...` through `###### ...`) always starts a new block even when the
 * preceding line runs directly into it with no blank line. Real example
 * found while building this: a "Git commit prior to merge" auto-snapshot
 * commit (585,944 bytes vs. this file's normal ~293,000 — an artifact of a
 * doubled/concatenated pre-merge state) had a real dialogue paragraph's
 * closing sentence glued, with no blank line, directly onto the very next
 * line: `# Episode 34 — "One Luca, Many Hats"` — the document's own top
 * header, reappearing mid-file at the seam between the two concatenated
 * copies. Without this extra split, that one paragraph and the unrelated
 * header would be treated as a single oversized comparison unit that could
 * never match as a contiguous substring elsewhere even though the
 * paragraph's actual text was fully intact. Splitting on headings regardless
 * of blank-line hygiene removes that whole class of false positive.
 */
function extractBlocks(content: string): LostBlock[] {
  const blankSplitBlocks = content.split(/\n\s*\n+/);
  const rawBlocks: string[] = [];
  for (const chunk of blankSplitBlocks) {
    const lines = chunk.split('\n');
    let current: string[] = [];
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line) && current.length > 0) {
        rawBlocks.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) rawBlocks.push(current.join('\n'));
  }

  const blocks: LostBlock[] = [];
  for (const raw of rawBlocks) {
    const stripped = stripCommentLines(raw);
    const normalized = norm(stripped);
    if (normalized.length < MIN_BLOCK_CHARS) continue;
    blocks.push({ normalized, original: raw.trim() });
  }
  return blocks;
}

/**
 * Return every block present in `oldContent` whose normalized text does NOT
 * appear anywhere in the normalized full text of `newContent`.
 *
 * Deliberately insensitive to file size — a block is "lost" purely because
 * its own text vanished, regardless of how much other text was added
 * elsewhere in the same transition. This is what makes it catch the real
 * Sep 21 2026 incident, where the file's total size GREW in the very commit
 * that deleted real dialogue.
 *
 * `newContent` is comment-stripped before normalizing, matching the
 * stripping already applied to each `oldContent` block by extractBlocks() —
 * see stripCommentLines() for why this symmetry matters.
 */
export function findLostBlocks(oldContent: string, newContent: string, attributionReceipts: unknown[] = [], relPath?: string): LostBlock[] {
  if (attributionReceipts.some(receipt =>
    verifyEpisodeClaudeAttributionReceipt(oldContent, newContent, receipt) ||
    (relPath !== undefined && verifyRuntimeNoticeRelabelReceipt(relPath, oldContent, newContent, receipt)))) return [];
  const oldBlocks = extractBlocks(oldContent);
  const newNorm = norm(stripCommentLines(newContent));
  return oldBlocks.filter(b => !newNorm.includes(b.normalized));
}

/**
 * Compute lost blocks for a single old→new content transition, where either
 * side may be `null` to mean "the file did not exist / could not be read at
 * that point" (e.g. before creation, or after deletion).
 *
 * A file that existed before (`oldContent` non-null) and is now completely
 * gone (`newContent` null) has ALL of its content lost — this is treated as
 * `newContent === ''` rather than being silently skipped. Skipping any pair
 * where either side is null (the original bug) meant a real whole-file
 * deletion produced NO report at all: the newer commit's content genuinely
 * cannot be read, so the transition was treated as "nothing to compare"
 * instead of "everything that existed before is now gone".
 *
 * A file with no prior content (`oldContent` null — e.g. it was just
 * created) has nothing to have lost, so this returns `[]` rather than
 * diffing the new content against an empty string for the wrong conceptual
 * reason.
 */
export function findLostBlocksForTransition(oldContent: string | null, newContent: string | null, attributionReceipts: unknown[] = [], relPath?: string): LostBlock[] {
  if (oldContent === null) return [];
  return findLostBlocks(oldContent, newContent ?? '', attributionReceipts, relPath);
}

/**
 * True when `newContent`'s normalized full text is byte-identical to the
 * normalized full text of one of `historicalContents` — i.e. this transition
 * is a deliberate revert to a genuinely earlier known state of the file, not
 * silent corruption. Losses are not reported for such a transition.
 */
export function isSafeRevert(newContent: string, historicalContents: string[]): boolean {
  const newNorm = norm(newContent);
  return historicalContents.some(h => norm(h) === newNorm);
}

/**
 * Filter `lost` blocks down to the ones that are STILL absent from
 * `tipContent` (the current, most-up-to-date state of the file — working
 * tree if it differs from HEAD, otherwise HEAD).
 *
 * A block that disappeared in one commit but reappeared in a later commit
 * within the same checked window was a real, alarm-worthy transition AT THE
 * TIME — a CI run right after the loss commit would correctly have failed —
 * but by the time this tool is run later and looks back across a window of
 * history, reporting it as a live, actionable failure today would be a false
 * alarm: the task this tool exists for asks whether content is "absent now",
 * and self-healed history is not absent now. Those transitions are still
 * surfaced (informationally, non-blocking) so the historical event remains
 * visible for audit — they just do not fail the run.
 *
 * `tipContent` is comment-stripped before normalizing, for the same
 * symmetry reason as findLostBlocks().
 */
export function stillMissingAtTip(lost: LostBlock[], tipContent: string): LostBlock[] {
  const tipNorm = norm(stripCommentLines(tipContent));
  return lost.filter(b => !tipNorm.includes(b.normalized));
}

// ─────────────────────────────────────────────────────────────────────────
// Git plumbing — every function takes an explicit repoRoot (no default) so
// --self-check can point the exact same code at a hermetic temp repo instead
// of this workspace's real repo.
// ─────────────────────────────────────────────────────────────────────────

function git(args: string[], repoRoot: string): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

/** Commits touching `relPath`, newest first. */
function commitsTouching(relPath: string, repoRoot: string, limit?: number): string[] {
  const args = ['log', '--format=%H', ...(limit ? ['-n', String(limit)] : []), '--', relPath];
  const out = git(args, repoRoot).trim();
  return out ? out.split('\n') : [];
}

function contentAtCommit(commit: string, relPath: string, repoRoot: string): string | null {
  try {
    // stderr is deliberately discarded: a nonexistent-at-this-commit path is
    // an EXPECTED, routinely-hit case here (checkFileCurrentlyMissing() and
    // the pairwise loop's creation/deletion edges both probe commits on
    // purpose to find where a file starts or stops existing), and git's own
    // "fatal: path ... does not exist in ..." would otherwise leak to the
    // console on every such probe, indistinguishable from a real failure.
    return execFileSync('git', ['show', `${commit}:${relPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // file did not exist at that commit
  }
}

function commitMeta(commit: string, repoRoot: string): string {
  try {
    // %cd (committer date) matches the COMMITTER-time recency gate below —
    // showing the author date here while filtering by committer date would
    // print a commit as e.g. "2 months ago" right next to a claim that it
    // landed "within the last 72h", which is confusing even though both
    // would be technically true for a cherry-picked/rebased commit.
    return git(['log', '-1', '--format=%h  %cd  %s', '--date=short', commit], repoRoot).trim();
  } catch {
    return commit;
  }
}

/**
 * Commit's COMMITTER date as epoch milliseconds, for recency filtering.
 *
 * Deliberately %ct (committer date), not %at (author date). Author date is
 * whatever the author's local clock said when the change was first authored
 * — it travels with the commit through `git commit --date=...`, rebase, and
 * cherry-pick, and can be arbitrarily old or even backdated. Committer date
 * reflects when the commit actually LANDED in this repository (a rebase or
 * cherry-pick sets a fresh committer date even when the author date is
 * preserved from months ago). This function answers "did this transition
 * land recently", so it must use the timestamp that actually tracks
 * landing, not authorship.
 */
function commitEpochMs(commit: string, repoRoot: string): number | null {
  try {
    const secs = parseInt(git(['log', '-1', '--format=%ct', commit], repoRoot).trim(), 10);
    return Number.isFinite(secs) ? secs * 1000 : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Target discovery — "active/rolling episode file" = the codebase's own
// established convention (rolling-tag-utils.ts / restore-rolling-episodes-
// from-db.ts): a conversation_memories row tagged 'rolling' or
// 'rolling-protected' in the HolaHola Episodes arc. Git history is unioned
// in alongside the DB result (not just used as a fallback when the DB is
// unavailable) so that a target survives even if ITS OWN DB row or tag is
// what disappeared in the same change that deleted its file — the DB alone
// can never report that case, since the row/tag it would need to report it
// is exactly what is gone.
// ─────────────────────────────────────────────────────────────────────────

export interface TargetFile {
  relPath: string;
  /** conversation_memories.id for the whole-episode content row, if known
   *  (used for the secondary DB-vs-.md check). */
  episodeDbId?: string;
}

/**
 * Real episode numbers currently top out at 34 (docs/episode-34.md) and
 * grow roughly one every several days — reaching even 1000 is not a
 * near-term concern. Every test/CI fixture in this codebase that creates a
 * throwaway docs/episode-N.md deliberately picks a number far above any
 * plausible real episode specifically so it can never collide with a real
 * one: episode-9993 (test-chat-episode-hook-e2e.ts), episode-9994
 * (test-episode-ci-sentinel-guard.ts), episode-9995
 * (test-episode-append-trigger.ts), episode-9997/9998
 * (test-episode-concurrent-write.ts), episode-9999
 * (test-episode-watcher-fires.ts and others). docs/episode-9993.md in
 * particular is real, git-tracked history in this repo (created and later
 * removed by that test's own fixture lifecycle) — exactly the kind of path
 * a naive "any episode-N.md ever seen in git history" scan would wrongly
 * treat as a permanently-deleted real target. Any git-history candidate at
 * or above this threshold is a test/CI fixture, never a real episode.
 *
 * One legacy fixture predates this range convention and uses a bare low
 * number instead: docs/episode-99.md is test-rolling-sync-guard.ts's
 * real-repo fixture (see LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS in
 * episode-content-loss-guard.ts — shared here rather than re-declared, so
 * the two guards can never drift apart on which legacy numbers are
 * excluded). Confirmed 2026-09-25: this detector flagged that fixture's
 * routine create/delete lifecycle as permanent content loss the same way
 * episode-content-loss-guard.ts once did, before the legacy set existed.
 */
const MAX_PLAUSIBLE_REAL_EPISODE_NUMBER = 1000;

function isTestFixtureEpisodePath(relPath: string): boolean {
  const m = /^docs\/episode-(\d+)\.md$/.exec(relPath);
  if (!m) return false;
  const episodeNumber = parseInt(m[1], 10);
  return episodeNumber >= MAX_PLAUSIBLE_REAL_EPISODE_NUMBER
    || LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS.has(episodeNumber);
}

/**
 * Pure mapping from conversation_memories rows (id + title) to target files.
 * Deliberately does NOT check whether the file currently exists on disk — a
 * target must still be checked precisely BECAUSE its file might be missing;
 * that is itself the loss this tool exists to catch. Filtering discovery by
 * `existsSync()` was the original bug: a DB-tracked rolling episode whose
 * .md had been deleted entirely simply never became a target, so nothing
 * downstream ever ran against it and the scan reported clean.
 *
 * DOES apply isTestFixtureEpisodePath(): test-rolling-sync-guard.ts inserts
 * a real 'rolling'-tagged conversation_memories row titled "Episode 99" for
 * the exact duration of its own test run — the same discoverTargetFiles()
 * DB query this function feeds can observe that row mid-test (a real,
 * confirmed race when this detector's CI step overlaps that test's suite).
 * Without this filter, the fixture-path exclusion applied to git-history
 * candidates in gitHistoryCandidateTargets() would not protect the
 * identical path when it arrives via the DB instead.
 *
 * Exported so --self-check can prove target discovery does not silently
 * drop a deleted episode, and does not pick up a known fixture row.
 */
export function dbRowsToTargets(rows: Array<{ id: string; title: string }>): TargetFile[] {
  const files: TargetFile[] = [];
  for (const row of rows) {
    const m = /^Episode\s+(\d+)/i.exec(String(row.title));
    if (!m) continue;
    const relPath = `docs/episode-${parseInt(m[1], 10)}.md`;
    if (isTestFixtureEpisodePath(relPath)) continue;
    files.push({ relPath, episodeDbId: row.id });
  }
  return files;
}

/**
 * Pure function: build the git-history-derived candidate target list from
 * the set of episode filenames that currently exist on disk and the set of
 * every episode filename that has EVER existed anywhere in this repo's git
 * history for the docs/episode-*.md pattern. Excludes known test/CI fixture
 * numbers (see MAX_PLAUSIBLE_REAL_EPISODE_NUMBER) — without this exclusion,
 * a real but no-longer-current test fixture path (docs/episode-9993.md) is
 * indistinguishable from a real episode that was permanently deleted, and
 * gets wrongly reported as a BLOCKING loss forever.
 *
 * Exported so --self-check can prove the fixture-exclusion rule directly,
 * without needing a real git repo.
 */
export function gitHistoryCandidateTargets(currentFiles: string[], historicalFiles: string[]): TargetFile[] {
  const allPaths = Array.from(new Set([...currentFiles, ...historicalFiles]));
  return allPaths
    .filter(p => /^docs\/episode-\d+\.md$/.test(p) && !isTestFixtureEpisodePath(p))
    .sort()
    .map(relPath => ({ relPath }));
}

/**
 * Merge DB-sourced targets (authoritative for "currently tagged
 * rolling/rolling-protected") with git-history-derived targets (the
 * fallback signal that survives even when a target's OWN DB row/tag is what
 * disappeared — see the target-discovery header comment above). Applied
 * with the SAME logic regardless of whether the DB was reachable: when DB
 * targets are empty (DB unavailable, or query returned nothing), the merge
 * degrades to exactly the history-derived list rather than needing a
 * separate code path.
 *
 * A path present in both wins the DB row's `episodeDbId`; a path present in
 * only one side is kept as-is. Deduplicated and sorted by relPath.
 *
 * Exported so --self-check can prove: (a) a history-only target (DB row/tag
 * gone, file still has git history) survives the merge, (b) a DB-only
 * target (e.g. brand new today, no git history yet) survives the merge, and
 * (c) a fixture path already excluded by gitHistoryCandidateTargets() stays
 * excluded (merge does not somehow reintroduce it).
 */
export function mergeTargets(dbTargets: TargetFile[], historyTargets: TargetFile[]): TargetFile[] {
  const byPath = new Map<string, TargetFile>();
  for (const t of historyTargets) byPath.set(t.relPath, t);
  for (const t of dbTargets) byPath.set(t.relPath, { ...byPath.get(t.relPath), ...t });
  return Array.from(byPath.values()).sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function discoverTargetFiles(): Promise<TargetFile[]> {
  // Git-history candidates are ALWAYS computed (not just as a fallback when
  // the DB is unavailable) — see the header comment above for why.
  const docsDir = join(REPO_ROOT, 'docs');
  const currentFiles = readdirSync(docsDir)
    .filter(f => /^episode-\d+\.md$/.test(f))
    .map(f => `docs/${f}`);
  let historicalFiles: string[] = [];
  try {
    const out = git(['log', '--pretty=format:', '--name-only', '--', 'docs/episode-*.md'], REPO_ROOT);
    historicalFiles = out.split('\n').map(l => l.trim()).filter(l => /^docs\/episode-\d+\.md$/.test(l));
  } catch {
    // best-effort; if git log fails for some reason, fall back to just currentFiles
  }
  const historyTargets = gitHistoryCandidateTargets(currentFiles, historicalFiles);

  let dbTargets: TargetFile[] = [];
  const dbUrl = process.env.NEON_SHARED_DATABASE_URL;
  if (dbUrl) {
    try {
      const sql = neon(dbUrl);
      const rows = await sql`
        SELECT id, title
        FROM conversation_memories
        WHERE arc_name = 'HolaHola Episodes'
          AND ('rolling' = ANY(tags) OR 'rolling-protected' = ANY(tags))
        ORDER BY created_at ASC
      `;
      dbTargets = dbRowsToTargets((rows as any[]).map(r => ({ id: r.id as string, title: r.title as string })));
      if (dbTargets.length === 0) {
        console.log(Y('  ℹ  DB query returned no rolling/rolling-protected episodes — using git-history-derived targets only.'));
      }
    } catch (err: any) {
      console.log(Y(`  ℹ  DB discovery unavailable (${err?.message ?? err}) — using git-history-derived targets only.`));
    }
  } else {
    console.log(Y('  ℹ  NEON_SHARED_DATABASE_URL not set — using git-history-derived targets only.'));
  }

  const merged = mergeTargets(dbTargets, historyTargets);
  const missing = merged.filter(f => !existsSync(join(REPO_ROOT, f.relPath)));
  if (missing.length > 0) {
    console.log(R(`  ⚠  ${missing.length} target(s) have NO .md file on disk right now: ${missing.map(f => f.relPath).join(', ')} — still included as a target (this is exactly the "whole file deleted" case this tool must catch, not a reason to skip it).`));
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────
// Live check (default mode + --full-history)
// ─────────────────────────────────────────────────────────────────────────

interface LossReport {
  file: string;
  source: string;
  meta: string;
  blocks: LostBlock[];
  /** Git-history and missing-file reports are the grounded, primary signal
   *  and fail the run. DB-row reports are informational only (the DB can be
   *  corrupted from the same source as the .md, as happened in the real
   *  incident, so it cannot serve as an independent last-known-good source
   *  on its own) — printed for visibility but never the sole reason a run
   *  fails. */
  blocking: boolean;
}

async function checkFileGitHistory(relPath: string, fullHistory: boolean, repoRoot: string = REPO_ROOT): Promise<LossReport[]> {
  const reports: LossReport[] = [];
  const fetchLimit = fullHistory ? undefined : FAST_MODE_HISTORY_WINDOW + 2;
  const commitsNewestFirst = commitsTouching(relPath, repoRoot, fetchLimit);
  if (commitsNewestFirst.length === 0) return reports;

  const commitsOldestFirst = [...commitsNewestFirst].reverse();
  const contentCache = new Map<string, string>();
  const getContent = (c: string): string | null => {
    if (contentCache.has(c)) return contentCache.get(c)!;
    const content = contentAtCommit(c, relPath, repoRoot);
    if (content !== null) contentCache.set(c, content);
    return content;
  };

  const allConsecutivePairs: Array<[string, string]> = commitsOldestFirst
    .slice(0, -1)
    .map((c, i) => [c, commitsOldestFirst[i + 1]] as [string, string]);

  let pairsToCheck: Array<[string, string]>;
  if (fullHistory) {
    pairsToCheck = allConsecutivePairs;
  } else {
    const cutoffMs = Date.now() - RECENCY_WINDOW_HOURS * 60 * 60 * 1000;
    pairsToCheck = allConsecutivePairs.filter(([, newCommit]) => {
      const ts = commitEpochMs(newCommit, repoRoot);
      return ts !== null && ts >= cutoffMs;
    });
    if (pairsToCheck.length === 0 && allConsecutivePairs.length > 0) {
      console.log(`    (no commits touching this file in the last ${RECENCY_WINDOW_HOURS}h — nothing new to check; use --full-history for a full audit)`);
    }
  }

  // The current tip: working tree content if it exists and is readable,
  // otherwise the most recent commit's content (which may itself be null if
  // the file was deleted and never restored). Used to distinguish a loss
  // that is STILL absent right now from one that was already self-healed by
  // a later commit within the checked window (see stillMissingAtTip()).
  const headCommit = commitsOldestFirst[commitsOldestFirst.length - 1];
  const headContent = getContent(headCommit);
  const wtPath = join(repoRoot, relPath);
  const currentTipContent = existsSync(wtPath) ? readFileSync(wtPath, 'utf8') : headContent;

  for (const [oldCommit, newCommit] of pairsToCheck) {
    const oldContent = getContent(oldCommit);
    // newContent may legitimately be null: the file was deleted AT newCommit.
    // That must NOT be skipped — it means everything in oldContent is lost.
    const newContent = getContent(newCommit);
    if (oldContent === null) continue; // nothing existed yet at oldCommit; nothing to have lost

    const idx = commitsOldestFirst.indexOf(oldCommit);
    const priorContents = commitsOldestFirst
      .slice(0, idx)
      .map(c => getContent(c))
      .filter((c): c is string => c !== null);

    if (newContent !== null && isSafeRevert(newContent, priorContents)) {
      console.log(Y(`    ℹ  ${commitMeta(oldCommit, repoRoot)} → ${commitMeta(newCommit, repoRoot)} — matches an earlier known state (verified clean revert), skipping.`));
      continue;
    }

    const lost = findLostBlocksForTransition(oldContent, newContent, readEpisodeAttributionReceipts(repoRoot, relPath), relPath);
    if (lost.length === 0) continue;

    const stillMissing = currentTipContent !== null ? stillMissingAtTip(lost, currentTipContent) : lost;
    const deletionSuffix = newContent === null ? '  (file deleted here)' : '';
    if (stillMissing.length > 0) {
      reports.push({
        file: relPath,
        source: newContent === null ? 'git (file deleted)' : 'git',
        meta: `${commitMeta(oldCommit, repoRoot)}  →  ${commitMeta(newCommit, repoRoot)}${deletionSuffix}`,
        blocks: stillMissing,
        blocking: true,
      });
    }
    if (stillMissing.length < lost.length) {
      console.log(Y(`    ℹ  ${commitMeta(oldCommit, repoRoot)} → ${commitMeta(newCommit, repoRoot)} — ${lost.length - stillMissing.length} block(s) briefly disappeared here but are present again at the current tip (self-healed by a later commit); not blocking.`));
    }
  }

  // Working tree vs most recent commit — catches a loss not yet committed.
  if (headContent !== null && existsSync(wtPath)) {
    const wtContent = readFileSync(wtPath, 'utf8');
    if (wtContent !== headContent) {
      const lost = findLostBlocks(headContent, wtContent, readEpisodeAttributionReceipts(repoRoot, relPath), relPath);
      if (lost.length > 0) {
        reports.push({
          file: relPath,
          source: 'git (uncommitted)',
          meta: `${commitMeta(headCommit, repoRoot)}  →  (uncommitted working tree)`,
          blocks: lost,
          blocking: true,
        });
      }
    }
  }

  return reports;
}

/**
 * Always-on (NOT recency-gated) check: does this target's file exist right
 * now, on disk? See the header comment (comparison source #2) for why this
 * must be independent of the commit-recency window used elsewhere in this
 * file.
 *
 * When the file is missing, walks back through the file's own git history
 * (unlimited — not capped by FAST_MODE_HISTORY_WINDOW, so a deletion outside
 * that window is still caught) to find the most recent commit that DID have
 * readable content, and reports every block in that content as lost.
 */
function checkFileCurrentlyMissing(relPath: string, repoRoot: string = REPO_ROOT): LossReport | null {
  const wtPath = join(repoRoot, relPath);
  if (existsSync(wtPath)) return null;

  const commits = commitsTouching(relPath, repoRoot); // newest first, unlimited
  for (const c of commits) {
    const content = contentAtCommit(c, relPath, repoRoot);
    if (content === null) continue; // this commit ALSO doesn't have it; keep looking further back
    const blocks = extractBlocks(content);
    if (blocks.length === 0) return null;
    return {
      file: relPath,
      source: 'git (file missing)',
      meta: `${commitMeta(c, repoRoot)}  →  (file no longer exists on disk or at HEAD)`,
      blocks,
      blocking: true,
    };
  }
  return null; // no commit ever had readable content for this path; nothing to have lost
}

async function checkFileAgainstDb(relPath: string, episodeDbId: string | undefined): Promise<LossReport | null> {
  if (!episodeDbId) return null;
  const dbUrl = process.env.NEON_SHARED_DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const sql = neon(dbUrl);
    const rows = await sql`SELECT content FROM conversation_memories WHERE id = ${episodeDbId}`;
    const dbContent = (rows[0] as any)?.content as string | undefined;
    if (!dbContent) return null;
    const wtPath = join(REPO_ROOT, relPath);
    if (!existsSync(wtPath)) return null; // handled as a BLOCKING loss by checkFileCurrentlyMissing() instead
    const mdContent = readFileSync(wtPath, 'utf8');
    const lost = findLostBlocks(dbContent, mdContent);
    if (lost.length === 0) return null;
    return {
      file: relPath,
      source: 'DB row (informational — DB may itself be stale; corroborate with a git-history report before acting)',
      meta: `conversation_memories.id=${episodeDbId}`,
      blocks: lost,
      blocking: false,
    };
  } catch {
    return null; // best-effort; DB unavailability must not fail this check
  }
}

function printBlock(block: LostBlock): void {
  const preview = block.original.replace(/\n/g, ' ↵ ').slice(0, 180);
  console.log(R(`      - "${preview}${block.original.length > 180 ? '…' : ''}"`));
}

async function runLiveCheck(fullHistory: boolean): Promise<void> {
  sep();
  console.log(B(`Episode Dialogue-Loss Detector${fullHistory ? ' (full history audit)' : ''}`));
  sep();

  const targets = await discoverTargetFiles();
  if (targets.length === 0) {
    console.error(R('FATAL: no active/rolling episode .md files found (DB and filesystem discovery both empty).'));
    process.exit(1);
  }
  console.log(`  Checking ${targets.length} file(s): ${targets.map(t => t.relPath).join(', ')}`);

  const allReports: LossReport[] = [];
  for (const target of targets) {
    console.log('');
    console.log(B(`  ── ${target.relPath} ──`));
    const missingReport = checkFileCurrentlyMissing(target.relPath);
    const gitReports = await checkFileGitHistory(target.relPath, fullHistory);
    const dbReport = await checkFileAgainstDb(target.relPath, target.episodeDbId);
    const fileReports = [...(missingReport ? [missingReport] : []), ...gitReports, ...(dbReport ? [dbReport] : [])];

    if (fileReports.length === 0) {
      console.log(G('    ✓ no loss detected'));
    } else {
      for (const report of fileReports) {
        const label = report.blocking ? 'LOSS DETECTED' : 'POSSIBLE LOSS (informational)';
        console.log((report.blocking ? R : Y)(`    ✗ ${label}  (${report.source})`));
        console.log(`      ${report.meta}`);
        for (const block of report.blocks) printBlock(block);
      }
    }
    allReports.push(...fileReports);
  }

  sep();
  const blockingReports = allReports.filter(r => r.blocking);
  const infoReports = allReports.filter(r => !r.blocking);
  const totalBlockingBlocks = blockingReports.reduce((n, r) => n + r.blocks.length, 0);

  if (infoReports.length > 0) {
    const totalInfoBlocks = infoReports.reduce((n, r) => n + r.blocks.length, 0);
    console.log(Y(`  ℹ  ${totalInfoBlocks} informational DB-vs-.md difference(s) across ${infoReports.length} report(s) — not fatal on their own; see above.`));
  }

  if (blockingReports.length === 0) {
    console.log(G(`  ✓ PASS — no disappearing dialogue detected across ${targets.length} file(s).`));
    process.exit(0);
  } else {
    console.log(R(`  ✗ FAIL — ${totalBlockingBlocks} lost block(s) across ${blockingReports.length} report(s).`));
    console.log('  Investigate the commit(s) named above — each represents a transition where');
    console.log('  content present before is now completely absent, regardless of file size change.');
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Self-check — grounded in the REAL Sep 21 2026 episode-34 incident, plus
// synthetic/hermetic assertions for cases no single real commit fixture can
// exercise directly.
// ─────────────────────────────────────────────────────────────────────────

const EPISODE_34_PATH = 'docs/episode-34.md';
const REAL_INCIDENT = {
  before: 'fffeefc',
  lossCommit: '8917df2',
  restoreCommit: '392652e',
};

/**
 * A large-diff-stat transition on the same file that LOOKS alarming
 * (`git show --stat` reports 2,520 deletions against only 5 insertions) but
 * is a legitimate, content-preserving dedup, not a real incident: 6db287b
 * ("Git commit prior to merge") is a doubled/concatenated pre-merge
 * auto-snapshot (585,944 bytes vs. this file's normal ~293,000 — roughly two
 * copies glued together), and 790b50d collapses it back down to one clean
 * copy. This is the exact fixture that exposed the need for the heading-
 * boundary split in extractBlocks(): at the seam between the two
 * concatenated copies, a real paragraph's closing sentence ran directly
 * into the file's own `# Episode 34 — ...` header with no blank line
 * between them. Used as a regression guard: a big line-count diff alone
 * must never be mistaken for real content loss.
 */
const KNOWN_SAFE_DEDUP = {
  before: '6db287b',
  after: '790b50d',
};

/**
 * Hermetic end-to-end integration check: builds a real, throwaway git repo
 * in a temp directory containing a fake episode file, deletes that file
 * entirely in a later commit, and runs the ACTUAL checkFileCurrentlyMissing()
 * function against that repo (not this workspace's real one).
 *
 * This is what the pure-function assertions cannot prove by themselves: that
 * the wiring between git plumbing and the comparison logic actually reports
 * a BLOCKING loss when a tracked file disappears completely — the exact gap
 * a code review found in the first version of this tool (target discovery
 * silently dropped any target whose file did not currently exist, so the
 * whole-file-deletion case never reached any comparison logic at all).
 */
function runHermeticDeletionIntegrationCheck(): void {
  const tmpDir = mkdtempSync(join(tmpdir(), 'episode-loss-detector-selfcheck-'));
  try {
    const relPath = 'docs/episode-hermetic-test.md';
    const fullPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });

    const realParagraph = 'This is a real dialogue paragraph that must be detected as lost when the whole file is deleted in a later commit, matching the shape of a genuine episode exchange.';
    writeFileSync(fullPath, `# Episode Hermetic Test\n\n${realParagraph}\n`);

    const runGit = (args: string[]) => execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
    runGit(['init', '-q', '-b', 'main']);
    runGit(['config', 'user.email', 'selfcheck@example.com']);
    runGit(['config', 'user.name', 'Self Check']);
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'add episode file']);

    // Delete the file entirely in a second commit — the exact failure mode
    // the code review flagged: a whole active episode file disappearing.
    unlinkSync(fullPath);
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'delete episode file']);

    const missingReport = checkFileCurrentlyMissing(relPath, tmpDir);
    if (!missingReport) {
      console.error(R('SELF-CHECK FAIL (hermetic integration): checkFileCurrentlyMissing() found NO loss after a real git-tracked file was deleted in a temp repo.'));
      console.error('  This is the exact blind spot a code review found: deleting an active episode file must never pass silently.');
      process.exit(1);
    }
    if (!missingReport.blocking) {
      console.error(R('SELF-CHECK FAIL (hermetic integration): a fully-deleted tracked file was reported but NOT marked blocking.'));
      process.exit(1);
    }
    const joined = missingReport.blocks.map(b => b.normalized).join(' | ');
    if (!joined.includes('real dialogue paragraph')) {
      console.error(R('SELF-CHECK FAIL (hermetic integration): the missing-file report did not contain the real deleted paragraph text.'));
      console.error(`  Got: ${JSON.stringify(missingReport.blocks.map(b => b.original))}`);
      process.exit(1);
    }
    console.log(G('  ✓ hermetic integration: a real git-tracked episode file deleted in a temp repo is reported as a BLOCKING loss (checkFileCurrentlyMissing)'));

    // Also confirm the function correctly finds NOTHING once the file still
    // exists — i.e. it is not a function that always reports loss regardless
    // of input (a no-op-in-disguise would trivially "pass" the assertion
    // above for the wrong reason).
    const existingPath = 'docs/episode-hermetic-still-here.md';
    writeFileSync(join(tmpDir, existingPath), '# Still Here\n\nThis file was never deleted.\n');
    const notMissingReport = checkFileCurrentlyMissing(existingPath, tmpDir);
    if (notMissingReport !== null) {
      console.error(R('SELF-CHECK FAIL (hermetic integration): checkFileCurrentlyMissing() reported loss for a file that still exists on disk.'));
      process.exit(1);
    }
    console.log(G('  ✓ hermetic integration: checkFileCurrentlyMissing() correctly reports nothing for a file that still exists (not a no-op-in-disguise)'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Hermetic regression check: commitEpochMs() must key recency off the
 * commit's COMMITTER date, not its AUTHOR date. `git commit --date=<X>` sets
 * only the author date — the committer date still reflects the real
 * wall-clock time the commit was made, unless GIT_COMMITTER_DATE is also set
 * (deliberately left unset here). This simulates a cherry-picked or rebased
 * commit that carries a far-in-the-past author date while genuinely landing
 * on the branch right now — a code review found the original implementation
 * used author date (%at), which would let such a commit bypass the recency
 * window entirely despite landing today.
 */
function runHermeticCommitterDateRegressionCheck(): void {
  const tmpDir = mkdtempSync(join(tmpdir(), 'episode-loss-detector-selfcheck-committer-date-'));
  try {
    const relPath = 'docs/episode-hermetic-date-test.md';
    const fullPath = join(tmpDir, relPath);
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(fullPath, '# Episode Hermetic Date Test\n\nInitial content.\n');

    const runGit = (args: string[]) => execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
    runGit(['init', '-q', '-b', 'main']);
    runGit(['config', 'user.email', 'selfcheck@example.com']);
    runGit(['config', 'user.name', 'Self Check']);
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'initial commit']);

    writeFileSync(fullPath, '# Episode Hermetic Date Test\n\nUpdated content, backdated author date.\n');
    runGit(['add', '-A']);
    const tenYearsAgoIso = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
    execFileSync('git', ['commit', '-q', '-m', 'backdated-author commit', '--date', tenYearsAgoIso], {
      cwd: tmpDir,
      encoding: 'utf8',
    });

    const backdatedCommit = git(['rev-parse', 'HEAD'], tmpDir).trim();
    const epochMs = commitEpochMs(backdatedCommit, tmpDir);
    if (epochMs === null) {
      console.error(R('SELF-CHECK FAIL (committer-date regression): commitEpochMs() returned null for a real commit.'));
      process.exit(1);
    }
    const ageMs = Date.now() - epochMs;
    // Real committer time must read as "just now" (generous 10-minute
    // tolerance for a slow sandbox), not ~10 years old. A regression back to
    // author time (%at) would make ageMs come out close to 10 years instead.
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    if (Math.abs(ageMs) > TEN_MINUTES_MS) {
      console.error(R('SELF-CHECK FAIL (committer-date regression): commitEpochMs() did not reflect the real committer (landing) time.'));
      console.error(`  Commit's author date was backdated to ${tenYearsAgoIso}, but its committer date (real landing time) should read as "now".`);
      console.error(`  Got age: ${(ageMs / 1000 / 60).toFixed(1)} minute(s) old — expected close to 0, not ~5,256,000 minutes (10 years).`);
      console.error('  This means commitEpochMs() is reading the AUTHOR date (%at) instead of the COMMITTER date (%ct).');
      process.exit(1);
    }
    console.log(G('  ✓ commitEpochMs() correctly uses committer (landing) time, not author time — a 10-years-backdated author date on a commit made right now still reads as recent'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runSelfCheck(): Promise<void> {
  sep();
  console.log(B('Episode Dialogue-Loss Detector — Self-Check'));
  console.log('  Uses the REAL Sep 21 2026 episode-34 incident as a grounded fixture:');
  console.log(`    ${REAL_INCIDENT.before}  (before)`);
  console.log(`    ${REAL_INCIDENT.lossCommit}  (deleted real dialogue while the file GREW)`);
  console.log(`    ${REAL_INCIDENT.restoreCommit}  (restored the deleted exchange)`);
  sep();

  const before = contentAtCommit(REAL_INCIDENT.before, EPISODE_34_PATH, REPO_ROOT);
  const lossState = contentAtCommit(REAL_INCIDENT.lossCommit, EPISODE_34_PATH, REPO_ROOT);
  const restored = contentAtCommit(REAL_INCIDENT.restoreCommit, EPISODE_34_PATH, REPO_ROOT);

  if (before === null || lossState === null || restored === null) {
    console.error(R('SELF-CHECK SETUP ERROR: could not read one or more fixture commits.'));
    console.error('  This fixture depends on real git history being intact. If these commits');
    console.error('  were ever garbage-collected or history was rewritten, anchor this self-check');
    console.error('  to a different real incident (see docs/open-bugs.md and');
    console.error('  .agents/memory/episode-stale-overwrite-loss.md).');
    process.exit(1);
  }

  // ── Assertion 1: the file GREW in the loss commit — this is WHY size/shrink
  //    checks miss it. If this fixture ever stops demonstrating that shape,
  //    the self-check must fail loudly rather than silently prove nothing. ──
  if (lossState.length <= before.length) {
    console.error(R('SELF-CHECK SETUP ERROR: fixture no longer demonstrates "grew while losing content".'));
    console.error(`  before=${before.length} bytes, lossCommit=${lossState.length} bytes (expected lossCommit > before)`);
    process.exit(1);
  }
  console.log(G(`  ✓ fixture confirmed: file grew ${before.length} → ${lossState.length} bytes in the loss commit`));
  console.log('    (a size-only or shrink-only check would see this as healthy growth)');

  // ── Assertion 2: findLostBlocks DOES detect real lost content ────────────
  const lostInIncident = findLostBlocks(before, lossState);
  if (lostInIncident.length === 0) {
    console.error(R('SELF-CHECK FAIL: findLostBlocks() found ZERO lost blocks in the real loss commit.'));
    console.error('  The detector is broken — it must catch this real, historically-confirmed incident.');
    process.exit(1);
  }
  const joinedNormalized = lostInIncident.map(b => b.normalized).join(' | ');
  if (!joinedNormalized.includes('good session') || !joinedNormalized.includes('enjoy the rest of your day')) {
    console.error(R('SELF-CHECK FAIL: lost blocks were found, but none contain the known real deleted text'));
    console.error('  ("Good session. Enjoy the rest of your day.") — the detector may be flagging the wrong content.');
    console.error(`  Lost block previews: ${JSON.stringify(lostInIncident.map(b => b.original.slice(0, 80)))}`);
    process.exit(1);
  }
  console.log(G(`  ✓ findLostBlocks() correctly detected ${lostInIncident.length} lost block(s), including the real deleted sign-off exchange`));

  // ── Assertion 3: findLostBlocks reports ZERO loss once restored (no false
  //    positive against the fix — the restore commit is known to have fully
  //    recovered the deleted content). ──────────────────────────────────────
  const lostAfterRestore = findLostBlocks(before, restored);
  if (lostAfterRestore.length !== 0) {
    console.error(R(`SELF-CHECK FAIL: ${lostAfterRestore.length} block(s) STILL reported lost after the restore commit.`));
    console.error('  The restore commit is known to have fully recovered the deleted content;');
    console.error('  a nonzero result here means the detector has a false-positive bug.');
    for (const b of lostAfterRestore) console.error(`    - ${JSON.stringify(b.original.slice(0, 120))}`);
    process.exit(1);
  }
  console.log(G('  ✓ findLostBlocks() correctly reports ZERO loss comparing before-incident → after-restore (no false positive)'));

  // ── Assertion 4: regression check — a naive size-only comparator (what the
  //    codebase already had) misses the real incident entirely. Proves the
  //    sensitivity comes from findLostBlocks(), not from picking an easy
  //    fixture. ────────────────────────────────────────────────────────────
  const naiveSizeOnlyDetector = (a: string, b: string): boolean => b.length < a.length; // "flags only if shrank"
  if (naiveSizeOnlyDetector(before, lossState)) {
    console.error(R('SELF-CHECK SETUP ERROR: naive size-only check would already catch this — fixture no longer demonstrates the gap this tool exists to close.'));
    process.exit(1);
  }
  console.log(G('  ✓ regression check: a naive size/shrink-only comparator misses this transition entirely — findLostBlocks() is what actually catches it'));

  // ── Assertion 5: isSafeRevert does not mistake the restore for an exact
  //    revert to the pre-incident state (the restore also kept new content
  //    added after the incident, so it is not byte-identical to `before`). ──
  if (isSafeRevert(restored, [before])) {
    console.error(R('SELF-CHECK FAIL: isSafeRevert() incorrectly treated the restore as an exact revert to the pre-incident state.'));
    console.error('  The restore commit added the sign-off back AND kept unrelated new material — it is not byte-identical to `before`.');
    process.exit(1);
  }
  console.log(G('  ✓ isSafeRevert() correctly does NOT treat the restore as a revert (new material was also present — not a byte-identical match)'));

  // ── Assertion 6: isSafeRevert DOES recognize a genuine byte-identical
  //    revert, so the guard is not just always-false. ───────────────────────
  if (!isSafeRevert(before, [before])) {
    console.error(R('SELF-CHECK FAIL: isSafeRevert() failed to recognize an exact match against its own content.'));
    process.exit(1);
  }
  console.log(G('  ✓ isSafeRevert() correctly recognizes a genuine byte-identical revert (guard is not always-false)'));

  // ── Assertion 7: a real, large-diff-stat transition (2,520 deletions per
  //    `git show --stat`) that is actually a content-preserving dedup must
  //    report ZERO lost blocks — proves the heading-boundary split fix (see
  //    extractBlocks()) actually resolves the exact defect it was built for,
  //    and that a big line-count diff alone is never mistaken for loss. ─────
  const dedupBefore = contentAtCommit(KNOWN_SAFE_DEDUP.before, EPISODE_34_PATH, REPO_ROOT);
  const dedupAfter = contentAtCommit(KNOWN_SAFE_DEDUP.after, EPISODE_34_PATH, REPO_ROOT);
  if (dedupBefore === null || dedupAfter === null) {
    console.error(R('SELF-CHECK SETUP ERROR: could not read one or more known-safe-dedup fixture commits.'));
    console.error('  See docs/open-bugs.md / .agents/memory/episode-stale-overwrite-loss.md if this fixture needs re-anchoring.');
    process.exit(1);
  }
  if (dedupAfter.length >= dedupBefore.length) {
    console.error(R('SELF-CHECK SETUP ERROR: fixture no longer demonstrates a large collapse (expected a big size drop from a doubled snapshot).'));
    console.error(`  before=${dedupBefore.length} bytes, after=${dedupAfter.length} bytes`);
    process.exit(1);
  }
  const dedupLost = findLostBlocks(dedupBefore, dedupAfter);
  if (dedupLost.length !== 0) {
    console.error(R(`SELF-CHECK FAIL: ${dedupLost.length} block(s) reported lost across a known content-preserving dedup transition.`));
    console.error('  This transition collapses a doubled pre-merge snapshot back to one copy — nothing should be genuinely missing.');
    console.error('  A nonzero result here means extractBlocks() is still vulnerable to the heading-glued-to-prose false positive.');
    for (const b of dedupLost) console.error(`    - ${JSON.stringify(b.original.slice(0, 160))}`);
    process.exit(1);
  }
  console.log(G(`  ✓ known-safe dedup (${dedupBefore.length} → ${dedupAfter.length} bytes, a real 2,520-deletion diff) correctly reports ZERO lost blocks — confirms the heading-boundary split fix`));

  // ── Assertions 8-9: stillMissingAtTip() itself, tested directly and
  //    deterministically (no dependency on how any specific historical
  //    commit's content happens to be shaped). ─────────────────────────────
  const fakeLost: LostBlock[] = [
    { normalized: 'alpha block text that vanished', original: 'Alpha block text that vanished.' },
    { normalized: 'beta block text that also vanished', original: 'Beta block text that also vanished.' },
  ];

  // Assertion 8: a tip that contains ONLY the alpha text must clear alpha and
  // keep reporting beta — proves this is a real per-block filter, not a
  // no-op that always clears everything or an all-or-nothing check.
  const partialRecoveryTip = 'unrelated preamble ... alpha block text that vanished ... unrelated epilogue';
  const partialResult = stillMissingAtTip(fakeLost, partialRecoveryTip);
  if (partialResult.length !== 1 || partialResult[0].normalized !== 'beta block text that also vanished') {
    console.error(R('SELF-CHECK FAIL: stillMissingAtTip() did not correctly clear a recovered block while keeping an unrecovered one.'));
    console.error(`  Expected exactly [beta] remaining; got: ${JSON.stringify(partialResult.map(b => b.normalized))}`);
    process.exit(1);
  }
  console.log(G('  ✓ stillMissingAtTip() clears a block once its text is found in the tip while correctly still reporting one that is not (not all-or-nothing)'));

  // Assertion 9: a tip containing NEITHER text must keep reporting both —
  // proves the function is not a no-op that always clears everything.
  const noRecoveryTip = 'completely unrelated content with no overlap at all';
  const noRecoveryResult = stillMissingAtTip(fakeLost, noRecoveryTip);
  if (noRecoveryResult.length !== fakeLost.length) {
    console.error(R('SELF-CHECK FAIL: stillMissingAtTip() cleared block(s) against tip content that contains neither of them.'));
    console.error(`  Expected both blocks to remain reported; got ${noRecoveryResult.length}.`);
    process.exit(1);
  }
  console.log(G('  ✓ stillMissingAtTip() correctly reports everything still missing when the tip recovers neither block (not a no-op)'));

  // ── Assertion 10: findLostBlocksForTransition treats a deleted (null)
  //    file as total loss of its prior content — this is the pure-function
  //    core of the whole-file-deletion fix. ─────────────────────────────────
  const deletionLost = findLostBlocksForTransition(
    'A real paragraph that must not vanish silently when the whole file disappears in a later commit.',
    null,
  );
  if (deletionLost.length === 0) {
    console.error(R('SELF-CHECK FAIL: findLostBlocksForTransition() found zero lost blocks when newContent is null (file deleted).'));
    process.exit(1);
  }
  console.log(G('  ✓ findLostBlocksForTransition() correctly treats a deleted (null) file as total loss of its prior content'));

  // ── Assertion 11: findLostBlocksForTransition reports nothing when the
  //    file did not exist before (pure creation) — proves assertion 10 is a
  //    real conditional, not a function that always reports full loss. ─────
  const creationLost = findLostBlocksForTransition(null, 'Brand new file content that did not exist before this commit.');
  if (creationLost.length !== 0) {
    console.error(R('SELF-CHECK FAIL: findLostBlocksForTransition() reported loss for a file that did not exist before (nothing to lose).'));
    process.exit(1);
  }
  console.log(G('  ✓ findLostBlocksForTransition() correctly reports no loss when the file did not exist before (pure creation, not an always-lost bug)'));

  // ── Assertion 12: dbRowsToTargets() includes a target even when its .md
  //    does not exist on disk — the pure-function core of the target-
  //    discovery half of the whole-file-deletion fix. Uses episode 500: a
  //    plausible-but-unused low number, deliberately NOT >= 1000 and NOT in
  //    LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS, so this assertion keeps
  //    exercising the real "target survives even without a file" behavior
  //    instead of accidentally hitting the fixture-exclusion path that
  //    Assertion 20 (below) tests on purpose. ─────────────────────────────
  const fakeRows = [{ id: 'fake-id-does-not-matter', title: 'Episode 500 — a title for a file that must not exist on disk' }];
  const fakeTargets = dbRowsToTargets(fakeRows);
  const fakeTarget = fakeTargets.find(t => t.relPath === 'docs/episode-500.md');
  if (!fakeTarget) {
    console.error(R('SELF-CHECK FAIL: dbRowsToTargets() did not produce a target for a DB row (target discovery must never depend on file existence).'));
    process.exit(1);
  }
  if (existsSync(join(REPO_ROOT, fakeTarget.relPath))) {
    console.error(R('SELF-CHECK SETUP ERROR: fixture file docs/episode-500.md unexpectedly exists on disk — pick a different fake episode number.'));
    process.exit(1);
  }
  console.log(G('  ✓ dbRowsToTargets() includes a target even though docs/episode-500.md does not exist on disk (discovery never gates on existence)'));

  // ── Assertion 13: comment-normalization symmetry — a metadata HTML
  //    comment wedged INSIDE an otherwise word-for-word-unchanged paragraph
  //    must NOT create a false positive. ─────────────────────────────────────
  const commentOldContent = 'Intro text goes here so this block clears the minimum length.\n\nA real paragraph that stays exactly the same across versions, word for word, long enough to clear the floor.\n\nOutro text also long enough to clear the floor on its own.';
  const commentNewContent = 'Intro text goes here so this block clears the minimum length.\n\nA real paragraph that stays exactly the same across\n<!-- inner-life:felt:1234567890:abcdef -->\nversions, word for word, long enough to clear the floor.\n\nOutro text also long enough to clear the floor on its own.';
  const commentLost = findLostBlocks(commentOldContent, commentNewContent);
  if (commentLost.length !== 0) {
    console.error(R('SELF-CHECK FAIL: findLostBlocks() reported a false loss when a metadata HTML comment was inserted inside an otherwise-unchanged paragraph.'));
    console.error('  This means old-side and new-side comment stripping are asymmetric.');
    console.error(`  Falsely lost: ${JSON.stringify(commentLost.map(b => b.original))}`);
    process.exit(1);
  }
  console.log(G('  ✓ findLostBlocks() does not falsely flag loss when a metadata HTML comment is inserted mid-paragraph (comment stripping is symmetric on both sides)'));

  // ── Assertion 14: hermetic end-to-end integration — see
  //    runHermeticDeletionIntegrationCheck() for what this proves that the
  //    pure-function assertions above cannot. ───────────────────────────────
  runHermeticDeletionIntegrationCheck();

  // ── Assertion 15: gitHistoryCandidateTargets() excludes a known test/CI
  //    fixture number (the real docs/episode-9993.md false-positive a code
  //    review found) while still including a real low episode number. ──────
  const candidateInputCurrent = ['docs/episode-34.md'];
  const candidateInputHistorical = ['docs/episode-34.md', 'docs/episode-9993.md'];
  const candidates = gitHistoryCandidateTargets(candidateInputCurrent, candidateInputHistorical);
  if (candidates.some(t => t.relPath === 'docs/episode-9993.md')) {
    console.error(R('SELF-CHECK FAIL: gitHistoryCandidateTargets() included the known test fixture docs/episode-9993.md as a real target.'));
    process.exit(1);
  }
  if (!candidates.some(t => t.relPath === 'docs/episode-34.md')) {
    console.error(R('SELF-CHECK FAIL: gitHistoryCandidateTargets() dropped a real episode number (docs/episode-34.md).'));
    process.exit(1);
  }
  console.log(G('  ✓ gitHistoryCandidateTargets() excludes the known docs/episode-9993.md test fixture while keeping a real episode number'));

  // ── Assertion 16: mergeTargets() keeps a HISTORY-ONLY target — the exact
  //    scenario a code review found missing: a target whose own DB row/tag
  //    disappeared (so it is absent from dbTargets) must still survive via
  //    its git history, or a whole-file deletion paired with DB-row/tag loss
  //    becomes invisible to the whole tool again. ───────────────────────────
  const mergeHistoryOnly = mergeTargets(
    [{ relPath: 'docs/episode-27.md', episodeDbId: 'db-row-27' }], // DB still has 27, but NOT 34
    [{ relPath: 'docs/episode-27.md' }, { relPath: 'docs/episode-34.md' }], // history has both
  );
  if (!mergeHistoryOnly.some(t => t.relPath === 'docs/episode-34.md')) {
    console.error(R('SELF-CHECK FAIL: mergeTargets() dropped a history-only target whose DB row/tag was absent.'));
    console.error('  This is the exact gap a code review found: a target must survive even when ITS OWN DB signal disappears.');
    process.exit(1);
  }
  console.log(G('  ✓ mergeTargets() keeps a history-only target even when its own DB row/tag is absent (the DB-desync case a code review found)'));

  // ── Assertion 17: mergeTargets() keeps a DB-ONLY target — e.g. a brand
  //    new episode created today that has a DB row but no git history yet.
  //    Proves the merge is a real union, not "history wins when present". ──
  const mergeDbOnly = mergeTargets(
    [{ relPath: 'docs/episode-35.md', episodeDbId: 'db-row-35' }],
    [{ relPath: 'docs/episode-34.md' }],
  );
  const dbOnlyTarget = mergeDbOnly.find(t => t.relPath === 'docs/episode-35.md');
  if (!dbOnlyTarget || dbOnlyTarget.episodeDbId !== 'db-row-35') {
    console.error(R('SELF-CHECK FAIL: mergeTargets() dropped or corrupted a DB-only target with no git history yet.'));
    process.exit(1);
  }
  console.log(G('  ✓ mergeTargets() keeps a DB-only target with no git history yet, with its episodeDbId intact (real union, not history-precedence)'));

  // ── Assertion 18: a fixture path already excluded by
  //    gitHistoryCandidateTargets() is not somehow reintroduced by
  //    mergeTargets() itself. ────────────────────────────────────────────────
  const mergeWithFixtureExcluded = mergeTargets([], gitHistoryCandidateTargets([], ['docs/episode-9993.md']));
  if (mergeWithFixtureExcluded.some(t => t.relPath === 'docs/episode-9993.md')) {
    console.error(R('SELF-CHECK FAIL: mergeTargets() reintroduced a fixture path that gitHistoryCandidateTargets() had already excluded.'));
    process.exit(1);
  }
  console.log(G('  ✓ mergeTargets() does not reintroduce a fixture path already excluded upstream'));

  // ── Assertion 19: hermetic committer-date regression — see
  //    runHermeticCommitterDateRegressionCheck() for what this proves. ──────
  runHermeticCommitterDateRegressionCheck();

  // ── Assertion 20: the legacy bare-numbered fixture (docs/episode-99.md,
  //    test-rolling-sync-guard.ts) must be excluded the same way the
  //    9900+/1000+ convention is — via BOTH git-history candidates AND
  //    DB-row-derived targets, since that test's temporary 'rolling'-tagged
  //    DB row (title "Episode 99") is exactly what discoverTargetFiles()'s
  //    DB query can observe mid-run. Real neighbors (98, 100) must remain
  //    protected on both paths. ────────────────────────────────────────────
  const legacyFixtureCandidates = gitHistoryCandidateTargets(
    ['docs/episode-98.md'],
    ['docs/episode-98.md', 'docs/episode-99.md', 'docs/episode-100.md'],
  );
  if (legacyFixtureCandidates.some(t => t.relPath === 'docs/episode-99.md')) {
    console.error(R('SELF-CHECK FAIL: gitHistoryCandidateTargets() included the legacy docs/episode-99.md fixture (test-rolling-sync-guard.ts) as a real target.'));
    process.exit(1);
  }
  if (!legacyFixtureCandidates.some(t => t.relPath === 'docs/episode-100.md')) {
    console.error(R('SELF-CHECK FAIL: gitHistoryCandidateTargets() dropped a real neighbor (docs/episode-100.md) of the excluded legacy fixture.'));
    process.exit(1);
  }
  const legacyFixtureDbRows = dbRowsToTargets([
    { id: '99000000-0000-4000-8000-000000000099', title: 'Episode 99' },
    { id: 'db-row-100', title: 'Episode 100' },
  ]);
  if (legacyFixtureDbRows.some(t => t.relPath === 'docs/episode-99.md')) {
    console.error(R('SELF-CHECK FAIL: dbRowsToTargets() included the legacy docs/episode-99.md fixture row. This is the exact live-race gap: test-rolling-sync-guard.ts inserts a real \'rolling\'-tagged row titled "Episode 99" for the duration of its own run, which discoverTargetFiles() can observe mid-test.'));
    process.exit(1);
  }
  if (!legacyFixtureDbRows.some(t => t.relPath === 'docs/episode-100.md')) {
    console.error(R('SELF-CHECK FAIL: dbRowsToTargets() dropped a real neighboring DB row (Episode 100) alongside the excluded legacy fixture.'));
    process.exit(1);
  }
  console.log(G('  ✓ the legacy docs/episode-99.md fixture (test-rolling-sync-guard.ts) is excluded from BOTH git-history and DB-row target discovery, while real neighbors (98, 100) remain protected'));

  // A receipt is not an exemption: reconstruct every label span against the
  // entire old snapshot. Both the absent-receipt and forged-receipt controls
  // must still report loss, and deletion of the file must remain blocking.
  const receiptOld = 'Claude Code: Synthetic exact spoken words must remain byte-for-byte.\n\nDavid: An untouched synthetic reply stays here.\n';
  const receiptNew = receiptOld.replace(/^Claude Code:/, 'LUCA [Claude Code]:');
  const receipt = {
    episodeId: '41200170-1c49-4660-838c-9d397aff5d27',
    applied: true, replicaParity: true,
    beforeSha256: attributionSha256(receiptOld),
    afterSha256: attributionSha256(receiptNew),
    edits: [{
      offset: 0, oldLabel: 'Claude Code:', newLabel: 'LUCA [Claude Code]:',
      sourceId: 'synthetic-self-check-source',
      captureId: 'cc-c52bede8-dd68-4804-8f77-59290f60b9e2-900001',
      spokenSha256: attributionSha256('Synthetic exact spoken words must remain byte-for-byte.'),
    }],
  };
  const lostWords = receiptNew.replace('exact spoken words ', '');
  if (!findLostBlocks(receiptOld, receiptNew).length ||
      findLostBlocks(receiptOld, receiptNew, [receipt]).length ||
      findLostBlocks(receiptOld, receiptNew + '\nNew appended synthetic content.\n', [receipt]).length ||
      !findLostBlocks(receiptOld, lostWords, [{ ...receipt, afterSha256: attributionSha256(lostWords) }]).length ||
      !findLostBlocksForTransition(receiptOld, null, [receipt]).length ||
      !findLostBlocks(receiptOld, receiptNew, [{ ...receipt, beforeSha256: '0'.repeat(64) }]).length) {
    console.error(R('SELF-CHECK FAIL: label-only receipt verification suppressed an unproven change or failed to accept its exact byte proof.'));
    process.exit(1);
  }
  console.log(G('  ✓ complete label-only receipts distinguish attribution correction from dialogue loss; missing/forged receipts, actual lost words, and whole-file deletion remain blocking'));

  // Runtime-notice relabel receipts: accepted only for their replica path and
  // only when they reconstruct the exact label-only change.
  const noticeLine = '<task-notification> background task "CI" completed </task-notification>';
  const noticeOld = `**David [Claude Code]:** ${noticeLine}

**Claude Code:** Synthetic reply words must survive.
`;
  const noticeNew = noticeOld.replace('**David [Claude Code]:**', `**${RUNTIME_NOTICE_LABEL}:**`);
  const noticeReceipt = {
    kind: 'runtime-notice-relabel', episodeId: '41200170-1c49-4660-838c-9d397aff5d27', label: RUNTIME_NOTICE_LABEL,
    applied: true, replicaParity: true,
    beforeSha256: attributionSha256(noticeOld), afterSha256: attributionSha256(noticeNew),
    edits: [{ offset: 0, oldLabel: '**David [Claude Code]:**', newLabel: `**${RUNTIME_NOTICE_LABEL}:**`, lineSha256: attributionSha256(noticeLine) }],
  };
  if (!findLostBlocks(noticeOld, noticeNew).length ||
      findLostBlocks(noticeOld, noticeNew, [noticeReceipt], 'docs/episode-34.md').length ||
      !findLostBlocks(noticeOld, noticeNew, [noticeReceipt]).length ||
      !findLostBlocks(noticeOld, noticeNew, [noticeReceipt], 'docs/episode-35.md').length ||
      !findLostBlocks(noticeOld, noticeNew.replace('reply words ', ''), [noticeReceipt], 'docs/episode-34.md').length) {
    console.error(R('SELF-CHECK FAIL: runtime-notice relabel receipt verification suppressed an unproven change or failed to accept its exact byte proof.'));
    process.exit(1);
  }
  console.log(G('  ✓ runtime-notice relabel receipts are accepted only for their replica path and the exact label-only change'));

  sep();
  console.log(G('\n  ✓ SELF-CHECK PASSED — detector proven against the real Sep 21 2026 episode-34 incident, a known-safe dedup regression case, a hermetic whole-file-deletion integration case, target-discovery union/fixture-exclusion rules, committer-date recency filtering, and strict label-only receipts.\n'));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────

const SELF_CHECK = process.argv.includes('--self-check');
const FULL_HISTORY = process.argv.includes('--full-history');

if (SELF_CHECK) {
  runSelfCheck().catch((err: any) => {
    console.error(R('FATAL: self-check crashed: ' + (err?.message ?? err)));
    process.exit(1);
  });
} else {
  runLiveCheck(FULL_HISTORY).catch((err: any) => {
    console.error(R('FATAL: ' + (err?.message ?? err)));
    process.exit(1);
  });
}
