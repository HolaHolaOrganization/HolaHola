// HTTP surface. Two routes only:
//   GET  /healthz        -> { ok, state, epoch } (both public: the policy file is on a public main)
//   POST /v1/operations  -> a denial, or the gateway's result for an allowed request
// Bodies are capped, must be JSON, and are never echoed back. There is no
// passthrough, no login and no admin route.
//
// Large blob.put bodies (stage-1 design section 8) need a signed admission
// header, verified against policy before any body byte is read, and one of a
// bounded number of slots. Without admission configuration that path is off,
// and every body keeps the standard cap.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  ADMISSION_HEADER, type AdmissionConfig, type AdmissionManifest, AdmissionSlots, matchesManifest, parseAdmissionHeader,
  STANDARD_BODY_LIMIT, verifyAdmission,
} from './admission.ts';
import { decide, type LoaderFor } from './authorize.ts';
import { type Gateway } from './gateway.ts';
import { type PolicyLoader } from './policy.ts';

export type BrokerServerOptions = {
  loaderFor: LoaderFor;
  /** Any configured actor's loader, for the public health read only. */
  healthLoader: PolicyLoader;
  /** Absent: allowed requests are refused as not_implemented (no operations wired). */
  gateway?: Gateway;
  /** Absent: large-body admission is disabled (founder decision F5: no caps until configured). */
  admission?: AdmissionConfig;
  now?: () => number;
};

export const MAX_BODY_BYTES = STANDARD_BODY_LIMIT;
/** Design section 8: request headers must arrive within 5 s. */
export const HEADERS_TIMEOUT_MS = 5_000;
/**
 * How often Node checks headersTimeout. Its default is 30 s, which would let a
 * partial-header connection live about 30 s regardless of headersTimeout
 * (luca-replit PR #126 review, C-HEADERS).
 */
export const CONNECTIONS_CHECK_INTERVAL_MS = 250;

function send(res: ServerResponse, status: number, body: unknown, close = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text),
    // A refused admission is answered without reading its body, so the connection is not reused.
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(text);
}

type Timing = { deadlineMs: number; minBytesPerSecond: number };
type BodyResult = { ok: true; raw: Buffer } | { ok: false; reason: 'too_large' | 'too_slow' };

/**
 * Counts streamed bytes (never trusting Content-Length) and stops at `limit`.
 * With `timing`, a body that misses the deadline or falls below the minimum
 * average rate after its first second has its connection destroyed.
 */
async function readBody(req: IncomingMessage, limit: number, timing?: Timing): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let slow = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (timing) {
    const start = performance.now();
    timer = setInterval(() => {
      const elapsed = performance.now() - start;
      if (elapsed >= timing.deadlineMs || (elapsed >= 1_000 && size < (timing.minBytesPerSecond * elapsed) / 1_000)) {
        slow = true;
        req.destroy();
      }
    }, 50);
  }
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) return { ok: false, reason: 'too_large' };
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (slow) return { ok: false, reason: 'too_slow' };
    throw error;
  } finally {
    if (timer) clearInterval(timer);
  }
  return slow ? { ok: false, reason: 'too_slow' } : { ok: true, raw: Buffer.concat(chunks) };
}

export function createBrokerServer(options: BrokerServerOptions): Server {
  const now = options.now ?? Date.now;
  const slots = options.admission ? new AdmissionSlots(options.admission) : null;
  const server = createServer({ connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS }, async (req, res) => {
    let release: (() => void) | undefined;
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

      // Admission is decided from the header alone, before any body byte is read.
      let manifest: AdmissionManifest | null = null;
      const header = req.headers[ADMISSION_HEADER];
      if (header !== undefined) {
        if (!options.admission || !slots) return send(res, 413, { decision: 'deny', reason: 'large_body_disabled' }, true);
        const parsed = parseAdmissionHeader(header);
        if (!parsed) return send(res, 400, { decision: 'deny', reason: 'admission_invalid' }, true);
        const policy = await options.loaderFor(parsed.manifest.actor)?.current();
        if (!policy) return send(res, 403, { decision: 'deny', reason: 'admission_invalid' }, true);
        const verified = verifyAdmission(parsed, policy, options.admission, now());
        if (!verified.ok) return send(res, verified.reason === 'too_large' ? 413 : 400, { decision: 'deny', reason: verified.reason }, true);
        const length = req.headers['content-length'];
        if (length !== undefined && Number(length) !== verified.manifest.bodySize) return send(res, 400, { decision: 'deny', reason: 'admission_invalid' }, true);
        const slot = slots.reserve(verified.manifest.actor, verified.manifest.admissionId);
        if (!slot.ok) return send(res, slot.reason === 'busy' ? 503 : 400, { decision: 'deny', reason: slot.reason }, true);
        release = slot.release;
        manifest = verified.manifest;
      }

      const read = await readBody(req, manifest ? manifest.bodySize : MAX_BODY_BYTES,
        manifest && options.admission ? { deadlineMs: options.admission.bodyDeadlineMs, minBytesPerSecond: options.admission.minBytesPerSecond } : undefined);
      if (!read.ok) {
        if (read.reason === 'too_slow') return; // The connection was already destroyed.
        return send(res, 413, manifest ? { decision: 'deny', reason: 'admission_invalid' } : { error: 'body_too_large' }, true);
      }
      if (manifest && read.raw.length !== manifest.bodySize) return send(res, 400, { decision: 'deny', reason: 'admission_invalid' });
      let body: unknown;
      try {
        body = JSON.parse(read.raw.toString('utf8'));
      } catch {
        return send(res, 400, { decision: 'deny', reason: 'malformed' });
      }
      if (manifest && !matchesManifest(body, manifest)) return send(res, 400, { decision: 'deny', reason: 'admission_invalid' });
      // Admission is never authority: the full signed request is authorized as always.
      const decision = await decide(body, options.loaderFor, now);
      if (decision.decision === 'deny') return send(res, 403, decision);
      if (!options.gateway) return send(res, 403, { decision: 'deny', reason: 'not_implemented', operationId: decision.operationId });
      const { envelope, digest, payload, policy } = decision.authorized;
      const result = await options.gateway.execute(body, envelope, digest, payload, policy.epoch);
      return send(res, result.status, result.body);
    } catch {
      if (!res.headersSent) send(res, 500, { decision: 'deny', reason: 'internal_error' });
      else res.destroy();
    } finally {
      release?.();
    }
  });
  // Enforced by Node's connection checker, which runs every CONNECTIONS_CHECK_INTERVAL_MS.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
