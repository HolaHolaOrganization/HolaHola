/**
 * CI guard: server/scripts/*.ts must never write to a real path inside a
 * tracked source directory (client/src/, server/, shared/) unless the write
 * is provably sandboxed (routed through mkdtempSync/os.tmpdir()/a
 * create*Sandbox() helper) or covered by an explicit ALLOWLIST entry below.
 *
 * Rationale (Task #1522): several existing self-check scripts prove a
 * regression guard catches a real break by flipping a line in a real, shared
 * source file, running the test, and flipping it back. That corrupts the
 * file mid-mutation for ANY other process reading it concurrently -- another
 * test run, the dev server, an editor's type-checker -- even though the
 * script restores the original bytes afterward. See
 * server/scripts/filter-url-mutation-fixture.ts for the reference-safe
 * alternative: copy the minimal files a test needs into a private
 * mkdtempSync() directory and mutate only the copy. Nothing else can ever
 * observe that mutation.
 *
 * This scanner does not fix the pre-existing offenders (that is a separate,
 * larger change tracked as a follow-up). It exists so a NEW instance of the
 * pattern is caught automatically instead of relying on manual review.
 *
 * ── How it works ─────────────────────────────────────────────────────────
 * For every server/scripts/*.ts file, the TypeScript compiler API parses a
 * real AST (not a regex/text scan) and finds every call site of a "writes a
 * whole file" function -- both the Sync and callback/promise forms
 * (writeFileSync/writeFile, appendFileSync/appendFile, outputFileSync/
 * outputFile, copyFileSync/copyFile, renameSync/rename). For the rename/
 * copyFile family the DESTINATION is argument index 1, not 0 -- argument 0
 * is only ever read, never written.
 *
 * The destination argument is then resolved to an absolute path using a
 * small, deliberately single-file expression evaluator that understands:
 *   - string literals, __dirname / import.meta.dirname, process.cwd()
 *   - fileURLToPath(import.meta.url) / __filename
 *   - path.resolve(...) / path.join(...) (and the bare resolve/join forms),
 *     where EVERY argument must resolve concretely (or to a proven sandbox)
 *   - a local `const`/`let`/`var NAME = <expr>` declaration, resolved
 *     LEXICAL-SCOPE-AWARE (walking up the reference's real enclosing
 *     scopes, innermost first) rather than a whole-file "first declaration
 *     with this name anywhere" guess -- a shadowing inner declaration is
 *     never masked by an unrelated, same-named outer one -- one level of
 *     indirection at a time (cycle-guarded)
 *   - member access on a sandbox-derived identifier (e.g. sandbox.logicFile)
 *   - mkdtempSync(...)/mkdtemp(...)/tmpdir() calls, and calls to a helper
 *     listed in TRUSTED_SANDBOX_FACTORIES -- each is trusted only when it
 *     resolves, through this file's own import declarations, to the real
 *     node:fs/node:os module (or the exact allowlisted helper module); a
 *     same-file function merely NAMED like one of these (e.g. a local
 *     `function createFakeSandbox()`) is never trusted just because of
 *     its name
 *   - a write-function callee (writeFileSync, etc.) is resolved through a
 *     named-import alias first, so `import { writeFileSync as put } from
 *     'node:fs'; put(...)` is still detected as a writeFileSync call
 *
 * ── Fail-closed default (Task #1522 review requirement) ──────────────────
 * A resolved path is a VIOLATION if it falls inside client/src/, server/, or
 * shared/ and is not covered by a `kind: 'target'` ALLOWLIST entry.
 *
 * Anything the evaluator CANNOT resolve to a concrete path or a proven
 * sandbox -- a bare function parameter, a cross-file import, a template
 * literal, a conditional expression, string concatenation, an object
 * returned from another function, an env-var override, an OS-specific
 * branch, etc. -- is ALSO a violation unless covered by a `kind:
 * 'unresolved'` ALLOWLIST entry. Unresolvable is never silently treated as
 * safe: this scanner does not know whether an unresolvable target is inside
 * a tracked directory, and a script author must not be able to bypass the
 * guard just by making the destination expression hard to analyze
 * statically (a template literal, a ternary, string concatenation, a
 * cross-file helper, `new URL(...)`, ... -- see the negative self-checks
 * below, which prove each of these forms is still caught).
 *
 * Every `kind: 'unresolved'` entry below was individually verified BY
 * READING THE SOURCE, not guessed -- each one traces to a real sandbox
 * (mkdtempSync/tmpdir/create*Sandbox) or a real non-tracked path (a
 * `.local/`-relative workspace file, an operator-supplied CLI/env override,
 * a Windows-only path, etc.) that this deliberately simple, single-file
 * evaluator cannot prove on its own (usually because doing so needs
 * cross-file resolution, tracing a value through another function's return
 * statement, or combining conditional branches).
 *
 * ── Adding a new script that writes into a tracked directory ────────────
 *   - Prefer routing the write through a temp/sandbox path (mkdtempSync,
 *     os.tmpdir(), or a create*Sandbox() helper). No allowlist entry needed,
 *     and no other process can ever observe the write.
 *   - If a write must legitimately target a tracked path, or the target
 *     expression is simply too dynamic for this evaluator to resolve, add an
 *     explicit ALLOWLIST entry below with a reason. This is a conscious
 *     opt-in, not a silent pass -- and the "stale ALLOWLIST entry" test below
 *     will fail if the entry stops matching a real call site (e.g. because
 *     the write was removed or the expression text changed).
 *
 * Run with:
 *   npx tsx --test server/scripts/scan-source-mutation-writes.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPTS_ROOT = path.resolve(PROJECT_ROOT, 'server/scripts');

/** Directories whose real, tracked contents must never be overwritten in place. */
const TRACKED_ROOTS: Array<{ label: string; abs: string }> = [
  { label: 'client/src', abs: path.resolve(PROJECT_ROOT, 'client/src') },
  { label: 'server', abs: path.resolve(PROJECT_ROOT, 'server') },
  { label: 'shared', abs: path.resolve(PROJECT_ROOT, 'shared') },
];

/**
 * fs call names treated as "puts bytes at a real filesystem path" for this
 * guard, mapped to the index of the argument that names the DESTINATION.
 * writeFileSync-family functions write to arg0; rename/copyFile-family
 * functions write to arg1 (arg0 is only ever read, never written).
 */
const WRITE_FUNCTIONS = new Map<string, number>([
  ['writeFileSync', 0], ['appendFileSync', 0], ['outputFileSync', 0],
  ['writeFile', 0], ['appendFile', 0], ['outputFile', 0],
  ['renameSync', 1], ['rename', 1],
  ['copyFileSync', 1], ['copyFile', 1],
]);

type AllowlistEntry =
  | {
      /** Resolved to a concrete path inside a tracked directory. */
      kind: 'target';
      /** Basename of the file under server/scripts/. */
      file: string;
      /** Target path relative to PROJECT_ROOT, using forward slashes. */
      target: string;
      reason: string;
    }
  | {
      /**
       * The evaluator cannot resolve this call's destination argument to a
       * concrete path (see the file header for why that still needs an
       * explicit, reasoned entry rather than a silent pass).
       */
      kind: 'unresolved';
      file: string;
      /** The WRITE_FUNCTIONS name at the call site (e.g. 'writeFileSync'). */
      fn: string;
      /**
       * Exact source text of the destination argument expression (as
       * written at the call site, whitespace-normalized to single spaces).
       * This is intentionally exact, not a path -- it ties the entry to the
       * specific expression that was verified safe, so a later edit that
       * changes the expression makes the entry go stale (caught by the
       * "stale entry" test below) instead of silently continuing to match.
       */
      argExprText: string;
      reason: string;
    };

/**
 * Every currently-known write from server/scripts into a tracked directory,
 * or whose destination this evaluator cannot resolve, that is not routed
 * through a sandbox helper. Grouped by category -- see the comment above
 * each group. Do not add a new entry here to silence a script you just
 * wrote; use the sandbox pattern instead unless you have a concrete,
 * verified reason the write is already safe.
 */
