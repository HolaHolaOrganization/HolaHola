/**
 * Stand-in for the voice server in browser tests: serves the built harness and a
 * Socket.io `/voice` namespace that records every client message and lets a test
 * push scripted server messages. Holds no secrets and talks to nothing external.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Server as SocketServer, type Socket } from 'socket.io';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export interface ReceivedMessage { at: number; event: string; body: any }

export interface MockVoiceServer {
  url: string;
  received: ReceivedMessage[];
  /** Messages of one type sent by the client over the `message` channel. */
  messages(type: string): ReceivedMessage[];
  /** Client telemetry events of one type (single or batched). */
  telemetry(type: string): any[];
  send(message: Record<string, unknown>): void;
  waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void>;
  close(): Promise<void>;
}

export async function startMockVoiceServer(staticRoot: string, sessionId = 'e2e-session-1'): Promise<MockVoiceServer> {
  const received: ReceivedMessage[] = [];
  const sockets = new Set<Socket>();

  const http: HttpServer = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
    const file = join(staticRoot, path === '/' || path === '\\' ? 'index.html' : path);
    if (!file.startsWith(staticRoot)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      // The app makes best-effort API calls (micro-acks, diagnostics); answer them harmlessly.
      res.writeHead(path.startsWith('/api/') ? 204 : 404).end();
    }
  });

  const io = new SocketServer(http, { transports: ['websocket'], maxHttpBufferSize: 10e6 });
  io.of('/voice').on('connection', socket => {
    sockets.add(socket);
    socket.on('disconnect', () => sockets.delete(socket));
    socket.on('heartbeat', () => socket.emit('heartbeat_ack'));
    for (const event of ['message', 'client_telemetry', 'client_telemetry_batch']) {
      socket.on(event, (body: any) => {
        received.push({ at: Date.now(), event, body });
        if (event === 'message' && body?.type === 'start_session') {
          socket.emit('message', { type: 'session_started', sessionId, voiceSessionId: 'e2e-db-session', isGeminiLive: true, timestamp: Date.now() });
        }
      });
    }
  });

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as { port: number };

  const server: MockVoiceServer = {
    url: `http://127.0.0.1:${port}/`,
    received,
    messages: type => received.filter(r => r.event === 'message' && r.body?.type === type),
    telemetry: type => received.flatMap(r =>
      r.event === 'client_telemetry' ? [r.body] : r.event === 'client_telemetry_batch' ? r.body : [])
      .filter((e: any) => e?.type === type),
    send: message => { for (const socket of sockets) socket.emit('message', { timestamp: Date.now(), ...message }); },
    async waitFor(predicate, timeoutMs, label) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
        await new Promise(r => setTimeout(r, 100));
      }
    },
    close: () => new Promise<void>(resolve => { io.close(); http.close(() => resolve()); }),
  };
  return server;
}
