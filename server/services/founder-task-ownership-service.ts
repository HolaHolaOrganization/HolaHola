import crypto from "node:crypto";
import { enrichOwnershipApprovalScopes } from "./ownership-approval-scope";
import { checkedPromotionDescriptor, insertPromotionApprovalContext, loadPromotionApprovalContexts, requireVerifiedPromotionContext } from "./promotion-approval-context";
import { ownershipProofPayload } from "./task-ownership-proof-payload";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  taskOwnershipChallenges, taskOwnershipReceipts, taskOwnershipProofNonces,
  taskOwnershipDecisionEvents, taskOwnershipProofAttempts,
} from "@shared/schema";
import { canonicalJson } from "./task-ownership-service";
import { TASK_APPROVAL_DEFAULT_MS, TASK_APPROVAL_MAX_MS } from "../../shared/task-ownership-policy";
export { canonicalJson };

const CHALLENGE_TTL = TASK_APPROVAL_DEFAULT_MS;
const MAX_CHALLENGE_TTL = TASK_APPROVAL_MAX_MS;
const GATE3_AUTHORITY_TTL = 20 * 60_000;
const NONCE_TTL = 90_000;
const error = (code: string): never => {
  const value = new Error(code);
  (value as Error & { code?: string }).code = code;
  throw value;
};
const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => canonicalJson(value);

function validatePublicKey(encoded: string, suppliedFingerprint: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) error("INVALID_PUBLIC_KEY");
  let key!: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" }); }
  catch { error("INVALID_PUBLIC_KEY"); }
  if (key.asymmetricKeyType !== "ed25519") error("INVALID_PUBLIC_KEY");
  const fingerprint = digest(key.export({ format: "der", type: "spki" }) as Buffer);
  if (!/^[a-f0-9]{64}$/.test(suppliedFingerprint) || suppliedFingerprint !== fingerprint) error("INVALID_KEY_FINGERPRINT");
  return encoded;
}

export async function createChallenge(input: {
  taskRef: string; artifactSha256: string; intendedActor?: string; coordinationActor: string;
  publicKey: string; keyFingerprint: string; contextDigest?: string; idempotencyKey: string;
  ttlMs?: number; promotionDescriptor?: unknown;
}) {
  const ttlMs = input.ttlMs ?? CHALLENGE_TTL;
  if (input.intendedActor && input.intendedActor !== input.coordinationActor) error("ACTOR_MISMATCH");
  if (
    !input.coordinationActor.startsWith("luca-")
    || !/^[a-f0-9]{64}$/.test(input.artifactSha256)
    || input.idempotencyKey.length < 1
    || input.idempotencyKey.length > 128
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < 60_000
    || ttlMs > MAX_CHALLENGE_TTL
  ) error("INVALID_CHALLENGE");
  validatePublicKey(input.publicKey, input.keyFingerprint);
  const promotionDescriptor = input.contextDigest != null || input.promotionDescriptor !== undefined
    ? checkedPromotionDescriptor(input.promotionDescriptor, input.contextDigest) : undefined;
  const requestFields: Record<string, unknown> = {
    taskRef: input.taskRef,
    artifactSha256: input.artifactSha256,
    actor: input.coordinationActor,
    publicKey: input.publicKey,
    keyFingerprint: input.keyFingerprint,
    ttlMs,
  };
  if (input.contextDigest !== undefined) requestFields.contextDigest = input.contextDigest;
  if (promotionDescriptor) requestFields.promotionDescriptor = promotionDescriptor;
  const requestDigest = digest(canonical(requestFields));

  return db.transaction(async tx => {
    const lockKey = digest(canonical([
      input.coordinationActor,
      input.idempotencyKey,
    ]));
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const [existing] = await tx.select().from(taskOwnershipChallenges).where(and(
      eq(taskOwnershipChallenges.coordinationActor, input.coordinationActor),
      eq(taskOwnershipChallenges.idempotencyKey, input.idempotencyKey),
    ));
    if (existing) {
      if (existing.requestDigest !== requestDigest) error("IDEMPOTENCY_CONFLICT");
      return { challengeId: existing.id, expiresAt: existing.expiresAt };
    }
    const [row] = await tx.insert(taskOwnershipChallenges).values({
      taskRef: input.taskRef,
      artifactSha256: input.artifactSha256,
      intendedActor: input.coordinationActor,
      coordinationActor: input.coordinationActor,
      publicKey: input.publicKey,
      keyFingerprint: input.keyFingerprint,
      contextDigest: input.contextDigest,
      serverNonce: crypto.randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + ttlMs),
      idempotencyKey: input.idempotencyKey,
      requestDigest,
    }).returning({
      id: taskOwnershipChallenges.id,
      expiresAt: taskOwnershipChallenges.expiresAt,
    });
    if (promotionDescriptor) await insertPromotionApprovalContext(tx, row.id, input.contextDigest!, promotionDescriptor);
    return { challengeId: row.id, expiresAt: row.expiresAt };
  });
}

