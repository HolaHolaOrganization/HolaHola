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
 * drizzle-kit needs a direct (unpooled) Neon connection. Render holds only
 * NEON_SHARED_DATABASE_URL, so the direct URL is NEON_DIRECT_DATABASE_URL when
 * set, otherwise derived from the pooled URL by dropping Neon's `-pooler`
 * host suffix (Neon's documented pooled/direct naming). No new secret is
 * required, and no connection string is ever printed.
 *
 * Usage (Render "Pre-Deploy Command"): npx tsx scripts/render-predeploy.ts
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface DirectUrlResolution {
  url: string;
  source: 'NEON_DIRECT_DATABASE_URL' | 'derived-from-pooled' | 'already-direct';
}

/** Neon pooled hosts end their first DNS label with `-pooler`. */
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
  if (!firstLabel.endsWith('-pooler')) {
    return { url: connectionString, changed: false };
  }
  parsed.hostname = [firstLabel.slice(0, -'-pooler'.length), ...rest].join('.');
  return { url: parsed.toString(), changed: true };
}

export function resolveDirectUrl(env: NodeJS.ProcessEnv): DirectUrlResolution {
  const explicit = env.NEON_DIRECT_DATABASE_URL?.trim();
  if (explicit) {
    return { url: toDirectNeonUrl(explicit).url, source: 'NEON_DIRECT_DATABASE_URL' };
  }
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
