import crypto from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import { COORDINATION_ACTOR_IDS } from '@shared/schema';
import {
  chainMiddleware,
  requireFounderOrCoordinationCapability,
  type CoordinationAuthenticatedRequest,
} from '../middleware/coordination-auth';
import { requireFounder, loadAuthenticatedUser, type AuthenticatedRequest } from '../middleware/rbac';
import { isAuthenticated } from '../replitAuth';
import { storage } from '../storage';
import { strictLimiter } from '../middleware/rate-limiter';
import {
  RuntimeOnboardingError,
  cancelRuntimeOnboardingInvitation,
  createRuntimeOnboardingChallenge,
  decideRuntimeOnboardingRequest,
  getAldenRuntimeOnboardingStatus,
  getRuntimeOnboardingAdminView,
  getRuntimeOnboardingRequestStatus,
  listAldenRuntimeOnboarding,
  prepareRuntimeOnboardingInvitation,
  proveRuntimeOnboardingChallenge,
  revokeOnboardedRuntime,
  submitRuntimeOnboardingRequest,
  trustedRuntimeOnboardingEndpoint,
} from '../services/runtime-onboarding-service';

type RouteRequest = CoordinationAuthenticatedRequest & AuthenticatedRequest & {
  body: Record<string, unknown>;
  params: { id: string };
  session?: Record<string, unknown>;
};

export type RuntimeOnboardingRouteDependencies = {
  founderMiddleware?: readonly RequestHandler[];
  runtimeAdminMiddleware?: RequestHandler;
  services?: Partial<{
    prepareRuntimeOnboardingInvitation: typeof prepareRuntimeOnboardingInvitation;
    submitRuntimeOnboardingRequest: typeof submitRuntimeOnboardingRequest;
    getRuntimeOnboardingRequestStatus: typeof getRuntimeOnboardingRequestStatus;
    createRuntimeOnboardingChallenge: typeof createRuntimeOnboardingChallenge;
    proveRuntimeOnboardingChallenge: typeof proveRuntimeOnboardingChallenge;
    decideRuntimeOnboardingRequest: typeof decideRuntimeOnboardingRequest;
    cancelRuntimeOnboardingInvitation: typeof cancelRuntimeOnboardingInvitation;
    revokeOnboardedRuntime: typeof revokeOnboardedRuntime;
    getRuntimeOnboardingAdminView: typeof getRuntimeOnboardingAdminView;
    listAldenRuntimeOnboarding: typeof listAldenRuntimeOnboarding;
    getAldenRuntimeOnboardingStatus: typeof getAldenRuntimeOnboardingStatus;
  }>;
};

const ERROR_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NOT_AVAILABLE: 409,
  CONFLICT: 409,
  INVALID_PROOF: 401,
  FORBIDDEN: 403,
  DATABASE_UNAVAILABLE: 503,
};

function safeError(res: Response, error: unknown): void {
  const code = error instanceof RuntimeOnboardingError ? error.code : 'DATABASE_UNAVAILABLE';
  res.status(ERROR_STATUS[code] ?? 503).json({ error: { code } });
}

function founderActor(_req: RouteRequest): string {
  return 'david';
}

function actorFromAdminRequest(req: RouteRequest): typeof COORDINATION_ACTOR_IDS[number] {
  if (req.coordinationActor) return req.coordinationActor;
  return 'david';
}

