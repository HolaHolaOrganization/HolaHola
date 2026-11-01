/**
 * Orientation text must name tools that actually exist. On 2026-10-25 a hat's
 * onboarding prompt named read_coordination_message, which is Alden's tool,
 * not the MCP server's (get_coordination_thread). The authority here is the
 * real registration, recorded from registerCoordinationMcpTools, never a
 * hand-kept list. Offline: no credentials, database or provider calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coordinationMcpToolNames } from '../services/mcp-coordination-tools';
import { buildActorBriefing } from '../services/alden-actor-briefing';

const mcpToolNames = () => [...coordinationMcpToolNames()].sort();

/** Backticked identifiers that look like coordination tools. */
const coordinationToolsNamedIn = (text: string) =>
  [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)*_coordination_[a-z_]+|list_coordination_inbox)`/g)].map((m) => m[1]))].sort();

const quickstart = (() => {
  const doc = readFileSync('docs/runtime-onboarding-clients.md', 'utf8');
  const start = doc.indexOf('## New hat quickstart');
  assert.ok(start >= 0, 'the runbook keeps its New hat quickstart section');
  return doc.slice(start, doc.indexOf('\n## ', start + 1));
})();

const aldenRegistry = readFileSync('server/services/alden-functions.ts', 'utf8');
const aldenHasTool = (name: string) => aldenRegistry.includes(`name: "${name}"`);

test('the MCP server registers the four coordination tools the runbook teaches', () => {
  assert.deepEqual(mcpToolNames(), [
    'create_coordination_thread', 'get_coordination_thread', 'list_coordination_inbox', 'reply_to_coordination_thread',
  ]);
});

test('every coordination tool the quickstart names exists on the MCP server, unless it is marked as Alden-only', () => {
  const mcp = new Set(mcpToolNames());
  const named = coordinationToolsNamedIn(quickstart);
  assert.ok(named.length >= 4, 'the quickstart names the MCP tools');
  for (const name of named) {
    if (mcp.has(name)) continue;
    // The only allowed exception: a tool the quickstart explicitly calls Alden's, which must really be Alden's.
    assert.match(quickstart, new RegExp('`' + name + '` exists only\\s+on Alden'), `${name} is named but is not an MCP tool`);
    assert.ok(aldenHasTool(name), `${name} is described as Alden's but is not on Alden's registry`);
  }
  for (const name of mcp) assert.ok(named.includes(name), `the quickstart omits the MCP tool ${name}`);
});

test('the Alden-only read tool really is Alden-only', () => {
  assert.ok(aldenHasTool('read_coordination_message'));
  assert.ok(!mcpToolNames().includes('read_coordination_message'));
});

test('the quickstart keeps the execution-policy guidance: process-only RemoteSigned, fail closed, no bypass', () => {
  assert.match(quickstart, /-ExecutionPolicy RemoteSigned -File/);
  assert.match(quickstart, /Group Policy still takes precedence/);
  assert.match(quickstart, /fails closed: no\s+`Bypass`/);
});

test('the quickstart and coordination-clients runbook document the four Antigravity IDE worktree and diff-banner rules', () => {
  const clientsDoc = readFileSync('docs/coordination-clients.md', 'utf8');
  for (const doc of [quickstart, clientsDoc]) {
    assert.match(doc, /edit_file/);
    assert.match(doc, /write_file/);
    assert.match(doc, /git worktree add/);
    assert.match(doc, /Accept all/);
    assert.match(doc, /Reject all/);
    assert.match(doc, /git diff --stat origin\/main\.\.\.HEAD/);
  }
});

test("Alden's orientation briefing names exactly the MCP server's real tools, and asks for the hat's base", () => {
  const text = buildActorBriefing([], [], coordinationMcpToolNames());
  assert.deepEqual(coordinationToolsNamedIn(text.replace(/- ([a-z_]+)$/gm, '- `$1`')), mcpToolNames());
  assert.match(text, /use these exact tool names:/);
  assert.match(text, /commit and how far it is from origin\/main/);
  assert.match(text, /New hat quickstart in docs\/runtime-onboarding-clients\.md/);
});
