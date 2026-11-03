import type { Application, RequestHandler, Response } from 'express';
import {
  requireFounder,
  loadAuthenticatedUser,
} from '../middleware/rbac';
import { isAuthenticated } from '../replitAuth';
import { storage } from '../storage';
import {
  requireCoordinationAuth,
  requireFounderOrCoordinationCapability,
  chainMiddleware,
  COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR,
  type CoordinationAuthenticatedRequest,
} from '../middleware/coordination-auth';
import {
  exchangeBootstrapCredential,
  auditMissingBootstrapAttempt,
  markCoordinationRuntimeReplacementReady,
  renewBrokerCredential,
  revokeBrokerCredential,
  revokeRuntimeCredentials,
  registerCoordinationRuntime,
  adminRevokeRuntimeCredentials,
  listCoordinationRuntimeRegistrations,
} from '../services/coordination-credential-broker';
import { credentialRenewIpLimiter, credentialRenewLimiter, strictLimiter } from '../middleware/rate-limiter';
import {
  COORDINATION_ACTOR_IDS,
  COORDINATION_CREDENTIAL_CAPABILITIES,
  type CoordinationActorId,
  type CoordinationCredentialCapability,
} from '@shared/schema';

const LUCA_ACTOR_PREFIX = 'luca-';

function sourceIp(req: CoordinationAuthenticatedRequest): string | undefined {
  return req.ip || req.socket.remoteAddress;
}

// A founder web session reaching the runtime-admin gate (no coordination
// token presented) is always David -- requireFounder already restricted the
// session to founder access before this route body runs.
function runtimeAdminActor(req: CoordinationAuthenticatedRequest): CoordinationActorId {
  return req.coordinationActor ?? 'david';
}

function credentialRouteError(res: Response, error: unknown): void {
  console.error('[CoordinationCredentials] Request failed:', error);
  if (!res.headersSent) {
    res.status(503).json({ error: 'Coordination credential service is unavailable' });
  }
}

export type CoordinationCredentialRouteDependencies = {
  // Overrides the founder web-session check chained into the runtime-admin
  // gate's fallback path (isAuthenticated -> loadAuthenticatedUser ->
  // requireFounder by default). Mirrors founderMiddleware in
  // coordination-policy-routes.ts's CoordinationPolicyRouteDependencies, so
  // tests can inject a fake founder session without a real database or
  // Replit auth setup.
  founderMiddleware?: readonly RequestHandler[];
  // Overrides requireCoordinationAuth for GET /runtimes only.
  coordinationAuthMiddleware?: RequestHandler;
  // Overrides the entire runtime-admin gate (founder-session-or-token) used
  // by register-runtime and admin-revoke-runtime, for tests that want to
  // stub both paths at once instead of composing founderMiddleware.
  runtimeAdminMiddleware?: RequestHandler;
};

