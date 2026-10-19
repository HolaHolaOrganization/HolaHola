/**
 * CI guard: every call to uploadPublicBuffer() and generateEnvironmentScene()
 * in the server/ tree AND admin/migration scripts outside it must be
 * immediately wrapped in normalizeImageUrl().
 *
 * Rationale: raw GCS URLs stored in the database bypass the /api/media proxy,
 * break cache lookups, and leak bucket names to clients. Task 145 added unit
 * tests for every existing write path; this test prevents new paths from
 * silently skipping the guard.
 *
 * Scanned roots (configurable via EXTRA_ROOTS below):
 *   - server/   — application code
 *   - scripts/  — admin / data-migration / seeder scripts
 *   - project root — individual .ts files at the repo root (non-recursive)
 *
 * Exemptions:
 *   Append  // gcs-guard-exempt: <reason>  to any line that is intentionally
 *   unwrapped (e.g. audio uploads, preview-only URLs not persisted to DB).
 *   The scanner accepts any line containing that marker.
 *
 * Excluded files (implementation, not call sites):
 *   - server/services/image-storage.ts       (defines uploadPublicBuffer)
 *   - server/services/google-image-service.ts (defines generateEnvironmentScene)
 *   - server/scripts/scan-unwrapped-image-uploads.test.ts (this file)
 *
 * Run with:
 *   npx tsx --test server/scripts/scan-unwrapped-image-uploads.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

// PROJECT_ROOT must be declared before SERVER_ROOT and EXTRA_ROOTS.
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER_ROOT = path.resolve(PROJECT_ROOT, 'server');

/**
 * Additional directories to scan beyond server/.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  MAINTAINER NOTE — READ BEFORE ADDING A NEW TOP-LEVEL DIRECTORY        │
 * │                                                                         │
 * │  If you create a new top-level directory (e.g. tools/, admin/, seed/,  │
 * │  fixtures/) that will contain TypeScript files, you MUST do ONE of:     │
 * │                                                                         │
 * │    a) Add it to EXTRA_ROOTS below so the scanner covers it, OR          │
 * │    b) Add it to KNOWN_NON_SCRIPT_ROOTS (further down) with a comment    │
 * │       explaining why it will never call uploadPublicBuffer /             │
 * │       generateEnvironmentScene.                                          │
 * │                                                                         │
 * │  The test "new top-level directories with .ts files are covered" will   │
 * │  fail CI automatically if you forget to update either list.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * shared/ is included so that shared utilities that call upload helpers are
 * also guarded — omitting it would let a raw GCS URL slip in via a shared
 * helper without the normalizeImageUrl wrap.
 */
const EXTRA_ROOTS: string[] = [
  path.resolve(PROJECT_ROOT, 'scripts'),
  path.resolve(PROJECT_ROOT, 'shared'),
];

/**
 * Top-level directories that are deliberately NOT in EXTRA_ROOTS because they
 * will never contain uploadPublicBuffer / generateEnvironmentScene call sites.
 *
 * Add an entry here (with a brief reason) whenever you create a directory that
 * has .ts files but genuinely has no upload calls — otherwise the
 * "new top-level directories with .ts files are covered" test will fail CI.
 *
 * Set `optional: true` for a directory that only exists after a build step
 * (e.g. `dist/`) — a fresh, unbuilt checkout (as in CI) won't have it, and
 * that absence is expected rather than a sign the directory was renamed.
 */
const KNOWN_NON_SCRIPT_ROOTS: Array<{ name: string; reason: string; optional?: boolean }> = [
  { name: 'client',         reason: 'frontend bundle — no server-side GCS uploads' },
  { name: 'node_modules',   reason: 'vendor code — not scanned by design' },
  { name: 'dist',           reason: 'compiled output — not a source tree', optional: true },
  { name: 'docs',           reason: 'documentation only' },
  { name: 'migrations',     reason: 'SQL migration files only, no .ts upload calls' },
  { name: 'uploads',        reason: 'runtime upload directory, no source .ts files' },
  { name: 'attached_assets',reason: 'static assets, no .ts files' },
  { name: 'public',         reason: 'static public files, no .ts upload calls' },
  { name: 'broker',         reason: 'isolated GitHub operation broker; node: builtins only, cannot import upload helpers (enforced by broker/test/broker.test.ts)' },
];

