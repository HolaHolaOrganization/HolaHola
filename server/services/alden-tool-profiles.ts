/**
 * Named Alden tool profiles (gated-fixes design e4f8e988, P3), built on the
 * per-turn allowlist. Each lists exactly the tools the design names; anything
 * else, including request_continuation, is refused at dispatch.
 */
import { makeAldenToolAllowlist, type AldenToolAllowlist } from './alden-tool-allowlist';

/** Read-only memory and express-lane reads shared by both profiles. */
const MEMORY_READS = [
  'search_editor_memories', 'read_conversation_memories', 'read_conversation_memory_content', 'list_conversation_arcs',
] as const;

/**
 * Unattended Sofia triage: P2 reads, propose_fix, the pending proposal route,
 * notify, express lane, steward_pause and update_support_pattern, bound to the
 * pattern this task was started for. No shell, file writes, runtime,
 * credential, onboarding or review tools, and no continuation.
 */
export const TRIAGE_TOOLS: readonly string[] = Object.freeze([
  'read_file', 'search_code', 'list_directory',
  'propose_fix', 'queue_build_proposal',
  'notify_david', 'post_to_express_lane', 'steward_pause',
  'update_support_pattern',
  ...MEMORY_READS, 'search_express_lane', 'read_express_lane_session',
]);

export function triageAllowlist(supportPatternId: string | null): AldenToolAllowlist {
  return makeAldenToolAllowlist('triage', TRIAGE_TOOLS, {
    bindings: { supportPatternId },
    boundArgs: { update_support_pattern: { arg: 'pattern_id', binding: 'supportPatternId' } },
  });
}

/**
 * LR's consult/welcome-only access: read and reply on one specific thread,
 * plus read-only memory reads. No file, shell, write, credential or review
 * tool. The thread is bound server-side; any other thread is refused.
 */
export const CONSULT_WELCOME_TOOLS: readonly string[] = Object.freeze([
  'read_coordination_message', 'reply_to_coordination_thread', ...MEMORY_READS,
]);

export function consultWelcomeAllowlist(threadId: string): AldenToolAllowlist {
  if (!threadId) throw new Error('the consult-welcome profile needs its thread id');
  return makeAldenToolAllowlist('consult-welcome', CONSULT_WELCOME_TOOLS, {
    bindings: { threadId },
    boundArgs: {
      read_coordination_message: { arg: 'thread_id', binding: 'threadId' },
      reply_to_coordination_thread: { arg: 'thread_id', binding: 'threadId' },
    },
  });
}

/**
 * The unattended inbox wake (design eb2ed6bf r11): read, reply, pause and
 * notify only. The reply is bound to the claimed item's thread here, and its
 * recipient to the item's sender by the reply handler. Excluded: interject,
 * brief_new_actor, file reads and code search, request_continuation (a wake
 * turn is exactly one phase), and the chat-only ack and resume tools.
 */
export const WAKE_TOOLS: readonly string[] = Object.freeze([
  'list_coordination_inbox', 'read_coordination_message', 'reply_to_coordination_thread',
  'read_conversation_memories', 'read_conversation_memory_content', 'get_current_episode', 'search_editor_memories',
  'search_express_lane', 'read_express_lane_session',
  'read_agent_notes', 'list_shared_spec_reviews', 'read_shared_spec_review',
  'get_system_health', 'notify_david', 'steward_pause',
  'list_wake_pending',
]);

export function wakeAllowlist(threadId: string): AldenToolAllowlist {
  if (!threadId) throw new Error('the wake profile needs the claimed item\'s thread id');
  return makeAldenToolAllowlist('wake', WAKE_TOOLS, {
    bindings: { threadId },
    boundArgs: { reply_to_coordination_thread: { arg: 'thread_id', binding: 'threadId' } },
  });
}