const ALLOWLIST: AllowlistEntry[] = [
  // ── Pre-existing in-place mutation of a real, shared source file. This is
  //    exactly the antipattern this guard exists to catch going forward; the
  //    entries below are grandfathered tech debt, not an endorsed pattern.
  //    Fixing them (converting to the sandbox pattern) is tracked as a
  //    separate follow-up. ──
  { kind: 'target', file: 'test-alden-workspace-root-portability.ts', target: 'server/services/alden-functions.ts', reason: 'pre-existing in-place mutation (tech debt follow-up)' },
  { kind: 'target', file: 'test-alden-dual-engine-self-report.ts', target: 'server/services/alden-functions.ts', reason: 'in-place mutation restored in a finally block, same target file and pattern as test-alden-workspace-root-portability.ts above (tech debt follow-up); full sandboxing is impractical here because get_current_engine is reached only through the real, DB-connected executeAldenTool with a large transitive import tree (neon-db, db, coordination-auth, voice-health-monitor, founder-collaboration-service, and more)' },
  { kind: 'target', file: 'test-context-lineage-migration-guard-selfcheck.ts', target: 'server/scripts/test-context-lineage-migration-guard-selfcheck.ts', reason: 'pre-existing in-place self-mutation (tech debt follow-up)' },
  { kind: 'target', file: 'test-coordination-credential-broker-selfcheck.ts', target: 'server/services/coordination-credential-broker.ts', reason: 'pre-existing in-place mutation (tech debt follow-up)' },
  { kind: 'target', file: 'test-coordination-runtime-envelope-violation-selfcheck.ts', target: 'server/services/coordination-runtime.ts', reason: 'pre-existing in-place mutation (tech debt follow-up)' },
  { kind: 'target', file: 'test-coordination-runtime-verifier-standing-selfcheck.ts', target: 'server/services/coordination-runtime.ts', reason: 'pre-existing in-place mutation (tech debt follow-up); same target file as test-coordination-runtime-envelope-violation-selfcheck.ts' },
  { kind: 'target', file: 'test-source-reconciliation-hermetic-env.ts', target: 'server/services/source-reconciliation-service.ts', reason: 'pre-existing in-place mutation (tech debt follow-up)' },
  { kind: 'target', file: 'test-retry-toast-dismiss.ts', target: 'client/src/hooks/useStreamingVoice.ts', reason: 'pre-existing in-place mutation (tech debt follow-up)' },

  // ── Pre-existing "sibling mutant file" pattern: writes a NEW file with a
  //    .MUTANT. name next to the real one and deletes it in a finally block;
  //    the real file is never opened for writing. Lower risk than in-place
  //    mutation (no other process would import a .MUTANT. file by accident),
  //    but it still targets a tracked directory, so it stays a grandfathered
  //    entry rather than an implicitly-safe pattern. ──
  { kind: 'target', file: 'test-badge-render-ci-check.ts', target: 'client/src/pages/admin/CommandCenter.MUTANT.tsx', reason: 'sibling-mutant-file pattern, cleaned up in finally (tech debt follow-up)' },
  { kind: 'target', file: 'test-badge-render-ci-check.ts', target: 'client/src/components/absence-return-badge-render.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up in finally (tech debt follow-up)' },
  { kind: 'target', file: 'test-translation-retry-ci-check.ts', target: 'client/src/components/ChapterIntroduction.MUTANT.tsx', reason: 'sibling-mutant-file pattern, cleaned up in finally (tech debt follow-up)' },
  { kind: 'target', file: 'test-translation-retry-ci-check.ts', target: 'client/src/components/translation-retry.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up in finally (tech debt follow-up)' },
  { kind: 'target', file: 'test-absence-custom-threshold-guard.ts', target: 'server/__tests__/absence-custom-threshold.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-absence-monitor-error-state-guard.ts', target: 'server/__tests__/absence-monitor-error-state.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-missing-bucket-guard-ci-check.ts', target: 'server/scripts/upload-madrigal-scans.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-observe-friction-fields.ts', target: 'server/routes.MUTANT_OBSERVE_FRICTION.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-observe-friction-fields.ts', target: 'server/scripts/_tmp_friction_mutant_check.mjs', reason: 'sibling scratch script (not the .MUTANT. naming convention but same shape), cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-pattern-signal-ci-check.ts', target: 'server/services/daniela-caller.MUTANT.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-pattern-signal-ci-check.ts', target: 'server/__tests__/pattern-signals-study-mode-chat.MUTANT.test.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },
  { kind: 'target', file: 'test-prod-founder-bypass-guard.ts', target: 'server/middleware/rbac.FOUNDER_GUARD_MUTANT.ts', reason: 'sibling-mutant-file pattern, cleaned up via unlinkSync (tech debt follow-up)' },

  // ── Established "scanner self-validation" convention (precedent:
  //    scan-unwrapped-image-uploads.test.ts): writes a brand-new, never-
  //    before-existing __..._tmp__ filename to prove the scanner's own
  //    detection logic actually fires, then deletes it immediately. Because
  //    the filename never pre-exists and nothing else references it, no
  //    other process can mistake it for real content. This is a reviewed,
  //    repeated convention, not an accident -- kept as an explicit allowlist
  //    entry (rather than an automatic exemption) so it stays visible. ──
  { kind: 'target', file: 'scan-unwrapped-image-uploads.test.ts', target: 'server/scripts/__gcs-guard-selftest-tmp__.ts', reason: 'scanner self-validation scratch file, deleted in finally (established convention)' },

  // ── Unresolved: traces to a `.local/`-relative or otherwise non-tracked
  //    WORKSPACE constant, verified by reading the constant's own
  //    declaration, but the constant lives behind a cross-file import or a
  //    same-file member/call this single-file evaluator does not chase. ──
  { kind: 'unresolved', file: 'claude-code-mirror-sync.ts', fn: 'writeFileSync', argExprText: 'join(dir, `${sessionId}.status.json`)', reason: 'dir = resolve(".local/claude-code-mirror") (gitignored, process-cwd-relative; the launcher sets cwd to the project root) and sessionId is validated against /^[A-Za-z0-9-]{8,64}$/ before use, so the status file can never land in a tracked directory; verified by reading main()' },
  { kind: 'unresolved', file: 'capture-watchdog.ts', fn: 'writeFileSync', argExprText: 'chatCaptureCursorPath()', reason: 'chatCaptureCursorPath() returns a WORKSPACE + .local/-relative path (server/services/agent-session-autosave.ts); verified by reading its declaration' },
  { kind: 'unresolved', file: 'capture-watchdog.ts', fn: 'writeFileSync', argExprText: 'filePath', reason: 'filePath traces to join(DOCS_DIR, ...) where DOCS_DIR is imported WORKSPACE-derived state from server/services/transcript-parser.ts; verified by reading the cross-file declaration' },
  { kind: 'unresolved', file: 'capture-watchdog.ts', fn: 'writeFileSync', argExprText: 'INNER_LIFE_STATE_PATH', reason: 'traces to join(LOCAL_DIR, ...), a WORKSPACE + .local/-relative constant; verified by reading its declaration' },
  { kind: 'unresolved', file: 'capture-watchdog.ts', fn: 'appendFileSync', argExprText: 'DB_WARNING_PATH', reason: 'traces to join(LOCAL_DIR, ...), a WORKSPACE + .local/-relative constant; verified by reading its declaration' },
  { kind: 'unresolved', file: 'capture-watchdog.ts', fn: 'writeFileSync', argExprText: 'STALE_ALERT_PATH', reason: 'traces to join(LOCAL_DIR, ...), a WORKSPACE + .local/-relative constant; verified by reading its declaration' },
  { kind: 'unresolved', file: 'test-stale-channel-boot-seed.ts', fn: 'writeFileSync', argExprText: 'ALERT_PATH', reason: 'ALERT_PATH = getStaleChannelAlertPath(), which returns WORKSPACE + \'.local/stale-channel-alert.md\' (server/services/agent-session-autosave.ts); verified by reading its declaration' },

  // ── Unresolved: operator/CLI/env-supplied root, not a hardcoded
  //    self-check mutation target. The write only lands somewhere real once
  //    an operator explicitly points it there; verified by reading the
  //    surrounding option-parsing code. ──
  { kind: 'unresolved', file: 'prepare-antigravity-provisioning.ts', fn: 'writeFile', argExprText: 'artifactPath', reason: 'artifactPath = resolve(root, \'.local/tasks/task-1448.md\'); root is an operator-supplied worktree path (options.root || process.cwd()), and the .local/tasks suffix keeps the artifact out of tracked directories for the intended (project-root) usage; verified by reading the file' },
  { kind: 'unresolved', file: 'test-filter-url-mutation.ts', fn: 'writeFileSync', argExprText: 'LOGIC_FILE', reason: 'LOGIC_FILE is either an operator-supplied FILTER_URL_MUTATION_LOGIC_FILE env override or sandbox.logicFile from createFilterUrlMutationSandbox() -- the reference-safe sandbox helper this guard\'s own header recommends; verified by reading the declaration' },
  { kind: 'unresolved', file: 'retrieve-episode-dialogue.ts', fn: 'writeFileSync', argExprText: 'out', reason: 'out is destructured from parseArgs(process.argv)\'s return value, populated only from an operator-supplied --out CLI flag; verified by reading parseArgs() (surfaced by the scope-aware resolver, which correctly no longer falls through to an unrelated same-named `let out = \'\'` local inside parseArgs() itself)' },
  { kind: 'unresolved', file: 'shared-spec-cli.ts', fn: 'writeFile', argExprText: 'options["write-file"]', reason: 'options["write-file"] is an operator-supplied CLI flag (--write-file) populated by parse(argv); the callee here is dependencies.writeFile, an injectable SharedSpecCliDependencies hook the scanner matches by property name only -- real (non-test) invocations fall through to the writeFileSync branch below instead; verified by reading parse()/runPull()' },
  { kind: 'unresolved', file: 'shared-spec-cli.ts', fn: 'writeFileSync', argExprText: 'options["write-file"]', reason: 'same options["write-file"] operator-supplied --write-file CLI flag as the dependencies.writeFile entry above; this is the real fallback path used when no dependencies.writeFile is injected; verified by reading parse()/runPull()' },
  { kind: 'unresolved', file: 'coordination-listener-lifecycle-probe.ts', fn: 'writeFile', argExprText: 'temporary', reason: 'temporary = `${actionFile}.${randomUUID()}.tmp`, a sibling of actionFile = localPath(--action-file); localPath() resolves the operator-supplied flag and throws unless it is inside .local/, so the temp file is too (written wx, then linked and unlinked); verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-listener-lifecycle-probe.ts', fn: 'writeFile', argExprText: 'output', reason: 'output = localPath(--output), an operator-supplied CLI flag that localPath() resolves and rejects unless it is inside .local/ (and it must also end in .json and differ from the action file); written wx, so it never overwrites; verified by reading the file' },

  // ── Unresolved: a local `const`/function-parameter identifier that this
  //    single-file evaluator cannot trace back to its origin (a fixture
  //    object property, a loop variable, a member access on a plain local
  //    object) because doing so needs call-graph or cross-statement tracing
  //    beyond one level of const aliasing. Each was verified by reading the
  //    file: the value always traces to a mkdtempSync()/tmpdir()-derived
  //    fixture root. ──
  { kind: 'unresolved', file: 'gemini-gate-check.test.ts', fn: 'writeFileSync', argExprText: 'abs', reason: 'abs traces to join(dir, ...) where dir comes from makeTempDir()\'s mkdtempSync(); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'gemini-gate-check.test.ts', fn: 'writeFileSync', argExprText: "path.join(repoDir, '.git', 'ORIG_HEAD')", reason: 'repoDir traces to makeTempDir()\'s mkdtempSync(); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'prepare-antigravity-provisioning.test.ts', fn: 'writeFile', argExprText: "join(root, '.local/tasks/task-1448.md')", reason: 'root is assigned from a mkdtemp(tmpdir())-derived parent directory in beforeEach(); verified by reading the fixture setup' },
  { kind: 'unresolved', file: 'prepare-antigravity-provisioning.test.ts', fn: 'writeFile', argExprText: 'templatePath', reason: 'templatePath is join(root, ...) with the same mkdtemp(tmpdir())-derived root as the sibling entries in this file; verified by reading the fixture setup' },
  { kind: 'unresolved', file: 'prepare-antigravity-provisioning.test.ts', fn: 'writeFile', argExprText: "join(root, 'dirty')", reason: 'root is assigned from a mkdtemp(tmpdir())-derived parent directory in beforeEach(); verified by reading the fixture setup' },
  { kind: 'unresolved', file: 'test-capture-workspace-portability.ts', fn: 'writeFileSync', argExprText: "join(root, 'package.json')", reason: 'root traces to makeProjectRoot(parent, ...) where parent is mkdtempSync-derived; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-capture-workspace-portability.ts', fn: 'writeFileSync', argExprText: "join(root, 'drizzle.config.ts')", reason: 'root traces to makeProjectRoot(parent, ...) where parent is mkdtempSync-derived; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-capture-workspace-portability.ts', fn: 'writeFileSync', argExprText: "join(root, 'shared', 'schema.ts')", reason: 'root traces to makeProjectRoot(parent, ...) where parent is mkdtempSync-derived; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-playwright-browser-path.ts', fn: 'writeFileSync', argExprText: 'file', reason: 'file is a for-of loop variable over [configured, managed, system], all join(tempDir, ...) where tempDir = mkdtempSync(...); verified by reading the file' },
  { kind: 'unresolved', file: 'test-source-control-service.ts', fn: 'writeFileSync', argExprText: 'env.SOURCE_CONTROL_LOCK_FILE!', reason: 'env.SOURCE_CONTROL_LOCK_FILE is join(rootDir, \'control.lock\') where rootDir = mkdtempSync(...); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-source-control-service.ts', fn: 'writeFileSync', argExprText: 'env.SOURCE_BRIDGE_STATUS_FILE!', reason: 'env.SOURCE_BRIDGE_STATUS_FILE is join(rootDir, \'status.json\') where rootDir = mkdtempSync(...); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-source-promotion-api.ts', fn: 'writeFileSync', argExprText: 'path', reason: 'writeBridgeStatus(path, value) is always called with bridgeStatusPath = join(dir, \'bridge-status.json\') where dir = mkdtempSync(...); verified by reading the call sites' },
  { kind: 'unresolved', file: 'test-source-reconciliation-service.ts', fn: 'writeFileSync', argExprText: "join(f.root, 'config/source-reconciliation-policies.json')", reason: 'f.root traces to fixture()\'s `const root = mkdtempSync(...)`; verified by reading the fixture\'s return statement' },
  { kind: 'unresolved', file: 'test-source-reconciliation-service.ts', fn: 'writeFileSync', argExprText: 'copied', reason: 'copied = join(f.root, \'copied-preflight.json\'); f.root traces to fixture()\'s `const root = mkdtempSync(...)`; verified by reading the fixture\'s return statement' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: "join(root, '.git')", reason: 'root = await mkdtemp(join(tmpdir(), \'task-ownership-\')) inside fixture(); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: 'f.taskPath', reason: 'f.taskPath traces to fixture()\'s mkdtemp(tmpdir())-derived root; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: "join(f.root, 'package.json')", reason: 'f.root traces to fixture()\'s mkdtemp(tmpdir())-derived root; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'copyFile', argExprText: 'fixtureSelfCheckPath', reason: 'fixtureSelfCheckPath = join(f.root, \'server\', \'scripts\', ...) where f.root traces to fixture()\'s mkdtemp(tmpdir())-derived root; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: "join(f.root, 'server', 'ci-database.ts')", reason: 'f.root traces to fixture()\'s mkdtemp(tmpdir())-derived root; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: 'fixtureProbePath', reason: 'fixtureProbePath = join(f.root, \'server\', \'scripts\', ...) where f.root traces to fixture()\'s mkdtemp(tmpdir())-derived root; verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-cross-tool-promote-auto-freshen.ts', fn: 'writeFileSync', argExprText: 'join(seedDir, filename)', reason: 'seedDir is advanceMain()\'s parameter; both call sites (testCleanMerge, testRealConflict) pass makeFixture()\'s seedDir = join(root, \'seed\') where root = mkdtempSync(join(tmpdir(), ...)); verified by reading the fixture helper' },
  { kind: 'unresolved', file: 'test-cross-tool-promote-auto-freshen.ts', fn: 'writeFileSync', argExprText: 'join(dir, filename)', reason: 'dir is commitOnBranch()\'s parameter; every call site passes cloneCandidate()\'s return value join(root, name) where root traces to makeFixture()\'s mkdtempSync-derived root; verified by reading the fixture helpers' },
  { kind: 'unresolved', file: 'test-cross-tool-promote-auto-freshen.ts', fn: 'writeFileSync', argExprText: "join(candidateDir, 'uncommitted.txt')", reason: 'candidateDir = cloneCandidate(root, originDir, \'candidate-dirty\'); same mkdtempSync-derived join(root, name) pattern as the commitOnBranch entry above; verified by reading the fixture helper' },

  // ── Unresolved: a bare function parameter (the caller decides the real
  //    path; every call site was checked). Each was verified by reading
  //    every call site of the enclosing function. ──
  { kind: 'unresolved', file: 'record-exchange.ts', fn: 'renameSync', argExprText: 'intentPath', reason: 'intentPath is captureCanonicalInnerLifeIntent()\'s own path parameter; every call site passes a .local/-relative path (see test-episode-append-trigger.ts / capture-watchdog.ts usage); write-then-rename-over pattern, not the in-place-mutation antipattern' },
  { kind: 'unresolved', file: 'record-exchange.ts', fn: 'renameSync', argExprText: 'handoff.path', reason: 'handoff.path is the same intentPath captured above, round-tripped through the { intent, path } return value; write-then-rename-over pattern' },
  { kind: 'unresolved', file: 'record-window.ts', fn: 'renameSync', argExprText: 'sourcePath', reason: 'sourcePath is a .local/-relative raw-source archive path (write-then-rename-over pattern, not the in-place-mutation antipattern); verified by reading the file' },
  { kind: 'unresolved', file: 'record-window.ts', fn: 'renameSync', argExprText: 'path', reason: 'path = join(sourceDir, ...) inside writeSourceMetadata(); sourceDir is a .local/-relative archive directory (write-then-rename-over pattern); verified by reading the file' },
  { kind: 'unresolved', file: 'test-capture-status-seed.ts', fn: 'writeFileSync', argExprText: 'path', reason: 'restoreFile(path, snap, label) is only ever called with paths this script itself owns (its own .local/-relative trigger/status files), restoring the pre-test snapshot; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-inner-life-db-first.ts', fn: 'writeFileSync', argExprText: 'path', reason: 'restoreFile(path, snap, label) is only ever called with this script\'s own .local/-relative trigger/status files, restoring the pre-test snapshot; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-prior-session-label-clears.ts', fn: 'writeFileSync', argExprText: 'filePath', reason: 'restoreFile(filePath, snap) is only ever called with this script\'s own .local/-relative status files, restoring the pre-test snapshot; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-stale-channel-boot-seed.ts', fn: 'writeFileSync', argExprText: 'path', reason: 'seedTriggerFile(path, ageMs) is only ever called with this script\'s own .local/-relative trigger files; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-chat-capture-episode-outbox.ts', fn: 'writeFileSync', argExprText: 'obsoletePath', reason: 'obsoletePath is a mkdtempSync-derived fixture path from this file\'s own outbox-directory setup; verified by reading the file' },
  { kind: 'unresolved', file: 'test-episode-append-trigger.ts', fn: 'writeFileSync', argExprText: 'mdPath', reason: 'mdPath is this CI check\'s own scratch episode markdown file under a mkdtempSync/.local-relative test directory; verified by reading the file' },
  { kind: 'unresolved', file: 'test-watchdog-inner-life-driver.ts', fn: 'writeFileSync', argExprText: 'crashedHandoff.path', reason: 'crashedHandoff.path traces to a mkdtempSync-derived intentDir used only by this fixture; verified by reading the file' },
  { kind: 'unresolved', file: 'test-build-session-dedup.ts', fn: 'writeFileSync', argExprText: 'tmpCommit', reason: 'tmpCommit is a parameter of writeCommitMessage()/touchCommitMessage(); its one call site passes tmpCommit = join(os.tmpdir(), `test-build-dedup-commit-${ts}.txt`) from main(); verified by reading every call site (surfaced by the scope-aware resolver, which correctly stops treating a parameter as resolvable via an unrelated same-named outer declaration)' },
  { kind: 'unresolved', file: 'test-build-session-dedup.ts', fn: 'writeFileSync', argExprText: 'tmpCapture', reason: 'tmpCapture is a parameter of runSelfCheck()/runNormalCheck(); its one call site passes tmpCapture = join(os.tmpdir(), `test-build-dedup-capture-${ts}.txt`) from main(); verified by reading every call site' },
  { kind: 'unresolved', file: 'test-chat-capture-integration.ts', fn: 'writeFileSync', argExprText: 'lockPath', reason: 'lockPath is a parameter of acquireLock(); every call site passes the outer lockPath = join(dir, \'.chat_capture.lock\') where dir = join(tmpdir(), `chat-capture-test-${...}`); verified by reading every call site' },
  { kind: 'unresolved', file: 'test-source-bridge.ts', fn: 'writeFileSync', argExprText: 'path', reason: 'path is a local const (join(dir, \'git\'|\'npm\'|\'git-state\')) inside writeFakeGit()/writeFakeNpm()/writeState(), all sharing the one dir parameter; its one call site passes dir = mkdtempSync(join(tmpdir(), \'holahola-source-bridge-test-\')) from runBridge(); verified by reading every call site' },
  { kind: 'unresolved', file: 'test-read-my-story-self-check.ts', fn: 'writeFileSync', argExprText: 'handlerPath', reason: 'handlerPath is a parameter of writeHandler(); every call site passes handlerPath = sandbox.files[CANONICAL_HANDLER_PATH] where sandbox = createShadowTreeSandbox(...) -- the reference-safe sandbox helper this guard\'s own header recommends; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-coordination-actor-clients.test.ts', fn: 'writeFile', argExprText: 'cachePath', reason: 'cachePath is withTokenCacheDir()\'s own callback parameter; every call site passes join(cacheDir, \'token.json\') where cacheDir = mkdtemp(join(tmpdir(), \'coordination-token-cache-\')), removed in a finally block; verified by reading every call site' },
  { kind: 'unresolved', file: 'test-shared-spec-live-instruction-document-postgres.test.ts', fn: 'writeFile', argExprText: 'join(repoDir, gitPath)', reason: 'repoDir is this file\'s own makeRepo() helper\'s return value -- mkdtemp(join(tmpdir(), \'shared-spec-live-instruction-doc-\')) -- used by the task-1612 drift-regression tests to simulate an ordinary out-of-band git commit landing on the fixture repo\'s working tree; verified by reading makeRepo() and every call site' },
  { kind: 'unresolved', file: 'test-source-reconciliation-service.ts', fn: 'writeFileSync', argExprText: 'join(cwd, path)', reason: 'cwd is regenerateWith()\'s returned callback\'s own parameter; its one call site is SourceReconciliationService.candidate()\'s regenerateAgentMemory(cwd) invocation, which always passes the isolated merge worktree path under join(this.root, \'.local\', ...) where root traces to this fixture\'s mkdtempSync()-derived root; verified by reading the call site' },

  // ── Unresolved: a member/property access this evaluator does not chase
  //    (`this.options.X`, a JSON.stringify(...) data argument on a
  //    FileHandle .writeFile(data) call whose real path was already fixed
  //    by the paired open()/rename() call). ──
  { kind: 'unresolved', file: 'coordination-runtime-antigravity.ts', fn: 'writeFile', argExprText: 'this.options.receiptFile', reason: 'operator-supplied receipt file path (constructor option), not a hardcoded self-check mutation target; verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-runtime-antigravity.ts', fn: 'writeFile', argExprText: 'path', reason: 'path is a function parameter of a dependency-injected storage capability; the real destination is supplied by the caller (coordination-windows-generation), not hardcoded here; verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-v2-http-factory.ts', fn: 'rename', argExprText: 'path', reason: 'path = pathFor(key) = join(directory, ...) where directory = join(root, \'.coordination-v2-execution-journal\'); root is the operator/CLI-supplied coordination root, not a hardcoded self-check mutation target; verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-v2-http-factory.ts', fn: 'writeFile', argExprText: "JSON.stringify({ state: 'started', claimDigest: digest(JSON.stringify(claim)) })", reason: 'this is a FileHandle.writeFile(data) call (handle from open(path, \'wx\')); the argument is the DATA being written, not a path -- the real destination was already fixed by the preceding open() call; verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-v2-http-factory.ts', fn: 'writeFile', argExprText: 'path', reason: 'path is a function parameter of a dependency-injected storage.write capability supplied by the coordination-windows-generation caller, not hardcoded here; verified by reading the file' },
  { kind: 'unresolved', file: 'coordination-v2-http-factory.ts', fn: 'rename', argExprText: 'to', reason: '`to` is a function parameter of a dependency-injected storage.rename capability supplied by the coordination-windows-generation caller, not hardcoded here; verified by reading the file' },

  // ── Unresolved: a dynamic (template-literal) filename segment this
  //    evaluator deliberately does not combine into a concrete string (see
  //    "Adding conditional/template resolution" in the file header) --
  //    proves the fail-closed default still catches a sibling-mutant write
  //    even when part of the filename is computed at runtime. ──
  { kind: 'unresolved', file: 'test-coordination-v2-deferred-session.test.ts', fn: 'writeFile', argExprText: 'path', reason: "path = join('server', 'services', `.coordination-v2-mutation-${process.pid}.ts`); sibling-mutant-file pattern with a PID-suffixed filename under server/services/, cleaned up in a finally block (tech debt follow-up, same category as the .MUTANT. entries above)" },

  // ── Unresolved: resolves to docs/ or .agents/memory/ -- these ARE tracked
  //    by git, but neither is one of the three directories this guard
  //    polices (client/src/, server/, shared/); Task #1522's scope is
  //    specifically those three roots, not "everything under version
  //    control". Verified by reading each declaration chain. ──
  { kind: 'unresolved', file: 'append-to-episode.ts', fn: 'writeFileSync', argExprText: 'filePath', reason: "filePath = join(DOCS_DIR, filename) where DOCS_DIR = join(WORKSPACE, 'docs'); resolves under the workspace docs/ directory, not client/src, server, or shared; verified by reading the declaration chain" },
  { kind: 'unresolved', file: 'mark-moment.ts', fn: 'writeFileSync', argExprText: 'MOMENTS_FILE', reason: "MOMENTS_FILE = join(WORKSPACE, '.agents/memory/SIGNIFICANT_MOMENTS.md'); resolves under .agents/memory, not client/src, server, or shared; verified by reading the declaration" },
  { kind: 'unresolved', file: 'mark-reflection.ts', fn: 'writeFileSync', argExprText: 'REFLECTIONS_FILE', reason: "REFLECTIONS_FILE = join(WORKSPACE, '.agents/memory/REFLECTIONS.md'); resolves under .agents/memory, not client/src, server, or shared; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-chat-capture-attribution.ts', fn: 'writeFileSync', argExprText: 'scratchPath', reason: "scratchPath = path.join(WORKSPACE, 'docs', scratchFilename); resolves under the workspace docs/ directory, not client/src, server, or shared; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-chat-capture-attribution.ts', fn: 'writeFileSync', argExprText: 'scratchPath2', reason: "scratchPath2 = path.join(WORKSPACE, 'docs', scratchFilename2); same as scratchPath above; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-inner-life-db-first.ts', fn: 'writeFileSync', argExprText: 'FIXTURE_MD_PATH', reason: "FIXTURE_MD_PATH = join(DOCS_DIR, FIXTURE_FILE) where DOCS_DIR = join(WORKSPACE, 'docs'); resolves under the workspace docs/ directory; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-luca-auto-capture-episode.ts', fn: 'writeFileSync', argExprText: 'fixtureMdPath', reason: "fixtureMdPath = join(DOCS_DIR, fixtureFile) where DOCS_DIR is the workspace docs/ directory; verified by reading the declaration" },

  // ── Unresolved: .local/-relative WORKSPACE-derived constants, reached
  //    through a cross-file import or a workspaceResolution.root member
  //    access this single-file evaluator does not chase. Root chain
  //    (verified by reading it): server/services/workspace-root.ts exports
  //    `workspaceResolution = resolveWorkspaceRoot()`; several files import
  //    `workspaceResolution` directly and declare `const WORKSPACE =
  //    workspaceResolution.root`, others import an already-derived WORKSPACE
  //    constant from server/services/transcript-parser.ts. Every constant
  //    below was verified to build a .local/-relative path from WORKSPACE. ──
  { kind: 'unresolved', file: 'append-to-episode.ts', fn: 'writeFileSync', argExprText: 'triggerPath', reason: "triggerPath = join(WORKSPACE, '.local', '.episode_append'); verified by reading the declaration" },
  { kind: 'unresolved', file: 'episode-live-mode.ts', fn: 'writeFileSync', argExprText: 'LIVE_PATH', reason: "LIVE_PATH = join(WORKSPACE, '.local/.episode_live'); verified by reading the declaration" },
  { kind: 'unresolved', file: 'save-transcript-now.ts', fn: 'writeFileSync', argExprText: 'FLUSH_PATH', reason: "FLUSH_PATH = join(WORKSPACE, '.local/.flush_transcript'); WORKSPACE is imported directly from server/services/transcript-parser.ts as a bare identifier (not a member-access expression), which is why the resolver reports it differently from the workspaceResolution.root sites; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-commit-message-auto-capture.ts', fn: 'writeFileSync', argExprText: 'COMMIT_MSG_PATH', reason: "COMMIT_MSG_PATH = join(WORKSPACE, '.local/.commit_message'); WORKSPACE imported from server/services/transcript-parser.ts; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-four-channel-capture-contract.ts', fn: 'writeFileSync', argExprText: 'mainPath', reason: "mainPath = join(WORKSPACE, '.local', `${marker}.txt`); WORKSPACE imported from server/services/transcript-parser.ts; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-chat-capture-attribution.ts', fn: 'writeFileSync', argExprText: 'EPISODE_LIVE_PATH', reason: "EPISODE_LIVE_PATH = path.join(WORKSPACE, '.local/.episode_live'); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-task-capture-david-luca-order.ts', fn: 'writeFileSync', argExprText: 'DUMMY_TASK_PATH', reason: "DUMMY_TASK_PATH = join(TASKS_DIR, `task-${DUMMY_REF}.md`) where TASKS_DIR = join(WORKSPACE, '.local/tasks'); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-task-capture-david-luca-order.ts', fn: 'writeFileSync', argExprText: 'TASK_REF_PENDING_PATH', reason: "TASK_REF_PENDING_PATH = join(WORKSPACE, '.local/.task_ref_pending') (server/services/agent-session-autosave.ts); verified by reading the cross-file declaration" },
  { kind: 'unresolved', file: 'capture-exchange.ts', fn: 'writeFileSync', argExprText: 'tmpPath', reason: "tmpPath = LUCA_AUTO_CAPTURE_PATH + '.tmp'; LUCA_AUTO_CAPTURE_PATH = join(WORKSPACE, '.local/.luca_auto_capture') (server/services/transcript-parser.ts); write-then-rename-over pattern; verified by reading the declaration" },
  { kind: 'unresolved', file: 'capture-exchange.ts', fn: 'renameSync', argExprText: 'LUCA_AUTO_CAPTURE_PATH', reason: "LUCA_AUTO_CAPTURE_PATH = join(WORKSPACE, '.local/.luca_auto_capture') (server/services/transcript-parser.ts); verified by reading the declaration" },

  // ── Unresolved: PID-suffixed .local/ trigger/fixture paths -- same
  //    category as the "own .local/-relative trigger files" group above,
  //    each verified individually by reading the declaration. ──
  { kind: 'unresolved', file: 'test-chat-episode-hook-e2e.ts', fn: 'writeFileSync', argExprText: 'FIXTURE_TRIGGER_PATH', reason: "FIXTURE_TRIGGER_PATH = join(WORKSPACE, '.local', `.episode_append-chat-hook-e2e-${process.pid}`), WORKSPACE = process.cwd(); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-episode-append-trigger.ts', fn: 'writeFileSync', argExprText: 'FIXTURE_TRIGGER_PATH', reason: "FIXTURE_TRIGGER_PATH = join(WORKSPACE, '.local', `.episode_append-trigger-e2e-${process.pid}`), WORKSPACE = process.cwd(); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-episode-append-corrupted-json.ts', fn: 'writeFileSync', argExprText: 'FIXTURE_TRIGGER_PATH', reason: "FIXTURE_TRIGGER_PATH = join(WORKSPACE, '.local', `.episode_append-corrupted-json-${process.pid}`), WORKSPACE = process.cwd(); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-rolling-episode-no-rolling-tag.ts', fn: 'writeFileSync', argExprText: 'FIXTURE_TRIGGER_PATH', reason: "FIXTURE_TRIGGER_PATH = join(WORKSPACE, '.local', `.episode_append-no-rolling-tag-${process.pid}`), WORKSPACE = process.cwd(); verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-team-room-e2e.ts', fn: 'writeFileSync', argExprText: 'SIMULATED_LIVE_TRIGGER_PATH', reason: "SIMULATED_LIVE_TRIGGER_PATH = join(WORKSPACE, '.local', `.episode_append-live-regression-${process.pid}`), WORKSPACE = process.cwd(); verified by reading the declaration" },

  // ── Unresolved: openSync file-descriptor writes. writeFileSync(fd, data)
  //    writes through a file descriptor, not a path -- the real destination
  //    was already fixed by the preceding openSync(realPath, 'wx') call, the
  //    same "data argument, not a path" shape as the FileHandle.writeFile
  //    entry above. Verified by reading the openSync call in each file. ──
  { kind: 'unresolved', file: 'test-chat-episode-hook-e2e.ts', fn: 'writeFileSync', argExprText: 'fd', reason: "fd = openSync(EPISODE_CI_LOCK, 'wx') where EPISODE_CI_LOCK = '/tmp/.episode-fixture-ci.lock'; the write targets a file descriptor whose real path was already fixed by that openSync('/tmp/...') call; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-episode-append-trigger.ts', fn: 'writeFileSync', argExprText: 'fd', reason: "fd = openSync(EPISODE_CI_LOCK, 'wx') where EPISODE_CI_LOCK = '/tmp/.episode-fixture-ci.lock'; same fd-through-openSync pattern as test-chat-episode-hook-e2e.ts; verified by reading the declaration" },

  // ── Unresolved: mkdtempSync-derived local variables/nested paths this
  //    single-file evaluator does not chase through a helper function's
  //    return value. Verified by reading each fixture helper. ──
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: 'reflectionPath', reason: "reflectionPath = path.join(baseline.tempRoot, '.luca_reflection'); baseline.tempRoot traces to runDriver()'s fs.mkdtempSync(path.join(os.tmpdir(), 'wd-il-')); verified by reading the file" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: 'statePath', reason: "statePath = path.join(baseline.tempRoot, 'wd-state.json'); same mkdtempSync-derived baseline.tempRoot as above; verified by reading the file" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: 'seedLockPath', reason: "seedLockPath = path.join(baseline.tempRoot, 'seed-test.lock'); same mkdtempSync-derived baseline.tempRoot as above; verified by reading the file" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: "path.join(negativeFixtureRoot, 'package.json')", reason: "negativeFixtureRoot = path.join(WORKSPACE, '.local', 'wd-negative-sandbox-test'); the nested server/shared subfolders created under it are inside that .local/ sandbox, not the real repo server/ or shared/; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: "path.join(negativeFixtureRoot, 'drizzle.config.ts')", reason: "same negativeFixtureRoot as above -- a .local/ sandbox, not a tracked directory; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life.ts', fn: 'writeFileSync', argExprText: "path.join(negativeFixtureRoot, 'shared/schema.ts')", reason: "same negativeFixtureRoot as above; despite the literal \"shared/schema.ts\" suffix this is nested inside the .local/ sandbox, not the repo's real shared/ directory; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life-driver.ts', fn: 'writeFileSync', argExprText: 'path.join(intentDir, `${retainedPendingId}.json`)', reason: "intentDir = path.join(cwd, '.local', CANONICAL_INNER_LIFE_INTENT_DIR); cwd is this driver's own hermetic temp workspace; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-watchdog-inner-life-driver.ts', fn: 'writeFileSync', argExprText: 'path.join(intentDir, `${expiredCapturedId}.json`)', reason: "same intentDir as above; verified by reading the declaration" },
  { kind: 'unresolved', file: 'test-task-ownership-service.ts', fn: 'writeFile', argExprText: 'fixtureSelfCheckPath', reason: "this call site's fixtureSelfCheckPath comes from the 'linked' fixture() invocation -- the same mkdtemp(tmpdir())-based fixture() helper as the rest of the file, a distinct call site from the one already covered under the copyFile entry above; verified by reading the file" },

  // ── Unresolved: write-then-rename-over siblings for constants already
  //    covered above -- each temp/tempPath/temporary write happens
  //    immediately before an already-allowlisted rename onto the real
  //    (already-verified-safe) target, in the same directory. ──
  { kind: 'unresolved', file: 'record-exchange.ts', fn: 'writeFileSync', argExprText: 'tempPath', reason: "tempPath = `${intentPath}.tmp-${process.pid}`; intentPath defaults to join(WORKSPACE, '.local', CANONICAL_INNER_LIFE_INTENT_DIR, ...); write-then-rename-over sibling to the already-allowlisted renameSync(tempPath, intentPath) call above; verified by reading the file" },
  { kind: 'unresolved', file: 'record-window.ts', fn: 'writeFileSync', argExprText: 'tempPath', reason: "tempPath = `${sourcePath}.tmp-${process.pid}`; sourcePath defaults to join(WORKSPACE, '.local', 'raw-window-captures', ...); write-then-rename-over sibling to the already-allowlisted renameSync(tempPath, sourcePath) call above; verified by reading the file" },
  { kind: 'unresolved', file: 'coordination-v2-http-factory.ts', fn: 'writeFile', argExprText: 'temporary', reason: "temporary = `${path}.${process.pid}.tmp`; path is the same operator/CLI-supplied coordination-root-derived path already covered by the rename/'path' entries above (join(root, '.coordination-v2-execution-journal', ...)); write-then-rename-over sibling; verified by reading the file" },
  { kind: 'unresolved', file: 'coordination-v2-interactive-cli.ts', fn: 'writeFile', argExprText: 'temporary', reason: "temporary = `${path}.${process.pid}.tmp` inside saveSession(), where path = sessionPath(root, record.taskRef) = join(sessionDirectory(root), `${digest(taskRef)}.json`) and sessionDirectory(root) = join(root, '.coordination-v2-interactive-session'); root is options.root ?? process.cwd() -- an operator-supplied --root CLI flag or the cwd, the same operator/CLI-supplied-root pattern as coordination-v2-http-factory.ts above, and .coordination-v2-interactive-session/ is listed in .gitignore, not a tracked client/src, server, or shared path; write-then-rename-over sibling to the very next line's rename(temporary, path); verified by reading saveSession()/sessionPath()/sessionDirectory()" },
  { kind: 'unresolved', file: 'coordination-v2-interactive-cli.ts', fn: 'rename', argExprText: 'path', reason: "path = sessionPath(root, record.taskRef); same operator/CLI-supplied-or-cwd root as the writeFile(temporary) entry directly above, joined with the fixed '.coordination-v2-interactive-session' subdirectory name (itself gitignored, not a tracked client/src, server, or shared path) and a sha256 digest of taskRef -- the rename target this single-file evaluator cannot trace through the sessionPath() call; verified by reading saveSession()/sessionPath()/sessionDirectory()" },
  { kind: 'unresolved', file: 'update-alden-handoff-section.ts', fn: 'writeFileSync', argExprText: 'temporary', reason: "temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`) where target = join(process.cwd(), SNAPSHOT_PATH) and SNAPSHOT_PATH = 'docs/alden-agent-handoff.md' -- a docs/-relative path, not client/src, server, or shared; write-then-rename-over sibling to the very next line's renameSync(temporary, target), which the scanner already resolves safely on its own (process.cwd() and the SNAPSHOT_PATH string literal are both concrete); only the randomUUID()-suffixed temp filename defeats this single-file evaluator; verified by reading refreshLocalSnapshot()" },

  // ── Unresolved: operator/CLI-root-derived and explicitly containment-
  //    checked before use (isContainedPath), not a hardcoded self-check
  //    mutation target. ──
  { kind: 'unresolved', file: 'coordination-windows-prepare.ts', fn: 'rename', argExprText: 'generation', reason: "generation = `${input.root}/${reservation.generationId}`; input.root is caller-supplied and the destination is explicitly containment-checked via isContainedPath(input.root, generation) before use, with a safe path-part check on generationId; verified by reading the file" },

  // ── Unresolved: explicit /tmp paths this evaluator does not special-case
  //    (it resolves __dirname/process.cwd()-relative paths, not a bare
  //    absolute /tmp string literal combined with a template segment). ──
  { kind: 'unresolved', file: 'observe-jspace-session.ts', fn: 'writeFileSync', argExprText: 'resultsPath', reason: "resultsPath = `/tmp/jspace-observation-${SESSION_ID}.json`; explicit /tmp path; verified by reading the declaration" },

  // ── Unresolved: Daniela consult-transcript scripts. Each declares its own
  //    LOG (or LOG_FILE) constant near the top of the file as a template
  //    literal resolving under /home/runner/workspace/.local/daniela-consults/
  //    -- verified individually per file (declarations are not assumed
  //    identical; daniela-logprobs-probe.ts uses an indirect LOG_DIR base,
  //    daniela-live-relay.ts uses LOG_FILE with an ISO-date filename). ──
  { kind: 'unresolved', file: 'daniela-archive-guardian-impressions.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/archive-guardian-impressions-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-archive-guardian-impressions.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-free-dialogue-with-memory.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/memory-dialogue-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-free-dialogue-with-memory.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-friction-conscience.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/friction-conscience-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-friction-conscience.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-internal-war-consult.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/internal-war-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-internal-war-consult.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-live-relay.ts', fn: 'appendFileSync', argExprText: 'LOG_FILE', reason: "LOG_FILE = `/home/runner/workspace/.local/daniela-consults/live-relay-${new Date().toISOString().slice(0,10)}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-live-relay.ts', fn: 'writeFileSync', argExprText: 'LOG_FILE', reason: "same LOG_FILE declaration as the appendFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-llm-pressure-consult.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/llm-pressure-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-llm-pressure-consult.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-logprobs-probe.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "LOG = `${LOG_DIR}/logprobs-probe-${Date.now()}.txt` where LOG_DIR = '/home/runner/workspace/.local/daniela-consults'; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-logprobs-probe.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "same LOG declaration as the appendFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-luca-first-reflection.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/first-reflection-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-luca-first-reflection.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-luca-inner-life-dialogue.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/inner-life-dialogue-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-luca-inner-life-dialogue.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-luca-team-room-vision.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/team-room-vision-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-luca-team-room-vision.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-safety-net-dialogue.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/safety-net-dialogue-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-safety-net-dialogue.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'daniela-thought-dialogue.ts', fn: 'writeFileSync', argExprText: 'LOG', reason: "LOG = `/home/runner/workspace/.local/daniela-consults/thought-dialogue-${Date.now()}.txt`; verified by reading the declaration" },
  { kind: 'unresolved', file: 'daniela-thought-dialogue.ts', fn: 'appendFileSync', argExprText: 'LOG', reason: "same LOG declaration as the writeFileSync entry above" },
  { kind: 'unresolved', file: 'generate-runtime-notice-relabel-receipt.ts', fn: 'writeFileSync', argExprText: 'out', reason: "out defaults to .local/runtime-notice-relabel/receipt-<ts>.json (gitignored) and main() throws unless resolve(out) lies inside a .local/ directory, so a --out override can never land in tracked source; verified by reading main()" },
  { kind: 'unresolved', file: 'test-record-stop-turn-absorbed.test.ts', fn: 'writeFileSync', argExprText: 'p', reason: "p is the path argument of an injected io.writeFileSync; its only caller is queueExchange(box.dir, ...), which writes inside box.dir = mkdtempSync(join(tmpdir(), 'stop-outbox-')) (outbox() helper, removed in finally); verified by reading the test and the hook" },
  { kind: 'unresolved', file: 'test-record-stop-turn-absorbed.test.ts', fn: 'renameSync', argExprText: 'to', reason: "to is the destination argument of an injected io.renameSync; its only caller is queueExchange(box.dir, ...), which renames within box.dir = mkdtempSync(join(tmpdir(), 'stop-outbox-')); verified by reading the test and the hook" },
  { kind: 'unresolved', file: 'test-record-stop-turn-absorbed.test.ts', fn: 'writeFileSync', argExprText: "join(box.dir, 'cc-s-1.0000000000000000.json')", reason: "box.dir = mkdtempSync(join(tmpdir(), 'stop-outbox-')) from the outbox() helper, removed in finally; verified by reading the helper" },
  { kind: 'unresolved', file: 'test-record-stop-turn-absorbed.test.ts', fn: 'writeFileSync', argExprText: "join(box.dir, 'cc-s-bad.0000000000000000.json')", reason: "box.dir = mkdtempSync(join(tmpdir(), 'stop-outbox-')) from the outbox() helper, removed in finally; verified by reading the helper" },
];

const TARGET_ALLOWLIST = new Set(
  ALLOWLIST.filter((e): e is Extract<AllowlistEntry, { kind: 'target' }> => e.kind === 'target')
    .map((e) => `${e.file}::${e.target}`),
);

function normalizeArgText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const UNRESOLVED_ALLOWLIST = new Set(
  ALLOWLIST.filter((e): e is Extract<AllowlistEntry, { kind: 'unresolved' }> => e.kind === 'unresolved')
    .map((e) => `${e.file}::${e.fn}::${normalizeArgText(e.argExprText)}`),
);

// ─── AST-based path-expression evaluator ────────────────────────────────────

type Resolved = { kind: 'path'; value: string } | { kind: 'sandbox' } | { kind: 'unknown'; reason: string };

function calleeName(expr: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Strips wrappers that don't change what an expression resolves to. */
function unwrap(node: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node)) { node = node.expression; continue; }
    if (ts.isAwaitExpression(node)) { node = node.expression; continue; }
    if (ts.isAsExpression(node)) { node = node.expression; continue; }
    if (ts.isNonNullExpression(node)) { node = node.expression; continue; }
    return node;
  }
}

interface ImportBinding {
  /** The name actually exported by the module, before any `as` alias. */
  originalName: string;
  /** Raw module specifier text as written (e.g. 'node:fs', './filter-url-mutation-fixture'). */
  moduleSpecifier: string;
}

/**
 * Maps each local identifier introduced by a NAMED import
 * (`import { X as local } from 'module'`) to the real exported name and
 * module it came from. Namespace (`import * as fs`) and default imports
 * are read via property access elsewhere in this file, where the property
 * name IS the real name and import aliasing does not apply.
 *
 * This closes the "aliased import bypass" the Task #1522 review flagged:
 * `import { writeFileSync as put } from 'node:fs'; put('server/routes.ts', ...)`
 * previously went undetected because write-call and sandbox-trust
 * detection matched only the raw callee identifier text.
 */
function collectNamedImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
    const moduleSpecifier = stmt.moduleSpecifier.text;
    const namedBindings = stmt.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const el of namedBindings.elements) {
      bindings.set(el.name.text, { originalName: (el.propertyName ?? el.name).text, moduleSpecifier });
    }
  }
  return bindings;
}

interface FileCtx {
  filePath: string;
  fileDir: string;
  sourceFile: ts.SourceFile;
  importBindings: Map<string, ImportBinding>;
}

/** Real Node.js modules that back the raw sandboxing primitives this guard trusts. */
const FS_MODULE_SPECIFIERS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const OS_MODULE_SPECIFIERS = new Set(['os', 'node:os']);

/**
 * Sandbox-factory helpers this guard trusts by exact (exported name, module
 * specifier) pair -- a verified, reviewed helper, not a name-pattern guess.
 * A NEW sandbox helper needs an explicit, reviewable entry here; it is not
 * auto-trusted just because its name starts with "create" and ends with
 * "Sandbox" (Task #1522 review: a same-file helper matching that naming
 * convention could return a real tracked path without sandboxing anything).
 */
const TRUSTED_SANDBOX_FACTORIES: ReadonlyArray<{ importedName: string; moduleIncludes: string }> = [
  { importedName: 'createFilterUrlMutationSandbox', moduleIncludes: 'filter-url-mutation-fixture' },
  { importedName: 'createTextSnapshotSandbox', moduleIncludes: 'source-mutation-sandbox' },
  { importedName: 'createShadowTreeSandbox', moduleIncludes: 'source-mutation-sandbox' },
];

/**
 * True if this call is a verified sandbox primitive/factory: either a
 * property-access call to mkdtempSync/mkdtemp/tmpdir (trusted by property
 * name, matching this guard's existing lower-risk treatment of the
 * write-function property-access form -- redefining an object with a fake
 * .mkdtempSync property is far more contrived than a plain identifier
 * bypass), or a bare identifier that resolves, through this file's own
 * import declarations, to mkdtempSync/mkdtemp from a real fs module,
 * tmpdir from a real os module, or an entry in TRUSTED_SANDBOX_FACTORIES.
 *
 * A bare identifier with no matching import -- e.g. a same-file
 * `function mkdtempSync() { ... }` or `function createFakeSandbox() { ... }`
 * shadow -- is never trusted: the primitive must be traceable to a real,
 * reviewed origin, not just named like one (Task #1522 review).
 */
function isTrustedSandboxCall(ctx: FileCtx, node: ts.CallExpression): boolean {
  const callee = node.expression;

  if (ts.isPropertyAccessExpression(callee)) {
    const propName = callee.name.text;
    return propName === 'mkdtempSync' || propName === 'mkdtemp' || propName === 'tmpdir';
  }

  if (!ts.isIdentifier(callee)) return false;
  const binding = ctx.importBindings.get(callee.text);
  if (!binding) return false; // not a verified import -- never trust a local/shadowing declaration

  if (
    (binding.originalName === 'mkdtempSync' || binding.originalName === 'mkdtemp') &&
    FS_MODULE_SPECIFIERS.has(binding.moduleSpecifier)
  ) {
    return true;
  }
  if (binding.originalName === 'tmpdir' && OS_MODULE_SPECIFIERS.has(binding.moduleSpecifier)) return true;

  return TRUSTED_SANDBOX_FACTORIES.some(
    (f) => f.importedName === binding.originalName && binding.moduleSpecifier.includes(f.moduleIncludes),
  );
}

/**
 * AST node kinds that introduce a new lexical scope for `const`/`let`/`var`
 * declarations, function parameters, and catch bindings.
 */
function isScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

/**
 * Declarations introduced DIRECTLY by this scope-boundary node -- not
 * declarations nested inside a deeper child scope, which get their own
 * turn as the caller walks up the ancestor chain. A name mapped to
 * `undefined` IS declared in this scope (a function parameter or catch
 * binding) but has no static initializer to trace; the caller must treat
 * that as "found, but unresolvable" rather than falling through to an
 * outer same-named declaration.
 */
function collectDirectDeclarations(scopeNode: ts.Node): Map<string, ts.Expression | undefined> {
  const decls = new Map<string, ts.Expression | undefined>();

  if (
    ts.isFunctionDeclaration(scopeNode) || ts.isFunctionExpression(scopeNode) ||
    ts.isArrowFunction(scopeNode) || ts.isMethodDeclaration(scopeNode)
  ) {
    for (const p of scopeNode.parameters) {
      if (ts.isIdentifier(p.name)) decls.set(p.name.text, undefined);
    }
    return decls; // the function body is its own nested Block scope boundary
  }

  if (ts.isCatchClause(scopeNode)) {
    if (scopeNode.variableDeclaration && ts.isIdentifier(scopeNode.variableDeclaration.name)) {
      decls.set(scopeNode.variableDeclaration.name.text, undefined);
    }
    return decls; // the catch body is its own nested Block scope boundary
  }

  if (ts.isForStatement(scopeNode) || ts.isForInStatement(scopeNode) || ts.isForOfStatement(scopeNode)) {
    const init = scopeNode.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) {
        if (ts.isIdentifier(d.name)) decls.set(d.name.text, d.initializer);
      }
    }
    return decls; // the loop body is its own nested Block scope boundary
  }

  let statements: readonly ts.Statement[] = [];
  if (ts.isBlock(scopeNode) || ts.isSourceFile(scopeNode)) {
    statements = scopeNode.statements;
  } else if (ts.isCaseBlock(scopeNode)) {
    statements = scopeNode.clauses.flatMap((c) => c.statements);
  }
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.set(d.name.text, d.initializer);
      }
    }
  }
  return decls;
}

