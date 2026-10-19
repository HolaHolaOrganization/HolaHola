// HTTP surface. Two routes only:
//   GET  /healthz        -> { ok, state, epoch } (both public: the policy file is on a public main)
//   POST /v1/operations  -> a denial, or the gateway's result for an allowed request
// Bodies are capped, must be JSON, and are never echoed back. There is no
// passthrough, no login and no admin route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decide, type LoaderFor } from './authorize.ts';
import { type Gateway } from './gateway.ts';
import { type PolicyLoader } from './policy.ts';

export type BrokerServerOptions = {
  loaderFor: LoaderFor;
  /** Any configured actor's loader, for the public health read only. */
  healthLoader: PolicyLoader;
  /** Absent: allowed requests are refused as not_implemented (no operations wired). */
  gateway?: Gateway;
  now?: () => number;
};

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

export function createBrokerServer(options: BrokerServerOptions): Server {
  const now = options.now ?? Date.now;
  return createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') {
        const policy = await options.healthLoader.current();
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
      const decision = await decide(body, options.loaderFor, now);
      if (decision.decision === 'deny') return send(res, 403, decision);
      if (!options.gateway) return send(res, 403, { decision: 'deny', reason: 'not_implemented', operationId: decision.operationId });
      const { envelope, digest, payload, policy } = decision.authorized;
      const result = await options.gateway.execute(body, envelope, digest, payload, policy.epoch);
      return send(res, result.status, result.body);
    } catch {
      if (!res.headersSent) send(res, 500, { decision: 'deny', reason: 'internal_error' });
      else res.destroy();
    }
  });
}
