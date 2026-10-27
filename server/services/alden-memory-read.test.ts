import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ALDEN_TOOL_RESULT_LIMIT,
  aldenWatchToolResultContent,
  isCompleteAldenResultTool,
  serializeAldenToolResult,
} from './alden-tool-result';
import {
  assertMemoryId,
  buildMemoryDiscovery,
  readMemoryContentChunk,
  READ_MEMORY_CONTENT_TOOL,
  type MemoryRow,
} from './alden-memory-read';

// Synthetic fixtures only: no database, network or real memory row is used.
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const ID = '00000000-0000-4000-8000-000000000001';
const LATE = 'THE LATE PASSAGE: ¿cómo va tu corazón? 🌱';

/** ~100K characters with surrogate pairs throughout and a known late passage. */
function longText(): string {
  const line = 'David: una línea con emoji 😀 y control\tchars "quoted" \\ back\n';
  let s = '';
  while (s.length < 97_000) s += line;
  return s + LATE + '\n' + 'tail 🎉'.repeat(500);
}

/** Read every chunk exactly as Alden would, through the real serializer. */
function readAll(row: MemoryRow, serialize: (data: unknown) => string) {
  const chunks: string[] = [];
  let offset = 0;
  let digest: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const data = readMemoryContentChunk(row, { offset, ...(digest ? { expected_content_sha256: digest } : {}) });
    const wire = serialize(data);
    assert.ok(wire.length <= ALDEN_TOOL_RESULT_LIMIT, `chunk ${i} is ${wire.length} characters`);
    assert.doesNotMatch(wire, /^\[truncated result/);
    const parsed = JSON.parse(wire);
    chunks.push(parsed.content);
    digest ??= parsed.contentSha256;
    if (parsed.complete) return { chunks, digest: parsed.contentSha256 as string };
    assert.equal(parsed.nextOffset, offset + parsed.content.length);
    offset = parsed.nextOffset;
  }
  throw new Error('reader did not finish');
}

test('both memory tools are delivered whole on every Alden path', () => {
  for (const name of ['read_conversation_memories', READ_MEMORY_CONTENT_TOOL]) {
    assert.equal(isCompleteAldenResultTool(name), true, name);
  }
  // An oversized result for a bounded tool is refused, never silently cut.
  assert.throws(() => serializeAldenToolResult(READ_MEMORY_CONTENT_TOOL, { content: 'x'.repeat(20_000) }), /memory_tool_result_too_large/);
});

test('a ~100K row reassembles exactly on the Claude/Gemini and watch-worker paths', () => {
  const content = longText();
  assert.ok(content.length > 99_000 && content.indexOf(LATE) > 90_000);
  const row = { id: ID, content };
  const paths = {
    persona: (data: unknown) => serializeAldenToolResult(READ_MEMORY_CONTENT_TOOL, data),
    watch: (data: unknown) => aldenWatchToolResultContent(READ_MEMORY_CONTENT_TOOL, { data }),
  };
  for (const [name, serialize] of Object.entries(paths)) {
    const { chunks, digest } = readAll(row, serialize);
    const joined = chunks.join('');
    assert.equal(joined, content, name);
    assert.equal(digest, sha(content), name);
    assert.ok(joined.includes(LATE), name);
    assert.ok(chunks.length > 10, `${name}: ${chunks.length} chunks`);
    // No chunk ends between the halves of a surrogate pair.
    for (const chunk of chunks) assert.doesNotMatch(chunk.slice(-1), /[\uD800-\uDBFF]/);
  }
});

test('offsets: both boundaries succeed, anything invalid fails explicitly', () => {
  const content = 'ab😀cd';
  const row = { id: ID, content };
  const digest = sha(content);
  const first = readMemoryContentChunk(row, {});
  assert.deepEqual([first.offset, first.complete, first.nextOffset, first.content], [0, true, null, content]);
  const end = readMemoryContentChunk(row, { offset: content.length, expected_content_sha256: digest });
  assert.deepEqual([end.content, end.complete], ['', true]);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ offset: content.length + 1, expected_content_sha256: digest }, /outside the content/],
    [{ offset: 3, expected_content_sha256: digest }, /splits a surrogate pair/],
    [{ offset: -1 }, /non-negative safe integer/],
    [{ offset: 1.5 }, /non-negative safe integer/],
    [{ offset: '2' }, /non-negative safe integer/],
    [{ offset: 2 }, /must pass expected_content_sha256/],
    [{ offset: 2, expected_content_sha256: 'ABC' }, /64-character lowercase hex/],
  ];
  for (const [args, message] of bad) assert.throws(() => readMemoryContentChunk(row, args), message, JSON.stringify(args));
  assert.throws(() => readMemoryContentChunk(null, {}), /memory_not_found/);
  assert.throws(() => assertMemoryId('not-a-uuid'), /UUID/);
  assert.equal(assertMemoryId(ID), ID);
});

