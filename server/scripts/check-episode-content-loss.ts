#!/usr/bin/env npx tsx
/**
 * check-episode-content-loss.ts
 *
 * CLI gate that blocks a change from landing when it would silently remove
 * real conversation history from any `docs/episode-<N>.md` file. See
 * server/services/episode-content-loss-guard.ts for the detection algorithm
 * and full background (task #1529).
 *
 * This is one of several call sites for the same shared guard:
 *   - server/services/source-control-service.ts calls the guard module
 *     directly before its fast-forward push (the authoritative chokepoint —
 *     every direct commit and every post-task-agent-merge state eventually
 *     flows through that push).
 *   - scripts/post-merge.sh calls this CLI right after a merge lands, for
 *     fast, loud, local feedback (mirrors scripts/gemini-gate-check.sh).
 *   - .github/workflows/cross-tool-promote.yml calls this CLI before
 *     fast-forwarding main, for the external-tool promotion path.
 *
 * Normal mode:
 *   npx tsx server/scripts/check-episode-content-loss.ts
 *     Range defaults to ORIG_HEAD..HEAD (set by git during a real merge or
 *     fast-forward pull), falling back to HEAD~1..HEAD, matching
 *     scripts/gemini-gate-check.sh's exact convention. Override with
 *     --old-ref/--new-ref for an explicit range (e.g. heads.github/
 *     heads.local shas).
 *
 * Self-check mode:
 *   npx tsx server/scripts/check-episode-content-loss.ts --self-check
 *     Hermetic: builds a real temp git repo, reproduces both confirmed
 *     incident shapes (full truncation; grow-but-lose-content) plus safe
 *     edits (append; exact-duplicate-elsewhere removal) and asserts the
 *     guard fires only where it must — proving the mechanism, not just the
 *     algorithm in isolation. Also proves a naive shrinkage-only check (the
 *     pre-existing restore-episode-*-from-db.ts strategy) would miss the
 *     grow-but-lose case, which is the reason this guard exists.
 *
 * Exit codes:
 *   0 — no protected episode file changed, no content lost, or content loss
 *       was present but authorized by a docs/episode-content-loss-override-
 *       *.md file in the same range (self-check: all assertions passed).
 *   1 — real, non-duplicate episode content would be removed with no
 *       override present (self-check: an assertion failed).
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkEpisodeContentLoss,
  findContentLossViolations,
  isProtectedEpisodeFile,
  isRegularFileEntry,
  LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS,
  RESERVED_FIXTURE_EPISODE_MIN,
  type GitRunner,
  type TreeEntry,
} from '../services/episode-content-loss-guard';
import { attributionSha256 } from '../services/episode-claude-attribution-repair';

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;

// ---------------------------------------------------------------------------
// Git runner (real filesystem — used by both normal mode and self-check,
// pointed at different cwds). Read-only commands only.
// ---------------------------------------------------------------------------

function makeGitRunner(cwd: string): GitRunner {
  return async (args: string[]) => {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 128,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      const stdout = typeof err?.stdout === 'string' ? err.stdout : (err?.stdout?.toString?.('utf-8') ?? '');
      const exitCode = typeof err?.status === 'number' ? err.status : 1;
      return { stdout, exitCode };
    }
  };
}

function git(cwd: string, args: string[]): string {
  const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return stdout.trim();
}

/** Wraps a real GitRunner so any call matching `shouldFail` returns a
 *  failure, while every other call passes through to the real repo
 *  unchanged. Lets a self-check reproduce one specific git failure (e.g.
 *  the exact "blob unreadable" shape a partial-clone lazy-fetch failure
 *  would produce) inside an otherwise-real, otherwise-correct repo, so the
 *  assertion proves the orchestration's reaction to that failure rather
 *  than just a hand-built mock's behavior. */