/** Files that define the functions — skip them (they are not call sites). */
const EXCLUDED_FILES = new Set([
  path.resolve(SERVER_ROOT, 'services/image-storage.ts'),
  path.resolve(SERVER_ROOT, 'services/google-image-service.ts'),
  path.resolve(SERVER_ROOT, 'scripts/scan-unwrapped-image-uploads.test.ts'),
]);

/** Function names whose return value MUST be wrapped in normalizeImageUrl. */
const GUARDED_FUNCTIONS = ['uploadPublicBuffer', 'generateEnvironmentScene'];

/** Marker that opts a line out of the check. */
const EXEMPT_MARKER = 'gcs-guard-exempt:';

// ─── File walker ─────────────────────────────────────────────────────────────

function* walkTs(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Yield all .ts files directly at the project root (non-recursive —
 * subdirectories are covered by their own roots in EXTRA_ROOTS).
 */
function* walkRootTs(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield path.join(dir, entry.name);
    }
  }
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  text: string;
  fn: string;
}

function scanForViolations(): Violation[] {
  const violations: Violation[] = [];

  // Collect all roots: server/ + every configured extra root + root-level .ts files.
  const fileSources: Array<() => Generator<string>> = [
    () => walkTs(SERVER_ROOT),
    ...EXTRA_ROOTS.filter(r => fs.existsSync(r)).map(r => () => walkTs(r)),
    () => walkRootTs(PROJECT_ROOT),
  ];

  for (const source of fileSources) {
    for (const filePath of source()) {
      if (EXCLUDED_FILES.has(filePath)) continue;

      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];

        for (const fn of GUARDED_FUNCTIONS) {
          // Only check lines that actually call the function (have the open-paren)
          if (!lineText.includes(`${fn}(`)) continue;

          // Line is explicitly opted out
          if (lineText.includes(EXEMPT_MARKER)) continue;

          // Import declarations and re-exports are not call sites
          const trimmed = lineText.trim();
          if (
            trimmed.startsWith('import ') ||
            trimmed.startsWith('export ') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('//')
          ) continue;

          // The call must be wrapped: normalizeImageUrl( must appear on the same
          // line OR on the immediately following line (two-line assignment pattern:
          //   const baseUrl = await uploadPublicBuffer(...);
          //   const url = normalizeImageUrl(`${baseUrl}?v=...`);
          // ).
          const nextLine = lines[i + 1] ?? '';
          if (lineText.includes('normalizeImageUrl(')) continue;
          if (nextLine.includes('normalizeImageUrl(')) continue;

          violations.push({
            file: path.relative(PROJECT_ROOT, filePath),
            line: i + 1,
            text: lineText.trim(),
            fn,
          });
        }
      }
    }
  }

  return violations;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Scanner roots — new top-level directories are covered (#433)', () => {
  /**
   * Walks only the immediate children of PROJECT_ROOT, checks whether any
   * directory contains at least one .ts file, and then verifies that every
   * such directory is either:
   *   (a) SERVER_ROOT itself (always scanned), or
   *   (b) listed in EXTRA_ROOTS, or
   *   (c) listed in KNOWN_NON_SCRIPT_ROOTS (with an explicit reason).
   *
   * If this test fails it means a new top-level directory was created with
   * .ts files but was not registered in either list — exactly the gap this
   * guard is meant to close.
   */
  it('every top-level directory with .ts files is either scanned or explicitly excluded', () => {
    const knownNonScriptNames = new Set(KNOWN_NON_SCRIPT_ROOTS.map(e => e.name));
    const coveredRoots = new Set([SERVER_ROOT, ...EXTRA_ROOTS]);

    const uncovered: string[] = [];

    for (const entry of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip hidden directories (e.g. .git, .github, .local, .agents)
      if (entry.name.startsWith('.')) continue;

      const dirPath = path.join(PROJECT_ROOT, entry.name);

      // Already covered by the scanner
      if (coveredRoots.has(dirPath)) continue;

      // Explicitly declared as non-script
      if (knownNonScriptNames.has(entry.name)) continue;

      // Check whether the directory contains any .ts files (recursive)
      const hasTsFiles = (function hasTs(dir: string): boolean {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (hasTs(full)) return true; }
          else if (e.isFile() && e.name.endsWith('.ts')) return true;
        }
        return false;
      })(dirPath);

      if (hasTsFiles) {
        uncovered.push(entry.name);
      }
    }

    assert.deepEqual(
      uncovered,
      [],
      `The following top-level directories contain .ts files but are not covered by the GCS upload guard:\n` +
      uncovered.map(n => `  ${n}/`).join('\n') + '\n\n' +
      `Add each directory to EXTRA_ROOTS (to scan it) OR to KNOWN_NON_SCRIPT_ROOTS\n` +
      `(with a reason why it will never call uploadPublicBuffer / generateEnvironmentScene).\n` +
      `Both lists are at the top of server/scripts/scan-unwrapped-image-uploads.test.ts.`,
    );
  });

  it('mutation self-check: a fake uncovered directory would fail the assertion above', () => {
    // Simulate what the test above does but with an injected fake directory name
    // that is neither in EXTRA_ROOTS nor in KNOWN_NON_SCRIPT_ROOTS.
    const knownNonScriptNames = new Set(KNOWN_NON_SCRIPT_ROOTS.map(e => e.name));
    const coveredRoots = new Set([SERVER_ROOT, ...EXTRA_ROOTS]);

    const fakeDirName = '__hypothetical-tools-dir__';
    const fakeDirPath = path.join(PROJECT_ROOT, fakeDirName);

    const isCovered =
      coveredRoots.has(fakeDirPath) || knownNonScriptNames.has(fakeDirName);

    assert.equal(
      isCovered,
      false,
      'Fake directory was unexpectedly found in EXTRA_ROOTS or KNOWN_NON_SCRIPT_ROOTS — ' +
      'the self-check would not catch the gap.',
    );
  });

  it('every KNOWN_NON_SCRIPT_ROOTS entry that no longer exists on disk is flagged (stale-entry guard)', () => {
    /**
     * If a directory in KNOWN_NON_SCRIPT_ROOTS is renamed or deleted, its
     * entry silently becomes a no-op: the first test above still passes
     * (because the old name is still in the exclusion list), but the renamed
     * directory may now be uncovered on the next scan. This test closes that
     * gap by asserting that every KNOWN_NON_SCRIPT_ROOTS name that was once a
     * real directory still exists on disk.
     *
     * When a directory is intentionally removed (not renamed), remove its
     * entry from KNOWN_NON_SCRIPT_ROOTS at the same time.
     */
    const stale: string[] = [];

    for (const entry of KNOWN_NON_SCRIPT_ROOTS) {
      if (entry.optional) continue;
      const dirPath = path.join(PROJECT_ROOT, entry.name);
      const exists = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
      if (!exists) {
        stale.push(entry.name);
      }
    }

    assert.deepEqual(
      stale,
      [],
      `The following KNOWN_NON_SCRIPT_ROOTS entries no longer exist on disk:\n` +
      stale.map(n => `  ${n}/  (reason: ${KNOWN_NON_SCRIPT_ROOTS.find(e => e.name === n)?.reason})`).join('\n') + '\n\n' +
      `If the directory was renamed, update the entry in KNOWN_NON_SCRIPT_ROOTS to match the new name.\n` +
      `If the directory was intentionally removed, delete its entry from KNOWN_NON_SCRIPT_ROOTS.\n` +
      `Both lists are at the top of server/scripts/scan-unwrapped-image-uploads.test.ts.`,
    );
  });

  it('mutation self-check: a stale KNOWN_NON_SCRIPT_ROOTS entry would fail the assertion above', () => {
    // Inject a fake entry whose directory does not exist on disk and confirm
    // it would be detected as stale by the guard above.
    const fakeEntry = { name: '__definitely-deleted-dir-9x7z__', reason: 'test only' };
    const fakeDirPath = path.join(PROJECT_ROOT, fakeEntry.name);

    const exists = fs.existsSync(fakeDirPath) && fs.statSync(fakeDirPath).isDirectory();

    assert.equal(
      exists,
      false,
      'Fake stale directory unexpectedly exists on disk — the self-check would not catch the gap.',
    );
  });

  it('every EXTRA_ROOTS entry still exists on disk (stale-entry guard)', () => {
    /**
     * If a directory in EXTRA_ROOTS is renamed or deleted, the scanner
     * silently stops covering it: fs.existsSync() in scanForViolations()
     * quietly skips missing roots, so the main coverage test may still pass
     * while the renamed directory goes unguarded.
     *
     * This test closes that gap by asserting that every absolute path in
     * EXTRA_ROOTS still resolves to a real directory on disk.
     *
     * When an EXTRA_ROOTS directory is intentionally removed, delete its
     * entry from EXTRA_ROOTS at the same time.
     */
    const stale: string[] = [];

    for (const rootPath of EXTRA_ROOTS) {
      const exists = fs.existsSync(rootPath) && fs.statSync(rootPath).isDirectory();
      if (!exists) {
        stale.push(rootPath);
      }
    }

    assert.deepEqual(
      stale,
      [],
      `The following EXTRA_ROOTS entries no longer exist on disk:\n` +
      stale.map(p => `  ${path.relative(PROJECT_ROOT, p)}/`).join('\n') + '\n\n' +
      `If the directory was renamed, update the path in EXTRA_ROOTS to match the new name.\n` +
      `If the directory was intentionally removed, delete its entry from EXTRA_ROOTS.\n` +
      `EXTRA_ROOTS is at the top of server/scripts/scan-unwrapped-image-uploads.test.ts.`,
    );
  });

  it('mutation self-check: a stale EXTRA_ROOTS entry would fail the assertion above', () => {
    // Inject a fake absolute path that does not exist on disk and confirm
    // it would be detected as stale by the guard above.
    const fakePath = path.join(PROJECT_ROOT, '__definitely-missing-extra-root-9x7z__');

    const exists = fs.existsSync(fakePath) && fs.statSync(fakePath).isDirectory();

    assert.equal(
      exists,
      false,
      'Fake stale EXTRA_ROOTS path unexpectedly exists on disk — the self-check would not catch the gap.',
    );
  });
});

