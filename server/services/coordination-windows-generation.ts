import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  coordinationV2PreparationReservations,
  coordinationV2SessionEvents,
  coordinationV2Sessions,
  coordinationV2HostEnrollments,
  coordinationV2PolicyVersions,
  coordinationV2OperatorGrants,
  coordinationV2SourcePromotions,
  type CoordinationV2PreparationReservation,
} from "@shared/schema";
import { canonicalJson, canonicalizePolicy } from "./coordination-policy-canonicalization";
import {
  authorizeCoordinationLifecycleInTransaction,
  CoordinationLifecycleAuthorizationError,
} from "./coordination-lifecycle-authorization";

export const COORDINATION_PREPARATION_PROTOCOL_VERSION = 1 as const;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const TREE = /^[0-9a-f]{40}$/;
const PREPARATION_RESERVATION_DURATION_MS = 15 * 60_000;
const PREPARATION_UNIQUE_CONSTRAINTS = new Set([
  "uq_coordination_v2_preparation_reserve_request",
  "uq_coordination_v2_preparation_generation",
]);
// Fixed M8 enrollment capabilities; M9 transport capabilities are not accepted
// or activated by this reservation service.
const M8_REQUIRED_HOST_CAPABILITIES = ["preflight", "prepare"] as const;
const SECRET_SHAPED = /(?:secret|password|token|ciphertext|plaintext|bearer|private[_-]?key)/i;
// Approved canonical policy hostConstraints keys for M8 are
// windowsRepositoryBranch and windowsPublicMaterialDigest. These are scalar,
// server-owned values; they are deliberately not top-level policy fields.

export type PreparationReservationState =
  | "reserved" | "promoted" | "acknowledged" | "failed" | "expired" | "abandoned";

export type PreparationReservationDto = {
  id: string;
  sessionId: string | null;
  enrolledHostId: string;
  generationId: string;
  taskRef: string | null;
  taskArtifactSha256: string | null;
  promotionRecordId: string | null;
  promotedCommitSha: string | null;
  exactTreeSha: string | null;
  policyIdentityId: string | null;
  policyVersionId: string | null;
  operatorGrantId: string | null;
  operatorActor: string | null;
  budgetsDigest: string | null;
  completionCriteriaDigest: string | null;
  validationCriteriaDigest: string | null;
  reservationDigest: string;
  publicMaterialDigest: string;
  protocolVersion: number;
  repositoryIdentity: string;
  branch: string;
  startingCommit: string;
  state: PreparationReservationState;
  reserveRequestKey: string;
  reserveCommandDigest: string;
  acknowledgementRequestKey: string | null;
  ackCommandDigest: string | null;
  safePromotionEvidenceDigest: string | null;
  createdAt: string;
  expiresAt: string;
  promotedAt: string | null;
  acknowledgedAt: string | null;
  expiredAt: string | null;
  failedAt: string | null;
  abandonedAt: string | null;
  failureCode: string | null;
  abandonCode: string | null;
};

export type PreparationGenerationErrorCode =
  | "PREPARATION_INVALID_REQUEST" | "PREPARATION_NOT_FOUND"
  | "PREPARATION_CONFLICT" | "PREPARATION_REPLAY_CONFLICT"
  | "PREPARATION_AUTHORIZATION_DENIED" | "PREPARATION_EXPIRED"
  | "PREPARATION_INVALID_TRANSITION" | "PREPARATION_DATABASE_UNAVAILABLE";

export class CoordinationPreparationError extends Error {
  readonly code: PreparationGenerationErrorCode;
  constructor(code: PreparationGenerationErrorCode) {
    super(code);
    this.name = "CoordinationPreparationError";
    this.code = code;
  }
}

function fail(code: PreparationGenerationErrorCode): never {
  throw new CoordinationPreparationError(code);
}

function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("PREPARATION_INVALID_REQUEST");
  }
  return value as string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("PREPARATION_INVALID_REQUEST");
  return value as string;
}

export function isCoordinationPreparationUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (value.code === "23505" && typeof value.constraint === "string"
      && PREPARATION_UNIQUE_CONSTRAINTS.has(value.constraint)) return true;
    current = value.cause;
  }
  return false;
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function validatePreparationReservationBinding(row: Pick<CoordinationV2PreparationReservation,
  "sessionId" | "state" | "taskRef" | "taskArtifactSha256" | "promotionRecordId" | "promotedCommitSha"
  | "exactTreeSha" | "policyIdentityId" | "policyVersionId" | "operatorGrantId" | "operatorActor">): boolean {
  if (row.sessionId === null) {
    return ["reserved", "promoted"].includes(row.state)
      && !!row.taskRef && !!row.taskArtifactSha256 && !!row.promotionRecordId
      && !!row.promotedCommitSha && !!row.exactTreeSha && !!row.policyIdentityId
      && !!row.policyVersionId && !!row.operatorGrantId && !!row.operatorActor;
  }
  return row.state !== "acknowledged" || (!!row.policyVersionId && !!row.operatorGrantId);
}

