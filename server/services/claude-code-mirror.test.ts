/** Mirror core and ingest rules (recording-gap design R6.5, stage R-P1); no database. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BLOCK_SIZE,
  blockDigest,
  contentSha256,
  filterEntry,
  isFilterFixedPoint,
  rootDigest,
} from '@shared/claude-code-mirror-core.mjs';
import { MirrorInputError, observationFlags, prepareEntry } from './claude-code-mirror-rules';

describe('privacy filter', () => {
  test('user: provenance and text kept; tool_result and image reduced to content-free markers', () => {
    const out = filterEntry({
      type: 'user', uuid: 'u1', timestamp: 't', origin: { kind: 'human' }, promptSource: 'sdk', cwd: '/secret/path', sessionId: 's',
      message: { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_result', tool_use_id: 'tu1', content: 'SECRET OUTPUT' },
        { type: 'image', source: { data: 'BASE64' } },
      ] },
    });
    assert.deepEqual(out, {
      type: 'user', timestamp: 't', origin: { kind: 'human' }, promptSource: 'sdk',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_result', tool_use_id: 'tu1' }, { type: 'image' }] },
    });
    assert.doesNotMatch(JSON.stringify(out), /SECRET|BASE64|secret\/path/);
  });

  test('assistant: mixed entry keeps its text, tool_use becomes an id-only witness, thinking is dropped', () => {
    const out = filterEntry({
      type: 'assistant', uuid: 'a1', timestamp: 't', isApiErrorMessage: false,
      message: { model: 'm', content: [
        { type: 'thinking', thinking: 'PRIVATE' },
        { type: 'text', text: 'Running it now.' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat .env' } },
      ] },
    });
    assert.deepEqual(out, {
      type: 'assistant', timestamp: 't', isApiErrorMessage: false,
      message: { model: 'm', content: [{ type: 'text', text: 'Running it now.' }, { type: 'tool_use', id: 'tu1' }] },
    });
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE|Bash|\.env/);
  });

  test('hook feedback witnesses carry no reason text; queued_command is kept whole', () => {
    assert.deepEqual(filterEntry({ type: 'attachment', uuid: 'x', timestamp: 't', attachment: { type: 'hook_blocking_error', blockingError: 'REASON' } }),
      { type: 'attachment', timestamp: 't', attachment: { type: 'hook_blocking_error' } });
    assert.deepEqual(filterEntry({ type: 'system', subtype: 'stop_hook_summary', level: 'suggestion', timestamp: 't', content: 'REASON', hookInfos: [1] }),
      { type: 'system', subtype: 'stop_hook_summary', level: 'suggestion', timestamp: 't' });
    const queued = { type: 'queued_command', prompt: 'p', origin: { kind: 'human' }, source_uuid: 's' };
    assert.deepEqual(filterEntry({ type: 'attachment', timestamp: 't', attachment: queued }), { type: 'attachment', timestamp: 't', attachment: queued });
  });

  test('every other entry becomes a content-free placeholder', () => {
    assert.deepEqual(filterEntry({ type: 'file-history-snapshot', snapshot: { big: 'x' } }), { type: 'file-history-snapshot' });
    assert.deepEqual(filterEntry({ type: 'system', subtype: 'api_error', content: 'ERR' }), { type: 'system', subtype: 'api_error' });
    assert.deepEqual(filterEntry({ type: 'attachment', attachment: { type: 'environment', cwd: '/x' } }), { type: 'attachment', attachment: { type: 'environment' } });
    assert.deepEqual(filterEntry('not an object'), { type: 'unparseable' });
  });

  test('the filter is idempotent, and only filtered entries are accepted', () => {
    const raw = { type: 'assistant', timestamp: 't', message: { model: 'm', content: [{ type: 'tool_use', id: 'x', input: { a: 1 } }] } };
    assert.equal(isFilterFixedPoint(filterEntry(raw)), true);
    assert.equal(isFilterFixedPoint(raw), false, 'tool input must not be accepted');
    assert.throws(() => prepareEntry({ position: 0, uuid: 'u', entry: raw }), MirrorInputError);
    assert.throws(() => prepareEntry({ position: 0, uuid: 'u', entry: { type: 'user', cwd: '/x', message: { content: 'hi' } } }), MirrorInputError);
  });
});

describe('identity and digests', () => {
  const entry = filterEntry({ type: 'user', timestamp: 't', message: { content: 'hi' } });

  test('the content hash excludes position and uuid', () => {
    const a = prepareEntry({ position: 3, uuid: 'u1', entry });
    const b = prepareEntry({ position: 900, uuid: 'other', entry });
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.sha256, contentSha256(entry));
  });

  test('input validation', () => {
    assert.throws(() => prepareEntry({ position: -1, entry }), MirrorInputError);
    assert.throws(() => prepareEntry({ position: 1.5, entry }), MirrorInputError);
    assert.throws(() => prepareEntry({ position: 1, uuid: 'bad uuid!', entry }), MirrorInputError);
    assert.equal(prepareEntry({ position: 1, uuid: null, entry }).uuid, '');
    const big = filterEntry({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
    assert.throws(() => prepareEntry({ position: 1, entry: big }), /too large/);
  });

  test('block digests are order-independent and salted by session (test 14)', () => {
    const t = [{ position: 1, uuid: 'a', sha256: 'f'.repeat(64) }, { position: 2, uuid: '', sha256: 'e'.repeat(64) }];
    assert.equal(blockDigest('session-1', t), blockDigest('session-1', [...t].reverse()));
    assert.notEqual(blockDigest('session-1', t), blockDigest('session-2', t));
    assert.notEqual(blockDigest('session-1', t), blockDigest('session-1', [t[0], { ...t[1], position: 3 }]));
    assert.notEqual(rootDigest('session-1', [{ index: 0, digest: 'a' }]), rootDigest('session-2', [{ index: 0, digest: 'a' }]));
    assert.equal(BLOCK_SIZE, 256);
  });
});

describe('observation flags (R6-1, R6-2, R6-9)', () => {
  const H1 = '1'.repeat(64), H2 = '2'.repeat(64);
  const held = [{ position: 17, uuid: 'A', sha256: H1 }];

  test('R6-1: same uuid, different bytes at the same position', () => {
    assert.deepEqual(observationFlags({ position: 17, uuid: 'A', sha256: H2 }, held), ['same-uuid-different-bytes']);
  });
  test('R6-2: a different uuid at an occupied position', () => {
    assert.deepEqual(observationFlags({ position: 17, uuid: 'B', sha256: H1 }, held), ['position-reused']);
  });
  test('R6-9: the same uuid and bytes at a new position', () => {
    assert.deepEqual(observationFlags({ position: 18, uuid: 'A', sha256: H1 }, held), ['position-moved']);
  });
  test('an exact retry and an unrelated entry carry no flags; a missing uuid is noted', () => {
    assert.deepEqual(observationFlags({ position: 17, uuid: 'A', sha256: H1 }, held), []);
    assert.deepEqual(observationFlags({ position: 40, uuid: 'C', sha256: H2 }, held), []);
    assert.deepEqual(observationFlags({ position: 41, uuid: '', sha256: H2 }, held), ['no-uuid']);
  });
});