export async function getChallenge(id: string, actor: string) {
  await expirePendingChallenges();
  const [row] = await db.select().from(taskOwnershipChallenges).where(and(eq(taskOwnershipChallenges.id, id), eq(taskOwnershipChallenges.coordinationActor, actor)));
  if (!row) error("CHALLENGE_NOT_FOUND");
  const [receipt] = await db.select({ id: taskOwnershipReceipts.id, status: taskOwnershipReceipts.status })
    .from(taskOwnershipReceipts).where(eq(taskOwnershipReceipts.challengeId, id));
  return {
    id: row.id, taskRef: row.taskRef, status: row.status, expiresAt: row.expiresAt,
    intendedActor: row.intendedActor, artifactSha256: row.artifactSha256,
    keyFingerprint: row.keyFingerprint, receipt: receipt ?? null,
  };
}

export async function listChallenges() {
  await expirePendingChallenges();
  const challenges = await db.select({ id: taskOwnershipChallenges.id, taskRef: taskOwnershipChallenges.taskRef,
    artifactSha256: taskOwnershipChallenges.artifactSha256, intendedActor: taskOwnershipChallenges.intendedActor,
    keyFingerprint: taskOwnershipChallenges.keyFingerprint, status: taskOwnershipChallenges.status,
    contextDigest: taskOwnershipChallenges.contextDigest, expiresAt: taskOwnershipChallenges.expiresAt,
    createdAt: taskOwnershipChallenges.createdAt, decidedAt: taskOwnershipChallenges.decidedAt })
    .from(taskOwnershipChallenges)
    .orderBy(desc(taskOwnershipChallenges.createdAt))
    .limit(100);
  const receipts = await db.select({
    id: taskOwnershipReceipts.id, challengeId: taskOwnershipReceipts.challengeId,
    status: taskOwnershipReceipts.status, expiresAt: taskOwnershipReceipts.expiresAt,
    revokedAt: taskOwnershipReceipts.revokedAt,
  }).from(taskOwnershipReceipts);
  const byChallenge = new Map(receipts.map(receipt => [receipt.challengeId, receipt]));
  const promotionContexts = await loadPromotionApprovalContexts(challenges);
  return enrichOwnershipApprovalScopes(challenges.map(challenge => ({
    ...challenge, receipt: byChallenge.get(challenge.id) ?? null,
    promotionContext: promotionContexts.get(challenge.id),
  })));
}

