/**
 * antigravity-journal-shipper.ts
 *
 * Ships conversation turns from the local Antigravity transcript journal
 * (transcript.jsonl) into the canonical conversation intake endpoint
 * (POST /api/internal/canonical-conversation-exchange) as speaker "David [Antigravity]"
 * and "Luca [Antigravity]".
 *
 * Part B of the Antigravity adapter (founder priority; approved design 535ca04f).
 *
 * USAGE:
 *   node --import tsx server/scripts/antigravity-journal-shipper.ts \
 *     --transcript <path-to-transcript.jsonl> \
 *     --conversation-id <uuid> \
 *     [--url <apiUrl>] \
 *     [--state-dir <path>] \
 *     [--dry-run]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import {
  parseAntigravityJournal,
  ShipperStateStore,
  shipAntigravityExchanges,
} from './lib/antigravity-journal-shipper';

export interface ShipperCliOptions {
  transcriptPath: string;
  conversationId: string;
  apiUrl: string;
  stateDir: string;
  runtimeId: string;
  dryRun: boolean;
}

export function parseShipperArgs(argv: string[]): ShipperCliOptions {
  const options: Record<string, string | boolean> = {};
  const allowed = new Set(['transcript', 'conversation-id', 'url', 'state-dir', 'runtime-id', 'dry-run']);

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

  const transcriptPath = (options.transcript as string) || '';
  if (!transcriptPath) {
    throw new Error('--transcript is required');
  }

  const apiUrl = (options.url as string) || process.env.COORDINATION_API_URL || 'https://getholahola.com';
  const runtimeId = (options['runtime-id'] as string) || process.env.COORDINATION_RUNTIME_ID || 'luca-antigravity-littlenemo-observer-20261014-d523deda';
  const stateDir = (options['state-dir'] as string) || resolve('.local/antigravity-journal-shipper', conversationId);
  const dryRun = options['dry-run'] === true;

  return {
    transcriptPath: resolve(transcriptPath),
    conversationId,
    apiUrl,
    stateDir: resolve(stateDir),
    runtimeId,
    dryRun,
  };
}

export async function runShipper(options: ShipperCliOptions) {
  const stateStore = new ShipperStateStore(options.stateDir);
  const checkpoint = await stateStore.loadCheckpoint(options.conversationId);
  const afterStepIndex = checkpoint?.lastContiguousAcknowledgedStepIndex ?? -1;

  console.log(`[shipper] Reading transcript: ${options.transcriptPath}`);
  console.log(`[shipper] Conversation: ${options.conversationId} (resume after contiguous step: ${afterStepIndex})`);

  let rawFile = '';
  try {
    rawFile = await readFile(options.transcriptPath, 'utf8');
  } catch (err: any) {
    throw new Error(`Failed to read transcript file: ${err.message}`);
  }

  const lines = rawFile.split(/\r?\n/);
  const parseResult = parseAntigravityJournal(lines, options.conversationId, afterStepIndex);

  // CRITICAL: Persist all evidence to local durable disk storage IMMEDIATELY,
  // BEFORE any early returns or network calls!
  const { persistJournalEvidence } = await import('./lib/antigravity-journal-shipper');
  await persistJournalEvidence(parseResult, stateStore);

  console.log(`[shipper] Found ${parseResult.exchanges.length} complete exchange(s)`);
  if (parseResult.unresolvedTurns.length > 0) {
    console.warn(`[shipper] ${parseResult.unresolvedTurns.length} ambiguous/unresolved turn(s) held back at steps: ${parseResult.unresolvedTurns.map(t => t.stepIndex).join(', ')}`);
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
      shipped: 0,
      simulated: 0,
      skipped: parseResult.exchanges.length,
      failed: 0,
      pendingUnpaired: parseResult.unpairedUserInputs.length,
      unresolvedCount: parseResult.unresolvedTurns.length,
      isOpenTrailing: Boolean(parseResult.openTrailingTurn),
      lastAcknowledgedStepIndex: afterStepIndex,
      errors: [],
    };
  }

  // Obtain authorization credential via native DPAPI store
  console.log(`[shipper] Authenticating with native credential store (runtime: ${options.runtimeId})...`);
  const { createNativeRuntimeOnboardingStore } = await import('../services/runtime-onboarding-store');
  const store = createNativeRuntimeOnboardingStore();
  const raw = await store.get(
    { endpoint: options.apiUrl, actor: 'luca-antigravity', runtimeId: options.runtimeId },
    'access-credential'
  );
  if (!raw) {
    throw new Error('Failed to load active access credential from native DPAPI store');
  }
  const cred = JSON.parse(raw);
  if (!cred?.accessToken) {
    throw new Error('Invalid or missing accessToken in native store credential');
  }

  const report = await shipAntigravityExchanges(parseResult, {
    apiUrl: options.apiUrl,
    authToken: cred.accessToken,
    stateStore,
    dryRun: options.dryRun,
    expectedConversationId: options.conversationId,
  });

  console.log(`[shipper] Report: Shipped=${report.shipped}, Simulated=${report.simulated}, Skipped=${report.skipped}, Failed=${report.failed}, PendingUnpaired=${report.pendingUnpaired}, Unresolved=${report.unresolvedCount}, OpenTrailing=${report.isOpenTrailing}, Cursor=${report.lastAcknowledgedStepIndex}`);
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
