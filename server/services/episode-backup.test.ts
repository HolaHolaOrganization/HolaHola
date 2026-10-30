import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupHash, exportEpisodeBackup, restoreEpisodeBackup, verifyRestoredEpisodeInventory,
  type EpisodeBackupStore,
} from "./episode-backup";

class Store implements EpisodeBackupStore {
  objects = new Map<string, Buffer>();
  failKey = "";
  corruptRead = "";
  async putNew(key: string, bytes: Buffer) {
    if (key.includes(this.failKey) && this.failKey) throw new Error("injected upload failure");
    const existing = this.objects.get(key);
    if (existing && !existing.equals(bytes)) throw new Error("immutable object");
    if (!existing) this.objects.set(key, Buffer.from(bytes));
  }
  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("missing object");
    return key.includes(this.corruptRead) && this.corruptRead ? Buffer.from("corrupt") : bytes;
  }
}
const records = [
  { id: "episode", content: "Founder: café 🌎\r\nLuca: yes.\n", tags: ["rolling"], recorded_at: "2026-10-30T00:00:00.123456" },
  { id: "story", content: "Story\n", extends_memory_id: "episode", tags: ["episode-story"] },
  { id: "hidden-fixture", content: "", hidden: true },
];
function save(store: Store, id = "first", rows = records, previous: Awaited<ReturnType<typeof exportEpisodeBackup>>["reference"] | null = null) {
  return exportEpisodeBackup({ store, snapshotId: id, createdAt: "2026-10-30T00:00:00Z", records: rows, previous });
}

test("backup-only full round-trip preserves unicode, CRLF, empty content and metadata", async () => {
  const store = new Store();
  const { reference, manifest } = await save(store);
  assert.equal(manifest.status, "verified");
  assert.equal(manifest.records.length, records.length);
  assert.equal(manifest.records.find(r => r.id === "episode")?.contentBytes, Buffer.byteLength(records[0].content));
  const restored = await restoreEpisodeBackup(store, reference);
  verifyRestoredEpisodeInventory(records, restored);
  assert.throws(() => verifyRestoredEpisodeInventory(records, restored.slice(1)), /count/);
  assert.throws(() => verifyRestoredEpisodeInventory(records, [restored[0], restored[0], restored[0]]), /identity/);
  assert.throws(() => verifyRestoredEpisodeInventory(records, restored.map(r => ({ ...r, content: r.content + "x" }))), /content/);
  assert.throws(() => verifyRestoredEpisodeInventory(records, restored.map(r => ({ ...r, tags: [] }))), /metadata/);
});

test("missing or rewritten rows are quarantined without changing prior last-good", async () => {
  const store = new Store(), first = await save(store);
  const priorBytes = Buffer.from(await store.read(first.reference.key));
  const lost = await save(store, "missing", records.slice(1), first.reference);
  assert.equal(lost.manifest.status, "flagged");
  assert.deepEqual(lost.manifest.issues, ["missing:episode"]);
  await assert.rejects(restoreEpisodeBackup(store, lost.reference), /Flagged/);
  const rewritten = await save(store, "rewritten", records.map(r =>
    r.id === "episode" ? { ...r, content: "bad" } : r), first.reference);
  assert.deepEqual(rewritten.manifest.issues, ["non-prefix-change:episode"]);
  assert.ok((await store.read(first.reference.key)).equals(priorBytes));
  verifyRestoredEpisodeInventory(records, await restoreEpisodeBackup(store, first.reference));
});

test("prefix extensions and new records are accepted; exact objects are reusable", async () => {
  const store = new Store(), first = await save(store);
  const next = records.map(r => r.id === "episode" ? { ...r, content: r.content + "next\n" } : r);
  const second = await save(store, "second", next, first.reference);
  assert.equal(second.manifest.status, "verified");
  verifyRestoredEpisodeInventory(next, await restoreEpisodeBackup(store, second.reference));
});

test("partial upload and corrupt readback publish no manifest", async () => {
  for (const mode of ["failKey", "corruptRead"] as const) {
    const store = new Store();
    store[mode] = "/objects/";
    await assert.rejects(save(store));
    assert.equal([...store.objects.keys()].filter(k => k.includes("/manifests/")).length, 0);
  }
});

test("manifest tampering, missing objects and content corruption fail closed", async () => {
  for (const mode of ["manifest", "missing", "content"] as const) {
    const store = new Store(), { reference, manifest } = await save(store);
    if (mode === "manifest") store.objects.set(reference.key, Buffer.from("{}"));
    if (mode === "missing") store.objects.delete(manifest.records[0].key);
    if (mode === "content") store.objects.set(manifest.records[0].key, Buffer.from("not original"));
    await assert.rejects(restoreEpisodeBackup(store, reference));
  }
});

test("empty and duplicate source inventories fail before any writes", async () => {
  const store = new Store();
  await assert.rejects(save(store, "empty", []), /empty/);
  await assert.rejects(save(store, "duplicate", [records[0], records[0]]), /Duplicate/);
  assert.equal(store.objects.size, 0);
});

test("reusing a snapshot id cannot overwrite an existing manifest", async () => {
  const store = new Store(), first = await save(store);
  await assert.rejects(save(store, "first", records.slice(1)), /immutable/);
  verifyRestoredEpisodeInventory(records, await restoreEpisodeBackup(store, first.reference));
});

test("forged duplicate inventory and wrong snapshot identity are refused even with a matching external hash", async () => {
  const store = new Store(), first = await save(store);
  for (const mutate of [
    (m: typeof first.manifest) => { m.records.push(m.records[0]); },
    (m: typeof first.manifest) => { m.snapshotId = "another"; },
  ]) {
    const m = structuredClone(first.manifest);
    mutate(m);
    const bytes = Buffer.from(JSON.stringify(m));
    store.objects.set(first.reference.key, bytes);
    await assert.rejects(restoreEpisodeBackup(store, { ...first.reference, sha256: backupHash(bytes) }));
  }
});
