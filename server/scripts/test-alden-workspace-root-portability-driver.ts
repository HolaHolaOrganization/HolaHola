#!/usr/bin/env npx tsx
/**
 * Driver for test-alden-workspace-root-portability.ts -- MUST be spawned with
 * HOLAHOLA_WORKSPACE_ROOT set to a validated hermetic temp directory.
 *
 * Exercises Alden's list_directory/read_file tool handlers (both routed
 * through alden-functions.ts's shared safePath()/WORKSPACE_ROOT plumbing) and
 * prints the results as RESULTS:<json> for the parent to assert on. The
 * parent runs this driver against both the real (fixed) alden-functions.ts
 * and, in --self-check mode only, a temporarily mutated copy that
 * reintroduces the historical hardcoded '/home/runner/workspace' literal --
 * so it must never assume anything about which environment it is running in
 * beyond what HOLAHOLA_WORKSPACE_ROOT and cwd say.
 */
import { executeAldenTool } from '../services/alden-functions';
import { workspaceResolution } from '../services/workspace-root';

/**
 * This driver is spawned with `cwd` left at the real checkout (so tsx can
 * resolve this project's `@shared/*` path alias normally) but
 * HOLAHOLA_WORKSPACE_ROOT pointed at an isolated temp directory -- resolution
 * must follow the env var, not cwd, which is exactly the property under
 * test. It only issues read-only Alden tool calls (list_directory,
 * read_file), so there is no destructive risk in running it directly, but it
 * still refuses to run without an explicit root: the whole point of this
 * driver is to prove where Alden's tools resolve paths, and silently
 * defaulting to REPL_HOME or cwd would produce a result that looks like a
 * pass or fail for the wrong reason.
 */
function assertHermeticSandbox(): void {
  const configuredRoot = process.env.HOLAHOLA_WORKSPACE_ROOT?.trim();
  if (!configuredRoot) {
    console.error(
      '[test-alden-workspace-root-portability-driver] REFUSING TO RUN: HOLAHOLA_WORKSPACE_ROOT must be ' +
      'set to an isolated temp workspace -- run this only via ' +
      '`npx tsx server/scripts/test-alden-workspace-root-portability.ts`, which builds the isolated sandbox.',
    );
    process.exit(1);
  }
}

(async () => {
  assertHermeticSandbox();

  const dir = await executeAldenTool('list_directory', { path: 'server' });
  const file = await executeAldenTool('read_file', { path: 'server/ALDEN_WORKSPACE_CANARY.txt' });
  const nested = await executeAldenTool('read_file', { path: 'server/alden-canary-subdir/nested-canary.txt' });

  console.log('RESULTS:' + JSON.stringify({
    workspaceRoot: workspaceResolution.root,
    dir: dir.data,
    file: file.data,
    nested: nested.data,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
