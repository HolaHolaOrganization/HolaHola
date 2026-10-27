import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AntigravityExchange {
  conversationId: string;
  stepIndex: number;
  turnId: string;
  userText: string;
  assistantText: string;
  createdAt: string; // Original occurrence timestamp from journal
}

export interface PendingUserInput {
  conversationId: string;
  stepIndex: number;
  turnId: string;
  userText: string;
  createdAt: string; // Original occurrence timestamp from journal
}

export interface UnresolvedTurn {
  conversationId: string;
  stepIndex: number;
  turnId: string;
  rawContent: string;
  reason: string;
  createdAt: string; // Original occurrence timestamp from journal
}

export interface OpenTrailingTurn {
  conversationId: string;
  stepIndex: number;
  turnId: string;
  userText: string;
  assistantTextSoFar: string;
  createdAt: string;
}

export interface AcceptedExchangeRecord {
  turnId: string;
  conversationId: string;
  stepIndex: number;
  sourceCreatedAt: string; // original native created_at from journal, or 'unknown'
  serverAcceptedAt: string; // client/server receipt timestamp upon durable 202 acceptance
  userText: string;
  assistantText: string;
}

export interface ParseResult {
  exchanges: AntigravityExchange[];
  unpairedUserInputs: PendingUserInput[];
  unresolvedTurns: UnresolvedTurn[];
  openTrailingTurn?: OpenTrailingTurn;
  incompleteTrailingLine?: string;
  lastProcessedStepIndex: number;
}

/**
 * Extracts visible user text from a raw USER_INPUT content string.
 * Strictly enforces ambiguity guards: exactly one opening and one closing tag.
 * Strips only the native framing newlines immediately after <USER_REQUEST>
 * and before </USER_REQUEST>, leaving internal indentation and whitespace byte-exact.
 */
export function extractAntigravityUserRequest(rawContent: string): { userText?: string; error?: string } {
  if (typeof rawContent !== 'string') {
    return { error: 'content_not_string' };
  }

  const openTag = '<USER_REQUEST>';
  const closeTag = '</USER_REQUEST>';

  const openCount = (rawContent.match(/<USER_REQUEST>/g) || []).length;
  const closeCount = (rawContent.match(/<\/USER_REQUEST>/g) || []).length;

  if (openCount === 0 || closeCount === 0) {
    return { error: 'missing_request_tags' };
  }

  if (openCount > 1 || closeCount > 1) {
    return { error: 'ambiguous_multiple_request_tags' };
  }

  const startIdx = rawContent.indexOf(openTag);
  const endIdx = rawContent.indexOf(closeTag);

  if (endIdx <= startIdx) {
    return { error: 'malformed_tag_order' };
  }

  let extracted = rawContent.slice(startIdx + openTag.length, endIdx);

  // Strip only the native envelope framing newlines
  if (extracted.startsWith('\r\n')) {
    extracted = extracted.slice(2);
  } else if (extracted.startsWith('\n')) {
    extracted = extracted.slice(1);
  }

  if (extracted.endsWith('\r\n')) {
    extracted = extracted.slice(0, -2);
  } else if (extracted.endsWith('\n')) {
    extracted = extracted.slice(0, -1);
  }

  if (!extracted) {
    return { error: 'empty_user_request' };
  }

  return { userText: extracted };
}

/**
 * Extracts visible assistant markdown response from raw PLANNER_RESPONSE content.
 * Kept byte-exact: no regex alterations, no arbitrary trimming.
 */
export function extractAntigravityAssistantText(rawContent: string): string {
  if (typeof rawContent !== 'string') return '';
  return rawContent;
}

/**
 * Parses a sequence of transcript lines from an Antigravity journal.
 * Distinguishes completed exchanges from unpaired pending user inputs and open trailing turns.
 * Fails closed on mid-file corrupted JSON.
 */
