/**
 * Claude Code transcript mirror: server side of the recording-gap design R6.5,
 * stage R-P1 (preservation staging only).
 *
 * - Ingest stores privacy-filtered entries as immutable observations of the exact
 *   tuple (session, position, uuid, content hash). A changed, reused or moved
 *   entry is a NEW observation with a flag; nothing is updated or overwritten.
 * - Coverage is compared through per-block digests against the last local digest
 *   the server verified it holds in full (confirmed_local_digest), never against a
 *   digest of everything it holds (that superset never equals the local set once
 *   variants exist).
 * - Challenges are issued here; consuming them for quiescence is stage R-P2.
 *
 * Nothing in this file publishes canonical dialogue, and nothing here is read by
 * Daniela's recall. Every write for one session runs under a per-session
 * transaction advisory lock, so flag computation is not raced by a concurrent sync.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  claudeCodeBlockConfirmations,
  claudeCodeEntryContents,
  claudeCodeEntryObservations,
  claudeCodeHookEvidence,
  claudeCodeSessionRoots,
  claudeCodeSyncChallenges,
} from '@shared/schema';
import {
  BLOCK_SIZE,
  blockDigest,
  blockIndexOf,
  canonicalJson,
  rootDigest,
  sha256Hex,
  tupleKey,
  type MirrorBlock,
  type MirrorTuple,
} from '@shared/claude-code-mirror-core.mjs';
import { getSharedDb } from '../db';
import {
  MIRROR_LIMITS, MirrorInputError, SHA, assertPosition, assertSessionId, normalizeUuid, observationFlags, prepareEntry,
  type IncomingEntry,
} from './claude-code-mirror-rules';

export { MirrorInputError } from './claude-code-mirror-rules';

type Tx = Parameters<Parameters<ReturnType<typeof getSharedDb>['transaction']>[0]>[0];

async function withSessionLock<T>(sessionId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSharedDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'claude-code-mirror:' + sessionId}, 0))`);
    return fn(tx);
  });
}

export interface IngestResult { stored: number; alreadyHeld: number; flagged: Array<{ position: number; flags: string[] }> }

export async function ingestEntries(actor: string, sessionIdInput: unknown, entriesInput: unknown): Promise<IngestResult> {
  const sessionId = assertSessionId(sessionIdInput);
  if (!Array.isArray(entriesInput) || entriesInput.length === 0 || entriesInput.length > MIRROR_LIMITS.maxEntriesPerBatch) {
    throw new MirrorInputError(`entries must be 1 to ${MIRROR_LIMITS.maxEntriesPerBatch} items`);
  }
  const prepared = entriesInput.map((e) => prepareEntry(e as IncomingEntry));
  return withSessionLock(sessionId, async (tx) => {
    const positions = [...new Set(prepared.map((p) => p.position))];
    const uuids = [...new Set(prepared.map((p) => p.uuid).filter(Boolean))];
    const heldRows = await tx.select({
      position: claudeCodeEntryObservations.sourcePosition,
      uuid: claudeCodeEntryObservations.entryUuid,
      sha256: claudeCodeEntryObservations.contentSha256,
    }).from(claudeCodeEntryObservations).where(and(
      eq(claudeCodeEntryObservations.sessionId, sessionId),
      uuids.length
        ? sql`(${inArray(claudeCodeEntryObservations.sourcePosition, positions)} or ${inArray(claudeCodeEntryObservations.entryUuid, uuids)})`
        : inArray(claudeCodeEntryObservations.sourcePosition, positions),
    ));
    const held = heldRows.map((r) => ({ position: r.position, uuid: r.uuid, sha256: r.sha256 }));
    const heldKeys = new Set(held.map((h) => tupleKey(h.position, h.uuid, h.sha256)));
    const result: IngestResult = { stored: 0, alreadyHeld: 0, flagged: [] };
    for (const p of prepared) {
      const key = tupleKey(p.position, p.uuid, p.sha256);
      if (heldKeys.has(key)) { result.alreadyHeld += 1; continue; }
      const flags = observationFlags(p, held);
      await tx.insert(claudeCodeEntryContents)
        .values({ sessionId, contentSha256: p.sha256, entry: p.entry, byteLength: p.byteLength })
        .onConflictDoNothing();
      await tx.insert(claudeCodeEntryObservations)
        .values({ sessionId, sourcePosition: p.position, entryUuid: p.uuid, contentSha256: p.sha256, flags, actor })
        .onConflictDoNothing();
      held.push({ position: p.position, uuid: p.uuid, sha256: p.sha256 });
      heldKeys.add(key);
      result.stored += 1;
      if (flags.some((f) => f !== 'no-uuid')) result.flagged.push({ position: p.position, flags });
    }
    return result;
  });
}

function assertBlocks(value: unknown): MirrorBlock[] {
  if (!Array.isArray(value) || value.length > MIRROR_LIMITS.maxBlocksPerCoverage) throw new MirrorInputError('invalid blocks');
  const seen = new Set<number>();
  return value.map((b) => {
    const index = (b as MirrorBlock)?.index;
    const digest = (b as MirrorBlock)?.digest;
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) throw new MirrorInputError('invalid block index');
    if (typeof digest !== 'string' || !SHA.test(digest)) throw new MirrorInputError('invalid block digest');
    seen.add(index);
    return { index, digest };
  });
}

/** Returns the blocks whose local digest is not the confirmed one. Confirms the root when none differ. */
export async function compareCoverage(actor: string, sessionIdInput: unknown, blocksInput: unknown): Promise<{ differing: number[]; rootConfirmed: boolean }> {
  const sessionId = assertSessionId(sessionIdInput);
  const blocks = assertBlocks(blocksInput);
  return withSessionLock(sessionId, async (tx) => {
    const confirmed = await tx.select().from(claudeCodeBlockConfirmations).where(eq(claudeCodeBlockConfirmations.sessionId, sessionId));
    const byIndex = new Map(confirmed.map((c) => [c.blockIndex, c.confirmedLocalDigest]));
    const differing = blocks.filter((b) => byIndex.get(b.index) !== b.digest).map((b) => b.index).sort((a, b) => a - b);
    if (differing.length > 0 || blocks.length === 0) return { differing, rootConfirmed: false };
    const root = rootDigest(sessionId, blocks);
    await tx.insert(claudeCodeSessionRoots).values({ sessionId, actor, confirmedRootDigest: root })
      .onConflictDoUpdate({ target: claudeCodeSessionRoots.sessionId, set: { confirmedRootDigest: root, actor, confirmedAt: sql`clock_timestamp()` } });
    return { differing, rootConfirmed: true };
  });
}

