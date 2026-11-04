// Phase B episode backup (episode-backup.ts): one-way, content-addressed,
// never overwritten, verified on read-back, and the last-good pointer only
// advances for a complete, unflagged manifest. An in-memory store stands in
// for S3 and, like the conditional PUT, refuses to replace an object.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BACKUP_PREFIX_DEFAULT, objectKeyFor, readLastGood, runEpisodeBackup, type BackupStore, type InventoryRow, type StoredObject } from './episode-backup';

function memoryStore() {
  const objects = new Map<string, StoredObject>();
  const store: BackupStore & { objects: Map<string, StoredObject>; corrupt?: string } = {
    objects,
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      if (store.corrupt === key) return { bytes: Buffer.from('corrupted'), metadata: found.metadata };
      return { bytes: Buffer.from(found.bytes), metadata: { ...found.metadata } };
    },
    async putNew(key, body, metadata) {
      if (objects.has(key)) throw new Error(`PreconditionFailed: ${key} exists`);
      objects.set(key, { bytes: Buffer.from(body), metadata });
    },
    async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
  };
  return store;
}

const row = (id: string, content: string, arcName = 'HolaHola Episodes'): InventoryRow =>
  ({ id, arcName, entryType: 'episode', title: id, createdAt: null, recordedAt: null, content });
let clock = Date.parse('2026-11-03T19:00:00Z');
const run = (store: BackupStore, rows: InventoryRow[], extra: { dryRun?: boolean } = {}) =>
  runEpisodeBackup({ store, inventory: async () => rows, now: () => new Date(clock += 3_600_000), ...extra });
const keys = (store: ReturnType<typeof memoryStore>, part: string) => [...store.objects.keys()].filter((k) => k.includes(`/${part}/`));

test('a first run uploads every row, publishes a manifest and advances last-good; an unchanged rerun uploads nothing new', async () => {
  const store = memoryStore();
  const rows = [row('a', 'Episode A'), row('b', 'Episode B'), row('c', 'Story C', 'HolaHola Stories')];
  const first = await run(store, rows);
  assert.equal(first.outcome, 'advanced');
  assert.deepEqual([first.rowCount, first.uploaded, first.alreadyPresent], [3, 3, 0]);
  assert.equal(keys(store, 'objects').length, 3);
  const lastGood = await readLastGood(store, BACKUP_PREFIX_DEFAULT);
  assert.equal(lastGood!.manifestKey, first.manifestKey);
  assert.deepEqual(lastGood!.manifest.entries.map((e) => e.id), ['a', 'b', 'c']);

  const again = await run(store, rows);
  assert.equal(again.outcome, 'advanced');
  assert.deepEqual([again.uploaded, again.alreadyPresent], [0, 3], 'content-addressed: unchanged rows are not re-uploaded');
  assert.equal(keys(store, 'last-good').length, 2, 'each advance is a new pointer object, never an overwrite');
});

test('manifests are content-addressed: an unchanged run writes only a new pointer, which records when and what it verified', async () => {
  const store = memoryStore();
  const rows = [row('a', 'A'), row('b', 'B')];
  const first = await run(store, rows);
  const second = await run(store, rows);
  assert.equal(second.manifestKey, first.manifestKey);
  assert.equal(keys(store, 'manifests').length, 1, 'no second manifest for unchanged content');
  const pointers = keys(store, 'last-good').sort();
  assert.equal(pointers.length, 2);
  const newest = JSON.parse(store.objects.get(pointers[1])!.bytes.toString('utf8'));
  assert.equal(newest.manifestKey, first.manifestKey);
  assert.equal(newest.previousManifestKey, first.manifestKey);
  const lastGood = await readLastGood(store, BACKUP_PREFIX_DEFAULT);
  assert.equal(lastGood!.takenAt, newest.takenAt);
  await run(store, [row('a', 'A'), row('b', 'B, grown')]);
  assert.equal(keys(store, 'manifests').length, 2, 'changed content gets its own manifest');
});

