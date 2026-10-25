/**
 * Pure transcript helpers for syncing Alden's conversations (alden_messages)
 * into conversation_memories alongside the founder↔Daniela chats.
 * See founder-chat-sync.ts for the worker that uses them.
 */

export type AldenMessageRow = { role: string; content: string };

/**
 * Speaker label for an alden_messages role. Roles seen in production:
 * david, luca (Luca [Replit] calling Alden), alden, alden-<engine> (multi-engine
 * priority calls), daniela. Unknown roles keep their raw value so nothing is
 * silently relabelled as someone else.
 */
export function aldenSpeakerLabel(role: string): string {
  if (role === 'david') return 'David';
  if (role === 'luca') return 'Luca [Replit]';
  if (role === 'daniela') return 'Daniela';
  if (role === 'alden') return 'Alden';
  const engine = /^alden-([a-z0-9_-]+)$/i.exec(role);
  if (engine) return `Alden [${engine[1]}]`;
  return role;
}

/** Participants line, in first-appearance order: e.g. "David + Alden". */
export function aldenParticipants(messages: readonly AldenMessageRow[]): string {
  const seen: string[] = [];
  for (const m of messages) {
    const label = aldenSpeakerLabel(m.role).replace(/ \[[^\]]+\]$/, '');
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(' + ');
}

/**
 * Verbatim transcript: each message as "<Speaker>: <content>", blank-line
 * separated, in the order given. `clean` is the founder-chat sanitizer; a
 * message it reduces to nothing is skipped, exactly as for Daniela chats.
 */
export function formatAldenTranscript(
  messages: readonly AldenMessageRow[],
  clean: (raw: string) => string | null,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    const text = clean(m.content);
    if (!text) continue;
    lines.push(`${aldenSpeakerLabel(m.role)}: ${text}`);
  }
  return lines.join('\n\n');
}
