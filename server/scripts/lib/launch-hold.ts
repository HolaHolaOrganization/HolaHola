/**
 * In-script hold for standalone writers (plan efb1e3d1 rev 13, O2/O3), the
 * second line behind scripts/launch-gate.sh: a writer launched directly, not
 * through the gate, still refuses before it writes anything.
 *
 * A held writer may run only against the verified disposable CI database
 * (getVerifiedCiDatabaseUrl: CI=true, job-local host, NEON_SHARED_DATABASE_URL
 * equal to CI_DATABASE_URL). Anywhere else it prints NOT RUN and exits 0.
 * Lifting a hold for live data is a reviewed code change, never a flag.
 */
import { getVerifiedCiDatabaseUrl } from '../../ci-database';

export const HELD_WRITERS = [
  'capture-watchdog',
  'rolling-episode-restore',
  'luca-chat-canonical-save',
] as const;
export type HeldWriterId = (typeof HELD_WRITERS)[number];

export function heldWriterMayRun(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Boolean(getVerifiedCiDatabaseUrl(env));
  } catch {
    return false; // a misconfigured CI target never counts as disposable
  }
}

export function holdUnlessDisposableTarget(id: HeldWriterId, env: NodeJS.ProcessEnv = process.env): void {
  if (heldWriterMayRun(env)) return;
  console.log(`[launch-hold] NOT RUN: '${id}' is HELD — it writes shared state and may run only against a verified disposable CI database (instance role: ${env.HOLAHOLA_INSTANCE_ROLE ?? 'unset'}).`);
  process.exit(0);
}