export function registerCoordinationCredentialRoutes(
  app: Application,
  dependencies: CoordinationCredentialRouteDependencies = {},
): void {
  const coordinationAuth = dependencies.coordinationAuthMiddleware ?? requireCoordinationAuth;

  // Standing founder-granted authority to onboard/offboard OTHER actors'
  // runtimes (coordination:runtime:admin). Accepts either a founder web
  // session or a coordination token scoped to alden/david -- the same
  // dual-path pattern used for policy routes in coordination-policy-routes.ts.
  const runtimeAdminGate = dependencies.runtimeAdminMiddleware ?? requireFounderOrCoordinationCapability(
    chainMiddleware(
      dependencies.founderMiddleware ?? [isAuthenticated, loadAuthenticatedUser(storage), requireFounder],
    ),
    'coordination:runtime:admin',
    ['alden', 'david'],
  );

  app.post('/api/coordination/credentials/exchange', strictLimiter, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      const runtimeId = typeof req.body?.runtimeId === 'string' ? req.body.runtimeId.trim() : '';
      const bootstrap = typeof req.headers['x-coordination-bootstrap'] === 'string'
        ? req.headers['x-coordination-bootstrap']
        : undefined;
      if (!runtimeId || !bootstrap) {
        await auditMissingBootstrapAttempt(runtimeId || undefined, sourceIp(req));
        res.status(401).json({ error: 'Runtime bootstrap authentication required', reason: 'missing_credentials' });
        return;
      }
      const issued = await exchangeBootstrapCredential(runtimeId, bootstrap, sourceIp(req));
      if (!issued.ok) {
        res.status(401).json({ error: 'Runtime bootstrap authentication failed', reason: issued.reason });
        return;
      }
      res.status(201).json({
        accessToken: issued.accessToken,
        tokenType: 'Coordination',
        actor: issued.credential.actor,
        runtimeId: issued.credential.runtimeId,
        capabilities: issued.credential.capabilities,
        expiresAt: issued.credential.expiresAt.toISOString(),
      });
    } catch (error) {
      credentialRouteError(res, error);
    }
  });

  app.post('/api/coordination/credentials/renew', credentialRenewIpLimiter, requireCoordinationAuth, credentialRenewLimiter, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      if (req.coordinationAuthType !== 'broker' || !req.coordinationCredential) {
        res.status(403).json({ error: 'Only a broker credential can renew itself' });
        return;
      }
      const renewed = await renewBrokerCredential(req.coordinationCredential, sourceIp(req));
      if (!renewed) {
        res.status(401).json({ error: 'Credential renewal failed' });
        return;
      }
      res.json({
        accessToken: renewed.accessToken,
        tokenType: 'Coordination',
        actor: renewed.credential.actor,
        runtimeId: renewed.credential.runtimeId,
        capabilities: renewed.credential.capabilities,
        expiresAt: renewed.credential.expiresAt.toISOString(),
      });
    } catch (error) {
      credentialRouteError(res, error);
    }
  });

  app.post('/api/coordination/credentials/rotation-ready', strictLimiter, requireCoordinationAuth, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      if (req.coordinationAuthType !== 'broker' || !req.coordinationCredential) {
        res.status(403).json({ error: 'Only a replacement runtime broker credential can prove readiness' });
        return;
      }
      const sourceRuntimeId = typeof req.body?.sourceRuntimeId === 'string'
        ? req.body.sourceRuntimeId.trim()
        : '';
      if (!sourceRuntimeId) {
        res.status(400).json({ error: 'sourceRuntimeId is required' });
        return;
      }
      const result = await markCoordinationRuntimeReplacementReady({
        sourceRuntimeId,
        credential: req.coordinationCredential,
        sourceIp: sourceIp(req),
      });
      if (!result.ok) {
        res.status(409).json({ error: 'Runtime replacement readiness was rejected', reason: result.reason });
        return;
      }
      res.json({ ready: true, rotationId: result.rotationId });
    } catch (error) {
      credentialRouteError(res, error);
    }
  });

  app.post('/api/coordination/credentials/revoke', strictLimiter, requireCoordinationAuth, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      if (req.coordinationAuthType === 'broker' && req.coordinationCredential) {
        await revokeBrokerCredential(req.coordinationCredential, sourceIp(req));
        res.status(204).end();
        return;
      }
      const runtimeId = typeof req.body?.runtimeId === 'string' ? req.body.runtimeId.trim() : '';
      if (!runtimeId || !req.coordinationActor) {
        res.status(400).json({ error: 'runtimeId is required' });
        return;
      }
      if (!await revokeRuntimeCredentials(runtimeId, req.coordinationActor, sourceIp(req))) {
        res.status(404).json({ error: 'Runtime registration not found for authenticated actor' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      credentialRouteError(res, error);
    }
  });

  app.post('/api/coordination/credentials/register-runtime', strictLimiter, runtimeAdminGate, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      const runtimeId = typeof req.body?.runtimeId === 'string' ? req.body.runtimeId.trim() : '';
      const actorInput = typeof req.body?.actor === 'string' ? req.body.actor : '';
      const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
      const explicitCapabilities = Array.isArray(req.body?.capabilities)
        ? req.body.capabilities.filter((value: unknown): value is string => typeof value === 'string')
        : undefined;
      const tokenTtlSeconds = typeof req.body?.tokenTtlSeconds === 'number' ? req.body.tokenTtlSeconds : undefined;
      const provider = typeof req.body?.provider === 'string' ? req.body.provider : undefined;
      const model = typeof req.body?.model === 'string' ? req.body.model : undefined;

      if (!runtimeId || !displayName) {
        res.status(400).json({ error: 'runtimeId and displayName are required' });
        return;
      }
      if (!(COORDINATION_ACTOR_IDS as readonly string[]).includes(actorInput) || actorInput === 'coordination-system') {
        res.status(400).json({ error: 'actor must be a valid, non-system coordination actor id' });
        return;
      }
      const actor = actorInput as CoordinationActorId;

      // Default a new Luca-hat runtime to the same standard capability set
      // every other Luca hat already holds: onboarding a peer perspective on
      // the one HolaHola project, not authoring a new policy (the "two
      // surgeons, one brain" model -- every LLM hat operates at the same
      // level on the same repo). An explicit capabilities list still
      // overrides this for the rare non-default case.
      let capabilities: CoordinationCredentialCapability[];
      if (explicitCapabilities && explicitCapabilities.length > 0) {
        if (!explicitCapabilities.every((value: string) => (COORDINATION_CREDENTIAL_CAPABILITIES as readonly string[]).includes(value))) {
          res.status(400).json({ error: 'capabilities contains an unknown value' });
          return;
        }
        capabilities = explicitCapabilities as CoordinationCredentialCapability[];
      } else if (actor.startsWith(LUCA_ACTOR_PREFIX)) {
        capabilities = [...COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR['luca-replit']];
      } else {
        res.status(400).json({ error: 'capabilities is required for non-Luca-hat actors' });
        return;
      }

      const result = await registerCoordinationRuntime({
        runtimeId, actor, displayName, capabilities, tokenTtlSeconds, provider, model,
      });
      res.status(201).json({
        runtimeId,
        actor,
        displayName,
        capabilities,
        bootstrapToken: result.bootstrapToken,
        note: 'Store this bootstrap token now in that runtime\'s credential store -- it is shown once and cannot be recovered later.',
      });
    } catch (error) {
      // registerCoordinationRuntime throws plain Errors for validation and
      // duplicate-runtime-id conflicts (both client-correctable); anything
      // else (e.g. a genuine database outage) falls through to the generic
      // 503 handler below.
      if (error instanceof Error) {
        res.status(400).json({ error: error.message });
        return;
      }
      credentialRouteError(res, error);
    }
  });

  app.post('/api/coordination/credentials/admin-revoke-runtime', strictLimiter, runtimeAdminGate, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      const runtimeId = typeof req.body?.runtimeId === 'string' ? req.body.runtimeId.trim() : '';
      if (!runtimeId) {
        res.status(400).json({ error: 'runtimeId is required' });
        return;
      }
      if (!await adminRevokeRuntimeCredentials(runtimeId, runtimeAdminActor(req), sourceIp(req))) {
        res.status(404).json({ error: 'Runtime registration not found' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      credentialRouteError(res, error);
    }
  });

  app.get('/api/coordination/credentials/runtimes', coordinationAuth, async (_req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      const runtimes = await listCoordinationRuntimeRegistrations();
      res.json({ runtimes });
    } catch (error) {
      credentialRouteError(res, error);
    }
  });
}