import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TaskAgentKey {
  taskRef: string;
  publicKey: string;
  fingerprint: string;
  privateKeyPath: string;
}

export const TASK_AGENT_KEY_ROOT = join(tmpdir(), 'task-agent-ownership');
const safeRef = (ref: string) => /^[1-9][0-9]*$/.test(ref);

export function publicKeyFingerprint(publicKey: string): string {
  const der = Buffer.from(publicKey, 'base64url');
  const parsed = createPublicKey({ key: der, type: 'spki', format: 'der' });
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('Task ownership key must be Ed25519.');
  return createHash('sha256').update(der).digest('hex');
}

export async function generateTaskAgentKey(taskRef: string): Promise<TaskAgentKey> {
  if (!safeRef(taskRef)) throw new Error('Task ref must be positive decimal digits.');
  const dir = join(TASK_AGENT_KEY_ROOT, `task-${taskRef}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const privateKeyPath = join(dir, 'private-key.pem');
  const temporaryPath = join(dir, `.private-key-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, privateKey, { mode: 0o600, flag: 'wx' });
  await chmod(temporaryPath, 0o600);
  try {
    await link(temporaryPath, privateKeyPath);
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    return loadTaskAgentKey(taskRef);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const encodedPublicKey = publicKey.toString('base64url');
  return { taskRef, publicKey: encodedPublicKey, fingerprint: publicKeyFingerprint(encodedPublicKey), privateKeyPath };
}

export async function loadTaskAgentKey(taskRef: string): Promise<TaskAgentKey> {
  if (!safeRef(taskRef)) throw new Error('Task ref must be positive decimal digits.');
  const privateKeyPath = join(TASK_AGENT_KEY_ROOT, `task-${taskRef}`, 'private-key.pem');
  const privateKey = await readFile(privateKeyPath, 'utf8');
  // The public key is deliberately derived, never stored in workspace or sent by this module.
  const publicKey = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64url');
  return { taskRef, publicKey, fingerprint: publicKeyFingerprint(publicKey), privateKeyPath };
}

export async function ensureTaskAgentKey(taskRef: string): Promise<TaskAgentKey> {
  try {
    return await loadTaskAgentKey(taskRef);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    return generateTaskAgentKey(taskRef);
  }
}