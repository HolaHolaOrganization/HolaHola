import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { FileCoordinationCliCredentialCache, NativeStoreCoordinationCredentialCache } from './coordination-cli-credential-cache';
import { type CoordinationCredentialCacheEntry, createCoordinationActorClient } from './coordination-actor-client';
import { resolveCoordinationTransport } from '../scripts/coordination-cli';

async function withTempCacheDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'coordination-cli-cred-cache-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function entry(overrides: Partial<CoordinationCredentialCacheEntry> = {}): CoordinationCredentialCacheEntry {
  return {
    actor: 'luca-claude-code',
    runtimeId: 'luca-claude-code-test-runtime',
    accessToken: 'ct_test-token',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

function fileNameFor(actor: string, runtimeId: string): string {
  return `${createHash('sha256').update(`${actor}\u0000${runtimeId}`).digest('hex')}.json`;
}

test('FileCoordinationCliCredentialCache round-trips a saved credential for the same actor + runtimeId', async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const saved = entry();
    await cache.save(saved);
    const loaded = await cache.load(saved.actor, saved.runtimeId);
    assert.deepEqual(loaded, saved);
  });
});

test('FileCoordinationCliCredentialCache returns null when nothing has been saved yet', async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const loaded = await cache.load('luca-claude-code', 'never-saved-runtime');
    assert.equal(loaded, null);
  });
});

test("FileCoordinationCliCredentialCache never returns another actor's or runtime's credential", async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    await cache.save(entry({ actor: 'luca-claude-code', runtimeId: 'runtime-a', accessToken: 'ct_a' }));
    await cache.save(entry({ actor: 'luca-replit', runtimeId: 'runtime-b', accessToken: 'ct_b' }));

    assert.equal(await cache.load('luca-replit', 'runtime-a'), null);
    assert.equal(await cache.load('luca-claude-code', 'runtime-b'), null);
    assert.equal((await cache.load('luca-claude-code', 'runtime-a'))?.accessToken, 'ct_a');
    assert.equal((await cache.load('luca-replit', 'runtime-b'))?.accessToken, 'ct_b');
  });
});

test('FileCoordinationCliCredentialCache treats a corrupt cache file as absent, never throwing', async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const saved = entry();
    await cache.save(saved); // creates the directory and a valid file first
    // Overwrite it with garbage, simulating a truncated write or manual edit.
    await writeFile(join(dir, fileNameFor(saved.actor, saved.runtimeId)), '{not valid json');
    const loaded = await cache.load(saved.actor, saved.runtimeId);
    assert.equal(loaded, null);
  });
});

test("FileCoordinationCliCredentialCache treats a file whose own contents mismatch the requested identity as absent", async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const saved = entry({ actor: 'luca-claude-code', runtimeId: 'runtime-mismatch' });
    await cache.save(saved);
    // Simulate a hash collision or misrouted file: the file's own JSON claims
    // a different runtimeId than the hashed filename implies. The defense in
    // depth check inside load() must still refuse it.
    await writeFile(
      join(dir, fileNameFor(saved.actor, saved.runtimeId)),
      JSON.stringify({ ...saved, runtimeId: 'someone-elses-runtime' }),
    );
    const loaded = await cache.load(saved.actor, saved.runtimeId);
    assert.equal(loaded, null);
  });
});

test('FileCoordinationCliCredentialCache overwrites an existing entry on renewal (save is idempotent, not write-once)', async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const first = entry({ accessToken: 'ct_first' });
    await cache.save(first);
    const renewed = entry({ accessToken: 'ct_renewed', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    await cache.save(renewed);
    const loaded = await cache.load(renewed.actor, renewed.runtimeId);
    assert.deepEqual(loaded, renewed);
  });
});

test('FileCoordinationCliCredentialCache clear() removes a saved entry and is a no-op when nothing exists', async () => {
  await withTempCacheDir(async (dir) => {
    const cache = new FileCoordinationCliCredentialCache(dir);
    const saved = entry();
    await cache.save(saved);
    await cache.clear(saved.actor, saved.runtimeId);
    assert.equal(await cache.load(saved.actor, saved.runtimeId), null);
    await assert.doesNotReject(() => cache.clear(saved.actor, saved.runtimeId));
  });
});

