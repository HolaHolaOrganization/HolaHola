import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { after, before, test } from "node:test";
import ts from "typescript";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerRuntimeCentralRecordsRoutes } from "../routes/runtime-central-records-routes";
import { COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR } from "../middleware/coordination-auth";
import {
  CENTRAL_READ_SCOPES, CENTRAL_READER_ACTORS, assertGenericRegistrationScopes,
  isCentralReadScope, validCentralReaderAudience,
} from "../../shared/central-read-policy";
import {
  centralRecordAccessAuditValues, type CentralRecordAccessAudit,
} from "../services/central-record-access-audit";
import type { CentralEpisodeRow } from "../services/central-episode-records";
import type { BrokerCredential } from "../services/coordination-credential-broker";

// Synthetic fixtures and ephemeral HTTP only. No database or credential writes.
const episode: CentralEpisodeRow = {
  id: "fixture-episode", title: "Episode 34", content: "# Verbatim\r\nHola — 你好\n",
  recordedAt: "2026-10-27T00:00:00.123456Z", tags: [],
  entryType: "episode", parentId: null, parentTitle: null, bytes: 0,
};
const story: CentralEpisodeRow = {
  ...episode, id: "fixture-story", title: "Story", content: "Authored story.\n",
  tags: ["episode-story"], parentId: episode.id, parentTitle: episode.title,
};
let base: string;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let repoCalls = 0, resolveCalls = 0;
let rows: CentralEpisodeRow[] = [episode, story];
let audits: CentralRecordAccessAudit[] = [];
let failRepository = false, failAudit = false;
let lastResolved: unknown[] = [];