function dto(row: CoordinationV2PreparationReservation): PreparationReservationDto {
  if (!validatePreparationReservationBinding(row)) fail("PREPARATION_CONFLICT");
  const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
  return {
    id: row.id, sessionId: row.sessionId, enrolledHostId: row.enrolledHostId,
    generationId: row.generationId, taskRef: row.taskRef, taskArtifactSha256: row.taskArtifactSha256,
    promotionRecordId: row.promotionRecordId, promotedCommitSha: row.promotedCommitSha, exactTreeSha: row.exactTreeSha,
    policyIdentityId: row.policyIdentityId, policyVersionId: row.policyVersionId, operatorGrantId: row.operatorGrantId,
    operatorActor: row.operatorActor, budgetsDigest: row.budgetsDigest,
    completionCriteriaDigest: row.completionCriteriaDigest, validationCriteriaDigest: row.validationCriteriaDigest,
    reservationDigest: row.reservationDigest,
    publicMaterialDigest: row.publicMaterialDigest, protocolVersion: row.protocolVersion,
    repositoryIdentity: row.repositoryIdentity, branch: row.branch,
    startingCommit: row.startingCommit, state: row.state as PreparationReservationState,
    reserveRequestKey: row.reserveRequestKey, reserveCommandDigest: row.reserveCommandDigest,
    acknowledgementRequestKey: row.acknowledgementRequestKey, ackCommandDigest: row.ackCommandDigest,
    safePromotionEvidenceDigest: row.safePromotionEvidenceDigest,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    promotedAt: iso(row.promotedAt), acknowledgedAt: iso(row.acknowledgedAt),
    expiredAt: iso(row.expiredAt),
    failedAt: iso(row.failedAt), abandonedAt: iso(row.abandonedAt),
    failureCode: row.failureCode, abandonCode: row.abandonCode,
  };
}

async function databaseNow(tx: any): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  const now = row?.now instanceof Date ? row.now : new Date(row?.now);
  if (!Number.isFinite(now.getTime())) fail("PREPARATION_DATABASE_UNAVAILABLE");
  return now;
}

async function appendEvent(tx: any, row: CoordinationV2PreparationReservation, requestKey: string,
  eventType: string, actorId: string, occurredAt: Date, sessionState: string,
  metadata: Record<string, unknown> = {}) {
  if (!row.sessionId) return;
  const prior = await tx.select({ sequence: coordinationV2SessionEvents.sequence })
    .from(coordinationV2SessionEvents)
    .where(eq(coordinationV2SessionEvents.sessionId, row.sessionId))
    .orderBy(desc(coordinationV2SessionEvents.sequence)).limit(1);
  await tx.insert(coordinationV2SessionEvents).values({
    id: randomUUID(), sessionId: row.sessionId, sequence: (prior[0]?.sequence ?? 0) + 1,
    // Preparation is side-band evidence. The session reducer remains the
    // authority, so both state columns preserve its locked state.
    fromState: sessionState, toState: sessionState, eventType, actorType: "operator",
    actorId, requestKey, metadata: { protocolVersion: 1, generationId: row.generationId, ...metadata },
    createdAt: occurredAt,
  });
}

function preparationEventRequestKey(row: CoordinationV2PreparationReservation, phase: string, sourceRequestKey: string): string {
  return `preparation:${phase}:${digest({ reservationId: row.id, sourceRequestKey })}`;
}

async function authorize(tx: any, input: { sessionId: string; actorId: string; action: "launch" | "terminate" | "status" },
  now: Date, allowExpired = false) {
  try {
    return await authorizeCoordinationLifecycleInTransaction(tx, {
      sessionId: text(input.sessionId, "sessionId"), actorId: text(input.actorId, "actorId"),
      action: input.action, now, allowExpired,
    });
  } catch (error) {
    if (error instanceof CoordinationLifecycleAuthorizationError) {
      if (error.code === "LIFECYCLE_SESSION_NOT_FOUND") fail("PREPARATION_NOT_FOUND");
      if (error.code === "LIFECYCLE_SESSION_EXPIRED") fail("PREPARATION_EXPIRED");
      fail("PREPARATION_AUTHORIZATION_DENIED");
    }
    throw error;
  }
}

function reserveDigest(input: {
  sessionId: string; enrolledHostId: string; generationId: string; publicMaterialDigest: string;
  protocolVersion: number; repositoryIdentity: string; branch: string; startingCommit: string;
  reserveRequestKey: string;
}) {
  return digest(input);
}

export type ReservePreparationInput = {
  sessionId: string;
  actorId: string;
  reserveRequestKey: string;
};

export type PreSessionPreparationInput = {
  taskRef: string; taskArtifactSha256: string; repositoryIdentity: string; startingCommit: string;
  enrolledHostId: string; policyIdentityId: string; policyVersionId: string; operatorGrantId: string;
  operatorActor: string; reserveRequestKey: string; branch: string; publicMaterialDigest: string;
  promotionRecordId?: string; promotedCommitSha?: string; exactTreeSha?: string;
  budgetsDigest?: string; completionCriteriaDigest?: string; validationCriteriaDigest?: string;
};

