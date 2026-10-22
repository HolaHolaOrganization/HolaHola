/** Mirror sync client (stage R-P3): positions, blocks, batches, lock CAS, oversized entries, budget. No network. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { blockDigest, canonicalJson } from '@shared/claude-code-mirror-core.mjs';
import { MIRROR_LIMITS } from '../services/claude-code-mirror-rules';
import {
  MAX_ENTRY_BYTES, acquireLock, batches, localBlocks, ownerState, readTranscript, removeIfToken, syncSession, type Transport,
} from './claude-code-mirror-sync';

const line = (o: unknown) => JSON.stringify(o);
const user = (text: string, uuid?: string) => line({ type: 'user', ...(uuid ? { uuid } : {}), message: { content: text } });

describe('transcript reading, blocks and batches', () => {
  test('positions match the Stop recorder: index among truthy parsed, non-empty lines', () => {
    const text = [user('hi', 'a'), '', '{ not json', 'null',
      line({ type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'yo' }] } }), '"a bare string"',
      line({ type: 'file-history-snapshot', snapshot: { secret: 1 } })].join('\n');
    const entries = readTranscript(text);
    assert.deepEqual(entries.map((e) => [e.position, e.entry.type]), [[0, 'user'], [1, 'assistant'], [2, 'unparseable'], [3, 'file-history-snapshot']]);
    assert.equal(entries[0].uuid, 'a');
    assert.doesNotMatch(JSON.stringify(entries), /secret/);
  });

  test('local blocks group by 256 positions with session-salted digests', () => {
    const entries = readTranscript(Array.from({ length: 600 }, (_, i) => user(`m${i}`, `u${i}`)).join('\n'));
    const blocks = localBlocks('session-1', entries);
    assert.deepEqual(blocks.map((b) => [b.index, b.tuples.length]), [[0, 256], [1, 256], [2, 88]]);
    assert.equal(blocks[2].digest, blockDigest('session-1', blocks[2].tuples));
  });

  test('batches respect the count and byte limits and keep order', () => {
    const entries = readTranscript(Array.from({ length: 450 }, (_, i) => user('x'.repeat(i % 7 === 0 ? 30_000 : 10))).join('\n'));
    const out = batches(entries, 200, 100_000);
    assert.ok(out.every((b) => b.length <= 200));
    assert.ok(out.every((b) => b.length === 1 || b.reduce((n, e) => n + e.bytes + 128, 0) <= 100_000));
    assert.deepEqual(out.flat().map((e) => e.position), entries.map((e) => e.position));
  });

  test('the client per-entry limit equals the server limit', () => {
    assert.equal(MAX_ENTRY_BYTES, MIRROR_LIMITS.maxEntryBytes);
  });
});

describe('lock: compare-and-swap on the owner token (LR review 5620414671)', () => {
  const dead = (() => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); }) as never;

  test('exclusive while the owner lives; a dead owner is taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-lock-'));
    const release = acquireLock(dir, 'session-1');
    assert.ok(release);
    assert.equal(acquireLock(dir, 'session-1'), null);
    release!();
    writeFileSync(join(dir, 'session-2.lock'), '2147483646:stale');
    const takeover = acquireLock(dir, 'session-2', dead);
    assert.ok(takeover);
    takeover!();
  });

  test("competing stale recoveries: the slower contender cannot remove the newer owner's lock", () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-lock-'));
    const path = join(dir, 'session-3.lock');
    writeFileSync(path, '2147483646:stale');
    // Contender A has read the stale token; contender B takes over first.
    const staleSeenByA = readFileSync(path, 'utf8');
    const releaseB = acquireLock(dir, 'session-3', dead);
    assert.ok(releaseB);
    const ownerB = readFileSync(path, 'utf8');
    // A performs its already-decided removal, bound to the token it inspected: it must fail.
    assert.equal(removeIfToken(path, staleSeenByA), false);
    assert.equal(readFileSync(path, 'utf8'), ownerB, 'B still owns the lock');
    releaseB!();
  });

  test("a stale releaser never unlinks a replacement owner's lock", () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-lock-'));
    const path = join(dir, 'session-4.lock');
    writeFileSync(path, `${process.pid}:replacement-owner`);
    assert.equal(removeIfToken(path, `${process.pid}:old-owner`), false);
    assert.equal(readFileSync(path, 'utf8'), `${process.pid}:replacement-owner`);
  });

  test('only ESRCH means dead; EPERM is alive and other errors are unknown (never taken over)', () => {
    const throwing = (code: string) => (() => { throw Object.assign(new Error(code), { code }); }) as never;
    assert.equal(ownerState(1, throwing('ESRCH')), 'dead');
    assert.equal(ownerState(1, throwing('EPERM')), 'alive');
    assert.equal(ownerState(1, throwing('EINVAL')), 'unknown');
    const dir = mkdtempSync(join(tmpdir(), 'mirror-lock-'));
    writeFileSync(join(dir, 'session-5.lock'), '12345:other');
    assert.equal(acquireLock(dir, 'session-5', throwing('EPERM')), null);
    assert.equal(acquireLock(dir, 'session-5', throwing('EINVAL')), null);
  });
});

/** A mock server that starts empty and accepts uploads like the real one. */
function mockServer(opts: { stepMs?: number; clock?: { t: number } } = {}) {
  const held = new Set<string>();
  const calls: string[] = [];
  const transport: Transport = async (path, body: any) => {
    calls.push(path);
    if (opts.clock) opts.clock.t += opts.stepMs ?? 0;
    if (path === 'coverage') return { differing: body.blocks.map((b: { index: number }) => b.index), rootConfirmed: false };
    if (path === 'block-tuples') {
      const missing = body.tuples.filter((t: { position: number; sha256: string }) => !held.has(`${t.position}:${t.sha256}`));
      return { missing, confirmed: missing.length === 0 };
    }
    if (path === 'entries') {
      for (const e of body.entries) {
        const json = canonicalJson(e.entry);
        if (Buffer.byteLength(json, 'utf8') > MAX_ENTRY_BYTES) throw new Error('entry is too large');
        held.add(`${e.position}:${createHash('sha256').update(json, 'utf8').digest('hex')}`);
      }
      return { stored: body.entries.length };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { transport, calls, held };
}

describe('syncSession', () => {
  test('an oversized FIRST entry is reported unaccepted, and every following entry still syncs', async () => {
    const text = [user('y'.repeat(300_000), 'big'), user('after one', 'a1'), user('after two', 'a2')].join('\n');
    const server = mockServer();
    const result = await syncSession({ text, sessionId: 'session-ov', budgetMs: 60_000, transport: server.transport });
    assert.equal(result.sent, 2);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'unaccepted-entries');
    assert.deepEqual(result.unaccepted.map((u) => u.position), [0]);
    assert.ok(result.unaccepted[0].bytes > MAX_ENTRY_BYTES);
    assert.equal(server.calls.filter((c) => c === 'block-tuples').length, 1, 'a block holding an unaccepted entry is not re-confirmed');
  });

  test('a clean session syncs completely and confirms its block', async () => {
    const server = mockServer();
    const result = await syncSession({ text: [user('one', 'x1'), user('two', 'x2')].join('\n'), sessionId: 'session-ok', budgetMs: 60_000, transport: server.transport });
    assert.deepEqual([result.sent, result.complete, result.reason], [2, true, 'complete']);
    assert.deepEqual(server.calls, ['coverage', 'block-tuples', 'entries', 'block-tuples']);
  });

  test('the budget is enforced through every request, including inside the final block', async () => {
    const clock = { t: 0 };
    const server = mockServer({ stepMs: 2, clock });
    const result = await syncSession({
      text: [user('one', 'b1'), user('two', 'b2')].join('\n'), sessionId: 'session-budget', budgetMs: 3,
      transport: server.transport, now: () => clock.t,
    });
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'budget');
    assert.deepEqual(server.calls, ['coverage', 'block-tuples'], 'nothing is sent after the deadline');
  });

  test('a non-finite or non-positive budget is refused', async () => {
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(syncSession({ text: user('x'), sessionId: 'session-bad', budgetMs, transport: mockServer().transport }), /budget/);
    }
  });
});

test('the hook launcher builds a detached sync command only from a usable input, and is not registered', async () => {
  const { syncCommand } = await import('../../.claude/hooks/mirror-sync.mjs');
  const cmd = syncCommand({ session_id: '4efb200a-ed44-4e7b-be8f-d89d2d1c8053', transcript_path: 'C:/x/t.jsonl' }, '/root');
  assert.ok(cmd);
  assert.deepEqual(cmd.args.slice(-4), ['--transcript', 'C:/x/t.jsonl', '--session', '4efb200a-ed44-4e7b-be8f-d89d2d1c8053']);
  assert.equal(syncCommand({ session_id: 'bad id; rm', transcript_path: 'x' }), null);
  assert.equal(syncCommand({}), null);
  const settings = readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /mirror-sync/, 'activation is a separate, founder-approved change');
});
