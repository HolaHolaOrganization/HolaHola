import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  type CoordinationCredentialCapability,
  type CoordinationActorId,
} from '@shared/schema';
// Type-only: the broker module (and its transitive server/db.ts import) must
// never load merely by importing this file. External coordination clients
// (server/scripts/coordination-cli.ts -> coordination-actor-client.ts ->
// this file, for COORDINATION_TOKEN_ENV_BY_ACTOR) run on machines with no
// database credential at all. The two functions that do need the broker's
// real implementation are imported lazily inside resolveCoordinationCapability,
// the one code path that actually resolves a broker credential.
import type { BrokerCredential } from '../services/coordination-credential-broker';

type CoordinationEnvironment = Record<string, string | undefined>;

export interface CoordinationAuthenticatedRequest extends Request {
  coordinationActor?: CoordinationActorId;
  coordinationAuthType?: 'legacy' | 'broker';
  coordinationCredential?: BrokerCredential;
}

export const COORDINATION_TOKEN_ENV_BY_ACTOR: Record<
  Exclude<CoordinationActorId, 'coordination-system'>,
  string
> = {
  'luca-replit': 'COORDINATION_LUCA_REPLIT_TOKEN',
  'luca-claude-code': 'COORDINATION_LUCA_CLAUDE_CODE_TOKEN',
  'luca-gemini': 'COORDINATION_LUCA_GEMINI_TOKEN',
  'luca-antigravity': 'COORDINATION_LUCA_ANTIGRAVITY_TOKEN',
  'luca-holahola': 'COORDINATION_LUCA_HOLAHOLA_TOKEN',
  'luca-cursor': 'COORDINATION_LUCA_CURSOR_TOKEN',
  'luca-openai-agents': 'COORDINATION_LUCA_OPENAI_AGENTS_TOKEN',
  'luca-codex': 'COORDINATION_LUCA_CODEX_TOKEN',
  alden: 'COORDINATION_ALDEN_TOKEN',
  daniela: 'COORDINATION_DANIELA_TOKEN',
  david: 'COORDINATION_DAVID_TOKEN',
};

const GEMINI_LEGACY_TOKEN_ENV = 'COORDINATION_LUCA_GEMINI_TOKEN';
const GEMINI_CODE_TOKEN_ENV = 'COORDINATION_LUCA_GEMINI_CODE_TOKEN';

export type CoordinationAuthResolution =
  | { ok: true; actor: CoordinationActorId }
  | { ok: false; status: 401 | 503; error: string };

export type CoordinationCapabilityResolution =
  | { ok: true; actor: CoordinationActorId; authType: 'legacy' | 'broker'; credential?: BrokerCredential }
  | { ok: false; status: 401 | 403 | 503; error: string };

export const COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR: Readonly<
  Record<CoordinationActorId, readonly CoordinationCredentialCapability[]>
> = {
  'luca-replit': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-claude-code': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-gemini': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-antigravity': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-holahola': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-cursor': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-openai-agents': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  'luca-codex': ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'observation:read'],
  // alden and david hold coordination:runtime:admin: standing founder-granted
  // authority to onboard/revoke OTHER actors' runtimes (e.g. bringing on a
  // new Luca-hat LLM), distinct from coordination:credential:revoke above
  // which only ever lets an actor manage its own runtime. See
  // docs/coordination-v2-architecture.md, "Runtime onboarding delegation".
  alden: ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'coordination:runtime:admin'],
  daniela: ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke'],
  david: ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew', 'coordination:credential:revoke', 'coordination:runtime:admin'],
  'coordination-system': [],
};

/**
 * Resolves a supplied credential using only the server's fixed actor bindings.
 * `environment` is injectable so this function can be tested without mutating
 * process.env.
 */
export function resolveCoordinationActor(
  coordinationToken: string | undefined,
  agentToken: string | undefined,
  environment: CoordinationEnvironment = process.env,
): CoordinationAuthResolution {
  // `agentToken` is intentionally ignored. Keep the parameter during this
  // migration so callers that still pass the old compatibility argument fail
  // closed instead of gaining a second authentication path.
  void agentToken;
  const legacyGeminiToken = environment[GEMINI_LEGACY_TOKEN_ENV];
  const geminiCodeToken = environment[GEMINI_CODE_TOKEN_ENV];
  if (legacyGeminiToken && geminiCodeToken && legacyGeminiToken !== geminiCodeToken) {
    return {
      ok: false,
      status: 503,
      error: 'Coordination authentication has conflicting luca-gemini token aliases',
    };
  }

  const configuredBindings = Object.entries(COORDINATION_TOKEN_ENV_BY_ACTOR)
    .map(([actor, envName]) => [
      actor as CoordinationActorId,
      actor === 'luca-gemini'
        ? geminiCodeToken || legacyGeminiToken
        : environment[envName],
    ] as const);

  const validBindings = configuredBindings.filter(
    (binding): binding is [CoordinationActorId, string] => Boolean(binding[1] && binding[1].length >= 32),
  );

  const duplicateTokens = new Set<string>();
  const seenTokens = new Set<string>();
  for (const [, token] of validBindings) {
    if (seenTokens.has(token)) duplicateTokens.add(token);
    seenTokens.add(token);
  }

  // A duplicate makes actor attribution ambiguous. Reject every attempt rather
  // than selecting an arbitrary actor.
  if (duplicateTokens.size > 0) {
    return { ok: false, status: 503, error: 'Coordination authentication has ambiguous token bindings' };
  }

  if (coordinationToken) {
    for (const [actor, token] of validBindings) {
      const provided = Buffer.from(coordinationToken);
      const expected = Buffer.from(token);
      if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
        return { ok: true, actor };
      }
    }
    return { ok: false, status: 401, error: 'Invalid coordination token' };
  }

  if (validBindings.length === 0) {
    return { ok: false, status: 503, error: 'Coordination authentication is not configured' };
  }
  return { ok: false, status: 401, error: 'Coordination token required (x-coordination-token header)' };
}

