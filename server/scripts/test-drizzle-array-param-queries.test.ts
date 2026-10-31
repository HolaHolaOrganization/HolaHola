/**
 * Drizzle's `sql` template tag expands a bare JS array (`${arr}::text[]` or
 * `ANY(${arr}::uuid[])`) into a parenthesized tuple `($1, $2, ...)`, which
 * fails at runtime in PostgreSQL (`cannot cast type record to uuid[]` /
 * `op ANY/ALL (array) requires array on right side`), and fails silently
 * wherever the caller catches the error.
 *
 * These database-free tests verify the four conversation_memories array-bind
 * sites across native-fc-handlers.ts, alden-functions.ts, routes.ts, and
 * team-room-agent-worker.ts by extracting each site's SQL template and
 * rendering it through `new PgDialect().sqlToQuery(...)`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const chainIds = ['3ed91a36-0000-4000-8000-000000000001', 'e26a9c48-0000-4000-8000-000000000002', 'a1b2c3d4-0000-4000-8000-000000000003'];
const relatedTo = chainIds[0];
const pinnedIds = ['3ed91a36', 'e26a9c48'];

function extractTemplateLiteral(section: string, tagPrefix: 'sql`' | 'drizzleSql`'): string {
  const start = section.indexOf(tagPrefix);
  assert.ok(start >= 0, `expected ${tagPrefix} in section`);
  const bodyStart = start + tagPrefix.length;
  let depth = 0;
  for (let i = bodyStart; i < section.length; i++) {
    if (section[i] === '$' && section[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }
    if (depth > 0) {
      if (section[i] === '{') depth++;
      else if (section[i] === '}') depth--;
      continue;
    }
    if (section[i] === '`') {
      return section.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${tagPrefix} template literal`);
}

test('a bare JS array inside ANY(${arr}::uuid[]) expands into a tuple instead of one array parameter (the bug)', () => {
  const rendered = dialect.sqlToQuery(sql`WHERE extends_memory_id = ANY(${chainIds}::uuid[])`);
  assert.equal(rendered.sql, 'WHERE extends_memory_id = ANY(($1, $2, $3)::uuid[])');
  assert.equal(rendered.params.length, 3);
});

test('native-fc-handlers.ts processIntrospectChain binds chainIds as one JSON array parameter', () => {
  const source = readFileSync(new URL('../services/native-fc-handlers.ts', import.meta.url), 'utf8');
  const fnStart = source.indexOf('private async processIntrospectChain(');
  const fnEnd = source.indexOf('private async processIntrospectSpeaker(', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const fnBody = source.slice(fnStart, fnEnd);
  assert.doesNotMatch(fnBody, /\$\{chainIds\}::uuid\[\]/);

  const descendantsMarker = fnBody.indexOf('const descendants = await db.execute(');
  assert.ok(descendantsMarker >= 0);
  const expr = extractTemplateLiteral(fnBody.slice(descendantsMarker), 'sql`');
  const query = new Function('sql', 'chainIds', 'relatedTo', `return ${expr};`)(sql, chainIds, relatedTo);
  const rendered = dialect.sqlToQuery(query);

  assert.match(rendered.sql, /extends_memory_id = ANY\(ARRAY\(SELECT jsonb_array_elements_text\(\$1::jsonb\)\)::text\[\]\)/);
  assert.equal(rendered.params.length, 2, 'one JSON array parameter plus relatedTo');
  assert.deepEqual(JSON.parse(rendered.params[0] as string), chainIds);
  assert.equal(rendered.params[1], relatedTo);
});

test('alden-functions.ts read_conversation_memories related_to binds chainIds as one JSON array parameter', () => {
  const source = readFileSync(new URL('../services/alden-functions.ts', import.meta.url), 'utf8');
  const start = source.indexOf('case "read_conversation_memories":');
  const end = source.indexOf('const hasQuery = query && typeof query === \'string\'', start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);
  assert.doesNotMatch(section, /\$\{chainIds\}::uuid\[\]/);

  const descendantsMarker = section.indexOf('const descendants = await sharedDb.execute(');
  assert.ok(descendantsMarker >= 0);
  const expr = extractTemplateLiteral(section.slice(descendantsMarker), 'sql`');
  const query = new Function('sql', 'chainIds', 'related_to', `return ${expr};`)(sql, chainIds, relatedTo);
  const rendered = dialect.sqlToQuery(query);

  assert.match(rendered.sql, /extends_memory_id = ANY\(ARRAY\(SELECT jsonb_array_elements_text\(\$1::jsonb\)\)::text\[\]\)/);
  assert.equal(rendered.params.length, 2, 'one JSON array parameter plus related_to');
  assert.deepEqual(JSON.parse(rendered.params[0] as string), chainIds);
  assert.equal(rendered.params[1], relatedTo);
});

test('routes.ts GET /api/luca/search relatedTo binds chainIds as one JSON array parameter', () => {
  const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf('app.get("/api/luca/search"');
  const end = source.indexOf('// ── default path: keyword search across all three phases', start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);
  assert.doesNotMatch(section, /\$\{chainIds\}::uuid\[\]/);

  const descendantsMarker = section.indexOf('const descendants = await db.execute(');
  assert.ok(descendantsMarker >= 0);
  const expr = extractTemplateLiteral(section.slice(descendantsMarker), 'drizzleSql`');
  const query = new Function('drizzleSql', 'chainIds', 'relatedTo', `return ${expr};`)(sql, chainIds, relatedTo);
  const rendered = dialect.sqlToQuery(query);

  assert.match(rendered.sql, /extends_memory_id = ANY\(ARRAY\(SELECT jsonb_array_elements_text\(\$1::jsonb\)\)::text\[\]\)/);
  assert.equal(rendered.params.length, 2, 'one JSON array parameter plus relatedTo');
  assert.deepEqual(JSON.parse(rendered.params[0] as string), chainIds);
  assert.equal(rendered.params[1], relatedTo);
});

test('team-room-agent-worker.ts loadRoomMemories binds 8-char PINNED_MEMORY_IDS as JSONB prefixes and matches 36-char UUIDs via LIKE', () => {
  const source = readFileSync(new URL('../services/team-room-agent-worker.ts', import.meta.url), 'utf8');
  const pinnedArrayMatch = source.match(/const PINNED_MEMORY_IDS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(pinnedArrayMatch, 'expected PINNED_MEMORY_IDS constant in team-room-agent-worker.ts');
  const actualPinnedPrefixes = [...pinnedArrayMatch[1].matchAll(/'([0-9a-f]{8})'/g)].map((m) => m[1]);
  assert.deepEqual(actualPinnedPrefixes, pinnedIds, 'PINNED_MEMORY_IDS holds 8-char hex UUID prefixes');

  const start = source.indexOf('async function loadRoomMemories(');
  const end = source.indexOf('async function buildSystemPrompt(', start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);
  assert.doesNotMatch(section, /\$\{PINNED_MEMORY_IDS\}::uuid\[\]/);
  assert.doesNotMatch(section, /id\s*=\s*ANY\(/, 'must not compare 36-char id for exact equality against 8-char prefixes');

  const pinnedMarker = section.indexOf('const pinnedRows =');
  assert.ok(pinnedMarker >= 0);
  const expr = extractTemplateLiteral(section.slice(pinnedMarker), 'sql`');
  const query = new Function('sql', 'PINNED_MEMORY_IDS', `return ${expr};`)(sql, actualPinnedPrefixes);
  const rendered = dialect.sqlToQuery(query);

  assert.equal(
    rendered.sql,
    "EXISTS (SELECT 1 FROM jsonb_array_elements_text($1::jsonb) AS p WHERE id LIKE p || '%')",
  );
  assert.equal(rendered.params.length, 1, 'exactly one JSONB array parameter');
  const boundPrefixes = JSON.parse(rendered.params[0] as string) as string[];
  assert.deepEqual(boundPrefixes, actualPinnedPrefixes);

  // Verify the SQL predicate semantics against real 36-char conversation_memories.id values:
  // exact equality (`id = ANY(...)`) silently returns 0 rows, whereas `id LIKE p || '%'` matches both pinned memories.
  const fullMemoryRows = [
    { id: '3ed91a36-6c4e-4b9f-9a12-111111111111', title: 'Daniela White Wall' },
    { id: 'e26a9c48-8d2a-4c3e-b456-222222222222', title: 'The Three-Way Vision' },
    { id: 'a1b2c3d4-0000-4000-8000-000000000003', title: 'Unrelated session' },
  ];
  const exactAnyMatches = fullMemoryRows.filter((row) => boundPrefixes.includes(row.id));
  assert.equal(exactAnyMatches.length, 0, 'exact equality against 8-char prefixes matches 0 full 36-char UUIDs');

  const likePrefixMatches = fullMemoryRows.filter((row) =>
    boundPrefixes.some((p) => row.id.startsWith(p)),
  );
  assert.deepEqual(
    likePrefixMatches.map((r) => r.id),
    [
      '3ed91a36-6c4e-4b9f-9a12-111111111111',
      'e26a9c48-8d2a-4c3e-b456-222222222222',
    ],
  );
});
