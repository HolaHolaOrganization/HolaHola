/**
 * Unit tests for tryNormalize() in scan-gcs-urls.ts
 *
 * Run with:
 *   npx tsx --test server/scripts/scan-gcs-urls.test.ts
 *
 * Uses Node.js built-in test runner (node:test) — no extra packages needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryNormalize, evaluateScanResults, buildStrictWarning, COLUMNS, type ScanResult } from './scan-gcs-urls.js';

// ---------------------------------------------------------------------------
// Pattern 1 — path-style (no query string)
// ---------------------------------------------------------------------------
describe('Pattern 1 — path-style URL', () => {
  it('normalises a basic path-style URL', () => {
    const url = 'https://storage.googleapis.com/my-bucket/public/ai-images/abc123.jpg';
    assert.equal(tryNormalize(url), '/api/media/ai-image/abc123.jpg');
  });

  it('normalises a path-style URL with subdirectory in filename', () => {
    const url = 'https://storage.googleapis.com/holahola-prod/public/ai-images/sub/img.png';
    assert.equal(tryNormalize(url), '/api/media/ai-image/sub/img.png');
  });
});

// ---------------------------------------------------------------------------
// Pattern 2 — path-style with signed query string
// ---------------------------------------------------------------------------
describe('Pattern 2 — path-style signed URL', () => {
  it('strips the signed query string', () => {
    const url =
      'https://storage.googleapis.com/my-bucket/public/ai-images/file.webp' +
      '?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40project.iam.gserviceaccount.com' +
      '&X-Goog-Date=20240101T000000Z&X-Goog-Expires=3600&X-Goog-Signature=deadbeef';
    assert.equal(tryNormalize(url), '/api/media/ai-image/file.webp');
  });

  it('strips a simple ?token=… query string', () => {
    const url =
      'https://storage.googleapis.com/bucket-x/public/ai-images/photo.jpg?token=abc';
    assert.equal(tryNormalize(url), '/api/media/ai-image/photo.jpg');
  });
});

// ---------------------------------------------------------------------------
// Pattern 3 — subdomain-style (no query string)
// ---------------------------------------------------------------------------
describe('Pattern 3 — subdomain-style URL', () => {
  it('normalises a subdomain-style URL', () => {
    const url = 'https://my-bucket.storage.googleapis.com/public/ai-images/scene.jpg';
    assert.equal(tryNormalize(url), '/api/media/ai-image/scene.jpg');
  });

  it('normalises a subdomain URL with hyphens in bucket name', () => {
    const url = 'https://hola-hola-prod.storage.googleapis.com/public/ai-images/env.png';
    assert.equal(tryNormalize(url), '/api/media/ai-image/env.png');
  });
});

// ---------------------------------------------------------------------------
// Pattern 4 — subdomain-style with signed query string
// ---------------------------------------------------------------------------
describe('Pattern 4 — subdomain-style signed URL', () => {
  it('strips signed query string from subdomain URL', () => {
    const url =
      'https://my-bucket.storage.googleapis.com/public/ai-images/avatar.jpg' +
      '?X-Goog-Signature=cafebabe&X-Goog-Expires=86400';
    assert.equal(tryNormalize(url), '/api/media/ai-image/avatar.jpg');
  });
});

// ---------------------------------------------------------------------------
// Edge cases — idempotency & non-matching inputs
// ---------------------------------------------------------------------------
describe('Edge cases', () => {
  it('returns the proxy URL unchanged when already normalised', () => {
    const url = '/api/media/ai-image/already-done.jpg';
    assert.equal(tryNormalize(url), url);
  });

  it('returns null for an empty string', () => {
    assert.equal(tryNormalize(''), null);
  });

  it('returns null for an unrelated external URL', () => {
    assert.equal(
      tryNormalize('https://cdn.example.com/images/photo.jpg'),
      null,
    );
  });

  it('returns null for a googleapis URL outside the ai-images path', () => {
    // Different path — not in public/ai-images, should not be auto-patched
    const url = 'https://storage.googleapis.com/my-bucket/private/other/file.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a googleapis URL with no path segment', () => {
    const url = 'https://storage.googleapis.com/my-bucket/';
    assert.equal(tryNormalize(url), null);
  });

  it('handles a fragment (#) after the filename — strips it', () => {
    // The regex [^?#]+ will stop at '#', so the fragment is excluded
    const url = 'https://storage.googleapis.com/bucket/public/ai-images/img.jpg#section';
    assert.equal(tryNormalize(url), '/api/media/ai-image/img.jpg');
  });
});

// ---------------------------------------------------------------------------
// Unrecognised googleapis.com shapes — must return null so the scanner flags
// them for manual review rather than silently patching to an incorrect path.
// Each case below represents a shape that tryNormalize() cannot safely map.
// ---------------------------------------------------------------------------
describe('Unrecognised googleapis.com shapes → null (CI --strict guard)', () => {
  it('returns null for a path-style URL under a different object prefix', () => {
    // "media/" instead of "public/ai-images/" — not a known pattern
    const url = 'https://storage.googleapis.com/my-bucket/media/uploads/photo.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a path-style URL under a private/ prefix', () => {
    const url = 'https://storage.googleapis.com/my-bucket/private/ai-images/secret.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a path-style URL where "public" would be the bucket — no second /public/ segment', () => {
    // URL: storage.googleapis.com/public/ai-images/img.jpg
    // Pattern 1 regex needs /[bucket]/public/ai-images/<file>.
    // Here "public" is consumed as the bucket, leaving /ai-images/img.jpg
    // which does NOT start with /public/ai-images/ — so no pattern matches.
    const url = 'https://storage.googleapis.com/public/ai-images/img.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a non-storage googleapis.com service URL', () => {
    // e.g. Fonts API — not a storage object at all
    const url = 'https://fonts.googleapis.com/css2?family=Inter';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a googleapis.com URL with an unknown subdomain service', () => {
    // A hypothetical new GCS HTTPS endpoint with a different subdomain pattern
    const url = 'https://content-storage.googleapis.com/my-bucket/public/ai-images/img.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a subdomain-style URL under a different object prefix', () => {
    // Same host pattern as Pattern 3/4 but path is not public/ai-images/
    const url = 'https://my-bucket.storage.googleapis.com/uploads/raw/file.jpg';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for a subdomain-style URL with a versioned prefix', () => {
    // e.g. a future migration to a /v2/ai-images/ prefix would be unrecognised
    const url = 'https://my-bucket.storage.googleapis.com/public/v2/ai-images/img.png';
    assert.equal(tryNormalize(url), null);
  });

  it('returns null for an authenticated googleapis.com download URL', () => {
    // OAuth-style download links use a completely different URL structure
    const url = 'https://www.googleapis.com/download/storage/v1/b/my-bucket/o/file.jpg?alt=media';
    assert.equal(tryNormalize(url), null);
  });
});

// ---------------------------------------------------------------------------
// --strict exit-code behaviour
//
// These tests confirm that evaluateScanResults() — the pure helper that
// drives the script's process.exitCode — returns 1 whenever any googleapis.com
// URL cannot be normalised.  This is the condition that causes the --strict
// scan to fail in CI when a developer introduces a new, unrecognised URL shape.
//
// No database connection is required: the tests operate entirely on in-memory
// ScanResult objects constructed below.
// ---------------------------------------------------------------------------
describe('--strict exit-code behaviour — evaluateScanResults()', () => {
  it('returns exitCode 0 when every result is already normalised', () => {
    const results: ScanResult[] = [
      {
        table: 'visual_assets', urlCol: 'image_url', id: 1,
        rawUrl: 'https://storage.googleapis.com/bucket/public/ai-images/img.jpg',
        normalized: '/api/media/ai-image/img.jpg',
      },
      {
        table: 'visual_compositions', urlCol: 'composed_image_url', id: 2,
        rawUrl: 'https://bucket.storage.googleapis.com/public/ai-images/comp.png',
        normalized: '/api/media/ai-image/comp.png',
      },
    ];
    const { exitCode, unresolved } = evaluateScanResults(results);
    assert.equal(exitCode, 0);
    assert.equal(unresolved.length, 0);
  });

  it('returns exitCode 1 when a single URL has an unrecognised shape', () => {
    // Simulates a developer writing a new image path that uses a googleapis.com
    // URL shape not covered by tryNormalize() — this is the CI --strict guard.
    const results: ScanResult[] = [
      {
        table: 'users', urlCol: 'profile_image_url', id: 99,
        rawUrl: 'https://new-cdn.googleapis.com/v2/images/avatar.jpg',
        normalized: null,   // tryNormalize() returned null → unrecognised shape
      },
    ];
    const { exitCode, unresolved, patchable } = evaluateScanResults(results);
    assert.equal(exitCode, 1, 'unrecognised URL shape must produce exit code 1');
    assert.equal(unresolved.length, 1);
    assert.equal(patchable.length, 0);
  });

  it('returns exitCode 1 when even one URL in a mixed batch is unresolved', () => {
    const results: ScanResult[] = [
      {
        table: 'scenarios', urlCol: 'image_url', id: 10,
        rawUrl: 'https://storage.googleapis.com/bucket/public/ai-images/scene.jpg',
        normalized: '/api/media/ai-image/scene.jpg',
      },
      {
        table: 'scenarios', urlCol: 'image_url', id: 11,
        rawUrl: 'https://storage.googleapis.com/bucket/private/ai-images/secret.jpg',
        normalized: null,   // private/ prefix — not a recognised pattern
      },
    ];
    const { exitCode, unresolved, patchable } = evaluateScanResults(results);
    assert.equal(exitCode, 1, 'one unresolved URL in a mixed batch must still fail');
    assert.equal(unresolved.length, 1);
    assert.equal(patchable.length, 1);
  });

  it('returns exitCode 0 for an empty result set (database is clean)', () => {
    const { exitCode, unresolved, patchable } = evaluateScanResults([]);
    assert.equal(exitCode, 0);
    assert.equal(unresolved.length, 0);
    assert.equal(patchable.length, 0);
  });
});

// ---------------------------------------------------------------------------
// --strict stderr warning message — buildStrictWarning()
//
// These tests confirm that the exact stderr text emitted by the scanner when
// unresolved googleapis.com rows are found contains:
//   • the unresolved-count embedded in the message
//   • the correct mode-specific suffix:
//       --strict mode  → "(--strict: treating unresolved rows as a CI failure)"
//       normal mode    → "(re-run with --strict to enforce this as a CI failure)"
//
// This is the signal that causes `npx tsx scan-gcs-urls.ts --strict` to appear
// as an explicit CI failure in build logs rather than a silent warning.
// ---------------------------------------------------------------------------
describe('--strict stderr warning message — buildStrictWarning()', () => {
  it('includes the unresolved count and --strict suffix when strict=true', () => {
    // Simulates: developer added a new googleapis.com URL shape; CI runs with
    // --strict; scanner cannot normalise it; scanner emits this warning to stderr.
    const msg = buildStrictWarning(1, true);
    assert.ok(
      msg.includes('1 unresolved googleapis.com URL(s) found'),
      'message must contain the unresolved count',
    );
    assert.ok(
      msg.includes('--strict: treating unresolved rows as a CI failure'),
      'message must include the --strict CI-failure suffix',
    );
    assert.ok(
      msg.includes('[scan-gcs-urls]'),
      'message must carry the scanner prefix for easy log grepping',
    );
  });

  it('includes the correct non-strict suffix when strict=false', () => {
    const msg = buildStrictWarning(3, false);
    assert.ok(
      msg.includes('3 unresolved googleapis.com URL(s) found'),
      'message must contain the unresolved count',
    );
    assert.ok(
      msg.includes('re-run with --strict to enforce this as a CI failure'),
      'non-strict message must suggest using --strict',
    );
    assert.ok(
      !msg.includes('--strict: treating unresolved rows as a CI failure'),
      'non-strict message must NOT contain the CI-failure suffix',
    );
  });

  it('pluralises correctly for multiple unresolved rows', () => {
    const msg = buildStrictWarning(5, true);
    assert.ok(
      msg.includes('5 unresolved googleapis.com URL(s) found'),
      'count must reflect the actual number of unresolved rows',
    );
  });

  it('round-trips: evaluateScanResults exitCode 1 + buildStrictWarning strict suffix together', () => {
    // Full --strict guard path in one assertion:
    //   1. A new, unrecognised googleapis.com URL shape enters the database.
    //   2. tryNormalize() returns null  →  evaluateScanResults gives exitCode 1.
    //   3. buildStrictWarning(…, true) produces a message that a CI runner can grep.
    const results: ScanResult[] = [
      {
        table: 'users',
        urlCol: 'profile_image_url',
        id: 42,
        rawUrl: 'https://new-cdn.googleapis.com/v3/images/avatar.jpg',
        normalized: null,
      },
    ];
    const { exitCode, unresolved } = evaluateScanResults(results);
    assert.equal(exitCode, 1, 'unrecognised URL must produce exit code 1');

    const warning = buildStrictWarning(unresolved.length, /* strict= */ true);
    assert.ok(
      warning.includes('--strict: treating unresolved rows as a CI failure'),
      '--strict warning must be present so CI logs surface the failure',
    );
  });
});

