/**
 * update_support_pattern's SQL path against the CI job's disposable
 * PostgreSQL: inside a triage task it sets open/investigating on its own
 * pattern only and appends timestamped notes, never replacing them; another
 * pattern is untouched. Synthetic rows only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { getVerifiedCiDatabaseUrl } from '../ci-database';

const ids: string[] = [];
after(async () => {
  if (!getVerifiedCiDatabaseUrl()) return;
  const { getSharedDb } = await import('../neon-db');
  const { closeDbConnections } = await import('../db');
  const { supportPatterns } = await import('@shared/schema');
  const { inArray } = await import('drizzle-orm');
  if (ids.length) await getSharedDb().delete(supportPatterns).where(inArray(supportPatterns.id, ids));
  await closeDbConnections();
});

test('update_support_pattern appends notes on its own pattern only', async (context) => {
  if (!getVerifiedCiDatabaseUrl()) {
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const { getSharedDb } = await import('../neon-db');
  const { supportPatterns } = await import('@shared/schema');
  const { eq } = await import('drizzle-orm');
  const { executeAldenTool } = await import('./alden-functions');
  const { triageAllowlist } = await import('./alden-tool-profiles');
  const db = getSharedDb();
  const [mine, other] = [randomUUID(), randomUUID()];
  ids.push(mine, other);
  for (const id of [mine, other]) {
    await db.insert(supportPatterns).values({ id, patternType: 'no_audio', description: `profiles pg test ${id}`, status: 'open', developerNotes: 'earlier note' } as any);
  }

  const list = triageAllowlist(mine);
  const first = await executeAldenTool('update_support_pattern', { pattern_id: mine, status: 'investigating', notes: 'checked the hook' }, { toolAllowlist: list });
  assert.equal(first.data.updated, true, JSON.stringify(first.data));
  const second = await executeAldenTool('update_support_pattern', { pattern_id: mine, status: 'open', notes: 'needs a human' }, { toolAllowlist: list });
  assert.equal(second.data.updated, true);
  const refused = await executeAldenTool('update_support_pattern', { pattern_id: other, status: 'investigating', notes: 'not mine' }, { toolAllowlist: list });
  assert.equal(refused.data.refused, 'tool_binding_mismatch');

  const [row] = await db.select().from(supportPatterns).where(eq(supportPatterns.id, mine));
  assert.equal(row.status, 'open');
  const lines = String(row.developerNotes).split('\n');
  assert.equal(lines[0], 'earlier note');
  assert.match(lines[1], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] Alden: checked the hook$/);
  assert.match(lines[2], /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] Alden: needs a human$/);
  const [untouched] = await db.select().from(supportPatterns).where(eq(supportPatterns.id, other));
  assert.equal(untouched.status, 'open');
  assert.equal(untouched.developerNotes, 'earlier note');
});

test('a stale triage task cannot reopen a fixed, wont_fix or known_benign pattern', async (context) => {
  if (!getVerifiedCiDatabaseUrl()) {
    context.skip('requires CI=true and matching job-local CI_DATABASE_URL / NEON_SHARED_DATABASE_URL');
    return;
  }
  const { getSharedDb } = await import('../neon-db');
  const { supportPatterns } = await import('@shared/schema');
  const { eq } = await import('drizzle-orm');
  const { executeAldenTool } = await import('./alden-functions');
  const { triageAllowlist } = await import('./alden-tool-profiles');
  const db = getSharedDb();
  for (const status of ['fixed', 'wont_fix', 'known_benign']) {
    const id = randomUUID();
    ids.push(id);
    await db.insert(supportPatterns).values({ id, patternType: 'no_audio', description: `profiles pg terminal ${status}`, status, developerNotes: 'decided earlier' } as any);
    for (const next of ['open', 'investigating']) {
      const result = await executeAldenTool('update_support_pattern', { pattern_id: id, status: next, notes: 'stale task note' }, { toolAllowlist: triageAllowlist(id) });
      assert.equal(result.data.refused, 'pattern_not_editable', `${status} -> ${next}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.status, status);
    }
    const [row] = await db.select().from(supportPatterns).where(eq(supportPatterns.id, id));
    assert.equal(row.status, status, 'the decided status is unchanged');
    assert.equal(row.developerNotes, 'decided earlier', 'no stale note was appended');
  }
});