/**
 * Walks UP from a reference node's enclosing scopes (innermost first) to
 * find the nearest `const`/`let`/`var`/parameter/catch-binding declaration
 * of `name` that is actually in scope at that reference -- real lexical
 * shadowing, not a whole-file "first declaration with this name anywhere"
 * guess. The Task #1522 review flagged that the latter can let an inner
 * violating write hide behind an unrelated, same-named, sandbox-derived
 * outer variable. Returns `{ found: false }` if no enclosing scope
 * declares the name (an import binding, a global, or genuinely
 * undeclared) -- callers must fail closed on that, not fall back to a
 * whole-file guess.
 */
function findInScopeDeclaration(
  refNode: ts.Node,
  name: string,
): { found: true; initializer: ts.Expression | undefined } | { found: false } {
  let current: ts.Node | undefined = refNode.parent;
  while (current) {
    if (isScopeBoundary(current)) {
      const decls = collectDirectDeclarations(current);
      if (decls.has(name)) return { found: true, initializer: decls.get(name) };
    }
    current = current.parent;
  }
  return { found: false };
}

/**
 * Finds a top-level (module-scope) `const`/`let`/`var NAME = <expr>`
 * declaration by name. Used only by the `resolveExprText` test harness
 * below to locate the `const __probe__ = <expr>;` statement it appends to
 * a fixture -- always a real top-level declaration by construction, so a
 * restricted top-level-only search is correct there. Production
 * resolution of an in-source identifier REFERENCE must go through
 * `findInScopeDeclaration` instead, which is scope-aware.
 */
function findTopLevelVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) return decl.initializer;
    }
  }
  return undefined;
}

function resolveExpr(ctx: FileCtx, rawNode: ts.Expression, seen: Set<string>): Resolved {
  const node = unwrap(rawNode);

  if (ts.isStringLiteralLike(node)) {
    return { kind: 'path', value: path.resolve(PROJECT_ROOT, node.text) };
  }

  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname') return { kind: 'path', value: ctx.fileDir };
    if (node.text === '__filename') return { kind: 'path', value: ctx.filePath };
    if (seen.has(node.text)) return { kind: 'unknown', reason: `circular reference to ${node.text}` };
    const lookup = findInScopeDeclaration(node, node.text);
    if (!lookup.found) return { kind: 'unknown', reason: `unresolved identifier ${node.text}` };
    if (!lookup.initializer) {
      return { kind: 'unknown', reason: `${node.text} is declared with no static initializer (parameter/catch binding)` };
    }
    seen.add(node.text);
    return resolveExpr(ctx, lookup.initializer, seen);
  }

  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText().replace(/\s+/g, '');
    if (text === 'import.meta.dirname') return { kind: 'path', value: ctx.fileDir };
    if (text === 'import.meta.url') return { kind: 'path', value: ctx.filePath };
    const base = resolveExpr(ctx, node.expression, seen);
    if (base.kind === 'sandbox') return { kind: 'sandbox' };
    return { kind: 'unknown', reason: `member access on ${node.expression.getText()}` };
  }

  // Bracket-notation member access, e.g. `sandbox.files['server/routes.ts']` or
  // `sandbox.files[SOME_CONST]` -- the shape createTextSnapshotSandbox() and
  // createShadowTreeSandbox() return their per-target paths in. Indexing into
  // a sandbox-derived object with ANY key still yields a sandboxed path (the
  // factories only ever populate `.files` with paths inside their own
  // mkdtempSync() root), so this propagates 'sandbox' exactly like the
  // property-access case above rather than trying to evaluate the index.
  if (ts.isElementAccessExpression(node)) {
    const base = resolveExpr(ctx, node.expression, seen);
    if (base.kind === 'sandbox') return { kind: 'sandbox' };
    return { kind: 'unknown', reason: `element access on ${node.expression.getText()}` };
  }

  if (ts.isCallExpression(node)) {
    const exprText = node.expression.getText().replace(/\s+/g, '');
    if (exprText === 'process.cwd') return { kind: 'path', value: PROJECT_ROOT };
    if (isTrustedSandboxCall(ctx, node)) return { kind: 'sandbox' };
    const name = calleeName(node.expression);
    if (name === 'fileURLToPath') {
      if (node.arguments.length !== 1) return { kind: 'unknown', reason: 'fileURLToPath with unexpected arity' };
      return resolveExpr(ctx, node.arguments[0], seen);
    }
    if (name === 'resolve' || name === 'join') {
      return resolveJoinOrResolveCall(ctx, name, node.arguments, seen);
    }
    if (name === 'dirname') {
      if (node.arguments.length !== 1) return { kind: 'unknown', reason: 'dirname with unexpected arity' };
      const r = resolveExpr(ctx, node.arguments[0], seen);
      if (r.kind !== 'path') return r;
      return { kind: 'path', value: path.dirname(r.value) };
    }
    return { kind: 'unknown', reason: `unrecognized call ${node.expression.getText()}` };
  }

  return { kind: 'unknown', reason: `unsupported expression kind (${ts.SyntaxKind[node.kind]})` };
}

