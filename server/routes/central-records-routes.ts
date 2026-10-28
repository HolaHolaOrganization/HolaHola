import type { Application, RequestHandler } from "express";
import {
  centralEpisodeMetadata, centralEpisodeRead, createCentralEpisodeRepository,
  type CentralEpisodeRepository,
} from "../services/central-episode-records";

export function registerCentralRecordsRoutes(
  app: Application,
  options: {
    authorize: RequestHandler[];
    repository?: () => Promise<CentralEpisodeRepository>;
  },
) {
  const repository = options.repository ?? createCentralEpisodeRepository;
  const privateResponse: RequestHandler = (_req, res, next) => {
    res.set({
      "Cache-Control": "private, no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Vary": "Cookie, Authorization",
    });
    next();
  };
  const guards = [privateResponse, ...options.authorize];
  app.get("/api/admin/central-records", ...guards, async (req, res) => {
    const limitText = req.query.limit ?? "50";
    const offsetText = req.query.offset ?? "0";
    if (typeof limitText !== "string" || !/^[1-9]\d*$/.test(limitText)
      || Number(limitText) > 100 || typeof offsetText !== "string"
      || !/^(0|[1-9]\d*)$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) {
      res.status(400).json({ error: "invalid_pagination" });
      return;
    }
    try {
      const limit = Number(limitText), offset = Number(offsetText);
      const rows = await (await repository()).list(limit + 1, offset);
      res.json({
        records: rows.slice(0, limit).map(centralEpisodeMetadata),
        nextOffset: rows.length > limit ? offset + limit : null,
      });
    } catch {
      res.status(503).json({ error: "central_records_unavailable" });
    }
  });

  for (const download of [false, true]) {
    app.get(`/api/admin/central-records/:id${download ? "/markdown" : ""}`, ...guards, async (req, res) => {
      const id = req.params.id;
      const expected = req.query.sha256;
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)
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
        const record = centralEpisodeRead(row);
        if (expected !== undefined && expected !== record.sha256) {
          res.status(409).json({ error: "record_changed", sha256: record.sha256 });
          return;
        }
        res.set({ "X-Content-SHA256": record.sha256 });
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
        // Never disclose DB/connection errors, original records, or credentials.
        res.status(503).json({ error: "central_records_unavailable" });
      }
    });
  }
}