function withInjectedFailure(realRunner: GitRunner, shouldFail: (args: string[]) => boolean): GitRunner {
  return async (args: string[]) => {
    if (shouldFail(args)) return { stdout: '', exitCode: 128 };
    return realRunner(args);
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function bounded(text: string, limit = 240): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * ORIG_HEAD is set fresh by git during the exact merge/fast-forward that
 * triggers scripts/post-merge.sh — the intended use, matching
 * scripts/gemini-gate-check.sh's identical convention. But in a long-running
 * workspace, an ad-hoc or delayed invocation can find a stale ORIG_HEAD left
 * over from a prior, unrelated git operation. Widening the range with a
 * stale ref is safe for gemini-gate-check.sh's presence-only check, but
 * unsafe here: it risks flagging already-resolved historical content as a
 * fresh violation. Only trust ORIG_HEAD when it actually is an ancestor of
 * the ref being landed; otherwise fall back to the always-correct, always-
 * an-ancestor HEAD~1.
 */
async function resolveDefaultOldRef(runGit: GitRunner, newRef: string): Promise<string> {
  const origHead = await runGit(['rev-parse', '--verify', 'ORIG_HEAD']);
  if (origHead.exitCode === 0 && origHead.stdout.trim()) {
    const ancestorCheck = await runGit(['merge-base', '--is-ancestor', origHead.stdout.trim(), newRef]);
    if (ancestorCheck.exitCode === 0) {
      return 'ORIG_HEAD';
    }
  }
  return 'HEAD~1';
}

// ---------------------------------------------------------------------------
// Normal mode
// ---------------------------------------------------------------------------

async function runNormalMode(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const runGit = makeGitRunner(cwd);

  const newRef = flagValue(args, '--new-ref') ?? 'HEAD';
  let oldRef = flagValue(args, '--old-ref');

  if (!oldRef) {
    oldRef = await resolveDefaultOldRef(runGit, newRef);
  }

  // A range with no resolvable "old" side (fresh/shallow history, first
  // commit) has nothing to compare against — that's a legitimate no-op, the
  // same fallback scripts/gemini-gate-check.sh applies to an empty diff.
  const oldCheck = await runGit(['rev-parse', '--verify', `${oldRef}^{commit}`]);
  if (oldCheck.exitCode !== 0) {
    console.log(Y(`[episode-content-loss] Could not resolve old ref "${oldRef}" (e.g. first commit in history) — nothing to compare. Passing.`));
    process.exit(0);
  }

  let result;
  try {
    result = await checkEpisodeContentLoss(runGit, oldRef, newRef);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(R(`[episode-content-loss] FATAL: ${message}`));
    process.exit(1);
  }

  if (result.changedEpisodeFiles.length === 0) {
    console.log(G(`[episode-content-loss] No docs/episode-*.md files changed in range ${oldRef}..${newRef}. Passed.`));
    process.exit(0);
  }

  const violatingFiles = Object.keys(result.violations);
  if (violatingFiles.length === 0) {
    console.log(G(
      `[episode-content-loss] ${result.changedEpisodeFiles.length} episode file(s) changed ` +
      `(${result.changedEpisodeFiles.join(', ')}) — no real content removed. Passed.`,
    ));
    process.exit(0);
  }

  if (result.overrideDocsPresent.length > 0) {
    console.log(Y('[episode-content-loss] Content removal detected but an override is present — allowing.'));
    for (const file of violatingFiles) {
      console.log(Y(`  ${file}: ${result.violations[file].length} line(s) removed, overridden`));
    }
    console.log(Y(`  Override doc(s): ${result.overrideDocsPresent.join(', ')}`));
    process.exit(0);
  }

  console.log('');
  console.log(R('╔══════════════════════════════════════════════════════════════════════════╗'));
  console.log(R('║   ⚠️   EPISODE CONTENT-LOSS GUARD FAILED — DO NOT LAND THIS CHANGE   ⚠️   ║'));
  console.log(R('╠══════════════════════════════════════════════════════════════════════════╣'));
  console.log(R(`║  Range checked: ${oldRef}..${newRef}`));
  console.log(R('║'));
  console.log(R('║  The following file(s) would lose real, non-duplicate conversation'));
  console.log(R('║  content that exists in the current version but not anywhere in the'));
  console.log(R('║  new version:'));
  for (const file of violatingFiles) {
    const lines = result.violations[file];
    console.log(R(`║    • ${file} — ${lines.length} line(s) removed:`));
    for (const line of lines.slice(0, 10)) {
      console.log(R(`║        - ${bounded(line)}`));
    }
    if (lines.length > 10) console.log(R(`║        ...and ${lines.length - 10} more`));
  }
  console.log(R('║'));
  console.log(R('║  WHAT TO DO:'));
  console.log(R('║    • If this loss is unintended: re-append the missing content instead'));
  console.log(R('║      of replacing the file (see server/scripts/append-to-episode.ts).'));
  console.log(R('║    • If this removal is genuinely intentional (not the legitimate'));
  console.log(R('║      elsewhere-duplicate case, which never triggers this guard): add a'));
  console.log(R('║      docs/episode-content-loss-override-<reason>.md file in the same'));
  console.log(R('║      commit explaining why, and re-run.'));
  console.log(R('╚══════════════════════════════════════════════════════════════════════════╝'));
  console.log('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Self-check mode
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(G(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(R(`  ✗ ${label}`));
    if (detail) console.log(R(`       ${detail}`));
    failed++;
  }
}

/** Mirrors restore-episode-27-from-db.ts's shrinkage-only strategy, to prove
 *  it is insufficient for the grow-but-lose-content incident shape. */
function naiveShrinkageWouldCatch(oldContent: string, newContent: string): boolean {
  const normalize = (s: string) => s.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalize(newContent).length < normalize(oldContent).length - 200;
}

async function runSelfCheck(): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log(B('  episode-content-loss guard — SELF-CHECK'));
  console.log('═'.repeat(70) + '\n');

  // ── Pure-algorithm assertions (fast, no git) ──────────────────────────────
  console.log(B('— Pure algorithm —'));

  const oldGrowLose = [
    '**DAVID:** approved, I\'m off for the day',
    '**LUCA [Replit]:** Good session, enjoy the rest of your day',
  ].join('\n');
  const newGrowLose = [
    '**DAVID:** approved, I\'m off for the day',
    '**LUCA [Replit]:** actually one more thing before you go',
    '**DAVID:** sure, what\'s up',
    '**LUCA [Replit]:** never mind, all good — talk tomorrow',
  ].join('\n');
  const growLoseViolations = findContentLossViolations(oldGrowLose, newGrowLose);
  assert(
    'Grow-but-lose-content: removed closing exchange is detected even though the file grew',
    growLoseViolations.length === 1 && growLoseViolations[0].includes('Good session'),
    `Got violations: ${JSON.stringify(growLoseViolations)}`,
  );
  assert(
    'Grow-but-lose-content: a naive shrinkage-only check would NOT have caught it (this is why content-based detection exists)',
    !naiveShrinkageWouldCatch(oldGrowLose, newGrowLose),
    'Expected the naive check to miss this case (new content is larger), proving size-based checks are insufficient.',
  );

  const dupLine = '**DAVID:** this line appears twice in the old file';
  const oldDup = [dupLine, '**LUCA [Replit]:** noted once', dupLine].join('\n');
  const newDedup = [dupLine, '**LUCA [Replit]:** noted once'].join('\n');
  assert(
    'Exact-duplicate-elsewhere removal (legitimate dedup) is NOT flagged',
    findContentLossViolations(oldDup, newDedup).length === 0,
    `Got violations: ${JSON.stringify(findContentLossViolations(oldDup, newDedup))}`,
  );

  const oldAppend = '**DAVID:** hello\n**LUCA [Replit]:** hi';
  const newAppend = oldAppend + '\n**DAVID:** how are you\n**LUCA [Replit]:** doing well';
  assert(
    'Pure append is NOT flagged',
    findContentLossViolations(oldAppend, newAppend).length === 0,
  );

  // Attribution design f5d77712 (3.3): aware writers append plain-label turns
  // after the legacy prefix; that is an append, not a loss, and the legacy
  // bracket labels before it are untouched.
  const newPlainAppend = oldAppend + '\n\n**David:** how are you\n\n**Luca:** doing well\n\n**Daniela [consult]:** muy bien';
  assert(
    'Appending plain-label turns after legacy bracket labels is NOT flagged',
    findContentLossViolations(oldAppend, newPlainAppend).length === 0,
    `Got violations: ${JSON.stringify(findContentLossViolations(oldAppend, newPlainAppend))}`,
  );
  assert(
    'Relabeling a legacy bracket label to the plain form IS flagged',
    findContentLossViolations(oldAppend, oldAppend.replace('**LUCA [Replit]:** hi', '**Luca:** hi')).length > 0,
  );

  assert(
    'Trivial-line churn (blank lines, --- rules, HTML comment metadata) is NOT flagged',
    findContentLossViolations(
      '**DAVID:** hi\n\n---\n<!-- chat-capture-range:1:10 -->\n**LUCA [Replit]:** hello',
      '**DAVID:** hi\n<!-- chat-capture-range:1:99 -->\n**LUCA [Replit]:** hello',
    ).length === 0,
  );

  const blobEntry: TreeEntry = { mode: '100644', type: 'blob', path: 'docs/episode-content-loss-override-x.md' };
  const dirEntry: TreeEntry = { mode: '040000', type: 'tree', path: 'docs/episode-content-loss-override-dir.md' };
  const symlinkEntry: TreeEntry = { mode: '120000', type: 'blob', path: 'docs/episode-content-loss-override-link.md' };
  assert('isRegularFileEntry accepts a normal file blob', isRegularFileEntry(blobEntry));
  assert('isRegularFileEntry rejects a directory even if the name pattern matches', !isRegularFileEntry(dirEntry));
  assert('isRegularFileEntry rejects a symlink even if the name pattern matches', !isRegularFileEntry(symlinkEntry));
  assert('isRegularFileEntry rejects null (path absent from the tree)', !isRegularFileEntry(null));

  // Reserved CI-fixture episode-number range (2026-09-22 fix): a real
  // fixture path (docs/episode-9993.md, used by test-chat-episode-hook-e2e.ts)
  // blocked post-merge setup twice on its own file's normal create/delete
  // lifecycle before this exclusion existed.
  assert(
    `isProtectedEpisodeFile protects the number just below the fixture threshold (${RESERVED_FIXTURE_EPISODE_MIN - 1})`,
    isProtectedEpisodeFile(`docs/episode-${RESERVED_FIXTURE_EPISODE_MIN - 1}.md`),
  );
  assert(
    `isProtectedEpisodeFile excludes the fixture threshold itself (${RESERVED_FIXTURE_EPISODE_MIN})`,
    !isProtectedEpisodeFile(`docs/episode-${RESERVED_FIXTURE_EPISODE_MIN}.md`),
  );
  assert(
    'isProtectedEpisodeFile excludes the real docs/episode-9993.md fixture path',
    !isProtectedEpisodeFile('docs/episode-9993.md'),
  );
  assert(
    'isProtectedEpisodeFile excludes the 5-digit random fixture range (e.g. episode-93412.md)',
    !isProtectedEpisodeFile('docs/episode-93412.md'),
  );
  assert(
    'isProtectedEpisodeFile still protects real low-numbered episodes (27, 28, 34)',
    isProtectedEpisodeFile('docs/episode-27.md') && isProtectedEpisodeFile('docs/episode-34.md'),
  );

  // Legacy bare-numbered fixture (2026-09-25 fix): docs/episode-99.md is
  // test-rolling-sync-guard.ts's real-repo fixture, predating the 9900+
  // convention above. Blocked two consecutive, otherwise-unrelated task
  // merges before this exclusion existed.
  assert(
    'LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS contains exactly the confirmed legacy fixture (99)',
    LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS.has(99) && LEGACY_RESERVED_FIXTURE_EPISODE_NUMBERS.size === 1,
  );
  assert(
    'isProtectedEpisodeFile excludes the legacy episode-99 fixture (test-rolling-sync-guard.ts)',
    !isProtectedEpisodeFile('docs/episode-99.md'),
  );
  assert(
    'isProtectedEpisodeFile still protects the real neighbors of the legacy fixture (98, 100)',
    isProtectedEpisodeFile('docs/episode-98.md') && isProtectedEpisodeFile('docs/episode-100.md'),
  );

  // ── Hermetic git-backed end-to-end assertions ─────────────────────────────
  console.log('');
  console.log(B('— End-to-end (real temp git repo, real commits) —'));

  const ts = Date.now();
  const repoDir = join(tmpdir(), `episode-content-loss-test-${ts}`);
  const docsDir = join(repoDir, 'docs');

  try {
    mkdirSync(docsDir, { recursive: true });
    git(repoDir, ['init', '-b', 'main', '-q']);
    git(repoDir, ['config', 'user.email', 'ci@test']);
    git(repoDir, ['config', 'user.name', 'CI Test']);
    const runGit = makeGitRunner(repoDir);

    // Scenario A: full truncation (Aug 31 shape)
    const epPath = join(docsDir, 'episode-55.md');
    const realContent = [
      '# Episode 55',
      '',
      '**DAVID:** this is real dialogue line one',
      '**LUCA [Replit]:** this is real dialogue line two',
      '**DAVID:** this is real dialogue line three',
    ].join('\n');
    writeFileSync(epPath, realContent);
    git(repoDir, ['add', 'docs/episode-55.md']);
    git(repoDir, ['commit', '-qm', 'seed: real episode content']);
    const shaBefore = git(repoDir, ['rev-parse', 'HEAD']);

    writeFileSync(epPath, '');
    git(repoDir, ['add', 'docs/episode-55.md']);
    git(repoDir, ['commit', '-qm', 'Update agent memory logs (unrelated, wipes episode)']);
    const shaTruncated = git(repoDir, ['rev-parse', 'HEAD']);

    const truncatedResult = await checkEpisodeContentLoss(runGit, shaBefore, shaTruncated);
    assert(
      'Full truncation to 0 bytes is blocked',
      // All 4 non-trivial lines (the "# Episode 55" header plus 3 dialogue
      // lines) are expected to be reported — the header is real content too.
      truncatedResult.blocked && truncatedResult.violations['docs/episode-55.md']?.length === 4,
      `Got: blocked=${truncatedResult.blocked} violations=${JSON.stringify(truncatedResult.violations)}`,
    );

    // Scenario B: grow-but-lose-content (Sep 21 shape), from the same base
    writeFileSync(epPath, [
      '# Episode 55',
      '',
      '**LUCA [Replit]:** this is real dialogue line two',
      '**DAVID:** this is real dialogue line three',
      '**DAVID:** a different, later exchange entirely',
      '**LUCA [Replit]:** with lots of unrelated new content',
      '**LUCA [Replit]:** making the file bigger overall',
      '**LUCA [Replit]:** even though real content is missing',
    ].join('\n'));
    git(repoDir, ['add', 'docs/episode-55.md']);
    git(repoDir, ['commit', '-qm', 'Update authentication logic (unrelated, drops a line, file grows)']);
    const shaGrowLose = git(repoDir, ['rev-parse', 'HEAD']);

    const growLoseResult = await checkEpisodeContentLoss(runGit, shaBefore, shaGrowLose);
    assert(
      'Grow-but-lose-content end-to-end: blocked even though episode-55.md is now larger',
      growLoseResult.blocked
        && growLoseResult.violations['docs/episode-55.md']?.length === 1
        && growLoseResult.violations['docs/episode-55.md'][0].includes('dialogue line one'),
      `Got: blocked=${growLoseResult.blocked} violations=${JSON.stringify(growLoseResult.violations)}`,
    );

    // Scenario C: override doc present in the same range authorizes the loss
    writeFileSync(join(docsDir, 'episode-content-loss-override-manual-fix.md'), '# Manual fix\n\nIntentional edit, reviewed by David.\n');
    git(repoDir, ['add', 'docs/episode-content-loss-override-manual-fix.md']);
    git(repoDir, ['commit', '-qm', 'Add override doc for intentional edit']);
    const shaWithOverride = git(repoDir, ['rev-parse', 'HEAD']);

    const overrideResult = await checkEpisodeContentLoss(runGit, shaBefore, shaWithOverride);
    assert(
      'Override doc present in range: NOT blocked, but violation is still reported (logged)',
      !overrideResult.blocked && (overrideResult.violations['docs/episode-55.md']?.length ?? 0) > 0,
      `Got: blocked=${overrideResult.blocked} violations=${JSON.stringify(overrideResult.violations)}`,
    );

    // Scenario D: a brand-new episode file (no prior version) is never a violation
    const newEpPath = join(docsDir, 'episode-100.md');
    writeFileSync(newEpPath, '# Episode 100\n\n**DAVID:** first line ever\n');
    git(repoDir, ['add', 'docs/episode-100.md']);
    git(repoDir, ['commit', '-qm', 'seed episode 100']);
    const shaNewEpisode = git(repoDir, ['rev-parse', 'HEAD']);
    const prevSha = git(repoDir, ['rev-parse', 'HEAD~1']);
    const newEpisodeResult = await checkEpisodeContentLoss(runGit, prevSha, shaNewEpisode);
    assert(
      'A brand-new episode file is never flagged as content loss',
      !newEpisodeResult.blocked && Object.keys(newEpisodeResult.violations).length === 0,
      `Got: ${JSON.stringify(newEpisodeResult)}`,
    );

    // Scenario E: lookalike files are out of scope
    writeFileSync(join(docsDir, 'episode-55-gap-analysis.md'), '# regenerated analysis\n');
    git(repoDir, ['add', 'docs/episode-55-gap-analysis.md']);
    git(repoDir, ['commit', '-qm', 'add gap-analysis doc']);
    const shaLookalike = git(repoDir, ['rev-parse', 'HEAD']);
    const lookalikeResult = await checkEpisodeContentLoss(runGit, git(repoDir, ['rev-parse', 'HEAD~1']), shaLookalike);
    assert(
      'A non-numeric lookalike file (episode-55-gap-analysis.md) is out of scope',
      lookalikeResult.changedEpisodeFiles.length === 0,
      `Got: ${JSON.stringify(lookalikeResult.changedEpisodeFiles)}`,
    );

    // Scenario F: a real git failure reading a blob that DOES exist (the
    // exact shape a partial-clone lazy-fetch failure or network error would
    // produce — `ls-tree` still confirms the path is there, but `git show`
    // cannot read it) must fail CLOSED, never be silently treated as "old
    // content was empty, so nothing was lost".
    const failingShowRunner = withInjectedFailure(
      runGit,
      (args) => args[0] === 'show' && args[1] === `${shaBefore}:docs/episode-55.md`,
    );
    let threwOnUnreadableBlob = false;
    let threwMessage = '';
    try {
      await checkEpisodeContentLoss(failingShowRunner, shaBefore, shaTruncated);
    } catch (error) {
      threwOnUnreadableBlob = true;
      threwMessage = error instanceof Error ? error.message : String(error);
    }
    assert(
      'A git-show failure on a blob that ls-tree confirms exists throws (fails closed), not "0 violations"',
      threwOnUnreadableBlob && threwMessage.includes('episode-55.md'),
      `threw=${threwOnUnreadableBlob} message=${JSON.stringify(threwMessage)}`,
    );

    // Also prove the inverse holds: with no injected failure, the exact
    // same range does NOT throw — the throw above is caused by the
    // injected failure, not by some unrelated bug in the range itself.
    let threwWithRealRunner = false;
    try {
      await checkEpisodeContentLoss(runGit, shaBefore, shaTruncated);
    } catch {
      threwWithRealRunner = true;
    }
    assert(
      'Sanity: the same range against the real (non-failing) runner does not throw',
      !threwWithRealRunner,
    );

    // Scenario G: an override doc that existed before but was DELETED in
    // this same change must NOT authorize content loss in this change —
    // only a matching path that still exists as a regular file at newSha
    // counts as an active override.
    const ep101Path = join(docsDir, 'episode-101.md');
    const overrideTempPath = join(docsDir, 'episode-content-loss-override-temp.md');
    writeFileSync(ep101Path, ['# Episode 101', '**DAVID:** real line that must not be lost'].join('\n'));
    writeFileSync(overrideTempPath, '# temp override\n\nReviewed by David.\n');
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-qm', 'seed episode 101 with an override doc present']);
    const shaOverrideSeed = git(repoDir, ['rev-parse', 'HEAD']);

    writeFileSync(ep101Path, '# Episode 101\n'); // drops the real dialogue line
    rmSync(overrideTempPath);
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-qm', 'drop real content AND delete the override doc in the same commit']);
    const shaOverrideDeleted = git(repoDir, ['rev-parse', 'HEAD']);

    const deletedOverrideResult = await checkEpisodeContentLoss(runGit, shaOverrideSeed, shaOverrideDeleted);
    assert(
      'A deleted override doc does NOT authorize content loss in the same change (still blocked)',
      deletedOverrideResult.blocked
        && deletedOverrideResult.overrideDocsPresent.length === 0
        && (deletedOverrideResult.violations['docs/episode-101.md']?.length ?? 0) > 0,
      `Got: ${JSON.stringify(deletedOverrideResult)}`,
    );

    // ── Negative control: prove a no-op guard would NOT have caught scenario B ──
    const noopBlocked = false; // what checkEpisodeContentLoss would report if its body were stubbed to always pass
    assert(
      'Regression guard: the real check disagrees with a stubbed no-op on the grow-but-lose scenario',
      growLoseResult.blocked !== noopBlocked,
      'The real check must actively detect this case, not just structurally resemble a detector.',
    );

    // All receipt scenarios are synthetic and confined to this disposable repo.
    const attributionBefore = '# Synthetic dialogue\n\nDavid [Claude Code]: Preserve this question.\n\nClaude Code: Exact words — punctuation! 🙂\nSecond line must survive.\n';
    const attributionAfter = attributionBefore.replace('Claude Code: Exact', 'LUCA [Claude Code]: Exact');
    const attributionPath = join(docsDir, 'episode-34.md');
    const otherEpisodePath = join(docsDir, 'episode-35.md');
    const receiptRelPath = 'docs/episode-34-attribution-repair-evidence.json';
    const receiptPath = join(repoDir, receiptRelPath);
    const receipt = {
      episodeId: '41200170-1c49-4660-838c-9d397aff5d27',
      applied: true, replicaParity: true,
      beforeSha256: attributionSha256(attributionBefore),
      afterSha256: attributionSha256(attributionAfter),
      edits: [{
        offset: attributionBefore.indexOf('Claude Code: Exact'),
        oldLabel: 'Claude Code:', newLabel: 'LUCA [Claude Code]:',
        sourceId: 'synthetic-source',
        captureId: 'cc-c52bede8-dd68-4804-8f77-59290f60b9e2-900001',
        spokenSha256: attributionSha256('Exact words — punctuation! 🙂\nSecond line must survive.\n'),
      }],
    };
    const commitFixture = (message: string): string => {
      git(repoDir, ['add', '-A']);
      git(repoDir, ['commit', '--allow-empty', '-qm', message]);
      return git(repoDir, ['rev-parse', 'HEAD']);
    };
    writeFileSync(attributionPath, attributionBefore);
    writeFileSync(otherEpisodePath, attributionBefore);
    const attributionBase = commitFixture('seed synthetic attribution snapshots');
    writeFileSync(attributionPath, attributionAfter);
    const noReceiptSha = commitFixture('repair without evidence');
    assert('Label changes without receipts remain blocked',
      (await checkEpisodeContentLoss(runGit, attributionBase, noReceiptSha)).blocked);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    assert('An uncommitted valid receipt cannot authorize the incoming commit',
      (await checkEpisodeContentLoss(runGit, attributionBase, noReceiptSha)).blocked);
    const verifiedSha = commitFixture('commit exact repair evidence');
    const verified = await checkEpisodeContentLoss(runGit, attributionBase, verifiedSha);
    assert('Exact committed label-only repair passes without an override',
      !verified.blocked && Object.keys(verified.violations).length === 0 &&
      verified.overrideDocsPresent.length === 0);
    writeFileSync(attributionPath, attributionAfter + '\nDaniela: Newly appended content.\n');
    assert('Verified repair plus appended dialogue passes',
      !(await checkEpisodeContentLoss(runGit, attributionBase, commitFixture('append synthetic dialogue'))).blocked);
    for (const [label, changed] of [
      ['lost words', attributionAfter.replace('Second line must survive.', '')],
      ['changed punctuation', attributionAfter.replace('punctuation!', 'punctuation?')],
      ['changed other speaker', attributionAfter.replace('David [Claude Code]:', 'Daniela:')],
      ['reordered dialogue', attributionAfter.split('\n').reverse().join('\n')],
      ['whole episode deletion', null],
    ] as const) {
      if (changed === null) rmSync(attributionPath);
      else writeFileSync(attributionPath, changed);
      assert(`A valid receipt cannot authorize ${label}`,
        (await checkEpisodeContentLoss(runGit, attributionBase, commitFixture(label))).blocked);
    }
    writeFileSync(attributionPath, attributionAfter);
    for (const [label, invalid] of [
      ['malformed JSON', '{'],
      ['wrong old hash', JSON.stringify({ ...receipt, beforeSha256: '0'.repeat(64) })],
      ['wrong repaired hash', JSON.stringify({ ...receipt, afterSha256: '0'.repeat(64) })],
      ['wrong episode ID', JSON.stringify({ ...receipt, episodeId: 'synthetic-wrong-episode' })],
      ['unapplied receipt', JSON.stringify({ ...receipt, applied: false })],
      ['missing replica parity', JSON.stringify({ ...receipt, replicaParity: false })],
      ['forged speaker span', JSON.stringify({ ...receipt, edits: [{ ...receipt.edits[0], newLabel: 'Daniela:' }] })],
    ]) {
      writeFileSync(receiptPath, invalid);
      assert(`${label} cannot suppress loss detection`,
        (await checkEpisodeContentLoss(runGit, attributionBase, commitFixture(label))).blocked);
    }
    rmSync(receiptPath);
    symlinkSync(JSON.stringify(receipt), receiptPath);
    assert('Even a symlink blob containing valid JSON cannot authorize a repair',
      (await checkEpisodeContentLoss(runGit, attributionBase, commitFixture('symlink receipt'))).blocked);
    rmSync(receiptPath);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const goodReceiptSha = commitFixture('restore regular receipt');
    for (const command of ['ls-tree', 'show']) {
      const failingReceiptRunner: GitRunner = async (args) =>
        args[0] === command && args.some(arg => arg === receiptRelPath || arg.endsWith(`:${receiptRelPath}`))
          ? { stdout: '', exitCode: 1 } : runGit(args);
      let rejected = false;
      try {
        await checkEpisodeContentLoss(failingReceiptRunner, attributionBase, goodReceiptSha);
      } catch { rejected = true; }
      assert(`Receipt ${command} failure refuses to guess`, rejected);
    }
    rmSync(receiptPath);
    assert('Deleted committed evidence does not authorize a repair',
      (await checkEpisodeContentLoss(runGit, attributionBase, commitFixture('delete receipt'))).blocked);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(otherEpisodePath, attributionAfter);
    const scoped = await checkEpisodeContentLoss(runGit, attributionBase, commitFixture('repair another episode'));
    assert('Episode 34 evidence cannot authorize the identical change in another episode',
      scoped.blocked && !scoped.violations['docs/episode-34.md'] &&
      (scoped.violations['docs/episode-35.md']?.length ?? 0) > 0);
  } finally {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }

  console.log('');
  const total = passed + failed;
  if (failed === 0) {
    console.log(G(`✓  Self-check passed (${total} assertions).\n`));
    process.exit(0);
  } else {
    console.log(R(`✗  ${failed} of ${total} assertions failed — episode content-loss guard is NOT working correctly.\n`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes('--self-check')) {
    await runSelfCheck();
  } else {
    await runNormalMode();
  }
}

main().catch((err) => {
  console.error(R(`\n[episode-content-loss] Unhandled error: ${err?.message ?? err}\n`));
  process.exit(1);
});
