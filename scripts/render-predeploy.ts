/**
 * Render pre-deploy step: applies pending schema migrations and data-ops to
 * the production database BEFORE Render switches traffic to the new release.
 *
 * Why this exists (2026-10-15): main is now landed only through reviewed,
 * CI-green pull requests, and Render auto-deploys main after its checks pass.
 * The retired cross-tool-promote.yml used to be the only path that ran
 * `drizzle-kit migrate` + `scripts/run-data-ops.ts` against production, so a
 * plain PR merge would otherwise ship code whose migration never reached the
 * real database. Render runs this command in the freshly built image after
 * the build and before the start command; a non-zero exit fails the deploy
 * and leaves the previous release serving, so a failed migration can never be
 * followed by code that depends on it.
 *
 * Same two steps, in the same order, as the retired workflow's
 * "Apply migration + data-ops to production" step:
 *   1. `drizzle-kit migrate` (its migrations table makes re-runs a no-op)
 *   2. `scripts/run-data-ops.ts` (every data-op must be idempotent)
 *
 * drizzle-kit needs a direct (unpooled) Neon connection. The direct URL is
 * derived ONLY from the app's own NEON_SHARED_DATABASE_URL, by dropping the
 * `-pooler` suffix from a Neon endpoint host (Neon's documented pooled/direct
 * naming). There is deliberately no separate override: a second URL could
 * point the migration at a different database than the one the app serves
 * from, and both steps would "succeed" with the real schema unmigrated.
 * No new secret is required, and no connection string is ever printed.
 *
 * A failure here keeps the previous release serving, but it does NOT roll
 * back a schema step or data-op that already committed. The old release keeps
 * running against the changed database, so every migration and data-op must
 * stay backward-compatible with the release before it.
 *
 * Usage (Render "Pre-Deploy Command"): npx tsx scripts/render-predeploy.ts
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface DirectUrlResolution {
  url: string;
  source: 'derived-from-pooled' | 'already-direct';
}

const NEON_HOST_SUFFIX = '.neon.tech';

/**
 * Neon pooled endpoint hosts end their first DNS label with `-pooler`. Only
 * hosts under neon.tech are rewritten; any other host is returned unchanged.
 */
export function toDirectNeonUrl(connectionString: string): { url: string; changed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('NEON_SHARED_DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`NEON_SHARED_DATABASE_URL has unsupported protocol "${parsed.protocol}"`);
  }
  const [firstLabel, ...rest] = parsed.hostname.split('.');
  if (!parsed.hostname.toLowerCase().endsWith(NEON_HOST_SUFFIX) || !firstLabel.endsWith('-pooler')) {
    return { url: connectionString, changed: false };
  }
  parsed.hostname = [firstLabel.slice(0, -'-pooler'.length), ...rest].join('.');
  return { url: parsed.toString(), changed: true };
}

export function resolveDirectUrl(env: NodeJS.ProcessEnv): DirectUrlResolution {
  const pooled = env.NEON_SHARED_DATABASE_URL?.trim();
  if (!pooled) {
    throw new Error('NEON_SHARED_DATABASE_URL is required for the pre-deploy migration step');
  }
  const { url, changed } = toDirectNeonUrl(pooled);
  return { url, source: changed ? 'derived-from-pooled' : 'already-direct' };
}

function runStep(label: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`[predeploy] ${label}: npx ${args.join(' ')}`);
  const result = spawnSync('npx', args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} FAILED (exit ${result.status ?? result.signal})`);
  }
  console.log(`[predeploy] ${label}: OK`);
}

function main(): void {
  const { url, source } = resolveDirectUrl(process.env);
  console.log(`[predeploy] database connection: direct (${source})`);
  const env = { ...process.env, NEON_SHARED_DATABASE_URL: url };
  runStep('schema migrations', ['drizzle-kit', 'migrate'], env);
  runStep('data-ops', ['tsx', 'scripts/run-data-ops.ts'], env);
  console.log('[predeploy] SUCCEEDED — migrations and data-ops are applied; Render may start the new release.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`[predeploy] FAILED — ${err instanceof Error ? err.message : String(err)}. The deploy must not proceed.`);
    process.exit(1);
  }
}
