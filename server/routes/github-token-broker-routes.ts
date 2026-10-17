/**
 * Routes for the GitHub token broker (plan efb1e3d1 rev 10, A1b).
 *
 * - POST /api/coordination/github-grants                 propose (founder session, or alden/david runtime admin)
 * - GET  /api/coordination/github-grants/admin           list grants + recent audit (founder session)
 * - POST /api/coordination/github-grants/admin/:id/:decision  approve | reject | disable | enable | revoke (founder session + CSRF)
 * - POST /api/coordination/github-token                  mint a token for the CALLER's own App (agent credential)
 *
 * The mint route reads nothing from the request body: the actor comes from the
 * authenticated credential (which must be the actor's own BROKER credential),
 * and App, installation, repository and permissions come from the grant and
 * server constants.
 */
import type { Application, RequestHandler, Response } from 'express';
import {
  chainMiddleware,
  requireFounderOrCoordinationCapability,
  type CoordinationAuthenticatedRequest,
} from '../middleware/coordination-auth';
import { requireFounder, loadAuthenticatedUser, type AuthenticatedRequest } from '../middleware/rbac';
import { isAuthenticated } from '../replitAuth';
import { storage } from '../storage';
import { strictLimiter } from '../middleware/rate-limiter';
import { csrfAndSameOrigin, sessionCsrfToken } from './runtime-onboarding-routes';
import {
  GITHUB_GRANT_ACTORS,
  GRANT_TRANSITIONS,
  githubAppApi,
  loadPrivateKeyFromEnv,
  mintAgentGithubToken,
  validateGrantProposal,
  type GrantDecision,
  type MintDependencies,
} from '../services/github-token-broker';
import { GithubGrantError, githubTokenBrokerStore } from '../services/github-token-broker-store';
import { getProcessBackgroundTasks } from '../services/instance-role';

type RouteRequest = CoordinationAuthenticatedRequest & AuthenticatedRequest & {
  body: Record<string, unknown>;
  params: { id: string; decision: string };
  session?: Record<string, unknown>;
};

const ERROR_STATUS = { NOT_FOUND: 404, CONFLICT: 409, INVALID_INPUT: 400 } as const;

function handle(handler: (req: RouteRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void handler(req as unknown as RouteRequest, res).catch(next); };
}

function grantError(res: Response, error: unknown): void {
  if (error instanceof GithubGrantError) {
    res.status(ERROR_STATUS[error.code]).json({ error: { code: error.code } });
    return;
  }
  console.error('[GithubTokenBroker] grant operation failed:', error instanceof Error ? error.message : error);
  res.status(503).json({ error: { code: 'UNAVAILABLE' } });
}

export function registerGithubTokenBrokerRoutes(app: Application, mintDeps?: Partial<MintDependencies>): void {
  const founderSession = [isAuthenticated, loadAuthenticatedUser(storage), requireFounder];
  const proposeGate = requireFounderOrCoordinationCapability(
    chainMiddleware(founderSession), 'coordination:runtime:admin', ['alden', 'david'],
  );
  // Any agent eligible for a grant may ASK; the grant decides whether it gets anything.
  const agentGate = requireFounderOrCoordinationCapability(
    (_req, res) => { res.status(401).json({ error: 'Coordination token required (x-coordination-token header)' }); },
    'coordination:write',
    [...GITHUB_GRANT_ACTORS],
  );

  app.post('/api/coordination/github-grants', strictLimiter, proposeGate, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.coordinationAuthType && !csrfAndSameOrigin(req)) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    const validation = validateGrantProposal(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: validation.error } });
      return;
    }
    try {
      const proposedBy = req.coordinationActor ?? 'david';
      res.status(201).json({ grant: await githubTokenBrokerStore.propose(validation.proposal, proposedBy) });
    } catch (error) {
      grantError(res, error);
    }
  }));

  app.get('/api/coordination/github-grants/admin', ...founderSession, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json({ ...(await githubTokenBrokerStore.list()), csrfToken: sessionCsrfToken(req) });
    } catch (error) {
      grantError(res, error);
    }
  }));

  app.post('/api/coordination/github-grants/admin/:id/:decision', strictLimiter, ...founderSession, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const decision = req.params.decision as GrantDecision;
    if (!(decision in GRANT_TRANSITIONS)) {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return;
    }
    if (!csrfAndSameOrigin(req)) {
      res.status(403).json({ error: { code: 'FORBIDDEN' } });
      return;
    }
    try {
      res.json({ grant: await githubTokenBrokerStore.decide(req.params.id, decision, 'david') });
    } catch (error) {
      grantError(res, error);
    }
  }));

  app.post('/api/coordination/github-token', strictLimiter, agentGate, handle(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.coordinationActor;
    if (!actor) {
      res.status(401).json({ error: 'Coordination token required (x-coordination-token header)' });
      return;
    }
    const result = await mintAgentGithubToken({
      actor,
      authType: req.coordinationAuthType,
      runtimeId: req.coordinationCredential?.runtimeId,
      credentialId: req.coordinationCredential?.credentialId,
    }, {
      store: githubTokenBrokerStore,
      github: githubAppApi,
      loadPrivateKey: (appId) => loadPrivateKeyFromEnv(appId),
      instanceRole: getProcessBackgroundTasks().role,
      ...mintDeps,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: { code: result.reason } });
      return;
    }
    res.json(result);
  }));
}
