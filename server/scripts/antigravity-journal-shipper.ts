/**
 * antigravity-journal-shipper.ts
 *
 * Ships conversation turns from the local Antigravity transcript journal
 * (preferring transcript_full.jsonl and falling back read-only to
 * conversations/<id>.db across IDE restarts) into the canonical conversation
 * intake endpoint (POST /api/internal/canonical-conversation-exchange) as
 * speaker "David [Antigravity]" and "Luca [Antigravity]".
 *
 * Part B of the Antigravity adapter (founder priority; approved design 535ca04f
 * + SQLite fallback Revision 2 seq 82/83).
 *
 * USAGE:
 *   node --import tsx server/scripts/antigravity-journal-shipper.ts \
 *     [--transcript <path-to-transcript_full.jsonl>] \
 *     [--db <path-to-conversation.db>] \
 *     --conversation-id <uuid> \
 *     [--url <apiUrl>] \
 *     [--state-dir <path>] \
 *     [--dry-run]
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import {
  assertNotSummariesDb,
  EVICTION_WARNING_UNSHIPPED_STEPS,
  type EvictionWarningRecord,
  type ParseResult,
  parseAntigravityJournal,
  persistJournalEvidence,
  ShipperStateStore,
  shipAntigravityExchanges,
  snapshotAndParseAntigravitySqliteDb,
} from './lib/antigravity-journal-shipper';

export interface ShipperCliOptions {
  transcriptPath?: string;
  dbPath?: string;
  conversationId: string;
  apiUrl?: string;
  stateDir: string;
  runtimeId?: string;
  dryRun?: boolean;
  onEvictionWarning?: (warning: EvictionWarningRecord) => Promise<void> | void;
}

export function parseShipperArgs(argv: string[]): ShipperCliOptions {
  const options: Record<string, string | boolean> = {};
  const allowed = new Set([
    'transcript',
    'db',
    'conversation-id',
    'url',
    'state-dir',
    'runtime-id',
    'dry-run',
  ]);

  const args = [...argv];
  while (args.length) {
    const key = args.shift()!;
    if (!key.startsWith('--') || !allowed.has(key.slice(2))) {
      throw new Error(`Unknown or invalid argument: ${key}`);
    }
    const name = key.slice(2);
    if (name === 'dry-run') {
      options[name] = true;
    } else {
      const val = args.shift();
      if (!val || val.startsWith('--')) {
        throw new Error(`Missing value for argument: ${key}`);
      }
      options[name] = val;
    }
  }

  const conversationId = (options['conversation-id'] as string) || '';
  if (!conversationId) {
    throw new Error('--conversation-id is required');
  }

  const rawTranscript = (options.transcript as string) || '';
  const rawDb = (options.db as string) || '';
  if (!rawTranscript && !rawDb) {
    throw new Error('--transcript or --db is required');
  }

  if (rawTranscript) assertNotSummariesDb(rawTranscript);
  if (rawDb) assertNotSummariesDb(rawDb);

  const apiUrl = (options.url as string) || process.env.COORDINATION_API_URL || 'https://getholahola.com';
  const runtimeId =
    (options['runtime-id'] as string) ||
    process.env.COORDINATION_RUNTIME_ID ||
    'luca-antigravity-littlenemo-observer-20261014-d523deda';
  const stateDir = (options['state-dir'] as string) || resolve('.local/antigravity-journal-shipper', conversationId);
  const dryRun = options['dry-run'] === true;

  return {
    ...(rawTranscript ? { transcriptPath: resolve(rawTranscript) } : {}),
    ...(rawDb ? { dbPath: resolve(rawDb) } : {}),
    conversationId,
    apiUrl,
    stateDir: resolve(stateDir),
    runtimeId,
    dryRun,
  };
}

/**
 * Infers the sibling conversations/<conversationId>.db path when given a path inside
 * <antigravityRoot>/brain/<conversationId>/.system_generated/logs/transcript*.jsonl,
 * or falls back to ~/.gemini/antigravity/conversations/<conversationId>.db.
 */
export function inferDefaultSqliteDbPath(conversationId: string, transcriptPath?: string): string {
  if (transcriptPath) {
    const normalized = transcriptPath.replace(/\\/g, '/');
    const brainIdx = normalized.lastIndexOf(`/brain/${conversationId}/`);
    if (brainIdx > 0) {
      const rootDir = transcriptPath.slice(0, brainIdx);
      return resolve(rootDir, 'conversations', `${conversationId}.db`);
    }
  }
  return resolve(homedir(), '.gemini', 'antigravity', 'conversations', `${conversationId}.db`);
}

