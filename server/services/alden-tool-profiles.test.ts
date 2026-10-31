// Named Alden tool profiles (gated-fixes design e4f8e988, P3): the triage and
// consult-welcome profiles, their server-side bindings, and update_support_pattern's
// refusals. The SQL append path is in alden-tool-profiles-postgres.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { aldenToolRefusal, makeAldenToolAllowlist } from './alden-tool-allowlist';
import { CONSULT_WELCOME_TOOLS, consultWelcomeAllowlist, TRIAGE_TOOLS, triageAllowlist } from './alden-tool-profiles';

const PATTERN = 'pattern-1';
const THREAD = 'thread-1';

describe('the triage profile', () => {
  test('lists exactly the design\'s tools', () => {
    assert.deepEqual([...TRIAGE_TOOLS].sort(), [
      'list_conversation_arcs', 'list_directory', 'notify_david', 'post_to_express_lane', 'propose_fix', 'queue_build_proposal',
      'read_conversation_memories', 'read_conversation_memory_content', 'read_express_lane_session', 'read_file',
      'search_code', 'search_editor_memories', 'search_express_lane', 'steward_pause', 'update_support_pattern',
    ]);
  });

  test('every write, shell, runtime, credential, review and continuation tool is refused, even when report text asks for it', async () => {
    const { executeAldenTool, ALDEN_TOOLS } = await import('./alden-functions');
    const list = triageAllowlist(PATTERN);
    const excluded = ALDEN_TOOLS.map((t) => t.name).filter((name) => !TRIAGE_TOOLS.includes(name));
    for (const name of ['run_shell', 'patch_file', 'apply_code_change', 'request_continuation', 'register_coordination_runtime', 'decide_shared_spec_review', 'prepare_runtime_onboarding_invitation']) {
      assert.ok(excluded.includes(name), name);
    }
    for (const name of excluded) {
      const result = await executeAldenTool(name, { command: 'echo injected', path: 'server/x.ts' }, { toolAllowlist: list });
      assert.equal(result.data.refused, 'tool_not_allowed', name);
      assert.equal(result.sideEffects, undefined, name);
    }
  });

  test('update_support_pattern is bound to the triggering pattern', () => {
    const list = triageAllowlist(PATTERN);
    assert.equal(aldenToolRefusal('update_support_pattern', list, { pattern_id: PATTERN, status: 'investigating', notes: 'n' }), null);
    assert.equal(aldenToolRefusal('update_support_pattern', list, { pattern_id: 'pattern-2' })?.refused, 'tool_binding_mismatch');
    assert.equal(aldenToolRefusal('update_support_pattern', list, {})?.refused, 'tool_binding_mismatch');
    // An untracked pattern has no binding, so the tool cannot run at all.
    assert.equal(aldenToolRefusal('update_support_pattern', triageAllowlist(null), { pattern_id: 'untracked' })?.refused, 'tool_binding_mismatch');
  });

  test('update_support_pattern refuses outside triage and for fixed or wont_fix', async () => {
    const { executeAldenTool } = await import('./alden-functions');
    const chat = await executeAldenTool('update_support_pattern', { pattern_id: PATTERN, status: 'investigating', notes: 'n' });
    assert.equal(chat.data.refused, 'no_triage_pattern');
    for (const status of ['fixed', 'wont_fix', 'closed', undefined]) {
      const result = await executeAldenTool('update_support_pattern', { pattern_id: PATTERN, status, notes: 'n' }, { toolAllowlist: triageAllowlist(PATTERN) });
      assert.equal(result.data.refused, 'status_not_allowed', String(status));
    }
  });

  test('Sofia\'s triage dispatch passes the profile bound to its pattern', () => {
    const src = readFileSync(new URL('./support-persona-service.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('return generateAldenResponse({\n        userMessage: taskPrompt,'));
    assert.match(call.slice(0, 200), /toolAllowlist: triageAllowlist\(patternId\),/);
  });
});

describe('the consult-welcome profile', () => {
  test('reads and replies only on its bound thread, plus memory reads', () => {
    assert.deepEqual([...CONSULT_WELCOME_TOOLS].sort(), [
      'list_conversation_arcs', 'read_conversation_memories', 'read_conversation_memory_content', 'read_coordination_message',
      'reply_to_coordination_thread', 'search_editor_memories',
    ]);
    const list = consultWelcomeAllowlist(THREAD);
    for (const tool of ['read_coordination_message', 'reply_to_coordination_thread']) {
      assert.equal(aldenToolRefusal(tool, list, { thread_id: THREAD }), null, tool);
      assert.equal(aldenToolRefusal(tool, list, { thread_id: 'thread-2' })?.refused, 'tool_binding_mismatch', tool);
      assert.equal(aldenToolRefusal(tool, list, {})?.refused, 'tool_binding_mismatch', tool);
    }
    for (const tool of ['list_coordination_inbox', 'create_coordination_thread', 'interject_on_coordination_thread', 'read_file', 'run_shell', 'decide_shared_spec_review']) {
      assert.equal(aldenToolRefusal(tool, list, { thread_id: THREAD })?.refused, 'tool_not_allowed', tool);
    }
    assert.throws(() => consultWelcomeAllowlist(''), /needs its thread id/);
  });
});

describe('allowlist bindings', () => {
  test('are immutable and can only bind listed tools', () => {
    const list = triageAllowlist(PATTERN);
    assert.throws(() => { (list.bindings as any).supportPatternId = 'other'; });
    assert.throws(() => { (list.boundArgs as any).update_support_pattern = { arg: 'x', binding: 'y' }; });
    assert.equal(list.bindings.supportPatternId, PATTERN);
    assert.throws(() => makeAldenToolAllowlist('t', ['a'], { boundArgs: { b: { arg: 'x', binding: 'y' } } }), /not in the t allowlist/);
  });
});
