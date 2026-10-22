/**
 * Transcript entries the Claude Code runtime injects with type "user" that the
 * founder did not write: background-task notices, system reminders, scheduled
 * task prompts, the safety-classifier notice and slash-command records. The
 * Stop hook must never record one of these as David's words.
 *
 * Each kind is identified by the exact bytes its text opens with, never by
 * guessing at authorship. Founder messages arrive as their own entries; the
 * runtime does not mix these into the same entry.
 */
export const RUNTIME_ENTRY_OPENERS = Object.freeze([
  '<task-notification>',
  '<system-reminder>',
  '<scheduled-task',
  '[SYSTEM NOTIFICATION',
  'Your response above was stopped by a safety classifier',
  '<command-name>',
  '<command-message>',
  '<local-command-',
]);

/** True when the entry text opens with a runtime-injected kind's exact bytes. */
export function isRuntimeInjectedText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  return RUNTIME_ENTRY_OPENERS.some(opener => trimmed.startsWith(opener));
}
