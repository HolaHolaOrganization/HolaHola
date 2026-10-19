// HTTP surface. Two routes only:
//   GET  /healthz        -> { ok, state, epoch } (both public: the policy file is on a public main)
//   POST /v1/operations  -> a Decision
// Bodies are capped, must be JSON, and are never echoed back. There is no
// passthrough, no login and no admin route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decide } from './authorize.ts';
import { type PolicyLoader } from './policy.ts';

export const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createBrokerServer(loader: PolicyLoader, now: () => number = Date.now): Server {
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        const policy = await loader.current();
        return send(res, policy ? 200 : 503, policy ? { ok: true, state: policy.state, epoch: policy.epoch } : { ok: false, state: null });
      }
      if (path !== '/v1/operations') return send(res, 404, { error: 'not_found' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return send(res, 415, { error: 'unsupported_media_type' });
      }
      const raw = await readBody(req);
      if (!raw) return send(res, 413, { error: 'body_too_large' });
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { decision: 'deny', reason: 'malformed' });
      }
      const decision = await decide(body, loader, now);
      return send(res, decision.decision === 'allow' ? 200 : 403, decision);
    } catch {
      if (!res.headersSent) send(res, 500, { decision: 'deny', reason: 'internal_error' });
      else res.destroy();
    }
  });
}