export function parseAntigravityJournal(
  lines: string[],
  conversationId: string,
  afterStepIndex = -1
): ParseResult {
  const exchanges: AntigravityExchange[] = [];
  const unpairedUserInputs: PendingUserInput[] = [];
  const unresolvedTurns: UnresolvedTurn[] = [];
  let openTrailingTurn: OpenTrailingTurn | undefined;
  let incompleteTrailingLine: string | undefined;
  let lastProcessedStepIndex = afterStepIndex;

  interface PendingTurn {
    stepIndex: number;
    turnId: string;
    userText: string;
    createdAt: string;
    assistantParts: string[];
  }

  let currentTurn: PendingTurn | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;

    let record: any;
    try {
      record = JSON.parse(rawLine);
    } catch (err: any) {
      // If this is the last line in the input chunk, treat it as an incomplete trailing line.
      if (i === lines.length - 1) {
        incompleteTrailingLine = rawLine;
        break;
      }
      // Mid-file corrupted line fails closed!
      throw new Error(`corrupt_journal_line at line ${i + 1}: ${err.message}`);
    }

    const stepIndex = typeof record.step_index === 'number' ? record.step_index : -1;
    if (stepIndex <= afterStepIndex) {
      continue;
    }

    if (stepIndex > lastProcessedStepIndex) {
      lastProcessedStepIndex = stepIndex;
    }

    if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') {
      // A new USER_INPUT provides definitive native completion evidence for the previous turn
      if (currentTurn) {
        const fullAssistantText = currentTurn.assistantParts.join('\n\n');
        if (fullAssistantText.trim()) {
          exchanges.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            userText: currentTurn.userText,
            assistantText: fullAssistantText,
            createdAt: currentTurn.createdAt,
          });
        } else {
          // No assistant response arrived before next USER_INPUT -> unpaired user input!
          unpairedUserInputs.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            userText: currentTurn.userText,
            createdAt: currentTurn.createdAt,
          });
        }
        currentTurn = null;
      }

      const createdAt = typeof record.created_at === 'string' && record.created_at.trim()
        ? record.created_at
        : 'unknown';
      const extraction = extractAntigravityUserRequest(record.content || '');
      const turnId = `ag-${conversationId}-${stepIndex}`;

      if (extraction.error || !extraction.userText) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: record.content || '',
          reason: extraction.error || 'unresolved',
          createdAt,
        });
        currentTurn = null;
        continue;
      }

      currentTurn = {
        stepIndex,
        turnId,
        userText: extraction.userText,
        createdAt,
        assistantParts: [],
      };
    } else if (record.type === 'PLANNER_RESPONSE' && record.source === 'MODEL') {
      if (currentTurn && record.content) {
        const text = extractAntigravityAssistantText(record.content);
        if (text) {
          currentTurn.assistantParts.push(text);
        }
      }
    }
  }

  // Handle trailing turn at EOF:
  // Without a subsequent USER_INPUT to seal the exchange, any assistant text generated so far
  // is held open in openTrailingTurn to prevent premature partial shipping.
  if (currentTurn) {
    const fullAssistantText = currentTurn.assistantParts.join('\n\n');
    if (fullAssistantText.trim()) {
      openTrailingTurn = {
        conversationId,
        stepIndex: currentTurn.stepIndex,
        turnId: currentTurn.turnId,
        userText: currentTurn.userText,
        assistantTextSoFar: fullAssistantText,
        createdAt: currentTurn.createdAt,
      };
    } else {
      // Trailing user turn with no assistant response yet (in-flight or stopped)
      unpairedUserInputs.push({
        conversationId,
        stepIndex: currentTurn.stepIndex,
        turnId: currentTurn.turnId,
        userText: currentTurn.userText,
        createdAt: currentTurn.createdAt,
      });
    }
  }

  return {
    exchanges,
    unpairedUserInputs,
    unresolvedTurns,
    openTrailingTurn,
    incompleteTrailingLine,
    lastProcessedStepIndex,
  };
}

