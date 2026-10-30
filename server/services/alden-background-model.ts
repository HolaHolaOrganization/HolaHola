/**
 * Model settings for Alden's background routines (watch, repair proposal,
 * digest, auto-repair, code review). Founder decision 2026-10-29: Claude Sonnet 5.5, not the Opus model
 * his chat uses. These are short routine calls, so thinking runs only between
 * tool calls and effort is medium; Sonnet 5.5 rejects thinking "disabled".
 */
export const ALDEN_BACKGROUND_MODEL = 'claude-sonnet-5-5';

export const ALDEN_BACKGROUND_THINKING = {
  thinking: { type: 'between_tools' },
  output_config: { effort: 'medium' },
} as Record<string, unknown>;
