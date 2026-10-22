/** Mirror sync client: positions, blocks and batches (stage R-P3); no network. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockDigest } from '@shared/claude-code-mirror-core.mjs';
import { acquireLock, batches, localBlocks, readTranscript } from './claude-code-mirror-sync';

test('positions match the Stop recorder: index among truthy parsed, non-empty lines', () => {
  const text = [
    JSON.stringify({ type: 'user', uuid: 'a', message: { content: 'hi' } }),
    '',
    '{ not json',
    'null',
    JSON.stringify({ type: 'assistant', uuid: 'b', message: { content: [{ type: 'text', text: 'yo' }] } }),
    '"a bare string"',
    JSON.stringify({ type: 'file-history-snapshot', snapshot: { secret: 1 } }),
  ].join('\n');
  const entries = readTranscript(text);
  // The recorder: lines.filter(Boolean).map(parse-or-null).filter(Boolean) -> user, assistant, "a bare string", snapshot.
  assert.deepEqual(entries.map((e) => [e.position, e.entry.type]), [[0, 'user'], [1, 'assistant'], [2, 'unparseable'], [3, 'file-history-snapshot']]);
  assert.equal(entries[0].uuid, 'a');
  assert.doesNotMatch(JSON.stringify(entries), /secret/);
});

test('local blocks group by 256 positions with session-salted digests', () => {
  const entries = readTranscript(Array.from({ length: 600 }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: { content: `m${i}` } })).join('\n'));
  const blocks = localBlocks('session-1', entries);
  assert.deepEqual(blocks.map((b) => [b.index, b.tuples.length]), [[0, 256], [1, 256], [2, 88]]);
  assert.equal(blocks[2].digest, blockDigest('session-1', blocks[2].tuples));
});

test('batches respect the count and byte limits and keep order', () => {
  const entries = readTranscript(Array.from({ length: 450 }, (_, i) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(i % 7 === 0 ? 30_000 : 10) } })).join('\n'));
  const out = batches(entries, 200, 100_000);
  assert.ok(out.every((b) => b.length <= 200));
  assert.ok(out.every((b) => b.length === 1 || b.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.entry)) + 128, 0) <= 100_000));
  assert.deepEqual(out.flat().map((e) => e.position), entries.map((e) => e.position));
});

test('the per-session lock is exclusive and recovers only from a dead owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-lock-'));
  const release = acquireLock(dir, 'session-1');
  assert.ok(release);
  assert.equal(acquireLock(dir, 'session-1'), null, 'a live owner keeps the lock');
  release!();
  writeFileSync(join(dir, 'session-2.lock'), '2147483646');
  const takeover = acquireLock(dir, 'session-2');
  assert.ok(takeover, 'a lock whose owner pid is gone is taken over');
  takeover!();
});

test('the hook launcher builds a detached sync command only from a usable input, and is not registered', async () => {
  const { syncCommand } = await import('../../.claude/hooks/mirror-sync.mjs');
  const cmd = syncCommand({ session_id: '4efb200a-ed44-4e7b-be8f-d89d2d1c8053', transcript_path: 'C:/x/t.jsonl' }, '/root');
  assert.ok(cmd);
  assert.deepEqual(cmd.args.slice(-4), ['--transcript', 'C:/x/t.jsonl', '--session', '4efb200a-ed44-4e7b-be8f-d89d2d1c8053']);
  assert.equal(syncCommand({ session_id: 'bad id; rm', transcript_path: 'x' }), null);
  assert.equal(syncCommand({}), null);
  const { readFileSync } = await import('node:fs');
  const settings = readFileSync(new URL('../../.claude/settings.json', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /mirror-sync/, 'activation is a separate, founder-approved change');
});