if (platform() !== 'win32') {
  test('FileCoordinationCliCredentialCache writes the credential file with owner-only permissions', async () => {
    await withTempCacheDir(async (dir) => {
      const cache = new FileCoordinationCliCredentialCache(dir);
      const saved = entry();
      await cache.save(saved);
      const stats = await stat(join(dir, fileNameFor(saved.actor, saved.runtimeId)));
      assert.equal(stats.mode & 0o777, 0o600);
    });
  });
}

test('NativeStoreCoordinationCredentialCache returns null for an unenrolled identity without throwing', async () => {
  const {
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  } = await import('./runtime-onboarding-store');
  const storeClasses = [
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  ];
  const origGets = new Map(storeClasses.map((cls) => [cls, cls.prototype.get]));
  try {
    for (const cls of storeClasses) {
      cls.prototype.get = async () => null; // Absent entry in secure storage
    }
    const cache = new NativeStoreCoordinationCredentialCache('https://example.com');
    const loaded = await cache.load('luca-claude-code', 'nonexistent-runtime-id');
    assert.equal(loaded, null);
  } finally {
    for (const cls of storeClasses) {
      cls.prototype.get = origGets.get(cls)!;
    }
  }
});

test('NativeStoreCoordinationCredentialCache requires an explicit endpoint or COORDINATION_API_URL', () => {
  const prev = process.env.COORDINATION_API_URL;
  try {
    delete process.env.COORDINATION_API_URL;
    assert.throws(
      () => new NativeStoreCoordinationCredentialCache(''),
      /requires an explicit endpoint or COORDINATION_API_URL/,
    );
  } finally {
    if (prev !== undefined) process.env.COORDINATION_API_URL = prev;
  }
});

test('NativeStoreCoordinationCredentialCache clear is safe for absent identity', async () => {
  const {
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  } = await import('./runtime-onboarding-store');
  const storeClasses = [
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  ];
  const origDeletes = new Map(storeClasses.map((cls) => [cls, cls.prototype.delete]));
  try {
    for (const cls of storeClasses) {
      cls.prototype.delete = async () => {}; // Deletion of absent entry is a no-op
    }
    const cache = new NativeStoreCoordinationCredentialCache('https://example.com');
    await assert.doesNotReject(() => cache.clear('luca-claude-code', 'nonexistent-runtime-id'));
  } finally {
    for (const cls of storeClasses) {
      cls.prototype.delete = origDeletes.get(cls)!;
    }
  }
});


test('resolveCoordinationTransport rejects unsupported transports and resolves defaults', () => {
  assert.throws(() => resolveCoordinationTransport('unsupported-transport'), /unsupported_transport/);
  assert.deepEqual(resolveCoordinationTransport(undefined), { transport: 'file', isNative: false });
  assert.deepEqual(resolveCoordinationTransport('default'), { transport: 'file', isNative: false });
  assert.deepEqual(resolveCoordinationTransport('file'), { transport: 'file', isNative: false });
  assert.deepEqual(resolveCoordinationTransport('native-onboarding'), { transport: 'native-onboarding', isNative: true });
});

test('CoordinationActorClient with exclusiveCredentialCache ignores ambient tokens and refuses bootstrap fallback', async () => {
  const dummyCache = {
    async load() { return null; },
    async save() {},
  };
  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://example.com',
    credentialCache: dummyCache,
    exclusiveCredentialCache: true,
    environment: {
      COORDINATION_LUCA_REPLIT_TOKEN: 'r'.repeat(40),
      COORDINATION_RUNTIME_BOOTSTRAP_TOKEN: `cb_${'r'.repeat(43)}`,
      COORDINATION_RUNTIME_ID: 'test-runtime-id',
    },
  });

  // Calling any authenticated action should refuse fallback to ambient or bootstrap tokens
  await assert.rejects(
    () => client.listFeed(),
    /Coordination native credential unavailable for luca-replit.*refusing fallback/,
  );
});

