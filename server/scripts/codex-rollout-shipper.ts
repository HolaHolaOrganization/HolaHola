/**
 * codex-rollout-shipper.ts
 *
 * Ships completed Codex exchanges from a Codex session rollout into the
 * canonical conversation intake (POST /api/internal/canonical-conversation-exchange)
 * as source "codex", recorded as "David [Codex]" / "Luca [Codex]"
 * (native Codex onboarding design 4860f832, step 3). Parsing is in
 * lib/codex-rollout-shipper.ts; checkpointing and shipping reuse the
 * Antigravity journal shipper's fail-closed path.
 *
 * Authentication is luca-codex's own enrolled access credential from the
 * native runtime onboarding store (step 5). There is no legacy token, no
 * borrowed identity and no default runtime id: until Codex is enrolled this
 * can only run with --dry-run.
 *
 * USAGE:
 *   node --import tsx server/scripts/codex-rollout-shipper.ts --rollout <rollout-*.jsonl> \
 *     --runtime-id <luca-codex runtime id> [--url <apiUrl>] [--state-dir <dir>] [--dry-run]
 *   # As a Codex Stop hook (reads the hook's JSON on stdin, ships its transcript_path,
 *   # always exits 0 so a recording failure never blocks Codex):
 *   node --import tsx server/scripts/codex-rollout-shipper.ts --hook --runtime-id <id>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { ShipperStateStore, shipAntigravityExchanges, type ShipReport } from './lib/antigravity-journal-shipper';
import { parseCodexRollout, type CodexParseResult } from './lib/codex-rollout-shipper';

export interface CodexShipperOptions {
  rolloutPath?: string;
  hook: boolean;
  runtimeId?: string;
  apiUrl: string;
  stateBaseDir: string;
  dryRun: boolean;
}

export function parseCodexShipperArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CodexShipperOptions {
  const allowed = new Set(['rollout', 'hook', 'runtime-id', 'url', 'state-dir', 'dry-run']);
  const flags = new Set(['hook', 'dry-run']);
  const options: Record<string, string | boolean> = {};
  const args = [...argv];
  while (args.length) {
    const key = args.shift()!;
    const name = key.slice(2);
    if (!key.startsWith('--') || !allowed.has(name) || name in options) throw new Error(`Unknown, invalid or repeated argument: ${key}`);
    if (flags.has(name)) { options[name] = true; continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for argument: ${key}`);
    options[name] = value;
  }
  const hook = options.hook === true;
  if (hook === Boolean(options.rollout)) throw new Error('Exactly one of --rollout <path> or --hook is required');
  return {
    ...(options.rollout ? { rolloutPath: resolve(options.rollout as string) } : {}),
    hook,
    runtimeId: (options['runtime-id'] as string) || env.COORDINATION_RUNTIME_ID || undefined,
    apiUrl: (options.url as string) || env.COORDINATION_API_URL || 'https://getholahola.com',
    // Under CODEX_HOME by default: the Codex sandbox can write there when this runs as a hook.
    stateBaseDir: resolve((options['state-dir'] as string) || join(env.CODEX_HOME || join(homedir(), '.codex'), 'holahola-shipper')),
    dryRun: options['dry-run'] === true,
  };
}

/** Read a rollout, decompressing an archived .jsonl.zst when the runtime supports it. */
export function readRollout(path: string): string {
  const bytes = readFileSync(path);
  if (!path.endsWith('.zst')) return bytes.toString('utf8');
  const decompress = (zlib as any).zstdDecompressSync as ((b: Buffer) => Buffer) | undefined;
  if (!decompress) throw new Error('This Node runtime cannot read .zst rollouts');
  return decompress(bytes).toString('utf8');
}

/** The rollout path a Codex hook names, from its stdin JSON. */
export function rolloutPathFromHookPayload(raw: string): string {
  let payload: any;
  try { payload = JSON.parse(raw); } catch { throw new Error('hook stdin is not JSON'); }
  const path = payload?.transcript_path;
  if (typeof path !== 'string' || !path) throw new Error('hook payload has no transcript_path');
  return path;
}

async function loadAccessToken(apiUrl: string, runtimeId: string): Promise<string> {
  const { createNativeRuntimeOnboardingStore } = await import('../services/runtime-onboarding-store');
  const raw = await createNativeRuntimeOnboardingStore().get({ endpoint: apiUrl, actor: 'luca-codex', runtimeId }, 'access-credential');
  if (!raw) throw new Error(`No luca-codex access credential in the native store for runtime ${runtimeId} (enrollment, step 5)`);
  const cred = JSON.parse(raw);
  if (!cred?.accessToken) throw new Error('The luca-codex credential in the native store has no accessToken');
  return cred.accessToken;
}

export async function runCodexShipper(
  options: CodexShipperOptions & { rolloutPath: string },
  deps: { fetchImpl?: typeof fetch; accessToken?: (apiUrl: string, runtimeId: string) => Promise<string> } = {},
): Promise<{ parse: CodexParseResult; report: ShipReport }> {
  if (!existsSync(options.rolloutPath)) throw new Error(`rollout not found: ${options.rolloutPath}`);
  const parse = parseCodexRollout(readRollout(options.rolloutPath));
  const stateStore = new ShipperStateStore(join(options.stateBaseDir, parse.runtime.sessionId));
  let authToken = 'dry-run-no-token';
  if (!options.dryRun) {
    if (!options.runtimeId) throw new Error('--runtime-id (or COORDINATION_RUNTIME_ID) is required; there is no default luca-codex runtime');
    authToken = await (deps.accessToken ?? loadAccessToken)(options.apiUrl, options.runtimeId);
  }
  const report = await shipAntigravityExchanges(parse, {
    apiUrl: options.apiUrl, authToken, stateStore, dryRun: options.dryRun,
    expectedConversationId: parse.runtime.sessionId, source: 'codex',
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return { parse, report };
}

function summary(parse: CodexParseResult, report: ShipReport): string {
  return `[codex-shipper] session=${parse.runtime.sessionId} shipped=${report.shipped} simulated=${report.simulated} skipped=${report.skipped} ` +
    `failed=${report.failed} unresolved=${report.unresolvedCount} openTrailing=${report.isOpenTrailing} nonDialogue=${parse.skippedNonDialogueTurns}` +
    (report.errors.length ? ` errors=${JSON.stringify(report.errors)}` : '');
}

async function main(): Promise<void> {
  const options = parseCodexShipperArgs(process.argv.slice(2));
  if (!options.hook) {
    const { parse, report } = await runCodexShipper(options as CodexShipperOptions & { rolloutPath: string });
    console.log(summary(parse, report));
    if (report.failed > 0) process.exitCode = 1;
    return;
  }
  // Hook mode: never block or fail the Codex turn; record what happened locally.
  mkdirSync(options.stateBaseDir, { recursive: true });
  const log = (line: string) => { try { appendFileSync(join(options.stateBaseDir, 'hook.log'), `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } };
  try {
    const raw = readFileSync(0, 'utf8');
    const { parse, report } = await runCodexShipper({ ...options, rolloutPath: rolloutPathFromHookPayload(raw) });
    log(summary(parse, report));
  } catch (e: any) {
    log(`[codex-shipper] FAILED: ${e?.message ?? e}`);
  }
  process.exitCode = 0;
}

if (isDirectCliInvocation('codex-rollout-shipper.ts')) {
  main().catch((e) => { console.error(`[codex-shipper] ${e?.message ?? e}`); process.exit(1); });
}
