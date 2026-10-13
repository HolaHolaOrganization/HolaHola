import type { Application, Response } from 'express';
import { requireCoordinationAuth, type CoordinationAuthenticatedRequest } from '../middleware/coordination-auth';
import { productionTaskRegistry, type SharedTaskRegistry } from '../services/shared-task-registry-service';
import { TaskRegistryError } from '../services/shared-task-registry-contract';

export function registerSharedTaskRegistryRoutes(app: Application, provided?: SharedTaskRegistry) {
  function registry() {
    const repository = process.env.COORDINATION_V2_REPOSITORY_IDENTITY ||
      (process.env.SHARED_SPEC_GITHUB_REPOSITORY ? `github:${process.env.SHARED_SPEC_GITHUB_REPOSITORY}` : '');
    if (!provided && !repository) throw new TaskRegistryError('REGISTRY_NOT_READY');
    return provided || productionTaskRegistry(repository);
  }
  // Existing boundary derives GET/read vs mutation/write capability from method.
  const read = requireCoordinationAuth;
  const write = requireCoordinationAuth;
  function error(res: Response, err: unknown) {
    const code = err instanceof TaskRegistryError ? err.code : 'REGISTRY_UNAVAILABLE';
    const status = code.includes('CONFLICT') ? 409 : code.includes('FORBIDDEN') || code.includes('PROOF_REQUIRED') ? 403 :
      code === 'TASK_NOT_FOUND' ? 404 : code === 'ALLOCATION_LIMIT' ? 429 :
      code.startsWith('INVALID') ? 422 : 503;
    res.status(status).json({ error: { code } });
  }
  for (const [path, imported] of [['tasks', false], ['imports', true]] as const) {
    app.post(`/api/task-registry/${path}`, write, async (req: CoordinationAuthenticatedRequest, res) => {
      try {
        const key = req.header('idempotency-key') || '';
        const result = await registry().create(req.coordinationActor!, key, req.body, imported);
        res.status(201).json(result);
      } catch (err) { error(res, err); }
    });
  }
  app.get('/api/task-registry/tasks', read, async (req, res) => {
    try {
      const limit = req.query.limit === undefined ? 25 :
        typeof req.query.limit === 'string' && /^[1-9][0-9]*$/.test(req.query.limit) ? Number(req.query.limit) : NaN;
      const tasks = await registry().list(typeof req.query.after === 'string' ? req.query.after : '0', limit);
      res.json({ tasks, nextAfter: tasks.length === limit ? tasks.at(-1)?.task_ref : null });
    } catch (err) { error(res, err); }
  });
  app.get('/api/task-registry/tasks/:ref', read, async (req, res) => {
    try { res.json(await registry().show(req.params.ref)); } catch (err) { error(res, err); }
  });
  app.get('/api/task-registry/tasks/:ref/artifact', read, async (req, res) => {
    try {
      const task = await registry().show(req.params.ref);
      res.json({ taskRef: task.task_ref, artifactBase64: task.artifact_base64, artifactSha256: task.artifact_sha256,
        repositoryIdentity: task.repository_identity, sourceKind: task.source_kind, creatorActor: task.creator_actor });
    } catch (err) { error(res, err); }
  });
  app.post('/api/task-registry/tasks/:ref/transitions', write, async (req: CoordinationAuthenticatedRequest, res) => {
    try { res.json(await registry().transition(req.coordinationActor!, req.params.ref, req.body)); }
    catch (err) { error(res, err); }
  });
}