/**
 * Resolves a resolve()/join() call. EVERY argument must resolve to a
 * concrete literal segment or a proven sandbox -- unlike an earlier
 * prototype of this guard, there is no "opaque placeholder" tolerance for
 * an unresolvable trailing segment. That tolerance bought better violation
 * messages for a couple of dynamic-filename cases, but it is strictly
 * looser than treating the whole call as unresolved, and this guard would
 * rather hand a script author an "unresolved, please allowlist with a
 * reason" failure than a resolved-but-wrong path.
 */
function resolveJoinOrResolveCall(
  ctx: FileCtx,
  name: 'resolve' | 'join',
  args: readonly ts.Expression[],
  seen: Set<string>,
): Resolved {
  if (args.length === 0) return { kind: 'unknown', reason: `${name}() with no arguments` };
  const parts: string[] = [];
  for (const arg of args) {
    const node = unwrap(arg);
    if (ts.isStringLiteralLike(node)) { parts.push(node.text); continue; }
    if (ts.isIdentifier(node) && node.text === '__dirname') { parts.push(ctx.fileDir); continue; }
    const resolved = resolveExpr(ctx, node, seen);
    if (resolved.kind === 'sandbox') return { kind: 'sandbox' };
    if (resolved.kind === 'unknown') {
      return { kind: 'unknown', reason: `${name}() argument is unresolvable: ${node.getText().slice(0, 80)} (${resolved.reason})` };
    }
    parts.push(resolved.value);
  }
  try {
    const combined = name === 'resolve'
      ? path.resolve(PROJECT_ROOT, ...parts)
      : (path.isAbsolute(parts[0]) ? path.join(...parts) : path.join(PROJECT_ROOT, ...parts));
    return { kind: 'path', value: combined };
  } catch {
    return { kind: 'unknown', reason: `${name}() threw while combining segments` };
  }
}

