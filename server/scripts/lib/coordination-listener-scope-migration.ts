import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeScope } from './coordination-listener';
import { withOwnershipGuard } from './coordination-listener-ownership';

type Config = { stateDir: string; actor: string; apiUrl: string; runtimeId: string };
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function regularBytes(path: string) {
  if (!(await lstat(path)).isFile()) throw new Error('migration_nonregular_state');
  return readFile(path);
}

export async function assertRuntimeScope(config: Config) {
  const scope = JSON.parse((await regularBytes(join(config.stateDir, 'scope.json'))).toString('utf8'));
  if (scope.actor !== config.actor || scope.apiUrl !== normalizeScope(config).apiUrl ||
      scope.runtimeId !== config.runtimeId) throw new Error('boot_runtime_scope_mismatch');
}

async function assertStopped(config: Config) {
  // Deliberately refuse even a stale lock. Recovery is a separate audited action.
  for (const name of ['watch.lock', 'boot/supervisor.lock']) {
    try { await lstat(join(config.stateDir, name)); }
    catch (e) { if (absent(e)) continue; throw e; }
    throw new Error('migration_owner_lock_present');
  }
}

async function checkpointManifest(config: Config) {
  const names = ['cursor.json'];
  const pending = join(config.stateDir, 'pending');
  if (!(await lstat(pending)).isDirectory()) throw new Error('migration_nonregular_pending');
  for (const name of (await readdir(pending)).sort()) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('migration_unknown_pending_entry');
    names.push(`pending/${name}`);
  }
  const manifest: Record<string, string> = {};
  for (const name of names) manifest[name] = hash(await regularBytes(join(config.stateDir, name)));
  const cursor = JSON.parse((await regularBytes(join(config.stateDir, 'cursor.json'))).toString('utf8'));
  if (!Number.isSafeInteger(cursor.after) || cursor.after < 0) throw new Error('migration_invalid_cursor');
  return manifest;
}

async function exclusiveWrite(path: string, bytes: string) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Candidate operator-only migration; never called by launch or normal boot.
 * All state participants must honor the existing ownership guard.
 */
export async function migrateLegacyListenerScope(
  config: Config,
  approval: { expectedScopeSha256: string; operator: string; reason: string },
) {
  if (!/^[a-f0-9]{64}$/.test(approval.expectedScopeSha256) ||
      !approval.operator.trim() || !approval.reason.trim() || !config.runtimeId.trim()) {
    throw new Error('migration_explicit_approval_required');
  }
  const normalized = normalizeScope(config);
  const bootDirectory = join(config.stateDir, 'boot');
  await mkdir(bootDirectory, { recursive: true, mode: 0o700 });
  return withOwnershipGuard(config.stateDir, normalized, async () => {
    // Supervisor acquisition uses the boot namespace, listener acquisition the
    // root namespace. Hold BOTH so neither can start during the commit window.
    return withOwnershipGuard(bootDirectory, normalized, async () => {
    await assertStopped(config);
    const path = join(config.stateDir, 'scope.json');
    const original = await regularBytes(path);
    if (hash(original) !== approval.expectedScopeSha256) throw new Error('migration_scope_changed');
    const scope = JSON.parse(original.toString('utf8'));
    if (scope.actor !== normalized.actor || scope.apiUrl !== normalized.apiUrl ||
        Object.hasOwn(scope, 'runtimeId') || Object.keys(scope).some(k => !['actor', 'apiUrl'].includes(k))) {
      throw new Error('migration_not_expected_legacy_scope');
    }
    const manifest = await checkpointManifest(config);
    const replacement = JSON.stringify({ ...scope, runtimeId: config.runtimeId });
    const auditPath = join(config.stateDir, `scope-migration-${randomUUID()}.json`);
    // Exact original bytes are recoverable; this is a prepared audit, NOT a success receipt.
    await exclusiveWrite(auditPath, JSON.stringify({
      state: 'prepared', operator: approval.operator, reason: approval.reason,
      at: new Date().toISOString(), originalScopeBase64: original.toString('base64'),
      originalScopeSha256: hash(original), replacementScopeSha256: hash(replacement), manifest,
    }));
    await syncDirectory(config.stateDir);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await exclusiveWrite(temporary, replacement);
      await assertStopped(config);
      if (!(await regularBytes(path)).equals(original) ||
          JSON.stringify(await checkpointManifest(config)) !== JSON.stringify(manifest)) {
        throw new Error('migration_state_changed');
      }
      await rename(temporary, path);
      await syncDirectory(config.stateDir);
      await assertRuntimeScope(config);
      if (JSON.stringify(await checkpointManifest(config)) !== JSON.stringify(manifest)) {
        throw new Error('migration_postcondition_failed');
      }
      return { auditPath, scopeSha256: hash(replacement), checkpointPreserved: true };
    } finally {
      await unlink(temporary).catch(e => { if (!absent(e)) throw e; });
    }
    });
  });
}
