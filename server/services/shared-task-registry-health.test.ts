import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSharedTaskRegistryHealth } from './shared-task-registry-health';

function reader(options: { count?: number; ready?: boolean; badDigest?: boolean; mismatches?: number } = {}) {
  return async (statement: string, params?: unknown[]) => {
    assert.match(statement, /^SELECT\b/, 'health checks never issue mutations');
    if (statement.includes('to_regclass')) return {
      rows: (params![0] as string[]).map((name, i) => ({ name, present: i < (options.count ?? 7) })),
    };
    if (statement.includes('SELECT ready')) return { rows: [{ ready: options.ready ?? true }] };
    if (statement.includes('task_ref IN')) return {
      rows: ['1000001', '1000002'].map(task_ref => ({
        task_ref, artifact_base64: Buffer.from(task_ref).toString('base64'),
        artifact_sha256: options.badDigest ? 'f'.repeat(64) : createHash('sha256').update(task_ref).digest('hex'),
        expected_sha: createHash('sha256').update(task_ref).digest('hex'),
      })),
    };
    return { rows: [{ mismatches: options.mismatches ?? 0 }] };
  };
}
test('registry health distinguishes source-only absence, partial rollout and closed readiness', async () => {
  assert.equal((await readSharedTaskRegistryHealth(reader({ count: 0 }))).status, 'warn');
  assert.equal((await readSharedTaskRegistryHealth(reader({ count: 6 }))).status, 'fail');
  assert.equal((await readSharedTaskRegistryHealth(reader({ ready: false }))).status, 'fail');
});
test('registry health fails closed on bootstrap or frozen-projection disagreement', async () => {
  assert.equal((await readSharedTaskRegistryHealth(reader({ badDigest: true }))).status, 'fail');
  assert.equal((await readSharedTaskRegistryHealth(reader({ mismatches: 1 }))).status, 'fail');
  assert.equal((await readSharedTaskRegistryHealth(reader())).status, 'pass');
});
