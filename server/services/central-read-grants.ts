import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { CENTRAL_READER_ACTORS } from "@shared/central-read-policy";
import type { BrokerCredential } from "./coordination-credential-broker";

type Database = ReturnType<typeof import("../db").getSharedDb>;
type Row = Record<string, any>;
export const CENTRAL_CREDENTIAL_TTL_SECONDS = 300;
// Five minutes limits a copied read token's exposure without changing routine
// credential custody. Grant revocation is checked on every use, not at expiry.
export class CentralGrantError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
async function rows(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as unknown as { rows: Row[] }).rows) as Row[];
}
function fail(status: number, code: string): never { throw new CentralGrantError(status, code); }
function allowedActor(actor: string): boolean {
  return (CENTRAL_READER_ACTORS as readonly string[]).includes(actor);
}
const grantDates = sql`to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_utc,
  to_char(revoked_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revoked_utc`;
function grantView(row: Row) {
  return { id: row.id as string, runtimeId: row.runtime_id as string, actor: row.actor as string,
    scope: row.scope as string, grantedBy: row.granted_by as string,
    expiresAt: row.expires_utc as string, revokedAt: row.revoked_utc as string | null };
}
async function audit(db: Database, event: string, runtimeId: string, actor: string,
  grantId: string, credentialId?: string, founderId?: string) {
  await db.execute(sql`INSERT INTO coordination_credential_audit_events
    (event_type,success,runtime_id,actor,credential_id,metadata)
    VALUES (${event},true,${runtimeId},${actor},${credentialId ?? null},
      ${JSON.stringify({ grantId, scope: "central-records:read", ...(founderId ? { founderId } : {}) })}::jsonb)`);
}
async function lockRuntime(db: Database, runtimeId: string) {
  // R2 order: runtime advisory lock -> registration -> grant -> credential.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${runtimeId},0))`);
  const [registration] = await rows(db, sql`SELECT * FROM coordination_runtime_registrations
    WHERE id=${runtimeId} FOR UPDATE`);
  return registration;
}
function activeRuntime(row: Row | undefined, actor?: string): row is Row {
  return !!row && row.enabled && !row.revoked_at && allowedActor(row.actor)
    && (!actor || row.actor === actor);
}
async function database(): Promise<Database> { return (await import("../db")).getSharedDb(); }

export async function centralGrantSnapshot() {
  const db = await database();
  const [limits] = await rows(db, sql`SELECT to_char(
    (now() AT TIME ZONE 'UTC') + interval '1 year',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS maximum_expires_at`);
  const runtimes = await rows(db, sql`SELECT id,actor,display_name,enabled,revoked_at
    FROM coordination_runtime_registrations ORDER BY actor,id`);
  const grants = await rows(db, sql`SELECT *,${grantDates} FROM central_read_grants ORDER BY created_at DESC`);
  return { maximumExpiresAt: limits.maximum_expires_at as string,
    runtimes: runtimes.filter(row => allowedActor(row.actor)).map(row => ({
    runtimeId: row.id, actor: row.actor, displayName: row.display_name,
    enabled: row.enabled && !row.revoked_at,
  })), grants: grants.map(grantView) };
}

