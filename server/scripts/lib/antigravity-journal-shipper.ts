import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

const requireSqlite = createRequire(import.meta.url);

/**
 * Enforces the LITTLENEMO shipper runtime contract: Node 22.5+ / Node 24 with
 * built-in `node:sqlite` is required so the shipper never silently degrades or
 * skips its SQLite fallback.
 */
export function assertNodeSqliteRuntime(
  loader: (moduleId: string) => unknown = requireSqlite
): { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabaseSync } {
  try {
    const mod = loader('node:sqlite') as {
      DatabaseSync?: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabaseSync;
    };
    if (!mod || typeof mod.DatabaseSync !== 'function') {
      throw new Error('DatabaseSync missing');
    }
    return mod as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabaseSync };
  } catch {
    throw new Error(
      `unsupported_node_runtime: antigravity-journal-shipper requires Node 22+ (node:sqlite); current runtime is ${process.version}`
    );
  }
}

function openSqliteDatabase(dbPath: string, options?: { readOnly?: boolean }): SqliteDatabaseSync {
  const mod = assertNodeSqliteRuntime();
  return new mod.DatabaseSync(dbPath, options);
}

export const PINNED_ANTIGRAVITY_IDE_VERSION = '2.6.0';
export const PINNED_ANTIGRAVITY_STEP_FORMAT = 0;
export const EVICTION_WARNING_UNSHIPPED_STEPS = 1500;

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

export interface SourceSnapshotEvidence {
  conversationId: string;
  dbPath: string;
  sourceDbSha256: string;
  walSha256?: string;
  pinnedIdeVersion: string;
  capturedAt: string;
}

export interface EvictionWarningRecord {
  conversationId: string;
  afterStepIndex: number;
  lastProcessedStepIndex: number;
  unshippedStepSpan: number;
  threshold: number;
  recordedAt: string;
}

export interface ParseResult {
  exchanges: AntigravityExchange[];
  unpairedUserInputs: PendingUserInput[];
  unresolvedTurns: UnresolvedTurn[];
  openTrailingTurn?: OpenTrailingTurn;
  incompleteTrailingLine?: string;
  lastProcessedStepIndex: number;
}

export interface SqliteSnapshotParseResult extends ParseResult {
  sourceSnapshot: SourceSnapshotEvidence;
}

/**
 * Guard against reading conversation_summaries.db under any circumstance.
 * Summaries must never stand in for verbatim words (Inviolability of the Narrative).
 */
export function assertNotSummariesDb(filePath: string): void {
  if (basename(filePath).toLowerCase() === 'conversation_summaries.db') {
    throw new Error(
      'forbidden_summaries_db: conversation_summaries.db must never be used as a transcript source'
    );
  }
}

/**
 * Detects literal compact-log truncation markers injected by Antigravity into
 * compact transcript.jsonl when a field exceeds ~4 KB.
 */
