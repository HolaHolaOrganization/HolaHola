/**
 * Shared guard for "only run main() when this file is the actual CLI entry
 * point" — the pattern every server/scripts/*.ts CLI script needs to avoid
 * running its side effects (DB writes, process.exit(), a live query dump)
 * just because something *imported* it for its exported functions.
 *
 * Do not reimplement this ad hoc. Two failure modes motivated pulling it out:
 *
 * 1. Substring collisions with a script's own test file. This repo's test
 *    files are named `test-<subject>.test.ts`, so a test that imports a
 *    script for its exported functions naturally has a filename that is a
 *    superstring of the script's own base name (e.g.
 *    `test-coordination-runtime-status.test.ts` contains
 *    `coordination-runtime-status`). A guard written as
 *    `process.argv[1]?.includes('<script-base-name>')` fires on that import,
 *    running the script's CLI body — including a `.finally(closeDbConnections)`
 *    in several scripts — as a side effect, which tears down the shared DB
 *    pool mid-test-run and breaks every later query in that process with an
 *    unrelated-looking Drizzle "Failed query" error.
 *
 * 2. The esbuild production bundle. Any script reachable from server/index.ts
 *    is merged into one dist/index.js at build time, and esbuild rewrites
 *    every bundled module's `import.meta.url` to the bundle's own file URL —
 *    the same value `process.argv[1]` holds when the server boots via
 *    `node dist/index.js`. A guard built on `import.meta.url` (equality,
 *    `endsWith`, or a resolved-path comparison against it) is therefore true
 *    for every bundled module, firing the script's CLI body at server boot.
 *    See .agents/memory/esbuild-ismain-guard.md.
 *
 * This helper avoids both: it never touches `import.meta.url`, and it
 * compares the *exact* basename of `process.argv[1]` rather than doing a
 * substring match. Inside the bundle, `basename(process.argv[1])` is
 * `index.js` (never this script's filename). When a test imports the module,
 * it's the test file's own name (never an exact match either, even though it
 * contains the script's name as a substring). Only a direct
 * `npx tsx server/scripts/<name>.ts` invocation makes it match.
 */
import { win32 } from 'node:path';

/**
 * @param scriptBasename The exact filename of the calling script, e.g.
 *   `'populate-principle-embeddings.ts'`. Must match the real file name —
 *   this is intentionally a plain string, not derived from `import.meta.url`.
 */
export function isDirectCliInvocation(scriptBasename: string): boolean {
  // win32.basename splits on both `/` and `\`, so a Windows argv[1] matches
  // the same way on every platform, and Linux CI can test it. (A `/`-only
  // suffix check made shared-spec-cli.ts exit 0 silently on Windows.)
  return process.argv[1] !== undefined && win32.basename(process.argv[1]) === scriptBasename;
}
