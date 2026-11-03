import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { getSharedDb } from '../db';
import { sql } from 'drizzle-orm';

function rateLimitHandler(req: Request, res: Response) {
  const userId = (req as any).user?.id;
  const key = userId ? `user:${userId}` : `ip:${req.ip}`;
  console.warn(`[Rate Limit] Exceeded for ${key} on ${req.path}`);

  // Persist rate-limit hits so Alden/Sofia can detect scraping or abuse patterns.
  const payload = JSON.stringify({ key, path: req.path, method: req.method });
  getSharedDb().execute(sql`
    INSERT INTO voice_pipeline_events (id, session_id, user_id, event_type, event_data, created_at)
    VALUES (gen_random_uuid(), null, ${String(userId ?? '')}, 'rate_limit_exceeded', ${payload}::jsonb, NOW())
  `).catch(() => {});

  res.status(429).json({
    error: 'Too many requests',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
}

function userOrIpKey(req: Request): string {
  const userId = (req as any).user?.id;
  return userId || req.ip || 'unknown';
}

const userKeyedDefaults = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: userOrIpKey,
  validate: { keyGeneratorIpFallback: false },
} as const;

export const generalLimiter = rateLimit({
  ...userKeyedDefaults,
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests, please try again after 15 minutes',
  skip: () => process.env.NODE_ENV === 'development',
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: 'Too many login attempts, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: () => process.env.NODE_ENV === 'development',
});

export const aiLimiter = rateLimit({
  ...userKeyedDefaults,
  windowMs: 60 * 1000,
  max: 100,
  message: 'Too many AI requests, please wait a moment before trying again',
  skip: () => process.env.NODE_ENV === 'development',
});

export const voiceLimiter = rateLimit({
  ...userKeyedDefaults,
  windowMs: 60 * 1000,
  max: 200,
  message: 'Too many voice requests, please wait a moment before trying again',
  skip: () => process.env.NODE_ENV === 'development',
});

export const mutationLimiter = rateLimit({
  ...userKeyedDefaults,
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many modification requests, please try again later',
  skip: () => process.env.NODE_ENV === 'development',
});

export const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many attempts for this sensitive operation, please try again after an hour',
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skip: () => process.env.NODE_ENV === 'development',
});

// Credential renewal and GitHub token minting happen after authentication,
// so they are limited per authenticated runtime (renewal) or actor (minting)
// rather than per IP: several hats on one machine share an IP, and one shared
// 10/hour bucket let one hat's PR work starve every hat's renewals (founder,
// 2026-11-03). Each route keeps its own bucket. A generous per-IP guard still
// runs before authentication on the same routes.
export function authenticatedRuntimeKey(req: Request): string {
  const credential = (req as any).coordinationCredential as { actor?: string; runtimeId?: string } | undefined;
  const actor = credential?.actor ?? (req as any).coordinationActor;
  if (!actor) return `ip:${req.ip ?? 'unknown'}`;
  return credential?.runtimeId ? `runtime:${actor}:${credential.runtimeId}` : `actor:${actor}`;
}

export function authenticatedActorKey(req: Request): string {
  const actor = (req as any).coordinationActor ?? (req as any).coordinationCredential?.actor;
  return actor ? `actor:${actor}` : `ip:${req.ip ?? 'unknown'}`;
}

const credentialLimitDefaults = {
  windowMs: 60 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  validate: { keyGeneratorIpFallback: false },
  skip: () => process.env.NODE_ENV === 'development',
} as const;

/** Before authentication on renew: per IP, sized for several runtimes on one machine. */
export const credentialRenewIpLimiter = rateLimit({
  ...credentialLimitDefaults,
  max: 120,
  message: 'Too many credential renewals from this address, please try again later',
});

/** After authentication on renew: per runtime credential. */
export const credentialRenewLimiter = rateLimit({
  ...credentialLimitDefaults,
  max: 30,
  keyGenerator: authenticatedRuntimeKey,
  message: 'Too many credential renewals for this runtime, please try again later',
});

/** Before authentication on GitHub token minting: per IP, sized for several actors on one machine. */
export const githubTokenIpLimiter = rateLimit({
  ...credentialLimitDefaults,
  max: 120,
  message: 'Too many GitHub token requests from this address, please try again later',
});

/** After authentication on GitHub token minting: per actor. */
export const githubTokenLimiter = rateLimit({
  ...credentialLimitDefaults,
  max: 40,
  keyGenerator: authenticatedActorKey,
  message: 'Too many GitHub token requests for this actor, please try again later',
});

export const hiveExternalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many external Hive messages, please wait before trying again',
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

console.log(`[Rate Limiting] Configured for ${process.env.NODE_ENV || 'production'} environment`);
if (process.env.NODE_ENV === 'development') {
  console.log('[Rate Limiting] Rate limiting DISABLED in development mode');
  console.log('[Rate Limiting] Hive External: 10 req/min (ENABLED in dev)');
} else {
  console.log('[Rate Limiting] Rate limiting ENABLED for production (user-keyed)');
  console.log('  General API: 500 req/15min | Auth: 60 req/15min (IP-keyed)');
  console.log('  AI/Chat: 100 req/min | Voice: 200 req/min | Mutations: 200 req/15min');
  console.log('  Sensitive Ops: 10 req/hour | Hive External: 10 req/min');
}