export async function decideChallenge(id: string, decision: "approved" | "rejected", founderId: string, reason?: string) {
  if (!founderId) error("FOUNDER_ID_REQUIRED");
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(taskOwnershipChallenges).where(eq(taskOwnershipChallenges.id, id));
    if (!initial) error("CHALLENGE_NOT_FOUND");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${initial.taskRef}, 0))`);
    const [challenge] = await tx.select().from(taskOwnershipChallenges).where(eq(taskOwnershipChallenges.id, id)).for("update");
    if (!challenge) error("CHALLENGE_NOT_FOUND");
    if (decision === "approved") await requireVerifiedPromotionContext(challenge, tx);
    if (challenge.status !== "pending") {
      const [priorEvent] = await tx.select().from(taskOwnershipDecisionEvents)
        .where(eq(taskOwnershipDecisionEvents.challengeId, id))
        .orderBy(taskOwnershipDecisionEvents.createdAt)
        .limit(1);
      const normalizedReason = reason?.trim() || null;
      if (
        challenge.status === decision
        && priorEvent?.decision === decision
        && priorEvent.actorId === founderId
        && (priorEvent.reason?.trim() || null) === normalizedReason
      ) {
        const [receipt] = await tx.select().from(taskOwnershipReceipts)
          .where(eq(taskOwnershipReceipts.challengeId, id));
        return decision === "rejected"
          ? { status: decision }
          : { id: receipt.id, status: receipt.status, expiresAt: receipt.expiresAt, payloadDigest: receipt.payloadDigest };
      }
      error("CHALLENGE_ALREADY_DECIDED");
    }
    if (challenge.expiresAt <= new Date()) {
      const decidedAt = new Date();
      await tx.update(taskOwnershipChallenges).set({ status: "expired", decidedAt })
        .where(and(eq(taskOwnershipChallenges.id, id), eq(taskOwnershipChallenges.status, "pending")));
      await tx.insert(taskOwnershipDecisionEvents).values({
        challengeId: id, decision: "expired", actorId: "coordination-system", reason: "challenge_ttl_elapsed",
      });
      return { expired: true as const };
    }
    const decidedAt = new Date();
    const [decided] = await tx.update(taskOwnershipChallenges).set({ status: decision, decidedAt })
      .where(and(eq(taskOwnershipChallenges.id, id), eq(taskOwnershipChallenges.status, "pending")))
      .returning({ id: taskOwnershipChallenges.id });
    if (!decided) error("CHALLENGE_ALREADY_DECIDED");
    if (decision === "rejected") {
      await tx.insert(taskOwnershipDecisionEvents).values({ challengeId: id, decision, actorId: founderId, reason });
      return { status: decision };
    }
    const active = await tx.select({ id: taskOwnershipReceipts.id }).from(taskOwnershipReceipts)
      .where(and(eq(taskOwnershipReceipts.taskRef, challenge.taskRef), eq(taskOwnershipReceipts.status, "active")));
    for (const old of active) {
      await tx.update(taskOwnershipReceipts).set({ status: "revoked", revokedAt: new Date() }).where(eq(taskOwnershipReceipts.id, old.id));
      await tx.insert(taskOwnershipDecisionEvents).values({ challengeId: id, receiptId: old.id, decision: "revoked", actorId: founderId, reason: "replaced" });
    }
    const receiptIssuedAt = new Date();
    const receiptTtl = (
      challenge.taskRef === "1448"
      && challenge.coordinationActor === "luca-gemini"
      && challenge.intendedActor === "luca-gemini"
    ) ? GATE3_AUTHORITY_TTL : CHALLENGE_TTL;
    const receiptExpiresAt = new Date(receiptIssuedAt.getTime() + receiptTtl);
    const receiptApprovedAt = receiptIssuedAt;
    const receiptId = crypto.randomUUID();
    const payload = canonical({ challengeId: id, receiptId, receiptVersion: 1, taskRef: challenge.taskRef, artifactSha256: challenge.artifactSha256,
      intendedActor: challenge.intendedActor, publicKey: challenge.publicKey, keyFingerprint: challenge.keyFingerprint,
      contextDigest: challenge.contextDigest, approvedBy: founderId, approvedAt: receiptApprovedAt,
      issuedAt: receiptIssuedAt, expiresAt: receiptExpiresAt,
      status: "active" });
    const [receipt] = await tx.insert(taskOwnershipReceipts).values({
      id: receiptId,
      challengeId: id, taskRef: challenge.taskRef, artifactSha256: challenge.artifactSha256,
      intendedActor: challenge.intendedActor, publicKey: challenge.publicKey, keyFingerprint: challenge.keyFingerprint,
      contextDigest: challenge.contextDigest, approvedBy: founderId, approvedAt: receiptApprovedAt, expiresAt: receiptExpiresAt,
      issuedAt: receiptIssuedAt,
      payloadDigest: digest(payload),
    }).returning();
    await tx.insert(taskOwnershipDecisionEvents).values({
      challengeId: id,
      receiptId: receipt.id,
      decision,
      actorId: founderId,
      reason,
    });
    return { id: receipt.id, status: receipt.status, expiresAt: receipt.expiresAt, payloadDigest: receipt.payloadDigest };
  }).then(result => {
    if ("expired" in result) error("CHALLENGE_EXPIRED");
    return result;
  });
}

async function expirePendingChallenges(): Promise<void> {
  await db.transaction(async tx => {
    const now = new Date();
    const expired = await tx.update(taskOwnershipChallenges)
      .set({ status: "expired", decidedAt: now })
      .where(and(eq(taskOwnershipChallenges.status, "pending"), lte(taskOwnershipChallenges.expiresAt, now)))
      .returning({ id: taskOwnershipChallenges.id });
    if (expired.length > 0) {
      await tx.insert(taskOwnershipDecisionEvents).values(expired.map(challenge => ({
        challengeId: challenge.id,
        decision: "expired",
        actorId: "coordination-system",
        reason: "challenge_ttl_elapsed",
      })));
    }
  });
}

export async function revokeReceipt(id: string, founderId: string, reason?: string) {
  if (!founderId) error("FOUNDER_ID_REQUIRED");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(taskOwnershipReceipts).where(and(eq(taskOwnershipReceipts.id, id), eq(taskOwnershipReceipts.status, "active")));
    if (!receipt) error("RECEIPT_NOT_ACTIVE");
    await tx.update(taskOwnershipReceipts).set({ status: "revoked", revokedAt: new Date() }).where(eq(taskOwnershipReceipts.id, id));
    await tx.insert(taskOwnershipDecisionEvents).values({ challengeId: receipt.challengeId, receiptId: id, decision: "revoked", actorId: founderId, reason });
    return { status: "revoked" };
  });
}

export async function issueProofNonce(receiptId: string, actor: string) {
  const [receipt] = await db.select().from(taskOwnershipReceipts).where(and(eq(taskOwnershipReceipts.id, receiptId),
    eq(taskOwnershipReceipts.intendedActor, actor), eq(taskOwnershipReceipts.status, "active"), gt(taskOwnershipReceipts.expiresAt, new Date())));
  if (!receipt) error("RECEIPT_NOT_ACTIVE");
  await requireVerifiedPromotionContext({ id: receipt.challengeId, contextDigest: receipt.contextDigest });
  const [nonce] = await db.insert(taskOwnershipProofNonces).values({ receiptId, nonce: crypto.randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + NONCE_TTL) }).returning();
  const signedPayload = ownershipProofPayload(receipt, nonce);
  return { nonceId: nonce.id, expiresAt: nonce.expiresAt, signedPayload };
}

export async function verifyProof(nonceId: string, signature: string, actor: string) {
  const result = await db.transaction(async tx => {
    const [nonce] = await tx.select().from(taskOwnershipProofNonces).where(eq(taskOwnershipProofNonces.id, nonceId));
    if (!nonce) error("NONCE_INVALID");
    const [claimed] = await tx.update(taskOwnershipProofNonces).set({ consumedAt: new Date() })
      .where(and(eq(taskOwnershipProofNonces.id, nonceId), isNull(taskOwnershipProofNonces.consumedAt), gt(taskOwnershipProofNonces.expiresAt, new Date()))).returning();
    if (!claimed) error("NONCE_REPLAYED");
    const [receipt] = await tx.select().from(taskOwnershipReceipts).where(eq(taskOwnershipReceipts.id, nonce.receiptId));
    if (!receipt) return { ok: false as const, errorCode: "RECEIPT_NOT_FOUND" };
    if (receipt.intendedActor !== actor) {
      await tx.insert(taskOwnershipProofAttempts).values({ nonceId, receiptId: receipt.id, success: false, errorCode: "ACTOR_MISMATCH" });
      return { ok: false as const, errorCode: "ACTOR_MISMATCH" };
    }
    if (receipt.status !== "active" || receipt.expiresAt <= new Date()) {
      await tx.insert(taskOwnershipProofAttempts).values({ nonceId, receiptId: receipt.id, success: false, errorCode: "RECEIPT_NOT_ACTIVE" });
      return { ok: false as const, errorCode: "RECEIPT_NOT_ACTIVE" };
    }
    await requireVerifiedPromotionContext({ id: receipt.challengeId, contextDigest: receipt.contextDigest }, tx);
    const payload = canonical(ownershipProofPayload(receipt, nonce));
    let success = false;
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(receipt.publicKey, "base64url"),
        format: "der",
        type: "spki",
      });
      success = crypto.verify(
        null,
        Buffer.from(payload),
        publicKey,
        Buffer.from(signature || "", "base64url"),
      );
    } catch { /* evidence below */ }
    const proofPayloadDigest = digest(payload);
    await tx.insert(taskOwnershipProofAttempts).values({ nonceId, receiptId: receipt.id, success, errorCode: success ? null : "SIGNATURE_INVALID", payloadDigest: proofPayloadDigest });
    return success
      ? {
          ok: true as const,
          verified: true as const,
          receiptId: receipt.id,
          taskRef: receipt.taskRef,
          artifactSha256: receipt.artifactSha256,
          intendedActor: receipt.intendedActor,
           proofPayloadDigest,
           ...(receipt.contextDigest ? { contextDigest: receipt.contextDigest } : {}),
        }
      : { ok: false as const, errorCode: "SIGNATURE_INVALID" };
  });
  if (result.ok !== true) return error(result.errorCode);
  return result;
}

/**
 * Read-only: does `actor` currently hold a founder-approved, unexpired
 * task-ownership receipt for exactly this `taskRef`? Backs the GitHub
 * publish guard's ownership probe (see
 * server/services/shared-spec-github-publish-guard.ts) so a task can only
 * pass that check by having completed the real challenge/proof protocol
 * above -- not merely by naming an active-looking task reference.
 *
 * `taskOwnershipReceipts` enforces at most one `active` receipt per taskRef
 * (see shared/schema.ts), and a receipt is scoped to the exact
 * `intendedActor` it was issued to, so this cannot be satisfied by a
 * different actor claiming someone else's task.
 */
export async function hasActiveOwnershipReceipt(taskRef: string, actor: string): Promise<boolean> {
  const [receipt] = await db.select({ id: taskOwnershipReceipts.id }).from(taskOwnershipReceipts).where(and(
    eq(taskOwnershipReceipts.taskRef, taskRef),
    eq(taskOwnershipReceipts.intendedActor, actor),
    eq(taskOwnershipReceipts.status, "active"),
    gt(taskOwnershipReceipts.expiresAt, new Date()),
  ));
  return Boolean(receipt);
}