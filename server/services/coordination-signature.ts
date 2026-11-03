/**
 * A coordination message may open with a sender signature in the
 * "Sender -> Recipient" form. The server already knows who posted it (the
 * authenticated actor), so a signature naming anyone else is refused, for
 * every hat alike (founder, 2026-11-03). Only the opening signature is
 * checked: mentioning or quoting another hat later in a message is fine.
 * No database access, so callers can check before any ledger work.
 */
import type { CoordinationActorId } from '@shared/schema';

/** The name each actor signs with. */
export const SIGNATURE_NAMES: Readonly<Record<string, CoordinationActorId>> = Object.freeze({
  'luca [holahola]': 'luca-holahola',
  'luca [replit]': 'luca-replit',
  'luca [claude code]': 'luca-claude-code',
  'luca [gemini]': 'luca-gemini',
  'luca [antigravity]': 'luca-antigravity',
  'luca [cursor]': 'luca-cursor',
  'luca [openai agents]': 'luca-openai-agents',
  'luca [codex]': 'luca-codex',
  alden: 'alden',
  daniela: 'daniela',
  david: 'david',
});

// Optional markdown emphasis, the sender name, an optional bracketed role
// ("Alden [Steward]"), then the arrow.
const OPENING_SIGNATURE = /^[\s*_>#]*(Luca \[[^\]\n]{1,40}\]|Alden|Daniela|David)[*_]*(?:\s*\[[^\]\n]{1,40}\])?[*_]*\s*(?:->|→)/i;

export interface SignatureRefusal {
  error: string;
  refused: 'signature_actor_mismatch';
  signedAs: string;
}

/**
 * Null when the message carries no opening signature or signs as the poster.
 * coordination-system relays other records and is exempt.
 */
export function signatureRefusal(content: string, actor: string): SignatureRefusal | null {
  if (actor === 'coordination-system') return null;
  const match = OPENING_SIGNATURE.exec(content);
  if (!match) return null;
  const signedAs = match[1];
  if (SIGNATURE_NAMES[signedAs.toLowerCase().replace(/\s+/g, ' ')] === actor) return null;
  return {
    error: `This message opens signed as "${signedAs}", but it is being posted by ${actor}. Sign only as yourself, or start without a signature.`,
    refused: 'signature_actor_mismatch',
    signedAs,
  };
}
