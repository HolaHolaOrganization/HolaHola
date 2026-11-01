/**
 * Regression for the canonical-chat cursor wedge:
 * canonical DB progress must continue while an episode mirror is retrying,
 * and receipts must remain pending until that mirror succeeds.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  advanceEpisodeMirrorAcknowledgement,
  enqueueEpisodeMirror,
  listEpisodeMirrorOutbox,
  processEpisodeMirrorOutbox,
  resolveEpisodeMirrorDestinationInvalid,
  type EpisodeMirrorOutboxItem,
} from '../services/episode-mirror-outbox';
import { saveChatCaptureCursor } from '../services/transcript-parser';
import {
  settleCanonicalCaptureReceiptsByTurnId,
  settleCanonicalCaptureReceiptsForInvalidDestination,
  writeCanonicalCaptureReceipt,
} from '../services/canonical-conversation-capture';

let passed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  const root = join(tmpdir(), `chat-episode-outbox-${randomBytes(4).toString('hex')}`);
  const directory = join(root, 'outbox');
  const acknowledgementCursorPath = join(root, 'ack-cursor.json');
  const projectionCursorPath = join(root, 'projection-cursor.json');
  const receiptDir = join(root, 'receipts');
  const latestPath = join(root, 'latest-receipt.json');
  const quarantineDirectory = join(root, 'quarantine');
  mkdirSync(root, { recursive: true });

  const paths = { directory, acknowledgementCursorPath, receiptDirectory: receiptDir, quarantineDirectory };
  const receiptPaths = { receiptDir, latestPath, cursorPath: acknowledgementCursorPath };
  const first: EpisodeMirrorOutboxItem = {
    startCursor: 0,
    endOffset: 100,
    liveEpisode: 'episode-test.md',
    formattedContent: '**David [Replit]:** first',
    appendMarker: '<!-- chat-capture-range:0:100 -->',
    captureIds: ['first'],
    lastSavedTurnFingerprint: 'fingerprint-first',
  };
  const second: EpisodeMirrorOutboxItem = {
    startCursor: 100,
    endOffset: 200,
    liveEpisode: 'episode-test.md',
    formattedContent: '**David [Replit]:** second',
    appendMarker: '<!-- chat-capture-range:100:200 -->',
    captureIds: ['second'],
    lastSavedTurnFingerprint: 'fingerprint-second',
  };

  try {
    enqueueEpisodeMirror(first, paths);
    saveChatCaptureCursor({ byteOffset: 100 }, projectionCursorPath);
    writeCanonicalCaptureReceipt({
      turnId: 'first',
      targetByteOffset: 100,
      createdAtMs: Date.now(),
      source: 'replit',
      status: 'pending',
    }, receiptPaths);

    const failed = await processEpisodeMirrorOutbox(async () => false, paths);
    assert(failed.processed === 0 && failed.pending === 1, 'failed mirror remains durably queued');
    assert(JSON.parse(readFileSync(projectionCursorPath, 'utf8')).byteOffset === 100, 'canonical cursor advances after DB success despite mirror failure');
    assert(JSON.parse(readFileSync(acknowledgementCursorPath, 'utf8')).byteOffset === 0, 'acknowledgement cursor does not advance on mirror failure');
    assert(JSON.parse(readFileSync(join(receiptDir, 'first.json'), 'utf8')).status === 'pending', 'receipt remains pending after mirror failure');

    enqueueEpisodeMirror(second, paths);
    saveChatCaptureCursor({ byteOffset: 200 }, projectionCursorPath);
    writeCanonicalCaptureReceipt({
      turnId: 'second',
      targetByteOffset: 200,
      createdAtMs: Date.now(),
      source: 'replit',
      status: 'pending',
    }, receiptPaths);
    assert(listEpisodeMirrorOutbox(paths).length === 2, 'later exchange queues while the first mirror is still pending');
    assert(JSON.parse(readFileSync(projectionCursorPath, 'utf8')).byteOffset === 200, 'later canonical exchange drains past the failed mirror');

    const order: number[] = [];
    const recovered = await processEpisodeMirrorOutbox(async item => {
      order.push(item.endOffset);
      saveChatCaptureCursor({
        byteOffset: item.endOffset,
        lastSavedTurnFingerprint: item.lastSavedTurnFingerprint,
      }, acknowledgementCursorPath);
      settleCanonicalCaptureReceiptsByTurnId(item.captureIds, item.endOffset, receiptPaths);
      return true;
    }, paths);

    assert(recovered.processed === 2 && recovered.pending === 0, 'successful retry drains both queued mirrors');
    assert(order.join(',') === '100,200', 'mirror retries preserve cursor order');
    assert(JSON.parse(readFileSync(acknowledgementCursorPath, 'utf8')).byteOffset === 200, 'acknowledgement cursor reaches the final mirrored boundary');
    assert(JSON.parse(readFileSync(join(receiptDir, 'first.json'), 'utf8')).status === 'acknowledged', 'first receipt settles after its mirror succeeds');
    assert(JSON.parse(readFileSync(join(receiptDir, 'second.json'), 'utf8')).status === 'acknowledged', 'later receipt settles only after its mirror succeeds');
    assert(listEpisodeMirrorOutbox(paths).length === 0, 'completed mirror items are removed');

    const obsolete: EpisodeMirrorOutboxItem = {
      ...first,
      liveEpisode: 'episode-31.md',
      formattedContent: '**David [Replit]:** preserved obsolete source',
      appendMarker: '<!-- chat-capture-range:200:300 -->',
      startCursor: 200,
      endOffset: 300,
      captureIds: ['obsolete'],
    };
    const later: EpisodeMirrorOutboxItem = {
      ...second,
      liveEpisode: 'episode-33.md',
      formattedContent: '**David [Replit]:** later valid source',
      appendMarker: '<!-- chat-capture-range:300:400 -->',
      startCursor: 300,
      endOffset: 400,
      captureIds: ['later'],
    };
    const obsoletePath = enqueueEpisodeMirror(obsolete, paths);
    enqueueEpisodeMirror(later, paths);
    for (const [turnId, targetByteOffset] of [['obsolete', 300], ['later', 400]] as const) {
      writeCanonicalCaptureReceipt({
        turnId,
        targetByteOffset,
        createdAtMs: Date.now(),
        source: 'replit',
        status: 'pending',
      }, receiptPaths);
    }
    let incompleteAuditRejected = false;
    try {
      await resolveEpisodeMirrorDestinationInvalid(obsoletePath, {
        destinationState: 'removed',
        reason: 'Episode 31 was deliberately removed after sealing',
        operator: 'ci-operator',
        evidence: [],
      }, paths);
    } catch {
      incompleteAuditRejected = true;
    }
    assert(incompleteAuditRejected, 'advancing past an invalid destination requires evidence for every source capture');
    let duplicateEvidenceRejected = false;
    try {
      await resolveEpisodeMirrorDestinationInvalid(obsoletePath, {
        destinationState: 'removed',
        reason: 'Episode 31 was deliberately removed after sealing',
        operator: 'ci-operator',
        evidence: [
          {
            captureId: 'obsolete',
            disposition: 'deliberately-unresolved',
            reason: 'first contradictory decision',
          },
          {
            captureId: 'obsolete',
            disposition: 'canonical',
            canonicalMemoryId: 'fabricated-memory-id',
          },
        ],
        verifyCanonicalMemory: async () => true,
      }, paths);
    } catch {
      duplicateEvidenceRejected = true;
    }
    assert(duplicateEvidenceRejected, 'each source capture requires exactly one evidence decision');

    const emptyItem: EpisodeMirrorOutboxItem = {
      ...obsolete,
      startCursor: 300,
      endOffset: 300,
      appendMarker: '<!-- empty-terminal-evidence-fixture -->',
      captureIds: [],
    };
    const emptyItemPath = enqueueEpisodeMirror(emptyItem, paths);
    let emptyEvidenceRejected = false;
    try {
      await resolveEpisodeMirrorDestinationInvalid(emptyItemPath, {
        destinationState: 'removed',
        reason: 'empty evidence fixture',
        operator: 'ci-operator',
        evidence: [],
      }, paths);
    } catch {
      emptyEvidenceRejected = true;
    }
    assert(emptyEvidenceRejected, 'an item with no source capture IDs cannot use the terminal bypass');
    rmSync(emptyItemPath, { force: true });
    let fabricatedCanonicalRejected = false;
    try {
      await resolveEpisodeMirrorDestinationInvalid(obsoletePath, {
        destinationState: 'removed',
        reason: 'Episode 31 was deliberately removed after sealing',
        operator: 'ci-operator',
        evidence: [{
          captureId: 'obsolete',
          disposition: 'canonical',
          canonicalMemoryId: 'fabricated-memory-id',
        }],
        verifyCanonicalMemory: async () => false,
      }, paths);
    } catch {
      fabricatedCanonicalRejected = true;
    }
    assert(fabricatedCanonicalRejected, 'fabricated canonical-memory evidence cannot terminally resolve an item');

    const resolution = await resolveEpisodeMirrorDestinationInvalid(obsoletePath, {
      destinationState: 'removed',
      reason: 'Episode 31 was deliberately removed after sealing',
      operator: 'ci-operator',
      evidence: [{
        captureId: 'obsolete',
        disposition: 'deliberately-unresolved',
        reason: 'source receipt preserved; canonical destination intentionally left unresolved',
      }],
      resolvedAtMs: 1_788_500_000_000,
    }, paths);
    assert(existsSync(resolution.auditPath), 'invalid item audit is retained outside the active queue');
    const auditBytes = readFileSync(resolution.auditPath, 'utf8');
    assert(auditBytes.includes('sourceReceiptSha256') && auditBytes.includes('formattedContentSha256'), 'audit preserves source receipts and content hashes');
    const terminalItemBytes = readFileSync(obsoletePath, 'utf8');
    const tamperedTerminalItem = JSON.parse(terminalItemBytes);
    tamperedTerminalItem.terminalResolution.evidence[0].disposition = 'forged';
    writeFileSync(obsoletePath, JSON.stringify(tamperedTerminalItem), 'utf8');
    let persistedTamperingRejected = false;
    try {
      listEpisodeMirrorOutbox(paths);
    } catch {
      persistedTamperingRejected = true;
    }
    assert(persistedTamperingRejected, 'persisted terminal evidence tampering fails closed before acknowledgement');
    assert(JSON.parse(readFileSync(acknowledgementCursorPath, 'utf8')).byteOffset === 200, 'tampered terminal item cannot move the acknowledgement cursor');
    writeFileSync(obsoletePath, terminalItemBytes, 'utf8');

    const modifiedEpisodes: string[] = [];
    const drained = await processEpisodeMirrorOutbox(async item => {
      if (item.terminalResolution) {
        const nextOffset = advanceEpisodeMirrorAcknowledgement(item, paths);
        settleCanonicalCaptureReceiptsForInvalidDestination(
          item.terminalResolution.evidence.map(evidence => ({
            turnId: evidence.captureId,
            evidenceDisposition: evidence.disposition,
          })),
          nextOffset,
          item.terminalResolution.auditPath,
          item.terminalResolution.reason,
          receiptPaths,
        );
        return true;
      }
      modifiedEpisodes.push(item.liveEpisode);
      const nextOffset = advanceEpisodeMirrorAcknowledgement(item, paths);
      settleCanonicalCaptureReceiptsByTurnId(item.captureIds, nextOffset, receiptPaths);
      return true;
    }, paths);
    assert(drained.processed === 2 && drained.pending === 0, 'audited invalid head no longer blocks a later valid mirror');
    assert(!modifiedEpisodes.includes('episode-31.md'), 'removed or sealed episode destination is never modified');
    assert(modifiedEpisodes.join(',') === 'episode-33.md', 'later valid mirror completes after audited resolution');
    const obsoleteReceipt = JSON.parse(readFileSync(join(receiptDir, 'obsolete.json'), 'utf8'));
    assert(obsoleteReceipt.status === 'audited-invalid-destination', 'invalid destination receipt remains operator-visible instead of looking acknowledged');
    assert(obsoleteReceipt.evidenceDisposition === 'deliberately-unresolved', 'receipt states whether source was canonical or deliberately unresolved');
    assert(JSON.parse(readFileSync(join(receiptDir, 'later.json'), 'utf8')).status === 'acknowledged', 'later valid receipt is acknowledged normally');

    const firstAuditBytes = readFileSync(resolution.auditPath, 'utf8');
    const repeatedPath = enqueueEpisodeMirror(obsolete, paths);
    const laterResolution = await resolveEpisodeMirrorDestinationInvalid(repeatedPath, {
      destinationState: 'removed',
      reason: 'independent later operator decision',
      operator: 'second-ci-operator',
      evidence: [{
        captureId: 'obsolete',
        disposition: 'deliberately-unresolved',
        reason: 'second resolution keeps the original audit immutable',
      }],
      resolvedAtMs: 1_788_500_000_001,
    }, paths);
    assert(laterResolution.auditPath !== resolution.auditPath, 'independent resolutions use collision-proof content-addressed audit paths');
    assert(readFileSync(resolution.auditPath, 'utf8') === firstAuditBytes, 'a later resolution cannot overwrite the earlier audit');
    rmSync(repeatedPath, { force: true });

    const autosaveSource = readFileSync(
      join(process.cwd(), 'server/services/agent-session-autosave.ts'),
      'utf8',
    );
    // Both branches assign episodeOk before the one success guard: the
    // framed common append (ATTRIBUTION_WRITERS_V1) and the legacy DB-first append.
    const framedAppendIndex = autosaveSource.indexOf('episodeOk = await appendFramedEpisodeMirror(item);');
    const normalAppendIndex = autosaveSource.indexOf('episodeOk = await appendInnerLifeToEpisodeDb(', framedAppendIndex);
    assert(framedAppendIndex !== -1, 'the framed branch assigns episodeOk before the success guard');
    const failedAppendGuardIndex = autosaveSource.indexOf('if (!episodeOk) return false;', normalAppendIndex);
    const normalAdvanceIndex = autosaveSource.indexOf(
      'const acknowledgementOffset = advanceEpisodeMirrorAcknowledgement(item);',
      failedAppendGuardIndex,
    );
    assert(
      normalAppendIndex !== -1 &&
      failedAppendGuardIndex > normalAppendIndex &&
      normalAdvanceIndex > failedAppendGuardIndex,
      'production worker advances normal acknowledgement only after episode append success',
    );

    const stale: EpisodeMirrorOutboxItem = {
      ...later,
      startCursor: 350,
      endOffset: 450,
      appendMarker: '<!-- chat-capture-range:350:450 -->',
      captureIds: ['stale'],
    };
    const stalePath = enqueueEpisodeMirror(stale, paths);
    saveChatCaptureCursor({ byteOffset: 500, lastSavedTurnFingerprint: 'newer' }, acknowledgementCursorPath);
    const monotonicOffset = advanceEpisodeMirrorAcknowledgement(stale, paths);
    assert(monotonicOffset === 500, 'stale outbox replay cannot move the acknowledgement cursor backward');
    assert(JSON.parse(readFileSync(acknowledgementCursorPath, 'utf8')).lastSavedTurnFingerprint === 'newer', 'stale replay preserves the newer acknowledgement fingerprint');
    rmSync(stalePath, { force: true });

    const raceItem: EpisodeMirrorOutboxItem = {
      ...later,
      startCursor: 500,
      endOffset: 600,
      appendMarker: '<!-- chat-capture-range:500:600 -->',
      captureIds: ['race'],
    };
    const racePath = enqueueEpisodeMirror(raceItem, paths);
    writeCanonicalCaptureReceipt({
      turnId: 'race',
      targetByteOffset: 600,
      createdAtMs: Date.now(),
      source: 'replit',
      status: 'pending',
    }, receiptPaths);
    let releaseProcessor!: () => void;
    const processorEntered = new Promise<void>(resolve => { releaseProcessor = resolve; });
    let signalEntered!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const inFlightDrain = processEpisodeMirrorOutbox(async () => {
      signalEntered();
      await processorEntered;
      return false;
    }, paths);
    await entered;
    let concurrentResolutionRejected = false;
    try {
      await resolveEpisodeMirrorDestinationInvalid(racePath, {
        destinationState: 'sealed',
        reason: 'race test',
        operator: 'ci-operator',
        evidence: [{
          captureId: 'race',
          disposition: 'deliberately-unresolved',
          reason: 'race fixture',
        }],
      }, paths);
    } catch {
      concurrentResolutionRejected = true;
    }
    releaseProcessor();
    await inFlightDrain;
    assert(concurrentResolutionRejected, 'resolver cannot race an in-flight mirror append');
    assert(!listEpisodeMirrorOutbox(paths).find(entry => entry.path === racePath)?.item.terminalResolution, 'failed concurrent resolution cannot resurrect or rewrite the in-flight item');
    rmSync(racePath, { force: true });

    writeFileSync(join(directory, '00000000000000000300-corrupt.json'), '{', 'utf8');
    let malformedFailedClosed = false;
    try {
      await processEpisodeMirrorOutbox(async () => true, paths);
    } catch {
      malformedFailedClosed = true;
    }
    assert(malformedFailedClosed, 'malformed outbox item fails closed instead of skipping an acknowledgement boundary');

    console.log(`\nPASS — ${passed} episode-outbox assertions`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL — ${error?.message ?? error}`);
  process.exit(1);
});