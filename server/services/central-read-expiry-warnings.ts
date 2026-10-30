import { sql } from "drizzle-orm";

type Database = ReturnType<typeof import("../db").getSharedDb>;
async function rows(db: Database, query: ReturnType<typeof sql>) {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as unknown as { rows: Record<string, any>[] }).rows);
}

/**
 * One durable founder-inbox warning per live grant inside its final 14 days.
 * No Team Room/hat fanout or expired-grant follow-up is implied.
 */
export async function runCentralGrantExpiryWarnings() {
  const db = (await import("../db")).getSharedDb();
  // Two-int advisory keys are separate from runtime's single-bigint keyspace.
  // Namespace 0x43475241 = "CGRA"; key 1 identifies the expiry-warning scanner.
  return db.transaction(async leader => {
    const scan = leader as unknown as Database;
    const [lock] = await rows(scan, sql`SELECT pg_try_advisory_xact_lock(${0x43475241},1) AS acquired`);
    if (!lock.acquired) return { warned: 0, scannerBusy: true };
    // No row locks on the scanning transaction: grant writes below use their
    // own short transaction, so grant/revoke is not blocked for the whole scan.
    const candidates = await rows(scan, sql`SELECT g.id,g.runtime_id
      FROM central_read_grants g JOIN coordination_runtime_registrations r ON r.id=g.runtime_id
      WHERE g.revoked_at IS NULL AND (g.expires_at AT TIME ZONE 'UTC')>now()
        AND (g.expires_at AT TIME ZONE 'UTC')<=now()+interval '14 days'
        AND r.enabled AND r.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM coordination_credential_audit_events a
          WHERE a.event_type='central_expiry_warned' AND a.success=true
            AND a.metadata->>'grantId'=g.id)
      ORDER BY g.expires_at,g.id`);
    let warned = 0;
    for (const candidate of candidates) {
      warned += await db.transaction(async transaction => {
        const tx = transaction as unknown as Database;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.runtime_id},0))`);
        const [runtime] = await rows(tx, sql`SELECT id FROM coordination_runtime_registrations
          WHERE id=${candidate.runtime_id} AND enabled AND revoked_at IS NULL FOR UPDATE`);
        if (!runtime) return 0;
        const [grant] = await rows(tx, sql`SELECT g.*,to_char(g.expires_at,
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_utc
          FROM central_read_grants g
          WHERE g.id=${candidate.id} AND g.revoked_at IS NULL
            AND (g.expires_at AT TIME ZONE 'UTC')>now()
            AND (g.expires_at AT TIME ZONE 'UTC')<=now()+interval '14 days'
          FOR UPDATE`);
        if (!grant) return 0;
        const [existing] = await rows(tx, sql`SELECT id FROM coordination_credential_audit_events
          WHERE event_type='central_expiry_warned' AND success=true
            AND metadata->>'grantId'=${grant.id} LIMIT 1`);
        if (existing) return 0;
        const content = `Central-record read grant ${grant.id} for ${grant.actor} / ${grant.runtime_id} expires at ${grant.expires_utc}. Review it in /admin/runtime-onboarding before expiry if continued access is needed. This notice does not renew or extend access.`;
        await tx.execute(sql`INSERT INTO alden_notifications
          (content,triggered_by,severity,read,fingerprint)
          VALUES (${content},'central-read-expiry','warning',false,${`central_expiry:${grant.id}`})`);
        await tx.execute(sql`INSERT INTO coordination_credential_audit_events
          (event_type,success,runtime_id,actor,metadata)
          VALUES ('central_expiry_warned',true,${grant.runtime_id},${grant.actor},
            ${JSON.stringify({ grantId: grant.id, warningDays: 14, channel: "founder-inbox" })}::jsonb)`);
        return 1;
      });
    }
    return { warned, scannerBusy: false };
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
/** Called only by normal app startup after HTTP is serving, never by import. */
export function startCentralGrantExpiryWarnings() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runCentralGrantExpiryWarnings(); }
    catch { console.error("[CentralRead] Expiry-warning scan failed; retrying next hour."); }
    finally { running = false; }
  };
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();
}
