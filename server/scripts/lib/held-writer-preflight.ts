/**
 * Side-effect-only preflight for held standalone writers (plan efb1e3d1 rev 13,
 * O2/O3). Each held script imports this as its FIRST import, so ES module
 * evaluation order runs the hold before any DB-dependent module in that
 * script's import graph initializes (e.g. agent-memory-core -> db = getDb()).
 *
 * It holds only when the process was launched as one of the held scripts
 * (exact basename of process.argv[1], the same rule as isDirectCliInvocation),
 * so a test or the server bundle importing the module is unaffected.
 * Its own imports (node:path, launch-hold -> ci-database) have no DB access.
 */
import { basename } from 'node:path';
import { HELD_WRITER_SCRIPTS, holdUnlessDisposableTarget } from './launch-hold';

const entry = process.argv[1] === undefined ? '' : basename(process.argv[1]);
if (Object.hasOwn(HELD_WRITER_SCRIPTS, entry)) {
  holdUnlessDisposableTarget(HELD_WRITER_SCRIPTS[entry as keyof typeof HELD_WRITER_SCRIPTS]);
}