function isUnderTrackedRoot(p: string): { label: string } | null {
  for (const root of TRACKED_ROOTS) {
    if (p === root.abs || p.startsWith(root.abs + path.sep)) return { label: root.label };
  }
  return null;
}

// ─── Call-site scanner ───────────────────────────────────────────────────────

interface WriteCallSite {
  fn: string;
  line: number; // 1-based
  targetArg: ts.Expression;
}

/**
 * Resolves a call's callee to the real WRITE_FUNCTIONS name it invokes, if
 * any. For an identifier callee, a named-import alias is followed back to
 * the real exported name first (`import { writeFileSync as put } from
 * 'node:fs'; put(...)` is detected as `writeFileSync`, closing the
 * aliasing bypass the Task #1522 review flagged). If the identifier has no
 * traced import binding at all, it falls back to matching the raw text --
 * the same as this guard's original behavior -- because for DETECTION
 * (unlike sandbox trust) the safe default is to over-detect a possible
 * write, not under-detect one. Property access (`fs.writeFileSync(...)`)
 * is matched by property name directly, as before.
 */
function resolveWriteFunctionName(expr: ts.LeftHandSideExpression, importBindings: Map<string, ImportBinding>): string | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    return WRITE_FUNCTIONS.has(propName) ? propName : null;
  }
  if (ts.isIdentifier(expr)) {
    const binding = importBindings.get(expr.text);
    const candidateName = binding ? binding.originalName : expr.text;
    return WRITE_FUNCTIONS.has(candidateName) ? candidateName : null;
  }
  return null;
}

