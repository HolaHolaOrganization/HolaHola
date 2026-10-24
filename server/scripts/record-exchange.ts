/**
 * record-exchange.ts
 *
 * Records a David↔Luca chat exchange into .local/.chat_capture so the autosave
 * worker routes it to conversation_memories and (when live mode is on) to the
 * rolling episode .md.
 *
 * This is the standard end-of-turn capture path for Luca [Replit] sessions.
 * Replit does not expose a live chat stream API, so capture must be triggered
 * explicitly by the agent at the end of each turn.
 *
 * USAGE — all 4 channels
 * ----------------------
 * The Luca [Replit] output has 4 channels: feeling (felt), thinking, moment,
 * and the main response. Every capture must explicitly supply all four slots so
 * the episode cannot silently retain only the surface response.
 *
 *   cat > /tmp/david_turn.txt << 'ENDDAVID'
 *   David's exact message text
 *   ENDDAVID
 *
 *   cat > /tmp/luca_feeling.txt << 'ENDFEELING'
 *   [felt]: What this feels like from inside...
 *   ENDFEELING
 *
 *   cat > /tmp/luca_thinking.txt << 'ENDTHINKING'
 *   [thinking]: What is still turning over...
 *   ENDTHINKING
 *
 *   cat > /tmp/luca_moment.txt << 'ENDMOMENT'
 *   [moment]: If something landed as significant...
 *   ENDMOMENT
 *
 *   cat > /tmp/luca_turn.txt << 'ENDLUCA'
 *   Main response text
 *   ENDLUCA
 *
 *   npx tsx server/scripts/record-exchange.ts \
 *     --david-file    /tmp/david_turn.txt \
 *     --feeling-file  /tmp/luca_feeling.txt \
 *     --thinking-file /tmp/luca_thinking.txt \
 *     --moment-file   /tmp/luca_moment.txt \
 *     --luca-file     /tmp/luca_turn.txt
 *
 * Each inner-life slot is required. If a channel genuinely has no authored
 * content, use its explicit-empty flag (`--felt-empty`, `--thinking-empty`, or
 * `--moment-empty`) rather than omitting it. The canonical record will show
 * `[intentionally empty]`, an acknowledgement of absence rather than invented
 * inner-life text.
 * During live mode this composed turn is the ONLY episode route for these
 * channels. The persistent .luca_reflection/.luca_question/.luca_moment files
 * still save personal memory and readiness status, but do not append a second
 * episode copy.
 * The composed Luca turn appears in the episode as:
 *
 *   **LUCA [Replit]:** [felt]: ... or [intentionally empty]
 *
 *   [thinking]: ...
 *
 *   [moment]: ...
 *
 *   Main response text
 *
 * WHAT HAPPENS NEXT
 * -----------------
 * The autosave worker polls .chat_capture every ~20s. This command waits for
 * its acknowledgement by default, then confirms that:
 *   1. Insert a conversation_memories row (importance=8, tags: david-luca-chat, verbatim)
 *   2. If .local/.episode_live exists, append both turns to the rolling episode .md
 *      formatted as **David:** and **LUCA [Replit]:**
 *
 * It exits non-zero when the cursor does not advance within 35 seconds. That
 * is an explicit capture failure, never a successful-looking empty backlog.
 * `--no-wait` is an emergency escape hatch only; `--wait-ms <ms>` adjusts the
 * acknowledgement timeout for a known slow startup.
 *
 * SELF-CHECK MODE
 * ---------------
 *   npx tsx server/scripts/record-exchange.ts --self-check
 *
 * Writes a canary exchange, reads it back via parseChatCaptureFromOffset, and
 * confirms both turns are present. Exits non-zero if anything is wrong.
 */

import { readFileSync, existsSync, statSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { isDirectCliInvocation } from './lib/cli-entrypoint';
import {
  appendChatCaptureTurn,
  CHAT_CAPTURE_ACK_DIR,
  CHAT_CAPTURE_ACK_CURSOR_PATH,
  CHAT_CAPTURE_ACK_PATH,
  CHAT_CAPTURE_CURSOR_PATH,
  CHAT_CAPTURE_PATH,
  WORKSPACE,
  parseChatCaptureFromOffset,
} from '../services/transcript-parser';
import {
  appendCanonicalConversationExchange,
  type CanonicalConversationSource,
  writeSynchronizedCanonicalCaptureReceipt,
} from '../services/canonical-conversation-capture';
import {
  buildCanonicalInnerLifeTurnIntent,
  CANONICAL_INNER_LIFE_INTENT_DIR,
  composeLucaTurn,
  pruneCapturedCanonicalInnerLifeIntents,
  type CanonicalInnerLifeTurnIntent,
  type FourChannelLucaTurn,
} from '../services/inner-life-capture';
import { inspectCaptureWorkspace, workspaceResolution } from '../services/workspace-root';
import { getAgentAuthHeaders } from '../services/agent-auth';
export { composeLucaTurn } from '../services/inner-life-capture';

const DEFAULT_ACK_TIMEOUT_MS = 35_000;
const ACK_POLL_MS = 250;

interface CaptureAcknowledgement {
  turnId: string;
  targetByteOffset: number;
  createdAtMs: number;
  source?: CanonicalConversationSource;
  status: 'pending' | 'acknowledged' | 'failed' | 'audited-invalid-destination';
  acknowledgedAtMs?: number;
  failedAtMs?: number;
  failureReason?: string;
}

function writeCaptureAcknowledgement(receipt: CaptureAcknowledgement): void {
  writeSynchronizedCanonicalCaptureReceipt({
    ...receipt,
    source: receipt.source ?? 'replit',
  });
}

function readCursorOffset(cursorPath = CHAT_CAPTURE_ACK_CURSOR_PATH): number {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath, 'utf-8')) as { byteOffset?: unknown };
    return typeof parsed.byteOffset === 'number' && Number.isFinite(parsed.byteOffset)
      ? parsed.byteOffset
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Wait for the durable cursor acknowledgement of a just-written capture.
 *
 * In live mode checkChatCapture advances this cursor only after the
 * conversation-memory insert AND DB-first episode append both succeed.
 * Therefore reaching targetByteOffset is a real canonical acknowledgement,
 * not merely proof that .chat_capture received local bytes.
 */