/**
 * For one block, returns the local tuples the server does not hold. When it holds
 * all of them, records the local digest as confirmed. The digest is recomputed
 * here, so a client cannot confirm a digest that does not match its tuples.
 */
export async function checkBlockTuples(sessionIdInput: unknown, blockIndexInput: unknown, localDigestInput: unknown, tuplesInput: unknown): Promise<{ missing: MirrorTuple[]; confirmed: boolean }> {
  const sessionId = assertSessionId(sessionIdInput);
  const blockIndex = blockIndexInput as number;
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new MirrorInputError('invalid blockIndex');
  if (typeof localDigestInput !== 'string' || !SHA.test(localDigestInput)) throw new MirrorInputError('invalid localDigest');
  if (!Array.isArray(tuplesInput) || tuplesInput.length > BLOCK_SIZE * 8) throw new MirrorInputError('invalid tuples');
  const tuples: MirrorTuple[] = tuplesInput.map((t) => {
    const position = assertPosition((t as MirrorTuple)?.position);
    if (blockIndexOf(position) !== blockIndex) throw new MirrorInputError(`tuple position ${position} is outside block ${blockIndex}`);
    const sha256 = (t as MirrorTuple)?.sha256;
    if (typeof sha256 !== 'string' || !SHA.test(sha256)) throw new MirrorInputError('invalid tuple sha256');
    return { position, uuid: normalizeUuid((t as MirrorTuple)?.uuid), sha256 };
  });
  if (blockDigest(sessionId, tuples) !== localDigestInput) throw new MirrorInputError('localDigest does not match tuples');
  return withSessionLock(sessionId, async (tx) => {
    const lo = blockIndex * BLOCK_SIZE;
    const rows = await tx.select({
      position: claudeCodeEntryObservations.sourcePosition,
      uuid: claudeCodeEntryObservations.entryUuid,
      sha256: claudeCodeEntryObservations.contentSha256,
    }).from(claudeCodeEntryObservations).where(and(
      eq(claudeCodeEntryObservations.sessionId, sessionId),
      sql`${claudeCodeEntryObservations.sourcePosition} >= ${lo} and ${claudeCodeEntryObservations.sourcePosition} < ${lo + BLOCK_SIZE}`,
    ));
    const held = new Set(rows.map((r) => tupleKey(r.position, r.uuid, r.sha256)));
    const missing = tuples.filter((t) => !held.has(tupleKey(t.position, t.uuid, t.sha256)));
    if (missing.length > 0) return { missing, confirmed: false };
    await tx.insert(claudeCodeBlockConfirmations).values({ sessionId, blockIndex, confirmedLocalDigest: localDigestInput })
      .onConflictDoUpdate({
        target: [claudeCodeBlockConfirmations.sessionId, claudeCodeBlockConfirmations.blockIndex],
        set: { confirmedLocalDigest: localDigestInput, confirmedAt: sql`clock_timestamp()` },
      });
    return { missing, confirmed: true };
  });
}

