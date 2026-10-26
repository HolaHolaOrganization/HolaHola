import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordinationCredentialCache, CoordinationCredentialCacheEntry } from './coordination-actor-client';

/**
 * Cross-invocation credential cache for the standalone coordination CLI.
 *
 * coordination-cli.ts runs as a brand-new OS process per command. Without
 * this, CoordinationActorClient's exchanged access token -- kept in memory
 * only -- dies with that process, and the runtime's bootstrap token (already
 * consumed forever on the first exchange) can never produce a second one.
 * This cache lets a second, third, ... CLI invocation in the same container
 * reuse the still-valid access token the first invocation obtained, instead
 * of stranding the runtime until an operator manually reissues a bootstrap.
 *
 * Scope: wired into coordination-cli.ts only (see that file). The main
 * server's own long-running CoordinationActorClient instances never pass a
 * credentialCache option and keep their existing memory-only behavior.
 */

const CACHE_ROOT_ENV = 'COORDINATION_CLI_CREDENTIAL_CACHE_DIR';

export const DEFAULT_COORDINATION_CLI_CREDENTIAL_CACHE_ROOT = join(
  tmpdir(),
  'holahola-coordination-cli-credentials',
);

function defaultCacheRoot(): string {
  const override = process.env[CACHE_ROOT_ENV]?.trim();
  return override || DEFAULT_COORDINATION_CLI_CREDENTIAL_CACHE_ROOT;
}

function cacheFileName(actor: string, runtimeId: string): string {
  // Hash rather than sanitize-and-join: runtimeId is operator-supplied via an
  // environment variable and must never be interpreted as a path fragment
  // (traversal, separators, length limits). The actor+runtimeId pair is also
  // re-verified against the file's own contents on load (see load() below),
  // so even a hash collision could not by itself hand back the wrong actor's
  // or runtime's credential.
  return `${createHash('sha256').update(`${actor}\u0000${runtimeId}`).digest('hex')}.json`;
}

export class FileCoordinationCliCredentialCache implements CoordinationCredentialCache {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? defaultCacheRoot();
  }

  private path(actor: string, runtimeId: string): string {
    return join(this.root, cacheFileName(actor, runtimeId));
  }

  async load(actor: string, runtimeId: string): Promise<CoordinationCredentialCacheEntry | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(actor, runtimeId), 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // A corrupt cache file is treated as absent, never trusted.
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as Record<string, unknown>).actor !== actor
      || (parsed as Record<string, unknown>).runtimeId !== runtimeId
      || typeof (parsed as Record<string, unknown>).accessToken !== 'string'
      || typeof (parsed as Record<string, unknown>).expiresAt !== 'string'
    ) {
      // Defense in depth alongside the hashed filename: never hand back a
      // credential whose embedded identity does not match the caller's own
      // actor + runtimeId, even if the wrong file were somehow read.
      return null;
    }
    return parsed as CoordinationCredentialCacheEntry;
  }

  async save(entry: CoordinationCredentialCacheEntry): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    const finalPath = this.path(entry.actor, entry.runtimeId);
    const temporaryPath = join(this.root, `.${cacheFileName(entry.actor, entry.runtimeId)}-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(entry), { mode: 0o600 });
    try {
      await rename(temporaryPath, finalPath); // Atomic replace on the same filesystem.
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async clear(actor: string, runtimeId: string): Promise<void> {
    await unlink(this.path(actor, runtimeId)).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * Native platform credential cache bridging Windows DPAPI, macOS Keychain,
 * or Linux Secret Service directly into the CoordinationCredentialCache interface.
 * Selected explicitly via --transport native-onboarding.
 * Zero plaintext token files, zero shell arguments, automatic renewal on expiry.
 */
export class NativeStoreCoordinationCredentialCache implements CoordinationCredentialCache {
  private readonly endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = (endpoint || process.env.COORDINATION_API_URL || 'https://getholahola.com').replace(/\/+$/, '');
  }

  async load(actor: string, runtimeId: string): Promise<CoordinationCredentialCacheEntry | null> {
    try {
      const { createNativeRuntimeOnboardingStore } = await import('./runtime-onboarding-store');
      const store = createNativeRuntimeOnboardingStore();
      const { RuntimeOnboardingClient } = await import('./runtime-onboarding-client');
      const client = new RuntimeOnboardingClient({
        endpoint: this.endpoint,
        actor,
        runtimeId,
        store,
      });
      const cred = await client.getValidCredential();
      if (
        cred
        && cred.actor === actor
        && cred.runtimeId === runtimeId
        && typeof cred.accessToken === 'string'
        && typeof cred.expiresAt === 'string'
      ) {
        return {
          actor: cred.actor as any,
          runtimeId: cred.runtimeId,
          accessToken: cred.accessToken,
          expiresAt: cred.expiresAt,
        };
      }
      return null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'onboarding_credential_unavailable_run_setup') {
        return null;
      }
      const safeDiagnostic = sanitizeNativeStoreDiagnostic(error);
      throw new Error(`native_store_credential_unavailable: ${safeDiagnostic}`);
    }
  }

  async save(entry: CoordinationCredentialCacheEntry): Promise<void> {
    try {
      const { createNativeRuntimeOnboardingStore } = await import('./runtime-onboarding-store');
      const store = createNativeRuntimeOnboardingStore();
      const scope = { endpoint: this.endpoint, actor: entry.actor, runtimeId: entry.runtimeId };
      const raw = await store.get(scope, 'access-credential');
      if (raw) {
        const existing = JSON.parse(raw);
        existing.accessToken = entry.accessToken;
        existing.expiresAt = entry.expiresAt;
        await store.set(scope, 'access-credential', JSON.stringify(existing));
      }
    } catch (error) {
      const safeDiagnostic = sanitizeNativeStoreDiagnostic(error);
      throw new Error(`native_store_save_failed: ${safeDiagnostic}`);
    }
  }

  async clear(actor: string, runtimeId: string): Promise<void> {
    try {
      const { createNativeRuntimeOnboardingStore } = await import('./runtime-onboarding-store');
      const store = createNativeRuntimeOnboardingStore();
      const scope = { endpoint: this.endpoint, actor, runtimeId };
      await store.delete(scope, 'access-credential');
    } catch (error) {
      const safeDiagnostic = sanitizeNativeStoreDiagnostic(error);
      throw new Error(`native_store_clear_failed: ${safeDiagnostic}`);
    }
  }
}

export const SAFE_NATIVE_STORE_ERROR_CODES = new Set([
  'keystore_unavailable',
  'keyring_locked',
  'storage_corrupted',
  'storage_unavailable',
  'access_denied',
]);

export function sanitizeNativeStoreDiagnostic(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (SAFE_NATIVE_STORE_ERROR_CODES.has(msg)) {
    return msg;
  }
  return 'secure_storage_operation_failed';
}

