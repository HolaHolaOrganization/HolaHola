/**
 * Regression guard for the CLI-entrypoint substring-guard antipattern that
 * task 1583 fixed across 20 scripts: a guard written as
 * `process.argv[1]?.includes('<script-base-name>')` fires whenever anything
 * with that substring in its own filename imports the script -- most often
 * this repo's own `test-<subject>.test.ts` naming convention, where a test
 * importing a script for its exported functions has a filename that is a
 * superstring of the script's base name by construction. That false-positive
 * match runs the script's CLI body as an import side effect, including (in
 * several scripts) a `.finally(closeDbConnections)` that tears down the
 * shared DB pool mid-test-run and breaks every later query in that process
 * with an unrelated-looking Drizzle "Failed query" error.
 *
 * server/scripts/lib/cli-entrypoint.ts's isDirectCliInvocation() is the fix:
 * an exact basename comparison instead of a substring match. This check
 * statically scans server/scripts/**\/*.ts for the substring pattern that
 * caused the original bug, so a brand-new script cannot silently reintroduce
 * it. See .agents/memory/esbuild-ismain-guard.md for the second, related
 * failure mode (import.meta.url inside the esbuild production bundle) that
 * isDirectCliInvocation() also guards against.
 *
 * It also flags two separator-dependent forms that silently never match on
 * Windows, where process.argv[1] holds backslashes: `process.argv[1]` +
 * `.endsWith(` (a `'/<name>.ts'` suffix never matches a backslash path, and
 * a bare `'<name>.ts'` suffix shares the test-file collision above), and the
 * `file://${process.argv[1]}` template compared against import.meta.url (a
 * Windows path never forms the same file URL that way). A guard that never
 * matches makes the CLI exit 0 having done nothing -- a shared-spec `share`
 * looked successful but wrote nothing this way.
 *
 * This is a narrow, syntactic guard -- it does not evaluate every possible
 * hand-rolled entry-point check, only those exact combinations.
 *
 * Self-check (--self-check flag):
 *   Uses scanForUnsafeEntrypointGuard() as a live test seam: points it at a
 *   synthetic temp directory containing a file that reintroduces the unsafe
 *   pattern (must be flagged), a file correctly using the shared helper (must
 *   not be flagged), and a lib/cli-entrypoint.ts stand-in whose own doc
 *   comment mentions the pattern (must be exempted by path, exactly like the
 *   real file). Also proves that exemption is load-bearing by re-running
 *   without it and confirming the same file then gets flagged. Proves the
 *   guard would actually catch the regression it exists to catch, not just
 *   that it passes today.
 *
 * Usage:
 *   npx tsx server/scripts/test-cli-entrypoint-guard-pattern.ts             # normal check
 *   npx tsx server/scripts/test-cli-entrypoint-guard-pattern.ts --self-check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'server', 'scripts');

const IS_SELF_CHECK = process.argv.includes('--self-check');

// Matches `process.argv[1]` optionally followed by `?`, then `.includes(` --
// the exact antipattern task 1583 fixed -- or by `.endsWith(`, or the
// `file://${process.argv[1]}` template (see the header for why each is
// unsafe). Kept as one regex so there is exactly one definition of "the
// pattern" to keep in sync.
const UNSAFE_GUARD_PATTERN = /process\.argv\[1\]\??\.(?:includes|endsWith)\(|file:\/\/\$\{process\.argv\[1\]\}/;

// Scan-root-relative (POSIX) paths that legitimately mention the pattern
// without using it -- cli-entrypoint.ts documents the antipattern in its own
// doc comment as the reason the shared helper exists.
const DOC_COMMENT_EXEMPTIONS = new Set<string>(['lib/cli-entrypoint.ts']);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n    ${detail}` : ''}`);
    failed++;
  }
}

export interface UnsafeGuardViolation {
  file: string;
  line: number;
  text: string;
}

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Pure function so --self-check can point it at a synthetic temp directory
 * instead of the real server/scripts tree.
 *
 * @param rootDir Directory to scan recursively for *.ts files.
 * @param selfPath Absolute path of the running scanner file itself. Always
 *   excluded -- this file's own doc comment above necessarily describes the
 *   pattern it detects.
 * @param exemptions Scan-root-relative (POSIX) paths to exempt in addition to
 *   the self-exclusion above. Defaults to the real DOC_COMMENT_EXEMPTIONS;
 *   --self-check passes its own synthetic exemption set (and an empty one) so
 *   it can prove the exemption mechanism is real without touching the actual
 *   allowlist.
 */
export function scanForUnsafeEntrypointGuard(
  rootDir: string,
  selfPath: string,
  exemptions: Set<string> = DOC_COMMENT_EXEMPTIONS,
): UnsafeGuardViolation[] {
  const violations: UnsafeGuardViolation[] = [];
  for (const file of listTsFilesRecursive(rootDir)) {
    if (path.resolve(file) === path.resolve(selfPath)) continue;

    const relPath = path.relative(rootDir, file).split(path.sep).join('/');
    if (exemptions.has(relPath)) continue;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((lineText, index) => {
      if (UNSAFE_GUARD_PATTERN.test(lineText)) {
        violations.push({ file: relPath, line: index + 1, text: lineText.trim() });
      }
    });
  }
  return violations;
}

