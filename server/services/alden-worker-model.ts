/**
 * The model Alden's background workers (watch, auto-repair, code review,
 * digest) run on, and how they call it. Founder-authorized move from
 * claude-sonnet-4-5, 2026-10-25/26; Alden's own conversation engine is
 * separate (alden-persona-service.ts).
 *
 * Claude Sonnet 5.5 thinks adaptively by default, so a reply can start with a
 * thinking block (empty text under the default display) and thinking counts
 * toward max_tokens. Callers therefore read the reply by block type, never
 * content[0], and leave max_tokens room for thinking as well as the answer.
 */
export const ALDEN_WORKER_MODEL = 'claude-sonnet-5-5';

// Effort is the only depth control. Short verdicts (classify, summarize) run at
// low, where the model skips thinking on most simple requests; work that
// reasons over code or tool results runs at medium. The installed SDK (0.71)
// predates output_config's types, so the field is sent as-is, as in
// alden-persona-service.ts.
export const ALDEN_WORKER_LOW_EFFORT = { output_config: { effort: 'low' } } as Record<string, unknown>;
export const ALDEN_WORKER_MEDIUM_EFFORT = { output_config: { effort: 'medium' } } as Record<string, unknown>;

/** The first text block's text, trimmed, or '' when the reply has none (e.g. only thinking, or a refusal). */
export function aldenWorkerText(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  const block = content?.find((b) => b.type === 'text');
  return typeof block?.text === 'string' ? block.text.trim() : '';
}