export async function reserveCoordinationWindowsPreparationBeforeSession(input: PreSessionPreparationInput): Promise<PreparationReservationDto> {
  const reserveRequestKey = text(input.reserveRequestKey, "reserveRequestKey");
  text(input.repositoryIdentity, "repositoryIdentity", 255);
  text(input.enrolledHostId, "enrolledHostId");
  text(input.policyIdentityId, "policyIdentityId");
  text(input.policyVersionId, "policyVersionId");
  text(input.operatorGrantId, "operatorGrantId");
  text(input.operatorActor, "operatorActor");
  text(input.branch, "branch", 255);
  text(input.taskRef, "taskRef");
  text(input.taskArtifactSha256, "taskArtifactSha256");
  text(input.startingCommit, "startingCommit");
  text(input.publicMaterialDigest, "publicMaterialDigest");
  if (!/^[1-9][0-9]*$/.test(input.taskRef) || !DIGEST.test(input.taskArtifactSha256)
    || !COMMIT.test(input.startingCommit) || !DIGEST.test(input.publicMaterialDigest)) fail("PREPARATION_INVALID_REQUEST");
  if (input.promotionRecordId !== undefined) text(input.promotionRecordId, "promotionRecordId");
  if (input.promotedCommitSha !== undefined && !COMMIT.test(input.promotedCommitSha)) fail("PREPARATION_INVALID_REQUEST");
  if (input.exactTreeSha !== undefined && !TREE.test(input.exactTreeSha)) fail("PREPARATION_INVALID_REQUEST");
  for (const value of [input.budgetsDigest, input.completionCriteriaDigest, input.validationCriteriaDigest]) {
    if (value !== undefined && !DIGEST.test(value)) fail("PREPARATION_INVALID_REQUEST");
  }
  const commandDigest = digest(input);
  for (let collisionAttempt = 0; collisionAttempt < 2; collisionAttempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const host = (await tx.select({ id: coordinationV2HostEnrollments.id }).from(coordinationV2HostEnrollments)
          .where(and(eq(coordinationV2HostEnrollments.id, input.enrolledHostId), eq(coordinationV2HostEnrollments.status, "active"), isNull(coordinationV2HostEnrollments.revokedAt))).limit(1))[0];
        const policy = (await tx.select({ id: coordinationV2PolicyVersions.id }).from(coordinationV2PolicyVersions)
          .where(and(eq(coordinationV2PolicyVersions.id, input.policyVersionId), eq(coordinationV2PolicyVersions.approvalState, "approved"), isNull(coordinationV2PolicyVersions.revokedAt))).limit(1))[0];
        const grant = (await tx.select({ id: coordinationV2OperatorGrants.id }).from(coordinationV2OperatorGrants)
          .where(and(eq(coordinationV2OperatorGrants.id, input.operatorGrantId), eq(coordinationV2OperatorGrants.operatorActor, input.operatorActor),
            gt(coordinationV2OperatorGrants.expiresAt, new Date()), isNull(coordinationV2OperatorGrants.revokedAt))).limit(1))[0];
        if (!host || !policy || !grant) fail("PREPARATION_AUTHORIZATION_DENIED");
        if (!input.promotionRecordId || !input.promotedCommitSha || !input.exactTreeSha) fail("PREPARATION_AUTHORIZATION_DENIED");
        const promotion = (await tx.select({ id: coordinationV2SourcePromotions.id }).from(coordinationV2SourcePromotions)
          .where(and(eq(coordinationV2SourcePromotions.id, input.promotionRecordId),
            eq(coordinationV2SourcePromotions.promotedCommitSha, input.promotedCommitSha),
            eq(coordinationV2SourcePromotions.exactTreeSha, input.exactTreeSha),
            eq(coordinationV2SourcePromotions.repositoryIdentity, input.repositoryIdentity),
            eq(coordinationV2SourcePromotions.state, "published"))).limit(1))[0];
        if (!promotion) fail("PREPARATION_AUTHORIZATION_DENIED");
        const prior = await tx.select().from(coordinationV2PreparationReservations)
          .where(eq(coordinationV2PreparationReservations.reserveRequestKey, reserveRequestKey)).for("update");
        if (prior[0]) {
          const row = prior[0] as CoordinationV2PreparationReservation;
          if (row.reserveCommandDigest !== commandDigest) fail("PREPARATION_REPLAY_CONFLICT");
          return dto(row);
        }
        const generationId = randomUUID();
        const reservationDigest = digest({
          taskRef: input.taskRef, taskArtifactSha256: input.taskArtifactSha256, repositoryIdentity: input.repositoryIdentity,
          startingCommit: input.startingCommit, enrolledHostId: input.enrolledHostId, policyVersionId: input.policyVersionId,
          operatorGrantId: input.operatorGrantId, operatorActor: input.operatorActor, generationId,
          publicMaterialDigest: input.publicMaterialDigest, reserveRequestKey,
        });
        // Every lifecycle stamp (created/promoted/acknowledged) comes from the
        // database clock, so the timestamp-order constraint holds even when the
        // application host's clock is skewed from the database's.
        const now = await databaseNow(tx);
        const inserted = await tx.insert(coordinationV2PreparationReservations).values({
          id: randomUUID(), sessionId: null, enrolledHostId: input.enrolledHostId, generationId,
          taskRef: input.taskRef, taskArtifactSha256: input.taskArtifactSha256,
          promotionRecordId: input.promotionRecordId, promotedCommitSha: input.promotedCommitSha, exactTreeSha: input.exactTreeSha,
          policyIdentityId: input.policyIdentityId, policyVersionId: input.policyVersionId, operatorGrantId: input.operatorGrantId,
          operatorActor: input.operatorActor, budgetsDigest: input.budgetsDigest,
          completionCriteriaDigest: input.completionCriteriaDigest, validationCriteriaDigest: input.validationCriteriaDigest,
          reservationDigest, publicMaterialDigest: input.publicMaterialDigest, protocolVersion: 1, repositoryIdentity: input.repositoryIdentity,
          branch: input.branch, startingCommit: input.startingCommit, state: "reserved",
          reserveRequestKey, reserveCommandDigest: commandDigest, createdAt: now,
          expiresAt: new Date(now.getTime() + PREPARATION_RESERVATION_DURATION_MS),
        }).returning();
        return dto(inserted[0] as CoordinationV2PreparationReservation);
      });
    } catch (error) {
      if (error instanceof CoordinationPreparationError) throw error;
      const code = postgresCode(error);
      if (code === "23505" && isCoordinationPreparationUniqueConflict(error)) {
        for (let readAttempt = 0; readAttempt < 3; readAttempt += 1) {
          const winner = await readReservationWinner(reserveRequestKey);
          if (winner) {
            if (winner.reserveCommandDigest !== commandDigest) fail("PREPARATION_REPLAY_CONFLICT");
            return dto(winner);
          }
          if (readAttempt < 2) await boundedReservationBackoff(readAttempt);
        }
        if (collisionAttempt === 0) continue;
        fail("PREPARATION_CONFLICT");
      }
      if (code === "23505") fail("PREPARATION_DATABASE_UNAVAILABLE");
      if (code === "23514") fail("PREPARATION_INVALID_TRANSITION");
      if (code === "40001" || code === "40P01") fail("PREPARATION_CONFLICT");
      return fail("PREPARATION_DATABASE_UNAVAILABLE");
    }
  }
  return fail("PREPARATION_CONFLICT");
}

