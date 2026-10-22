/**
 * Agent awareness feed endpoints (hat feed design r5.1, stage F-P1).
 *
 * Coordination auth, under /api/coordination/ so a runtime's own credential
 * (RuntimeOnboardingClient) can reach it; the reader is always the authenticated actor, never a
 * request parameter. Only actors with a canonical source (luca-claude-code,
 * luca-replit) can read. Nothing here writes to conversation_memories.
 *
 * - POST /api/coordination/agent-feed/enroll                       one-time baseline
 * - POST /api/coordination/agent-feed/register     { runtimeSessionId }
 * - POST /api/coordination/agent-feed/bootstrap    { registrationId }            once per epoch
 * - POST /api/coordination/agent-feed/page         { registrationId }
 * - POST /api/coordination/agent-feed/ack          { registrationId, servedId, items }
 * - POST /api/coordination/agent-feed/peek         { registrationId }            writes nothing
 * - POST /api/coordination/agent-feed/notice       { registrationId }            debits one notice
 * - POST /api/coordination/agent-feed/notice-seen  { registrationId, attemptId }
 * - POST /api/coordination/agent-feed/row          { registrationId, rowId, chunk }
 * - POST /api/coordination/agent-feed/read         { registrationId, rowId, sha256, receivedSha256 }
 */
import type { Application, RequestHandler, Response } from 'express';
import { requireCoordinationAuth, type CoordinationAuthenticatedRequest } from '../middleware/coordination-auth';
import {
  FeedError,
  ackPage,
  bootstrap,
  confirmRead,
  enroll,
  noticeAttempt,
  noticeSeen,
  page,
  peek,
  register,
  rowChunk,
} from '../services/agent-feed';

const PREFIX = '/api/coordination/agent-feed';

function handle(fn: (actor: string, body: Record<string, unknown>) => Promise<unknown>): RequestHandler {
  return async (req, res: Response) => {
    const actor = (req as CoordinationAuthenticatedRequest).coordinationActor;
    if (!actor) {
      res.status(403).json({ error: 'coordination actor required' });
      return;
    }
    try {
      res.json(await fn(actor, (req.body ?? {}) as Record<string, unknown>));
    } catch (e) {
      if (e instanceof FeedError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      console.error('[AgentFeed] failed:', e instanceof Error ? e.message : String(e));
      res.status(500).json({ error: 'feed_unavailable' });
    }
  };
}

export function registerAgentFeedRoutes(app: Application): void {
  const auth = requireCoordinationAuth as unknown as RequestHandler;
  app.post(`${PREFIX}/enroll`, auth, handle((actor) => enroll(actor)));
  app.post(`${PREFIX}/register`, auth, handle((actor, b) => register(actor, b.runtimeSessionId)));
  app.post(`${PREFIX}/bootstrap`, auth, handle((actor, b) => bootstrap(actor, b.registrationId)));
  app.post(`${PREFIX}/page`, auth, handle((actor, b) => page(actor, b.registrationId)));
  app.post(`${PREFIX}/ack`, auth, handle((actor, b) => ackPage(actor, b.registrationId, b.servedId, b.items)));
  app.post(`${PREFIX}/peek`, auth, handle((actor, b) => peek(actor, b.registrationId)));
  app.post(`${PREFIX}/notice`, auth, handle((actor, b) => noticeAttempt(actor, b.registrationId)));
  app.post(`${PREFIX}/notice-seen`, auth, handle((actor, b) => noticeSeen(actor, b.registrationId, b.attemptId)));
  app.post(`${PREFIX}/row`, auth, handle((actor, b) => rowChunk(actor, b.registrationId, b.rowId, b.chunk)));
  app.post(`${PREFIX}/read`, auth, handle((actor, b) => confirmRead(actor, b.registrationId, b.rowId, b.sha256, b.receivedSha256)));
}