test('growth at the end of a row (including multi-byte text) is not flagged; a new row is not flagged', async () => {
  const store = memoryStore();
  await run(store, [row('a', 'Episode — ñ start'), row('b', 'B')]);
  const grown = await run(store, [row('a', 'Episode — ñ start, then more 🙂'), row('b', 'B'), row('d', 'new row')]);
  assert.equal(grown.outcome, 'advanced');
  assert.deepEqual(grown.flags, []);
  assert.equal(grown.uploaded, 2, 'the grown row and the new row');
});

test('a missing, shrunk or rewritten row is flagged; the flagged manifest is kept beside last-good, which does not move', async () => {
  const store = memoryStore();
  const good = await run(store, [row('a', 'Alpha alpha'), row('b', 'Bravo bravo'), row('c', 'Charlie'), row('d', 'Delta'), row('e', 'Echo'),
    row('f', 'F'), row('g', 'G'), row('h', 'H'), row('i', 'I'), row('j', 'J')]);
  const flagged = await run(store, [row('a', 'Alpha'), row('b', 'Bravo BRAVO'), row('d', 'Delta'), row('e', 'Echo'),
    row('f', 'F'), row('g', 'G'), row('h', 'H'), row('i', 'I'), row('j', 'J')]);
  assert.equal(flagged.outcome, 'flagged');
  assert.deepEqual(flagged.flags.map((f) => [f.kind, (f as any).id]).sort(), [['missing', 'c'], ['rewritten', 'b'], ['shrank', 'a']]);
  assert.match(flagged.manifestKey!, /\/flagged\//);
  assert.equal((await readLastGood(store, BACKUP_PREFIX_DEFAULT))!.manifestKey, good.manifestKey, 'last-good stays on the good manifest');
  // The next run still compares against the last good manifest, so the loss stays flagged until it is repaired.
  const repeat = await run(store, [row('a', 'Alpha'), row('b', 'Bravo BRAVO')]);
  assert.equal(repeat.outcome, 'flagged');
  assert.ok(repeat.flags.some((f) => f.kind === 'catalog_shrank'));
});

test('an empty catalog is flagged and never advances last-good', async () => {
  const store = memoryStore();
  const result = await run(store, []);
  assert.equal(result.outcome, 'flagged');
  assert.deepEqual(result.flags, [{ kind: 'catalog_empty' }]);
  assert.equal(await readLastGood(store, BACKUP_PREFIX_DEFAULT), null);
});

test('an existing object with different bytes is never replaced', async () => {
  const store = memoryStore();
  await run(store, [row('a', 'A')]);
  store.objects.set(keys(store, 'objects')[0], { bytes: Buffer.from('tampered'), metadata: {} });
  await assert.rejects(run(store, [row('a', 'A')]), /exists with different bytes; refusing to replace it/);
  assert.equal(keys(store, 'last-good').length, 1, 'last-good did not advance');
});

test('a failed read-back stops the run before last-good moves', async () => {
  const store = memoryStore();
  await run(store, [row('a', 'A')]);
  store.corrupt = objectKeyFor(BACKUP_PREFIX_DEFAULT, createHash('sha256').update('B').digest('hex'));
  await assert.rejects(run(store, [row('a', 'A'), row('b', 'B')]), /read-back verification failed/);
  assert.equal(keys(store, 'last-good').length, 1, 'last-good did not advance');
});

test('a dry run inventories and compares but writes nothing', async () => {
  const store = memoryStore();
  const result = await run(store, [row('a', 'A')], { dryRun: true });
  assert.equal(result.outcome, 'dry_run');
  assert.equal(store.objects.size, 0);
});

test('last-good refuses a manifest whose bytes no longer match its pointer', async () => {
  const store = memoryStore();
  const first = await run(store, [row('a', 'A')]);
  store.objects.set(first.manifestKey!, { bytes: Buffer.from('{"tampered":true}'), metadata: {} });
  await assert.rejects(readLastGood(store, BACKUP_PREFIX_DEFAULT), /failed verification/);
});