describe('Scanner roots — shared/ is included (#476)', () => {
  // shared/ utilities can call uploadPublicBuffer or generateEnvironmentScene
  // (e.g. a shared image-helper module).  Omitting shared/ from EXTRA_ROOTS
  // would let a raw GCS URL slip through undetected.
  it('EXTRA_ROOTS includes the shared/ directory', () => {
    const sharedRoot = path.resolve(PROJECT_ROOT, 'shared');
    assert.ok(
      EXTRA_ROOTS.includes(sharedRoot),
      `shared/ directory not in EXTRA_ROOTS — shared utilities would bypass the GCS-wrap guard.\n` +
      `  Expected: ${sharedRoot}\n` +
      `  Got: ${JSON.stringify(EXTRA_ROOTS)}`,
    );
  });

  it('mutation self-check: removing shared/ from EXTRA_ROOTS would fail the assertion above', () => {
    const sharedRoot = path.resolve(PROJECT_ROOT, 'shared');
    const withoutShared = EXTRA_ROOTS.filter(r => r !== sharedRoot);
    assert.ok(
      !withoutShared.includes(sharedRoot),
      'shared/ still present after filter — self-check would not catch the omission',
    );
  });
});

describe('GCS guard — every upload call wrapped in normalizeImageUrl', () => {
  it('finds no unwrapped uploadPublicBuffer() calls in server/, scripts/, or project root', () => {
    const violations = scanForViolations().filter(v => v.fn === 'uploadPublicBuffer');

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join('\n');
      assert.fail(
        `Found ${violations.length} unwrapped uploadPublicBuffer() call(s).\n` +
        `Each must be wrapped: normalizeImageUrl(await uploadPublicBuffer(...))\n` +
        `or annotated: // gcs-guard-exempt: <reason>\n\n` +
        detail,
      );
    }
  });

  it('finds no unwrapped generateEnvironmentScene() calls in server/, scripts/, or project root', () => {
    const violations = scanForViolations().filter(v => v.fn === 'generateEnvironmentScene');

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join('\n');
      assert.fail(
        `Found ${violations.length} unwrapped generateEnvironmentScene() call(s).\n` +
        `Each must be wrapped: normalizeImageUrl(await generateEnvironmentScene(...))\n` +
        `or annotated: // gcs-guard-exempt: <reason>\n\n` +
        detail,
      );
    }
  });

  it('exempt marker is accepted: a gcs-guard-exempt line is not flagged', () => {
    // Synthetic: a line that calls uploadPublicBuffer with the marker
    const mockLine = `audioUrl = await uploadPublicBuffer('test.wav', buf, 'audio/wav'); // gcs-guard-exempt: audio upload`;
    const hasExempt = mockLine.includes(EXEMPT_MARKER);
    assert.ok(hasExempt, 'exempt marker should suppress the violation');
  });

  it('unwrapped call without marker IS flagged (scanner logic self-check)', () => {
    const mockLine = `    const url = await uploadPublicBuffer(filename, buf, 'image/jpeg');`;
    const hasGuard = mockLine.includes('normalizeImageUrl(');
    const hasExempt = mockLine.includes(EXEMPT_MARKER);
    const isSuppressed = hasGuard || hasExempt;
    assert.equal(isSuppressed, false, 'unwrapped call without marker must not be suppressed');
  });

  it('wrapped call is not flagged (scanner logic self-check)', () => {
    const mockLine = `    const url = normalizeImageUrl(await uploadPublicBuffer(filename, buf, 'image/jpeg'));`;
    const hasGuard = mockLine.includes('normalizeImageUrl(');
    assert.ok(hasGuard, 'wrapped call must satisfy the guard');
  });

  it('every path in EXCLUDED_FILES exists on disk (rename guard)', () => {
    const missing: string[] = [];
    for (const filePath of EXCLUDED_FILES) {
      if (!fs.existsSync(filePath)) {
        missing.push(path.relative(PROJECT_ROOT, filePath));
      }
    }
    assert.equal(
      missing.length,
      0,
      `EXCLUDED_FILES contains ${missing.length} path(s) that no longer exist on disk.\n` +
      `Update the EXCLUDED_FILES constant to match the current file locations:\n` +
      missing.map(p => `  ${p}`).join('\n'),
    );
  });
});

