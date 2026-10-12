import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parentState, readProcessIdentity, type ProcessIdentity } from './coordination-listener-identity';

type Scope = { actor: string; apiUrl: string };
const markerPattern = /^guard-recovery-[a-f0-9-]{36}\.json$/;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export class GuardBlocked extends Error { readonly code = 'GUARD_BLOCKED'; }
let selfIdentity: Promise<ProcessIdentity> | undefined;

/** Final names are exclusive and expose only fully written, closed identity records.
 * Interrupted staging files are not guards/markers and never authorize recovery.
 * Injectable filesystem operations allow real process-death tests at each boundary.
 */
export async function publishOwnershipRecord(path: string, record: object,
  io: { open: typeof open; link: typeof link; unlink: typeof unlink } = { open, link, unlink }) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let ownsTemporary = false;
  try {
    const handle = await io.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { await handle.writeFile(JSON.stringify(record)); }
    finally { await handle.close(); }
    // Same-directory hard link: atomic visibility and EEXIST, never replacement.
    await io.link(temporary, path);
  } finally {
    if (ownsTemporary) await io.unlink(temporary).catch(e => { if (!missing(e)) throw e; });
  }
}

async function identityRecord(scope: Scope) {
  // Our own creation identity cannot change within this process.
  const identity = await (selfIdentity ??= readProcessIdentity(process.pid));
  if (identity.state !== 'present') { selfIdentity = undefined; throw new GuardBlocked('guard_self_identity_unknown'); }
  return { ...scope, pid: process.pid, created: identity.created, owner: randomUUID() };
}
function validate(record: any, scope: Scope) {
  if (record?.actor !== scope.actor || record?.apiUrl !== scope.apiUrl ||
      !Number.isSafeInteger(record.pid) || record.pid < 1 ||
      typeof record.created !== 'string' || !record.created || typeof record.owner !== 'string') {
    throw new GuardBlocked('guard_identity_unknown');
  }
}
export async function ownershipStatus(directory: string) {
  const names = await readdir(directory);
  return { guardPresent: names.includes('ownership.guard'), recoveryMarkers: names.filter(n => markerPattern.test(n)) };
}

export async function withOwnershipGuard<T>(directory: string, scope: Scope, action: () => Promise<T>): Promise<T> {
  const record = await identityRecord(scope);
  if ((await ownershipStatus(directory)).recoveryMarkers.length) throw new GuardBlocked('guard_recovery_in_progress_or_stranded');
  try { await publishOwnershipRecord(join(directory, 'ownership.guard'), record); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new GuardBlocked('guard_present');
    throw e;
  }
  try { return await action(); }
  finally { await unlink(join(directory, 'ownership.guard')); }
}

/** Explicit recovery only. Unique markers prevent a second recoverer deleting a new owner's guard. */
export async function recoverOwnershipGuard(directory: string, scope: Scope,
  reader: (pid: number) => Promise<ProcessIdentity> = readProcessIdentity) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = await identityRecord(scope);
  const marker = `guard-recovery-${record.owner}.json`;
  await publishOwnershipRecord(join(directory, marker), record);
  try {
    // Normal acquisition refuses markers. Other recoverers refuse our live marker.
    for (const name of (await ownershipStatus(directory)).recoveryMarkers) {
      if (name === marker) continue;
      let other;
      try { other = JSON.parse(await readFile(join(directory, name), 'utf8')); }
      catch (e) { if (missing(e)) continue; throw new GuardBlocked('recovery_marker_unknown'); }
      validate(other, scope);
      if (await parentState(other, reader) !== 'absent') throw new GuardBlocked('recovery_owner_live_or_unknown');
      // Unique names are never reused, so stale marker removal cannot target a new owner.
      await unlink(join(directory, name)).catch(e => { if (!missing(e)) throw e; });
    }
    let guard;
    try { guard = JSON.parse(await readFile(join(directory, 'ownership.guard'), 'utf8')); }
    catch (e) { if (missing(e)) return; throw new GuardBlocked('guard_identity_unknown'); }
    validate(guard, scope);
    if (await parentState(guard, reader) !== 'absent') throw new GuardBlocked('guard_owner_live_or_unknown');
    await unlink(join(directory, 'ownership.guard'));
  } finally {
    await unlink(join(directory, marker)).catch(e => { if (!missing(e)) throw e; });
  }
}
