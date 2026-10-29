import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Application, Request, RequestHandler, Response } from "express";
import {
  CentralGrantError, centralGrantSnapshot, exchangeCentralRead, grantCentralRead, revokeCentralRead,
} from "../services/central-read-grants";

type SessionRequest = Request & {
  session?: Record<string, any>; authenticatedUser?: { id: string };
};
export interface CentralGrantRouteDependencies {
  founderMiddleware?: RequestHandler;
  canonicalFounder?: (id: string | undefined) => boolean;
  origin?: string;
  snapshot?: typeof centralGrantSnapshot;
  grant?: typeof grantCentralRead;
  revoke?: typeof revokeCentralRead;
  exchange?: typeof exchangeCentralRead;
}
const secretHeaders = ["authorization", "x-coordination-token", "x-coordination-bootstrap",
  "x-agent-token", "x-guardian-token"];
function csrf(req: SessionRequest): string {
  if (!req.session) return "";
  return req.session.centralReadCsrf ??= randomBytes(32).toString("base64url");
}
function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !b || a.length > 128) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function replyError(res: Response, error: unknown) {
  if (error instanceof CentralGrantError) {
    res.status(error.status).json({ error: error.code });
  } else {
    res.status(503).json({ error: "central_grants_unavailable" });
  }
}
export function registerCentralReadGrantRoutes(app: Application, deps: CentralGrantRouteDependencies = {}) {
  const root = "/api/runtime/central-read";
  const privateResponse: RequestHandler = (_req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", Vary: "Cookie, X-Coordination-Token, Authorization" });
    next();
  };
  const founder: RequestHandler = async (req: SessionRequest, res, next) => {
    if (secretHeaders.some(h => req.header(h))) {
      res.status(401).json({ error: "founder_session_required" }); return;
    }
    const enforce: RequestHandler = async () => {
      const canonical = deps.canonicalFounder ?? (await import("../middleware/rbac")).isCanonicalFounderId;
      if (!req.session || !canonical(req.authenticatedUser?.id)) {
        res.status(403).json({ error: "canonical_founder_required" }); return;
      }
      next();
    };
    try {
      if (deps.founderMiddleware) {
        deps.founderMiddleware(req, res, error => error ? replyError(res, error) : void enforce(req, res, next));
      } else {
        const [{ isAuthenticated }, { loadAuthenticatedUser, requireFounder }, { storage },
          { chainMiddleware }] = await Promise.all([
          import("../replitAuth"), import("../middleware/rbac"), import("../storage"),
          import("../middleware/coordination-auth"),
        ]);
        chainMiddleware([isAuthenticated, loadAuthenticatedUser(storage), requireFounder, enforce])(req, res, next);
      }
    } catch (error) { replyError(res, error); }
  };
  const mutate: RequestHandler = (req: SessionRequest, res, next) => {
    let expected: string;
    try {
      const configured = deps.origin ?? process.env.APP_URL;
      if (!configured) throw new Error("missing origin");
      expected = new URL(configured).origin;
    } catch {
      res.status(503).json({ error: "central_grant_origin_unconfigured" }); return;
    }
    if (req.header("origin") !== expected || !safeEqual(req.body?.csrfToken, csrf(req))) {
      res.status(403).json({ error: "csrf_required" }); return;
    }
    next();
  };
  app.get(`${root}/admin`, privateResponse, founder, async (req: SessionRequest, res) => {
    try { res.json({ ...await (deps.snapshot ?? centralGrantSnapshot)(), csrfToken: csrf(req) }); }
    catch (error) { replyError(res, error); }
  });
  app.post(`${root}/admin/grants`, privateResponse, founder, mutate, async (req: SessionRequest, res) => {
    const body = req.body;
    if (!body || Object.keys(body).some(k => !["runtimeId", "actor", "expiresAt", "expectedGrantId", "csrfToken"].includes(k))
      || !["runtimeId", "actor", "expiresAt"].every(k => typeof body[k] === "string" && body[k].length > 0 && body[k].length < 160)
      || !(body.expectedGrantId === null || (typeof body.expectedGrantId === "string" && body.expectedGrantId.length < 160))) {
      res.status(400).json({ error: "invalid_grant" }); return;
    }
    try {
      const grant = await (deps.grant ?? grantCentralRead)({ runtimeId: body.runtimeId, actor: body.actor,
        expiresAt: body.expiresAt, expectedGrantId: body.expectedGrantId, founderId: req.authenticatedUser!.id });
      res.status(201).json({ grant });
    } catch (error) { replyError(res, error); }
  });
  app.post(`${root}/admin/grants/:id/revoke`, privateResponse, founder, mutate, async (req: SessionRequest, res) => {
    if (Object.keys(req.body ?? {}).some(k => k !== "csrfToken") || !/^[a-zA-Z0-9-]{1,128}$/.test(req.params.id)) {
      res.status(400).json({ error: "invalid_grant" }); return;
    }
    try { res.json({ grant: await (deps.revoke ?? revokeCentralRead)({
      grantId: req.params.id, founderId: req.authenticatedUser!.id,
    }) }); } catch (error) { replyError(res, error); }
  });
  app.post(`${root}/exchange`, privateResponse, async (req, res) => {
    const token = req.header("x-coordination-token");
    if (!token || token.length > 512 || secretHeaders.filter(h => h !== "x-coordination-token").some(h => req.header(h))) {
      res.status(401).json({ error: "routine_credential_required" }); return;
    }
    if (Object.keys(req.body ?? {}).some(k => k !== "grantId")
      || !/^[a-zA-Z0-9-]{1,128}$/.test(req.body?.grantId ?? "")) {
      res.status(400).json({ error: "invalid_grant_reference" }); return;
    }
    try { res.status(201).json(await (deps.exchange ?? exchangeCentralRead)(token, req.body.grantId)); }
    catch (error) { replyError(res, error); }
  });
}