export interface CheckpointData {
  conversationId: string;
  acknowledgedSteps: number[];
  lastContiguousAcknowledgedStepIndex: number;
  updatedAt: string;
}

export class ShipperStateStore {
  constructor(private readonly stateDir: string) {}

  private file(name: string): string {
    return join(this.stateDir, name);
  }

  private pendingDir(): string {
    return join(this.stateDir, 'pending');
  }

  private unresolvedDir(): string {
    return join(this.stateDir, 'unresolved');
  }

  private acceptedDir(): string {
    return join(this.stateDir, 'accepted');
  }

  /**
   * Loads checkpoint fail-closed: returns null ONLY on ENOENT (no file).
   * Validates schema, finite safe integers, and conversation scope if expectedConversationId is provided.
   */
  async loadCheckpoint(expectedConversationId?: string): Promise<CheckpointData | null> {
    let raw: string;
    try {
      raw = await readFile(this.file('checkpoint.json'), 'utf8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`corrupt_checkpoint_json: ${err.message}`);
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.conversationId !== 'string' ||
      !parsed.conversationId.trim() ||
      !Array.isArray(parsed.acknowledgedSteps) ||
      !Number.isSafeInteger(parsed.lastContiguousAcknowledgedStepIndex) ||
      parsed.lastContiguousAcknowledgedStepIndex < -1
    ) {
      throw new Error('corrupt_checkpoint_schema: invalid checkpoint data structure');
    }

    for (const step of parsed.acknowledgedSteps) {
      if (!Number.isSafeInteger(step) || step < 0) {
        throw new Error('corrupt_checkpoint_schema: acknowledgedSteps must contain only non-negative safe integers');
      }
    }

    if (expectedConversationId && parsed.conversationId !== expectedConversationId) {
      throw new Error(
        `mismatched_conversation_scope: checkpoint conversation "${parsed.conversationId}" does not match requested conversation "${expectedConversationId}"`
      );
    }

    return parsed as CheckpointData;
  }

  async saveCheckpoint(checkpoint: CheckpointData): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tempFile = this.file(`checkpoint.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempFile, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tempFile, this.file('checkpoint.json'));
  }

  /** Durably records an accepted exchange locally, preserving native occurrence and server receipt time */
  async recordAcceptedExchange(record: AcceptedExchangeRecord): Promise<void> {
    const dir = this.acceptedDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${record.turnId}.json`);
    const temp = join(dir, `${record.turnId}.${Date.now()}.tmp`);
    await writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
  }

  /** Lists all locally archived accepted exchange records */
  async listAcceptedExchanges(): Promise<AcceptedExchangeRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.acceptedDir());
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const out: AcceptedExchangeRecord[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await readFile(join(this.acceptedDir(), f), 'utf8');
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err: any) {
        throw new Error(`corrupt_accepted_file in ${f}: ${err.message}`);
      }
      out.push(parsed);
    }
    return out.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /** Persists a USER_INPUT durably before/while awaiting assistant completion */
  async persistPendingUserInput(input: PendingUserInput): Promise<void> {
    const dir = this.pendingDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${input.turnId}.json`);
    const temp = join(dir, `${input.turnId}.${Date.now()}.tmp`);
    await writeFile(temp, JSON.stringify(input, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, target);
  }

  /** Clears a pending USER_INPUT only after durable server acknowledgement */
  async clearPendingUserInput(turnId: string): Promise<void> {
    const target = join(this.pendingDir(), `${turnId}.json`);
    await unlink(target).catch((err: any) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  /**
   * Lists all currently pending unpaired user inputs.
   * Fails closed on corrupt files or unexpected errors.
   */
  async listPendingUserInputs(): Promise<PendingUserInput[]> {
    let files: string[];
    try {
      files = await readdir(this.pendingDir());
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const out: PendingUserInput[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await readFile(join(this.pendingDir(), f), 'utf8');
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (err: any) {
        throw new Error(`corrupt_pending_file in ${f}: ${err.message}`);
      }
      if (!parsed || typeof parsed.turnId !== 'string' || typeof parsed.stepIndex !== 'number') {
        throw new Error(`corrupt_pending_schema in ${f}`);
      }
      out.push(parsed);
    }
    return out.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /** Persists an ambiguous/unresolved turn as raw source evidence */
  async recordUnresolvedTurn(turn: UnresolvedTurn): Promise<void> {
    const dir = this.unresolvedDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${turn.turnId}.json`);
    await writeFile(target, JSON.stringify(turn, null, 2), 'utf8');
  }

  /** Lists all unresolved evidence records */
  async listUnresolvedTurns(): Promise<UnresolvedTurn[]> {
    let files: string[];
    try {
      files = await readdir(this.unresolvedDir());
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const out: UnresolvedTurn[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await readFile(join(this.unresolvedDir(), f), 'utf8');
      try {
        out.push(JSON.parse(raw));
      } catch (err: any) {
        throw new Error(`corrupt_unresolved_file in ${f}: ${err.message}`);
      }
    }
    return out.sort((a, b) => a.stepIndex - b.stepIndex);
  }
}