export function hasCompactTruncationMarker(text: string): boolean {
  return /<truncated \d+ bytes/.test(text);
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

  if (hasCompactTruncationMarker(rawContent)) {
    return { error: 'compact_jsonl_truncated' };
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
 * Fails closed on mid-file corrupted JSON and rejects compact-truncated records.
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

    const hasTruncatedFields =
      Array.isArray(record.truncated_fields) && record.truncated_fields.length > 0;
    const rawContentStr = typeof record.content === 'string' ? record.content : '';
    const isContentTruncated = hasTruncatedFields || hasCompactTruncationMarker(rawContentStr);

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
      const turnId = `ag-${conversationId}-${stepIndex}`;

      if (isContentTruncated) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: rawContentStr,
          reason: 'compact_jsonl_truncated',
          createdAt,
        });
        currentTurn = null;
        continue;
      }

      const extraction = extractAntigravityUserRequest(rawContentStr);

      if (extraction.error || !extraction.userText) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: rawContentStr,
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
      if (currentTurn) {
        if (isContentTruncated) {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: rawContentStr,
            reason: 'compact_jsonl_truncated',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }
        if (rawContentStr) {
          const text = extractAntigravityAssistantText(rawContentStr);
          if (text) {
            currentTurn.assistantParts.push(text);
          }
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

export interface ProtobufField {
  fieldNumber: number;
  wireType: number;
  varintValue?: bigint;
  bytes?: Uint8Array;
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    throw new Error('corrupt_protobuf_payload: invalid_utf8');
  }
}

/**
 * Fail-closed protobuf wire decoder for Antigravity step_payload and metadata blobs.
 * Rejects any unknown wire type, truncated varint, fieldNumber <= 0, or length overflow.
 */
export function decodeProtobufFields(u8: Uint8Array | null | undefined): ProtobufField[] {
  if (!u8 || u8.length === 0) {
    throw new Error('corrupt_protobuf_payload: empty_buffer');
  }
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const out: ProtobufField[] = [];
  let offset = 0;

  const ZERO = BigInt(0);
  const THREE = BigInt(3);
  const SEVEN = BigInt(7);
  const THIRTY_FIVE = BigInt(35);
  const SIXTY_FOUR = BigInt(64);
  const MASK_7F = BigInt(0x7f);
  const MASK_80 = BigInt(0x80);
  const MASK_07 = BigInt(0x07);

  while (offset < buf.length) {
    let tag = ZERO;
    let shift = ZERO;
    let tagComplete = false;
    while (offset < buf.length) {
      if (shift >= SIXTY_FOUR) {
        throw new Error('corrupt_protobuf_payload: tag_varint_overflow');
      }
      const b = BigInt(buf[offset++]);
      tag |= (b & MASK_7F) << shift;
      if ((b & MASK_80) === ZERO) {
        tagComplete = true;
        break;
      }
      shift += SEVEN;
    }
    if (!tagComplete) {
      throw new Error('corrupt_protobuf_payload: truncated_tag_varint');
    }

    const wireType = Number(tag & MASK_07);
    const fieldNumber = Number(tag >> THREE);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) {
      throw new Error('corrupt_protobuf_payload: invalid_field_number');
    }

    if (wireType === 0) {
      let val = ZERO;
      let vShift = ZERO;
      let valComplete = false;
      while (offset < buf.length) {
        if (vShift >= SIXTY_FOUR) {
          throw new Error('corrupt_protobuf_payload: varint_overflow');
        }
        const b = BigInt(buf[offset++]);
        val |= (b & MASK_7F) << vShift;
        if ((b & MASK_80) === ZERO) {
          valComplete = true;
          break;
        }
        vShift += SEVEN;
      }
      if (!valComplete) {
        throw new Error('corrupt_protobuf_payload: truncated_varint');
      }
      out.push({ fieldNumber, wireType, varintValue: val });
    } else if (wireType === 2) {
      let lenBig = ZERO;
      let lShift = ZERO;
      let lenComplete = false;
      while (offset < buf.length) {
        if (lShift >= THIRTY_FIVE) {
          throw new Error('corrupt_protobuf_payload: length_varint_overflow');
        }
        const b = BigInt(buf[offset++]);
        lenBig |= (b & MASK_7F) << lShift;
        if ((b & MASK_80) === ZERO) {
          lenComplete = true;
          break;
        }
        lShift += SEVEN;
      }
      if (!lenComplete) {
        throw new Error('corrupt_protobuf_payload: truncated_length_varint');
      }
      const len = Number(lenBig);
      if (len < 0 || offset + len > buf.length) {
        throw new Error('corrupt_protobuf_payload: length_overflow');
      }
      const slice = buf.subarray(offset, offset + len);
      offset += len;
      out.push({ fieldNumber, wireType, bytes: slice });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) {
        throw new Error('corrupt_protobuf_payload: truncated_fixed64');
      }
      const slice = buf.subarray(offset, offset + 8);
      offset += 8;
      out.push({ fieldNumber, wireType, bytes: slice });
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) {
        throw new Error('corrupt_protobuf_payload: truncated_fixed32');
      }
      const slice = buf.subarray(offset, offset + 4);
      offset += 4;
      out.push({ fieldNumber, wireType, bytes: slice });
    } else {
      throw new Error(`corrupt_protobuf_payload: unsupported_wire_type_${wireType}`);
    }
  }

  return out;
}

