import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateLegacyListenerScope, assertRuntimeScope } from './coordination-listener-scope-migration';
import { withOwnershipGuard } from './coordination-listener-ownership';

async function fixture(run: (config: { stateDir: string; actor: string; apiUrl: string; runtimeId: string },
  approval: { expectedScopeSha256: string; operator: string; reason: string }) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'listener-migration-'));
  const config = { stateDir, actor: 'luca-replit', apiUrl: 'https://example.invalid', runtimeId: 'synthetic-runtime' };
  const original = '{ "actor": "luca-replit", "apiUrl": "https://example.invalid" }\n';
  await mkdir(join(stateDir, 'pending'));
  await writeFile(join(stateDir, 'scope.json'), original);
  await writeFile(join(stateDir, 'cursor.json'), '{"after":42}\n');
  await writeFile(join(stateDir, 'pending/00000000-0000-4000-8000-000000000001.json'), '{"synthetic":true}\n');
  try {
    await run(config, {
      expectedScopeSha256: createHash('sha256').update(original).digest('hex'),
      operator: 'synthetic-operator', reason: 'isolated test only',
    });
  } finally { await rm(stateDir, { recursive: true, force: true }); }
}

test('explicit migration preserves exact checkpoint and pending bytes with prepared audit',
  { skip: process.platform !== 'linux' ? 'Replit/Linux migration uses directory fsync' : false }, async () => {
  await fixture(async (config, approval) => {
    await assert.rejects(() => assertRuntimeScope(config), /runtime_scope_mismatch/);
    const scopeBefore = await readFile(join(config.stateDir, 'scope.json'));
    const pending = 'pending/00000000-0000-4000-8000-000000000001.json';
    const before = await readFile(join(config.stateDir, pending));
    const receipt = await migrateLegacyListenerScope(config, approval);
    await assertRuntimeScope(config);
    assert.equal(await readFile(join(config.stateDir, 'cursor.json'), 'utf8'), '{"after":42}\n');
    assert.deepEqual(await readFile(join(config.stateDir, pending)), before);
    const audit = JSON.parse(await readFile(receipt.auditPath, 'utf8'));
    assert.equal(audit.state, 'prepared');
    assert.deepEqual(Buffer.from(audit.originalScopeBase64, 'base64'), scopeBefore);
    await assert.rejects(() => migrateLegacyListenerScope(config, approval), /scope_changed/);
  });
});

test('wrong digest, existing runtime, wrong identities, malformed state and owner locks refuse', async () => {
  for (const variant of ['digest', 'runtime', 'actor', 'api', 'malformed', 'watch.lock', 'boot/supervisor.lock']) {
    await fixture(async (config, approval) => {
      if (variant === 'digest') approval.expectedScopeSha256 = '0'.repeat(64);
      else if (['runtime', 'actor', 'api', 'malformed'].includes(variant)) {
        const value = variant === 'malformed' ? '{broken' : JSON.stringify({
          actor: variant === 'actor' ? 'other' : config.actor,
          apiUrl: variant === 'api' ? 'https://other.invalid' : config.apiUrl,
          ...(variant === 'runtime' ? { runtimeId: 'wrong' } : {}),
        });
        await writeFile(join(config.stateDir, 'scope.json'), value);
        approval.expectedScopeSha256 = createHash('sha256').update(value).digest('hex');
      } else {
        await mkdir(join(config.stateDir, 'boot'), { recursive: true });
        await writeFile(join(config.stateDir, variant), '{}');
      }
      const before = await readFile(join(config.stateDir, 'scope.json'));
      await assert.rejects(() => migrateLegacyListenerScope(config, approval));
      assert.deepEqual(await readFile(join(config.stateDir, 'scope.json')), before);
      assert.equal((await readdir(config.stateDir)).filter(n => n.startsWith('scope-migration-')).length, 0);
    });
  }
});

test('competing ownership guard blocks migration without touching scope', async () => {
  await fixture(async (config, approval) => {
    await withOwnershipGuard(config.stateDir, config, async () => {
      await assert.rejects(() => migrateLegacyListenerScope(config, approval), /guard_present/);
    });
    await assert.rejects(() => assertRuntimeScope(config), /runtime_scope_mismatch/);
  });
});

test('competing supervisor namespace guard also blocks the migration', async () => {
  await fixture(async (config, approval) => {
    const boot = join(config.stateDir, 'boot');
    await mkdir(boot);
    await withOwnershipGuard(boot, config, async () => {
      await assert.rejects(() => migrateLegacyListenerScope(config, approval), /guard_present/);
    });
    await assert.rejects(() => assertRuntimeScope(config), /runtime_scope_mismatch/);
  });
});
