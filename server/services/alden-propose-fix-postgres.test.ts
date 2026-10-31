/**
 * propose_fix's real SQL path against the CI job's disposable PostgreSQL
 * (migration 0074 applied): a pinned high-confidence row and a
 * description-only row satisfy the constraints, a failed notice is retried
 * by retryProposalNotices and delivered once. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alden-propose-fix-pg-'));
fs.mkdirSync(path.join(root, 'server'), { recursive: true });
fs.writeFileSync(path.join(root, 'server', 'x.ts'), 'const a = 1;\nconst b = 2;\n');
const ids: string[] = [];

after(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  if (!getVerifiedCiDatabaseUrl()) return;
  const { getUserDb, closeDbConnections } = await import('../db');
  const { buildQueue } = await import('@shared/schema');
  const { inArray } = await import('drizzle-orm');
  if (ids.length) await getUserDb().delete(buildQueue).where(inArray(buildQueue.id, ids));
  await closeDbConnections();
});

test('propose_fix stores constraint-valid rows and retries a failed notice once', async (context) => {
  if (!getVerifiedCiDatabaseUrl()) {
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const { proposeFix, retryProposalNotices } = await import('./alden-propose-fix-service');
  const { getUserDb } = await import('../db');
  const { buildQueue } = await import('@shared/schema');
  const { eq } = await import('drizzle-orm');
  const db = getUserDb();
  const pinSource = () => ({
    kind: 'release' as const,
    commit: 'c'.repeat(40),
    sourceDigest: 'd'.repeat(64),
    read: (rel: string) => ({ bytes: fs.readFileSync(path.join(root, rel)) }),
  });
  const args = { rationale: 'pg test', evidence: 'synthetic', verify: 'synthetic' };

  const high = await proposeFix({ ...args, confidence: 'high', edits: [{ path: 'server/x.ts', find: 'const b = 2;', replace: 'const b = 3;' }] }, {
    root, pinSource, notify: async () => { throw new Error('post failed'); },
  });
  ids.push(high.row.id);
  assert.equal(high.row.pinKind, 'release');
  assert.equal(high.row.notifyState, 'failed');

  const low = await proposeFix({ ...args, confidence: 'low', edits: [{ path: 'server/x.ts', find: 'a', replace: 'b' }] }, {
    root, pinSource, notify: async () => {},
  });
  ids.push(low.row.id);
  assert.equal(low.row.pinKind, null);
  assert.equal(low.row.notifyState, 'delivered');

  const delivered: string[] = [];
  await retryProposalNotices({ notify: async (row) => { if (ids.includes(row.id)) delivered.push(row.id); else throw new Error('not ours'); } });
  assert.deepEqual(delivered, [high.row.id], 'only the failed one is retried, once');
  const [after1] = await db.select().from(buildQueue).where(eq(buildQueue.id, high.row.id));
  assert.equal(after1.notifyState, 'delivered');
  assert.equal(after1.notifyAttempts, 2);
  await retryProposalNotices({ notify: async (row) => { if (ids.includes(row.id)) delivered.push(row.id); else throw new Error('not ours'); } });
  assert.deepEqual(delivered, [high.row.id], 'a delivered notice is not sent again');
});
