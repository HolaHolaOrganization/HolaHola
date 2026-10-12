import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WindowsIdentityReader } from './coordination-listener-windows-reader';

export type ProcessIdentity = { state: 'present'; created: string } | { state: 'absent' } | { state: 'unknown' };
export type ParentIdentity = { pid: number; created: string };
let windowsReader: WindowsIdentityReader | undefined;
export function closeProcessIdentityReader() {
  windowsReader?.close();
  windowsReader = undefined;
}

/** Creation identity, never PID-only liveness. Query failure is unknown, not absent. */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (e) {
      return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' };
    }
    try {
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      if (end < 0 || !/^\d+$/.test(fields[19] ?? '')) return { state: 'unknown' };
      if (fields[0] === 'Z' || fields[0] === 'X') return { state: 'absent' };
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!boot) return { state: 'unknown' };
      return { state: 'present', created: `${boot}:${fields[19]}` };
    } catch { return { state: 'unknown' }; }
  }
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot;
    if (!root) return { state: 'unknown' };
    windowsReader ??= new WindowsIdentityReader(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    return windowsReader.query(pid);
  }
  return { state: 'unknown' }; // Unsupported host is not silently assumed alive.
}

export async function parentState(parent: ParentIdentity,
  reader: (pid: number) => Promise<ProcessIdentity> = readProcessIdentity): Promise<'present' | 'absent' | 'unknown'> {
  const identity = await reader(parent.pid);
  if (identity.state !== 'present') return identity.state;
  return identity.created === parent.created ? 'present' : 'absent';
}
