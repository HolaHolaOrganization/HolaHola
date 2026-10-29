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
import { runCentralGrantExpiryWarnings } from "../services/central-read-expiry-warnings";

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
    CREATE TABLE alden_notifications (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),content text NOT NULL,
      triggered_by varchar NOT NULL,severity varchar NOT NULL,read boolean NOT NULL DEFAULT false,
      fingerprint varchar(100),created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE coordination_gate3_proof_grants (
      id varchar PRIMARY KEY,credential_id varchar NOT NULL,revoked_at timestamp,expires_at timestamp NOT NULL);`);
  await pool.query(readFileSync("migrations/0073_central_read_grants.sql", "utf8"));
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
for (const priorCentralUse of [false, true]) {
check(`grace ignores ${priorCentralUse ? "used" : "unused"} central credentials for eligibility but revokes them on recovery`, async () => {
  const id = priorCentralUse ? "grace-used" : "grace-unused";
  await runtime(id);
  const g = await grant(id);
  const issued = await exchangeCentralRead(routine(id), g.id);
  if (priorCentralUse) assert.ok(await resolveCentralReadCredential(issued.accessToken));
  const { consumedCoordinationBootstrapHash, exchangeBootstrapCredential } =
    await import("../services/coordination-credential-broker");
  const bootstrap = "fixture-grace-bootstrap";
  await pool.query(`UPDATE coordination_runtime_registrations SET bootstrap_hash=$1 WHERE id=$2`,
    [consumedCoordinationBootstrapHash(id, hash(bootstrap)), id]);
  // Fixture the exact grace precondition: no ordinary credential has been
  // used; central use is varied independently. The grant/runtime stay active.
  await pool.query(`UPDATE coordination_runtime_credentials SET last_used_at=NULL
    WHERE runtime_id=$1 AND central_grant_id IS NULL`, [id]);
  const exchanged = await exchangeBootstrapCredential(id, bootstrap);
  assert.equal(exchanged.ok, true);
  assert.equal(await resolveCentralReadCredential(issued.accessToken), null);
  const state = await pool.query(`SELECT c.revoked_at IS NOT NULL AS credential_revoked,
    g.revoked_at IS NULL AS grant_active, g.expires_at>now() AS grant_unexpired,
    r.enabled AND r.revoked_at IS NULL AS runtime_active
    FROM coordination_runtime_credentials c JOIN central_read_grants g ON g.id=c.central_grant_id
    JOIN coordination_runtime_registrations r ON r.id=c.runtime_id WHERE c.id=$1`, [issued.credentialId]);
  assert.deepEqual(state.rows[0], { credential_revoked: true, grant_active: true,
    grant_unexpired: true, runtime_active: true });
  const audit = await pool.query(`SELECT metadata FROM coordination_credential_audit_events
    WHERE runtime_id=$1 AND event_type='bootstrap_grace_reexchange' ORDER BY id DESC LIMIT 1`, [id]);
  assert.equal(audit.rows[0].metadata.priorUnusedCredentialsRevoked, 1);
  assert.equal(audit.rows[0].metadata.priorCentralCredentialsRevoked, 1);
  if (!exchanged.ok) throw new Error("fixture grace exchange failed");
  const { resolveBrokerCredential } = await import("../services/coordination-credential-broker");
  const ordinary = await resolveBrokerCredential(exchanged.accessToken);
  assert.deepEqual(ordinary?.capabilities, ["coordination:read", "coordination:write"]);
  const retry = await exchangeBootstrapCredential(id, bootstrap);
  assert.equal(retry.ok, false, "real ordinary use still blocks grace reexchange");
  if (!retry.ok) assert.equal(retry.reason, "bootstrap_already_consumed");
});
}
check("central exchange expiry uses only database timestamps for the grant cap", async () => {
  await runtime("database-expiry-cap");
  const g = await grant("database-expiry-cap", {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const issued = await exchangeCentralRead(routine("database-expiry-cap"), g.id);
  // Deliberately compare stored timestamps in SQL. Comparing two JS Dates can
  // hide the same host-local timestamp decoding error on both sides.
  const result = await pool.query(`SELECT
    c.expires_at <= g.expires_at AS bounded_by_grant,
    c.expires_at = g.expires_at AS short_grant_wins,
    c.expires_at > c.issued_at AS usable_lifetime,
    c.expires_at <= c.issued_at + interval '300 seconds' AS bounded_by_ttl
    FROM coordination_runtime_credentials c JOIN central_read_grants g ON g.id=c.central_grant_id
    WHERE c.id=$1`, [issued.credentialId]);
  assert.deepEqual(result.rows[0], { bounded_by_grant: true, short_grant_wins: true,
    usable_lifetime: true, bounded_by_ttl: true });
  assert.equal(issued.expiresAt, (await pool.query(`SELECT to_char(expires_at,
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value FROM coordination_runtime_credentials WHERE id=$1`,
    [issued.credentialId])).rows[0].value);
  assert.equal((await resolveCentralReadCredential(issued.accessToken))?.expiresAt.toISOString(), issued.expiresAt);
});
check("one-calendar-year cap uses database time and rejects a replacement without revoking its predecessor", async () => {
  await runtime("year-cap");
  const maximum = (await pool.query(`SELECT to_char((now() AT TIME ZONE 'UTC')+interval '1 year',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value`)).rows[0].value;
  const original = await grant("year-cap", { expiresAt: maximum });
  assert.equal(original.expiresAt, maximum);
  const tooLong = (await pool.query(`SELECT to_char((now() AT TIME ZONE 'UTC')+interval '1 year 1 day',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value`)).rows[0].value;
  await assert.rejects(grant("year-cap", { expectedGrantId: original.id, expiresAt: tooLong }),
    /grant_exceeds_one_year/);
  assert.equal((await pool.query("SELECT revoked_at FROM central_read_grants WHERE id=$1", [original.id])).rows[0].revoked_at, null);
  const snapshot = await centralGrantSnapshot();
  assert.equal(snapshot.grants.find(g => g.id === original.id)?.expiresAt, maximum);
  assert.match(snapshot.maximumExpiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const bound = await pool.query(`SELECT expires_at <=
    (now() AT TIME ZONE 'UTC')+interval '1 year' AS valid FROM central_read_grants WHERE id=$1`, [original.id]);
  assert.equal(bound.rows[0].valid, true);
});
check("native dormant retirement ignores central usage but revokes every central credential", async () => {
  const broker = await import("../services/coordination-credential-broker");
  const id = "native-dormant-central";
  await runtime(id);
  const g = await grant(id);
  const central = await exchangeCentralRead(routine(id), g.id);
  assert.ok(await resolveCentralReadCredential(central.accessToken));
  await pool.query(`UPDATE coordination_runtime_credentials
    SET expires_at=(now() AT TIME ZONE 'UTC')-interval '45 days',
      last_used_at=(now() AT TIME ZONE 'UTC')-interval '46 days'
    WHERE runtime_id=$1 AND central_grant_id IS NULL`, [id]);
  const retired = await broker.disableCoordinationRuntimeRegistration(id, undefined, { dormantDays: 30 });
  assert.equal(retired.ok, true);
  assert.equal(await resolveCentralReadCredential(central.accessToken), null);
  const live = await pool.query(`SELECT count(*)::int AS count
    FROM coordination_runtime_credentials WHERE runtime_id=$1 AND revoked_at IS NULL`, [id]);
  assert.equal(live.rows[0].count, 0);
});

check("native dormant retirement still refuses recently used ordinary credentials", async () => {
  const broker = await import("../services/coordination-credential-broker");
  const id = "native-dormant-routine";
  await runtime(id);
  const g = await grant(id);
  const central = await exchangeCentralRead(routine(id), g.id);
  await pool.query(`UPDATE coordination_runtime_credentials
    SET expires_at=(now() AT TIME ZONE 'UTC')-interval '1 day',
      last_used_at=(now() AT TIME ZONE 'UTC')-interval '2 days'
    WHERE runtime_id=$1 AND central_grant_id IS NULL`, [id]);
  const refused = await broker.disableCoordinationRuntimeRegistration(id, undefined, { dormantDays: 30 });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "runtime_used_within_dormancy_window");
  assert.ok(await resolveCentralReadCredential(central.accessToken), "failed retirement must preserve central access");
});

check("expiry warning is durable once per grant across concurrent and repeated scans", async () => {
  await runtime("warning-once");
  const g = await grant("warning-once");
  await Promise.all([runCentralGrantExpiryWarnings(), runCentralGrantExpiryWarnings()]);
  await runCentralGrantExpiryWarnings();
  const notes = await pool.query("SELECT content,severity,read FROM alden_notifications WHERE fingerprint=$1", [`central_expiry:${g.id}`]);
  assert.equal(notes.rowCount, 1);
  assert.equal(notes.rows[0].severity, "warning");
  assert.equal(notes.rows[0].read, false);
  assert.match(notes.rows[0].content, /warning-once/);
  const audits = await pool.query(`SELECT id FROM coordination_credential_audit_events
    WHERE event_type='central_expiry_warned' AND metadata->>'grantId'=$1`, [g.id]);
  assert.equal(audits.rowCount, 1);
  await assert.rejects(pool.query(`INSERT INTO coordination_credential_audit_events
    (event_type,success,runtime_id,actor,metadata)
    VALUES ('central_expiry_warned',true,'warning-once','luca-replit',$1::jsonb)`,
    [JSON.stringify({ grantId: g.id })]), /unique/i);
});
check("warning window excludes far-future, expired, revoked and disabled-runtime grants", async () => {
  const ids = ["warning-far", "warning-expired", "warning-revoked", "warning-disabled"];
  const grants: string[] = [];
  for (const id of ids) { await runtime(id); grants.push((await grant(id)).id); }
  await pool.query("UPDATE central_read_grants SET expires_at=(now() AT TIME ZONE 'UTC')+interval '15 days' WHERE id=$1", [grants[0]]);
  await pool.query(`UPDATE central_read_grants SET created_at=(now() AT TIME ZONE 'UTC')-interval '2 days',
    expires_at=(now() AT TIME ZONE 'UTC')-interval '1 day' WHERE id=$1`, [grants[1]]);
  await revokeCentralRead({ grantId: grants[2], founderId: "fixture-founder" });
  await pool.query("UPDATE coordination_runtime_registrations SET enabled=false WHERE id='warning-disabled'");
  await runCentralGrantExpiryWarnings();
  const count = await pool.query("SELECT count(*)::int AS n FROM alden_notifications WHERE fingerprint=ANY($1)", [grants.map(id => `central_expiry:${id}`)]);
  assert.equal(count.rows[0].n, 0);
});
check("failed warning audit rolls back founder delivery and is retryable", async () => {
  await runtime("warning-rollback");
  const g = await grant("warning-rollback");
  await pool.query(`CREATE FUNCTION reject_warning_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type='central_expiry_warned' AND NEW.runtime_id='warning-rollback'
    THEN RAISE EXCEPTION 'fixture warning audit rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_warning_audit BEFORE INSERT ON coordination_credential_audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_warning_audit();`);
  try {
    await assert.rejects(runCentralGrantExpiryWarnings(), (error: any) =>
      /fixture warning audit rejection/.test(String(error.cause?.message ?? error.message)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM alden_notifications WHERE fingerprint=$1", [`central_expiry:${g.id}`])).rows[0].n, 0);
  } finally {
    await pool.query("DROP TRIGGER reject_warning_audit ON coordination_credential_audit_events; DROP FUNCTION reject_warning_audit()");
  }
  await runCentralGrantExpiryWarnings();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM alden_notifications WHERE fingerprint=$1", [`central_expiry:${g.id}`])).rows[0].n, 1);
});
check("failed founder-inbox insert leaves no warning marker and retries safely", async () => {
  await runtime("warning-delivery-failure");
  const g = await grant("warning-delivery-failure");
  await pool.query(`CREATE FUNCTION reject_warning_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.fingerprint='central_expiry:' || '${g.id}'
    THEN RAISE EXCEPTION 'fixture inbox rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_warning_delivery BEFORE INSERT ON alden_notifications
    FOR EACH ROW EXECUTE FUNCTION reject_warning_delivery();`);
  try {
    await assert.rejects(runCentralGrantExpiryWarnings(), (error: any) =>
      /fixture inbox rejection/.test(String(error.cause?.message ?? error.message)));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordination_credential_audit_events
      WHERE event_type='central_expiry_warned' AND metadata->>'grantId'=$1`, [g.id])).rows[0].n, 0);
  } finally {
    await pool.query("DROP TRIGGER reject_warning_delivery ON alden_notifications; DROP FUNCTION reject_warning_delivery()");
  }
  await runCentralGrantExpiryWarnings();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM alden_notifications WHERE fingerprint=$1", [`central_expiry:${g.id}`])).rows[0].n, 1);
});
check("warning scan racing revocation uses the runtime lock and does not notify after revoke", async () => {
  await runtime("warning-revoke-race");
  const g = await grant("warning-revoke-race");
  const lock = await pool.connect();
  await lock.query("BEGIN");
  try {
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('warning-revoke-race',0))");
    const pending = runCentralGrantExpiryWarnings();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    await lock.query("UPDATE central_read_grants SET revoked_at=now() WHERE id=$1", [g.id]);
    await lock.query("COMMIT");
    await pending;
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM alden_notifications WHERE fingerprint=$1", [`central_expiry:${g.id}`])).rows[0].n, 0);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
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