export async function acknowledgeCoordinationWindowsPreparationBeforeSession(input: {
  reservationId: string; actorId: string; generationId: string; publicMaterialDigest: string;
  acknowledgementRequestKey: string; safePromotionEvidenceDigest: string;
}): Promise<PreparationReservationDto> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(coordinationV2PreparationReservations)
      .where(eq(coordinationV2PreparationReservations.id, input.reservationId)).for("update");
    const row = rows[0] as CoordinationV2PreparationReservation | undefined;
    if (!row || row.operatorActor !== input.actorId || row.generationId !== input.generationId
      || row.publicMaterialDigest !== input.publicMaterialDigest) fail("PREPARATION_CONFLICT");
    const ackCommandDigest = digest(input);
    if (row.state === "acknowledged" && row.sessionId) {
      if (row.ackCommandDigest !== ackCommandDigest
        || row.acknowledgementRequestKey !== input.acknowledgementRequestKey
        || row.safePromotionEvidenceDigest !== input.safePromotionEvidenceDigest) {
        fail("PREPARATION_REPLAY_CONFLICT");
      }
      return dto(row);
    }
    const acknowledgementNow = await databaseNow(tx);
    if (row.state !== "promoted" || row.expiresAt <= acknowledgementNow) fail("PREPARATION_INVALID_TRANSITION");
    if (!row.promotedAt || !row.safePromotionEvidenceDigest
      || row.safePromotionEvidenceDigest !== input.safePromotionEvidenceDigest) fail("PREPARATION_CONFLICT");
    const rawPolicy = (await tx.select({ canonicalPolicy: coordinationV2PolicyVersions.canonicalPolicy })
      .from(coordinationV2PolicyVersions).where(eq(coordinationV2PolicyVersions.id, row.policyVersionId!)).limit(1))[0]?.canonicalPolicy as any;
    let policy: Record<string, unknown>;
    try {
      policy = canonicalizePolicy(rawPolicy) as Record<string, unknown>;
    } catch {
      // A database row that no longer satisfies the canonical authority
      // language must never receive a session or credentials.
      fail("PREPARATION_AUTHORIZATION_DENIED");
    }
    const providerOrder = policy.providerOrder;
    const totalAttemptBudget = policy.totalAttemptBudget;
    const sessionDurationMs = policy.sessionDurationMs;
    const perProviderBudgets = policy.perProviderAttemptBudgets ?? {};
    const requiredValidations = policy.requiredValidationCommands ?? [];
    const requiredCompletionEvidence = policy.requiredCompletionEvidence ?? [];
    if (!Array.isArray(providerOrder) || providerOrder.length === 0
      || typeof totalAttemptBudget !== "number" || !Number.isSafeInteger(totalAttemptBudget)
      || typeof sessionDurationMs !== "number" || !Number.isSafeInteger(sessionDurationMs)
      || !perProviderBudgets || typeof perProviderBudgets !== "object"
      || !Array.isArray(requiredValidations) || !Array.isArray(requiredCompletionEvidence)) {
      fail("PREPARATION_AUTHORIZATION_DENIED");
    }
    const sessionDigest = digest({ reservationId: row.id, taskRef: row.taskRef, taskArtifactSha256: row.taskArtifactSha256, generationId: row.generationId });
    const sessionRows = await tx.insert(coordinationV2Sessions).values({
      id: randomUUID(), preparationReservationId: row.id, policyVersionId: row.policyVersionId!,
      operatorGrantId: row.operatorGrantId!, operatorActor: row.operatorActor!, taskRef: row.taskRef!,
      taskArtifactSha256: row.taskArtifactSha256!, repositoryIdentity: row.repositoryIdentity,
      startingCommit: row.startingCommit, enrolledHostId: row.enrolledHostId,
      requestedProviders: providerOrder as string[],
      expiresAt: new Date(acknowledgementNow.getTime() + sessionDurationMs),
      attemptBudget: totalAttemptBudget as number,
      perProviderBudgets: perProviderBudgets as Record<string, number>,
      requiredValidations: requiredValidations as string[],
      completionCriteria: { requiredCompletionEvidence },
      state: "ready",
      idempotencyKey: `${row.reserveRequestKey}:ack`, sessionDigest,
      createdAt: acknowledgementNow, updatedAt: acknowledgementNow,
    }).returning();
    const session = sessionRows[0];
    const updated = await tx.update(coordinationV2PreparationReservations).set({
      sessionId: session.id, state: "acknowledged", acknowledgementRequestKey: input.acknowledgementRequestKey,
      ackCommandDigest, safePromotionEvidenceDigest: input.safePromotionEvidenceDigest, acknowledgedAt: acknowledgementNow,
    }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
    const eventRow = updated[0] as CoordinationV2PreparationReservation;
    await appendEvent(tx, eventRow,
      preparationEventRequestKey(eventRow, "reserved", eventRow.reserveRequestKey),
      "preparation_reserved", eventRow.operatorActor!, eventRow.createdAt, "ready", {
        reserveRequestKey: eventRow.reserveRequestKey,
        reserveCommandDigest: eventRow.reserveCommandDigest,
        reservationDigest: eventRow.reservationDigest,
        publicMaterialDigest: eventRow.publicMaterialDigest,
      });
    await appendEvent(tx, eventRow,
      preparationEventRequestKey(eventRow, "promoted", eventRow.reserveRequestKey),
      "preparation_promoted", eventRow.operatorActor!, eventRow.promotedAt!, "ready", {
        reserveRequestKey: eventRow.reserveRequestKey,
        safePromotionEvidenceDigest: eventRow.safePromotionEvidenceDigest,
      });
    await appendEvent(tx, eventRow,
      preparationEventRequestKey(eventRow, "acknowledged", eventRow.acknowledgementRequestKey!),
      "preparation_acknowledged", input.actorId, acknowledgementNow, "ready", {
        acknowledgementRequestKey: eventRow.acknowledgementRequestKey,
        ackCommandDigest: eventRow.ackCommandDigest,
        safePromotionEvidenceDigest: eventRow.safePromotionEvidenceDigest,
      });
    return dto(updated[0] as CoordinationV2PreparationReservation);
  });
}