function runSelfCheck(): void {
  console.log('\n[SELF-CHECK] Proving scanForUnsafeEntrypointGuard() actually catches a reintroduced regression.\n');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-entrypoint-guard-selfcheck-'));
  try {
    // Scenario A: a brand-new script reintroducing the unsafe substring guard.
    fs.writeFileSync(
      path.join(tmpBase, 'brand-new-script.ts'),
      "const isMain = process.argv[1]?.includes('brand-new-script');\n",
    );

    // Scenarios A2/A3: the separator-dependent forms that never match on
    // Windows -- a `'/<name>.ts'` suffix and the `file://${argv[1]}` template.
    fs.writeFileSync(
      path.join(tmpBase, 'suffix-script.ts'),
      "if (process.argv[1]?.endsWith('/suffix-script.ts')) main();\n",
    );
    fs.writeFileSync(
      path.join(tmpBase, 'file-url-script.ts'),
      'if (import.meta.url === `file://${process.argv[1]}`) main();\n',
    );

    // Scenario B: a script correctly using the safe shared helper -- must NOT
    // be flagged, proving no false positive on the fix itself.
    fs.mkdirSync(path.join(tmpBase, 'lib'));
    fs.writeFileSync(
      path.join(tmpBase, 'safe-script.ts'),
      "import { isDirectCliInvocation } from './lib/cli-entrypoint';\n" +
        "const isMain = isDirectCliInvocation('safe-script.ts');\n",
    );

    // Scenario C: a lib/cli-entrypoint.ts stand-in whose doc comment mentions
    // the unsafe pattern -- must be exempted by path, exactly like the real file.
    fs.writeFileSync(
      path.join(tmpBase, 'lib', 'cli-entrypoint.ts'),
      "/** Do not write process.argv[1]?.includes('<name>') -- see the real guard. */\n" +
        'export function isDirectCliInvocation(name: string): boolean { return false; }\n',
    );

    const results = scanForUnsafeEntrypointGuard(tmpBase, __filename, new Set(['lib/cli-entrypoint.ts']));

    const brandNewFlagged = results.some(v => v.file === 'brand-new-script.ts');
    assert(brandNewFlagged, 'a brand-new script reintroducing the unsafe substring guard is detected');
    assert(results.some(v => v.file === 'suffix-script.ts'), 'a process.argv[1] .endsWith() suffix guard is detected');
    assert(results.some(v => v.file === 'file-url-script.ts'), 'a file://${process.argv[1]} template guard is detected');

    const safeFlagged = results.some(v => v.file === 'safe-script.ts');
    assert(!safeFlagged, 'a script correctly using the shared isDirectCliInvocation() helper is not flagged');

    const libExemptFlagged = results.some(v => v.file === 'lib/cli-entrypoint.ts');
    assert(!libExemptFlagged, 'the lib/cli-entrypoint.ts doc-comment mention is exempted, exactly like the real file');

    assert(
      results.length === 3,
      'exactly three real violations are reported (the three unsafe scripts, nothing else)',
      `found ${results.length}: ${JSON.stringify(results)}`,
    );

    // Scenario D: without the exemption, the same doc-comment mention IS
    // caught -- proves scenario C above is exercising a real exemption path,
    // not a scan blind spot that would also miss a real regression there.
    const resultsWithoutExemption = scanForUnsafeEntrypointGuard(tmpBase, __filename, new Set());
    const libFlaggedWithoutExemption = resultsWithoutExemption.some(v => v.file === 'lib/cli-entrypoint.ts');
    assert(
      libFlaggedWithoutExemption,
      'removing the exemption makes the same lib/cli-entrypoint.ts doc comment get flagged -- proves the exemption is load-bearing',
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(`\n=== Self-check results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    console.error('[SELF-CHECK] FAIL -- scanForUnsafeEntrypointGuard() would not catch a real regression.');
    process.exit(1);
  }
  console.log('[SELF-CHECK] PASS -- guard is real.\n');
  process.exit(0);
}

function runNormalCheck(): void {
  console.log('\n=== CLI entrypoint guard regression scan (server/scripts/**/*.ts) ===\n');

  const violations = scanForUnsafeEntrypointGuard(SCRIPTS_ROOT, __filename);
  assert(
    violations.length === 0,
    'no server/scripts/*.ts file reintroduces the unsafe process.argv[1] substring guard',
    violations.map(v => `${v.file}:${v.line}: ${v.text}`).join('\n    '),
  );

  if (violations.length > 0) {
    console.error('\n  Use isDirectCliInvocation() from server/scripts/lib/cli-entrypoint.ts instead.');
    console.error('  See .agents/memory/esbuild-ismain-guard.md for why the substring form is unsafe.\n');
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

if (IS_SELF_CHECK) {
  runSelfCheck();
} else {
  runNormalCheck();
}
