/**
 * Regression coverage for Team Room speaker attribution (Task #1559).
 *
 * POST /api/agent/team-room/message and GET /api/agent/team-room/thread
 * derive `speaker` from the authenticated coordination actor, never from
 * client-supplied JSON, and are restricted to Luca hats only. This suite
 * proves both properties would actually break a test if removed or
 * bypassed, using pure in-memory fake storage so it runs everywhere with no
 * live database.
 *
 * The two fire-and-forget side effects on the POST path (Why-Protocol
 * deference scan, rolling-episode append) are replaced with no-op spies via
 * dependency injection -- without this, a real active rolling episode in the
 * shared dev DB would have this test's synthetic content silently written
 * into the live episode record (see .agents/memory/ci-fixture-canonical-boundary.md).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CoordinationActorId } from '@shared/schema';
import { lucaHatTeamRoomSpeaker, registerTeamRoomRoutes, requireLucaHatActor } from '../routes/team-room-routes';

const TOKENS = {
  'luca-replit': 'team-room-attribution-replit-token-'.repeat(2),
  'luca-claude-code': 'team-room-attribution-claude-token-'.repeat(2),
  'luca-cursor': 'team-room-attribution-cursor-token-'.repeat(2),
  'luca-openai-agents': 'team-room-attribution-openai-token-'.repeat(2),
  'luca-codex': 'team-room-attribution-codex-token-'.repeat(2),
  alden: 'team-room-attribution-alden-token-'.repeat(2),
  daniela: 'team-room-attribution-daniela-token-'.repeat(2),
  david: 'team-room-attribution-david-token-'.repeat(2),
} as const;
type TestActor = keyof typeof TOKENS;

const TOKEN_ENVIRONMENT: Record<string, string> = {
  COORDINATION_LUCA_REPLIT_TOKEN: TOKENS['luca-replit'],
  COORDINATION_LUCA_CLAUDE_CODE_TOKEN: TOKENS['luca-claude-code'],
  COORDINATION_LUCA_CURSOR_TOKEN: TOKENS['luca-cursor'],
  COORDINATION_LUCA_OPENAI_AGENTS_TOKEN: TOKENS['luca-openai-agents'],
  COORDINATION_LUCA_CODEX_TOKEN: TOKENS['luca-codex'],
  COORDINATION_ALDEN_TOKEN: TOKENS.alden,
  COORDINATION_DANIELA_TOKEN: TOKENS.daniela,
  COORDINATION_DAVID_TOKEN: TOKENS.david,
};

const previousEnvironment = new Map<string, string | undefined>();

interface FakeRoom {
  id: string;
  topic: string;
  status: string;
  createdBy: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface FakeMessage {
  id: string;
  roomId: string;
  speaker: string;
  content: string;
  audioUrl: string | null;
  timestamp: Date;
}

function createFakeTeamRoom() {
  const room: FakeRoom = {
    id: 'room-1',
    topic: 'Attribution test room',
    status: 'active',
    createdBy: 'test',
    metadata: null,
    createdAt: new Date(),
  };
  const messages: FakeMessage[] = [];
  const createRoomMessageCalls: Array<{ roomId: string; speaker: string; content: string }> = [];
  const deferenceScanCalls: string[] = [];
  const episodeAppendCalls: string[] = [];
  let nextId = 1;

  const dependencies = {
    listTeamRooms: async (limit?: number) => [room].slice(0, limit ?? 1),
    getTeamRoom: async (id: string) => (id === room.id ? room : undefined),
    createRoomMessage: async (data: { roomId: string; speaker: string; content: string }) => {
      createRoomMessageCalls.push({ roomId: data.roomId, speaker: data.speaker, content: data.content });
      const message: FakeMessage = {
        id: `message-${nextId++}`,
        roomId: data.roomId,
        speaker: data.speaker,
        content: data.content,
        audioUrl: null,
        timestamp: new Date(),
      };
      messages.push(message);
      return message;
    },
    getRoomMessages: async (roomId: string, limit = 50) =>
      messages.filter((m) => m.roomId === roomId).slice(0, limit),
    // No-op stand-ins -- see file header for why these must never be the real
    // dynamically-imported service calls in this test.
    scanOutgoingMessageForDeferenceSlide: (content: string) => { deferenceScanCalls.push(content); },
    appendToRollingEpisodeIfActive: (content: string) => { episodeAppendCalls.push(content); },
  };

  return { room, messages, createRoomMessageCalls, deferenceScanCalls, episodeAppendCalls, dependencies };
}

let server: Server;
let baseUrl: string;
let fake: ReturnType<typeof createFakeTeamRoom>;

async function post(actor: TestActor, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/agent/team-room/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coordination-token': TOKENS[actor] },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function getThread(actor: TestActor) {
  const response = await fetch(`${baseUrl}/api/agent/team-room/thread`, {
    headers: { accept: 'application/json', 'x-coordination-token': TOKENS[actor] },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

before(async () => {
  for (const [name, value] of Object.entries(TOKEN_ENVIRONMENT)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  fake = createFakeTeamRoom();
  const app = express();
  app.use(express.json());
  registerTeamRoomRoutes(app, fake.dependencies as any);
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('lucaHatTeamRoomSpeaker derives a distinct label per hat, with a safe fallback for an unmapped hat', () => {
  assert.equal(lucaHatTeamRoomSpeaker('luca-replit'), 'Luca [Replit]');
  assert.equal(lucaHatTeamRoomSpeaker('luca-claude-code'), 'Luca [Claude Code]');
  assert.equal(lucaHatTeamRoomSpeaker('luca-cursor'), 'Luca [Cursor]');
  assert.equal(lucaHatTeamRoomSpeaker('luca-openai-agents'), 'Luca [OpenAI Agents]');
  assert.equal(lucaHatTeamRoomSpeaker('luca-codex'), 'Luca [Codex]');
  assert.notEqual(lucaHatTeamRoomSpeaker('luca-replit'), lucaHatTeamRoomSpeaker('luca-claude-code'));
  // A future hat not yet in the map still gets a "Luca [...]" label, never the bare "Luca" string.
  assert.equal(lucaHatTeamRoomSpeaker('luca-future-hat' as CoordinationActorId), 'Luca [future-hat]');
});

test('posting as two different Luca hats stores and returns each hat-specific speaker label, never a shared "Luca" string', async () => {
  const replitPost = await post('luca-replit', { content: 'Replit hat checking in.' });
  assert.equal(replitPost.status, 200);
  assert.equal(replitPost.body.speaker, 'Luca [Replit]');

  const claudePost = await post('luca-claude-code', { content: 'Claude Code hat checking in.' });
  assert.equal(claudePost.status, 200);
  assert.equal(claudePost.body.speaker, 'Luca [Claude Code]');

  // The two hats must never collapse to the same label, and neither may regress to a bare "Luca".
  assert.notEqual(replitPost.body.speaker, claudePost.body.speaker);
  assert.notEqual(replitPost.body.speaker, 'Luca');
  assert.notEqual(claudePost.body.speaker, 'Luca');

  // The stored row (not just the HTTP response) must carry the same hat-specific label.
  const storedReplit = fake.messages.find((m) => m.id === replitPost.body.messageId);
  const storedClaude = fake.messages.find((m) => m.id === claudePost.body.messageId);
  assert.equal(storedReplit?.speaker, 'Luca [Replit]');
  assert.equal(storedClaude?.speaker, 'Luca [Claude Code]');

  // Reading the thread back must preserve each hat's distinct attribution.
  const thread = await getThread('luca-replit');
  assert.equal(thread.status, 200);
  const speakersInThread = new Set(thread.body.messages.map((m: any) => m.speaker));
  assert.ok(speakersInThread.has('Luca [Replit]'));
  assert.ok(speakersInThread.has('Luca [Claude Code]'));
  assert.equal(speakersInThread.has('Luca'), false);
});

test('new runtime hats post to Team Room with authenticated, attributed identities', async () => {
  const cursorPost = await post('luca-cursor', { content: 'Cursor runtime checking in.' });
  const openAiAgentsPost = await post('luca-openai-agents', { content: 'OpenAI Agents runtime checking in.' });
  const codexPost = await post('luca-codex', { content: 'Codex runtime checking in.' });

  assert.equal(cursorPost.status, 200);
  assert.equal(cursorPost.body.speaker, 'Luca [Cursor]');
  assert.equal(openAiAgentsPost.status, 200);
  assert.equal(openAiAgentsPost.body.speaker, 'Luca [OpenAI Agents]');
  assert.equal(codexPost.status, 200);
  assert.equal(codexPost.body.speaker, 'Luca [Codex]');
  assert.notEqual(cursorPost.body.speaker, openAiAgentsPost.body.speaker);
  assert.notEqual(openAiAgentsPost.body.speaker, codexPost.body.speaker);
});

test('a client-supplied speaker field is ignored -- the stored and returned speaker always reflects the authenticated actor', async () => {
  const spoof = await post('luca-replit', { content: 'Pretending to be someone else.', speaker: 'David' });
  assert.equal(spoof.status, 200);
  assert.equal(spoof.body.speaker, 'Luca [Replit]');
  assert.notEqual(spoof.body.speaker, 'David');

  const stored = fake.messages.find((m) => m.id === spoof.body.messageId);
  assert.equal(stored?.speaker, 'Luca [Replit]');
  assert.notEqual(stored?.speaker, 'David');

  // The GET thread response must also never surface the spoofed value.
  const thread = await getThread('luca-claude-code');
  assert.equal(
    thread.body.messages.some((m: any) => m.speaker === 'David'),
    false,
  );
});

test('non-Luca coordination actors are rejected with 403 from both the post and thread endpoints, and never write a message', async () => {
  for (const actor of ['alden', 'daniela', 'david'] as const) {
    const callsBefore = fake.createRoomMessageCalls.length;

    const postResponse = await post(actor, { content: `${actor} trying to post directly.` });
    assert.equal(postResponse.status, 403, `${actor} POST must be rejected`);
    assert.equal(postResponse.body.error, 'This endpoint requires a Luca coordination actor');
    assert.equal(fake.createRoomMessageCalls.length, callsBefore, `${actor} must not have written a Team Room message`);

    const threadResponse = await getThread(actor);
    assert.equal(threadResponse.status, 403, `${actor} GET thread must be rejected`);
    assert.equal(threadResponse.body.error, 'This endpoint requires a Luca coordination actor');
  }
});

test('requireLucaHatActor rejects a request with no authenticated coordination actor', () => {
  let statusCode = 0;
  let body: unknown;
  const fakeRes = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as any;

  const result = requireLucaHatActor({ coordinationActor: undefined } as any, fakeRes);

  assert.equal(result, null);
  assert.equal(statusCode, 403);
  assert.deepEqual(body, { error: 'This endpoint requires a Luca coordination actor' });
});

test('posting never triggers the live rolling-episode append or Why-Protocol scan through untested code paths', async () => {
  const before = { deference: fake.deferenceScanCalls.length, episode: fake.episodeAppendCalls.length };
  await post('luca-replit', { content: 'A message whose side-effect hooks are spied, not real.' });
  assert.equal(fake.deferenceScanCalls.length, before.deference + 1);
  assert.equal(fake.episodeAppendCalls.length, before.episode + 1);
});