export function sessionCsrfToken(req: RouteRequest): string {
  const session = req.session;
  if (!session) return '';
  if (typeof session.runtimeOnboardingCsrfToken !== 'string') {
    session.runtimeOnboardingCsrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return session.runtimeOnboardingCsrfToken as string;
}

export function csrfAndSameOrigin(req: RouteRequest): boolean {
  const origin = req.get('origin');
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  const supplied = req.body?.csrfToken;
  const expected = sessionCsrfToken(req);
  if (!origin || origin !== expectedOrigin || typeof supplied !== 'string' || !expected) return false;
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

function needsBrowserCsrf(req: RouteRequest): boolean {
  // Tokens are authenticated as a coordination actor. A founder web session
  // has no coordinationAuthType and must use the synchronizer token.
  return !req.coordinationAuthType;
}

function requestSourceIp(req: Request): string | undefined {
  return req.ip || req.socket.remoteAddress;
}

function withRouteRequest(
  handler: (req: RouteRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req as unknown as RouteRequest, res).catch(next);
  };
}

export function registerRuntimeOnboardingRoutes(
  app: Application,
  dependencies: RuntimeOnboardingRouteDependencies = {},
): void {
  const founderSession = dependencies.founderMiddleware
    ? [...dependencies.founderMiddleware]
    : [isAuthenticated, loadAuthenticatedUser(storage), requireFounder];
  const runtimeAdminGate = dependencies.runtimeAdminMiddleware
    ?? requireFounderOrCoordinationCapability(
      chainMiddleware(founderSession),
      'coordination:runtime:admin',
      ['alden', 'david'],
    );
  const service = {
    prepareRuntimeOnboardingInvitation,
    submitRuntimeOnboardingRequest,
    getRuntimeOnboardingRequestStatus,
    createRuntimeOnboardingChallenge,
    proveRuntimeOnboardingChallenge,
    decideRuntimeOnboardingRequest,
    cancelRuntimeOnboardingInvitation,
    revokeOnboardedRuntime,
    getRuntimeOnboardingAdminView,
    listAldenRuntimeOnboarding,
    getAldenRuntimeOnboardingStatus,
    ...dependencies.services,
  };

  app.post('/api/coordination/onboarding/invitations', strictLimiter, runtimeAdminGate, withRouteRequest(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (needsBrowserCsrf(req) && !csrfAndSameOrigin(req)) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    try {
      if (!req.body || JSON.stringify(req.body).length > 16_384) {
        res.status(413).json({ error: { code: 'INVALID_INPUT' } });
        return;
      }
      const endpoint = trustedRuntimeOnboardingEndpoint();
      const invitation = await service.prepareRuntimeOnboardingInvitation({
        invitation: {
          actor: req.body.actor as never,
          runtimeId: typeof req.body.runtimeId === 'string' ? req.body.runtimeId : '',
          displayName: typeof req.body.displayName === 'string' ? req.body.displayName : '',
          capabilities: Array.isArray(req.body.capabilities) ? req.body.capabilities as never : undefined,
          provider: typeof req.body.provider === 'string' ? req.body.provider : undefined,
          model: typeof req.body.model === 'string' ? req.body.model : undefined,
          clientType: req.body.clientType as never,
        },
        preparedBy: actorFromAdminRequest(req),
        sourceIp: requestSourceIp(req),
      });
      res.status(201).json({
        invitation,
        setup: {
          invitationId: invitation.id,
          endpoint,
        },
      });
    } catch (error) {
      safeError(res, error);
    }
  }));

  app.post('/api/coordination/onboarding/requests', strictLimiter, async (req: Request, res: Response) => {
    try {
      if (!req.body || JSON.stringify(req.body).length > 10_000) {
        res.status(413).json({ error: { code: 'INVALID_INPUT' } });
        return;
      }
      const result = await service.submitRuntimeOnboardingRequest({
        invitationId: typeof req.body.invitationId === 'string' ? req.body.invitationId : '',
        publicKeyPem: typeof req.body.publicKey === 'string' ? req.body.publicKey : '',
        sourceIp: requestSourceIp(req),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        requestId: result.id,
        actor: result.actor,
        runtimeId: result.runtimeId,
        verificationCode: result.verificationCode,
        fingerprint: result.fingerprint,
        approvalPath: result.approvalPath,
        state: result.state,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      safeError(res, error);
    }
  });

  app.post('/api/coordination/onboarding/requests/:id/status', strictLimiter, withRouteRequest(async (req, res) => {
    try {
      const status = await service.getRuntimeOnboardingRequestStatus(req.params.id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        requestId: status.id,
        actor: status.actor,
        runtimeId: status.runtimeId,
        displayName: status.displayName,
        verificationCode: status.verificationCode,
        fingerprint: status.fingerprint,
        approvalPath: status.approvalPath,
        state: status.state,
        expiresAt: status.expiresAt,
        capabilities: status.capabilities,
        provider: status.provider,
        model: status.model,
      });
    } catch (error) {
      safeError(res, error);
    }
  }));

  app.post('/api/coordination/onboarding/requests/:id/challenge', strictLimiter, withRouteRequest(async (req, res) => {
    try {
      const purpose = req.body?.purpose;
      if (purpose !== 'enroll' && purpose !== 'recover') {
        throw new RuntimeOnboardingError('INVALID_INPUT');
      }
      const result = await service.createRuntimeOnboardingChallenge({
        requestId: req.params.id,
        purpose,
        endpoint: trustedRuntimeOnboardingEndpoint(),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (error) {
      safeError(res, error);
    }
  }));

  app.post('/api/coordination/onboarding/requests/:id/prove', strictLimiter, withRouteRequest(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    try {
      const result = await service.proveRuntimeOnboardingChallenge({
        requestId: req.params.id,
        challengeId: typeof req.body?.challengeId === 'string' ? req.body.challengeId : '',
        signatureBase64: typeof req.body?.signature === 'string' ? req.body.signature : '',
        endpoint: trustedRuntimeOnboardingEndpoint(),
        sourceIp: requestSourceIp(req),
      });
      res.json(result);
    } catch (error) {
      safeError(res, error);
    }
  }));

  app.get('/api/coordination/onboarding/admin', ...founderSession, withRouteRequest(async (req, res) => {
    try {
      const result = await service.getRuntimeOnboardingAdminView();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...result, csrfToken: sessionCsrfToken(req) });
    } catch (error) {
      safeError(res, error);
    }
  }));

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`/api/coordination/onboarding/admin/requests/:id/${decision}`, ...founderSession, withRouteRequest(async (req, res) => {
      if (!csrfAndSameOrigin(req)) {
        res.status(403).json({ error: { code: 'FORBIDDEN' } });
        return;
      }
      try {
        res.json(await service.decideRuntimeOnboardingRequest({
          requestId: req.params.id,
          decision,
          founderActor: founderActor(req),
        }));
      } catch (error) {
        safeError(res, error);
      }
    }));
  }

  app.post('/api/coordination/onboarding/invitations/:id/cancel', strictLimiter, runtimeAdminGate, withRouteRequest(async (req, res) => {
    if (needsBrowserCsrf(req) && !csrfAndSameOrigin(req)) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    try {
      const actor = actorFromAdminRequest(req);
      if (!await service.cancelRuntimeOnboardingInvitation({
        invitationId: req.params.id,
        actor,
        requireOwn: actor === 'alden',
      })) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } });
        return;
      }
      res.json({ cancelled: true });
    } catch (error) {
      safeError(res, error);
    }
  }));

  app.post('/api/coordination/onboarding/admin/runtimes/:id/revoke', ...founderSession, withRouteRequest(async (req, res) => {
    if (!csrfAndSameOrigin(req)) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    try {
      if (!await service.revokeOnboardedRuntime({
        runtimeId: req.params.id,
        revokedByActor: 'david',
        sourceIp: requestSourceIp(req),
      })) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } });
        return;
      }
      res.json({ revoked: true });
    } catch (error) {
      safeError(res, error);
    }
  }));

  // Alden's non-secret operations are available only behind his runtime-admin
  // authenticated tool/API context; browser-only founder routes remain above.
  app.get('/api/coordination/onboarding/alden', runtimeAdminGate, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await service.listAldenRuntimeOnboarding());
    } catch (error) {
      safeError(res, error);
    }
  });
}