// ---------------------------------------------------------------------------
// image_vision_cache — backfill CI guard
//
// These tests confirm that image_vision_cache.image_url is included in the
// COLUMNS manifest so the --strict scan cannot be silently bypassed.
//
// getCachedDescription now uses a single equality lookup against the proxy
// path.  Any un-backfilled GCS-keyed row will be silently missed.  These
// tests ensure the scanner catches that case in CI before the code ships.
// ---------------------------------------------------------------------------
describe('image_vision_cache — backfill CI guard', () => {
  it('COLUMNS manifest includes image_vision_cache.image_url', () => {
    // If this assertion fails it means image_vision_cache was removed from the
    // COLUMNS list — the --strict scan will no longer catch lingering GCS rows
    // and getCachedDescription will silently miss un-backfilled entries.
    const entry = COLUMNS.find(
      c => c.table === 'image_vision_cache' && c.urlCol === 'image_url',
    );
    assert.ok(
      entry !== undefined,
      'image_vision_cache.image_url must be in the COLUMNS manifest so the ' +
      '--strict scan catches un-backfilled GCS rows in CI',
    );
  });

  it('a GCS URL in image_vision_cache.image_url is patchable via tryNormalize', () => {
    // Confirms that the common path-style GCS URL stored by the image-vision
    // service can be normalised — meaning the backfill script (and the scanner)
    // can actually fix these rows rather than flagging them as unresolved.
    const gcsUrl =
      'https://storage.googleapis.com/holahola-prod/public/ai-images/scene-abc123.jpg';
    const normalised = tryNormalize(gcsUrl);
    assert.equal(
      normalised,
      '/api/media/ai-image/scene-abc123.jpg',
      'path-style GCS URL from image_vision_cache must normalise to the proxy path',
    );
  });

  it('evaluateScanResults returns exitCode 1 for an un-backfilled image_vision_cache row', () => {
    // Simulates what happens when scan-gcs-urls --strict encounters a GCS-keyed
    // image_vision_cache row whose shape is NOT in the known patterns — the scan
    // must exit non-zero so CI blocks the merge.
    const results: ScanResult[] = [
      {
        table: 'image_vision_cache',
        urlCol: 'image_url',
        id: 'ivc-001',
        rawUrl: 'https://storage.googleapis.com/holahola-prod/private/vision/img.jpg',
        normalized: null, // private/ prefix — tryNormalize returns null
      },
    ];
    const { exitCode, unresolved } = evaluateScanResults(results);
    assert.equal(
      exitCode,
      1,
      'un-backfilled image_vision_cache row with unknown URL shape must fail CI',
    );
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].table, 'image_vision_cache');
  });

  it('evaluateScanResults returns exitCode 0 when image_vision_cache rows are already normalised', () => {
    // Simulates the clean state after the backfill has run: all rows use the
    // proxy path.  The scan should pass silently.
    const results: ScanResult[] = [
      {
        table: 'image_vision_cache',
        urlCol: 'image_url',
        id: 'ivc-002',
        rawUrl: 'https://storage.googleapis.com/holahola-prod/public/ai-images/env.png',
        normalized: '/api/media/ai-image/env.png',
      },
    ];
    const { exitCode, unresolved } = evaluateScanResults(results);
    assert.equal(
      exitCode,
      0,
      'fully-normalised image_vision_cache rows must not fail the CI scan',
    );
    assert.equal(unresolved.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Static source-code scan — no raw storage.googleapis.com literals in .ts/.tsx
// ---------------------------------------------------------------------------
// These files are the ONLY legitimate locations for storage.googleapis.com:
//   • server/services/image-storage.ts  — the write path; normalizeImageUrl lives here
//   • server/scripts/scan-gcs-urls.ts   — the DB scanner (URL patterns as comments/strings)
//   • server/scripts/scan-gcs-urls.test.ts — this file (URL fixtures in test data)
//
// Any other TypeScript file that hardcodes a raw GCS URL is a bug waiting to
// reach the database without normalisation.

/**
 * Repo-relative roots the static source scan walks. Shared by the main scan
 * and by the disposable-tree discovery test, so the test exercises the same
 * root list the real scan uses.
 */
const SCAN_ROOTS = ['server', 'client/src', 'scripts', 'migrations', 'shared'] as const;

/** The absolute directories the static scan walks for a given workspace root. */
function scanDirsFor(workspaceRoot: string): string[] {
  return SCAN_ROOTS.map((root) => path.resolve(workspaceRoot, root));
}

/** Recursively collect all .ts and .tsx files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(tsx?)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('Static source-code scan — no raw storage.googleapis.com literals outside exempt files', () => {
  // Resolve the workspace root relative to this test file's location.
  const thisFile = fileURLToPath(import.meta.url);
  // __dirname equivalent: <workspace>/server/scripts/
  const scriptsDir = path.dirname(thisFile);
  const workspaceRoot = path.resolve(scriptsDir, '..', '..');

  // Individual files that are allowed to contain storage.googleapis.com.
  //   • image-storage.ts       — normalizeImageUrl() is the one legitimate write path
  //   • scan-gcs-urls.ts       — the DB scanner that matches on GCS URL patterns
  //   • scan-gcs-urls.test.ts  — this file (URL fixtures in evaluateScanResults tests)
  //   • backfill-lesson-image-urls.ts — uses GCS patterns in SQL LIKE queries to find
  //                                     rows to fix; does not write raw URLs itself
  const EXEMPT_FILES = new Set([
    path.resolve(workspaceRoot, 'server/services/image-storage.ts'),
    path.resolve(workspaceRoot, 'server/scripts/scan-gcs-urls.ts'),
    path.resolve(workspaceRoot, 'server/scripts/scan-gcs-urls.test.ts'),
    path.resolve(workspaceRoot, 'server/scripts/backfill-lesson-image-urls.ts'),
  ]);

  // Directory subtrees that are categorically exempt:
  //   • server/replit_integrations/ — Replit-managed storage SDK; uses GCS URLs
  //                                   only to validate input, never to write them
  //   • server/__tests__/ and any *.test.ts — URL fixtures in test suites are
  //                                            intentional; they are the inputs to
  //                                            normalisation tests, not write paths
  function isExemptPath(absPath: string): boolean {
    if (EXEMPT_FILES.has(absPath)) return true;
    // Replit-managed integration code
    if (absPath.includes(`${path.sep}replit_integrations${path.sep}`)) return true;
    // Any test file (*.test.ts / *.test.tsx)
    if (/\.test\.tsx?$/.test(absPath)) return true;
    // __tests__ directories
    if (absPath.includes(`${path.sep}__tests__${path.sep}`)) return true;
    return false;
  }

  // Order matters: the tests below index SCAN_DIRS by position.
  //   scripts/ and migrations/ — a raw GCS URL in a migration or seed script
  //     would be written to the database without normalisation.
  //   shared/ — URL builders and helpers imported by server and client; a raw
  //     GCS URL here would bypass the proxy at every call site.
  const SCAN_DIRS = scanDirsFor(workspaceRoot);

  const TARGET = 'storage.googleapis.com';

  it('finds no raw GCS URL literals in server/ outside the exempt list', () => {
    const violations: string[] = [];

    const serverDir = SCAN_DIRS[0];
    if (!fs.existsSync(serverDir)) return; // nothing to scan

    for (const file of collectTsFiles(serverDir)) {
      if (isExemptPath(file)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        // Skip pure comment lines (// … and JSDoc/block * …)
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes(TARGET)) {
          const rel = path.relative(workspaceRoot, file);
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Raw storage.googleapis.com URL literal(s) found in non-exempt server/ files.\n` +
        `These must be normalised via normalizeImageUrl() in image-storage.ts before storage.\n\n` +
        violations.join('\n'),
    );
  });

  it('finds no raw GCS URL literals in client/src/ outside the exempt list', () => {
    const violations: string[] = [];

    const clientSrcDir = SCAN_DIRS[1];
    if (!fs.existsSync(clientSrcDir)) return; // nothing to scan

    for (const file of collectTsFiles(clientSrcDir)) {
      if (isExemptPath(file)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes(TARGET)) {
          const rel = path.relative(workspaceRoot, file);
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Raw storage.googleapis.com URL literal(s) found in non-exempt client/src/ files.\n` +
        `These must be normalised via normalizeImageUrl() in image-storage.ts before storage.\n\n` +
        violations.join('\n'),
    );
  });

  it('all exempt files exist on disk', () => {
    // If a file in EXEMPT_FILES is deleted or renamed its exemption becomes a
    // silent no-op: the scan skips a name that no longer exists while a
    // replacement file with the same GCS URL pattern goes undetected.
    const missing: string[] = [];
    for (const absPath of EXEMPT_FILES) {
      if (!fs.existsSync(absPath)) {
        missing.push(path.relative(workspaceRoot, absPath));
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Exempt file(s) no longer exist — update the list or remove the exemption:\n` +
        missing.map(p => `  • ${p}`).join('\n'),
    );
  });

  it('finds no raw GCS URL literals in scripts/ (repo-root admin/migration scripts)', () => {
    const violations: string[] = [];

    const scriptsRootDir = SCAN_DIRS[2];
    if (!fs.existsSync(scriptsRootDir)) return; // directory is optional

    for (const file of collectTsFiles(scriptsRootDir)) {
      if (isExemptPath(file)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes(TARGET)) {
          const rel = path.relative(workspaceRoot, file);
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Raw storage.googleapis.com URL literal(s) found in non-exempt scripts/ files.\n` +
        `These must be normalised via normalizeImageUrl() in image-storage.ts before storage.\n\n` +
        violations.join('\n'),
    );
  });

  it('finds no raw GCS URL literals in migrations/ (repo-root SQL/TS migration files)', () => {
    const violations: string[] = [];

    const migrationsRootDir = SCAN_DIRS[3];
    if (!fs.existsSync(migrationsRootDir)) return; // directory is optional

    for (const file of collectTsFiles(migrationsRootDir)) {
      if (isExemptPath(file)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes(TARGET)) {
          const rel = path.relative(workspaceRoot, file);
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Raw storage.googleapis.com URL literal(s) found in non-exempt migrations/ files.\n` +
        `These must be normalised via normalizeImageUrl() in image-storage.ts before storage.\n\n` +
        violations.join('\n'),
    );
  });

  it('finds no raw GCS URL literals in shared/ (shared utility helpers)', () => {
    const violations: string[] = [];

    const sharedDir = SCAN_DIRS[4];
    if (!fs.existsSync(sharedDir)) return; // nothing to scan

    for (const file of collectTsFiles(sharedDir)) {
      if (isExemptPath(file)) continue;

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (trimmed.includes(TARGET)) {
          const rel = path.relative(workspaceRoot, file);
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Raw storage.googleapis.com URL literal(s) found in non-exempt shared/ files.\n` +
        `These must be normalised via normalizeImageUrl() in image-storage.ts before storage.\n\n` +
        violations.join('\n'),
    );
  });


  it('fails (simulated) when a new write path hardcodes a raw GCS URL', () => {
    // Inject a synthetic violation to prove the detection logic actually fires.
    // We run the same loop logic but over a fake in-memory "file" so we do not
    // need to touch the real filesystem.
    const fakeFile = path.resolve(workspaceRoot, 'server/services/fake-new-writer.ts');
    const fakeLines = [
      `// This is a new image-write helper`,
      `const url = 'https://storage.googleapis.com/my-bucket/public/ai-images/new.jpg';`,
      `export async function writeImage() { return url; }`,
    ];

    const violations: string[] = [];
    for (let i = 0; i < fakeLines.length; i++) {
      const trimmed = fakeLines[i].trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (trimmed.includes(TARGET)) {
        const rel = path.relative(workspaceRoot, fakeFile);
        violations.push(`${rel}:${i + 1}: ${fakeLines[i].trim()}`);
      }
    }

    assert.equal(
      violations.length,
      1,
      'Simulated new write path with a hardcoded GCS URL must produce exactly one violation',
    );
    assert.ok(
      violations[0].includes('storage.googleapis.com'),
      'Violation message must name the offending URL',
    );
  });
});

// ---------------------------------------------------------------------------
// Meta-test: source-code scanner self-validation (per-line logic only)
//
// Proves the scanner's per-line rule and exemption rule: a raw
// storage.googleapis.com literal on a non-comment line of a non-test .ts path
// is flagged, comment lines and test files are not. These cases pass an
// in-memory source and a synthetic path to scanLines(); they do NOT prove that
// the directory walk discovers files under each root. That is covered by the
// disposable-tree discovery test at the end of this file.
//
// No database connection is required.
// ---------------------------------------------------------------------------

// These self-validation cases run the scanner's per-line logic against an
// in-memory source at a path under each scanned root. They deliberately do NOT
// write a temporary file into the real source tree: doing so raced with the
// other directory-walking scanner tests that run concurrently in the same CI
// batch (ENOENT when a temp file vanished between listing and reading).
describe('Static source-code scan — scanner self-validation (in-memory source at a scanned path)', () => {
  const thisFile2 = fileURLToPath(import.meta.url);
  const scriptsDir2 = path.dirname(thisFile2);
  const workspaceRoot2 = path.resolve(scriptsDir2, '..', '..');
  // Synthetic path (never written). Must NOT end in .test.ts so it is not auto-exempted.
  const TEMP_FILE = path.resolve(
    workspaceRoot2, 'server/scripts/__gcs-source-selftest-tmp__.ts',
  );
  const TARGET2 = 'storage.googleapis.com';

  /** Mirror of isExemptPath used by the main scan above. */
  function isExemptSelfTest(absPath: string): boolean {
    if (/\.test\.tsx?$/.test(absPath)) return true;
    if (absPath.includes(`${path.sep}replit_integrations${path.sep}`)) return true;
    if (absPath.includes(`${path.sep}__tests__${path.sep}`)) return true;
    return false;
  }

  /** Run the same per-line scan logic used above against a set of lines. */
  function scanLines(absPath: string, lines: string[]): string[] {
    const violations: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (trimmed.includes(TARGET2)) {
        const rel = path.relative(workspaceRoot2, absPath);
        violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    return violations;
  }

  it('detects a violation when a non-test .ts file contains a raw storage.googleapis.com URL', () => {
    // This is the core CI-gap test: a developer who hardcodes a GCS URL in a
    // new service file would be caught before the row ever reaches the DB scanner.
    const source = [
      `// In-memory fixture for scan-gcs-urls.test.ts`,
      `export const imageUrl = 'https://storage.googleapis.com/my-bucket/public/ai-images/new.jpg';`,
      `export async function writeImage() { return imageUrl; }`,
    ].join('\n');

    {
      assert.ok(
        !isExemptSelfTest(TEMP_FILE),
        'The synthetic path must not be exempt, so the per-line rule applies',
      );
      const lines = source.split('\n');
      const violations = scanLines(TEMP_FILE, lines);
      assert.equal(
        violations.length,
        1,
        `Scanner must detect exactly 1 violation but found ${violations.length}.\n` +
        `Violations: ${JSON.stringify(violations)}`,
      );
      assert.ok(
        violations[0].includes('storage.googleapis.com'),
        'Violation message must name the offending GCS URL',
      );
    }
  });

  it('does NOT flag the same file when the GCS URL appears only on a comment line', () => {
    // Comment lines are always skipped — they are documentation, not write paths.
    const source = [
      `// In-memory fixture for scan-gcs-urls.test.ts`,
      `// Reference: https://storage.googleapis.com/my-bucket/public/ai-images/new.jpg`,
      `export const imageUrl = '/api/media/ai-image/new.jpg';`,
      `export async function writeImage() { return imageUrl; }`,
    ].join('\n');

    {
      const lines = source.split('\n');
      const violations = scanLines(TEMP_FILE, lines);
      assert.equal(
        violations.length,
        0,
        `Scanner must not flag comment lines but found ${violations.length} violation(s).\n` +
        `Violations: ${JSON.stringify(violations)}`,
      );
    }
  });

  it('a .test.ts file with a GCS URL fixture is exempt (test files are safe)', () => {
    // Confirms the exemption rule that lets this very test file contain GCS URLs
    // as test fixtures without triggering a violation.
    const testFilePath = TEMP_FILE.replace(/\.ts$/, '.test.ts');
    assert.ok(
      isExemptSelfTest(testFilePath),
      '.test.ts paths must always be exempt so test fixtures are allowed',
    );
  });

  it('detects a violation when a non-test .ts file in scripts/ (repo root) contains a raw GCS URL', () => {
    // Per-line logic for a path under scripts/: such a path is not exempt and a
    // raw GCS literal on it is flagged. Whether the walk reaches scripts/ at all
    // is covered by the disposable-tree discovery test below.
    const scriptsRoot = path.resolve(workspaceRoot2, 'scripts');

    const TEMP_SCRIPTS_FILE = path.resolve(scriptsRoot, '__gcs-source-selftest-scripts-tmp__.ts');
    const source = [
      `// In-memory fixture for scan-gcs-urls.test.ts`,
      `export const seedUrl = 'https://storage.googleapis.com/my-bucket/public/ai-images/seed.jpg';`,
      `export async function seedImages() { return seedUrl; }`,
    ].join('\n');

    {
      assert.ok(
        !isExemptSelfTest(TEMP_SCRIPTS_FILE),
        'A synthetic path under scripts/ must not be exempt',
      );
      const lines = source.split('\n');
      const violations = scanLines(TEMP_SCRIPTS_FILE, lines);
      assert.equal(
        violations.length,
        1,
        `Scanner must detect exactly 1 violation in scripts/ but found ${violations.length}.\n` +
        `Violations: ${JSON.stringify(violations)}`,
      );
      assert.ok(
        violations[0].includes('storage.googleapis.com'),
        'Violation message must name the offending GCS URL',
      );
    }
  });

  it('detects a violation when a non-test .ts file in shared/ (repo root) contains a raw GCS URL', () => {
    // Per-line logic for a path under shared/ (see the scripts/ case above).
    // Directory discovery is covered by the disposable-tree test below.
    const sharedRoot = path.resolve(workspaceRoot2, 'shared');

    const TEMP_SHARED_FILE = path.resolve(sharedRoot, '__gcs-source-selftest-shared-tmp__.ts');
    const source = [
      `// In-memory fixture for scan-gcs-urls.test.ts`,
      `export const helperUrl = 'https://storage.googleapis.com/my-bucket/public/ai-images/helper.jpg';`,
      `export function buildImageUrl() { return helperUrl; }`,
    ].join('\n');

    {
      assert.ok(
        !isExemptSelfTest(TEMP_SHARED_FILE),
        'A synthetic path under shared/ must not be exempt',
      );
      const lines = source.split('\n');
      const violations = scanLines(TEMP_SHARED_FILE, lines);
      assert.equal(
        violations.length,
        1,
        `Scanner must detect exactly 1 violation in shared/ but found ${violations.length}.\n` +
        `Violations: ${JSON.stringify(violations)}`,
      );
      assert.ok(
        violations[0].includes('storage.googleapis.com'),
        'Violation message must name the offending GCS URL',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Root discovery against a disposable tree (outside the source tree)
//
// REQUIRED_ROOTS is an independent oracle, deliberately not derived from
// SCAN_ROOTS: the fixture tree is built from it, and the production
// scanDirsFor() -- the same function the main scan uses -- must resolve
// exactly those directories. So a typo in, removal from, or broken mapping of
// the real root list fails here. The tree lives under os.tmpdir(), so it
// cannot race the real-tree scans above.
// ---------------------------------------------------------------------------
describe('Static source-code scan — root discovery (disposable tree)', () => {
  const REQUIRED_ROOTS = ['server', 'client/src', 'scripts', 'migrations', 'shared'];

  it('scanDirsFor resolves exactly the required roots, and the walk discovers nested files under each', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-scan-roots-'));
    try {
      const expected: string[] = [];
      for (const root of REQUIRED_ROOTS) {
        const nested = path.join(tmp, root, 'deep', 'er');
        fs.mkdirSync(nested, { recursive: true });
        const tsFile = path.join(nested, 'writer.ts');
        fs.writeFileSync(tsFile, "export const u = 'https://storage.googleapis.com/b/public/ai-images/x.jpg';\n");
        const tsxFile = path.join(tmp, root, 'View.tsx');
        fs.writeFileSync(tsxFile, 'export const V = 1;\n');
        fs.writeFileSync(path.join(nested, 'notes.md'), 'storage.googleapis.com\n');
        expected.push(tsFile, tsxFile);
      }

      const dirs = scanDirsFor(tmp);
      assert.deepEqual(dirs, REQUIRED_ROOTS.map((root) => path.join(tmp, root)),
        'the production root list must resolve to exactly the required roots under the workspace');
      for (const dir of dirs) assert.ok(fs.statSync(dir).isDirectory(), `${dir} must exist in the fixture tree`);

      const found = dirs.flatMap((dir) => collectTsFiles(dir));
      assert.deepEqual([...found].sort(), [...expected].sort());
      for (const dir of dirs) {
        const flagged = collectTsFiles(dir)
          .filter((file) => fs.readFileSync(file, 'utf8').includes('storage.googleapis.com'));
        assert.equal(flagged.length, 1, `expected one discovered GCS literal under ${dir}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
