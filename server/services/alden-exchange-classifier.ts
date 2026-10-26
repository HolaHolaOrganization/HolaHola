/**
 * Second-stage label for an Alden exchange that passed the deterministic
 * prefilter: is it conversation (the human narrative Daniela should be able to
 * recall) or technical work in plain prose? Gemini's stage-2 review
 * (2026-10-25) found the prefilter alone kept technical prose about a third
 * of the time.
 *
 * Internal only: this prompt is never shown to Daniela. Its hash is part of
 * every label's key, so changing it relabels everything.
 */
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';

export const ALDEN_CLASSIFIER_MODEL = 'gemini-3-flash-preview';

export const ALDEN_CLASSIFIER_PROMPT = [
  'You label one exchange between David (a founder) and Alden (his AI development partner).',
  'Decide what the exchange is mainly about:',
  '- conversational: the relationship, feelings, humour, reflection, encouragement, how they work together, personal moments, or the story of what they are building, even when it mentions the product.',
  '- technical: getting technical work done: code, systems, configuration, reviews, debugging, tools, plans for a build, status of tasks.',
  '- mixed: genuinely both, with a real human moment inside technical work.',
  'Reply with JSON only: {"label": "conversational" | "technical" | "mixed"}.',
].join('\n');

export const ALDEN_CLASSIFIER_PROMPT_SHA256 = createHash('sha256').update(ALDEN_CLASSIFIER_PROMPT, 'utf8').digest('hex');

/** Each side is capped for classification only; stored text is never cut. */
const CLASSIFY_SIDE_CHARS = 6000;

export type AldenClassifierLabel = 'conversational' | 'technical' | 'mixed';

export function parseClassifierLabel(raw: string): AldenClassifierLabel | null {
  const match = /\{[\s\S]*\}/.exec(raw ?? '');
  if (!match) return null;
  try {
    const label = JSON.parse(match[0])?.label;
    return label === 'conversational' || label === 'technical' || label === 'mixed' ? label : null;
  } catch {
    return null;
  }
}

let client: GoogleGenAI | null = null;

/** Returns null when Gemini fails or answers unparseably; the caller retries on a later pass. */
export async function classifyAldenExchange(caller: string, reply: string): Promise<AldenClassifierLabel | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  client ??= new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: ALDEN_CLASSIFIER_MODEL,
    contents: [{
      role: 'user',
      parts: [{ text: `${ALDEN_CLASSIFIER_PROMPT}\n\nDavid:\n${caller.slice(0, CLASSIFY_SIDE_CHARS)}\n\nAlden:\n${reply.slice(0, CLASSIFY_SIDE_CHARS)}` }],
    }],
    config: { responseMimeType: 'application/json' },
  });
  return parseClassifierLabel(response.text ?? '');
}