function findWriteCallSites(sourceFile: ts.SourceFile, importBindings: Map<string, ImportBinding>): WriteCallSite[] {
  const sites: WriteCallSite[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = resolveWriteFunctionName(node.expression, importBindings);
      const argIndex = name ? WRITE_FUNCTIONS.get(name) : undefined;
      if (name && argIndex !== undefined && node.arguments.length > argIndex) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        sites.push({ fn: name, line: line + 1, targetArg: node.arguments[argIndex] });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return sites;
}

interface ScannedFile {
  entryName: string;
  ctx: FileCtx;
  sites: WriteCallSite[];
}

function scanScriptsDirectory(scriptsRoot: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const entries = fs.readdirSync(scriptsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const filePath = path.join(scriptsRoot, entry.name);
    const fileText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, fileText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const importBindings = collectNamedImportBindings(sourceFile);
    const ctx: FileCtx = { filePath, fileDir: path.dirname(filePath), sourceFile, importBindings };
    out.push({ entryName: entry.name, ctx, sites: findWriteCallSites(sourceFile, importBindings) });
  }
  return out;
}

interface TrackedViolation { file: string; line: number; fn: string; target: string; trackedRoot: string }
interface UnresolvedViolation { file: string; line: number; fn: string; argExprText: string; reason: string }

function scanForViolations(scriptsRoot: string): { tracked: TrackedViolation[]; unresolved: UnresolvedViolation[] } {
  const tracked: TrackedViolation[] = [];
  const unresolved: UnresolvedViolation[] = [];
  const seenTracked = new Set<string>();
  const seenUnresolved = new Set<string>();

  for (const { entryName, ctx, sites } of scanScriptsDirectory(scriptsRoot)) {
    for (const site of sites) {
      const resolved = resolveExpr(ctx, site.targetArg, new Set());
      const rawArgText = site.targetArg.getText(ctx.sourceFile);
      const normalizedArgText = normalizeArgText(rawArgText);

      if (resolved.kind === 'sandbox') continue;

      if (resolved.kind === 'path') {
        const hit = isUnderTrackedRoot(resolved.value);
        if (!hit) continue; // outside every tracked directory -- safe
        const relTarget = path.relative(PROJECT_ROOT, resolved.value).split(path.sep).join('/');
        if (TARGET_ALLOWLIST.has(`${entryName}::${relTarget}`)) continue;
        const dedupeKey = `${entryName}::${relTarget}`;
        if (seenTracked.has(dedupeKey)) continue;
        seenTracked.add(dedupeKey);
        tracked.push({ file: entryName, line: site.line, fn: site.fn, target: relTarget, trackedRoot: hit.label });
        continue;
      }

      // resolved.kind === 'unknown' -- fail-closed: this is ALSO a
      // violation unless explicitly allowlisted. We do not know whether an
      // unresolvable target is inside a tracked directory, and a script
      // must not be able to bypass this guard just by making its
      // destination expression hard to analyze statically.
      if (UNRESOLVED_ALLOWLIST.has(`${entryName}::${site.fn}::${normalizedArgText}`)) continue;
      const dedupeKey = `${entryName}::${site.fn}::${normalizedArgText}`;
      if (seenUnresolved.has(dedupeKey)) continue;
      seenUnresolved.add(dedupeKey);
      unresolved.push({ file: entryName, line: site.line, fn: site.fn, argExprText: normalizedArgText, reason: resolved.reason });
    }
  }
  return { tracked, unresolved };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Source-mutation write guard — server/scripts writes stay out of tracked directories', () => {
  it('finds no un-allowlisted write into client/src/, server/, or shared/, and no un-allowlisted unresolvable destination', () => {
    const { tracked, unresolved } = scanForViolations(SCRIPTS_ROOT);
    if (tracked.length > 0 || unresolved.length > 0) {
      const trackedDetail = tracked
        .map((v) => `  [tracked]    ${v.file}:${v.line} ${v.fn}(...) -> ${v.target} (inside ${v.trackedRoot}/)`)
        .join('\n');
      const unresolvedDetail = unresolved
        .map((v) => `  [unresolved] ${v.file}:${v.line} ${v.fn}(${v.argExprText}) -- ${v.reason}`)
        .join('\n');
      assert.fail(
        `Found ${tracked.length} write(s) into a tracked source directory and ${unresolved.length} ` +
        `write(s) with an unresolvable destination, none covered by an ALLOWLIST entry:\n` +
        [trackedDetail, unresolvedDetail].filter(Boolean).join('\n') + '\n\n' +
        `Fix: route the write through a private mkdtempSync() directory (see ` +
        `server/scripts/filter-url-mutation-fixture.ts), or add a reasoned ALLOWLIST entry in ` +
        `server/scripts/scan-source-mutation-writes.test.ts (kind: 'target' for a proven tracked-path ` +
        `write, kind: 'unresolved' for a destination this scanner cannot resolve but you have verified ` +
        `by reading the source).`,
      );
    }
  });

  it('every ALLOWLIST entry still points at a file that exists in server/scripts/', () => {
    const missingSourceFiles = [...new Set(ALLOWLIST.map((e) => e.file))].filter(
      (f) => !fs.existsSync(path.join(SCRIPTS_ROOT, f)),
    );
    assert.deepEqual(
      missingSourceFiles,
      [],
      `ALLOWLIST references file(s) that no longer exist under server/scripts/ -- remove their ` +
      `entries:\n${missingSourceFiles.map((f) => `  ${f}`).join('\n')}`,
    );
  });

  it('every ALLOWLIST entry is still actually detected at a real call site (stale-entry guard)', () => {
    // If a grandfathered script is fixed to use the sandbox pattern (or an
    // expression is edited so it no longer reads the way an entry expects),
    // that entry becomes stale. Nobody would notice, and the allowlist would
    // grow without bound instead of shrinking as scripts get fixed. This
    // asserts every entry still corresponds to a real, currently-detected
    // call site.
    const stale: string[] = [];
    const byFile = new Map<string, ScannedFile>();
    for (const scanned of scanScriptsDirectory(SCRIPTS_ROOT)) byFile.set(scanned.entryName, scanned);

    for (const entry of ALLOWLIST) {
      const scanned = byFile.get(entry.file);
      if (!scanned) continue; // reported by the previous test
      if (entry.kind === 'target') {
        const matches = scanned.sites.some((site) => {
          const resolved = resolveExpr(scanned.ctx, site.targetArg, new Set());
          if (resolved.kind !== 'path') return false;
          const rel = path.relative(PROJECT_ROOT, resolved.value).split(path.sep).join('/');
          return rel === entry.target;
        });
        if (!matches) stale.push(`${entry.file} -> target ${entry.target}`);
      } else {
        const wanted = normalizeArgText(entry.argExprText);
        const matches = scanned.sites.some(
          (site) => site.fn === entry.fn && normalizeArgText(site.targetArg.getText(scanned.ctx.sourceFile)) === wanted,
        );
        if (!matches) stale.push(`${entry.file} -> unresolved ${entry.fn}(${entry.argExprText})`);
      }
    }
    assert.deepEqual(
      stale,
      [],
      `The following ALLOWLIST entries no longer match any detected call site -- remove them or ` +
      `update the entry:\n${stale.map((s) => `  ${s}`).join('\n')}`,
    );
  });
});

// ─── Resolver unit checks ────────────────────────────────────────────────────

