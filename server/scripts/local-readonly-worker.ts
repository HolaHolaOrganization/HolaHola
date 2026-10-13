/**
 * Local Read-only Worker v1 supervisor CLI (design bb6c6c06 rev b8fe5e66).
 *
 *   npx tsx server/scripts/local-readonly-worker.ts --charter-id <uuid> --charter-version <n>
 *     (--plan-only | --until <ISO> [--max-jobs N]) [--adapter claude-cli|claude-cli-nofiletools]
 *     [--reclaim-stale-lock] [--state-dir <path>] [--staging-root <path>]
 *
 * Requires COORDINATION_API_URL (base, e.g. https://getholahola.com) and the
 * luca-claude-code coordination token in COORDINATION_LUCA_CLAUDE_CODE_TOKEN.
 * The token is used only by the supervisor's HTTP port and is never passed to
 * the harness. Founder-run only; this CLI never schedules itself.
 *
 * API-profile jobs are NOT available from this CLI: it supplies no designated API key
 * (no credential handling in this phase), so the supervisor refuses such jobs before
 * any claim (decision ineligible:api_key_not_configured). Only the subscription profile
 * can run, and only after a separate qualification gate.
 */
import { createFileStateStore, createHostPort, createHttpLedgerPort, defaultStateDir } from '../services/local-worker/ports';
import { runSupervisor } from '../services/local-worker/supervisor';
import { isDirectCliInvocation } from './lib/cli-entrypoint';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const charterId = arg('charter-id');
  const charterVersion = Number(arg('charter-version'));
  const planOnly = flag('plan-only');
  const until = arg('until');
  const adapter = (arg('adapter') ?? 'claude-cli') as 'claude-cli' | 'claude-cli-nofiletools';
  if (!charterId || !Number.isSafeInteger(charterVersion) || charterVersion < 1) throw new Error('--charter-id and --charter-version are required');
  if (!planOnly && !until) throw new Error('normal mode requires --until <ISO> (bounded runs only)');
  if (!['claude-cli', 'claude-cli-nofiletools'].includes(adapter)) throw new Error('--adapter invalid');
  const untilMs = planOnly ? Date.now() + 60_000 : Date.parse(until!);
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) throw new Error('--until must be a future ISO timestamp');
  const maxJobs = Number(arg('max-jobs') ?? '1');
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 50) throw new Error('--max-jobs must be 1..50');

  const apiUrl = process.env.COORDINATION_API_URL;
  const token = process.env.COORDINATION_LUCA_CLAUDE_CODE_TOKEN;
  if (!apiUrl || !token) throw new Error('COORDINATION_API_URL and COORDINATION_LUCA_CLAUDE_CODE_TOKEN are required');
  const base = apiUrl.replace(/\/api\/coordination\/?$/, '');

  const report = await runSupervisor(
    { workerActor: 'luca-claude-code', charterId, charterVersion, planOnly, untilMs, maxJobs, adapter,
      reclaimStaleLock: flag('reclaim-stale-lock'), log: (l) => process.stderr.write(`[lrw] ${l}\n`) },
    createHttpLedgerPort(base, token),
    createHostPort({ repoRoot: process.cwd(), stagingRoot: arg('staging-root') ?? 'C:\\hh-w' }),
    createFileStateStore(arg('state-dir') ?? defaultStateDir()),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.halted) process.exitCode = 2;
}

if (isDirectCliInvocation('local-readonly-worker.ts')) {
  main().catch((e) => { process.stderr.write(`[lrw] ${(e as Error).message}\n`); process.exitCode = 1; });
}
