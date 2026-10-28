import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import pg from "pg";
import express from "express";
import type { AddressInfo } from "node:net";
import { getVerifiedCiDatabaseUrl } from "../ci-database";
import {
  centralGrantSnapshot, grantCentralRead, revokeCentralRead, exchangeCentralRead,
  resolveCentralReadCredential, CENTRAL_CREDENTIAL_TTL_SECONDS,
} from "../services/central-read-grants";

// Check the dedicated opt-in BEFORE inspecting the ambient database. Never
// substitute the shared database when a disposable target was not supplied.
const target = process.env.CENTRAL_READ_DISPOSABLE_TEST_URL;
if (target) {
  const url = new URL(target);
  assert.equal(getVerifiedCiDatabaseUrl(), target);
  assert.match(url.pathname, /^\/central_grants_test(?:_[a-z0-9]+)?$/);
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.CI_DATABASE_URL, target);
  assert.equal(process.env.NEON_SHARED_DATABASE_URL, target);
}
const check = target ? test : test.skip;
let pool: pg.Pool;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const routine = (runtime: string) => `fixture-routine-${runtime}`;
async function runtime(id: string, actor = "luca-replit") {
  await pool.query(`INSERT INTO coordination_runtime_registrations
    (id,actor,display_name,bootstrap_hash,capabilities,token_ttl_seconds)
    VALUES ($1,$2,$1,$3,ARRAY['coordination:read','coordination:write'],900)`, [id, actor, hash(`bootstrap-${id}`)]);
  await pool.query(`INSERT INTO coordination_runtime_credentials
    (runtime_id,actor,token_hash,capabilities,expires_at) VALUES ($1,$2,$3,
    ARRAY['coordination:read','coordination:write'],now()+interval '1 hour')`, [id, actor, hash(routine(id))]);
}
async function grant(id: string, overrides = {}) {
  return grantCentralRead({ runtimeId: id, actor: "luca-replit", expiresAt: future(),
    expectedGrantId: null, founderId: "fixture-founder", ...overrides });
}
before(async () => {
  if (!target) return;
  pool = new pg.Pool({ connectionString: target });
  // Recreate ONLY in a dedicated, job-local database. Apply the real generated
  // migration to exact minimal predecessor tables, not a mocked grant schema.
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TABLE coordination_runtime_registrations (
      id varchar(120) PRIMARY KEY,actor varchar(80) NOT NULL,display_name varchar(160) NOT NULL,
      provider varchar(40),model varchar(120),bootstrap_hash varchar(64) NOT NULL,
      capabilities text[] NOT NULL,token_ttl_seconds integer NOT NULL DEFAULT 900,
      enabled boolean NOT NULL DEFAULT true,standing_verifier boolean NOT NULL DEFAULT false,
      standing_verifier_designated_at timestamp,standing_verifier_designated_by varchar(120),
      created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now(),revoked_at timestamp);
    CREATE TABLE coordination_runtime_credentials (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),runtime_id varchar(120) NOT NULL REFERENCES coordination_runtime_registrations(id),
      actor varchar(80) NOT NULL,token_hash varchar(64) NOT NULL UNIQUE,capabilities text[] NOT NULL,
      issued_at timestamp NOT NULL DEFAULT now(),expires_at timestamp NOT NULL,last_used_at timestamp,
      revoked_at timestamp,renewed_from_credential_id varchar);
    CREATE TABLE coordination_credential_audit_events (
      id bigserial PRIMARY KEY,event_type varchar(40) NOT NULL,success boolean NOT NULL,
      runtime_id varchar(120),actor varchar(80),credential_id varchar,reason varchar(160),source_ip_hash varchar(64),
      metadata jsonb NOT NULL DEFAULT '{}',created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE coordination_runtime_rotations (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),source_runtime_id varchar(120) NOT NULL,
      replacement_runtime_id varchar(120) NOT NULL,actor varchar(80) NOT NULL,capabilities text[] NOT NULL,
      token_ttl_seconds integer NOT NULL,state varchar(24) NOT NULL DEFAULT 'staged',
      ready_credential_id varchar,created_at timestamp NOT NULL DEFAULT now(),
      ready_at timestamp,completed_at timestamp,rolled_back_at timestamp);
    CREATE TABLE coordination_gate3_proof_grants (
      id varchar PRIMARY KEY,credential_id varchar NOT NULL,revoked_at timestamp,expires_at timestamp NOT NULL);`);
  await pool.query(readFileSync("migrations/0067_central_read_grants.sql", "utf8"));
});
after(async () => {
  if (!target) return;
  const { closeDbConnections } = await import("../db");
  await closeDbConnections();
  await pool.end();
});
check("dedicated grant and token never expand routine credentials or registrations", async () => {
  await runtime("isolation");
  const g = await grant("isolation");
  assert.equal((await centralGrantSnapshot()).grants.some(x => x.id === g.id), true);
  const issued = await exchangeCentralRead(routine("isolation"), g.id);
  const resolved = await resolveCentralReadCredential(issued.accessToken);
  assert.equal(resolved?.centralGrantId, g.id);
  assert.deepEqual(resolved?.capabilities, ["central-records:read"]);
  assert.equal(await resolveCentralReadCredential(routine("isolation")), null);
  const { resolveBrokerCredential, renewBrokerCredential } = await import("../services/coordination-credential-broker");
  assert.equal(await resolveBrokerCredential(issued.accessToken), null);
  const ordinary = await resolveBrokerCredential(routine("isolation"));
  assert.deepEqual(ordinary?.capabilities, ["coordination:read", "coordination:write"]);
  assert.equal(await renewBrokerCredential(resolved!), null, "central token cannot generic-renew into routine scopes");
  const renewed = await renewBrokerCredential(ordinary!);
  assert.deepEqual(renewed?.credential.capabilities, ["coordination:read", "coordination:write"]);
  assert.equal(CENTRAL_CREDENTIAL_TTL_SECONDS, 300);
  assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 300_000);
  await assert.rejects(exchangeCentralRead(issued.accessToken, g.id), /routine_credential_required/);
});
check("revocation immediately denies an existing central token without revoking routine access", async () => {
  await runtime("revoke");
  const g = await grant("revoke");
  const issued = await exchangeCentralRead(routine("revoke"), g.id);
  await revokeCentralRead({ grantId: g.id, founderId: "fixture-founder" });
  assert.equal(await resolveCentralReadCredential(issued.accessToken), null);
  await assert.rejects(exchangeCentralRead(routine("revoke"), g.id), /central_grant_unavailable/);
  const { resolveBrokerCredential } = await import("../services/coordination-credential-broker");
  assert.ok(await resolveBrokerCredential(routine("revoke")));
});
check("same actor cannot use another runtime's grant; disabled and disallowed actors are denied", async () => {
  await runtime("owner"); await runtime("other"); await runtime("student", "daniela");
  const g = await grant("owner");
  await assert.rejects(exchangeCentralRead(routine("other"), g.id), /central_grant_unavailable/);
  await assert.rejects(grant("student", { actor: "daniela" }), /invalid_grant/);
  await pool.query("UPDATE coordination_runtime_registrations SET enabled=false WHERE id='owner'");
  await assert.rejects(exchangeCentralRead(routine("owner"), g.id), /runtime_unavailable/);
});
check("expired grant and expired token are refused and token expiry cannot exceed grant expiry", async () => {
  await runtime("expiry");
  const g = await grant("expiry", { expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const issued = await exchangeCentralRead(routine("expiry"), g.id);
  assert.ok(Date.parse(issued.expiresAt) <= Date.parse(g.expiresAt));
  await pool.query("UPDATE coordination_runtime_credentials SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash(issued.accessToken)]);
  assert.equal(await resolveCentralReadCredential(issued.accessToken), null);
  await pool.query("UPDATE central_read_grants SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [g.id]);
  await assert.rejects(exchangeCentralRead(routine("expiry"), g.id), /central_grant_unavailable/);
  const replacement = await grant("expiry", { expectedGrantId: g.id });
  assert.notEqual(replacement.id, g.id);
  await assert.rejects(grant("expiry", { expectedGrantId: g.id }), /grant_changed/);
});
check("audit failure rolls back grants and credential exchange", async () => {
  await runtime("rollback");
  const g = await grant("rollback");
  const count = (await pool.query("SELECT count(*)::int AS n FROM coordination_runtime_credentials")).rows[0].n;
  await pool.query(`CREATE FUNCTION reject_central_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type LIKE 'central_%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_central_audit BEFORE INSERT ON coordination_credential_audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_central_audit();`);
  try {
    await assert.rejects(exchangeCentralRead(routine("rollback"), g.id));
    await assert.rejects(grant("rollback", { expectedGrantId: g.id }));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM coordination_runtime_credentials")).rows[0].n, count);
    assert.equal((await pool.query("SELECT revoked_at FROM central_read_grants WHERE id=$1", [g.id])).rows[0].revoked_at, null);
  } finally {
    await pool.query("DROP TRIGGER reject_central_audit ON coordination_credential_audit_events; DROP FUNCTION reject_central_audit()");
  }
});
check("database rejects unknown scopes, duplicate live grants, unbound and invalid-bound tokens", async () => {
  await runtime("constraints");
  const g = await grant("constraints");
  await assert.rejects(pool.query(`INSERT INTO central_read_grants (runtime_id,actor,scope,granted_by,expires_at)
    VALUES ('constraints','luca-replit','central-documents:read','fixture',now()+interval '1 hour')`));
  await assert.rejects(pool.query(`INSERT INTO central_read_grants (runtime_id,actor,scope,granted_by,expires_at)
    VALUES ('constraints','luca-replit','central-records:read','fixture',now()+interval '1 hour')`));
  await assert.rejects(pool.query(`INSERT INTO coordination_runtime_credentials (runtime_id,actor,token_hash,capabilities,expires_at)
    VALUES ('constraints','luca-replit','unbound',ARRAY['central-records:read'],now()+interval '1 hour')`));
  await assert.rejects(pool.query(`INSERT INTO coordination_runtime_credentials
    (runtime_id,actor,token_hash,capabilities,expires_at,central_grant_id)
    VALUES ('constraints','luca-replit','bound-mixed',ARRAY['coordination:read'],now()+interval '1 hour',$1)`, [g.id]));
});
check("revoke racing exchange waits for the exact runtime lock and cannot issue after revoke", async () => {
  await runtime("race");
  const g = await grant("race");
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('race',0))");
  // Revoke first while holding the authoritative lock; exchange must wait.
  await lock.query("UPDATE central_read_grants SET revoked_at=now() WHERE id=$1", [g.id]);
  const exchange = exchangeCentralRead(routine("race"), g.id);
  let settled = false;
  void exchange.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await lock.query("COMMIT"); lock.release();
  await assert.rejects(exchange, /central_grant_unavailable/);
});
check("concurrent founder confirmations serialize and only one exact-state replacement wins", async () => {
  await runtime("confirm-race");
  const original = await grant("confirm-race");
  const results = await Promise.allSettled([
    grant("confirm-race", { expectedGrantId: original.id }),
    grant("confirm-race", { expectedGrantId: original.id }),
  ]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const failure = results.find(x => x.status === "rejected") as PromiseRejectedResult;
  assert.match(failure.reason.message, /grant_changed/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM central_read_grants
    WHERE runtime_id='confirm-race' AND revoked_at IS NULL`)).rows[0].n, 1);
});
check("central usage neither blocks grace reexchange nor gets revoked by its unused-routine cleanup", async () => {
  await runtime("grace");
  const g = await grant("grace");
  const issued = await exchangeCentralRead(routine("grace"), g.id);
  assert.ok(await resolveCentralReadCredential(issued.accessToken));
  const { consumedCoordinationBootstrapHash, exchangeBootstrapCredential } =
    await import("../services/coordination-credential-broker");
  const bootstrap = "fixture-grace-bootstrap";
  await pool.query(`UPDATE coordination_runtime_registrations SET bootstrap_hash=$1 WHERE id='grace'`,
    [consumedCoordinationBootstrapHash("grace", hash(bootstrap))]);
  // Fixture the exact grace precondition: only central credentials have been
  // used; an abandoned, never-authenticated ordinary credential exists.
  await pool.query(`UPDATE coordination_runtime_credentials SET last_used_at=NULL
    WHERE runtime_id='grace' AND central_grant_id IS NULL`);
  const exchanged = await exchangeBootstrapCredential("grace", bootstrap);
  assert.equal(exchanged.ok, true);
  assert.ok(await resolveCentralReadCredential(issued.accessToken));
});
check("a replacement runtime does not inherit grants or central credentials", async () => {
  await runtime("replacement-source");
  const g = await grant("replacement-source");
  await exchangeCentralRead(routine("replacement-source"), g.id);
  await runtime("replacement-target");
  await assert.rejects(exchangeCentralRead(routine("replacement-target"), g.id), /central_grant_unavailable/);
  await pool.query(`UPDATE coordination_runtime_registrations SET enabled=false,revoked_at=now()
    WHERE id='replacement-source'`);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM central_read_grants
    WHERE runtime_id='replacement-target'`)).rows[0].n, 0);
});
check("unknown runtime, mismatched actor, expired founder grant and revoked routine token fail closed", async () => {
  await assert.rejects(grant("not-registered"), /runtime_unavailable/);
  await runtime("invalid-inputs");
  await assert.rejects(grant("invalid-inputs", { actor: "alden" }), /runtime_unavailable/);
  await assert.rejects(grant("invalid-inputs", { expiresAt: "2000-01-01T00:00:00Z" }), /grant_expired/);
  const g = await grant("invalid-inputs");
  await pool.query(`UPDATE coordination_runtime_credentials SET revoked_at=now() WHERE runtime_id='invalid-inputs'`);
  await assert.rejects(exchangeCentralRead(routine("invalid-inputs"), g.id), /routine_credential_required/);
});
check("actual generic middleware and runtime HTTP routes structurally reject central tokens", async () => {
  await runtime("generic-http");
  const g = await grant("generic-http");
  const issued = await exchangeCentralRead(routine("generic-http"), g.id);
  const [{ requireCoordinationAuth }, { registerCoordinationRuntimeRoutes }] = await Promise.all([
    import("../middleware/coordination-auth"), import("../routes/coordination-runtime-routes"),
  ]);
  const app = express();
  app.use(express.json());
  app.get("/fixture-coordination", requireCoordinationAuth, (_req, res) => res.json({ unreachable: true }));
  registerCoordinationRuntimeRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { "x-coordination-token": issued.accessToken };
    const response = await fetch(`${url}/fixture-coordination`, { headers });
    assert.equal(response.status, 401);
    const runtimeResponse = await fetch(`${url}/api/coordination/runtime/packets`, { method: "POST",
      headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(runtimeResponse.status, 401);
    assert.doesNotMatch(await runtimeResponse.text(), /standingVerifier/);
    const audit = await pool.query(`SELECT reason FROM coordination_credential_audit_events
      WHERE credential_id=$1 AND event_type='access_failed'`, [issued.credentialId]);
    assert.ok(audit.rows.some(r => r.reason === "central_credential_generic_use"));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
check("actual rotation racing a founder replacement cannot transfer central authority", async () => {
  await runtime("rotation-source");
  const g = await grant("rotation-source");
  const central = await exchangeCentralRead(routine("rotation-source"), g.id);
  const broker = await import("../services/coordination-credential-broker");
  const staged = await broker.stageCoordinationRuntimeReplacement({
    sourceRuntimeId: "rotation-source", replacementRuntimeId: "rotation-target", replacementDisplayName: "Fixture replacement",
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) throw new Error("rotation did not stage");
  const exchanged = await broker.exchangeBootstrapCredential("rotation-target", staged.bootstrapToken);
  assert.equal(exchanged.ok, true);
  if (!exchanged.ok) throw new Error("replacement bootstrap failed");
  const ready = await broker.markCoordinationRuntimeReplacementReady({
    sourceRuntimeId: "rotation-source", credential: exchanged.credential,
  });
  assert.equal(ready.ok, true);
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('rotation-source',0))");
  const complete = broker.completeCoordinationRuntimeReplacement({
    sourceRuntimeId: "rotation-source", replacementRuntimeId: "rotation-target",
  });
  const replacement = grant("rotation-source", { expectedGrantId: g.id });
  // Both production paths compete for the same runtime lock. Either order is
  // legitimate; after completion no source grant may authorize a read.
  const results = Promise.allSettled([complete, replacement]);
  await lock.query("COMMIT"); lock.release();
  const [completed] = await results;
  assert.equal(completed.status, "fulfilled");
  if (completed.status === "fulfilled") assert.equal(completed.value.ok, true);
  assert.equal(await resolveCentralReadCredential(central.accessToken), null);
  await assert.rejects(exchangeCentralRead(exchanged.accessToken, g.id), /central_grant_unavailable/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM central_read_grants
    WHERE runtime_id='rotation-target'`)).rows[0].n, 0);
});