/**
 * Resolves the transcript source to read:
 * 1. Never allows conversation_summaries.db.
 * 2. If transcriptPath points to .../transcript.jsonl and sibling .../transcript_full.jsonl
 *    exists, automatically upgrades to transcript_full.jsonl so compact truncation is avoided.
 * 3. If the JSONL file is absent (e.g. cleaned up after an IDE restart) and dbPath (or the
 *    inferred conversations/<id>.db) exists, falls back to read-only SQLite.
 */
export function resolveShipperSource(options: ShipperCliOptions): {
  mode: 'jsonl' | 'sqlite';
  path: string;
} {
  if (options.transcriptPath) assertNotSummariesDb(options.transcriptPath);
  if (options.dbPath) assertNotSummariesDb(options.dbPath);

  if (options.transcriptPath) {
    let candidateJsonl = options.transcriptPath;
    if (basename(candidateJsonl).toLowerCase() === 'transcript.jsonl') {
      const fullSibling = join(dirname(candidateJsonl), 'transcript_full.jsonl');
      if (existsSync(fullSibling)) {
        candidateJsonl = fullSibling;
      }
    }
    if (existsSync(candidateJsonl)) {
      return { mode: 'jsonl', path: candidateJsonl };
    }

    const fallbackDb = options.dbPath ?? inferDefaultSqliteDbPath(options.conversationId, options.transcriptPath);
    assertNotSummariesDb(fallbackDb);
    if (existsSync(fallbackDb)) {
      return { mode: 'sqlite', path: fallbackDb };
    }

    throw new Error(
      `Failed to read transcript file: "${options.transcriptPath}" does not exist and SQLite fallback "${fallbackDb}" was not found`
    );
  }

  if (options.dbPath) {
    if (!existsSync(options.dbPath)) {
      throw new Error(`Failed to read SQLite database: "${options.dbPath}" does not exist`);
    }
    return { mode: 'sqlite', path: options.dbPath };
  }

  throw new Error('--transcript or --db is required');
}