before(async () => {
  const app = express();
  registerRuntimeCentralRecordsRoutes(app, {
    resolve: async (...args) => {
      resolveCalls++;
      lastResolved = args;
      const token = args[0];
      if (token === "auth-down") throw new Error("SECRET BACKEND DETAIL");
      if (token === "invalid" || token === "revoked") {
        return { ok: false, status: 401, error: "SECRET TOKEN DETAILS" };
      }
      if (token === "no-cap") return { ok: false, status: 403, error: "scope missing" };
      if (token === "legacy") return { ok: true, actor: "luca-replit", authType: "legacy" };
      const credential: BrokerCredential = {
        actor: token === "daniela" ? "daniela" : "luca-replit",
        runtimeId: "fixture-runtime", credentialId: "fixture-credential",
        centralGrantId: token === "unbound" ? undefined : "fixture-grant",
        capabilities: token === "admin" ? ["coordination:runtime:admin"]
          : token === "coordination" ? ["coordination:read"] : ["central-records:read"],
        expiresAt: new Date(Date.now() + 60_000), standingVerifier: false,
      };
      if (token === "expired") credential.expiresAt = new Date(0);
      if (token === "invalid-expiry") credential.expiresAt = new Date(NaN);
      if (token === "empty-runtime") credential.runtimeId = "";
      if (token === "empty-id") credential.credentialId = "";
      return {
        ok: true, actor: token === "mismatch" ? "alden" : credential.actor,
        authType: "broker", credential,
      };
    },
    repository: async () => {
      repoCalls++;
      if (failRepository) throw new Error("PRIVATE DATABASE ERROR");
      return {
        list: async (limit, offset) => rows.slice(offset, offset + limit),
        find: async id => rows.find(row => row.id === id) ?? null,
      };
    },
    audit: async event => {
      if (failAudit) throw new Error("PRIVATE AUDIT ERROR");
      audits.push(event);
    },
  });
  server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runtime/central-records`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
});
const request = (path = "", token: string | null = "valid", headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...(token ? { "x-coordination-token": token } : {}), ...headers } });

test("missing token or ambiguous Authorization never invokes resolver/repository", async () => {
  const beforeRepo = repoCalls, beforeResolve = resolveCalls;
  assert.equal((await request("", null)).status, 401);
  assert.equal((await request("", "valid", { Authorization: "Bearer other" })).status, 401);
  assert.equal(repoCalls, beforeRepo);
  assert.equal(resolveCalls, beforeResolve);
});
for (const [token, status] of [
  ["invalid", 401], ["revoked", 401], ["no-cap", 403], ["legacy", 403],
  ["daniela", 403], ["mismatch", 403], ["expired", 403], ["invalid-expiry", 403],
  ["empty-runtime", 403], ["empty-id", 403], ["admin", 403], ["coordination", 403],
  ["unbound", 403], ["auth-down", 503],
] as const) {
  test(`${token} is refused before canonical access`, async () => {
    const beforeRepo = repoCalls, beforeAudit = audits.length;
    const response = await request("", token);
    assert.equal(response.status, status);
    assert.match(response.headers.get("cache-control")!, /private.*no-store/);
    assert.equal(repoCalls, beforeRepo);
    assert.equal(audits.length, beforeAudit);
    assert.doesNotMatch(await response.text(), /SECRET|PRIVATE/);
  });
}
test("catalog is bounded, no content; identity and allowlist come from resolver", async () => {
  const response = await request("?limit=1&offset=0", "valid",
    { "x-actor": "david", "x-runtime-id": "forged" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].id, episode.id);
  assert.equal(body.nextOffset, 1);
  assert.equal(body.records[0].content, undefined);
  assert.equal(lastResolved[1], "central-records:read");
  assert.equal(lastResolved[2], CENTRAL_READER_ACTORS);
  assert.deepEqual(audits.at(-1), {
    actor: "luca-replit", runtimeId: "fixture-runtime", credentialId: "fixture-credential",
    operation: "catalog", recordIds: [episode.id], limit: 1, offset: 0,
  });
});
for (const query of ["?limit=101", "?limit=0", "?limit=1&limit=2",
  "?offset=-1", "?offset=9007199254740991", "?actor=david", "?offset=1.5"]) {
  test(`reject malformed catalog ${query} before lookup`, async () => {
    const calls = repoCalls;
    assert.equal((await request(query)).status, 400);
    assert.equal(repoCalls, calls);
  });
}
test("read uses exact UTF-8 snapshot and canonical-ID audit", async () => {
  const response = await request("/" + episode.id);
  assert.equal(response.status, 200);
  const { record } = await response.json();
  const sha256 = createHash("sha256").update(episode.content).digest("hex");
  assert.equal(record.content, episode.content);
  assert.equal(record.bytes, Buffer.byteLength(episode.content));
  assert.equal(record.sha256, sha256);
  assert.equal(response.headers.get("x-content-sha256"), sha256);
  assert.deepEqual(audits.at(-1)?.recordIds, [episode.id]);
  assert.equal(audits.at(-1)?.sha256, sha256);
  assert.equal(audits.at(-1)?.operation, "read");
});
test("story download retains exact bytes and linked filename", async () => {
  const response = await request(`/${story.id}/markdown`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /episode-34-story.md/);
  assert.equal(await response.text(), story.content);
  assert.equal(audits.at(-1)?.operation, "markdown");
});
test("growing record with pinned hash conflicts and sends no content", async () => {
  const hash = createHash("sha256").update(episode.content).digest("hex");
  const beforeAudit = audits.length;
  rows = [{ ...episode, content: episode.content + "Next turn\n" }, story];
  try {
    const response = await request(`/${episode.id}/markdown?sha256=${hash}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "record_changed");
    assert.equal(audits.length, beforeAudit);
  } finally { rows = [episode, story]; }
});
test("matching digest returns the pinned bytes", async () => {
  const hash = createHash("sha256").update(episode.content).digest("hex");
  const response = await request(`/${episode.id}/markdown?sha256=${hash}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), episode.content);
});
test("missing, malformed and extra identity query never leak content", async () => {
  assert.equal((await request("/missing")).status, 404);
  for (const path of [`/${episode.id}?sha256=x`, `/${episode.id}?actor=david`,
    `/${episode.id}?sha256=${"a".repeat(64)}&sha256=${"b".repeat(64)}`]) {
    const beforeRepo = repoCalls;
    assert.equal((await request(path)).status, 400);
    assert.equal(repoCalls, beforeRepo);
  }
});
test("audit failure prevents content/catalog/download delivery", async () => {
  failAudit = true;
  try {
    for (const path of ["", "/" + episode.id, `/${story.id}/markdown`]) {
      const response = await request(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-content-sha256"), null);
      const text = await response.text();
      assert.doesNotMatch(text, /PRIVATE|Verbatim|Authored story/);
    }
  } finally { failAudit = false; }
});
test("repository failure is sanitized", async () => {
  failRepository = true;
  try {
    const response = await request("/" + episode.id);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE DATABASE/);
  } finally { failRepository = false; }
});
test("audit persistence projection excludes extra secret/content properties", () => {
  const value = centralRecordAccessAuditValues({
    actor: "alden", runtimeId: "r", credentialId: "c", operation: "read",
    recordIds: ["canonical-id"], sha256: "a".repeat(64), bytes: 3,
    secret: "DO NOT STORE", content: "DO NOT STORE", token: "DO NOT STORE",
  } as CentralRecordAccessAudit);
  assert.doesNotMatch(JSON.stringify(value), /DO NOT STORE|secret|content|token/);
  assert.equal(value.eventType, "central_records_read");
});
test("same explicit allowlist validates audiences; no wildcard or implicit actors", () => {
  assert.equal(validCentralReaderAudience(["alden", "luca-replit"]), true);
  for (const values of [[], ["alden", "alden"], ["david"], ["daniela"],
    ["coordination-system"], ["student"], ["luca-codex"], ["luca-*"]]) {
    assert.equal(validCentralReaderAudience(values), false);
  }
});
test("no legacy actor inherits either new scope", () => {
  for (const values of Object.values(COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR)) {
    assert.equal(values.some(isCentralReadScope), false);
  }
});
test("generic constructors reject new scopes; guard precedes all validation/writes", () => {
  for (const capability of CENTRAL_READ_SCOPES) {
    assert.throws(() => assertGenericRegistrationScopes([capability]), /founder issuance/);
    assert.throws(() => assertGenericRegistrationScopes(["coordination:read", capability]), /founder issuance/);
  }
  assert.doesNotThrow(() => assertGenericRegistrationScopes(["coordination:read"]));
  const source = readFileSync("server/services/coordination-credential-broker.ts", "utf8");
  const validation = source.slice(source.indexOf("function validateRuntimeRegistrationInput"),
    source.indexOf("async function audit("));
  const guard = validation.indexOf("assertGenericRegistrationScopes(input.capabilities)");
  assert.ok(guard >= 0);
  assert.ok(guard < validation.indexOf("if (!input.runtimeId"));
  const tool = readFileSync("server/services/alden-functions.ts", "utf8");
  assert.match(tool, /capability !== 'coordination:runtime:admin' && !isCentralReadScope\(capability\)/);
});

test("all three actual issuer bodies refuse new scopes before any executor/DB use", async () => {
  const source = readFileSync("server/services/coordination-credential-broker.ts", "utf8");
  const names = [
    "validateRuntimeRegistrationInput", "registerCoordinationRuntime",
    "registerCoordinationRuntimeForOnboardingInExecutor",
    "registerCoordinationRuntimeWithBootstrapSha256InExecutor",
  ];
  const parsed = ts.createSourceFile("broker.ts", source, ts.ScriptTarget.ES2022, true);
  // Compile the unchanged real function bodies with a forbidden DB boundary.
  // Do not import broker/db: these tests must remain hermetic even without env.
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
    && node.name && names.includes(node.name.text)).map(node => node.getText(parsed));
  assert.equal(functions.length, names.length);
  const js = ts.transpileModule(functions.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let databaseTouches = 0;
  const forbidden = () => { databaseTouches++; throw new Error("forbidden DB/secret generation"); };
  const exports: Record<string, Function> = {};
  runInNewContext(js, {
    exports, assertGenericRegistrationScopes, getSharedDb: forbidden,
    generateCoordinationSecret: forbidden,
  });
  for (const name of names.slice(1)) {
    for (const cap of CENTRAL_READ_SCOPES) {
      await assert.rejects(exports[name]({
        runtimeId: "fixture-runtime", actor: "alden", displayName: "Synthetic",
        capabilities: ["coordination:runtime:admin", cap],
        bootstrapSha256: "a".repeat(64),
      }, { insert: forbidden }), /founder issuance/);
    }
  }
  assert.equal(databaseTouches, 0);
});