export interface SqliteStepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  step_payload: Uint8Array | null;
  step_format: number | null;
}

/**
 * Directly parses rows from an Antigravity conversations/<id>.db `steps` table.
 * Builds user turns directly from `step_payload` field 19.2 without synthetic
 * <USER_REQUEST> envelope wrapping (preserving trailing bare \r and all whitespace byte-exact).
 * Fails closed on unsupported step_format, status=5 evicted payloads, or malformed protobuf blobs.
 */
export function parseAntigravitySqliteSteps(
  rows: SqliteStepRow[],
  conversationId: string,
  afterStepIndex = -1
): ParseResult {
  const exchanges: AntigravityExchange[] = [];
  const unpairedUserInputs: PendingUserInput[] = [];
  const unresolvedTurns: UnresolvedTurn[] = [];
  let openTrailingTurn: OpenTrailingTurn | undefined;
  let lastProcessedStepIndex = afterStepIndex;

  interface PendingTurn {
    stepIndex: number;
    turnId: string;
    userText: string;
    createdAt: string;
    assistantParts: string[];
  }

  let currentTurn: PendingTurn | null = null;

  const sealCurrentTurn = () => {
    if (!currentTurn) return;
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
      unpairedUserInputs.push({
        conversationId,
        stepIndex: currentTurn.stepIndex,
        turnId: currentTurn.turnId,
        userText: currentTurn.userText,
        createdAt: currentTurn.createdAt,
      });
    }
    currentTurn = null;
  };

  for (const r of rows) {
    const stepIndex = typeof r.idx === 'number' ? r.idx : -1;
    if (stepIndex <= afterStepIndex) {
      continue;
    }

    if (stepIndex > lastProcessedStepIndex) {
      lastProcessedStepIndex = stepIndex;
    }

    const turnId = `ag-${conversationId}-${stepIndex}`;

    if (r.step_format !== PINNED_ANTIGRAVITY_STEP_FORMAT) {
      if (r.step_type === 14) {
        sealCurrentTurn();
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'unsupported_step_format',
          createdAt: 'unknown',
        });
      } else if (r.step_type === 15 && currentTurn) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'unsupported_step_format',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
      }
      continue;
    }

    let metaFields: ProtobufField[];
    try {
      metaFields = decodeProtobufFields(r.metadata);
    } catch {
      if (r.step_type === 14) {
        sealCurrentTurn();
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: 'unknown',
        });
      } else if (r.step_type === 15 && currentTurn) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
      }
      continue;
    }

    if (
      metaFields.some(
        f => (f.fieldNumber === 1 && f.wireType !== 2) || (f.fieldNumber === 3 && f.wireType !== 0)
      )
    ) {
      if (r.step_type === 14) {
        sealCurrentTurn();
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: 'unknown',
        });
      } else if (r.step_type === 15 && currentTurn) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
      }
      continue;
    }

    let createdAt = 'unknown';
    const tsField = metaFields.find(f => f.fieldNumber === 1 && f.wireType === 2 && f.bytes);
    if (tsField?.bytes) {
      try {
        const tsSub = decodeProtobufFields(tsField.bytes);
        if (tsSub.some(f => f.fieldNumber === 1 && f.wireType !== 0)) {
          throw new Error('corrupt_protobuf_payload: invalid_timestamp_wire_type');
        }
        const secField = tsSub.find(f => f.fieldNumber === 1 && f.wireType === 0);
        const sec = Number(secField?.varintValue ?? BigInt(0));
        if (Number.isSafeInteger(sec) && sec > 0) {
          createdAt = new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
        }
      } catch {
        if (r.step_type === 14) {
          sealCurrentTurn();
          unresolvedTurns.push({
            conversationId,
            stepIndex,
            turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt: 'unknown',
          });
          continue;
        } else if (r.step_type === 15 && currentTurn) {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }
      }
    }

    const sourceEnum = Number(metaFields.find(f => f.fieldNumber === 3 && f.wireType === 0)?.varintValue ?? BigInt(0));

    if (r.step_type === 14) {
      // Definitive completion evidence for previous turn
      sealCurrentTurn();

      if (sourceEnum !== 4) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt,
        });
        continue;
      }

      let payloadFields: ProtobufField[];
      try {
        payloadFields = decodeProtobufFields(r.step_payload);
      } catch {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt,
        });
        continue;
      }

      if (payloadFields.some(f => f.fieldNumber === 19 && f.wireType !== 2)) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt,
        });
        continue;
      }

      const f19 = payloadFields.find(f => f.fieldNumber === 19 && f.wireType === 2);

      if (r.status === 5 && !f19) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'evicted_step_payload',
          createdAt,
        });
        continue;
      }

      if (r.status !== 3) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'non_done_step_status',
          createdAt,
        });
        continue;
      }

      if (!f19?.bytes || f19.bytes.length === 0) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'missing_user_input_field',
          createdAt,
        });
        continue;
      }

      let f19Fields: ProtobufField[];
      try {
        f19Fields = decodeProtobufFields(f19.bytes);
      } catch {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt,
        });
        continue;
      }

      if (
        f19Fields.some(
          f => [2, 3, 4, 7, 12, 13, 18].includes(f.fieldNumber) && f.wireType !== 2
        )
      ) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt,
        });
        continue;
      }

      const f2 = f19Fields.find(f => f.fieldNumber === 2 && f.wireType === 2);
      const f7 = f19Fields.find(f => f.fieldNumber === 7 && f.wireType === 2);

      if (f2?.bytes) {
        let userText: string;
        try {
          userText = decodeUtf8Strict(f2.bytes);
        } catch {
          unresolvedTurns.push({
            conversationId,
            stepIndex,
            turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt,
          });
          continue;
        }

        if (hasCompactTruncationMarker(userText)) {
          unresolvedTurns.push({
            conversationId,
            stepIndex,
            turnId,
            rawContent: userText,
            reason: 'compact_jsonl_truncated',
            createdAt,
          });
          continue;
        }

        if (!userText) {
          unresolvedTurns.push({
            conversationId,
            stepIndex,
            turnId,
            rawContent: '',
            reason: 'empty_user_request',
            createdAt,
          });
          continue;
        }

        currentTurn = {
          stepIndex,
          turnId,
          userText,
          createdAt,
          assistantParts: [],
        };
      } else if (f7?.bytes) {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'empty_user_request',
          createdAt,
        });
      } else {
        unresolvedTurns.push({
          conversationId,
          stepIndex,
          turnId,
          rawContent: '',
          reason: 'missing_user_input_field',
          createdAt,
        });
      }
    } else if (r.step_type === 15 && currentTurn) {
      if (sourceEnum !== 2) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      if (r.status === 5) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'evicted_step_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      if (r.status !== 3) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'non_done_step_status',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      let payloadFields: ProtobufField[];
      try {
        payloadFields = decodeProtobufFields(r.step_payload);
      } catch {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      if (payloadFields.some(f => f.fieldNumber === 20 && f.wireType !== 2)) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      const f20 = payloadFields.find(f => f.fieldNumber === 20 && f.wireType === 2);
      if (!f20?.bytes || f20.bytes.length === 0) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'missing_planner_response_field',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      let f20Fields: ProtobufField[];
      try {
        f20Fields = decodeProtobufFields(f20.bytes);
      } catch {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      if (
        f20Fields.some(
          f =>
            ([1, 3, 6, 7, 8, 11, 14].includes(f.fieldNumber) && f.wireType !== 2) ||
            (f.fieldNumber === 12 && f.wireType !== 0)
        )
      ) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'corrupt_protobuf_payload',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      const f1 = f20Fields.find(f => f.fieldNumber === 1 && f.wireType === 2);
      const f3 = f20Fields.find(f => f.fieldNumber === 3 && f.wireType === 2);
      const f7 = f20Fields.find(f => f.fieldNumber === 7 && f.wireType === 2);

      if (!f1 && !f3 && !f7) {
        unresolvedTurns.push({
          conversationId,
          stepIndex: currentTurn.stepIndex,
          turnId: currentTurn.turnId,
          rawContent: '',
          reason: 'missing_planner_response_field',
          createdAt: currentTurn.createdAt,
        });
        currentTurn = null;
        continue;
      }

      if (f1) {
        if (!f1.bytes || f1.bytes.length === 0) {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }

        let responseText: string;
        try {
          responseText = decodeUtf8Strict(f1.bytes);
        } catch {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }

        if (hasCompactTruncationMarker(responseText)) {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: responseText,
            reason: 'compact_jsonl_truncated',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }

        const text = extractAntigravityAssistantText(responseText);
        if (!text) {
          unresolvedTurns.push({
            conversationId,
            stepIndex: currentTurn.stepIndex,
            turnId: currentTurn.turnId,
            rawContent: '',
            reason: 'corrupt_protobuf_payload',
            createdAt: currentTurn.createdAt,
          });
          currentTurn = null;
          continue;
        }

        currentTurn.assistantParts.push(text);
      }
    }
  }

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
    lastProcessedStepIndex,
  };
}

