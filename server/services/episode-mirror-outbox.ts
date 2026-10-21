/**
 * Durable retry queue for rolling-episode projections.
 *
 * The canonical conversation row and chat-capture cursor must not wait on the
 * episode mirror. Each item is written atomically before the projection cursor
 * advances, then removed only after the DB-first mirror and acknowledgement
 * cursor have both succeeded.
 */

import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  CHAT_CAPTURE_ACK_CURSOR_PATH,
  WORKSPACE,
  loadChatCaptureCursor,
  saveChatCaptureCursor,
  type ChatCaptureCursor,
} from './transcript-parser';
import { CHAT_CAPTURE_ACK_DIR } from './transcript-parser';

export const EPISODE_MIRROR_OUTBOX_PATH = join(WORKSPACE, '.local/episode-mirror-outbox');
export const EPISODE_MIRROR_QUARANTINE_PATH = join(WORKSPACE, '.local/episode-mirror-outbox-quarantine');

export interface EpisodeMirrorResolutionEvidence {
  captureId: string;
  disposition: 'canonical';
  canonicalMemoryId: string;
}

export interface EpisodeMirrorUnresolvedEvidence {
  captureId: string;
  disposition: 'deliberately-unresolved';
  reason: string;
}

export interface EpisodeMirrorTerminalResolution {
  kind: 'permanently-invalid-destination';
  destinationState: 'removed' | 'sealed';
  reason: string;
  operator: string;
  resolvedAtMs: number;
  evidence: Array<EpisodeMirrorResolutionEvidence | EpisodeMirrorUnresolvedEvidence>;
  itemSha256: string;
  formattedContentSha256: string;
  appendMarkerSha256: string;
  sourceReceiptSha256: Record<string, string>;
  auditPath: string;
}

export interface EpisodeMirrorOutboxItem {
  startCursor: number;
  endOffset: number;
  liveEpisode: string;
  formattedContent: string;
  appendMarker: string;
  captureIds: string[];
  lastSavedTurnFingerprint?: string;
  terminalResolution?: EpisodeMirrorTerminalResolution;
  /**
   * ATTRIBUTION_WRITERS_V1 (design f5d77712 3.4, writer 1): the exact framed
   * event to append through the common append instead of formattedContent.
   */
  episodeEvent?: import('./projection-append').AppendEvent;
  /** Set when the item was enqueued with the switch on: never append it unframed. */
  attributionRequired?: boolean;
}

export interface EpisodeMirrorOutboxPaths {
  directory?: string;
  acknowledgementCursorPath?: string;
  receiptDirectory?: string;
  quarantineDirectory?: string;
  lockPath?: string;
}

