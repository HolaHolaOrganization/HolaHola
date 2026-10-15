import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  coordinationCredentialAuditEvents, coordinationEvents, coordinationInboxItems,
  coordinationRuntimeCredentials, coordinationRuntimeInboxWindowItems,
  coordinationRuntimeInboxWindows, coordinationRuntimePackets, coordinationRuntimeProfiles,
  coordinationRuntimeRegistrations, coordinationGate3ProofGrants, coordinationThreads,
  taskOwnershipChallenges, taskOwnershipReceipts,
} from "@shared/schema";
import { getSharedDb } from "../db";
import { getVerifiedCiDatabaseUrl } from "../ci-database";
import { createCoordinationThread } from "./coordination-ledger-service";
import { PostgresCoordinationRuntimeRepository } from "./coordination-runtime-postgres-repository";
import { digestCanonical } from "./coordination-runtime";
import {
  GATE3, deriveAntigravityRuntimeId, type PublicProvisioningBundle,
  validatePublicProvisioningBundle,
} from "./antigravity-provisioning-bundle";
import {
  GATE3_TASK_ARTIFACT_MAX_BYTES,
  Gate3TaskArtifactMaterializationError,
  materializeGate3TaskArtifact,
} from "./gate3-task-artifact-materializer";

const MAX_BUNDLE_BYTES = 1024 * 1024;
const GATE3_TASK_ARTIFACT_PATH = resolve(process.cwd(), "server/templates/task-1448.md");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARGIN_MS = 10 * 60_000 + 30_000;

export class Gate3AssignmentWindowError extends Error {
  readonly code: string;
  constructor(code: string) { super(`gate3_assignment_window_${code}`); this.name = "Gate3AssignmentWindowError"; this.code = code; }
}
const fail = (code: string): never => { throw new Gate3AssignmentWindowError(code); };
const same = (a: unknown, b: unknown) => digestCanonical(a) === digestCanonical(b);
const AUDIT_KEYS = [
  "assignmentAttemptId", "receiptId", "threadId", "assignmentEventId",
  "runtimeInboxItemId", "windowId", "boundaryDigest", "artifactSha256", "bundleDigest",
] as const;

export type AssignmentWindowResult = {
  assignmentAttemptId: string; threadId: string; assignmentEventId: string;
  runtimeInboxItemId: string; windowId: string; boundaryDigest: string;
  expectedSequence: number; receiptId: string; artifactDigest: string; bundleDigest: string;
};

export type Gate3AssignmentWindowTestHooks = {
  taskArtifactPath?: string;
  afterTaskArtifactStat?: () => Promise<void>;
  afterPartialEventChecked?: () => Promise<void>;
  afterCanonicalThreadCreated?: () => Promise<void>;
  afterRuntimeInboxItemCreated?: () => Promise<void>;
  afterWindowFrozen?: () => Promise<void>;
  afterAuditCreated?: () => Promise<void>;
};

export function validateGate3AssignmentBundle(value: unknown): PublicProvisioningBundle {
  try { validatePublicProvisioningBundle(value); } catch { fail("invalid_bundle"); }
  const bundle = value as PublicProvisioningBundle;
  if (!bundle.bundleDigest) fail("invalid_bundle");
  return bundle;
}