export async function resolveCoordinationCapability(
  token: string,
  capability: CoordinationCredentialCapability,
  actorAllowlist?: readonly CoordinationActorId[],
  sourceIp?: string,
  environment: CoordinationEnvironment = process.env,
): Promise<CoordinationCapabilityResolution> {
  const fixed = resolveCoordinationActor(token, undefined, environment);
  if (fixed.ok) {
    if (actorAllowlist && !actorAllowlist.includes(fixed.actor)) {
      return { ok: false, status: 403, error: 'Coordination actor is not authorized for this endpoint' };
    }
    if (!COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR[fixed.actor].includes(capability)) {
      return { ok: false, status: 403, error: `Credential lacks required capability: ${capability}` };
    }
    return { ok: true, actor: fixed.actor, authType: 'legacy' };
  }
  try {
    const { resolveBrokerCredential, auditBrokerAccessDenied } =
      await import('../services/coordination-credential-broker');
    const credential = await resolveBrokerCredential(token, sourceIp);
    if (!credential) return { ok: false, status: fixed.status, error: fixed.error };
    if (!credential.capabilities.includes(capability)) {
      await auditBrokerAccessDenied(credential, capability, sourceIp);
      return { ok: false, status: 403, error: `Credential lacks required capability: ${capability}` };
    }
    if (actorAllowlist && !actorAllowlist.includes(credential.actor)) {
      return { ok: false, status: 403, error: 'Coordination actor is not authorized for this endpoint' };
    }
    return { ok: true, actor: credential.actor, authType: 'broker', credential };
  } catch (error) {
    console.error('[CoordinationAuth] Broker credential resolution failed:', error);
    return { ok: false, status: 503, error: 'Coordination credential broker is unavailable' };
  }
}

/**
 * Runs a fixed sequence of Express middleware as one handler, short-circuiting
 * on the first response or error. Used to compose a founder web-session check
 * (isAuthenticated -> loadAuthenticatedUser -> requireFounder) into the single
 * middleware requireFounderOrCoordinationCapability expects as its fallback.
 */
export function chainMiddleware(handlers: readonly RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    const run = (index: number, error?: unknown): void => {
      if (error) {
        next(error);
        return;
      }
      const handler = handlers[index];
      if (!handler) {
        next();
        return;
      }
      handler(req, res, (nextError?: unknown) => run(index + 1, nextError));
    };
    run(0);
  };
}

export function requireFounderOrCoordinationCapability(
  founderMiddleware: (req: Request, res: Response, next: NextFunction) => unknown,
  capability: CoordinationCredentialCapability,
  actorAllowlist: readonly CoordinationActorId[],
) {
  return async (req: CoordinationAuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = readHeader(req, 'x-coordination-token');
    if (!token) {
      founderMiddleware(req, res, next);
      return;
    }
    const resolution = await resolveCoordinationCapability(
      token,
      capability,
      actorAllowlist,
      req.ip || req.socket.remoteAddress,
    );
    if (!resolution.ok) {
      res.status(resolution.status).json({ error: resolution.error });
      return;
    }
    req.coordinationActor = resolution.actor;
    req.coordinationAuthType = resolution.authType;
    req.coordinationCredential = resolution.credential;
    next();
  };
}

function readHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredCapability(req: Request): string {
  if (req.path.endsWith('/credentials/renew')) return 'coordination:credential:renew';
  if (req.path.endsWith('/credentials/rotation-ready')) return 'coordination:credential:renew';
  if (req.path.endsWith('/credentials/revoke')) return 'coordination:credential:revoke';
  if (req.path.endsWith('/inbox/ack')) return 'coordination:inbox:ack';
  return req.method === 'GET' ? 'coordination:read' : 'coordination:write';
}

export async function requireCoordinationAuth(
  req: CoordinationAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = readHeader(req, 'x-coordination-token');
  const resolution = resolveCoordinationActor(
    token,
    undefined,
  );

  if (token) {
    const capabilityResolution = await resolveCoordinationCapability(
      token,
      requiredCapability(req) as CoordinationCredentialCapability,
      undefined,
      req.ip || req.socket.remoteAddress,
    );
    if (capabilityResolution.ok) {
      req.coordinationActor = capabilityResolution.actor;
      req.coordinationAuthType = capabilityResolution.authType;
      req.coordinationCredential = capabilityResolution.credential;
      next();
      return;
    }
    res.status(capabilityResolution.status).json({ error: capabilityResolution.error });
    return;
  }
  if (!resolution.ok) {
    res.status(resolution.status).json({ error: resolution.error });
  }
}