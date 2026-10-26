/**
 * Unit coverage for isDirectCliInvocation() -- the shared guard every
 * server/scripts/*.ts CLI script should use instead of a substring match
 * against process.argv[1]. See cli-entrypoint.ts for the two failure modes
 * this exists to prevent: a script's own test file importing it for its
 * exported functions (substring collision), and the esbuild production
 * bundle rewriting import.meta.url for every bundled module.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectCliInvocation } from './cli-entrypoint';

describe('isDirectCliInvocation', () => {
  const originalArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it('is true for a direct CLI invocation matching the exact basename', () => {
    process.argv[1] = '/home/runner/workspace/server/scripts/populate-principle-embeddings.ts';
    assert.equal(isDirectCliInvocation('populate-principle-embeddings.ts'), true);
  });

  it('matches on basename only, ignoring the directory portion of argv[1]', () => {
    process.argv[1] = '/some/other/checkout/path/server/scripts/coordination-cli.ts';
    assert.equal(isDirectCliInvocation('coordination-cli.ts'), true);
  });

  it('is false when the invoking file is a superstring of the script name -- the exact test-file collision this guard exists to prevent', () => {
    // This repo's test-file convention (`test-<subject>.test.ts`) means a test
    // that imports a script for its exports has a filename that naturally
    // contains the script's own base name as a substring. A `.includes()`
    // guard fires here; isDirectCliInvocation() must not.
    process.argv[1] = '/home/runner/workspace/server/scripts/test-populate-principle-embeddings.test.ts';
    assert.equal(isDirectCliInvocation('populate-principle-embeddings.ts'), false);
  });

  it('is false inside the esbuild production bundle, where argv[1] is the bundle entry, not this script', () => {
    // Any script reachable from server/index.ts is merged into dist/index.js;
    // process.argv[1] at boot is that bundle path, never the script's own
    // filename. See .agents/memory/esbuild-ismain-guard.md.
    process.argv[1] = '/home/runner/workspace/dist/index.js';
    assert.equal(isDirectCliInvocation('populate-principle-embeddings.ts'), false);
  });

  it('matches a Windows argv[1] (backslash separators) on every platform', () => {
    process.argv[1] = 'C:\\Users\\someone\\HolaHola\\server\\scripts\\shared-spec-cli.ts';
    assert.equal(isDirectCliInvocation('shared-spec-cli.ts'), true);
  });

  it('is false for a Windows argv[1] that only contains the script name as a substring', () => {
    process.argv[1] = 'C:\\Users\\someone\\HolaHola\\server\\scripts\\shared-spec-cli.test.ts';
    assert.equal(isDirectCliInvocation('shared-spec-cli.ts'), false);
  });

  it('is false when process.argv[1] is undefined', () => {
    delete process.argv[1];
    assert.equal(isDirectCliInvocation('populate-principle-embeddings.ts'), false);
  });

  it('is false for a different script name entirely', () => {
    process.argv[1] = '/home/runner/workspace/server/scripts/coordination-cli.ts';
    assert.equal(isDirectCliInvocation('agent-memory-cli.ts'), false);
  });
});
