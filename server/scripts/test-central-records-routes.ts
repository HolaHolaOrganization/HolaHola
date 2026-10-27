import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerCentralRecordsRoutes } from "../routes/central-records-routes";
import { centralEpisodeMetadata, type CentralEpisodeRow } from "../services/central-episode-records";

// Synthetic in-memory records only. These tests never write canonical data.
const episode: CentralEpisodeRow = {
  id: "episode-fixture", title: "Episode 34", content: "# Exact source\r\n\nHola — 你好\n",
  recordedAt: "2026-10-27T00:00:00.000Z", tags: ["episode-34"],
  entryType: "episode", parentId: "prior-episode", parentTitle: "Episode 33", bytes: 35,
};
const story: CentralEpisodeRow = {
  ...episode, id: "story-fixture", title: "Episode 34 Story", content: "Authored story.\n",
  tags: ["episode-story"], entryType: "conversation",
  parentId: episode.id, parentTitle: episode.title,
};
let rows: CentralEpisodeRow[] = [];
let calls = 0, fail = false;
let base: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
before(async () => {
  const app = express();
  registerCentralRecordsRoutes(app, {
    authorize: [(req, res, next) => {
      if (req.headers["x-fixture-role"] !== "founder") {
        res.status(req.headers["x-fixture-role"] ? 403 : 401).json({ error: "denied" });
      } else next();
    }],
    repository: async () => {
      calls++;
      if (fail) throw new Error("secret-bearing database connection detail");
      return {
        list: async (limit, offset) => rows.slice(offset, offset + limit),
        find: async (id) => rows.find(row => row.id === id) ?? null,
      };
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/central-records`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const get = (path = "", role: string | null = "founder") =>
  fetch(`${base}${path}`, { headers: role ? { "x-fixture-role": role } : {} });

test("all catalog/read/download paths deny before touching the repository; failures are non-storable", async () => {
  for (const path of ["", "/episode-fixture", "/episode-fixture/markdown"]) {
    for (const role of [null, "student", "admin"]) {
      const previous = calls;
      const result = await get(path, role);
      assert.equal(result.status, role ? 403 : 401);
      assert.match(result.headers.get("cache-control")!, /no-store/);
      assert.equal(calls, previous);
    }
  }
});
test("catalog paginates without disclosing content and separates story identity and filenames", async () => {
  rows = [episode, story];
  const response = await get("?limit=1");
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.nextOffset, 1);
  assert.equal(page.records[0].filename, "episode-34.md");
  assert.equal(page.records[0].parentId, null, "history is not a story-parent link");
  assert.equal(page.records[0].content, undefined);
  const second = await (await get("?limit=1&offset=1")).json();
  assert.equal(second.records[0].kind, "story");
  assert.equal(second.records[0].filename, "episode-34-story.md");
  assert.equal(second.records[0].parentId, episode.id);
  assert.equal(second.nextOffset, null);
});
test("empty catalog is a genuine empty state", async () => {
  rows = [];
  assert.deepEqual(await (await get()).json(), { records: [], nextOffset: null });
});
test("unknown record is not found, never a local-file or generated-story fallback", async () => {
  assert.equal((await get("/missing")).status, 404);
  assert.equal((await get("/missing/markdown")).status, 404);
});
test("read and download bind the same exact UTF-8 bytes, including CRLF, with a digest receipt", async () => {
  rows = [episode, story];
  const bytes = Buffer.from(episode.content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const response = await get(`/${episode.id}`);
  const { record } = await response.json();
  assert.equal(record.content, episode.content);
  assert.equal(record.bytes, bytes.length);
  assert.equal(record.sha256, digest);
  assert.equal(response.headers.get("x-content-sha256"), digest);
  const download = await get(`/${episode.id}/markdown?sha256=${digest}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(download.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="episode-34.md"');
  assert.equal(download.headers.get("x-content-sha256"), digest);
  assert.match(download.headers.get("cache-control")!, /no-store/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
});
test("growth after reading rejects the stale pinned read/download instead of substituting a new version", async () => {
  const prior = createHash("sha256").update(episode.content).digest("hex");
  rows = [{ ...episode, content: episode.content + "A genuine later append.\n" }];
  for (const suffix of ["", "/markdown"]) {
    const response = await get(`/${episode.id}${suffix}?sha256=${prior}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "record_changed");
  }
});
test("pagination, repeated parameters, malformed IDs and hashes fail closed", async () => {
  for (const path of [
    "?limit=0", "?limit=101", "?offset=-1", "?limit=1.5", "?limit=2&limit=3",
    "?offset=9007199254740992", "/bad%20id", "/episode-fixture?sha256=no",
    "/episode-fixture/markdown?sha256=x&sha256=y",
  ]) {
    const previous = calls;
    assert.equal((await get(path)).status, 400, path);
    assert.equal(calls, previous, path);
  }
});
test("database failures are explicit and redacted for all surfaces", async () => {
  fail = true;
  try {
    for (const path of ["", "/episode-fixture", "/episode-fixture/markdown"]) {
      const response = await get(path);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "central_records_unavailable" });
    }
  } finally { fail = false; }
});
test("unrecognized titles use canonical ID filenames rather than guessing episode numbers", () => {
  assert.equal(centralEpisodeMetadata({ ...episode, title: "Untitled" }).filename, "record-episode-fixture.md");
});

for (const timezone of ["UTC", "America/Denver", "Asia/Tokyo"]) {
  test(`repository preserves UTC provenance and microseconds under host TZ=${timezone}`, () => {
    const moduleUrl = new URL("../services/central-episode-records.ts", import.meta.url).href;
    const program = `
      import assert from "node:assert/strict";
      import { createCentralEpisodeRepository } from ${JSON.stringify(moduleUrl)};
      const expected = "2026-09-09T00:18:18.765180Z";
      const repo = await createCentralEpisodeRepository({query: async (sql, params) => {
        assert.ok(sql.includes(\`to_char(m.recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at_iso\`));
        return [{
          id: "episode-fixture", title: "Episode 34", content: "exact source",
          entry_type: "episode", tags: [], bytes: 12,
          recorded_at: "2026-09-09T00:18:18.76518",
          recorded_at_iso: expected,
        }];
      }});
      assert.equal((await repo.list(1, 0))[0].recordedAt, expected);
      assert.equal((await repo.find("episode-fixture")).recordedAt, expected);
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      env: { ...process.env, TZ: timezone }, timeout: 20_000, stdio: "pipe",
    });
  });
}