export async function runShipper(options: ShipperCliOptions) {
  const apiUrl = options.apiUrl || process.env.COORDINATION_API_URL || 'https://getholahola.com';
  const runtimeId =
    options.runtimeId ||
    process.env.COORDINATION_RUNTIME_ID ||
    'luca-antigravity-littlenemo-observer-20261014-d523deda';
  const dryRun = options.dryRun === true;

  const stateStore = new ShipperStateStore(options.stateDir);
  // Step 1: Verify conversation scope BEFORE any cursor use, parsing, or evidence writes!
  const checkpoint = await stateStore.loadCheckpoint(options.conversationId);
  const afterStepIndex = checkpoint?.lastContiguousAcknowledgedStepIndex ?? -1;

  const source = resolveShipperSource(options);
  console.log(`[shipper] Reading ${source.mode} source: ${source.path}`);
  console.log(`[shipper] Conversation: ${options.conversationId} (resume after contiguous step: ${afterStepIndex})`);

  let parseResult: ParseResult;
  let sourceDbSha256: string | undefined;

  if (source.mode === 'jsonl') {
    let rawFile = '';
    try {
      rawFile = await readFile(source.path, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to read transcript file: ${err.message}`);
    }
    const lines = rawFile.split(/\r?\n/);
    parseResult = parseAntigravityJournal(lines, options.conversationId, afterStepIndex);
  } else {
    const sqliteResult = await snapshotAndParseAntigravitySqliteDb(
      source.path,
      options.conversationId,
      afterStepIndex
    );
    parseResult = sqliteResult;
    sourceDbSha256 = sqliteResult.sourceSnapshot.sourceDbSha256;
    await stateStore.recordSourceSnapshotEvidence(sqliteResult.sourceSnapshot);
  }

  // CRITICAL: Persist all evidence to local durable disk storage IMMEDIATELY,
  // BEFORE any early returns or network calls!
  await persistJournalEvidence(parseResult, stateStore);

  // Check eviction-horizon threshold (>= 1500 unshipped steps)
  const unshippedSpan = parseResult.lastProcessedStepIndex - afterStepIndex;
  let evictionWarning = false;
  if (unshippedSpan >= EVICTION_WARNING_UNSHIPPED_STEPS) {
    evictionWarning = true;
    const warningRecord: EvictionWarningRecord = {
      conversationId: options.conversationId,
      afterStepIndex,
      lastProcessedStepIndex: parseResult.lastProcessedStepIndex,
      unshippedStepSpan: unshippedSpan,
      threshold: EVICTION_WARNING_UNSHIPPED_STEPS,
      recordedAt: new Date().toISOString(),
    };
    await stateStore.recordEvictionWarning(warningRecord);
    console.warn(
      `LUCASHIP_EVICTION_ALARM conversation=${options.conversationId} unshipped_steps=${unshippedSpan} threshold=${EVICTION_WARNING_UNSHIPPED_STEPS}`
    );
    if (options.onEvictionWarning) {
      await options.onEvictionWarning(warningRecord);
    }
  }

  console.log(`[shipper] Found ${parseResult.exchanges.length} complete exchange(s)`);
  if (parseResult.unresolvedTurns.length > 0) {
    console.warn(
      `[shipper] ${parseResult.unresolvedTurns.length} ambiguous/unresolved turn(s) held back at steps: ${parseResult.unresolvedTurns.map(t => t.stepIndex).join(', ')}`
    );
  }
  if (parseResult.unpairedUserInputs.length > 0) {
    console.log(`[shipper] ${parseResult.unpairedUserInputs.length} unpaired user input(s) recorded in durable pending store`);
  }
  if (parseResult.openTrailingTurn) {
    console.log(`[shipper] Open trailing turn at step ${parseResult.openTrailingTurn.stepIndex} held until completion`);
  }
  if (parseResult.incompleteTrailingLine) {
    console.log(`[shipper] Buffered 1 incomplete trailing line`);
  }

  const acknowledgedSet = new Set<number>(checkpoint?.acknowledgedSteps ?? []);
  const unacknowledgedExchanges = parseResult.exchanges.filter(ex => !acknowledgedSet.has(ex.stepIndex));

  if (unacknowledgedExchanges.length === 0) {
    console.log('[shipper] No unacknowledged complete exchanges to ship.');
    return {
      attempted: 0,
      shipped: 0,
      simulated: 0,
      skipped: parseResult.exchanges.length,
      failed: 0,
      pendingUnpaired: parseResult.unpairedUserInputs.length,
      unresolvedCount: parseResult.unresolvedTurns.length,
      isOpenTrailing: Boolean(parseResult.openTrailingTurn),
      lastAcknowledgedStepIndex: afterStepIndex,
      evictionWarning,
      ...(sourceDbSha256 ? { sourceDbSha256 } : {}),
      errors: [],
    };
  }

  let accessToken = 'dry-run-no-token';
  if (!dryRun) {
    // Obtain authorization credential via native DPAPI store
    console.log(`[shipper] Authenticating with native credential store (runtime: ${runtimeId})...`);
    const { createNativeRuntimeOnboardingStore } = await import('../services/runtime-onboarding-store');
    const store = createNativeRuntimeOnboardingStore();
    const raw = await store.get(
      { endpoint: apiUrl, actor: 'luca-antigravity', runtimeId },
      'access-credential'
    );
    if (!raw) {
      throw new Error('Failed to load active access credential from native DPAPI store');
    }
    const cred = JSON.parse(raw);
    if (!cred?.accessToken) {
      throw new Error('Invalid or missing accessToken in native store credential');
    }
    accessToken = cred.accessToken;
  }

  const report = await shipAntigravityExchanges(parseResult, {
    apiUrl,
    authToken: accessToken,
    stateStore,
    dryRun,
    expectedConversationId: options.conversationId,
  });

  report.evictionWarning = evictionWarning;
  if (sourceDbSha256) {
    report.sourceDbSha256 = sourceDbSha256;
  }

  console.log(
    `[shipper] Report: Shipped=${report.shipped}, Simulated=${report.simulated}, Skipped=${report.skipped}, Failed=${report.failed}, PendingUnpaired=${report.pendingUnpaired}, Unresolved=${report.unresolvedCount}, OpenTrailing=${report.isOpenTrailing}, Cursor=${report.lastAcknowledgedStepIndex}`
  );
  if (report.errors.length > 0) {
    console.error(`[shipper] Errors:`, report.errors);
  }

  return report;
}

if (isDirectCliInvocation('antigravity-journal-shipper.ts')) {
  try {
    const opts = parseShipperArgs(process.argv.slice(2));
    runShipper(opts)
      .then(report => {
        if (report.failed > 0) {
          process.exitCode = 1;
        }
      })
      .catch(err => {
        console.error('[shipper] Fatal error:', err.message);
        process.exitCode = 1;
      });
  } catch (err: any) {
    console.error('[shipper] Invalid usage:', err.message);
    process.exitCode = 64;
  }
}