/**
 * Persists all source evidence (unpaired inputs and unresolved turns)
 * into durable local disk storage before any network or early return!
 */
export async function persistJournalEvidence(
  parseResult: ParseResult,
  stateStore: ShipperStateStore
): Promise<void> {
  for (const unresolved of parseResult.unresolvedTurns) {
    await stateStore.recordUnresolvedTurn(unresolved);
  }
  for (const unpaired of parseResult.unpairedUserInputs) {
    await stateStore.persistPendingUserInput(unpaired);
  }
  if (parseResult.openTrailingTurn) {
    await stateStore.persistPendingUserInput({
      conversationId: parseResult.openTrailingTurn.conversationId,
      stepIndex: parseResult.openTrailingTurn.stepIndex,
      turnId: parseResult.openTrailingTurn.turnId,
      userText: parseResult.openTrailingTurn.userText,
      createdAt: parseResult.openTrailingTurn.createdAt,
    });
  }
}

/**
 * Calculates the highest step index up to which every user input
 * has been durably accounted for (acknowledged by server).
 */
export function calculateContiguousAcknowledgedStep(
  allExchanges: AntigravityExchange[],
  unpairedInputs: PendingUserInput[],
  unresolvedTurns: UnresolvedTurn[],
  acknowledgedSet: Set<number>
): number {
  // All user steps in chronological order
  const allUserSteps = [
    ...allExchanges.map(e => e.stepIndex),
    ...unpairedInputs.map(u => u.stepIndex),
    ...unresolvedTurns.map(u => u.stepIndex),
  ].sort((a, b) => a - b);

  let contiguous = -1;
  for (const step of allUserSteps) {
    if (acknowledgedSet.has(step)) {
      contiguous = step;
    } else {
      // Stopped at the lowest unacknowledged step!
      break;
    }
  }
  return contiguous;
}

export interface ShipOptions {
  apiUrl: string;
  authToken: string;
  stateStore: ShipperStateStore;
  fetchImpl?: typeof fetch;
  dryRun?: boolean;
  expectedConversationId?: string;
}

export interface ShipReport {
  attempted: number;
  shipped: number;
  simulated: number;
  skipped: number;
  failed: number;
  pendingUnpaired: number;
  unresolvedCount: number;
  isOpenTrailing: boolean;
  lastAcknowledgedStepIndex: number;
  errors: Array<{ turnId: string; status?: number; message: string }>;
}

/**
 * Ships pending Antigravity exchanges to the canonical conversation exchange endpoint.
 * Checkpoints each exchange and moves record to local accepted ledger upon durable 2xx acknowledgement.
 */