export async function grantCentralRead(input: {
  runtimeId: string; actor: string; expiresAt: string; expectedGrantId: string | null; founderId: string;
}) {
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || !allowedActor(input.actor)) fail(400, "invalid_grant");
  const db = await database();
  return db.transaction(async tx => {
    const executor = tx as unknown as Database;
    const runtime = await lockRuntime(executor, input.runtimeId);
    if (!activeRuntime(runtime, input.actor)) fail(409, "runtime_unavailable");
    const [previous] = await rows(executor, sql`SELECT * FROM central_read_grants
      WHERE runtime_id=${input.runtimeId} AND revoked_at IS NULL FOR UPDATE`);
    if ((previous?.id ?? null) !== input.expectedGrantId) fail(409, "grant_changed");
    const [clock] = await rows(executor, sql`SELECT
      ${expiry.toISOString()}::timestamptz > now() AS future,
      ${expiry.toISOString()}::timestamptz <=
        (date_trunc('milliseconds',(now() AT TIME ZONE 'UTC') + interval '1 year')
          AT TIME ZONE 'UTC') AS within_limit`);
    if (!clock.future) fail(400, "grant_expired");
    if (!clock.within_limit) fail(400, "grant_exceeds_one_year");
    // The partial unique index includes expired rows: explicitly revoke before
    // regranting. The new insert is the grant/regrant linearization point.
    if (previous) await executor.execute(sql`UPDATE central_read_grants SET revoked_at=now() AT TIME ZONE 'UTC'
      WHERE id=${previous.id}`);
    const [created] = await rows(executor, sql`INSERT INTO central_read_grants
      (runtime_id,actor,scope,granted_by,expires_at,created_at)
      VALUES (${input.runtimeId},${runtime.actor},'central-records:read',${input.founderId},${expiry.toISOString()}::timestamp,now() AT TIME ZONE 'UTC')
      RETURNING *,${grantDates}`);
    await audit(executor, "central_grant_created", input.runtimeId, runtime.actor, created.id, undefined, input.founderId);
    return grantView(created);
  });
}

export async function revokeCentralRead(input: { grantId: string; founderId: string }) {
  const db = await database();
  const [lookup] = await rows(db, sql`SELECT runtime_id FROM central_read_grants WHERE id=${input.grantId}`);
  if (!lookup) fail(404, "grant_not_found");
  return db.transaction(async tx => {
    const executor = tx as unknown as Database;
    await lockRuntime(executor, lookup.runtime_id);
    const [grant] = await rows(executor, sql`SELECT * FROM central_read_grants
      WHERE id=${input.grantId} FOR UPDATE`);
    if (!grant) fail(404, "grant_not_found");
    // This update is revoke's linearization point. Rows are never deleted.
    const [revoked] = await rows(executor, sql`UPDATE central_read_grants
      SET revoked_at=coalesce(revoked_at,now() AT TIME ZONE 'UTC') WHERE id=${grant.id} RETURNING *,${grantDates}`);
    await audit(executor, "central_grant_revoked", grant.runtime_id, grant.actor, grant.id, undefined, input.founderId);
    return grantView(revoked);
  });
}

export async function exchangeCentralRead(routineToken: string, grantId: string) {
  const db = await database();
  const tokenHash = hash(routineToken);
  const [lookup] = await rows(db, sql`SELECT runtime_id FROM coordination_runtime_credentials
    WHERE token_hash=${tokenHash} AND central_grant_id IS NULL`);
  if (!lookup) fail(401, "routine_credential_required");
  return db.transaction(async tx => {
    const executor = tx as unknown as Database;
    const runtime = await lockRuntime(executor, lookup.runtime_id);
    if (!activeRuntime(runtime)) fail(403, "runtime_unavailable");
    const [grant] = await rows(executor, sql`SELECT * FROM central_read_grants
      WHERE id=${grantId} AND runtime_id=${runtime.id} AND actor=${runtime.actor}
        AND scope='central-records:read' AND revoked_at IS NULL
        AND (expires_at AT TIME ZONE 'UTC')>now() FOR UPDATE`);
    if (!grant) fail(403, "central_grant_unavailable");
    const [routine] = await rows(executor, sql`SELECT * FROM coordination_runtime_credentials
      WHERE token_hash=${tokenHash} AND runtime_id=${runtime.id} AND actor=${runtime.actor}
        AND central_grant_id IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`);
    if (!routine || routine.capabilities.some((scope: string) => scope.startsWith("central-"))) {
      fail(401, "routine_credential_required");
    }
    await executor.execute(sql`UPDATE coordination_runtime_credentials SET last_used_at=now()
      WHERE id=${routine.id}`);
    const accessToken = `ct_${randomBytes(32).toString("base64url")}`;
    // Credential insert is exchange's linearization point, under the same grant
    // and runtime locks used by revoke. TTL is based only on database time.
    const [credential] = await rows(executor, sql`INSERT INTO coordination_runtime_credentials
      (runtime_id,actor,token_hash,capabilities,expires_at,central_grant_id,issued_at)
      VALUES (${runtime.id},${runtime.actor},${hash(accessToken)},ARRAY['central-records:read']::text[],
        least((SELECT expires_at FROM central_read_grants WHERE id=${grant.id}),
          (now() AT TIME ZONE 'UTC')+${CENTRAL_CREDENTIAL_TTL_SECONDS}*interval '1 second'),${grant.id},now() AT TIME ZONE 'UTC')
      RETURNING id,to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_utc`);
    await audit(executor, "central_credential_issued", runtime.id, runtime.actor, grant.id, credential.id);
    return { accessToken, tokenType: "Coordination", actor: runtime.actor, runtimeId: runtime.id,
      credentialId: credential.id, grantId: grant.id, capabilities: ["central-records:read"],
      expiresAt: credential.expires_utc as string };
  });
}

