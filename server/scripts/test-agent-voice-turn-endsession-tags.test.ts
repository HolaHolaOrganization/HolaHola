/**
 * The agent-voice-turn endSession save bound its tags as `${tags}::text[]`.
 * drizzle's sql template expands a JS array into a tuple of separate
 * parameters, so that INSERT failed on every call; sessions survived only
 * through the production-only one-hour expiry sweep. These tests pin the
 * mechanism and the fix without a database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const tags = ['agent-daniela', 'agent-voice-turn', 'with "quote" and \\ backslash'];

test('a bare JS array with ::text[] renders as a tuple, not an array (the bug)', () => {
  const rendered = dialect.sqlToQuery(sql`${tags}::text[]`);
  assert.equal(rendered.sql, '($1, $2, $3)::text[]');
});

test('the JSON form binds exactly one parameter carrying every tag byte for byte', () => {
  const rendered = dialect.sqlToQuery(sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(tags)}::jsonb))::text[]`);
  assert.equal(rendered.params.length, 1);
  assert.deepEqual(JSON.parse(rendered.params[0] as string), tags);
});

test('the agent-voice-turn route no longer binds a bare array as text[]', () => {
  const source = readFileSync(new URL('../routes.ts', import.meta.url), 'utf8');
  const start = source.indexOf('app.post("/api/admin/agent-voice-turn"');
  const route = source.slice(start, source.indexOf('app.get("/api/admin/google-voices', start));
  assert.ok(start >= 0 && route.length > 0);
  assert.doesNotMatch(route, /\$\{tags\}::text\[\]/);
  assert.match(route, /jsonb_array_elements_text\(\$\{JSON\.stringify\(tags\)\}::jsonb\)/);
});
