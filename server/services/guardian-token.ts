import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Shared check for the internal x-guardian-token header.
 *
 * Fails closed: when GUARDIAN_TOKEN is unset or blank, no request is
 * accepted. The previous inline `token !== GUARDIAN_TOKEN` check allowed any
 * header-less request whenever the variable was missing, because
 * `undefined !== undefined` is false.
 *
 * The configured value is read at call time so a rotated secret takes effect
 * without depending on module-load order. Both sides are hashed before the
 * constant-time comparison, so neither length nor content leaks through timing.
 */
export function isValidGuardianToken(
  header: unknown,
  configured: string | undefined = process.env.GUARDIAN_TOKEN,
): boolean {
  if (typeof configured !== 'string' || configured.trim() === '') return false;
  if (typeof header !== 'string' || header === '') return false;
  const expected = createHash('sha256').update(configured).digest();
  const actual = createHash('sha256').update(header).digest();
  return timingSafeEqual(expected, actual);
}
