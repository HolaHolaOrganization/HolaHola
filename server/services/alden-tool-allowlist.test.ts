// Per-turn tool allowlist for Alden: immutable, enforced in executeAldenTool for
// both engines and nested dispatch, and carried forward on continuation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { aldenToolRefusal, makeAldenToolAllowlist } from './alden-tool-allowlist';

describe('the allowlist itself', () => {
  test('lists exactly the named tools, sorted and deduplicated', () => {
    const list = makeAldenToolAllowlist('wake', ['notify_david', 'read_agent_notes', 'notify_david']);
    assert.deepEqual(list.names, ['notify_david', 'read_agent_notes']);
    assert.equal(list.has('notify_david'), true);
    assert.equal(list.has('run_shell'), false);
  });

  test('cannot be widened by any code path in the turn', () => {
    const list = makeAldenToolAllowlist('wake', ['notify_david']);
    assert.throws(() => { (list.names as string[]).push('run_shell'); });
    assert.throws(() => { (list as any).has = () => true; });
    assert.equal(list.has('run_shell'), false);
  });

  test('refusal is null without an allowlist or for a listed tool, and explicit otherwise', () => {
    const list = makeAldenToolAllowlist('wake', ['notify_david']);
    assert.equal(aldenToolRefusal('run_shell', undefined), null);
    assert.equal(aldenToolRefusal('notify_david', list), null);
    assert.deepEqual(aldenToolRefusal('run_shell', list), {
      error: 'The tool "run_shell" is not available in this turn (wake).', refused: 'tool_not_allowed', allowlist: 'wake',
    });
    assert.throws(() => makeAldenToolAllowlist('', []), /needs a label/);
  });
});

describe('enforcement in executeAldenTool', () => {
  test('an unlisted tool is refused before any tool code runs', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    const list = makeAldenToolAllowlist('test', ['notify_david']);
    for (const tool of ['run_shell', 'patch_file', 'apply_code_change', 'request_continuation']) {
      const result = await executeAldenTool(tool, { command: 'echo should-not-run' }, { toolAllowlist: list });
      assert.equal(result.data.refused, 'tool_not_allowed', tool);
      assert.equal(result.sideEffects, undefined, `${tool} produced no side effects`);
    }
  });

  test('nested dispatch carries the allowlist: an allowed tool cannot reach an unlisted one', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    const list = makeAldenToolAllowlist('test', ['post_report_to_team_room']);
    const result = await executeAldenTool('post_report_to_team_room', { hours: 1 }, { toolAllowlist: list });
    // get_ai_cost_report is refused inside, so the outer tool posts nothing.
    assert.deepEqual(result.data, { error: 'Failed to generate cost report' });
  });
});

describe('wiring in both engines', () => {
  const persona = readFileSync(new URL('./alden-persona-service.ts', import.meta.url), 'utf8');
  const functions = readFileSync(new URL('./alden-functions.ts', import.meta.url), 'utf8');

  test('executeAldenTool checks the allowlist before its tool switch', () => {
    const start = functions.indexOf('export async function executeAldenTool(');
    const gate = functions.indexOf('aldenToolRefusal(toolName, context?.toolAllowlist, args)', start);
    const sw = functions.indexOf('switch (toolName)', start);
    assert.ok(start > 0 && gate > start && gate < sw);
  });

  test('both engines pass the allowlist to dispatch and filter the model-visible tool list', () => {
    assert.equal(persona.match(/toolAllowlist: params\.toolAllowlist \}\);/g)?.length, 2);
    assert.match(persona, /toAnthropicAldenTools\(\)\.filter\(\(tool\) => !params\.toolAllowlist \|\| params\.toolAllowlist\.has\(tool\.name\)\)/);
    assert.match(persona, /toGeminiFunctions\(ALDEN_TOOLS\.filter\(\(tool\) => !params\.toolAllowlist \|\| params\.toolAllowlist\.has\(tool\.name\)\)\)/);
  });

  test('the turn result returns the same allowlist for a continuation phase', () => {
    assert.equal(persona.match(/toolAllowlist: params\.toolAllowlist \};/g)?.length, 2);
  });
});