async function readApprovedTaskArtifact(
  startingCommit: string,
  artifactPath = GATE3_TASK_ARTIFACT_PATH,
  afterStat?: () => Promise<void>,
): Promise<{ sha256: string; text: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      artifactPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > GATE3_TASK_ARTIFACT_MAX_BYTES) {
      fail("artifact_invalid");
    }
    await afterStat?.();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(
        16 * 1024,
        GATE3_TASK_ARTIFACT_MAX_BYTES + 1 - total,
      ));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > GATE3_TASK_ARTIFACT_MAX_BYTES) fail("artifact_invalid");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    if (total < 1) fail("artifact_invalid");
    const bytes = Buffer.concat(chunks, total);
    try {
      const artifact = materializeGate3TaskArtifact(bytes, startingCommit);
      return { sha256: artifact.sha256, text: artifact.text };
    } catch (error) {
      if (error instanceof Gate3TaskArtifactMaterializationError) fail(error.code);
      throw error;
    }
  } catch (error) {
    if (error instanceof Gate3AssignmentWindowError) throw error;
    throw new Gate3AssignmentWindowError("artifact_read_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function profileMatches(row: any, b: PublicProvisioningBundle) {
  return row.id === `antigravity-${b.bundleDigest}`
    && row.runtimeRegistrationId === b.runtimeId && row.actor === b.actor
    && same(row.capabilities, b.runtimeCapabilities) && row.provider === b.provider
    && row.model === b.model && row.adapterVersion === b.adapterVersion
    && row.repositoryLabel === b.repositoryLabel && row.worktreeLabel === b.worktreeLabel
    && row.worktreeRealpathDigest === b.worktreeRealpathDigest && row.branch === b.branch
    && row.startingCommit === b.startingCommit && row.status === "active";
}
function registrationMatches(row: any, b: PublicProvisioningBundle) {
  return row.id === b.runtimeId && row.actor === b.actor && row.displayName === b.worktreeLabel
    && same(row.capabilities, b.credentialCapabilities) && row.tokenTtlSeconds === b.tokenTtlSeconds
    && row.enabled && !row.revokedAt;
}
function resultFrom(a: any): AssignmentWindowResult {
  const m = a.metadata as Record<string, unknown>;
  return {
    assignmentAttemptId: String(m.assignmentAttemptId), threadId: String(m.threadId),
    assignmentEventId: String(m.assignmentEventId), runtimeInboxItemId: String(m.runtimeInboxItemId),
    windowId: String(m.windowId), boundaryDigest: String(m.boundaryDigest),
    expectedSequence: 1, receiptId: String(m.receiptId),
    artifactDigest: String(m.artifactSha256), bundleDigest: String(m.bundleDigest),
  };
}

export async function createGate3AssignmentWindow(input: {
  bundle: unknown; receiptId: string; assignmentAttemptId: string;
  testHooks?: Gate3AssignmentWindowTestHooks;
}): Promise<AssignmentWindowResult> {
  if (input.testHooks && !getVerifiedCiDatabaseUrl()) {
    throw new Error("gate3_assignment_window_test_hooks_require_disposable_database");
  }
  const bundle = validateGate3AssignmentBundle(input.bundle);
  if (!UUID.test(input.assignmentAttemptId) || input.assignmentAttemptId !== input.assignmentAttemptId.toLowerCase()) fail("attempt_id_invalid");
  if (!input.receiptId || input.receiptId.length > 255) fail("receipt_invalid");
  const taskArtifact = await readApprovedTaskArtifact(
    bundle.startingCommit,
    input.testHooks?.taskArtifactPath,
    input.testHooks?.afterTaskArtifactStat,
  );
  if (taskArtifact.sha256 !== bundle.artifactSha256) fail("artifact_digest_mismatch");
  const attempt = input.assignmentAttemptId;
  const key = `gate3-assignment:${bundle.bundleDigest}:${attempt}`;
  return getSharedDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${bundle.runtimeId}, 0))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const priorRows = await tx.select().from(coordinationCredentialAuditEvents).where(and(
      eq(coordinationCredentialAuditEvents.eventType, "gate3_assignment_window_created"),
      eq(coordinationCredentialAuditEvents.success, true),
      eq(coordinationCredentialAuditEvents.runtimeId, bundle.runtimeId),
    )).orderBy(desc(coordinationCredentialAuditEvents.createdAt));
    const prior = priorRows.find((row) =>
      (row.metadata as Record<string, unknown> | undefined)?.assignmentAttemptId === attempt);
    const pm = prior?.metadata as Record<string, unknown> | undefined;
    if (prior && pm?.assignmentAttemptId === attempt) {
      if (Object.keys(pm).length !== AUDIT_KEYS.length
        || !AUDIT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(pm, key))
        || pm.bundleDigest !== bundle.bundleDigest || pm.receiptId !== input.receiptId
        || pm.artifactSha256 !== bundle.artifactSha256) fail("attempt_binding_conflict");
      const threads = await tx.select().from(coordinationThreads).where(eq(coordinationThreads.id, pm.threadId as string));
      const events = await tx.select().from(coordinationEvents).where(eq(coordinationEvents.id, pm.assignmentEventId as string));
      const items = await tx.select().from(coordinationRuntimeInboxWindowItems).where(eq(coordinationRuntimeInboxWindowItems.itemId, pm.runtimeInboxItemId as string));
      const windows = await tx.select().from(coordinationRuntimeInboxWindows).where(eq(coordinationRuntimeInboxWindows.id, pm.windowId as string));
      const ordinaryRows = await tx.select().from(coordinationInboxItems).where(and(
        eq(coordinationInboxItems.coordinationEventId, pm.assignmentEventId as string),
        eq(coordinationInboxItems.recipientActor, GATE3.actor),
      ));
      const [thread] = threads, [event] = events, [item] = items, [window] = windows, [ordinary] = ordinaryRows;
      if (!thread || !event || !item || !window || !ordinary
        || threads.length !== 1 || events.length !== 1 || items.length !== 1 || windows.length !== 1 || ordinaryRows.length !== 1
        || thread.title !== "Gate 3 task 1448 assignment"
        || thread.description !== "Approved Gate 3 assignment for task 1448."
        || thread.originActor !== "luca-replit" || thread.intendedRecipient !== GATE3.actor || thread.latestSequence !== 1
        || event.threadId !== thread.id || event.id !== item.eventId || item.windowId !== window.id
        || event.sequence !== 1 || event.actor !== "luca-replit" || event.recipientActor !== GATE3.actor
        || event.eventType !== "created" || event.idempotencyKey !== key
        || event.content !== "Gate 3 task 1448 assignment."
        || item.threadId !== thread.id || item.taskId !== GATE3.taskRef || item.sequence !== 1
        || !same(item.payload, event.payload)
        || ordinary.coordinationEventId !== event.id || ordinary.coordinationThreadId !== thread.id
        || ordinary.recipientActor !== GATE3.actor || ordinary.senderActor !== "luca-replit"
        || ordinary.messageKind !== "created"
        || window.threadId !== thread.id || window.boundaryDigest !== pm.boundaryDigest
        || item.itemDigest !== digestCanonical({
          id: item.itemId, eventId: item.eventId, threadId: item.threadId,
          taskId: item.taskId, sequence: item.sequence, payload: item.payload,
        })
        || !same(window.orderedItemIds, [item.itemId])
        || window.afterExclusive !== 0 || window.throughInclusive !== 1
        || !same(window.canonicalPayload, {
          threadId: thread.id, afterExclusive: 0, throughInclusive: 1,
          boundaryToken: window.boundaryToken, orderedItemIds: [item.itemId],
          itemDigests: [item.itemDigest],
        })
        || window.boundaryDigest !== digestCanonical({
          threadId: thread.id, afterExclusive: 0, throughInclusive: 1,
          boundaryToken: window.boundaryToken, orderedItemIds: [item.itemId],
          itemDigests: [item.itemDigest],
        })
        || !same(event.payload, {
          kind: "gate3_assignment", receiptId: input.receiptId,
          artifactSha256: bundle.artifactSha256, bundleDigest: bundle.bundleDigest,
          taskArtifact,
          content: { assignment: { author: "luca-replit", taskId: "1448", expectedSequence: 1 } },
        })) fail("attempt_corrupt");
      const receipts = await tx.select().from(taskOwnershipReceipts).where(eq(taskOwnershipReceipts.id, input.receiptId));
      const [receipt] = receipts;
      const challenges = receipt ? await tx.select().from(taskOwnershipChallenges).where(eq(taskOwnershipChallenges.id, receipt.challengeId)) : [];
      const [challenge] = challenges;
      if (receipts.length !== 1 || challenges.length !== 1 || !receipt || !challenge
        || receipt.id !== input.receiptId || receipt.challengeId !== challenge.id
        || receipt.taskRef !== "1448" || receipt.intendedActor !== GATE3.actor
        || receipt.artifactSha256 !== bundle.artifactSha256 || receipt.publicKey !== bundle.publicKey
        || receipt.keyFingerprint !== bundle.keyFingerprint || receipt.contextDigest !== bundle.bundleDigest
        || challenge.purpose !== "runtime_provisioning"
        || challenge.taskRef !== receipt.taskRef || challenge.artifactSha256 !== receipt.artifactSha256
        || challenge.intendedActor !== receipt.intendedActor || challenge.coordinationActor !== GATE3.actor
        || challenge.publicKey !== receipt.publicKey || challenge.keyFingerprint !== receipt.keyFingerprint
        || challenge.contextDigest !== receipt.contextDigest) fail("attempt_corrupt");
      return resultFrom(prior);
    }
    const [registration] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, bundle.runtimeId)).for("update");
    const [profile] = await tx.select().from(coordinationRuntimeProfiles)
      .where(and(eq(coordinationRuntimeProfiles.id, `antigravity-${bundle.bundleDigest}`),
        eq(coordinationRuntimeProfiles.runtimeRegistrationId, bundle.runtimeId),
        eq(coordinationRuntimeProfiles.status, "active"))).for("update");
    const [receipt] = await tx.select().from(taskOwnershipReceipts).where(eq(taskOwnershipReceipts.id, input.receiptId)).for("update");
    const [challenge] = receipt ? await tx.select().from(taskOwnershipChallenges).where(eq(taskOwnershipChallenges.id, receipt.challengeId)).for("update") : [];
    const now = Date.now();
    if (!receipt || !challenge || receipt.status !== "active" || receipt.revokedAt || receipt.expiresAt.getTime() - now <= MARGIN_MS
      || challenge.status !== "approved" || challenge.expiresAt.getTime() <= now
      || receipt.taskRef !== "1448" || receipt.intendedActor !== GATE3.actor
      || receipt.artifactSha256 !== bundle.artifactSha256 || receipt.publicKey !== bundle.publicKey
      || receipt.keyFingerprint !== bundle.keyFingerprint || receipt.contextDigest !== bundle.bundleDigest
      || challenge.purpose !== "runtime_provisioning"
      || challenge.taskRef !== receipt.taskRef || challenge.artifactSha256 !== receipt.artifactSha256
      || challenge.intendedActor !== GATE3.actor || challenge.coordinationActor !== GATE3.actor
      || challenge.publicKey !== receipt.publicKey || challenge.keyFingerprint !== receipt.keyFingerprint
      || challenge.contextDigest !== receipt.contextDigest) fail("receipt_invalid");
    const generations = await tx.select().from(coordinationCredentialAuditEvents).where(and(
      eq(coordinationCredentialAuditEvents.runtimeId, bundle.runtimeId),
      eq(coordinationCredentialAuditEvents.eventType, "runtime_generation_provisioned"),
      eq(coordinationCredentialAuditEvents.success, true),
    )).limit(2);
    const [generation] = generations;
    const gm = generation?.metadata as Record<string, unknown> | undefined;
    const generationFields: Record<string, unknown> = {
      runtimeId: bundle.runtimeId,
      profileId: `antigravity-${bundle.bundleDigest}`,
      challengeId: challenge.id,
      receiptId: input.receiptId,
      actor: bundle.actor,
      taskRef: bundle.taskRef,
      artifactSha256: bundle.artifactSha256,
      keyFingerprint: bundle.keyFingerprint,
      bundleDigest: bundle.bundleDigest,
      bootstrapSha256: bundle.bootstrapSha256,
      worktreeRealpathDigest: bundle.worktreeRealpathDigest,
      startingCommit: bundle.startingCommit,
    };
    if (!registration || !profile
      || !registrationMatches(registration, bundle) || !profileMatches(profile, bundle)
      || generations.length !== 1 || !generation || !gm
      || Object.entries(generationFields).some(([key, expected]) => gm[key] !== expected)
      || typeof gm.bootstrapSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(gm.bootstrapSha256)
      || deriveAntigravityRuntimeId(gm.bootstrapSha256) !== bundle.runtimeId
      || gm.registrationOutcome !== "created") fail("generation_provisioning_missing");
    const [credential] = await tx.select().from(coordinationRuntimeCredentials).where(and(
      eq(coordinationRuntimeCredentials.runtimeId, bundle.runtimeId), isNull(coordinationRuntimeCredentials.revokedAt), gt(coordinationRuntimeCredentials.expiresAt, new Date()),
    ));
    const [grant] = await tx.select().from(coordinationGate3ProofGrants).where(and(
      eq(coordinationGate3ProofGrants.runtimeRegistrationId, bundle.runtimeId), isNull(coordinationGate3ProofGrants.revokedAt), gt(coordinationGate3ProofGrants.expiresAt, new Date()),
    ));
    const [packet] = await tx.select().from(coordinationRuntimePackets).where(eq(coordinationRuntimePackets.runtimeRegistrationId, bundle.runtimeId)).limit(1);
    if (credential) fail("live_credential");
    if (grant) fail("live_grant");
    if (packet) fail("packet_history");
    const [partialEvent] = await tx.select({ id: coordinationEvents.id }).from(coordinationEvents).where(and(
      eq(coordinationEvents.actor, "luca-replit"),
      eq(coordinationEvents.idempotencyKey, key),
    )).limit(1);
    if (partialEvent) fail("attempt_corrupt");
    await input.testHooks?.afterPartialEventChecked?.();
    const payload = {
      kind: "gate3_assignment", receiptId: input.receiptId, artifactSha256: bundle.artifactSha256,
      bundleDigest: bundle.bundleDigest,
      taskArtifact,
      content: { assignment: { author: "luca-replit", taskId: "1448", expectedSequence: 1 } },
    };
    const mutation = await createCoordinationThread({
      actor: "luca-replit", intendedRecipient: GATE3.actor, title: "Gate 3 task 1448 assignment",
      description: "Approved Gate 3 assignment for task 1448.", content: "Gate 3 task 1448 assignment.",
      priority: "normal", payload, idempotencyKey: key, createInboxDelivery: false,
    }, tx);
    await input.testHooks?.afterCanonicalThreadCreated?.();
    const canonicalPayload = mutation.event.payload as typeof payload;
    const canonicalAssignment = canonicalPayload?.content?.assignment;
    if (
      mutation.thread.title !== "Gate 3 task 1448 assignment"
      || mutation.thread.description !== "Approved Gate 3 assignment for task 1448."
      || mutation.thread.originActor !== "luca-replit"
      || mutation.thread.intendedRecipient !== GATE3.actor
      || mutation.thread.latestSequence !== 1
      || mutation.event.threadId !== mutation.thread.id
      || mutation.event.sequence !== 1
      || mutation.event.actor !== "luca-replit"
      || mutation.event.recipientActor !== GATE3.actor
      || mutation.event.eventType !== "created"
      || mutation.event.idempotencyKey !== key
      || mutation.event.content !== "Gate 3 task 1448 assignment."
      || !same(canonicalPayload, payload)
      || canonicalPayload.kind !== "gate3_assignment"
      || canonicalPayload.receiptId !== input.receiptId
      || canonicalPayload.artifactSha256 !== bundle.artifactSha256
      || canonicalPayload.bundleDigest !== bundle.bundleDigest
      || canonicalPayload.taskArtifact?.sha256 !== bundle.artifactSha256
      || canonicalPayload.taskArtifact?.text !== taskArtifact.text
      || canonicalAssignment?.author !== "luca-replit"
      || canonicalAssignment?.taskId !== GATE3.taskRef
      || canonicalAssignment?.expectedSequence !== mutation.event.sequence
    ) {
      fail("canonical_assignment_invalid");
    }
    const item = {
      id: `gate3-assignment-${mutation.event.id}`,
      eventId: mutation.event.id,
      threadId: mutation.event.threadId,
      taskId: canonicalAssignment.taskId,
      sequence: mutation.event.sequence,
      payload: canonicalPayload,
    };
    const repository = new PostgresCoordinationRuntimeRepository(tx);
    await repository.addInboxItem(item);
    await input.testHooks?.afterRuntimeInboxItemCreated?.();
    const window = await repository.freezeInboxWindow(mutation.thread.id, 0, 1, randomUUID());
    await input.testHooks?.afterWindowFrozen?.();
    const metadata = {
      assignmentAttemptId: attempt, receiptId: input.receiptId, threadId: mutation.thread.id,
      assignmentEventId: mutation.event.id, runtimeInboxItemId: item.id, windowId: window.id,
      boundaryDigest: window.boundaryDigest, artifactSha256: bundle.artifactSha256, bundleDigest: bundle.bundleDigest,
    };
    await tx.insert(coordinationCredentialAuditEvents).values({
      eventType: "gate3_assignment_window_created", success: true, runtimeId: bundle.runtimeId,
      actor: "luca-replit", metadata,
    });
    await input.testHooks?.afterAuditCreated?.();
    return resultFrom({ metadata });
  });
}

export async function readGate3AssignmentBundle(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (stat.size > MAX_BUNDLE_BYTES) fail("bundle_too_large");
    const bytes = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > MAX_BUNDLE_BYTES) fail("bundle_too_large");
    try { return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")); }
    catch { fail("invalid_bundle"); }
  } catch (error) {
    if (error instanceof Gate3AssignmentWindowError) throw error;
    fail("bundle_read_failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}