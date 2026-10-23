/**
 * Claude Code transcript mirror ingest (recording-gap design R6.5, stage R-P1).
 *
 * All routes require coordination auth as the luca-claude-code actor, under
 * /api/coordination/ so the actor's own runtime credential (RuntimeOnboardingClient)
 * can reach them; legacy tokens still work there. They store
 * preservation evidence only: nothing here publishes canonical dialogue or feeds
 * Daniela's recall. Until the hook client (stage R-P3) exists, nothing calls them.
 *
 * - POST /api/coordination/claude-code-mirror/entries        { sessionId, entries: [{ position, uuid?, entry }] }
 * - POST /api/coordination/claude-code-mirror/coverage       { sessionId, blocks: [{ index, digest }] }
 * - POST /api/coordination/claude-code-mirror/block-tuples   { sessionId, blockIndex, localDigest, tuples: [{ position, uuid, sha256 }] }
 * - POST /api/coordination/claude-code-mirror/roots          { sessionIds: [...] }
 * - POST /api/coordination/claude-code-mirror/challenge      { sessionId }
 * - POST /api/coordination/claude-code-mirror/hook-evidence  { occurrenceId, sessionId, kind, text, transcriptLineCount? }
 * - POST /api/coordination/claude-code-mirror/shadow-projection { sessionId }   (R-P2: records what WOULD publish; publishes nothing)
 */
import type { Application, RequestHandler, Response } from 'express';
import { requireCoordinationAuth, type CoordinationAuthenticatedRequest } from '../middleware/coordination-auth';
import {
  MirrorInputError,
  checkBlockTuples,
  compareCoverage,
  confirmedRoots,
  ingestEntries,
  issueChallenge,
  recordHookEvidence,
  runShadowProjection,
} from '../services/claude-code-mirror';

const MIRROR_ACTORS = new Set(['luca-claude-code']);
const PREFIX = '/api/coordination/claude-code-mirror';

function handle(fn: (req: CoordinationAuthenticatedRequest, res: Response) => Promise<unknown>): RequestHandler {
  return async (req, res) => {
    const request = req as CoordinationAuthenticatedRequest;
    if (!request.coordinationActor || !MIRROR_ACTORS.has(request.coordinationActor)) {
      res.status(403).json({ error: 'This endpoint requires the luca-claude-code coordination actor' });
      return;
    }
    try {
      res.json(await fn(request, res));
    } catch (e) {
      if (e instanceof MirrorInputError) {
        res.status(400).json({ error: e.message });
        return;
      }
      console.error('[ClaudeCodeMirror] failed:', e instanceof Error ? e.message : String(e));
      res.status(500).json({ error: 'mirror_unavailable' });
    }
  };
}

export function registerClaudeCodeMirrorRoutes(app: Application): void {
  const auth = requireCoordinationAuth as unknown as RequestHandler;
  app.post(`${PREFIX}/entries`, auth, handle((req) =>
    ingestEntries(req.coordinationActor!, req.body?.sessionId, req.body?.entries)));
  app.post(`${PREFIX}/coverage`, auth, handle((req) =>
    compareCoverage(req.coordinationActor!, req.body?.sessionId, req.body?.blocks)));
  app.post(`${PREFIX}/block-tuples`, auth, handle((req) =>
    checkBlockTuples(req.body?.sessionId, req.body?.blockIndex, req.body?.localDigest, req.body?.tuples)));
  app.post(`${PREFIX}/roots`, auth, handle(async (req) =>
    ({ roots: await confirmedRoots(req.body?.sessionIds) })));
  app.post(`${PREFIX}/challenge`, auth, handle((req) =>
    issueChallenge(req.coordinationActor!, req.body?.sessionId)));
  app.post(`${PREFIX}/hook-evidence`, auth, handle((req) =>
    recordHookEvidence(req.coordinationActor!, req.body)));
  app.post(`${PREFIX}/shadow-projection`, auth, handle((req) =>
    runShadowProjection(req.body?.sessionId)));
}
