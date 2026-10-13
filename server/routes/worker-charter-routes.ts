/**
 * Local Read-only Worker v1 routes (design §4.1, §4.2).
 * Founder-only charter create/approve/revoke (same founder gate as the
 * coordination policy routes: founder web session or the 'david' coordination
 * token); read-only charter GET and job discovery for coordination actors.
 */
import type { Application, Request, Response, RequestHandler } from 'express';
import {
  WorkerCharterError, approveCharter, createCharterDraft, createPostgresWorkerCharterRepository, getCharter,
  listWorkerJobs, revokeCharter, type WorkerCharterRepository,
} from '../services/worker-charter-service';

export type WorkerCharterRouteDependencies = {
  founderGate?: RequestHandler;
  coordinationAuthMiddleware?: RequestHandler;
  repository?: WorkerCharterRepository;
};

const STATUS: Record<string, number> = {
  WORKER_CHARTER_INVALID: 422,
  WORKER_JOBS_QUERY_INVALID: 400,
  WORKER_CHARTER_NOT_FOUND: 404,
  WORKER_CHARTER_STATE_CONFLICT: 409,
  WORKER_ACTOR_MISMATCH: 403,
  WORKER_CHARTER_SCHEMA_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  FOUNDER_REQUIRED: 401,
};

function reply(res: Response, error: unknown) {
  const code = error instanceof WorkerCharterError ? error.code : (error as { code?: string })?.code === 'FOUNDER_REQUIRED' ? 'FOUNDER_REQUIRED' : 'DATABASE_UNAVAILABLE';
  res.status(STATUS[code] ?? 503).json({
    error: { code, ...(error instanceof WorkerCharterError && error.details ? { details: error.details } : {}) },
  });
}

function founderActor(req: Request): string {
  const r = req as Request & { authenticatedUser?: { id?: string }; coordinationActor?: string };
  if (r.authenticatedUser?.id) return r.authenticatedUser.id;
  if (r.coordinationActor === 'david') return 'david';
  throw Object.assign(new Error('FOUNDER_REQUIRED'), { code: 'FOUNDER_REQUIRED' });
}

function versionParam(raw: string): number {
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < 1) throw new WorkerCharterError('WORKER_JOBS_QUERY_INVALID', { field: 'version' });
  return v;
}

export async function defaultWorkerCharterFounderGate(): Promise<RequestHandler> {
  const [{ requireFounder, loadAuthenticatedUser }, { isAuthenticated }, { storage }, coordinationAuth] = await Promise.all([
    import('../middleware/rbac'), import('../replitAuth'), import('../storage'), import('../middleware/coordination-auth'),
  ]);
  const founderSession = [isAuthenticated, loadAuthenticatedUser(storage), requireFounder] as RequestHandler[];
  return coordinationAuth.requireFounderOrCoordinationCapability(coordinationAuth.chainMiddleware(founderSession), 'coordination:write', ['david']);
}

export function registerWorkerCharterRoutes(app: Application, deps: Required<Pick<WorkerCharterRouteDependencies, 'founderGate' | 'coordinationAuthMiddleware'>> & WorkerCharterRouteDependencies): void {
  const repo = deps.repository ?? createPostgresWorkerCharterRepository();
  const founderGate = deps.founderGate;
  const coordinationAuth = deps.coordinationAuthMiddleware;

  app.post('/api/worker-charters', founderGate, async (req: Request, res: Response) => {
    try {
      const body = req.body as { id?: unknown; body?: unknown };
      const result = await createCharterDraft(repo, { id: typeof body.id === 'string' ? body.id : undefined, body: body.body, createdBy: founderActor(req) });
      res.status(201).json(result);
    } catch (e) { reply(res, e); }
  });

  app.post('/api/worker-charters/:id/versions/:version/approve', founderGate, async (req: Request, res: Response) => {
    try { res.json(await approveCharter(repo, req.params.id, versionParam(req.params.version), founderActor(req))); } catch (e) { reply(res, e); }
  });

  app.post('/api/worker-charters/:id/versions/:version/revoke', founderGate, async (req: Request, res: Response) => {
    try { res.json(await revokeCharter(repo, req.params.id, versionParam(req.params.version), founderActor(req))); } catch (e) { reply(res, e); }
  });

  app.get('/api/worker-charters/:id/versions/:version', coordinationAuth, async (req: Request, res: Response) => {
    try { res.json(await getCharter(repo, req.params.id, versionParam(req.params.version))); } catch (e) { reply(res, e); }
  });

  // Read-only: never acknowledges inbox items or advances any cursor.
  app.get('/api/worker/jobs', coordinationAuth, async (req: Request, res: Response) => {
    try {
      const actor = (req as Request & { coordinationActor?: string }).coordinationActor ?? '';
      const q = req.query as Record<string, string | undefined>;
      if (q.after === undefined) throw new WorkerCharterError('WORKER_JOBS_QUERY_INVALID', { field: 'after' });
      res.json(await listWorkerJobs(repo, {
        callerActor: actor, charterId: String(q.charterId ?? ''), charterVersion: versionParam(String(q.charterVersion ?? '')),
        after: Number(q.after), limit: Number(q.limit ?? 50),
      }));
    } catch (e) { reply(res, e); }
  });
}
