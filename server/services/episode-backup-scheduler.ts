/**
 * Runs the episode backup (episode-backup.ts) every hour on the production
 * instance and tells the hats when it needs attention (design fc90e95a,
 * Phase B; founder decision 2026-11-03: hourly, daily copies 90 days, monthly
 * 2 years). Nothing here deletes anything: retention is applied later with a
 * separate founder-held credential.
 *
 * Alerts go to the hats on the standing coordination thread
 * EPISODE_BACKUP_ALERT_THREAD_ID (a listed system alert channel in
 * coordination-ledger-service.ts), posted by coordination-system and addressed
 * to each hat, so their listeners wake:
 *   - a flagged run (a row missing, shrunk or rewritten): once per flagged manifest;
 *   - no good backup for over STALE_ALERT_MS (a failing, misconfigured or
 *     silent export): once per STALE_ALERT_WINDOW_MS.
 * Past FOUNDER_ESCALATION_MS without a good backup the founder inbox is told
 * too, once per day. The age comes from the newest last-good pointer in the
 * bucket, so it survives restarts; repeats are suppressed by the ledger's own
 * idempotency keys, so no state lives in memory.
 */
import { sql } from 'drizzle-orm';
import type { CoordinationActorId } from '@shared/schema';
import type { BackupRunResult } from './episode-backup';

export const EPISODE_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const EPISODE_BACKUP_FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
/** Three missed hourly runs. */
export const STALE_ALERT_MS = 3 * 60 * 60 * 1000;
export const STALE_ALERT_WINDOW_MS = 6 * 60 * 60 * 1000;
export const FOUNDER_ESCALATION_MS = 24 * 60 * 60 * 1000;
/** "Episode backup alerts (standing thread)", opened by luca-claude-code on 2026-11-03. */
export const EPISODE_BACKUP_ALERT_THREAD_ID = '9e442310-8e80-4c4c-bfbb-449f627efffd';
export const EPISODE_BACKUP_ALERT_HATS: readonly CoordinationActorId[] = Object.freeze([
  'luca-claude-code', 'luca-replit', 'luca-antigravity', 'luca-codex',
] as CoordinationActorId[]);

export type BackupAlert =
  | { kind: 'flagged'; key: string; text: string }
  | { kind: 'stale'; key: string; text: string };

export interface BackupTickDeps {
  run: () => Promise<BackupRunResult>;
  /** takenAt of the newest last-good pointer, or null if there is none. */
  lastGoodAt: () => Promise<string | null>;
  alertHats: (alert: BackupAlert) => Promise<void>;
  alertFounder: (key: string, text: string) => Promise<void>;
  now: () => number;
  /** When this process started watching; the age of "never backed up" counts from here. */
  watchingSince: number;
}

export interface BackupTickOutcome {
  run: 'advanced' | 'flagged' | 'failed';
  error?: string;
  ageMs: number | null;
  alerts: string[];
}

const windowStart = (now: number, windowMs: number) => new Date(Math.floor(now / windowMs) * windowMs).toISOString();