function pathsWithDefaults(paths: EpisodeMirrorOutboxPaths = {}) {
  return {
    directory: paths.directory ?? EPISODE_MIRROR_OUTBOX_PATH,
    acknowledgementCursorPath: paths.acknowledgementCursorPath ?? CHAT_CAPTURE_ACK_CURSOR_PATH,
    receiptDirectory: paths.receiptDirectory ?? CHAT_CAPTURE_ACK_DIR,
    quarantineDirectory: paths.quarantineDirectory ?? EPISODE_MIRROR_QUARANTINE_PATH,
    lockPath: paths.lockPath ?? `${paths.directory ?? EPISODE_MIRROR_OUTBOX_PATH}.lock`,
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function originalItemBytes(item: EpisodeMirrorOutboxItem): string {
  const { terminalResolution: _terminalResolution, ...original } = item;
  return JSON.stringify(original);
}

function assertValidTerminalResolution(item: EpisodeMirrorOutboxItem): void {
  const resolution = item.terminalResolution;
  if (!resolution) return;
  if (
    resolution.kind !== 'permanently-invalid-destination' ||
    !['removed', 'sealed'].includes(resolution.destinationState) ||
    !resolution.reason?.trim() ||
    !resolution.operator?.trim() ||
    !Number.isFinite(resolution.resolvedAtMs) ||
    !resolution.auditPath?.trim()
  ) {
    throw new Error('invalid terminal episode-mirror resolution metadata');
  }
  const expectedIds = [...new Set(item.captureIds)].sort();
  const evidenceIds = [...new Set(resolution.evidence.map(entry => entry.captureId))].sort();
  if (
    expectedIds.length === 0 ||
    item.captureIds.length !== expectedIds.length ||
    resolution.evidence.length !== expectedIds.length ||
    expectedIds.length !== evidenceIds.length ||
    expectedIds.some((captureId, index) => captureId !== evidenceIds[index])
  ) {
    throw new Error('terminal episode-mirror resolution must contain evidence for every source capture ID');
  }
  for (const evidence of resolution.evidence) {
    if (evidence.disposition !== 'canonical' && evidence.disposition !== 'deliberately-unresolved') {
      throw new Error(`terminal episode-mirror resolution has unsupported evidence disposition`);
    }
    if (
      (evidence.disposition === 'canonical' && !evidence.canonicalMemoryId?.trim()) ||
      (evidence.disposition === 'deliberately-unresolved' && !evidence.reason?.trim())
    ) {
      throw new Error(`terminal episode-mirror resolution has incomplete evidence for ${evidence.captureId}`);
    }
  }
  if (
    resolution.itemSha256 !== sha256(originalItemBytes(item)) ||
    resolution.formattedContentSha256 !== sha256(item.formattedContent) ||
    resolution.appendMarkerSha256 !== sha256(item.appendMarker)
  ) {
    throw new Error('terminal episode-mirror resolution hash mismatch');
  }
  const receiptHashIds = Object.keys(resolution.sourceReceiptSha256).sort();
  if (
    receiptHashIds.length !== expectedIds.length ||
    expectedIds.some((captureId, index) =>
      captureId !== receiptHashIds[index] ||
      !/^[a-f0-9]{64}$/.test(resolution.sourceReceiptSha256[captureId] ?? '')
    )
  ) {
    throw new Error('terminal episode-mirror resolution must bind every source receipt hash');
  }
  if (!existsSync(resolution.auditPath)) {
    throw new Error('terminal episode-mirror resolution audit is missing');
  }
  const audit = JSON.parse(readFileSync(resolution.auditPath, 'utf8')) as {
    resolution?: unknown;
    originalItem?: EpisodeMirrorOutboxItem;
    sourceReceipts?: Record<string, unknown>;
  };
  if (
    JSON.stringify(audit.resolution) !== JSON.stringify(resolution) ||
    JSON.stringify(audit.originalItem) !== originalItemBytes(item)
  ) {
    throw new Error('terminal episode-mirror resolution diverges from its retained audit');
  }
  for (const captureId of expectedIds) {
    const auditedReceipt = audit.sourceReceipts?.[captureId];
    if (
      auditedReceipt === undefined ||
      sha256(JSON.stringify(auditedReceipt)) !== resolution.sourceReceiptSha256[captureId]
    ) {
      throw new Error(`terminal episode-mirror source receipt audit mismatch for ${captureId}`);
    }
  }
}

function itemKey(item: EpisodeMirrorOutboxItem): string {
  return createHash('sha256')
    .update(`${item.startCursor}:${item.endOffset}:${item.appendMarker}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function itemPath(item: EpisodeMirrorOutboxItem, directory: string): string {
  return join(
    directory,
    `${String(item.endOffset).padStart(20, '0')}-${itemKey(item)}.json`,
  );
}

function writeAtomic(path: string, content: string): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, 'utf8');
  renameSync(tempPath, path);
}

function acquireOutboxLock(lockPath: string): number {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(lockPath, String(process.pid), { flag: 'w' });
    return fd;
  } catch {
    try {
      const ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      let ownerAlive = false;
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch { ownerAlive = false; }
      }
      if (ownerAlive) return -1;
      unlinkSync(lockPath);
      const fd = openSync(lockPath, 'wx');
      writeFileSync(lockPath, String(process.pid), { flag: 'w' });
      return fd;
    } catch {
      return -1;
    }
  }
}

function releaseOutboxLock(fd: number, lockPath: string): void {
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

export function enqueueEpisodeMirror(
  item: EpisodeMirrorOutboxItem,
  paths: EpisodeMirrorOutboxPaths = {},
): string {
  const resolved = pathsWithDefaults(paths);
  mkdirSync(resolved.directory, { recursive: true });
  const path = itemPath(item, resolved.directory);
  // A missing acknowledgement cursor is initialized at the item's beginning.
  // Never move an existing cursor backwards.
  if (!existsSync(resolved.acknowledgementCursorPath)) {
    writeAtomic(
      resolved.acknowledgementCursorPath,
      JSON.stringify({ byteOffset: item.startCursor } satisfies ChatCaptureCursor),
    );
  }
  writeAtomic(path, JSON.stringify(item));
  return path;
}

export function listEpisodeMirrorOutbox(
  paths: EpisodeMirrorOutboxPaths = {},
): Array<{ path: string; item: EpisodeMirrorOutboxItem }> {
  const { directory } = pathsWithDefaults(paths);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      try {
        const path = join(directory, name);
        const item = JSON.parse(readFileSync(path, 'utf8')) as EpisodeMirrorOutboxItem;
        if (
          Number.isFinite(item.startCursor) &&
          Number.isFinite(item.endOffset) &&
          item.endOffset >= item.startCursor &&
          typeof item.liveEpisode === 'string' &&
          typeof item.formattedContent === 'string' &&
          typeof item.appendMarker === 'string' &&
          Array.isArray(item.captureIds)
        ) {
          assertValidTerminalResolution(item);
          return { path, item };
        }
        throw new Error(`malformed episode mirror outbox item: ${name}`);
      } catch (error: any) {
        // A malformed earlier item is an unknown acknowledgement boundary.
        // Fail closed instead of skipping it and acknowledging later captures.
        throw new Error(`[EpisodeOutbox] Could not read ${name}: ${error?.message ?? error}`);
      }
    });
}

export async function resolveEpisodeMirrorDestinationInvalid(
  outboxItemPath: string,
  input: {
    destinationState: 'removed' | 'sealed';
    reason: string;
    operator: string;
    evidence: Array<EpisodeMirrorResolutionEvidence | EpisodeMirrorUnresolvedEvidence>;
    resolvedAtMs?: number;
    verifyCanonicalMemory?: (captureId: string, canonicalMemoryId: string) => Promise<boolean>;
  },
  paths: EpisodeMirrorOutboxPaths = {},
): Promise<EpisodeMirrorTerminalResolution> {
  const resolved = pathsWithDefaults(paths);
  const lockFd = acquireOutboxLock(resolved.lockPath);
  if (lockFd === -1) throw new Error('episode mirror outbox is busy; retry the audited resolution');
  try {
    const entry = listEpisodeMirrorOutbox(paths).find(candidate => candidate.path === outboxItemPath);
    if (!entry) throw new Error('episode mirror outbox item was not found');
    if (entry.item.terminalResolution) throw new Error('episode mirror outbox item is already terminally resolved');
    if (!input.reason?.trim() || !input.operator?.trim()) {
      throw new Error('terminal resolution requires a reason and operator');
    }

    const expectedIds = [...new Set(entry.item.captureIds)].sort();
    const evidenceIds = [...new Set(input.evidence.map(evidence => evidence.captureId))].sort();
    if (
      expectedIds.length === 0 ||
      entry.item.captureIds.length !== expectedIds.length ||
      input.evidence.length !== expectedIds.length ||
      expectedIds.length !== evidenceIds.length ||
      expectedIds.some((captureId, index) => captureId !== evidenceIds[index])
    ) {
      throw new Error('audited resolution requires evidence for every source capture ID');
    }
    for (const evidence of input.evidence) {
      if (evidence.disposition !== 'canonical' && evidence.disposition !== 'deliberately-unresolved') {
        throw new Error(
          `unsupported evidence disposition for ${String((evidence as { captureId?: unknown }).captureId ?? 'unknown')}`,
        );
      }
      if (evidence.disposition === 'canonical') {
        if (!evidence.canonicalMemoryId?.trim() || !input.verifyCanonicalMemory) {
          throw new Error(`canonical evidence for ${evidence.captureId} requires authoritative DB verification`);
        }
        if (!await input.verifyCanonicalMemory(evidence.captureId, evidence.canonicalMemoryId)) {
          throw new Error(`canonical memory ${evidence.canonicalMemoryId} does not prove capture ${evidence.captureId}`);
        }
      } else if (!evidence.reason?.trim()) {
        throw new Error(`deliberately unresolved evidence for ${evidence.captureId} requires a reason`);
      }
    }

    const sourceReceipts: Record<string, unknown> = {};
    const sourceReceiptSha256: Record<string, string> = {};
    for (const captureId of expectedIds) {
      const receiptPath = join(resolved.receiptDirectory, `${captureId}.json`);
      if (!existsSync(receiptPath)) {
        throw new Error(`audited resolution requires source receipt ${captureId}`);
      }
      const receiptBytes = readFileSync(receiptPath, 'utf8');
      const receipt = JSON.parse(receiptBytes) as { turnId?: unknown; targetByteOffset?: unknown; source?: unknown };
      if (
        receipt.turnId !== captureId ||
        receipt.source !== 'replit' && receipt.source !== 'claude-code' ||
        typeof receipt.targetByteOffset !== 'number' ||
        receipt.targetByteOffset > entry.item.endOffset
      ) {
        throw new Error(`source receipt ${captureId} does not match the outbox item`);
      }
      sourceReceipts[captureId] = receipt;
      sourceReceiptSha256[captureId] = sha256(receiptBytes);
    }

    const resolvedAtMs = input.resolvedAtMs ?? Date.now();
    const auditIdentity = sha256(JSON.stringify({
      originalItem: entry.item,
      sourceReceipts,
      destinationState: input.destinationState,
      reason: input.reason.trim(),
      operator: input.operator.trim(),
      resolvedAtMs,
      evidence: input.evidence,
    }));
    mkdirSync(resolved.quarantineDirectory, { recursive: true });
    const auditPath = join(
      resolved.quarantineDirectory,
      `${String(entry.item.endOffset).padStart(20, '0')}-${itemKey(entry.item)}-${auditIdentity}.json`,
    );
    const resolution: EpisodeMirrorTerminalResolution = {
      kind: 'permanently-invalid-destination',
      destinationState: input.destinationState,
      reason: input.reason.trim(),
      operator: input.operator.trim(),
      resolvedAtMs,
      evidence: input.evidence,
      itemSha256: sha256(originalItemBytes(entry.item)),
      formattedContentSha256: sha256(entry.item.formattedContent),
      appendMarkerSha256: sha256(entry.item.appendMarker),
      sourceReceiptSha256,
      auditPath,
    };
    const audit = { resolution, originalItem: entry.item, sourceReceipts };
    const auditBytes = JSON.stringify(audit, null, 2);
    try {
      writeFileSync(auditPath, auditBytes, { encoding: 'utf8', flag: 'wx' });
    } catch (error: any) {
      if (!existsSync(auditPath) || readFileSync(auditPath, 'utf8') !== auditBytes) {
        throw new Error(`refusing to overwrite existing episode mirror audit: ${error?.message ?? error}`);
      }
    }
    const terminalItem = { ...entry.item, terminalResolution: resolution };
    assertValidTerminalResolution(terminalItem);
    writeAtomic(entry.path, JSON.stringify(terminalItem));
    return resolution;
  } finally {
    releaseOutboxLock(lockFd, resolved.lockPath);
  }
}

export function advanceEpisodeMirrorAcknowledgement(
  item: EpisodeMirrorOutboxItem,
  paths: EpisodeMirrorOutboxPaths = {},
): number {
  const resolved = pathsWithDefaults(paths);
  const current = loadChatCaptureCursor(resolved.acknowledgementCursorPath);
  if (item.startCursor > current.byteOffset) {
    throw new Error(
      `cannot advance non-contiguous episode mirror acknowledgement: ` +
      `ack=${current.byteOffset}, item=${item.startCursor}→${item.endOffset}`,
    );
  }
  const nextOffset = Math.max(current.byteOffset, item.endOffset);
  saveChatCaptureCursor({
    byteOffset: nextOffset,
    ...(nextOffset === item.endOffset && item.lastSavedTurnFingerprint
      ? { lastSavedTurnFingerprint: item.lastSavedTurnFingerprint }
      : current.lastSavedTurnFingerprint
        ? { lastSavedTurnFingerprint: current.lastSavedTurnFingerprint }
        : {}),
  }, resolved.acknowledgementCursorPath);
  return nextOffset;
}

export async function processEpisodeMirrorOutbox(
  processor: (item: EpisodeMirrorOutboxItem) => Promise<boolean>,
  paths: EpisodeMirrorOutboxPaths = {},
): Promise<{ processed: number; pending: number }> {
  const resolved = pathsWithDefaults(paths);
  const lockFd = acquireOutboxLock(resolved.lockPath);
  if (lockFd === -1) return { processed: 0, pending: listEpisodeMirrorOutbox(paths).length };
  try {
    const items = listEpisodeMirrorOutbox(paths);
    let processed = 0;
    for (const entry of items) {
      try {
        const acknowledgement = JSON.parse(
          readFileSync(resolved.acknowledgementCursorPath, 'utf8'),
        ) as { byteOffset?: unknown };
        if (
          typeof acknowledgement.byteOffset !== 'number' ||
          entry.item.startCursor > acknowledgement.byteOffset
        ) {
          throw new Error(
            `outbox boundary is not contiguous: ack=${String(acknowledgement.byteOffset)}, ` +
            `item=${entry.item.startCursor}→${entry.item.endOffset}`,
          );
        }
        const complete = await processor(entry.item);
        if (!complete) break;
        unlinkSync(entry.path);
        processed++;
      } catch (error: any) {
        console.error(`[EpisodeOutbox] Mirror retry failed: ${error?.message ?? error}`);
        break;
      }
    }
    return { processed, pending: items.length - processed };
  } finally {
    releaseOutboxLock(lockFd, resolved.lockPath);
  }
}