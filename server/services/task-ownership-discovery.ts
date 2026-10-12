import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePromotionCandidate, type PromotionCandidate } from './promotion-candidate';

export type OwnershipChallengeHandle = {
  version: 1; endpoint: string; actor: string; taskRef: string;
  artifactSha256: string; keyFingerprint: string; challengeId: string;
  promotion?: PromotionCandidate;
};
export const ownershipUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

function directory(root: string, endpoint: string, actor: string, taskRef: string) {
  if (new URL(endpoint).origin !== endpoint) throw new Error('Ownership discovery needs a normalized server origin.');
  const scope = createHash('sha256').update(JSON.stringify([endpoint, actor, taskRef])).digest('hex');
  return join(root, '.local', 'task-ownership-discovery', scope);
}

/** A handle discovers a receipt; it never records approval or verified authority. */
export async function saveOwnershipChallengeHandle(root: string, handle: OwnershipChallengeHandle) {
  if (!ownershipUuid(handle.challengeId)) throw new Error('Invalid ownership challenge handle.');
  if (handle.promotion !== undefined) validatePromotionCandidate(handle.promotion);
  const dir = directory(root, handle.endpoint, handle.actor, handle.taskRef);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${handle.challengeId}.json`);
  const expected = JSON.stringify(handle);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${expected}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await link(temporary, target); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ownership discovery handle is not a regular file.');
  const actual = JSON.parse(await readFile(target, 'utf8'));
  if (JSON.stringify(actual) !== expected) throw new Error('Ownership discovery handle conflicts with saved identity; refusing replacement.');
}

export async function readOwnershipChallengeHandles(
  root: string, binding: Omit<OwnershipChallengeHandle, 'version' | 'challengeId'>,
): Promise<OwnershipChallengeHandle[]> {
  const dir = directory(root, binding.endpoint, binding.actor, binding.taskRef);
  let names: string[];
  try { names = await readdir(dir); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const handles: OwnershipChallengeHandle[] = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ownership discovery handle is not a regular file.');
    let handle: OwnershipChallengeHandle;
    try { handle = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('Ownership discovery handle is unreadable; stop and recover local state.'); }
    if (handle.version !== 1 || !ownershipUuid(handle.challengeId) || name !== `${handle.challengeId}.json`
        || Object.keys(handle).filter(key => key !== 'promotion').sort().join(',') !== 'actor,artifactSha256,challengeId,endpoint,keyFingerprint,taskRef,version'
        || Object.entries(binding).some(([field, value]) => handle[field as keyof OwnershipChallengeHandle] !== value)) {
      throw new Error('Ownership discovery handle mismatches endpoint, actor, task, artifact or custody key.');
    }
    if (handle.promotion !== undefined) validatePromotionCandidate(handle.promotion);
    handles.push(handle);
  }
  return handles;
}