/** One scheduled pass: run the backup, then judge how old the last good backup is. Never throws. */
export async function episodeBackupTick(deps: BackupTickDeps): Promise<BackupTickOutcome> {
  const alerts: string[] = [];
  let run: BackupTickOutcome['run'];
  let error: string | undefined;
  try {
    const result = await deps.run();
    run = result.outcome === 'flagged' ? 'flagged' : 'advanced';
    if (result.outcome === 'flagged') {
      const kinds = result.flags.map((f) => ('id' in f ? `${f.kind} ${f.id}` : f.kind));
      const alert: BackupAlert = {
        kind: 'flagged',
        key: `flagged:${result.manifestKey}`,
        text: `The episode backup found content that is not pure growth since the last good backup, so last-good did not move. `
          + `Flags (${result.flags.length}): ${kinds.slice(0, 20).join('; ')}${kinds.length > 20 ? '; …' : ''}. `
          + `Flagged manifest: ${result.manifestKey}. Check the canonical rows before anything else writes to them.`,
      };
      await sendHats(deps, alert, alerts);
    }
  } catch (err) {
    run = 'failed';
    error = err instanceof Error ? err.message : String(err);
    console.error('[EpisodeBackup] scheduled run failed:', error);
  }

  let ageMs: number | null = null;
  try {
    const lastGoodAt = await deps.lastGoodAt();
    const since = lastGoodAt ? Date.parse(lastGoodAt) : deps.watchingSince;
    ageMs = deps.now() - since;
    const hours = Math.floor(ageMs / 3_600_000);
    const what = lastGoodAt ? `The last good episode backup was ${hours} h ago (${lastGoodAt}).` : `No good episode backup exists yet; this server has been trying for ${hours} h.`;
    const why = error ? ` The latest run failed: ${error.slice(0, 300)}` : run === 'flagged' ? ' The latest run was flagged (see the flagged alert).' : '';
    if (ageMs > STALE_ALERT_MS) {
      await sendHats(deps, { kind: 'stale', key: `stale:${windowStart(deps.now(), STALE_ALERT_WINDOW_MS)}`, text: what + why }, alerts);
    }
    if (ageMs > FOUNDER_ESCALATION_MS) {
      const key = `episode_backup_stale:${new Date(deps.now()).toISOString().slice(0, 10)}`;
      try {
        await deps.alertFounder(key, `${what}${why} The hats have been alerted on coordination thread ${EPISODE_BACKUP_ALERT_THREAD_ID} and it is still unresolved.`);
        alerts.push(key);
      } catch (err) {
        console.error('[EpisodeBackup] founder escalation failed:', err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error('[EpisodeBackup] last-good check failed:', err instanceof Error ? err.message : err);
  }
  return { run, error, ageMs, alerts };
}

async function sendHats(deps: BackupTickDeps, alert: BackupAlert, sent: string[]) {
  try {
    await deps.alertHats(alert);
    sent.push(alert.key);
  } catch (err) {
    console.error('[EpisodeBackup] hat alert failed:', err instanceof Error ? err.message : err);
  }
}

/** Posts one comment per hat on the standing thread; the idempotency key makes a repeat a no-op. */
export async function postBackupAlertToHats(alert: BackupAlert, threadId = EPISODE_BACKUP_ALERT_THREAD_ID): Promise<void> {
  const { appendCoordinationEvent, CoordinationError } = await import('./coordination-ledger-service');
  const db = (await import('../db')).getSharedDb();
  for (const hat of EPISODE_BACKUP_ALERT_HATS) {
    for (let attempt = 0; ; attempt += 1) {
      // coordination-system is not a participant, so it reads the sequence directly rather than through getCoordinationThread.
      const found = await db.execute(sql`SELECT latest_sequence FROM coordination_threads WHERE id = ${threadId}`);
      const row = ((found as any).rows ?? found)[0];
      if (!row) throw new Error(`episode backup alert channel ${threadId} not found`);
      try {
        await appendCoordinationEvent({
          threadId,
          actor: 'coordination-system',
          recipientActor: hat,
          eventType: 'comment',
          content: `Episode backup alert (${alert.kind}). ${alert.text}`,
          idempotencyKey: `episode-backup:${alert.key}:${hat}`,
          expectedSequence: Number(row.latest_sequence),
          payload: { kind: 'system_alert', source: 'episode-backup', alert: alert.kind, key: alert.key },
        });
        break;
      } catch (error) {
        if (error instanceof CoordinationError && error.code === 'sequence_conflict' && attempt < 3) continue;
        throw error;
      }
    }
  }
}

/** One founder-inbox notice per key. */
export async function postBackupAlertToFounder(key: string, text: string): Promise<void> {
  const db = (await import('../db')).getSharedDb();
  const existing = await db.execute(sql`SELECT 1 FROM alden_notifications WHERE fingerprint = ${key} LIMIT 1`);
  if (((existing as any).rows ?? existing).length) return;
  await db.execute(sql`INSERT INTO alden_notifications (content, triggered_by, severity, read, fingerprint)
    VALUES (${text}, 'episode-backup', 'alert', false, ${key})`);
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Called only by normal app startup on the production instance (background task "episode-backup"). */
export function startEpisodeBackupScheduler(): void {
  if (timer) return;
  const watchingSince = Date.now();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scheduledPass(watchingSince);
    } catch (err) {
      console.error('[EpisodeBackup] scheduled pass could not start:', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, EPISODE_BACKUP_FIRST_RUN_DELAY_MS);
  timer = setInterval(() => { void tick(); }, EPISODE_BACKUP_INTERVAL_MS);
}

async function scheduledPass(watchingSince: number): Promise<void> {
  const { getSharedDb } = await import('../db');
  const { BACKUP_PREFIX_DEFAULT, readLastGood, runEpisodeBackup, takeInventory } = await import('./episode-backup');
  const { s3BackupStoreFromEnv } = await import('./episode-backup-s3');
  const db = getSharedDb();
  // Built per tick, so a missing bucket or credential is a failed run (and, after 3 h, an alert), not a crash.
  const store = () => s3BackupStoreFromEnv().store;
  const outcome = await episodeBackupTick({
    run: () => runEpisodeBackup({ store: store(), inventory: () => takeInventory(db) }),
    lastGoodAt: async () => (await readLastGood(store(), BACKUP_PREFIX_DEFAULT))?.takenAt ?? null,
    alertHats: (alert) => postBackupAlertToHats(alert),
    alertFounder: postBackupAlertToFounder,
    now: Date.now,
    watchingSince,
  });
  console.log(`[EpisodeBackup] ${outcome.run}; last good ${outcome.ageMs === null ? 'unknown' : `${Math.round(outcome.ageMs / 60000)} min`} ago${outcome.alerts.length ? `; alerts ${outcome.alerts.join(', ')}` : ''}`);
}
