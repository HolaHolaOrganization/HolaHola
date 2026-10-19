import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

/** Opt-in evidence of module-load completion, NOT listener readiness. */
export async function recordBootDiagnosticEntry(
  root: string,
  invocation = process.env.HOLAHOLA_LISTENER_BOOT_DIAGNOSTIC_RUN,
): Promise<void> {
  if (invocation === undefined) return;
  try {
    if (!/^invocation\.[A-Za-z0-9]{10}$/.test(invocation)) throw new Error('invalid_run');
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('unsupported_owner');
    const canonicalRoot = await realpath(root);
    const parent = join(canonicalRoot, '.local/coordination-listeners/luca-replit/boot/diagnostics');
    const directory = join(parent, invocation);
    if (await realpath(directory) !== directory) throw new Error('redirected_run');
    for (const path of [parent, directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) {
        throw new Error('unsafe_directory');
      }
    }
    // Append only to the wrapper-created file. No creation/fallback/path input.
    const file = await open(join(directory, 'events.log'),
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
        throw new Error('unsafe_file');
      }
      await file.writeFile(`${new Date().toISOString()} phase=node-entry pid=${process.pid}\n`);
    } finally {
      await file.close();
    }
  } catch {
    // Never print paths, tags, exceptions, environment, credentials or output.
    // Diagnostic failure must not replace the launcher's real result.
    console.error('LUCABOOT diagnostic-entry-unavailable');
  }
}
