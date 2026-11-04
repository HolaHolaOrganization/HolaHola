// The hourly episode backup pass (episode-backup-scheduler.ts): a flagged run and
// a stale last-good alert the hats, a day without a good backup also reaches the
// founder, and nothing in the pass can throw.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackupRunResult } from './episode-backup';
import { episodeBackupTick, FOUNDER_ESCALATION_MS, STALE_ALERT_MS, type BackupAlert, type BackupTickDeps } from './episode-backup-scheduler';

const NOW = Date.parse('2026-11-04T12:30:00Z');
const advanced: BackupRunResult = { outcome: 'advanced', manifestKey: 'p/manifests/abc.json', rowCount: 3, totalBytes: 30, uploaded: 0, alreadyPresent: 3, flags: [] };
const flagged: BackupRunResult = { ...advanced, outcome: 'flagged', manifestKey: 'p/flagged/def.json', flags: [{ kind: 'missing', id: 'row-1' }, { kind: 'catalog_shrank', previousCount: 10, count: 2 }] };
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function deps(over: Partial<BackupTickDeps> = {}) {
  const hats: BackupAlert[] = [];
  const founder: string[] = [];
  const d: BackupTickDeps = {
    run: async () => advanced,
    lastGoodAt: async () => iso(60_000),
    alertHats: async (a) => { hats.push(a); },
    alertFounder: async (key) => { founder.push(key); },
    now: () => NOW,
    watchingSince: NOW - 60_000,
    ...over,
  };
  return { d, hats, founder };
}

test('a good run with a fresh last-good alerts no one', async () => {
  const { d, hats, founder } = deps();
  const out = await episodeBackupTick(d);
  assert.equal(out.run, 'advanced');
  assert.deepEqual([hats, founder], [[], []]);
});

test('a flagged run alerts the hats once per flagged manifest, naming the flags', async () => {
  const { d, hats, founder } = deps({ run: async () => flagged });
  const out = await episodeBackupTick(d);
  assert.equal(out.run, 'flagged');
  assert.equal(hats.length, 1);
  assert.equal(hats[0].kind, 'flagged');
  assert.equal(hats[0].key, 'flagged:p/flagged/def.json');
  assert.match(hats[0].text, /missing row-1; catalog_shrank/);
  assert.deepEqual(founder, []);
});

test('a failed run is not an alert by itself; past three hours without a good backup it is, keyed per six-hour window', async () => {
  const fail = { run: async () => { throw new Error('R2 unreachable'); } };
  const recent = deps({ ...fail, lastGoodAt: async () => iso(STALE_ALERT_MS - 60_000) });
  assert.equal((await episodeBackupTick(recent.d)).run, 'failed');
  assert.deepEqual(recent.hats, []);

  const stale = deps({ ...fail, lastGoodAt: async () => iso(STALE_ALERT_MS + 60_000) });
  const out = await episodeBackupTick(stale.d);
  assert.equal(out.error, 'R2 unreachable');
  assert.equal(stale.hats.length, 1);
  assert.equal(stale.hats[0].kind, 'stale');
  assert.equal(stale.hats[0].key, 'stale:2026-11-04T12:00:00.000Z');
  assert.match(stale.hats[0].text, /3 h ago .* The latest run failed: R2 unreachable/);
  assert.deepEqual(stale.founder, []);
});

test('with no backup at all, the age counts from when this server started watching', async () => {
  const young = deps({ lastGoodAt: async () => null, run: async () => { throw new Error('no bucket'); }, watchingSince: NOW - 60_000 });
  await episodeBackupTick(young.d);
  assert.deepEqual(young.hats, []);
  const old = deps({ lastGoodAt: async () => null, run: async () => { throw new Error('no bucket'); }, watchingSince: NOW - STALE_ALERT_MS - 1 });
  await episodeBackupTick(old.d);
  assert.equal(old.hats[0]?.kind, 'stale');
  assert.match(old.hats[0].text, /No good episode backup exists yet/);
});

test('past a day without a good backup the founder inbox is told too, once per UTC day', async () => {
  const { d, hats, founder } = deps({ lastGoodAt: async () => iso(FOUNDER_ESCALATION_MS + 60_000) });
  const out = await episodeBackupTick(d);
  assert.equal(hats.length, 1);
  assert.deepEqual(founder, ['episode_backup_stale:2026-11-04']);
  assert.deepEqual(out.alerts, ['stale:2026-11-04T12:00:00.000Z', 'episode_backup_stale:2026-11-04']);
});

test('nothing in the pass throws: a failing alert channel or last-good read is logged, not raised', async () => {
  const { d } = deps({
    run: async () => flagged,
    alertHats: async () => { throw new Error('ledger down'); },
    lastGoodAt: async () => { throw new Error('bucket list failed'); },
  });
  const out = await episodeBackupTick(d);
  assert.equal(out.run, 'flagged');
  assert.deepEqual(out.alerts, []);
  assert.equal(out.ageMs, null);
});
