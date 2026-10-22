/**
 * Who wrote a transcript entry of type "user"? The Claude Code runtime injects
 * its own entries with that type: background-task notices, system reminders,
 * scheduled-task prompts, the safety-classifier notice, image metadata and
 * slash-command records. The Stop hook must never record one of these as
 * David's words.
 *
 * The transcript's own provenance fields decide first:
 * - `isMeta: true` or `isCompactSummary: true` is runtime material;
 * - `origin.kind` names the author: "human" is the founder, any other value
 *   (for example "task-notification") is the runtime;
 * - `promptSource: "system"` is the runtime.
 * A founder message whose text happens to look like a notice (a paste, say)
 * still carries origin "human" and is kept. Only an entry with no provenance
 * fields at all (an older transcript format) falls back to the exact opening
 * bytes of the known runtime kinds.
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

/**
 * Classify a "user" entry. `text` is the entry's extracted text, used only
 * when the entry carries no provenance fields.
 * @returns {{ founder: boolean, basis: string }}
 */
export function classifyUserEntry(entry, text) {
  if (entry?.isMeta === true) return { founder: false, basis: 'isMeta' };
  if (entry?.isCompactSummary === true) return { founder: false, basis: 'isCompactSummary' };
  const originKind = entry?.origin?.kind;
  if (typeof originKind === 'string') {
    return originKind === 'human'
      ? { founder: true, basis: 'origin:human' }
      : { founder: false, basis: `origin:${originKind}` };
  }
  if (entry?.promptSource === 'system') return { founder: false, basis: 'promptSource:system' };
  return isRuntimeInjectedText(text)
    ? { founder: false, basis: 'opener (no provenance fields)' }
    : { founder: true, basis: 'no provenance fields' };
}