async function readReservationWinner(reserveRequestKey: string): Promise<CoordinationV2PreparationReservation | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(coordinationV2PreparationReservations)
      .where(eq(coordinationV2PreparationReservations.reserveRequestKey, reserveRequestKey))
      .for("update");
    return rows[0] as CoordinationV2PreparationReservation | undefined;
  });
}

async function boundedReservationBackoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 5 : 15));
}

export async function promoteCoordinationWindowsPreparationBeforeSession(input: {
  reservationId: string; actorId: string; generationId: string; publicMaterialDigest: string; safePromotionEvidenceDigest: string;
}): Promise<PreparationReservationDto> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(coordinationV2PreparationReservations)
      .where(eq(coordinationV2PreparationReservations.id, input.reservationId)).for("update");
    const row = rows[0] as CoordinationV2PreparationReservation | undefined;
    if (!row || row.operatorActor !== input.actorId || row.generationId !== input.generationId
      || row.publicMaterialDigest !== input.publicMaterialDigest) fail("PREPARATION_CONFLICT");
    if (row.state === "promoted" || row.state === "acknowledged") return dto(row);
    const now = await databaseNow(tx);
    if (row.state !== "reserved" || row.expiresAt <= now) fail("PREPARATION_INVALID_TRANSITION");
    const updated = await tx.update(coordinationV2PreparationReservations).set({
      state: "promoted", promotedAt: now, safePromotionEvidenceDigest: input.safePromotionEvidenceDigest,
    }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
    return dto(updated[0] as CoordinationV2PreparationReservation);
  });
}