/** Confirmed root digest per session, or 'unknown' for a session the server has never confirmed. */
export async function confirmedRoots(sessionIdsInput: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(sessionIdsInput) || sessionIdsInput.length > MIRROR_LIMITS.maxSessionsPerRootQuery) throw new MirrorInputError('invalid sessionIds');
  const ids = [...new Set(sessionIdsInput.map(assertSessionId))];
  const out: Record<string, string> = Object.fromEntries(ids.map((id) => [id, 'unknown']));
  if (ids.length === 0) return out;
  const rows = await getSharedDb().select().from(claudeCodeSessionRoots).where(inArray(claudeCodeSessionRoots.sessionId, ids));
  for (const r of rows) out[r.sessionId] = r.confirmedRootDigest;
  return out;
}

/** Issues a quiescence challenge (server clock). Consumption is stage R-P2. */
export async function issueChallenge(actor: string, sessionIdInput: unknown): Promise<{ challengeId: string; issuedAt: string }> {
  const sessionId = assertSessionId(sessionIdInput);
  const [row] = await getSharedDb().insert(claudeCodeSyncChallenges).values({ sessionId, actor }).returning();
  return { challengeId: row.id, issuedAt: new Date(row.issuedAt).toISOString() };
}

const OCCURRENCE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Stores hook-side evidence. Idempotent per (occurrence id, bytes); the same
 * occurrence id with different bytes is kept as a new row flagged conflict.
 */
export async function recordHookEvidence(actor: string, input: unknown): Promise<{ stored: boolean; conflict: boolean }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const sessionId = assertSessionId(body.sessionId);
  if (typeof body.occurrenceId !== 'string' || !OCCURRENCE.test(body.occurrenceId)) throw new MirrorInputError('invalid occurrenceId');
  if (body.kind !== 'submitted-prompt' && body.kind !== 'last-assistant-message') throw new MirrorInputError('invalid kind');
  if (typeof body.text !== 'string' || Buffer.byteLength(body.text, 'utf8') > MIRROR_LIMITS.maxEvidenceBytes) throw new MirrorInputError('invalid text');
  const lineCount = body.transcriptLineCount;
  if (lineCount !== undefined && lineCount !== null && (!Number.isSafeInteger(lineCount) || (lineCount as number) < 0)) {
    throw new MirrorInputError('invalid transcriptLineCount');
  }
  const occurrenceId = body.occurrenceId;
  // Every accepted field is part of the identity, so a retransmission that differs in
  // any of them (anchor metadata included) is kept as a flagged conflict, never dropped.
  const sha = sha256Hex(canonicalJson({ kind: body.kind, sessionId, text: body.text, transcriptLineCount: lineCount ?? null }));
  return withSessionLock(sessionId, async (tx) => {
    const existing = await tx.select({ sha: claudeCodeHookEvidence.contentSha256 }).from(claudeCodeHookEvidence)
      .where(eq(claudeCodeHookEvidence.occurrenceId, occurrenceId));
    if (existing.some((e) => e.sha === sha)) return { stored: false, conflict: false };
    const conflict = existing.length > 0;
    await tx.insert(claudeCodeHookEvidence).values({
      occurrenceId, contentSha256: sha, sessionId, kind: body.kind as string, text: body.text as string,
      transcriptLineCount: (lineCount as number | undefined) ?? null, conflict, actor,
    });
    return { stored: true, conflict };
  });
}