/**
 * Copies conversations/<id>.db (plus any -wal and -shm files) into a private
 * temporary directory before opening read-only with node:sqlite, computing
 * SHA-256 source evidence for the shipper ledger.
 */
export async function snapshotAndParseAntigravitySqliteDb(
  dbPath: string,
  conversationId: string,
  afterStepIndex = -1
): Promise<SqliteSnapshotParseResult> {
  assertNotSummariesDb(dbPath);

  const snapDir = mkdtempSync(join(tmpdir(), 'ag-shipper-db-snap-'));
  try {
    const snapDbPath = join(snapDir, 'conversation.db');
    await copyFile(dbPath, snapDbPath);

    const dbBytes = await readFile(snapDbPath);
    const sourceDbSha256 = createHash('sha256').update(dbBytes).digest('hex');

    let walSha256: string | undefined;
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      const snapWalPath = `${snapDbPath}-wal`;
      await copyFile(walPath, snapWalPath);
      const walBytes = await readFile(snapWalPath);
      walSha256 = createHash('sha256').update(walBytes).digest('hex');
    }

    const shmPath = `${dbPath}-shm`;
    if (existsSync(shmPath)) {
      const snapShmPath = `${snapDbPath}-shm`;
      await copyFile(shmPath, snapShmPath);
    }

    const db = openSqliteDatabase(snapDbPath, { readOnly: true });
    let rows: SqliteStepRow[];
    try {
      rows = db
        .prepare(
          'SELECT idx, step_type, status, metadata, step_payload, step_format FROM steps ORDER BY idx ASC'
        )
        .all() as unknown as SqliteStepRow[];
    } finally {
      db.close();
    }

    const parsed = parseAntigravitySqliteSteps(rows, conversationId, afterStepIndex);
    const sourceSnapshot: SourceSnapshotEvidence = {
      conversationId,
      dbPath,
      sourceDbSha256,
      ...(walSha256 ? { walSha256 } : {}),
      pinnedIdeVersion: PINNED_ANTIGRAVITY_IDE_VERSION,
      capturedAt: new Date().toISOString(),
    };

    return {
      ...parsed,
      sourceSnapshot,
    };
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
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

  /** Durably records SQLite snapshot SHA-256 source evidence in the shipper ledger */
  async recordSourceSnapshotEvidence(evidence: SourceSnapshotEvidence): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tempFile = this.file(`source-snapshot.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempFile, JSON.stringify(evidence, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tempFile, this.file('source-snapshot.json'));
  }

  async loadSourceSnapshotEvidence(): Promise<SourceSnapshotEvidence | null> {
    try {
      const raw = await readFile(this.file('source-snapshot.json'), 'utf8');
      return JSON.parse(raw) as SourceSnapshotEvidence;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Durably records an eviction-horizon warning when unshipped steps >= threshold */
  async recordEvictionWarning(warning: EvictionWarningRecord): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tempFile = this.file(`eviction-warning.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempFile, JSON.stringify(warning, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tempFile, this.file('eviction-warning.json'));
  }

  async loadEvictionWarning(): Promise<EvictionWarningRecord | null> {
    try {
      const raw = await readFile(this.file('eviction-warning.json'), 'utf8');
      return JSON.parse(raw) as EvictionWarningRecord;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
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
  evictionWarning?: boolean;
  sourceDbSha256?: string;
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
