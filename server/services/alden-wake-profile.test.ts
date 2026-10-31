/**
 * The wake tool profile (design eb2ed6bf r11): exactly the unattended tools
 * the design names, the reply bound to the claimed item's thread, and every
 * other tool refused at dispatch, including continuation and the chat-only
 * ack and resume tools.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { aldenToolRefusal } from './alden-tool-allowlist';
import { WAKE_TOOLS, wakeAllowlist } from './alden-tool-profiles';

test('the wake profile lists exactly the design\'s unattended tools', () => {
  assert.deepEqual([...WAKE_TOOLS].sort(), [
    'get_current_episode', 'get_system_health', 'list_coordination_inbox', 'list_shared_spec_reviews', 'list_wake_pending',
    'notify_david', 'read_agent_notes', 'read_conversation_memories', 'read_conversation_memory_content', 'read_coordination_message',
    'read_express_lane_session', 'read_shared_spec_review', 'reply_to_coordination_thread', 'search_editor_memories',
    'search_express_lane', 'steward_pause',
  ]);
});

test('excluded tools are refused; steward_pause and notify_david are allowed', () => {
  const allowlist = wakeAllowlist('thread-1');
  for (const tool of ['interject_on_coordination_thread', 'brief_new_actor', 'read_file', 'search_code', 'request_continuation',
    'ack_coordination_item', 'resume_wake_thread', 'propose_fix', 'apply_code_change', 'run_shell', 'create_coordination_thread']) {
    assert.equal(aldenToolRefusal(tool, allowlist, {})?.refused, 'tool_not_allowed', tool);
  }
  assert.equal(aldenToolRefusal('steward_pause', allowlist, { friction: 'x', question: 'y' }), null);
  assert.equal(aldenToolRefusal('notify_david', allowlist, { message: 'x' }), null);
});

test('the reply is bound to the claimed item\'s thread', () => {
  const allowlist = wakeAllowlist('thread-1');
  assert.equal(aldenToolRefusal('reply_to_coordination_thread', allowlist, { thread_id: 'thread-1' }), null);
  assert.equal(aldenToolRefusal('reply_to_coordination_thread', allowlist, { thread_id: 'thread-2' })?.refused, 'tool_binding_mismatch');
  assert.throws(() => wakeAllowlist(''), /needs the claimed item/);
});
