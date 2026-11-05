// The restore drill (episode-restore-drill.ts) restores the last good backup into an
// empty table and proves the full inventory came back byte for byte, against an
// in-memory bucket and a minimal in-memory table that behaves like the SQL it is sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKUP_PREFIX_DEFAULT, runEpisodeBackup, type BackupStore, type InventoryRow, type StoredObject } from './episode-backup';
import { runRestoreDrill, type RestoreTarget } from './episode-restore-drill';
import { databaseIdentity } from '../scripts/episode-restore-drill';

function memoryStore() {
  const objects = new Map<string, StoredObject>();
  const store: BackupStore & { objects: Map<string, StoredObject> } = {
    objects,
    async get(key) { const o = objects.get(key); return o ? { bytes: Buffer.from(o.bytes), metadata: { ...o.metadata } } : null; },
    async putNew(key, body, metadata) { if (objects.has(key)) throw new Error('exists'); objects.set(key, { bytes: Buffer.from(body), metadata }); },
    async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
  };
  return store;
}

/** A table that understands the drill's four statements, optionally corrupting what it stores. */
function memoryTarget(options: { mangle?: (content: string) => string; preexisting?: number; dropId?: string } = {}) {
  const rows: { id: string; content: string }[] = Array.from({ length: options.preexisting ?? 0 }, (_, i) => ({ id: `old-${i}`, content: 'x' }));
  const target: RestoreTarget & { rows: typeof rows } = {
    rows,
    async query(text, params = []) {
      if (/^create table/.test(text)) return { rows: [] };
      if (/^select count/.test(text)) return { rows: [{ n: rows.length }] };
      if (/^insert into/.test(text)) {
        const [id, , , , , , content] = params as string[];
        if (id !== options.dropId) rows.push({ id, content: options.mangle ? options.mangle(content) : content });
        return { rows: [] };
      }
      if (/^select id, content/.test(text)) return { rows: rows.map((r) => ({ ...r })) };
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return target;
}

const row = (id: string, content: string): InventoryRow => ({ id, arcName: 'HolaHola Episodes', entryType: 'episode', title: id, createdAt: null, recordedAt: null, content });
const rows = [row('ep-1', 'Episode one — ñ 🙂'), row('ep-2', 'Episode two'), row('ep-3', 'Story three')];

async function backedUp() {
  const store = memoryStore();
  await runEpisodeBackup({ store, inventory: async () => rows, now: () => new Date('2026-11-04T20:00:00Z') });
  return store;
}

test('a good backup restores into an empty table and every row comes back byte for byte', async () => {
  const target = memoryTarget();
  const report = await runRestoreDrill({ store: await backedUp(), prefix: BACKUP_PREFIX_DEFAULT, target });
  assert.equal(report.outcome, 'passed');
  assert.deepEqual([report.expectedRows, report.restoredRows, report.failures], [3, 3, []]);
  assert.equal(target.rows.find((r) => r.id === 'ep-1')!.content, 'Episode one — ñ 🙂');
});

test('no backup yet is reported as such, not as a pass', async () => {
  const report = await runRestoreDrill({ store: memoryStore(), prefix: BACKUP_PREFIX_DEFAULT, target: memoryTarget() });
  assert.equal(report.outcome, 'no_backup');
});

test('a missing or altered object fails the drill and names the row', async () => {
  const store = await backedUp();
  const keys = [...store.objects.keys()].filter((k) => k.includes('/objects/'));
  store.objects.delete(keys[0]);
  store.objects.set(keys[1], { bytes: Buffer.from('tampered'), metadata: {} });
  const report = await runRestoreDrill({ store, prefix: BACKUP_PREFIX_DEFAULT, target: memoryTarget() });
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.failures.map((f) => f.kind).sort(), ['object_mismatch', 'object_missing']);
});

test('a row that changes or vanishes on the way into the database fails the drill', async () => {
  const altered = await runRestoreDrill({ store: await backedUp(), prefix: BACKUP_PREFIX_DEFAULT, target: memoryTarget({ mangle: (c) => c.normalize('NFD') }) });
  assert.equal(altered.outcome, 'failed');
  assert.ok(altered.failures.some((f) => f.kind === 'row_mismatch' && f.id === 'ep-1'), 'a Unicode-normalised row is caught');
  const dropped = await runRestoreDrill({ store: await backedUp(), prefix: BACKUP_PREFIX_DEFAULT, target: memoryTarget({ dropId: 'ep-2' }) });
  assert.deepEqual(dropped.failures, [{ kind: 'row_missing', id: 'ep-2' }]);
});

test('the drill refuses a table that already holds rows', async () => {
  await assert.rejects(runRestoreDrill({ store: await backedUp(), prefix: BACKUP_PREFIX_DEFAULT, target: memoryTarget({ preexisting: 1 }) }), /is not empty/);
});

test('the CLI identifies the shared database through its pooled and direct hostnames alike', () => {
  const pooled = 'postgres://u:p@ep-cool-name-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const direct = 'postgres://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const branch = 'postgres://u:p@ep-other-branch-456.us-east-2.aws.neon.tech/neondb?sslmode=require';
  assert.equal(databaseIdentity(pooled), databaseIdentity(direct));
  assert.notEqual(databaseIdentity(pooled), databaseIdentity(branch));
});
