import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { artifactBytes, digest, fail, taskReference } from './shared-task-registry-contract';
import { normalizeCoordinationRepositoryIdentity } from './coordination-repository-identity';

/** Same complete-temp/exclusive-link publication sequence as listener ownership.
 * Kept separate so the pending, independently reviewed listener payload is unchanged.
 */
export async function materializeRegistryArtifact(root: string, repository: string, raw: {
  taskRef: unknown; repositoryIdentity: unknown; artifactBase64: unknown; artifactSha256: unknown;
}) {
  const ref = taskReference(raw.taskRef);
  if (normalizeCoordinationRepositoryIdentity(raw.repositoryIdentity) !== normalizeCoordinationRepositoryIdentity(repository)) fail('PROJECT_FORBIDDEN');
  const bytes = artifactBytes(raw.artifactBase64);
  if (digest(bytes) !== raw.artifactSha256) fail('ARTIFACT_HASH_MISMATCH');
  root = await realpath(resolve(root));
  for (const directory of [join(root, '.local'), join(root, '.local', 'tasks')]) {
    await mkdir(directory, { mode: 0o700 }).catch((err: any) => { if (err?.code !== 'EEXIST') throw err; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) fail('UNSAFE_ARTIFACT_PATH');
  }
  const path = join(root, '.local', 'tasks', `task-${ref}.md`);
  const check = async () => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_ARTIFACT_PATH');
    if (!(await readFile(path)).equals(bytes)) fail('LOCAL_ARTIFACT_CONFLICT');
  };
  try { await check(); return { path, reused: true }; }
  catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
  const staging = `${path}.${randomUUID()}.tmp`;
  let ownsStaging = false;
  let reused = false;
  try {
    const handle = await open(staging, 'wx', 0o600);
    ownsStaging = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await link(staging, path); }
    catch (err: any) { if (err?.code !== 'EEXIST') throw err; reused = true; }
    await check();
    return { path, reused };
  } finally { if (ownsStaging) await unlink(staging).catch((err: any) => { if (err?.code !== 'ENOENT') throw err; }); }
}
