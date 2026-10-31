#!/usr/bin/env npx tsx
/**
 * test-alden-workspace-root-portability.ts
 *
 * Regression guard for the Alden file/shell tool workspace-root bug: Alden's
 * read_file/list_directory/search_code/search_multi/run_shell tool handlers
 * in server/services/alden-functions.ts all resolve paths through one shared
 * WORKSPACE_ROOT constant. That constant used to be hardcoded to
 * '/home/runner/workspace' -- a Replit-only container path -- which broke
 * every one of those tools silently the moment production ran on Render
 * instead of Replit: list_directory/read_file (routed through safePath())
 * reported "Directory not found", and the execSync-based tools
 * (run_shell/search_code/search_multi, which pass `cwd: WORKSPACE_ROOT`)
 * surfaced Node's misleading "spawnSync /bin/sh ENOENT" (a nonexistent `cwd`
 * is reported as if the shell binary itself were missing). The fix swapped
 * the hardcoded literal for workspaceResolution.root
 * (server/services/workspace-root.ts), the same portable root resolver the
 * canonical capture system uses. Nothing previously caught a repeat of the
 * hardcoded literal automatically.
 *
 * Two layers, both required:
 *
 *   1. Static source guard -- deterministic regardless of which environment
 *      this test itself runs in (Replit dev sandbox, GitHub Actions, or a
 *      future Render CI): WORKSPACE_ROOT must be declared as exactly
 *      `workspaceResolution.root`, and the file must not assign it -- or
 *      hardcode the historical literal anywhere else in executable code --
 *      as a string literal.
 *
 *   2. Behavioral proof -- spawns a fresh process with HOLAHOLA_WORKSPACE_ROOT
 *      pointed at an isolated temp project root (which cannot coincidentally
 *      match a hardcoded fallback, unlike this sandbox's own REPL_HOME) and
 *      proves executeAldenTool's list_directory/read_file (both routed
 *      through safePath(), the same helper run_shell/search_code/search_multi
 *      key their cwd/searchDir off of) actually resolve against that temp
 *      root.
 *
 * Usage:
 *   npx tsx server/scripts/test-alden-workspace-root-portability.ts
 *     Runs both layers against the current (fixed) source and asserts they pass.
 *
 *   npx tsx server/scripts/test-alden-workspace-root-portability.ts --self-check
 *     Temporarily reintroduces the historical hardcoded literal into
 *     alden-functions.ts, proves the static guard flips and the behavioral
 *     check then fails with the expected signature (the temp root's canary
 *     file goes missing from the tool results), and restores the original
 *     file byte-for-byte.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const aldenFunctionsPath = resolve(root, 'server/services/alden-functions.ts');
const driverPath = resolve(root, 'server/scripts/test-alden-workspace-root-portability-driver.ts');

const CANONICAL_IMPORT = 'import { workspaceResolution } from "./workspace-root";';
const CANONICAL_DECLARATION = 'const WORKSPACE_ROOT = workspaceResolution.root;';
const HARDCODED_DECLARATION = "const WORKSPACE_ROOT = '/home/runner/workspace';";
const HARDCODED_LITERAL_PATTERN = /\bWORKSPACE_ROOT\s*=\s*['"][^'"]*['"]/;

function assertStaticGuard(source: string, { expectPortable }: { expectPortable: boolean }): void {
  if (expectPortable) {
    assert.ok(
      source.includes(CANONICAL_IMPORT),
      'alden-functions.ts must import workspaceResolution from ./workspace-root',
    );
    assert.ok(
      source.includes(CANONICAL_DECLARATION),
      'alden-functions.ts must declare WORKSPACE_ROOT as workspaceResolution.root',
    );
    assert.doesNotMatch(
      source,
      HARDCODED_LITERAL_PATTERN,
      'alden-functions.ts must not assign WORKSPACE_ROOT a hardcoded string-literal path',
    );
    const nonCommentSource = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.ok(
      !nonCommentSource.includes('/home/runner/workspace'),
      'alden-functions.ts must not hardcode the Replit-only workspace path in executable code ' +
      '(the literal may only appear inside an explanatory comment)',
    );
  } else {
    assert.match(
      source,
      HARDCODED_LITERAL_PATTERN,
      'expected the reintroduced hardcoded literal to match the guard pattern -- update this ' +
      'self-check if the mutation shape changed',
    );
  }
}

function createFixtures(): { tempRoot: string; canaryToken: string } {
  const tempRoot = mkdtempSync(join(tmpdir(), 'alden-workspace-root-'));
  mkdirSync(join(tempRoot, 'server'), { recursive: true });
  mkdirSync(join(tempRoot, 'shared'), { recursive: true });
  // The canaries live under server/: Alden's read policy (gated-fixes design e4f8e988 P2)
  // exposes only its allowed root, so a canary at the workspace top level is hidden by design.
  mkdirSync(join(tempRoot, 'server', 'alden-canary-subdir'), { recursive: true });
  writeFileSync(join(tempRoot, 'package.json'), '{}');
  writeFileSync(join(tempRoot, 'drizzle.config.ts'), 'export default {};');
  writeFileSync(join(tempRoot, 'shared', 'schema.ts'), 'export {};');

  const canaryToken = `ALDEN_WORKSPACE_CANARY_${randomUUID().replace(/-/g, '')}`;
  writeFileSync(join(tempRoot, 'server', 'ALDEN_WORKSPACE_CANARY.txt'), `${canaryToken}\n`);
  writeFileSync(join(tempRoot, 'server', 'alden-canary-subdir', 'nested-canary.txt'), `${canaryToken}-nested\n`);

  return { tempRoot, canaryToken };
}

interface DriverRun {
  exitCode: number | null;
  output: string;
  results: Record<string, any> | null;
}

function runDriver(tempRoot: string): DriverRun {
  // cwd stays at the real checkout so tsx resolves this project's
  // `@shared/*` path alias normally; HOLAHOLA_WORKSPACE_ROOT (always an
  // absolute path here) is what must drive Alden's tool resolution, not cwd.
  const run = spawnSync('npx', ['tsx', driverPath], {
    cwd: root,
    env: {
      ...process.env,
      HOLAHOLA_WORKSPACE_ROOT: tempRoot,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const match = /RESULTS:(\{.*\})/.exec(output);
  return {
    exitCode: run.status,
    output,
    results: match ? JSON.parse(match[1]) : null,
  };
}

function assertPortableBehavior(tempRoot: string, canaryToken: string): void {
  const run = runDriver(tempRoot);
  assert.equal(
    run.exitCode,
    0,
    `driver failed against an isolated temp workspace root -- output:\n${run.output}`,
  );
  assert.ok(run.results, `driver produced no RESULTS line -- output:\n${run.output}`);
  const results = run.results as Record<string, any>;

  assert.equal(
    results.workspaceRoot,
    tempRoot,
    `workspaceResolution.root did not honor HOLAHOLA_WORKSPACE_ROOT (got ${results.workspaceRoot})`,
  );
  assert.equal(results.dir?.error, undefined, `list_directory failed: ${JSON.stringify(results.dir)}`);
  assert.ok(
    results.dir?.files?.includes('ALDEN_WORKSPACE_CANARY.txt'),
    `list_directory did not see the temp workspace's canary file -- it resolved somewhere else: ${JSON.stringify(results.dir)}`,
  );
  assert.ok(
    results.dir?.directories?.includes('alden-canary-subdir/'),
    `list_directory did not see the temp workspace's canary subdirectory: ${JSON.stringify(results.dir)}`,
  );
  assert.equal(results.file?.error, undefined, `read_file failed: ${JSON.stringify(results.file)}`);
  assert.ok(
    results.file?.content?.includes(canaryToken),
    `read_file did not return the temp workspace's canary content: ${JSON.stringify(results.file)}`,
  );
  assert.equal(results.nested?.error, undefined, `nested read_file failed: ${JSON.stringify(results.nested)}`);
  assert.ok(
    results.nested?.content?.includes(`${canaryToken}-nested`),
    `nested read_file did not return the temp workspace's canary content: ${JSON.stringify(results.nested)}`,
  );
}

function assertMutatedBehaviorFails(tempRoot: string): void {
  const run = runDriver(tempRoot);
  const dirFiles: string[] = run.results?.dir?.files ?? [];
  assert.equal(
    dirFiles.includes('ALDEN_WORKSPACE_CANARY.txt'),
    false,
    'reintroducing the hardcoded literal unexpectedly still resolved Alden tools to the isolated ' +
    `temp workspace -- output:\n${run.output}`,
  );
}

async function assertRegressionGuard(): Promise<void> {
  const source = readFileSync(aldenFunctionsPath, 'utf8');
  assertStaticGuard(source, { expectPortable: true });

  const { tempRoot, canaryToken } = createFixtures();
  try {
    assertPortableBehavior(tempRoot, canaryToken);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(
    '[alden-workspace-root-portability] PASS: Alden file tools resolve paths via ' +
    'workspaceResolution.root, and alden-functions.ts contains no hardcoded workspace-root literal.',
  );
}

async function selfCheck(): Promise<void> {
  const originalBytes = readFileSync(aldenFunctionsPath);
  const originalSource = originalBytes.toString('utf8');

  assert.equal(
    originalSource.split(CANONICAL_DECLARATION).length - 1,
    1,
    'Expected exactly one canonical WORKSPACE_ROOT declaration to mutate -- update this self-check ' +
    'if alden-functions.ts was intentionally restructured',
  );

  const mutantSource = originalSource.replace(CANONICAL_DECLARATION, HARDCODED_DECLARATION);
  assert.notEqual(mutantSource, originalSource, 'Mutation did not change alden-functions.ts');

  // Prove the static guard's own pattern flips correctly on the mutant before
  // touching disk -- if this fails, the regex is the thing that's broken.
  assertStaticGuard(mutantSource, { expectPortable: false });

  const { tempRoot } = createFixtures();
  try {
    writeFileSync(aldenFunctionsPath, mutantSource);
    try {
      assertMutatedBehaviorFails(tempRoot);
      console.log(
        '[alden-workspace-root-portability] SELF-CHECK PASS: reintroducing the hardcoded ' +
        'workspace-root literal correctly breaks Alden tool resolution and is caught by the ' +
        'static guard pattern.',
      );
    } finally {
      writeFileSync(aldenFunctionsPath, originalBytes);
      assert.deepEqual(
        readFileSync(aldenFunctionsPath),
        originalBytes,
        'Failed to restore alden-functions.ts byte-for-byte after mutation',
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isSelfCheck = process.argv.includes('--self-check');
(isSelfCheck ? selfCheck() : assertRegressionGuard()).catch((error) => {
  console.error(error);
  process.exit(1);
});