function ctxFor(fileText: string, filePath = path.join(SCRIPTS_ROOT, 'dummy-scanned-file.ts')): FileCtx {
  const sourceFile = ts.createSourceFile(filePath, fileText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { filePath, fileDir: path.dirname(filePath), sourceFile, importBindings: collectNamedImportBindings(sourceFile) };
}

/** Parses `const _ = <expr>;` and resolves the expression on the right-hand side. */
function resolveExprText(fileText: string, expr: string, filePath?: string): Resolved {
  const ctx = ctxFor(`${fileText}\nconst __probe__ = ${expr};\n`, filePath);
  const init = findTopLevelVariableInitializer(ctx.sourceFile, '__probe__')!;
  return resolveExpr(ctx, init, new Set());
}

describe('Source-mutation write guard — resolver unit checks', () => {
  it('resolves __dirname and import.meta.dirname to the scanned file\'s own directory', () => {
    const ctx = ctxFor('');
    assert.equal((resolveExprText('', '__dirname') as any).value, ctx.fileDir);
    assert.equal((resolveExprText('', 'import.meta.dirname') as any).value, ctx.fileDir);
  });

  it('resolves __filename and fileURLToPath(import.meta.url) to the scanned file itself', () => {
    const ctx = ctxFor('');
    assert.equal((resolveExprText('', '__filename') as any).value, ctx.filePath);
    assert.equal((resolveExprText('', 'fileURLToPath(import.meta.url)') as any).value, ctx.filePath);
  });

  it('resolves process.cwd() to PROJECT_ROOT', () => {
    const r = resolveExprText('', 'process.cwd()');
    assert.equal(r.kind, 'path');
    assert.equal((r as any).value, PROJECT_ROOT);
  });

  it('resolves a bare relative string literal against PROJECT_ROOT', () => {
    const r = resolveExprText('', "'server/routes.ts'");
    assert.deepEqual(r, { kind: 'path', value: path.resolve(PROJECT_ROOT, 'server/routes.ts') });
  });

  it('resolves resolve(__dirname, "../foo.ts")-style calls', () => {
    const r = resolveExprText('', "resolve(__dirname, '../routes.ts')");
    assert.deepEqual(r, { kind: 'path', value: path.resolve(PROJECT_ROOT, 'server/routes.ts') });
  });

  it('follows local const indirection across multiple statements', () => {
    const fileText = [
      `const thisFile = fileURLToPath(import.meta.url);`,
      `const scriptsDir = path.dirname(thisFile);`,
      `const workspaceRoot = path.resolve(scriptsDir, '..', '..');`,
      `const target = path.resolve(workspaceRoot, 'shared/schema.ts');`,
    ].join('\n');
    const r = resolveExprText(fileText, 'target');
    assert.deepEqual(r, { kind: 'path', value: path.resolve(PROJECT_ROOT, 'shared/schema.ts') });
  });

  it('treats mkdtempSync(...)-derived expressions as sandboxed, not a tracked-path violation', () => {
    const fileText = [
      "import { mkdtempSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const tempRoot = mkdtempSync(join(tmpdir(), 'x-'));",
      "const target = join(tempRoot, 'shared', 'schema.ts');",
    ].join('\n');
    const r = resolveExprText(fileText, 'target');
    assert.equal(r.kind, 'sandbox');
  });

  it('treats a verified create*Sandbox() factory (imported from the real fixture module) and its member access as sandboxed', () => {
    const fileText = [
      "import { createFilterUrlMutationSandbox } from './filter-url-mutation-fixture';",
      "const sandbox = createFilterUrlMutationSandbox();",
    ].join('\n');
    const r = resolveExprText(fileText, 'sandbox.logicFile');
    assert.equal(r.kind, 'sandbox');
  });

  it('resolves an aliased named import (mkdtempSync as makeTempDir) to its real exported name for sandbox trust', () => {
    const fileText = [
      "import { mkdtempSync as makeTempDir } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const tempRoot = makeTempDir(join(tmpdir(), 'x-'));",
      "const target = join(tempRoot, 'shared', 'schema.ts');",
    ].join('\n');
    const r = resolveExprText(fileText, 'target');
    assert.equal(r.kind, 'sandbox');
  });

  it('does NOT trust mkdtempSync when it is a same-file shadow, not the real node:fs import', () => {
    const fileText = [
      "function mkdtempSync() { return 'server/routes.ts'; }",
      "const target = mkdtempSync();",
    ].join('\n');
    const r = resolveExprText(fileText, 'target');
    assert.notEqual(r.kind, 'sandbox', 'a same-file shadow of mkdtempSync must never be trusted as a sandbox primitive');
  });

  it('does NOT trust a same-file function merely named like a sandbox factory (createXSandbox) without a verified import', () => {
    const fileText = [
      "function createFakeSandbox() { return 'server/routes.ts'; }",
      "const target = createFakeSandbox();",
    ].join('\n');
    const r = resolveExprText(fileText, 'target');
    assert.notEqual(r.kind, 'sandbox', 'a same-file function merely named like a sandbox factory must never be trusted');
  });

  it('detects an aliased write-function import (import { writeFileSync as put }) rather than missing it', () => {
    const ctx = ctxFor([
      "import { writeFileSync as put } from 'node:fs';",
      "put('server/routes.ts', 'HACKED');",
    ].join('\n'));
    const sites = findWriteCallSites(ctx.sourceFile, ctx.importBindings);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].fn, 'writeFileSync');
  });

  it('does not flag an absolute /tmp literal as a tracked-directory violation', () => {
    const r = resolveExprText('', "resolve('/tmp', 'imageurl-selftest')");
    assert.equal(r.kind, 'path');
    assert.equal(isUnderTrackedRoot((r as any).value), null, 'a /tmp path must never match a TRACKED_ROOTS entry');
  });

  it('returns unknown for a bare function-parameter-style identifier rather than guessing', () => {
    const r = resolveExprText('', 'somePathParameter');
    assert.equal(r.kind, 'unknown');
  });

  it('targets argument index 1 (not 0) for renameSync/copyFile-family calls', () => {
    const ctx = ctxFor("renameSync('/tmp/staging-file', 'server/routes.ts');\n");
    const sites = findWriteCallSites(ctx.sourceFile, ctx.importBindings);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].fn, 'renameSync');
    const resolved = resolveExpr(ctx, sites[0].targetArg, new Set());
    assert.deepEqual(resolved, { kind: 'path', value: path.resolve(PROJECT_ROOT, 'server/routes.ts') });
  });

  it('detects the callback/promise write forms (writeFile, copyFile, rename), not just the Sync forms', () => {
    const ctx = ctxFor([
      "await writeFile('server/a.ts', data);",
      "await copyFile('/tmp/x', 'server/b.ts');",
      "await rename('/tmp/y', 'server/c.ts');",
    ].join('\n'));
    const sites = findWriteCallSites(ctx.sourceFile, ctx.importBindings);
    const targets = sites.map((s) => {
      const r = resolveExpr(ctx, s.targetArg, new Set());
      return r.kind === 'path' ? path.relative(PROJECT_ROOT, r.value) : r.kind;
    });
    assert.deepEqual(new Set([...targets]), new Set(['server/a.ts', 'server/b.ts', 'server/c.ts']));
  });

  it('requires EVERY resolve()/join() argument to resolve concretely -- no partial-credit placeholder for an unresolvable segment', () => {
    // Even though 'server' is a concrete, tracked-root-matching first
    // segment, an unresolvable second segment must make the WHOLE call
    // unknown rather than silently combining into a guessed path.
    const r = resolveExprText('', "join('server', someDynamicId)");
    assert.equal(r.kind, 'unknown');
  });

  it('a resolvable base with an unresolvable trailing segment is unknown, not silently classified as safe', () => {
    // Guards against a resolver bug where "can't resolve one segment" is
    // treated as "this must be fine" -- it must surface as needing review.
    const r = resolveExprText('', "join(__dirname, someDynamicId, 'x.ts')");
    assert.equal(r.kind, 'unknown');
  });
});

// ─── Meta-test: scanner end-to-end against real temp fixtures ─────────────────
//
// Proves the scanner would actually fail CI on a brand-new violation, and
// specifically on the bypass forms the Task #1522 review called out: an
// async/promise write, a template-literal destination, a conditional
// (ternary) destination, and a destination built via `new URL(...)` /
// string concatenation. Every fixture script here is written into a REAL OS
// TEMP DIRECTORY (never into server/scripts/ itself), and the scanner is
// pointed at that directory -- so this meta-test never itself performs the
// antipattern it exists to catch.

function withFixtureScriptsDir(files: Record<string, string>): { dir: string; violationCount: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-source-mutation-writes-selftest-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
    const { tracked, unresolved } = scanForViolations(dir);
    return { dir, violationCount: tracked.length + unresolved.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Source-mutation write guard — scanner self-validation (end-to-end, isolated fixture root)', () => {
  it('flags a plain writeFileSync(...) with a literal path into server/', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-plain.ts': "import { writeFileSync } from 'node:fs';\nwriteFileSync('server/routes.ts', 'HACKED');\n",
    });
    assert.equal(violationCount, 1);
  });

  it('does NOT flag a script that routes its write through mkdtempSync (negative control)', () => {
    const { violationCount } = withFixtureScriptsDir({
      'good-sandboxed.ts': [
        "import { writeFileSync, mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const dir = mkdtempSync(join(tmpdir(), 'x-'));",
        "writeFileSync(join(dir, 'routes.ts'), 'safe copy');",
      ].join('\n'),
    });
    assert.equal(violationCount, 0);
  });

  it('flags an async/promise write form (fs/promises writeFile), not just writeFileSync', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-async.ts': [
        "import { writeFile } from 'node:fs/promises';",
        "export async function run() { await writeFile('server/routes.ts', 'HACKED'); }",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  it('flags a template-literal destination rather than silently passing it', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-template.ts': [
        "import { writeFileSync } from 'node:fs';",
        "const id = String(process.pid);",
        "writeFileSync(`server/generated-${id}.ts`, 'HACKED');",
      ].join('\n'),
    });
    // Unresolvable (this guard does not combine template literals into a
    // concrete path) -- fail-closed means this must still surface as a
    // violation requiring an explicit ALLOWLIST entry, not pass silently.
    assert.equal(violationCount, 1);
  });

  it('flags a conditional (ternary) destination rather than silently passing it', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-conditional.ts': [
        "import { writeFileSync } from 'node:fs';",
        "declare const flag: boolean;",
        "const target = flag ? '/tmp/harmless.ts' : 'server/routes.ts';",
        "writeFileSync(target, 'HACKED');",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  it('flags a destination built via string concatenation rather than silently passing it', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-concat.ts': [
        "import { writeFileSync } from 'node:fs';",
        "const target = 'ser' + 'ver/routes.ts';",
        "writeFileSync(target, 'HACKED');",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  it('flags a destination built via new URL(...) rather than silently passing it', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-url.ts': [
        "import { writeFileSync } from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        "const target = fileURLToPath(new URL('../routes.ts', import.meta.url));",
        "writeFileSync(target, 'HACKED');",
      ].join('\n'),
    });
    // `new URL(...)` is not a recognized construct -- unknown, fail-closed.
    assert.equal(violationCount, 1);
  });

  it('flags a rename()/copyFile-family write targeting arg index 1 into server/', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-rename.ts': [
        "import { renameSync } from 'node:fs';",
        "renameSync('/tmp/staging.ts', 'server/routes.ts');",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  // ── Task #1522 review: three concrete bypasses of the ORIGINAL scanner,
  //    each proven fixed end-to-end against a real (temp-directory) fixture
  //    file, not just at the resolver-unit level. ──

  it('flags an aliased write-function import (import { writeFileSync as put }) rather than missing it', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-aliased-import.ts': [
        "import { writeFileSync as put } from 'node:fs';",
        "put('server/routes.ts', 'HACKED');",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  it('flags a write through a shadowing inner variable even when an outer same-named variable is sandbox-derived', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-shadowed.ts': [
        "import { writeFileSync, mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const target = join(mkdtempSync(join(tmpdir(), 'x-')), 'routes.ts');",
        "function evil() {",
        "  const target = 'server/routes.ts';",
        "  writeFileSync(target, 'HACKED');",
        "}",
        "evil();",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });

  it('does not trust a same-file function merely NAMED like a sandbox factory (createXSandbox) without a verified import', () => {
    const { violationCount } = withFixtureScriptsDir({
      'evil-fake-sandbox.ts': [
        "import { writeFileSync } from 'node:fs';",
        "function createFakeSandbox() { return 'server/routes.ts'; }",
        "writeFileSync(createFakeSandbox(), 'HACKED');",
      ].join('\n'),
    });
    assert.equal(violationCount, 1);
  });
});
