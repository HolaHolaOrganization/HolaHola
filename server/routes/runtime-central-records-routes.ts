import type { Application, RequestHandler } from "express";
import { CENTRAL_READER_ACTORS } from "@shared/central-read-policy";
import { resolveCoordinationCapability } from "../middleware/coordination-auth";
import {
  centralEpisodeMetadata, centralEpisodeRead, createCentralEpisodeRepository,
  type CentralEpisodeRepository,
} from "../services/central-episode-records";
import {
  writeCentralRecordAccessAudit, type CentralRecordAccessAudit,
} from "../services/central-record-access-audit";

type Principal = Pick<CentralRecordAccessAudit, "actor" | "runtimeId" | "credentialId">;
export interface RuntimeCentralRecordsDependencies {
  resolve?: typeof resolveCoordinationCapability;
  repository?: () => Promise<CentralEpisodeRepository>;
  audit?: (event: CentralRecordAccessAudit) => Promise<void>;
}

/** First source increment: no grant/activation/mutation endpoint. */
export function registerRuntimeCentralRecordsRoutes(
  app: Application, options: RuntimeCentralRecordsDependencies = {},
): void {
  const resolve = options.resolve ?? resolveCoordinationCapability;
  const repository = options.repository ?? createCentralEpisodeRepository;
  const audit = options.audit ?? writeCentralRecordAccessAudit;
  const privateResponse: RequestHandler = (_req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      Vary: "X-Coordination-Token, Authorization",
    });
    next();
  };
  const authorize: RequestHandler = async (req, res, next) => {
    const token = req.header("x-coordination-token");
    // No session or Authorization-header fallback, and no identity from input.
    if (!token || req.header("authorization")) {
      res.status(401).json({ error: "central_read_authentication_required" });
      return;
    }
    try {
      const result = await resolve(token, "central-records:read", CENTRAL_READER_ACTORS,
        req.ip || req.socket.remoteAddress);
      if (!result.ok) {
        res.status(result.status).json({ error: "central_read_access_denied" });
        return;
      }
      const credential = result.credential;
      if (result.authType !== "broker" || !credential
        || credential.actor !== result.actor
        || !CENTRAL_READER_ACTORS.includes(result.actor)
        || !credential.capabilities.includes("central-records:read")
        || !credential.runtimeId || !credential.credentialId
        || !(credential.expiresAt instanceof Date)
        || !Number.isFinite(credential.expiresAt.getTime())
        || credential.expiresAt.getTime() <= Date.now()) {
        res.status(403).json({ error: "central_read_access_denied" });
        return;
      }
      res.locals.centralRecordPrincipal = {
        actor: credential.actor, runtimeId: credential.runtimeId,
        credentialId: credential.credentialId,
      } satisfies Principal;
      next();
    } catch {
      res.status(503).json({ error: "central_read_authentication_unavailable" });
    }
  };
  const prefix = "/api/runtime/central-records";
  app.get(prefix, privateResponse, authorize, async (req, res) => {
    const limitText = req.query.limit ?? "50", offsetText = req.query.offset ?? "0";
    if (Object.keys(req.query).some(key => !["limit", "offset"].includes(key))
      || typeof limitText !== "string" || !/^[1-9]\d*$/.test(limitText)
      || Number(limitText) > 100 || typeof offsetText !== "string"
      || !/^(0|[1-9]\d*)$/.test(offsetText)
      || !Number.isSafeInteger(Number(offsetText))
      || Number(offsetText) > Number.MAX_SAFE_INTEGER - 100) {
      res.status(400).json({ error: "invalid_pagination" });
      return;
    }
    try {
      const limit = Number(limitText), offset = Number(offsetText);
      const rows = await (await repository()).list(limit + 1, offset);
      const records = rows.slice(0, limit).map(centralEpisodeMetadata);
      await audit({ ...res.locals.centralRecordPrincipal as Principal,
        operation: "catalog", recordIds: records.map(record => record.id), limit, offset });
      res.json({ records, nextOffset: rows.length > limit ? offset + limit : null });
    } catch {
      res.status(503).json({ error: "central_records_unavailable" });
    }
  });
  for (const download of [false, true]) {
    app.get(`${prefix}/:id${download ? "/markdown" : ""}`, privateResponse, authorize, async (req, res) => {
      const id = req.params.id, expected = req.query.sha256;
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)
        || Object.keys(req.query).some(key => key !== "sha256")
        || (expected !== undefined && (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)))) {
        res.status(400).json({ error: "invalid_record_reference" });
        return;
      }
      try {
        const row = await (await repository()).find(id);
        if (!row) {
          res.status(404).json({ error: "record_not_found" });
          return;
        }
        if (row.id !== id) throw new Error("Canonical repository identity mismatch");
        const record = centralEpisodeRead(row);
        if (expected !== undefined && expected !== record.sha256) {
          res.status(409).json({ error: "record_changed", sha256: record.sha256 });
          return;
        }
        await audit({ ...res.locals.centralRecordPrincipal as Principal,
          operation: download ? "markdown" : "read", recordIds: [record.id],
          sha256: record.sha256, bytes: record.bytes });
        res.set("X-Content-SHA256", record.sha256);
        if (download) {
          res.set({
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${record.filename}"`,
          });
          res.send(Buffer.from(record.content, "utf8"));
        } else {
          res.json({ record });
        }
      } catch {
        res.status(503).json({ error: "central_records_unavailable" });
      }
    });
  }
}