test('a row that changes mid-read is refused, never joined across versions', () => {
  const content = longText();
  const first = readMemoryContentChunk({ id: ID, content }, {});
  assert.equal(first.complete, false);
  // A rolling episode grows between reads.
  const grown = content + '\nDavid: a new line';
  assert.throws(
    () => readMemoryContentChunk({ id: ID, content: grown }, { offset: first.nextOffset, expected_content_sha256: first.contentSha256 }),
    /snapshot_changed[\s\S]*restart at offset 0/,
  );
  // Same digest, same snapshot: the continuation proceeds.
  const next = readMemoryContentChunk({ id: ID, content }, { offset: first.nextOffset, expected_content_sha256: first.contentSha256 });
  assert.equal(next.offset, first.nextOffset);
});

function hugeRow(i: number): MemoryRow {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: '\u0001'.repeat(2_000) + 'T'.repeat(3_000),
    summary: '"'.repeat(30_000) + 'S'.repeat(20_000),
    content: longText(),
    importance: 10,
    created_at: '2026-10-27 04:00:00.123456',
    tags: Array.from({ length: 60 }, (_, t) => `tag-${t}-`.padEnd(200, 'x')),
    entry_type: 'conversation',
    arc_name: 'A'.repeat(150),
    extends_memory_id: ID,
  };
}

test('worst-case discovery fits the budget in every mode, honestly labelled', () => {
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => hugeRow(from + i));
  const modes = {
    // anchor + 10 ancestors + 10 descendants
    related_to: () => buildMemoryDiscovery({ anchor: hugeRow(99), ancestors: rows(10), descendants: rows(10, 10) }, { related_to: ID, totalInChain: 21, note: 'n' }),
    query: () => buildMemoryDiscovery({ memories: rows(15) }, { query: 'q', arc: null, speaker: null, matchCount: 15 }),
    speaker: () => buildMemoryDiscovery({ memories: rows(15) }, { query: null, arc: null, speaker: 'David', matchCount: 15 }, r => String(r.content)),
  };
  for (const [mode, build] of Object.entries(modes)) {
    const data = build() as any;
    for (const serialize of [
      (d: unknown) => serializeAldenToolResult('read_conversation_memories', d),
      (d: unknown) => aldenWatchToolResultContent('read_conversation_memories', { data: d }),
    ]) {
      const wire = serialize(data);
      assert.ok(wire.length <= ALDEN_TOOL_RESULT_LIMIT, `${mode}: ${wire.length}`);
      assert.doesNotMatch(wire, /^\[truncated result/);
    }
    const entries = [...(data.memories ?? []), ...(data.ancestors ?? []), ...(data.descendants ?? []), ...(data.anchor ? [data.anchor] : [])];
    assert.equal(entries.length, mode === 'related_to' ? 21 : 15);
    for (const e of entries) {
      assert.match(e.id, /^[0-9a-f-]{36}$/);
      assert.equal(e.totalCharacters, longText().length);
      assert.equal(e.contentSha256, sha(longText()));
      assert.equal(e.contentComplete, false);
      // A shortened text never sits in the field that means "complete".
      assert.equal('content' in e, false);
      assert.equal(typeof e.contentExcerpt, 'string');
      assert.ok(longText().startsWith(e.contentExcerpt));
      assert.equal(e.titleComplete, false);
      assert.equal(e.summaryComplete, false);
      assert.equal(e.tagsComplete, false);
      assert.equal(e.arcNameComplete, false);
    }
    assert.match(data.readNote, /read_conversation_memory_content/);
  }
});

test('short rows keep their full content in discovery, marked complete', () => {
  const row: MemoryRow = { id: ID, title: 't', summary: 's', content: 'short words 😀', tags: ['a', 'b'] };
  const data = buildMemoryDiscovery({ memories: [row] }, { matchCount: 1 }) as any;
  const e = data.memories[0];
  assert.deepEqual([e.content, e.contentComplete, e.totalCharacters], ['short words 😀', true, 'short words 😀'.length]);
  for (const key of ['contentExcerpt', 'titleComplete', 'summaryComplete', 'tagsComplete']) assert.equal(key in e, false, key);
  assert.deepEqual(e.tags, ['a', 'b']);
});