export async function reserveCoordinationWindowsPreparation(input: ReservePreparationInput): Promise<PreparationReservationDto> {
  const reserveRequestKey = text(input.reserveRequestKey, "reserveRequestKey");
  for (let collisionAttempt = 0; collisionAttempt < 2; collisionAttempt += 1) {
    try {
      return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      const { session, host, version, identity, grant } = await authorize(tx, {
        sessionId: input.sessionId, actorId: input.actorId, action: "launch",
      }, now);
      if (host.hostType.toLowerCase() !== "windows" || host.protocolVersion !== 1
        || host.status !== "active"
        || !M8_REQUIRED_HOST_CAPABILITIES.every((capability) => host.capabilities.includes(capability))) {
        fail("PREPARATION_AUTHORIZATION_DENIED");
      }
      const policy = version.canonicalPolicy as Record<string, unknown>;
      const constraints = policy.hostConstraints;
      if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
        fail("PREPARATION_AUTHORIZATION_DENIED");
      }
      const hostConstraints = constraints as Record<string, unknown>;
      const branch = hostConstraints.windowsRepositoryBranch;
      const publicMaterialDigest = hostConstraints.windowsPublicMaterialDigest;
      if (typeof branch !== "string" || branch.length === 0 || branch.length > 255
        || branch.trim() !== branch || SECRET_SHAPED.test(branch)
        || typeof publicMaterialDigest !== "string" || !DIGEST.test(publicMaterialDigest)
        || SECRET_SHAPED.test(publicMaterialDigest)) {
        fail("PREPARATION_AUTHORIZATION_DENIED");
      }
      const remainingMs = session.expiresAt.getTime() - now.getTime();
      if (remainingMs <= 0) fail("PREPARATION_EXPIRED");
      const effectiveDurationMs = Math.min(PREPARATION_RESERVATION_DURATION_MS, remainingMs);
      const commandDigest = digest({
        sessionId: session.id, enrolledHostId: host.id, branch, publicMaterialDigest,
        protocolVersion: COORDINATION_PREPARATION_PROTOCOL_VERSION, reserveRequestKey,
        durationMs: PREPARATION_RESERVATION_DURATION_MS,
      });
      const priorRows = await tx.select().from(coordinationV2PreparationReservations)
        .where(and(eq(coordinationV2PreparationReservations.sessionId, session.id),
          eq(coordinationV2PreparationReservations.reserveRequestKey, reserveRequestKey))).for("update");
      const prior = priorRows[0] as CoordinationV2PreparationReservation | undefined;
      if (prior) {
        if (prior.reserveCommandDigest !== commandDigest) fail("PREPARATION_REPLAY_CONFLICT");
        return dto(prior);
      }
      const generationId = randomUUID();
      const reservationDigest = reserveDigest({
        sessionId: session.id, enrolledHostId: host.id, generationId, publicMaterialDigest,
        protocolVersion: COORDINATION_PREPARATION_PROTOCOL_VERSION,
        repositoryIdentity: session.repositoryIdentity, branch, startingCommit: session.startingCommit,
        reserveRequestKey,
      });
      const inserted = await tx.insert(coordinationV2PreparationReservations).values({
        id: randomUUID(), sessionId: session.id, enrolledHostId: host.id, generationId,
        taskRef: session.taskRef, taskArtifactSha256: session.taskArtifactSha256,
        policyIdentityId: identity.id, policyVersionId: version.id, operatorGrantId: grant.id,
        operatorActor: session.operatorActor,
        reservationDigest, publicMaterialDigest,
        protocolVersion: COORDINATION_PREPARATION_PROTOCOL_VERSION,
        repositoryIdentity: session.repositoryIdentity, branch, startingCommit: session.startingCommit,
        state: "reserved", reserveRequestKey, reserveCommandDigest: commandDigest,
        createdAt: now, expiresAt: new Date(now.getTime() + effectiveDurationMs),
      }).returning();
      const row = inserted[0] as CoordinationV2PreparationReservation;
      await appendEvent(tx, row, reserveRequestKey, "preparation_reserved", input.actorId, now, session.state, {
        reservationDigest, publicMaterialDigest,
      });
      return dto(row);
      });
    } catch (error) {
      if (error instanceof CoordinationPreparationError) throw error;
      const code = postgresCode(error);
      if (code === "23505" && isCoordinationPreparationUniqueConflict(error)) {
        const commandDigest = digest(input);
        for (let readAttempt = 0; readAttempt < 3; readAttempt += 1) {
          const winner = await readReservationWinner(reserveRequestKey);
          if (winner) {
            if (winner.reserveCommandDigest !== commandDigest) fail("PREPARATION_REPLAY_CONFLICT");
            return dto(winner);
          }
          if (readAttempt < 2) await boundedReservationBackoff(readAttempt);
        }
        if (collisionAttempt === 0) continue;
        fail("PREPARATION_CONFLICT");
      }
      if (code === "23505") fail("PREPARATION_DATABASE_UNAVAILABLE");
      if (code === "23514") fail("PREPARATION_INVALID_TRANSITION");
      if (code === "40001" || code === "40P01") fail("PREPARATION_CONFLICT");
      return fail("PREPARATION_DATABASE_UNAVAILABLE");
    }
  }
  return fail("PREPARATION_CONFLICT");
}