test('CoordinationActorClient with exclusiveCredentialCache refreshes near-expiry credentials via load() and never calls /credentials/renew or save()', async () => {
  let loadCalls = 0;
  let saveCalls = 0;
  const requestedPaths: string[] = [];
  const usedTokens: string[] = [];

  const nearExpiryIso = new Date(Date.now() + 30_000).toISOString(); // < 60s remaining
  const refreshedIso = new Date(Date.now() + 600_000).toISOString(); // 10m remaining

  const exclusiveCache = {
    async load(actor: any, runtimeId: string) {
      loadCalls += 1;
      if (loadCalls === 1) {
        return {
          actor,
          runtimeId,
          accessToken: 'ct_near_expiry_token_1',
          expiresAt: nearExpiryIso,
        };
      }
      return {
        actor,
        runtimeId,
        accessToken: 'ct_refreshed_via_onboarding_client_2',
        expiresAt: refreshedIso,
      };
    },
    async save() {
      saveCalls += 1;
    },
  };

  const client = createCoordinationActorClient('luca-replit', {
    apiUrl: 'https://example.com',
    credentialCache: exclusiveCache,
    exclusiveCredentialCache: true,
    environment: {
      COORDINATION_RUNTIME_ID: 'test-runtime-id',
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      const headers = new Headers(init?.headers);
      usedTokens.push(headers.get('x-coordination-token') ?? '');
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  // 1st call loads near-expiry token (loadCalls = 1) and uses it
  await client.listFeed();
  assert.equal(loadCalls, 1);
  assert.equal(usedTokens[0], 'ct_near_expiry_token_1');

  // 2nd call sees <60s remaining on the cached credential, refreshes via credentialCache.load()
  // (never calling /api/coordination/credentials/renew directly), and uses the refreshed token
  await client.listFeed();
  assert.equal(loadCalls, 2);
  assert.equal(usedTokens[1], 'ct_refreshed_via_onboarding_client_2');

  // 3rd call reuses the refreshed token (which has 10m remaining) without calling load() again
  await client.listFeed();
  assert.equal(loadCalls, 2);
  assert.equal(usedTokens[2], 'ct_refreshed_via_onboarding_client_2');

  assert.equal(saveCalls, 0, 'exclusive mode must never call credentialCache.save()');
  assert.equal(
    requestedPaths.some((p) => p.includes('/credentials/renew')),
    false,
    'exclusive mode must never call /api/coordination/credentials/renew directly',
  );
});

test('NativeStoreCoordinationCredentialCache canary non-disclosure and error sanitization', async () => {
  const cache = new NativeStoreCoordinationCredentialCache('https://example.com');
  const canarySecret = 'secret-canary-not-real-do-not-leak';

  const { RuntimeOnboardingClient } = await import('./runtime-onboarding-client');
  const {
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  } = await import('./runtime-onboarding-store');
  const { sanitizeNativeStoreDiagnostic, SAFE_NATIVE_STORE_ERROR_CODES } = await import('./coordination-cli-credential-cache');

  // Negative control verification: ensure that canary detection is sensitive to leaks
  const syntheticLeakedMessage = `failure occurred: ${canarySecret}`;
  assert.strictEqual(syntheticLeakedMessage.includes(canarySecret), true);

  // Directly verify sanitizeNativeStoreDiagnostic sanitization
  assert.strictEqual(
    sanitizeNativeStoreDiagnostic(new Error(`store error with ${canarySecret}`)),
    'secure_storage_operation_failed',
  );
  assert.strictEqual(
    sanitizeNativeStoreDiagnostic(canarySecret),
    'secure_storage_operation_failed',
  );
  for (const code of SAFE_NATIVE_STORE_ERROR_CODES) {
    assert.strictEqual(sanitizeNativeStoreDiagnostic(new Error(code)), code);
  }

  const origGetValid = RuntimeOnboardingClient.prototype.getValidCredential;
  const storeClasses = [
    WindowsDpapiRuntimeOnboardingStore,
    MacOsKeychainRuntimeOnboardingStore,
    LinuxSecretServiceRuntimeOnboardingStore,
  ];
  const origStoreGets = new Map(storeClasses.map((cls) => [cls, cls.prototype.get]));
  const origStoreSets = new Map(storeClasses.map((cls) => [cls, cls.prototype.set]));
  const origStoreDeletes = new Map(storeClasses.map((cls) => [cls, cls.prototype.delete]));

  try {
    // 1. load() non-disclosure and allowlist preservation
    RuntimeOnboardingClient.prototype.getValidCredential = async () => {
      throw new Error(`keystore_failure: ${canarySecret}`);
    };
    let loadCanaryErr: Error | null = null;
    try {
      await cache.load('luca-replit', 'test-runtime');
    } catch (err: any) {
      loadCanaryErr = err;
    }
    assert.ok(loadCanaryErr, 'load() with canary error must reject');
    assert.strictEqual(
      loadCanaryErr.message,
      'native_store_credential_unavailable: secure_storage_operation_failed',
    );
    assert.strictEqual(loadCanaryErr.message.includes(canarySecret), false);

    RuntimeOnboardingClient.prototype.getValidCredential = async () => {
      throw new Error('keyring_locked');
    };
    let loadAllowlistedErr: Error | null = null;
    try {
      await cache.load('luca-replit', 'test-runtime');
    } catch (err: any) {
      loadAllowlistedErr = err;
    }
    assert.ok(loadAllowlistedErr, 'load() with allowlisted code must reject');
    assert.strictEqual(
      loadAllowlistedErr.message,
      'native_store_credential_unavailable: keyring_locked',
    );

    // 2. save() is an intentional no-op that never reads or writes the native store
    let storeTouchedBySave = false;
    for (const cls of storeClasses) {
      cls.prototype.get = async () => {
        storeTouchedBySave = true;
        throw new Error(`store_failure: ${canarySecret}`);
      };
      cls.prototype.set = async () => {
        storeTouchedBySave = true;
        throw new Error(`store_failure: ${canarySecret}`);
      };
    }
    await assert.doesNotReject(() =>
      cache.save({
        actor: 'luca-replit',
        runtimeId: 'test-runtime',
        accessToken: 'ct_test',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    assert.strictEqual(storeTouchedBySave, false, 'NativeStoreCoordinationCredentialCache.save() must not touch native storage');

    // 3. clear() non-disclosure and allowlist preservation
    for (const cls of storeClasses) {
      cls.prototype.delete = async () => {
        throw new Error(`store_failure: ${canarySecret}`);
      };
    }
    let clearCanaryErr: Error | null = null;
    try {
      await cache.clear('luca-replit', 'test-runtime');
    } catch (err: any) {
      clearCanaryErr = err;
    }
    assert.ok(clearCanaryErr, 'clear() with canary error must reject');
    assert.strictEqual(
      clearCanaryErr.message,
      'native_store_clear_failed: secure_storage_operation_failed',
    );
    assert.strictEqual(clearCanaryErr.message.includes(canarySecret), false);

    for (const cls of storeClasses) {
      cls.prototype.delete = async () => {
        throw new Error('storage_corrupted');
      };
    }
    let clearAllowlistedErr: Error | null = null;
    try {
      await cache.clear('luca-replit', 'test-runtime');
    } catch (err: any) {
      clearAllowlistedErr = err;
    }
    assert.ok(clearAllowlistedErr, 'clear() with allowlisted code must reject');
    assert.strictEqual(
      clearAllowlistedErr.message,
      'native_store_clear_failed: storage_corrupted',
    );
  } finally {
    RuntimeOnboardingClient.prototype.getValidCredential = origGetValid;
    for (const cls of storeClasses) {
      cls.prototype.get = origStoreGets.get(cls)!;
      cls.prototype.set = origStoreSets.get(cls)!;
      cls.prototype.delete = origStoreDeletes.get(cls)!;
    }
  }
});