/** R1: only this resolver accepts bound credentials; never legacy/routine. */
export async function resolveCentralReadCredential(token: string): Promise<BrokerCredential | null> {
  const db = await database();
  const tokenHash = hash(token);
  const [lookup] = await rows(db, sql`SELECT runtime_id,central_grant_id FROM coordination_runtime_credentials
    WHERE token_hash=${tokenHash} AND central_grant_id IS NOT NULL`);
  if (!lookup) return null;
  return db.transaction(async tx => {
    const executor = tx as unknown as Database;
    const runtime = await lockRuntime(executor, lookup.runtime_id);
    if (!activeRuntime(runtime)) return null;
    const [grant] = await rows(executor, sql`SELECT * FROM central_read_grants
      WHERE id=${lookup.central_grant_id} AND runtime_id=${runtime.id} AND actor=${runtime.actor}
        AND scope='central-records:read' AND revoked_at IS NULL
        AND (expires_at AT TIME ZONE 'UTC')>now() FOR UPDATE`);
    if (!grant) return null;
    const [credential] = await rows(executor, sql`SELECT *,
      to_char(expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_utc FROM coordination_runtime_credentials
      WHERE token_hash=${tokenHash} AND central_grant_id=${grant.id} AND runtime_id=${runtime.id}
        AND actor=${runtime.actor} AND revoked_at IS NULL AND (expires_at AT TIME ZONE 'UTC')>now()
        AND capabilities=ARRAY['central-records:read']::text[] FOR UPDATE`);
    if (!credential) return null;
    // Resolution linearizes at this use mark under grant lock. A request that
    // resolved before revoke may finish; a resolution after revoke is denied.
    await executor.execute(sql`UPDATE coordination_runtime_credentials SET last_used_at=now()
      WHERE id=${credential.id}`);
    return { actor: runtime.actor as BrokerCredential["actor"], runtimeId: runtime.id,
      centralGrantId: grant.id,
      credentialId: credential.id, capabilities: ["central-records:read"],
      expiresAt: new Date(credential.expires_utc as string), standingVerifier: false };
  });
}

/** Same resolver contract as central-record HTTP fixtures, no legacy fallback. */
export const resolveCentralReadCapability: typeof import("../middleware/coordination-auth").resolveCoordinationCapability =
  async (token, capability, actors) => {
    if (capability !== "central-records:read") return { ok: false, status: 403, error: "central_scope_unavailable" };
    try {
      const credential = await resolveCentralReadCredential(token);
      if (!credential || (actors && !actors.includes(credential.actor))) {
        return { ok: false, status: 401, error: "central_credential_required" };
      }
      return { ok: true, actor: credential.actor, authType: "broker", credential };
    } catch {
      return { ok: false, status: 503, error: "central_authentication_unavailable" };
    }
  };