export async function readCoordinationWindowsPreparation(input: {
  sessionId: string; actorId: string; reservationId?: string; generationId?: string;
}): Promise<PreparationReservationDto | null> {
  try {
    return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      await authorize(tx, { sessionId: input.sessionId, actorId: input.actorId, action: "status" }, now, true);
      const clauses = [eq(coordinationV2PreparationReservations.sessionId, input.sessionId)];
      if (input.reservationId) clauses.push(eq(coordinationV2PreparationReservations.id, text(input.reservationId, "reservationId")));
      if (input.generationId) clauses.push(eq(coordinationV2PreparationReservations.generationId, text(input.generationId, "generationId")));
      const rows = await tx.select().from(coordinationV2PreparationReservations).where(and(...clauses));
      return rows[0] ? dto(rows[0] as CoordinationV2PreparationReservation) : null;
    });
  } catch (error) {
    if (error instanceof CoordinationPreparationError) throw error;
    return fail("PREPARATION_DATABASE_UNAVAILABLE");
  }
}

export async function recoverCoordinationWindowsPreparation(input: {
  sessionId: string; actorId: string; reservationId: string; generationId: string;
}): Promise<PreparationReservationDto> {
  try {
    return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      const { session } = await authorize(tx, { sessionId: input.sessionId, actorId: input.actorId, action: "status" }, now, true);
      const rows = await tx.select().from(coordinationV2PreparationReservations)
        .where(and(eq(coordinationV2PreparationReservations.id, text(input.reservationId, "reservationId")),
          eq(coordinationV2PreparationReservations.sessionId, session.id),
          eq(coordinationV2PreparationReservations.generationId, text(input.generationId, "generationId")))).for("update");
      const row = rows[0] as CoordinationV2PreparationReservation | undefined;
      if (!row) return fail("PREPARATION_NOT_FOUND");
      if (row.state === "reserved" && row.expiresAt <= now) {
        const updated = await tx.update(coordinationV2PreparationReservations).set({
          state: "expired", expiredAt: now, failedAt: null,
        }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
        await appendEvent(tx, updated[0], `preparation-expire:${row.id}`, "preparation_expired", input.actorId, now, session.state);
        return dto(updated[0]);
      }
      return dto(row);
    });
  } catch (error) {
    if (error instanceof CoordinationPreparationError) throw error;
    return fail("PREPARATION_DATABASE_UNAVAILABLE");
  }
}

export type AcknowledgePreparationInput = {
  sessionId: string; actorId: string; reservationId: string; generationId: string;
  publicMaterialDigest: string; protocolVersion: number; acknowledgementRequestKey: string;
  safePromotionEvidenceDigest: string;
};

export async function promoteCoordinationWindowsPreparation(input: {
  sessionId: string; actorId: string; reservationId: string; generationId: string;
  publicMaterialDigest: string; safePromotionEvidenceDigest: string;
}): Promise<PreparationReservationDto> {
  const publicMaterialDigest = sha(input.publicMaterialDigest);
  const evidence = sha(input.safePromotionEvidenceDigest);
  try {
    return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      const { session, host } = await authorize(tx, {
        sessionId: input.sessionId, actorId: input.actorId, action: "launch",
      }, now, true);
      const rows = await tx.select().from(coordinationV2PreparationReservations)
        .where(and(eq(coordinationV2PreparationReservations.id, text(input.reservationId, "reservationId")),
          eq(coordinationV2PreparationReservations.sessionId, session.id))).for("update");
      const row = rows[0] as CoordinationV2PreparationReservation | undefined;
      if (!row || row.enrolledHostId !== host.id || row.generationId !== text(input.generationId, "generationId")
        || row.publicMaterialDigest !== publicMaterialDigest) fail("PREPARATION_CONFLICT");
      if (row.state === "promoted" || row.state === "acknowledged") {
        if (row.safePromotionEvidenceDigest !== evidence) fail("PREPARATION_REPLAY_CONFLICT");
        return dto(row);
      }
      if (row.state !== "reserved") fail("PREPARATION_INVALID_TRANSITION");
      if (row.expiresAt <= now) fail("PREPARATION_EXPIRED");
      const updated = await tx.update(coordinationV2PreparationReservations).set({
        state: "promoted", promotedAt: now, safePromotionEvidenceDigest: evidence,
      }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
      await appendEvent(tx, updated[0], `promotion:${row.id}`, "preparation_promoted", input.actorId, now, session.state, {
        safePromotionEvidenceDigest: evidence,
      });
      return dto(updated[0]);
    });
  } catch (error) {
    if (error instanceof CoordinationPreparationError) throw error;
    if ((error as { code?: string }).code === "23514") fail("PREPARATION_INVALID_TRANSITION");
    return fail("PREPARATION_DATABASE_UNAVAILABLE");
  }
}

