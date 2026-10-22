/**
 * Who wrote a transcript entry of type "user"? The Claude Code runtime injects
 * its own entries with that type: background-task notices, system reminders,
 * scheduled-task prompts, the safety-classifier notice, image metadata and
 * slash-command records. The Stop hook must never record one of these as
 * David's words.
 *
 * Only the transcript's own provenance fields decide, never the text's shape,
 * so a founder message that looks like a notice (a paste) is still David's:
 * - `isMeta: true` or `isCompactSummary: true` is runtime material;
 * - `origin.kind` names the author: "human" is the founder, any other value
 *   (for example "task-notification") is the runtime;
 * - with no `origin`, `turnOrigin` ("human" or another value) decides, then
 *   `promptSource` ("sdk" is the founder, "system" the runtime).
 * An entry with none of these fields (an older transcript format) keeps the
 * hook's original rule and is treated as the founder's, as before; the basis
 * says so, so a caller can tell a legacy decision from an evidenced one.
 */

/**
 * Classify a "user" entry from its provenance fields.
 * @returns {{ founder: boolean, basis: string }}
 */
export function classifyUserEntry(entry) {
  if (entry?.isMeta === true) return { founder: false, basis: 'isMeta' };
  if (entry?.isCompactSummary === true) return { founder: false, basis: 'isCompactSummary' };
  const originKind = entry?.origin?.kind;
  if (typeof originKind === 'string') {
    return { founder: originKind === 'human', basis: `origin:${originKind}` };
  }
  if (typeof entry?.turnOrigin === 'string') {
    return { founder: entry.turnOrigin === 'human', basis: `turnOrigin:${entry.turnOrigin}` };
  }
  if (entry?.promptSource === 'sdk') return { founder: true, basis: 'promptSource:sdk' };
  if (entry?.promptSource === 'system') return { founder: false, basis: 'promptSource:system' };
  return { founder: true, basis: 'no provenance fields (legacy rule)' };
}