export async function waitForCaptureAcknowledgement(
  targetByteOffset: number,
  options: {
    cursorPath?: string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<{ cursorOffset: number; waitedMs: number }> {
  const cursorPath = options.cursorPath ?? CHAT_CAPTURE_ACK_CURSOR_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? ACK_POLL_MS;
  const startedAt = Date.now();
  let cursorOffset = readCursorOffset(cursorPath);

  while (cursorOffset < targetByteOffset && Date.now() - startedAt < timeoutMs) {
    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    cursorOffset = readCursorOffset(cursorPath);
  }

  if (cursorOffset < targetByteOffset) {
    throw new Error(
      `Capture acknowledgement timed out after ${timeoutMs}ms: ` +
      `cursor=${cursorOffset}, expected at least ${targetByteOffset}. ` +
      'The exchange remains pending in .chat_capture and must not be treated as recorded.',
    );
  }

  return { cursorOffset, waitedMs: Date.now() - startedAt };
}

export function isRemoteCaptureAcknowledged(
  health: any,
  targetByteOffset: number,
): boolean {
  const acknowledgementCursorByteOffset = health?.capture?.acknowledgementCursorByteOffset;
  return health?.capture?.worker?.armed === true
    && typeof acknowledgementCursorByteOffset === 'number'
    && acknowledgementCursorByteOffset >= targetByteOffset;
}

function parseAcknowledgementTimeout(args: string[]): number {
  const index = args.indexOf('--wait-ms');
  if (index === -1) return DEFAULT_ACK_TIMEOUT_MS;
  const raw = args[index + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error('--wait-ms must be an integer between 1000 and 120000');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Self-check mode
// ---------------------------------------------------------------------------
async function runSelfCheck(): Promise<void> {
  const ts = Date.now();
  const canaryDavid = `[record-exchange self-check] David canary ${ts}`;
  const canaryLuca  = `[record-exchange self-check] Luca canary ${ts}`;
  const testCapturePath = join(
    WORKSPACE,
    '.local',
    `record-exchange-self-check-${process.pid}-${ts}.capture`,
  );

  // Never write CI canaries into the live stream: autosave could race the
  // assertion and project synthetic turns into the rolling episode.
  const fileSizeBefore = 0;

  appendChatCaptureTurn('David', canaryDavid, testCapturePath);
  appendChatCaptureTurn('Luca Replit', canaryLuca, testCapturePath);

  const fileSizeAfter = existsSync(testCapturePath)
    ? statSync(testCapturePath).size
    : 0;

  if (fileSizeAfter <= fileSizeBefore) {
    console.error('[record-exchange --self-check] FAIL: file did not grow after appending canary turns');
    process.exit(1);
  }

  // Parse from the pre-write offset to find our canary turns
  const { turns } = parseChatCaptureFromOffset(testCapturePath, 0);

  const davidTurn = turns.find(t => t.text === canaryDavid);
  const lucaTurn  = turns.find(t => t.text === canaryLuca);

  if (!davidTurn) {
    console.error('[record-exchange --self-check] FAIL: David canary turn not found after parse');
    process.exit(1);
  }
  if (!lucaTurn) {
    console.error('[record-exchange --self-check] FAIL: Luca canary turn not found after parse');
    process.exit(1);
  }
  if (davidTurn.speaker !== 'DAVID') {
    console.error(`[record-exchange --self-check] FAIL: David turn speaker="${davidTurn.speaker}" expected "DAVID"`);
    process.exit(1);
  }
  // Luca Replit normalises to LUCA REPLIT or similar — accept any non-DAVID value
  if (davidTurn.speaker === lucaTurn.speaker) {
    console.error('[record-exchange --self-check] FAIL: David and Luca turns have the same speaker label');
    process.exit(1);
  }

  console.log('[record-exchange --self-check] PASS — David + Luca turns written and parsed correctly');
  console.log(`  File grew: ${fileSizeBefore}B → ${fileSizeAfter}B`);
  console.log(`  David turn speaker: ${davidTurn.speaker}`);
  console.log(`  Luca turn speaker:  ${lucaTurn.speaker}`);
  unlinkSync(testCapturePath);
  console.log('  Hermetic capture removed; the live cursor and episode were untouched.');
}

async function runSelfCheck4ch(): Promise<void> {
  const ts = Date.now();
  const canaryDavid   = `[record-exchange 4ch self-check] David canary ${ts}`;
  // Canaries are intentionally raw (no label prefix) so composeLucaTurn is
  // proven to ADD the canonical [felt]/[thinking]/[moment] labels, not just
  // pass pre-labelled text through unchanged.
  const canaryFeeling  = `4ch canary feeling raw ${ts}`;
  const canaryThinking = `4ch canary thinking raw ${ts}`;
  const canaryMoment   = `4ch canary moment raw ${ts}`;
  const canaryMain     = `4ch canary main response ${ts}`;
  const testCapturePath = join(
    WORKSPACE,
    '.local',
    `record-exchange-4ch-self-check-${process.pid}-${ts}.capture`,
  );

  // --- Build the exact expected composed string ---
  // composeLucaTurn should add the canonical label prefix to each raw canary value
  // and join all four channels with double-newlines in felt→thinking→moment→main order.
  const expectedComposed =
    `[felt]: ${canaryFeeling}\n\n` +
    `[thinking]: ${canaryThinking}\n\n` +
    `[moment]: ${canaryMoment}\n\n` +
    canaryMain;

  const composed = composeLucaTurn({
    feeling:  canaryFeeling,
    thinking: canaryThinking,
    moment:   canaryMoment,
    main:     canaryMain,
  });

  // --- Exact equality: proves labels were added and order is correct ---
  if (composed !== expectedComposed) {
    console.error('[record-exchange --self-check-4ch] FAIL: composed turn does not match expected string');
    console.error(`  Expected (${expectedComposed.length} chars):\n${expectedComposed}`);
    console.error(`  Got     (${composed.length} chars):\n${composed}`);
    process.exit(1);
  }

  // --- Per-channel pairing: each label must be immediately followed by its canary ---
  const feltPair     = `[felt]: ${canaryFeeling}`;
  const thinkingPair = `[thinking]: ${canaryThinking}`;
  const momentPair   = `[moment]: ${canaryMoment}`;

  for (const [label, pair] of [['[felt]', feltPair], ['[thinking]', thinkingPair], ['[moment]', momentPair]] as const) {
    if (!composed.includes(pair)) {
      console.error(`[record-exchange --self-check-4ch] FAIL: ${label} not paired with its canary value`);
      console.error(`  Expected to find: "${pair}"`);
      process.exit(1);
    }
  }

  // --- Verify order of channel pairs in the composed string ---
  const feltIdx     = composed.indexOf(feltPair);
  const thinkingIdx = composed.indexOf(thinkingPair);
  const momentIdx   = composed.indexOf(momentPair);
  const mainIdx     = composed.indexOf(canaryMain);

  if (!(feltIdx < thinkingIdx && thinkingIdx < momentIdx && momentIdx < mainIdx)) {
    console.error(`[record-exchange --self-check-4ch] FAIL: channels out of order — felt@${feltIdx} thinking@${thinkingIdx} moment@${momentIdx} main@${mainIdx}`);
    process.exit(1);
  }

  // --- Round-trip through chat capture ---
  const fileSizeBefore = 0;

  appendChatCaptureTurn('David', canaryDavid, testCapturePath);
  appendChatCaptureTurn('Luca Replit', composed, testCapturePath);

  const fileSizeAfter = existsSync(testCapturePath) ? statSync(testCapturePath).size : 0;

  if (fileSizeAfter <= fileSizeBefore) {
    console.error('[record-exchange --self-check-4ch] FAIL: file did not grow after appending canary turns');
    process.exit(1);
  }

  const { turns } = parseChatCaptureFromOffset(testCapturePath, 0);

  const lucaTurn = turns.find(t => t.text.includes(canaryMain));
  if (!lucaTurn) {
    console.error('[record-exchange --self-check-4ch] FAIL: composed Luca turn not found after parse');
    process.exit(1);
  }

  // Each label must be paired with its canary value in the parsed round-trip text
  for (const [label, pair] of [['[felt]', feltPair], ['[thinking]', thinkingPair], ['[moment]', momentPair]] as const) {
    if (!lucaTurn.text.includes(pair)) {
      console.error(`[record-exchange --self-check-4ch] FAIL: ${label}+canary pair missing from parsed Luca turn`);
      console.error(`  Expected to find: "${pair}"`);
      process.exit(1);
    }
  }

  console.log('[record-exchange --self-check-4ch] PASS — 4-channel composition verified');
  console.log(`  Expected and composed strings match exactly (${composed.length} chars)`);
  console.log(`  Channel order: [felt]@${feltIdx} < [thinking]@${thinkingIdx} < [moment]@${momentIdx} < main@${mainIdx}`);
  console.log(`  Round-trip: file grew ${fileSizeBefore}B → ${fileSizeAfter}B, all label+canary pairs present`);
  unlinkSync(testCapturePath);
  console.log('  Hermetic capture removed; the live cursor and episode were untouched.');
}

function runCapturePreflight(): void {
  const inspection = inspectCaptureWorkspace();
  const result = {
    ok: inspection.localDirectoryPresent && inspection.localDirectoryWritable,
    workspaceSource: inspection.rootSource,
    localDirectoryPresent: inspection.localDirectoryPresent,
    localDirectoryWritable: inspection.localDirectoryWritable,
  };
  console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(
      'Canonical capture preflight failed: configure HOLAHOLA_WORKSPACE_ROOT ' +
      'to the HolaHola project root and ensure its .local directory is writable.',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readRequiredChannel(
  flag: string,
  emptyFlag: string,
  args: string[],
): string {
  const idx = args.indexOf(flag);
  const explicitlyEmpty = args.includes(emptyFlag);
  if (idx !== -1 && explicitlyEmpty) {
    console.error(`[record-exchange] ERROR: use either ${flag} or ${emptyFlag}, not both`);
    process.exit(1);
  }
  if (explicitlyEmpty) return '';
  if (idx === -1) {
    console.error(`[record-exchange] ERROR: ${flag} is required; use ${emptyFlag} only when that channel is intentionally empty`);
    process.exit(1);
  }
  const filePath = args[idx + 1];
  if (!filePath) {
    console.error(`[record-exchange] ERROR: ${flag} requires a file path argument`);
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    console.error(`[record-exchange] ERROR: ${flag} file not found: ${filePath}`);
    process.exit(1);
  }
  const text = readFileSync(filePath, 'utf-8').trimEnd();
  if (!text) {
    console.error(`[record-exchange] ERROR: ${flag} file is empty: ${filePath}; use ${emptyFlag} to acknowledge an intentionally empty channel`);
    process.exit(1);
  }
  return text;
}

export function writeCanonicalIntent(
  opts: {
    feeling?: string | null;
    thinking?: string | null;
    moment?: string | null;
    main: string;
    turnId?: string;
  },
  pathOverride?: string,
): { intent: CanonicalInnerLifeTurnIntent; path: string } {
  const intent = buildCanonicalInnerLifeTurnIntent(opts, Date.now(), opts.turnId);
  const intentPath = pathOverride ?? join(
    WORKSPACE,
    '.local',
    CANONICAL_INNER_LIFE_INTENT_DIR,
    `${intent.turnId}.json`,
  );
  mkdirSync(dirname(intentPath), { recursive: true });
  // Retention is intentionally run before each new handoff, not just when a
  // trigger happens to resolve. Captured records live for 14 days; pending
  // handoffs are never eligible for cleanup.
  pruneCapturedCanonicalInnerLifeIntents(dirname(intentPath));
  const tempPath = `${intentPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(intent), 'utf8');
  renameSync(tempPath, intentPath);
  return { intent, path: intentPath };
}

export function markCanonicalIntentCaptured(
  handoff: { intent: CanonicalInnerLifeTurnIntent; path: string },
): void {
  const tempPath = `${handoff.path}.tmp-${process.pid}`;
  writeFileSync(
    tempPath,
    JSON.stringify({ ...handoff.intent, status: 'captured' }),
    'utf8',
  );
  renameSync(tempPath, handoff.path);
}

async function persistRecordExchangeRawCapture(
  turnId: string,
  lucaSourceText: string,
  lucaSourceBytes: Buffer,
  options: {
    david?: { text: string; bytes: Buffer };
    mode: 'exchange' | 'luca-only';
  },
): Promise<{
  streamId: string;
  sourceKey: string;
  eventIds: string[];
  eventCount: number;
  byteCount: number;
  aggregateSha256: string;
}> {
  const events = options.david === undefined
    ? [{
        sequenceNumber: 1,
        eventType: 'luca-output',
        payloadText: lucaSourceText,
        payloadBytes: lucaSourceBytes,
        idempotencyKey: 'luca-output',
      }]
    : [
        {
          sequenceNumber: 1,
          eventType: 'david-message',
          payloadText: options.david.text,
          payloadBytes: options.david.bytes,
          idempotencyKey: 'david-message',
        },
        {
          sequenceNumber: 2,
          eventType: 'luca-output',
          payloadText: lucaSourceText,
          payloadBytes: lucaSourceBytes,
          idempotencyKey: 'luca-output',
        },
      ];
  const { persistRawReplitCapture } = await import('../services/raw-replit-capture');
  return persistRawReplitCapture({
    sourceKey: `record-exchange:${turnId}`,
    sourceRoute: 'record-exchange',
    events,
    metadata: {
      canonicalTurnId: turnId,
      mode: options.mode,
      collectorCapability: 'workspace-visible-record-exchange',
    },
  });
}

async function linkRecordExchangeRawCapture(
  input: Parameters<(typeof import('../services/raw-replit-capture'))['linkRawReplitCaptureToProjection']>[0],
): Promise<void> {
  const { linkRawReplitCaptureToProjection } = await import('../services/raw-replit-capture');
  await linkRawReplitCaptureToProjection(input);
}

async function closeRecordExchangeDbConnections(): Promise<void> {
  const { closeDbConnections } = await import('../db');
  await closeDbConnections();
}

const DEFAULT_REMOTE_URL = 'https://getholahola.com';
const REMOTE_ACK_POLL_MS = 1_000;

function remoteUrlFromArgs(args: string[]): string | null {
  const idx = args.indexOf('--remote');
  if (idx === -1) return null;
  const next = args[idx + 1];
  if (next && !next.startsWith('--')) return next.replace(/\/+$/, '');
  return (process.env.HOLAHOLA_REMOTE_URL?.trim() || DEFAULT_REMOTE_URL).replace(/\/+$/, '');
}

/**
 * Same contract as runClaudeCodeCli, but for a caller with no co-located
 * autosave worker (e.g. this Windows checkout): POST to the already-running
 * server's own intake endpoint instead of writing a local .chat_capture file
 * that nothing here would ever drain. Reuses the exact same endpoint the
 * server calls in-process -- no new capture path, just a remote transport
 * for the existing one.
 */
async function runClaudeCodeRemoteCli(
  args: string[],
  remoteUrl: string,
  acknowledgementTimeoutMs: number,
  waitForAcknowledgement: boolean,
): Promise<void> {
  const davidIdx = args.indexOf('--david-file');
  const assistantIdx = args.indexOf('--assistant-file');
  if (davidIdx === -1 || assistantIdx === -1) {
    throw new Error(
      'Claude Code remote usage: npx tsx server/scripts/record-exchange.ts --source claude-code --remote [url] ' +
       '--david-file <path> --assistant-file <path> --turn-id <stable-id> [--wait-ms <1000-120000>|--no-wait]',
    );
  }
  const davidFile = args[davidIdx + 1];
  const assistantFile = args[assistantIdx + 1];
  if (!davidFile || !existsSync(davidFile)) throw new Error(`--david-file not found: ${davidFile ?? ''}`);
  if (!assistantFile || !existsSync(assistantFile)) throw new Error(`--assistant-file not found: ${assistantFile ?? ''}`);
  const davidText = readFileSync(davidFile, 'utf8').trimEnd();
  const assistantText = readFileSync(assistantFile, 'utf8').trimEnd();
  if (!davidText || !assistantText) throw new Error('Claude Code user and assistant files must both be non-empty');

  const authHeaders = getAgentAuthHeaders('luca-claude-code');
  if (!authHeaders) throw new Error('Luca [Claude Code] coordination credential is not set -- required to call the remote canonical-conversation-exchange endpoint');

  const turnId = requiredTurnId(args);
  console.log(`[record-exchange] Posting to ${remoteUrl}/api/internal/canonical-conversation-exchange (turn=${turnId})...`);

  const postController = new AbortController();
  const postTimeout = setTimeout(() => postController.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${remoteUrl}/api/internal/canonical-conversation-exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ source: 'claude-code', userText: davidText, assistantText, turnId }),
      signal: postController.signal,
    });
  } catch (error: any) {
    throw new Error(`Remote POST failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(postTimeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = `Remote endpoint rejected the exchange (${response.status}): ${body?.error ?? JSON.stringify(body)}`;
    if (isChangedContentRejection(response.status, body?.error)) throw new ChangedContentRejection(message);
    throw new Error(message);
  }
  const targetByteOffset: number | undefined = body?.receipt?.targetByteOffset;
  if (typeof targetByteOffset !== 'number') {
    throw new Error(`Remote endpoint accepted the exchange but returned no receipt.targetByteOffset: ${JSON.stringify(body)}`);
  }
  console.log(
    `[record-exchange] Remote exchange ${body.appendedSpeakers?.length === 0 ? 'retry' : 'queued'} ` +
    `(${(body.appendedSpeakers ?? []).join('+') || 'no duplicate bytes written'}; turn=${turnId}, targetByteOffset=${targetByteOffset}).`,
  );

  if (!waitForAcknowledgement) {
    console.warn(`  ⚠️ Remote acknowledgement intentionally skipped — pending receipt targets cursor ${targetByteOffset} on ${remoteUrl}.`);
    return;
  }

  console.log(`  Waiting for remote canonical acknowledgement (cursor ≥ ${targetByteOffset}, timeout ${acknowledgementTimeoutMs}ms)…`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < acknowledgementTimeoutMs) {
    const healthController = new AbortController();
    const healthTimeout = setTimeout(() => healthController.abort(), 10_000);
    try {
      const healthResponse = await fetch(`${remoteUrl}/api/internal/canonical-conversation-health`, {
        headers: authHeaders,
        signal: healthController.signal,
      });
      const health = await healthResponse.json().catch(() => ({}));
      const acknowledgementCursorByteOffset: number | undefined =
        health?.capture?.acknowledgementCursorByteOffset;
      if (isRemoteCaptureAcknowledged(health, targetByteOffset)) {
        console.log(
          `  ✓ Remote canonical acknowledgement received (${Date.now() - startedAt}ms; acknowledgementCursor=${acknowledgementCursorByteOffset}). ` +
          'DB and live episode effects completed on the remote server before this cursor advanced.',
        );
        return;
      }
    } catch {
      // Transient network hiccup during polling -- keep retrying until the timeout.
    } finally {
      clearTimeout(healthTimeout);
    }
    await new Promise(resolve => setTimeout(resolve, REMOTE_ACK_POLL_MS));
  }
  throw new Error(
    `Remote capture acknowledgement timed out after ${acknowledgementTimeoutMs}ms waiting for cursor ≥ ${targetByteOffset} ` +
    `on ${remoteUrl}. The exchange remains pending on that server and must not be treated as recorded.`,
  );
}

/**
 * The one permanent remote outcome: the canonical record already holds
 * different text under this turn id, so retrying the same version can never
 * succeed. The CLI exits with CHANGED_CONTENT_REJECTION_EXIT for it, so a
 * caller (the Claude Code Stop hook) can keep the version aside instead of
 * retrying it forever. Every other failure, including other 409s (busy,
 * source mismatch), exits 1 and stays retryable.
 */
export const CHANGED_CONTENT_REJECTION_EXIT = 3;
const CHANGED_CONTENT_ERROR = /^canonical conversation turn [A-Za-z0-9-]+ already has different (?:user|assistant) text$/;

export class ChangedContentRejection extends Error {}

export function isChangedContentRejection(status: number, error: unknown): boolean {
  return status === 409 && typeof error === 'string' && CHANGED_CONTENT_ERROR.test(error);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const isMain = isDirectCliInvocation('record-exchange.ts');
const args = isMain ? process.argv.slice(2) : [];

if (!isMain) {
  // Import-only use (tests and shared composition); do not execute the CLI.
} else if (args.includes('--self-check-4ch')) {
  runSelfCheck4ch().catch(e => { console.error(e); process.exit(1); });
} else if (args.includes('--self-check')) {
  runSelfCheck().catch(e => { console.error(e); process.exit(1); });
} else if (args.includes('--preflight')) {
  runCapturePreflight();
} else {
  runCli(args).catch(error => {
    console.error(`[record-exchange] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof ChangedContentRejection ? CHANGED_CONTENT_REJECTION_EXIT : 1);
  });
}

function sourceFromArgs(args: string[]): CanonicalConversationSource {
  const idx = args.indexOf('--source');
  if (idx === -1) return 'replit';
  const source = args[idx + 1];
  if (source !== 'replit' && source !== 'claude-code') {
    throw new Error('--source must be "replit" or "claude-code"');
  }
  return source;
}

function requiredTurnId(args: string[]): string {
  const idx = args.indexOf('--turn-id');
  if (idx === -1) throw new Error('--turn-id is required and must be retained for acknowledgement retries');
  const turnId = args[idx + 1]?.trim();
  if (!turnId || !/^[A-Za-z0-9-]+$/.test(turnId)) {
    throw new Error('--turn-id must contain only letters, digits, and hyphens');
  }
  return turnId;
}

async function runClaudeCodeCli(
  args: string[],
  acknowledgementTimeoutMs: number,
  waitForAcknowledgement: boolean,
): Promise<void> {
  const davidIdx = args.indexOf('--david-file');
  const assistantIdx = args.indexOf('--assistant-file');
  if (davidIdx === -1 || assistantIdx === -1) {
    throw new Error(
      'Claude Code usage: npx tsx server/scripts/record-exchange.ts --source claude-code ' +
       '--david-file <path> --assistant-file <path> --turn-id <stable-id> [--wait-ms <1000-120000>|--no-wait]',
    );
  }
  const davidFile = args[davidIdx + 1];
  const assistantFile = args[assistantIdx + 1];
  if (!davidFile || !existsSync(davidFile)) throw new Error(`--david-file not found: ${davidFile ?? ''}`);
  if (!assistantFile || !existsSync(assistantFile)) throw new Error(`--assistant-file not found: ${assistantFile ?? ''}`);
  const davidText = readFileSync(davidFile, 'utf8').trimEnd();
  const assistantText = readFileSync(assistantFile, 'utf8').trimEnd();
  if (!davidText || !assistantText) throw new Error('Claude Code user and assistant files must both be non-empty');

  const capture = appendCanonicalConversationExchange({
    userText: davidText,
    assistantText,
    source: 'claude-code',
    turnId: requiredTurnId(args),
  });
  const receipt: CaptureAcknowledgement = {
    turnId: capture.turnId,
    targetByteOffset: capture.targetByteOffset,
    createdAtMs: Date.now(),
    source: 'claude-code',
    status: 'pending',
  };
  writeCaptureAcknowledgement(receipt);
  console.log(
    `[record-exchange] Claude Code ${capture.appendedSpeakers.length === 0 ? 'retry' : 'exchange'} ` +
    `queued (${capture.appendedSpeakers.join('+') || 'no duplicate bytes written'}; turn=${capture.turnId}).`,
  );
  await acknowledgeCapture(receipt, waitForAcknowledgement, acknowledgementTimeoutMs);
  await closeRecordExchangeDbConnections();
}

async function runCli(args: string[]): Promise<void> {
  const lucaOnly  = args.includes('--luca-only');
  const davidIdx  = args.indexOf('--david-file');
  const lucaIdx   = args.indexOf('--luca-file');
  const waitForAcknowledgement = !args.includes('--no-wait');
  const acknowledgementTimeoutMs = parseAcknowledgementTimeout(args);
  const source = sourceFromArgs(args);
  if (source === 'claude-code') {
    if (lucaOnly) throw new Error('--luca-only is only valid for source replit');
    const remoteUrl = remoteUrlFromArgs(args);
    if (remoteUrl) {
      await runClaudeCodeRemoteCli(args, remoteUrl, acknowledgementTimeoutMs, waitForAcknowledgement);
    } else {
      await runClaudeCodeCli(args, acknowledgementTimeoutMs, waitForAcknowledgement);
    }
    return;
  }
  const requestedTurnId = requiredTurnId(args);

  // --luca-only: David's turn is already captured by the normal pipeline;
  // only write Luca's channels to avoid double-writing David's side.
  if (!lucaOnly && (davidIdx === -1 || lucaIdx === -1)) {
    console.error('Usage: npx tsx server/scripts/record-exchange.ts --david-file <path> --luca-file <path> --turn-id <stable-id> (--feeling-file <path>|--felt-empty) (--thinking-file <path>|--thinking-empty) (--moment-file <path>|--moment-empty) [--wait-ms <1000-120000>|--no-wait]');
    console.error('       npx tsx server/scripts/record-exchange.ts --luca-only --luca-file <path> (--feeling-file <path>|--felt-empty) (--thinking-file <path>|--thinking-empty) (--moment-file <path>|--moment-empty) [--wait-ms <1000-120000>|--no-wait]');
    console.error('       npx tsx server/scripts/record-exchange.ts --self-check');
    process.exit(1);
  }
  if (lucaOnly && lucaIdx === -1) {
    console.error('[record-exchange] ERROR: --luca-only requires --luca-file');
    process.exit(1);
  }

  const lucaFile  = args[lucaIdx  + 1];

  if (!existsSync(lucaFile)) {
    console.error(`[record-exchange] ERROR: --luca-file not found: ${lucaFile}`);
    process.exit(1);
  }

  const lucaMainBytes = readFileSync(lucaFile);
  const lucaMain = lucaMainBytes.toString('utf8').trimEnd();
  const lucaFeeling = readRequiredChannel('--feeling-file',  '--felt-empty',     args);
  const lucaThink   = readRequiredChannel('--thinking-file', '--thinking-empty', args);
  const lucaMoment  = readRequiredChannel('--moment-file',   '--moment-empty',   args);

  if (!lucaMain) {
    console.error('[record-exchange] ERROR: --luca-file is empty');
    process.exit(1);
  }

  const lucaChannels: FourChannelLucaTurn = {
    feeling:  lucaFeeling,
    thinking: lucaThink,
    moment:   lucaMoment,
    main:     lucaMain,
  };
  const lucaText = composeLucaTurn(lucaChannels);

  const sizeBefore = existsSync(CHAT_CAPTURE_PATH) ? statSync(CHAT_CAPTURE_PATH).size : 0;

  if (!lucaOnly) {
    const davidFile = args[davidIdx + 1];
    if (!existsSync(davidFile)) {
      console.error(`[record-exchange] ERROR: --david-file not found: ${davidFile}`);
      process.exit(1);
    }
    const davidBytes = readFileSync(davidFile);
    const davidText = davidBytes.toString('utf8').trimEnd();
    if (!davidText) {
      console.error('[record-exchange] ERROR: --david-file is empty');
      process.exit(1);
    }
    // Durable handoff written before the Luca chat-capture turn. Trigger
    // watchers use it to wait for this exact canonical turn rather than
    // racing a second direct episode append.
    const handoff = writeCanonicalIntent({ ...lucaChannels, turnId: requestedTurnId });
    // The exact source events must be durable before the semantic .chat_capture
    // projection is allowed to exist. Failure here leaves no new chat-capture
    // bytes and therefore cannot produce a false canonical acknowledgement.
    const rawCapture = await persistRecordExchangeRawCapture(
      handoff.intent.turnId,
      lucaText,
      Buffer.from(lucaText, 'utf8'),
      {
      david: { text: davidBytes.toString('utf8'), bytes: davidBytes },
      mode: 'exchange',
      },
    );
    const capture = appendCanonicalConversationExchange({
      userText: davidText,
      assistantText: lucaText,
      source: 'replit',
      turnId: handoff.intent.turnId,
    });
    const sizeFinal = capture.targetByteOffset;
    await linkRecordExchangeRawCapture({
      capture: rawCapture,
      targetKind: 'chat-capture-range',
      targetKey: handoff.intent.turnId,
      disposition: 'dialogue',
      captureStartByteOffset: sizeBefore,
      captureEndByteOffset: sizeFinal,
      metadata: { canonicalTurnId: handoff.intent.turnId },
    });
    markCanonicalIntentCaptured(handoff);
    const receipt: CaptureAcknowledgement = {
      turnId: handoff.intent.turnId,
      targetByteOffset: sizeFinal,
      createdAtMs: Date.now(),
      source: 'replit',
      status: 'pending',
    };
    writeCaptureAcknowledgement(receipt);
    const channels = ['felt', 'thinking', 'moment', 'main'];
    console.log(`[record-exchange] ✓ Exchange written to .chat_capture (${sizeBefore}B → ${sizeFinal}B)`);
    console.log(`  David: ${davidText.length} chars`);
    console.log(`  Luca:  ${lucaText.length} chars (channels: ${channels.join(', ')})`);
    await acknowledgeCapture(receipt, waitForAcknowledgement, acknowledgementTimeoutMs);
    await closeRecordExchangeDbConnections();
  } else {
    const handoff = writeCanonicalIntent({ ...lucaChannels, turnId: requestedTurnId });
    const rawCapture = await persistRecordExchangeRawCapture(
      handoff.intent.turnId,
      lucaText,
      Buffer.from(lucaText, 'utf8'),
      { mode: 'luca-only' },
    );
    // This is a legacy continuation: David's side already exists in the normal
    // pipeline. Do not attach the complete-exchange capture ID to a one-sided
    // block, or autosave would correctly quarantine it as a malformed exchange.
    // The raw intent and durable receipt still use the stable handoff ID.
    appendChatCaptureTurn('Luca Replit', lucaText, undefined, undefined, 'replit');
    const sizeAfter = existsSync(CHAT_CAPTURE_PATH) ? statSync(CHAT_CAPTURE_PATH).size : 0;
    await linkRecordExchangeRawCapture({
      capture: rawCapture,
      targetKind: 'chat-capture-range',
      targetKey: handoff.intent.turnId,
      disposition: 'dialogue',
      captureStartByteOffset: sizeBefore,
      captureEndByteOffset: sizeAfter,
      metadata: { canonicalTurnId: handoff.intent.turnId },
    });
    markCanonicalIntentCaptured(handoff);
    const receipt: CaptureAcknowledgement = {
      turnId: handoff.intent.turnId,
      targetByteOffset: sizeAfter,
      createdAtMs: Date.now(),
      source: 'replit',
      status: 'pending',
    };
    writeCaptureAcknowledgement(receipt);
    const channels = ['felt', 'thinking', 'moment', 'main'];
    console.log(`[record-exchange] ✓ Luca turn written to .chat_capture (${sizeBefore}B → ${sizeAfter}B) [luca-only]`);
    console.log(`  Luca:  ${lucaText.length} chars (channels: ${channels.join(', ')})`);
    console.log('  David turn already captured by autosave pipeline.');
    await acknowledgeCapture(receipt, waitForAcknowledgement, acknowledgementTimeoutMs);
  await closeRecordExchangeDbConnections();
  }
}

async function acknowledgeCapture(
  receipt: CaptureAcknowledgement,
  shouldWait: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!shouldWait) {
    console.warn(
      `  ⚠️ Capture acknowledgement intentionally skipped — pending receipt targets cursor ${receipt.targetByteOffset}.`,
    );
    return;
  }

  console.log(`  Waiting for canonical acknowledgement (cursor ≥ ${receipt.targetByteOffset}, timeout ${timeoutMs}ms)…`);
  let acknowledgement: { cursorOffset: number; waitedMs: number };
  try {
    acknowledgement = await waitForCaptureAcknowledgement(
      receipt.targetByteOffset,
      { timeoutMs },
    );
  } catch (error: any) {
    writeCaptureAcknowledgement({
      ...receipt,
      status: 'failed',
      failedAtMs: Date.now(),
      failureReason: error?.message ?? String(error),
    });
    throw error;
  }
  const receiptPath = join(CHAT_CAPTURE_ACK_DIR, `${receipt.turnId}.json`);
  if (existsSync(receiptPath)) {
    const settled = JSON.parse(readFileSync(receiptPath, 'utf8')) as CaptureAcknowledgement & {
      terminalResolutionAuditPath?: string;
      evidenceDisposition?: string;
    };
    if (settled.status === 'audited-invalid-destination') {
      throw new Error(
        `Capture source was preserved, but its episode destination was terminally invalid ` +
        `(${settled.evidenceDisposition ?? 'audited'}). Audit: ${settled.terminalResolutionAuditPath ?? 'see capture receipt'}`,
      );
    }
  }
  writeCaptureAcknowledgement({
    ...receipt,
    status: 'acknowledged',
    acknowledgedAtMs: Date.now(),
  });
  console.log(
    `  ✓ Canonical acknowledgement received (${acknowledgement.waitedMs}ms; cursor=${acknowledgement.cursorOffset}). ` +
    'DB and live episode effects completed before this cursor advanced.',
  );
}