export async function acknowledgeCoordinationWindowsPreparation(input: AcknowledgePreparationInput): Promise<PreparationReservationDto> {
  const acknowledgementRequestKey = text(input.acknowledgementRequestKey, "acknowledgementRequestKey");
  const publicMaterialDigest = sha(input.publicMaterialDigest);
  const evidence = sha(input.safePromotionEvidenceDigest);
  if (input.protocolVersion !== 1) fail("PREPARATION_INVALID_REQUEST");
  try {
    return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      const { session, host } = await authorize(tx, {
        sessionId: input.sessionId, actorId: input.actorId, action: "launch",
      }, now, true);
      const rows = await tx.select().from(coordinationV2PreparationReservations)
        .where(and(eq(coordinationV2PreparationReservations.id, text(input.reservationId, "reservationId")),
          eq(coordinationV2PreparationReservations.sessionId, session.id))).for("update");
      const row = rows[0] as CoordinationV2PreparationReservation | undefined;
      if (!row || row.enrolledHostId !== host.id || row.generationId !== text(input.generationId, "generationId")
        || row.publicMaterialDigest !== publicMaterialDigest || row.protocolVersion !== input.protocolVersion) {
        fail("PREPARATION_CONFLICT");
      }
      const commandDigest = digest({
        reservationId: row.id, generationId: row.generationId, sessionId: session.id,
        enrolledHostId: host.id, publicMaterialDigest, protocolVersion: input.protocolVersion,
        acknowledgementRequestKey, safePromotionEvidenceDigest: evidence,
      });
      if (row.state === "acknowledged") {
        if (row.acknowledgementRequestKey !== acknowledgementRequestKey || row.ackCommandDigest !== commandDigest) {
          fail("PREPARATION_REPLAY_CONFLICT");
        }
        return dto(row);
      }
      if (row.state !== "promoted") fail(row.state === "reserved" ? "PREPARATION_INVALID_TRANSITION" : "PREPARATION_CONFLICT");
      const updated = await tx.update(coordinationV2PreparationReservations).set({
        state: "acknowledged", acknowledgementRequestKey, ackCommandDigest: commandDigest,
        acknowledgedAt: now,
      }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
      await appendEvent(tx, updated[0], acknowledgementRequestKey, "preparation_acknowledged", input.actorId, now, session.state, {
        safePromotionEvidenceDigest: evidence,
      });
      return dto(updated[0]);
    });
  } catch (error) {
    if (error instanceof CoordinationPreparationError) throw error;
    if ((error as { code?: string }).code === "23514") fail("PREPARATION_INVALID_TRANSITION");
    return fail("PREPARATION_DATABASE_UNAVAILABLE");
  }
}

export async function reportCoordinationWindowsAbandoned(input: {
  sessionId: string; actorId: string; reservationId: string; generationId: string; abandonCode: string;
}): Promise<PreparationReservationDto> {
  return endPreparation("abandoned", input);
}

export async function failCoordinationWindowsPreparation(input: {
  sessionId: string; actorId: string; reservationId: string; generationId: string; failureCode: string;
}): Promise<PreparationReservationDto> {
  return endPreparation("failed", input);
}

async function endPreparation(state: "failed" | "abandoned", input: {
  sessionId: string; actorId: string; reservationId: string; generationId: string;
  failureCode?: string; abandonCode?: string;
}): Promise<PreparationReservationDto> {
  const code = text(state === "failed" ? input.failureCode : input.abandonCode, "code", 128);
  try {
    return await db.transaction(async (tx) => {
      const now = await databaseNow(tx);
      const { session } = await authorize(tx, { sessionId: input.sessionId, actorId: input.actorId, action: "terminate" }, now, true);
      const rows = await tx.select().from(coordinationV2PreparationReservations)
        .where(and(eq(coordinationV2PreparationReservations.id, text(input.reservationId, "reservationId")),
          eq(coordinationV2PreparationReservations.sessionId, session.id),
          eq(coordinationV2PreparationReservations.generationId, text(input.generationId, "generationId")))).for("update");
      const row = rows[0] as CoordinationV2PreparationReservation | undefined;
      if (!row) return fail("PREPARATION_NOT_FOUND");
      if (!["reserved", "promoted"].includes(row.state)) fail("PREPARATION_INVALID_TRANSITION");
      const updated = await tx.update(coordinationV2PreparationReservations).set({
        state, ...(state === "failed" ? { failureCode: code, failedAt: now } : { abandonCode: code, abandonedAt: now }),
      }).where(eq(coordinationV2PreparationReservations.id, row.id)).returning();
      await appendEvent(tx, updated[0], `${state}:${row.id}`, `preparation_${state}`, input.actorId, now, session.state, { code });
      return dto(updated[0]);
    });
  } catch (error) {
    if (error instanceof CoordinationPreparationError) throw error;
    if ((error as { code?: string }).code === "23514") fail("PREPARATION_INVALID_TRANSITION");
    return fail("PREPARATION_DATABASE_UNAVAILABLE");
  }
}

/**
 * Local preparation intentionally uses this pure helper rather than importing
 * database code.  It is also the single canonical digest operation used by
 * injected hermetic test repositories.
 */
export function coordinationPreparationDigest(value: unknown): string {
  return digest(value);
}

// Descriptive aliases keep the public service vocabulary aligned with the
// milestone language while retaining the preparation-specific names above.
export const reserveCoordinationWindowsGeneration = reserveCoordinationWindowsPreparation;
export const readCoordinationWindowsReservation = readCoordinationWindowsPreparation;
export const recoverCoordinationWindowsGeneration = recoverCoordinationWindowsPreparation;
export const acknowledgeCoordinationWindowsGeneration = acknowledgeCoordinationWindowsPreparation;
export const reportAbandonedCoordinationWindowsGeneration = reportCoordinationWindowsAbandoned;
export const failCoordinationWindowsGeneration = failCoordinationWindowsPreparation;
