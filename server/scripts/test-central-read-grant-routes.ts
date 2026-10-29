import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerCentralReadGrantRoutes } from "../routes/central-read-grant-routes";
import { CentralGrantError } from "../services/central-read-grants";

let server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
let calls: unknown[] = [], fail = false;
const grant = { id: "grant-1", runtimeId: "runtime-1", actor: "luca-replit",
  scope: "central-records:read", grantedBy: "canonical-founder", expiresAt: "2035-01-01T00:00:00.000Z", revokedAt: null };
before(async () => {
  const app = express();
  app.use(express.json());
  registerCentralReadGrantRoutes(app, {
    origin: "https://trusted.example",
    founderMiddleware: (req: any, _res, next) => {
      req.session = { centralReadCsrf: "fixture-csrf" };
      req.authenticatedUser = { id: req.header("x-fixture-founder") };
      next();
    },
    canonicalFounder: id => id === "canonical-founder",
    snapshot: async () => ({ runtimes: [], grants: [], maximumExpiresAt: "2028-01-01T00:00:00.000Z" }),
    grant: async input => {
      calls.push(input);
      if (fail) throw new Error("SECRET backend detail");
      return grant;
    },
    revoke: async input => { calls.push(input); return { ...grant, revokedAt: grant.expiresAt }; },
    exchange: async (token, id) => {
      calls.push({ token, id });
      if (token !== "routine") throw new CentralGrantError(401, "routine_credential_required");
      return { accessToken: "synthetic-central-token", tokenType: "Coordination", actor: "luca-replit",
        runtimeId: "runtime-1", credentialId: "credential-1", grantId: id,
        capabilities: ["central-records:read"], expiresAt: grant.expiresAt };
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runtime/central-read`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
async function post(path = "/admin/grants", body: unknown = {
  runtimeId: "runtime-1", actor: "luca-replit", expiresAt: grant.expiresAt,
  expectedGrantId: null, csrfToken: "fixture-csrf",
}, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json",
    origin: "https://trusted.example", "x-fixture-founder": "canonical-founder", ...headers },
    body: JSON.stringify(body) });
}
test("founder snapshot is private, content-free and contains a session CSRF token", async () => {
  const response = await fetch(base + "/admin", { headers: { "x-fixture-founder": "canonical-founder" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(await response.json(), { runtimes: [], grants: [],
    maximumExpiresAt: "2028-01-01T00:00:00.000Z", csrfToken: "fixture-csrf" });
});
for (const id of ["", "admin", "alden", "dev-test-agent"]) {
  test(`noncanonical founder ${id || "missing"} cannot grant`, async () => {
    const count = calls.length;
    assert.equal((await post(undefined, undefined, { "x-fixture-founder": id })).status, 403);
    assert.equal(calls.length, count);
  });
}
for (const header of ["authorization", "x-coordination-token", "x-coordination-bootstrap", "x-agent-token"]) {
  test(`even a founder cookie cannot mix ${header} authentication`, async () => {
    const count = calls.length;
    assert.equal((await post(undefined, undefined, { [header]: "synthetic" })).status, 401);
    assert.equal(calls.length, count);
  });
}
test("a hostile Origin is denied even with a matching Host", async () => {
  assert.equal((await post(undefined, undefined, { origin: "https://evil.example", host: "evil.example" })).status, 403);
});
test("missing CSRF fails and no request identity is trusted", async () => {
  assert.equal((await post("/admin/grants", { runtimeId: "runtime-1", actor: "luca-replit",
    expiresAt: grant.expiresAt, expectedGrantId: null })).status, 403);
  assert.equal((await post("/admin/grants", { runtimeId: "runtime-1", actor: "luca-replit",
    expiresAt: grant.expiresAt, expectedGrantId: null, csrfToken: "fixture-csrf", founderId: "forged" })).status, 400);
});
test("valid grant passes the verified session identity and exact expected state", async () => {
  assert.equal((await post()).status, 201);
  assert.deepEqual(calls.at(-1), { runtimeId: "runtime-1", actor: "luca-replit",
    expiresAt: grant.expiresAt, expectedGrantId: null, founderId: "canonical-founder" });
});
test("absent document scope cannot be requested", async () => {
  assert.equal((await post("/admin/grants", { runtimeId: "runtime-1", actor: "luca-replit",
    expiresAt: grant.expiresAt, expectedGrantId: null, csrfToken: "fixture-csrf", scope: "central-documents:read" })).status, 400);
});
test("revoke is founder-only and never changes runtime-wide permissions", async () => {
  assert.equal((await post("/admin/grants/grant-1/revoke", { csrfToken: "fixture-csrf" })).status, 200);
  assert.deepEqual(calls.at(-1), { grantId: "grant-1", founderId: "canonical-founder" });
});
test("backend errors never expose exception details", async () => {
  fail = true;
  try {
    const response = await post();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "central_grants_unavailable" });
  } finally { fail = false; }
});
test("runtime exchange uses only its own broker header and no session fallback", async () => {
  assert.equal((await post("/exchange", { grantId: "grant-1" })).status, 401);
  assert.equal((await post("/exchange", { grantId: "grant-1" }, { "x-coordination-token": "central-only" })).status, 401);
  assert.equal((await post("/exchange", { grantId: "grant-1", actor: "forged" },
    { "x-coordination-token": "routine" })).status, 400);
  const response = await post("/exchange", { grantId: "grant-1" }, { "x-coordination-token": "routine" });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal((await response.json()).accessToken, "synthetic-central-token");
});