export async function shipAntigravityExchanges(
  parseResult: ParseResult,
  options: ShipOptions
): Promise<ShipReport> {
  const fetcher = options.fetchImpl ?? fetch;

  const conversationId = options.expectedConversationId ??
    parseResult.exchanges[0]?.conversationId ??
    parseResult.unpairedUserInputs[0]?.conversationId ??
    parseResult.unresolvedTurns[0]?.conversationId ??
    parseResult.openTrailingTurn?.conversationId;

  // Step 1: Verify conversation scope BEFORE any evidence writes or state mutations!
  const existingCheckpoint = await options.stateStore.loadCheckpoint(conversationId);

  // Step 2: Lock in all source evidence durably on disk!
  await persistJournalEvidence(parseResult, options.stateStore);

  const acknowledgedSet = new Set<number>(existingCheckpoint?.acknowledgedSteps ?? []);
  let lastContiguous = existingCheckpoint?.lastContiguousAcknowledgedStepIndex ?? -1;

  const report: ShipReport = {
    attempted: 0,
    shipped: 0,
    simulated: 0,
    skipped: 0,
    failed: 0,
    pendingUnpaired: parseResult.unpairedUserInputs.length,
    unresolvedCount: parseResult.unresolvedTurns.length,
    isOpenTrailing: Boolean(parseResult.openTrailingTurn),
    lastAcknowledgedStepIndex: lastContiguous,
    errors: [],
  };

  const targetUrl = `${options.apiUrl.replace(/\/+$/, '')}/api/internal/canonical-conversation-exchange`;

  // Step 3: Ship completed pairs that are not yet acknowledged
  for (const ex of parseResult.exchanges) {
    if (acknowledgedSet.has(ex.stepIndex)) {
      report.skipped++;
      continue;
    }

    // Durably persist pending record before dispatch
    await options.stateStore.persistPendingUserInput({
      conversationId: ex.conversationId,
      stepIndex: ex.stepIndex,
      turnId: ex.turnId,
      userText: ex.userText,
      createdAt: ex.createdAt,
    });

    report.attempted++;

    if (options.dryRun) {
      // B3-DRY: In dry-run simulation, count simulated turn without writing to accepted ledger,
      // without inventing server acceptance time, without removing pending inputs, and without
      // altering acknowledgement cursor.
      report.simulated++;
      continue;
    }

    try {
      const res = await fetcher(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-coordination-token': options.authToken,
        },
        body: JSON.stringify({
          source: 'antigravity',
          turnId: ex.turnId,
          userText: ex.userText,
          assistantText: ex.assistantText,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        report.failed++;
        report.errors.push({ turnId: ex.turnId, status: res.status, message: errorText });
        // Fail-closed on error: do not advance past unacknowledged turn.
        break;
      }

      // 2xx response means accepted write-ahead record.
      report.shipped++;
      acknowledgedSet.add(ex.stepIndex);

      // Record in local accepted ledger: retains native occurrence timestamp
      // distinctly from server receipt timestamp!
      await options.stateStore.recordAcceptedExchange({
        turnId: ex.turnId,
        conversationId: ex.conversationId,
        stepIndex: ex.stepIndex,
        sourceCreatedAt: ex.createdAt,
        serverAcceptedAt: new Date().toISOString(),
        userText: ex.userText,
        assistantText: ex.assistantText,
      });

      // Clear local pending record now that server and local accepted ledger have durably accepted it
      await options.stateStore.clearPendingUserInput(ex.turnId);

      lastContiguous = calculateContiguousAcknowledgedStep(
        parseResult.exchanges,
        parseResult.unpairedUserInputs,
        parseResult.unresolvedTurns,
        acknowledgedSet
      );
      report.lastAcknowledgedStepIndex = lastContiguous;

      await options.stateStore.saveCheckpoint({
        conversationId: ex.conversationId,
        acknowledgedSteps: [...acknowledgedSet].sort((a, b) => a - b),
        lastContiguousAcknowledgedStepIndex: lastContiguous,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      report.failed++;
      report.errors.push({ turnId: ex.turnId, message: err.message || 'network_error' });
      break;
    }
  }

  return report;
}
