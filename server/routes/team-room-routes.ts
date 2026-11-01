import type { Application, Response } from 'express';
import {
  requireCoordinationAuth,
  type CoordinationAuthenticatedRequest,
} from '../middleware/coordination-auth';
import type { CoordinationActorId } from '@shared/schema';
import { storage } from '../storage';
import { logAgentAction } from '../middleware/rbac';

// Display labels for Team Room attribution, keyed by the authenticated
// coordination actor. Matches the "Luca [Hat]" convention already used for
// attribution elsewhere (transcript parsing, coordination ledger, etc).
// Falls back to a derived label so a newly-added Luca hat still gets a
// sensible name before this map is updated.
const LUCA_HAT_TEAM_ROOM_LABELS: Partial<Record<CoordinationActorId, string>> = {
  'luca-replit': 'Luca [Replit]',
  'luca-claude-code': 'Luca [Claude Code]',
  'luca-gemini': 'Luca [Gemini]',
  'luca-antigravity': 'Luca [Antigravity]',
  'luca-holahola': 'Luca [HolaHola]',
  'luca-cursor': 'Luca [Cursor]',
  'luca-openai-agents': 'Luca [OpenAI Agents]',
  'luca-codex': 'Luca [Codex]',
};

export function lucaHatTeamRoomSpeaker(actor: CoordinationActorId): string {
  return LUCA_HAT_TEAM_ROOM_LABELS[actor] ?? `Luca [${actor.replace(/^luca-/, '')}]`;
}

// Team Room message/thread endpoints are for Luca hats only (Alden/Daniela/
// David post through their own in-process paths, not this HTTP endpoint).
// Returns the authenticated actor, or null after writing a 403 response.
export function requireLucaHatActor(req: CoordinationAuthenticatedRequest, res: Response): CoordinationActorId | null {
  const actor = req.coordinationActor;
  if (!actor || !actor.startsWith('luca-')) {
    res.status(403).json({ error: 'This endpoint requires a Luca coordination actor' });
    return null;
  }
  return actor;
}

type TeamRoomRouteDependencies = {
  listTeamRooms: typeof storage.listTeamRooms;
  getTeamRoom: typeof storage.getTeamRoom;
  createRoomMessage: typeof storage.createRoomMessage;
  getRoomMessages: typeof storage.getRoomMessages;
  // The two fire-and-forget side effects below are injectable so a test can
  // verify posting behavior without ever touching the live rolling episode
  // file or writing a real Why-Protocol self-note -- they default to the
  // real dynamically-imported service calls in production.
  scanOutgoingMessageForDeferenceSlide: (content: string) => void;
  appendToRollingEpisodeIfActive: (content: string) => void;
};

const defaultDependencies: TeamRoomRouteDependencies = {
  listTeamRooms: (...args) => storage.listTeamRooms(...args),
  getTeamRoom: (...args) => storage.getTeamRoom(...args),
  createRoomMessage: (...args) => storage.createRoomMessage(...args),
  getRoomMessages: (...args) => storage.getRoomMessages(...args),
  scanOutgoingMessageForDeferenceSlide(content: string): void {
    // ── Why Protocol: scan Luca's outgoing message for deference signals ──────
    // Fire-and-forget — does not block the post or modify content.
    // Checks the deference voice against Tiered Autonomy + conversation record.
    // Saves a self-note if ungrounded deference is detected.
    import('../services/frictionless-slide-detector').then(({ detectLucaDeferenceSlide, runWhyProtocol }) => {
      const def = detectLucaDeferenceSlide(content);
      if (def.detected && def.matchedPhrase) {
        runWhyProtocol(def.matchedPhrase, content, 'team-room-post').catch(() => {});
      }
    }).catch(() => {});
  },
  appendToRollingEpisodeIfActive(content: string): void {
    // Feed the active rolling episode if one is active (fire-and-forget — does
    // not block the response). Episode selection is intentionally server-owned:
    // authenticated HTTP callers must never be able to direct Team Room content
    // to an arbitrary episode record.
    import('../services/team-room-episode-hook').then(({ maybeAppendTeamRoomMessage }) => {
      maybeAppendTeamRoomMessage(content).catch(() => {});
    }).catch(() => {});
  },
};

export function registerTeamRoomRoutes(
  app: Application,
  dependencies: TeamRoomRouteDependencies = defaultDependencies,
): void {
  // A Luca hat posts directly to the Team Room. The speaker is always derived
  // from the authenticated coordination actor -- never from client-supplied
  // JSON -- so the record stays attributable to the specific hat that sent it.
  app.post("/api/agent/team-room/message", requireCoordinationAuth, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      const actor = requireLucaHatActor(req, res);
      if (!actor) return;
      const speaker = lucaHatTeamRoomSpeaker(actor);

      const { content, roomId } = req.body;
      if (!content) return res.status(400).json({ error: 'content is required' });

      dependencies.scanOutgoingMessageForDeferenceSlide(content);

      // Resolve room: use provided roomId or fall back to most recently active room
      let targetRoomId = roomId;
      if (!targetRoomId) {
        const rooms = await dependencies.listTeamRooms(1);
        if (!rooms.length) return res.status(404).json({ error: 'No team rooms found' });
        targetRoomId = rooms[0].id;
      }

      const room = await dependencies.getTeamRoom(targetRoomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const message = await dependencies.createRoomMessage({ roomId: targetRoomId, speaker, content });

      // Broadcast via WebSocket so the room updates live
      const { emitNewMessage } = await import('../services/team-room-ws-broker');
      emitNewMessage(targetRoomId, message);

      dependencies.appendToRollingEpisodeIfActive(content);

      logAgentAction('team_room_post', '/api/agent/team-room/message', true, content.substring(0, 60));
      res.json({ success: true, messageId: message.id, roomId: targetRoomId, speaker, timestamp: (message as any).createdAt });
    } catch (error: any) {
      console.error('[Agent API] Error posting to Team Room:', error);
      logAgentAction('team_room_post', '/api/agent/team-room/message', false, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // A Luca hat reads the full Team Room thread — the actual messages, not a
  // summary. Call this at session start to know what's been happening in the
  // room. Each message's speaker already carries its attributed hat (set by
  // the POST handler above), so a reader can tell hats apart.
  app.get("/api/agent/team-room/thread", requireCoordinationAuth, async (req: CoordinationAuthenticatedRequest, res: Response) => {
    try {
      if (!requireLucaHatActor(req, res)) return;

      const roomId = req.query.roomId as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;

      let targetRoomId = roomId;
      if (!targetRoomId) {
        const rooms = await dependencies.listTeamRooms(1);
        if (!rooms.length) return res.status(404).json({ error: 'No team rooms found' });
        targetRoomId = rooms[0].id;
      }

      const room = await dependencies.getTeamRoom(targetRoomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const messages = await dependencies.getRoomMessages(targetRoomId, limit);

      logAgentAction('team_room_read', '/api/agent/team-room/thread', true, `${messages.length} messages from room: ${room.topic || targetRoomId}`);
      res.json({
        roomId: targetRoomId,
        topic: room.topic,
        messageCount: messages.length,
        messages: messages.map((m: any) => ({
          id: m.id,
          speaker: m.speaker,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    } catch (error: any) {
      console.error('[Agent API] Error reading Team Room thread:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