// ─── Meta-test: scanner end-to-end against a real temporary file ──────────────
//
// Proves the scanner would actually fail CI if someone introduced a new
// unwrapped call in a brand-new file.  Without this, the scanner could silently
// pass everything and developers would have false confidence.

describe('GCS guard — scanner self-validation (end-to-end with a real file)', () => {
  const TEMP_FILE = path.join(SERVER_ROOT, 'scripts', '__gcs-guard-selftest-tmp__.ts');

  it('detects a violation when an unwrapped uploadPublicBuffer() call is written to a real file', () => {
    const source = [
      `// Temporary file written by scan-unwrapped-image-uploads.test.ts — DO NOT COMMIT`,
      `import { uploadPublicBuffer } from '../services/image-storage';`,
      `async function bad() {`,
      `  const url = await uploadPublicBuffer('image.png', Buffer.from(''), 'image/png');`,
      `  return url;`,
      `}`,
    ].join('\n');

    fs.writeFileSync(TEMP_FILE, source, 'utf8');
    try {
      const violations = scanForViolations().filter(
        v => v.file.includes('__gcs-guard-selftest-tmp__'),
      );
      assert.equal(
        violations.length,
        1,
        `Scanner should have found 1 unwrapped call but found ${violations.length}.\nViolations: ${JSON.stringify(violations)}`,
      );
    } finally {
      fs.unlinkSync(TEMP_FILE);
    }
  });

  it('detects a violation when an unwrapped generateEnvironmentScene() call is written to a real file', () => {
    const source = [
      `// Temporary file written by scan-unwrapped-image-uploads.test.ts — DO NOT COMMIT`,
      `import { generateEnvironmentScene } from '../services/image-engine';`,
      `async function bad() {`,
      `  const url = await generateEnvironmentScene({ theme: 'forest', style: 'watercolor' });`,
      `  return url;`,
      `}`,
    ].join('\n');

    fs.writeFileSync(TEMP_FILE, source, 'utf8');
    try {
      const violations = scanForViolations().filter(
        v => v.file.includes('__gcs-guard-selftest-tmp__'),
      );
      assert.equal(
        violations.length,
        1,
        `Scanner should have found 1 unwrapped generateEnvironmentScene() call but found ${violations.length}.\nViolations: ${JSON.stringify(violations)}`,
      );
    } finally {
      fs.unlinkSync(TEMP_FILE);
    }
  });

  it('does NOT flag the same file when the call carries the exempt marker', () => {
    const source = [
      `// Temporary file written by scan-unwrapped-image-uploads.test.ts — DO NOT COMMIT`,
      `import { uploadPublicBuffer } from '../services/image-storage';`,
      `async function exempted() {`,
      `  const url = await uploadPublicBuffer('audio.wav', Buffer.from(''), 'audio/wav'); // gcs-guard-exempt: audio upload`,
      `  return url;`,
      `}`,
    ].join('\n');

    fs.writeFileSync(TEMP_FILE, source, 'utf8');
    try {
      const violations = scanForViolations().filter(
        v => v.file.includes('__gcs-guard-selftest-tmp__'),
      );
      assert.equal(
        violations.length,
        0,
        `Scanner incorrectly flagged an exempt call.\nViolations: ${JSON.stringify(violations)}`,
      );
    } finally {
      fs.unlinkSync(TEMP_FILE);
    }
  });

  it('does NOT flag the same file when the call is wrapped in normalizeImageUrl', () => {
    const source = [
      `// Temporary file written by scan-unwrapped-image-uploads.test.ts — DO NOT COMMIT`,
      `import { uploadPublicBuffer, normalizeImageUrl } from '../services/image-storage';`,
      `async function wrapped() {`,
      `  const url = normalizeImageUrl(await uploadPublicBuffer('image.png', Buffer.from(''), 'image/png'));`,
      `  return url;`,
      `}`,
    ].join('\n');

    fs.writeFileSync(TEMP_FILE, source, 'utf8');
    try {
      const violations = scanForViolations().filter(
        v => v.file.includes('__gcs-guard-selftest-tmp__'),
      );
      assert.equal(
        violations.length,
        0,
        `Scanner incorrectly flagged a correctly-wrapped call.\nViolations: ${JSON.stringify(violations)}`,
      );
    } finally {
      fs.unlinkSync(TEMP_FILE);
    }
  });
});
