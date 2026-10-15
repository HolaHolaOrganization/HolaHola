import { and, eq, sql } from "drizzle-orm";
import {
  coordinationGate3ProofGrants,
  coordinationRuntimeCredentials,
  coordinationRuntimeProfiles,
  coordinationRuntimeRegistrations,
  coordinationCredentialAuditEvents,
  taskOwnershipChallenges,
  taskOwnershipProofAttempts,
  taskOwnershipReceipts,
} from "@shared/schema";
import type { BrokerCredential } from "./coordination-credential-broker";
import { getSharedDb } from "../db";
import { deriveAntigravityRuntimeId, GATE3 } from "./antigravity-provisioning-bundle";
import {
  COORDINATION_GEMINI_ADAPTER_VERSION,
  COORDINATION_GEMINI_MODEL,
} from "./coordination-gemini-adapter";

const ACTOR = "luca-gemini";
const TASK_REF = "1448";
const GRANT_TTL_MS = 15 * 60_000;
const fail = (code = "GATE3_PROOF_GRANT_INVALID"): never => {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  throw error;
};
type SuccessfulProof = {
  ok: true;
  verified: true;
  receiptId: string;
  taskRef: string;
  artifactSha256: string;
  intendedActor: string;
  proofPayloadDigest: string;
};

export function computeGate3GrantExpiry(
  issuedAt: Date,
  challengeExpiresAt: Date,
  receiptExpiresAt: Date,
  credentialExpiresAt: Date,
): Date {
  return new Date(Math.min(
    challengeExpiresAt.getTime(),
    receiptExpiresAt.getTime(),
    credentialExpiresAt.getTime(),
    issuedAt.getTime() + GRANT_TTL_MS,
  ));
}

const sameValues = (actual: string[], expected: readonly string[]) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

export function isGate3BrokerCredential(
  credential: BrokerCredential | undefined,
): credential is BrokerCredential {
  return Boolean(
    credential
    && credential.actor === ACTOR
    && /^luca-gemini-antigravity-[0-9a-f]{24}$/.test(credential.runtimeId),
  );
}

function requireGate3BrokerCredential(
  credential: BrokerCredential | undefined,
): BrokerCredential {
  const authenticatedCredential = credential ?? fail();
  if (
    authenticatedCredential.actor !== ACTOR
    || !/^luca-gemini-antigravity-[0-9a-f]{24}$/.test(authenticatedCredential.runtimeId)
  ) fail();
  return authenticatedCredential;
}

export async function issueGate3ProofGrant(
  proof: SuccessfulProof,
  credential: BrokerCredential | undefined,
) {
  const authenticatedCredential = requireGate3BrokerCredential(credential);
  if (proof.verified !== true) fail();
  const credentialId: string | undefined = authenticatedCredential.credentialId;
  const runtimeId: string | undefined = authenticatedCredential.runtimeId;
  if (!credentialId || !runtimeId) fail();
  const boundCredentialId = credentialId;
  const boundRuntimeId = runtimeId;
  return getSharedDb().transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${'gate3-credential:' + boundCredentialId}, 0)
      )
    `);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${proof.receiptId}, 0))`);
    const [registration] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, boundRuntimeId!)).for("update");
    const [profile] = await tx.select().from(coordinationRuntimeProfiles)
      .where(and(eq(coordinationRuntimeProfiles.runtimeRegistrationId, boundRuntimeId), eq(coordinationRuntimeProfiles.status, "active")))
      .for("update");
    const [storedCredential] = await tx.select().from(coordinationRuntimeCredentials)
      .where(eq(coordinationRuntimeCredentials.id, boundCredentialId!)).for("update");
    const [receipt] = await tx.select().from(taskOwnershipReceipts)
      .where(eq(taskOwnershipReceipts.id, proof.receiptId)).for("update");
    if (!receipt || receipt.status !== "active" || receipt.expiresAt <= new Date()) fail();
    const [challenge] = await tx.select().from(taskOwnershipChallenges)
      .where(eq(taskOwnershipChallenges.id, receipt.challengeId)).for("update");
    if (
      !challenge || challenge.purpose !== "runtime_provisioning" || challenge.status !== "approved" || challenge.expiresAt <= new Date()
      || challenge.taskRef !== receipt.taskRef
      || challenge.artifactSha256 !== receipt.artifactSha256
      || challenge.intendedActor !== receipt.intendedActor
      || challenge.publicKey !== receipt.publicKey
      || challenge.keyFingerprint !== receipt.keyFingerprint
      || !storedCredential || storedCredential.runtimeId !== boundRuntimeId
      || storedCredential.actor !== ACTOR || storedCredential.revokedAt
      || storedCredential.expiresAt <= new Date()
       || !sameValues(storedCredential.capabilities, GATE3.credentialCapabilities)
      || !registration || registration.id !== boundRuntimeId || registration.actor !== ACTOR
      || !registration.enabled || registration.revokedAt
       || !profile || profile.actor !== ACTOR
       || !sameValues(profile.capabilities, GATE3.runtimeCapabilities)
       || profile.provider !== "gemini"
       || profile.model !== COORDINATION_GEMINI_MODEL
       || profile.adapterVersion !== COORDINATION_GEMINI_ADAPTER_VERSION
      || receipt.taskRef !== TASK_REF || receipt.intendedActor !== ACTOR
       || receipt.id !== proof.receiptId
      || receipt.artifactSha256 !== proof.artifactSha256
      || proof.taskRef !== TASK_REF || proof.intendedActor !== ACTOR
       || !/^[0-9a-f]{64}$/.test(proof.proofPayloadDigest)
      || !receipt.contextDigest || challenge.contextDigest !== receipt.contextDigest
      || profile.startingCommit.length === 0
     ) fail();
     if (profile.id !== `antigravity-${receipt.contextDigest}`
       || profile.runtimeRegistrationId !== boundRuntimeId) fail();
     const generationAudits = await tx.select().from(coordinationCredentialAuditEvents)
       .where(and(
         eq(coordinationCredentialAuditEvents.runtimeId, boundRuntimeId),
         eq(coordinationCredentialAuditEvents.eventType, "runtime_generation_provisioned"),
         eq(coordinationCredentialAuditEvents.success, true),
       )).limit(2);
     const [generationAudit] = generationAudits;
     const generation = generationAudit?.metadata as Record<string, unknown> | undefined;
     if (generationAudits.length !== 1 || !generation
       || generation.runtimeId !== boundRuntimeId
       || generation.profileId !== profile.id
       || generation.receiptId !== receipt.id
       || generation.challengeId !== challenge.id
       || generation.actor !== ACTOR || generation.taskRef !== TASK_REF
       || generation.artifactSha256 !== receipt.artifactSha256
       || generation.keyFingerprint !== receipt.keyFingerprint
       || generation.bundleDigest !== receipt.contextDigest
       || typeof generation.bootstrapSha256 !== "string"
       || !/^[0-9a-f]{64}$/.test(generation.bootstrapSha256)
       || deriveAntigravityRuntimeId(generation.bootstrapSha256) !== boundRuntimeId
       || generation.startingCommit !== profile.startingCommit
       || generation.worktreeRealpathDigest !== profile.worktreeRealpathDigest
       || generation.registrationOutcome !== "created") fail();
    const contextDigest = receipt.contextDigest as string;
    const [proofAttempt] = await tx.select({ id: taskOwnershipProofAttempts.id })
      .from(taskOwnershipProofAttempts)
      .where(and(
        eq(taskOwnershipProofAttempts.receiptId, receipt.id),
        eq(taskOwnershipProofAttempts.success, true),
        eq(taskOwnershipProofAttempts.payloadDigest, proof.proofPayloadDigest),
      ));
    if (!proofAttempt) fail();
    const proofPayloadDigest = proof.proofPayloadDigest;
    const [existing] = await tx.select().from(coordinationGate3ProofGrants).where(and(
      eq(coordinationGate3ProofGrants.receiptId, receipt.id),
      eq(coordinationGate3ProofGrants.credentialId, storedCredential.id),
      eq(coordinationGate3ProofGrants.runtimeRegistrationId, registration.id),
      eq(coordinationGate3ProofGrants.profileId, profile.id),
    ));
    if (existing) return existing;
    const issuedAt = new Date();
    const expiresAt = computeGate3GrantExpiry(
      issuedAt,
      challenge.expiresAt,
      receipt.expiresAt,
      storedCredential.expiresAt,
    );
    if (expiresAt <= issuedAt) fail();
    const [grant] = await tx.insert(coordinationGate3ProofGrants).values({
      receiptId: receipt.id,
      credentialId: storedCredential.id,
      runtimeRegistrationId: registration.id,
      profileId: profile.id,
      actor: ACTOR,
      taskRef: receipt.taskRef,
      artifactSha256: receipt.artifactSha256,
      contextDigest,
      startingCommit: profile.startingCommit,
      proofPayloadDigest,
      issuedAt,
      expiresAt,
    }).returning();
    return grant;
  });
}

export async function validateGate3ProofGrant(grantId: string, credential: BrokerCredential | undefined) {
  const authenticatedCredential = requireGate3BrokerCredential(credential);
  const now = new Date();
  const [row] = await getSharedDb().select({
    grant: coordinationGate3ProofGrants,
    receipt: taskOwnershipReceipts,
    challenge: taskOwnershipChallenges,
    credentialRow: coordinationRuntimeCredentials,
    registration: coordinationRuntimeRegistrations,
    profile: coordinationRuntimeProfiles,
    proofAttempt: taskOwnershipProofAttempts,
  }).from(coordinationGate3ProofGrants)
    .innerJoin(taskOwnershipReceipts, eq(coordinationGate3ProofGrants.receiptId, taskOwnershipReceipts.id))
    .innerJoin(taskOwnershipChallenges, eq(taskOwnershipReceipts.challengeId, taskOwnershipChallenges.id))
    .innerJoin(coordinationRuntimeCredentials, eq(coordinationGate3ProofGrants.credentialId, coordinationRuntimeCredentials.id))
    .innerJoin(coordinationRuntimeRegistrations, eq(coordinationGate3ProofGrants.runtimeRegistrationId, coordinationRuntimeRegistrations.id))
    .innerJoin(coordinationRuntimeProfiles, eq(coordinationGate3ProofGrants.profileId, coordinationRuntimeProfiles.id))
    .innerJoin(taskOwnershipProofAttempts, and(
      eq(taskOwnershipProofAttempts.receiptId, coordinationGate3ProofGrants.receiptId),
      eq(taskOwnershipProofAttempts.payloadDigest, coordinationGate3ProofGrants.proofPayloadDigest),
      eq(taskOwnershipProofAttempts.success, true),
    ))
    .where(eq(coordinationGate3ProofGrants.id, grantId));
  if (!row) fail();
  const { grant, receipt, challenge, credentialRow, registration, profile, proofAttempt } = row;
  const generationAudits = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(and(
      eq(coordinationCredentialAuditEvents.runtimeId, grant.runtimeRegistrationId),
      eq(coordinationCredentialAuditEvents.eventType, "runtime_generation_provisioned"),
      eq(coordinationCredentialAuditEvents.success, true),
    )).limit(2);
  const [generationAudit] = generationAudits;
  const generation = generationAudit?.metadata as Record<string, unknown> | undefined;
  if (generationAudits.length !== 1 || !generation
    || generation.runtimeId !== grant.runtimeRegistrationId
    || generation.profileId !== profile.id
    || generation.receiptId !== receipt.id
    || generation.challengeId !== challenge.id
    || generation.actor !== ACTOR || generation.taskRef !== TASK_REF
    || generation.bundleDigest !== receipt.contextDigest
    || typeof generation.bootstrapSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(generation.bootstrapSha256)
    || deriveAntigravityRuntimeId(generation.bootstrapSha256) !== grant.runtimeRegistrationId
    || generation.artifactSha256 !== receipt.artifactSha256
    || generation.keyFingerprint !== receipt.keyFingerprint
    || generation.startingCommit !== profile.startingCommit
    || generation.worktreeRealpathDigest !== profile.worktreeRealpathDigest
    || generation.registrationOutcome !== "created") fail();
  if (
    grant.revokedAt || grant.expiresAt <= now || grant.actor !== ACTOR || grant.taskRef !== TASK_REF
    || grant.receiptId !== receipt.id || grant.credentialId !== credentialRow.id
    || credentialRow.id !== authenticatedCredential.credentialId
    || grant.runtimeRegistrationId !== registration.id || grant.profileId !== profile.id
    || receipt.status !== "active" || receipt.expiresAt <= now || receipt.intendedActor !== ACTOR
    || receipt.taskRef !== TASK_REF || !receipt.contextDigest
    || challenge.purpose !== "runtime_provisioning"
    || challenge.status !== "approved" || challenge.expiresAt <= now || challenge.taskRef !== receipt.taskRef
    || challenge.artifactSha256 !== receipt.artifactSha256 || challenge.contextDigest !== receipt.contextDigest
    || challenge.publicKey !== receipt.publicKey || challenge.keyFingerprint !== receipt.keyFingerprint
    || proofAttempt.receiptId !== receipt.id || proofAttempt.payloadDigest !== grant.proofPayloadDigest
    || credentialRow.runtimeId !== grant.runtimeRegistrationId || credentialRow.actor !== ACTOR
    || credentialRow.revokedAt || credentialRow.expiresAt <= now
    || !sameValues(credentialRow.capabilities, GATE3.credentialCapabilities)
    || registration.id !== grant.runtimeRegistrationId || registration.actor !== ACTOR
    || !registration.enabled || registration.revokedAt
    || profile.runtimeRegistrationId !== grant.runtimeRegistrationId || profile.id !== `antigravity-${receipt.contextDigest}` || profile.actor !== ACTOR || profile.status !== "active"
    || !sameValues(profile.capabilities, GATE3.runtimeCapabilities)
    || profile.provider !== "gemini" || profile.model !== COORDINATION_GEMINI_MODEL
    || profile.adapterVersion !== COORDINATION_GEMINI_ADAPTER_VERSION
    || grant.artifactSha256 !== receipt.artifactSha256 || grant.contextDigest !== receipt.contextDigest
    || grant.startingCommit !== profile.startingCommit
  ) fail();
  return {
    grantId: grant.id,
    actor: grant.actor,
    taskRef: grant.taskRef,
    artifactSha256: grant.artifactSha256,
    contextDigest: grant.contextDigest,
    startingCommit: grant.startingCommit,
    receiptId: receipt.id,
    credentialId: credentialRow.id,
    runtimeRegistrationId: registration.id,
    profileId: profile.id,
    expiresAt: grant.expiresAt,
  };
}

/** Validates the executor's Gate 3 lineage for an independent Luca verifier.
 * The verifier may have a different broker credential; all grant, receipt,
 * challenge, proof-attempt, registration, and profile bindings remain required.
 */
export async function validateGate3ProofGrantForVerifier(grantId: string) {
  const [row] = await getSharedDb().select({
    grant: coordinationGate3ProofGrants,
    receipt: taskOwnershipReceipts,
    challenge: taskOwnershipChallenges,
    credentialRow: coordinationRuntimeCredentials,
    registration: coordinationRuntimeRegistrations,
    profile: coordinationRuntimeProfiles,
    proofAttempt: taskOwnershipProofAttempts,
  }).from(coordinationGate3ProofGrants)
    .innerJoin(taskOwnershipReceipts, eq(coordinationGate3ProofGrants.receiptId, taskOwnershipReceipts.id))
    .innerJoin(taskOwnershipChallenges, eq(taskOwnershipReceipts.challengeId, taskOwnershipChallenges.id))
    .innerJoin(coordinationRuntimeCredentials, eq(coordinationGate3ProofGrants.credentialId, coordinationRuntimeCredentials.id))
    .innerJoin(coordinationRuntimeRegistrations, eq(coordinationGate3ProofGrants.runtimeRegistrationId, coordinationRuntimeRegistrations.id))
    .innerJoin(coordinationRuntimeProfiles, eq(coordinationGate3ProofGrants.profileId, coordinationRuntimeProfiles.id))
    .innerJoin(taskOwnershipProofAttempts, and(
      eq(taskOwnershipProofAttempts.receiptId, coordinationGate3ProofGrants.receiptId),
      eq(taskOwnershipProofAttempts.payloadDigest, coordinationGate3ProofGrants.proofPayloadDigest),
      eq(taskOwnershipProofAttempts.success, true),
    ))
    .where(eq(coordinationGate3ProofGrants.id, grantId));
  const now = new Date();
  if (!row) fail();
  const { grant, receipt, challenge, credentialRow, registration, profile, proofAttempt } = row;
  const generationAudits = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(and(
      eq(coordinationCredentialAuditEvents.runtimeId, grant.runtimeRegistrationId),
      eq(coordinationCredentialAuditEvents.eventType, "runtime_generation_provisioned"),
      eq(coordinationCredentialAuditEvents.success, true),
    )).limit(2);
  const [generationAudit] = generationAudits;
  const generation = generationAudit?.metadata as Record<string, unknown> | undefined;
  if (generationAudits.length !== 1 || !generation
    || generation.runtimeId !== grant.runtimeRegistrationId
    || generation.profileId !== profile.id
    || generation.receiptId !== receipt.id
    || generation.challengeId !== challenge.id
    || generation.actor !== ACTOR || generation.taskRef !== TASK_REF
    || generation.bundleDigest !== receipt.contextDigest
    || typeof generation.bootstrapSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(generation.bootstrapSha256)
    || deriveAntigravityRuntimeId(generation.bootstrapSha256) !== grant.runtimeRegistrationId
    || generation.artifactSha256 !== receipt.artifactSha256
    || generation.keyFingerprint !== receipt.keyFingerprint
    || generation.startingCommit !== profile.startingCommit
    || generation.worktreeRealpathDigest !== profile.worktreeRealpathDigest
    || generation.registrationOutcome !== "created") fail();
  if (
    grant.revokedAt || grant.expiresAt <= now || grant.actor !== ACTOR || grant.taskRef !== TASK_REF ||
    grant.receiptId !== receipt.id || grant.credentialId !== credentialRow.id ||
    grant.runtimeRegistrationId !== registration.id || grant.profileId !== profile.id ||
    receipt.status !== 'active' || receipt.expiresAt <= now || receipt.intendedActor !== ACTOR ||
    receipt.taskRef !== TASK_REF || !receipt.contextDigest ||
    challenge.purpose !== 'runtime_provisioning' ||
    challenge.status !== 'approved' || challenge.expiresAt <= now || challenge.taskRef !== receipt.taskRef ||
    challenge.intendedActor !== receipt.intendedActor ||
    challenge.artifactSha256 !== receipt.artifactSha256 || challenge.contextDigest !== receipt.contextDigest ||
    challenge.publicKey !== receipt.publicKey || challenge.keyFingerprint !== receipt.keyFingerprint ||
    credentialRow.runtimeId !== grant.runtimeRegistrationId || credentialRow.actor !== ACTOR || credentialRow.revokedAt ||
    credentialRow.expiresAt <= now || !sameValues(credentialRow.capabilities, GATE3.credentialCapabilities) ||
    registration.id !== grant.runtimeRegistrationId || registration.actor !== ACTOR || !registration.enabled || registration.revokedAt ||
    profile.runtimeRegistrationId !== grant.runtimeRegistrationId || profile.id !== `antigravity-${receipt.contextDigest}` || profile.actor !== ACTOR || profile.status !== 'active' ||
    !sameValues(profile.capabilities, GATE3.runtimeCapabilities) || profile.provider !== 'gemini' ||
    profile.model !== COORDINATION_GEMINI_MODEL || profile.adapterVersion !== COORDINATION_GEMINI_ADAPTER_VERSION ||
    grant.artifactSha256 !== receipt.artifactSha256 || grant.contextDigest !== receipt.contextDigest ||
    grant.startingCommit !== profile.startingCommit ||
    proofAttempt.receiptId !== receipt.id || proofAttempt.payloadDigest !== grant.proofPayloadDigest
  ) fail();
  return {
    grantId: grant.id, actor: grant.actor, taskRef: grant.taskRef,
    artifactSha256: grant.artifactSha256, contextDigest: grant.contextDigest,
    startingCommit: grant.startingCommit, receiptId: receipt.id,
    credentialId: credentialRow.id, runtimeRegistrationId: registration.id,
    profileId: profile.id, expiresAt: grant.expiresAt,
  };
}

type GrantAuthorityOperation<T> = (grant: Awaited<ReturnType<typeof validateGate3ProofGrantForVerifier>>) => Promise<T>;
export type Gate3AuthorityTransaction = <T>(operation: (tx: any) => Promise<T>) => Promise<T>;
const sharedDbTransaction: Gate3AuthorityTransaction = (operation) => getSharedDb().transaction(operation);

/**
 * Holds the complete Gate 3 authority chain locked until the protected
 * operation commits.  This is deliberately separate from the read validator:
 * revocation/disable updates must wait for the model/evidence mutation.
 */
export async function withGate3ProofGrantAuthority<T>(
  grantId: string,
  credential: BrokerCredential | undefined,
  operation: GrantAuthorityOperation<T>,
  transaction: Gate3AuthorityTransaction = sharedDbTransaction,
): Promise<T> {
  return transaction(async (tx) => {
    const [grantReference] = await tx.select().from(coordinationGate3ProofGrants)
      .where(eq(coordinationGate3ProofGrants.id, grantId));
    if (!grantReference) fail();
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${'gate3-credential:' + grantReference.credentialId}, 0)
      )
    `);
    const [registration] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, grantReference.runtimeRegistrationId)).for('no key update');
    const [profile] = await tx.select().from(coordinationRuntimeProfiles)
      .where(eq(coordinationRuntimeProfiles.id, grantReference.profileId)).for('no key update');
    const [credentialRow] = await tx.select().from(coordinationRuntimeCredentials)
      .where(eq(coordinationRuntimeCredentials.id, grantReference.credentialId)).for('no key update');
    const [receipt] = await tx.select().from(taskOwnershipReceipts)
      .where(eq(taskOwnershipReceipts.id, grantReference.receiptId)).for('no key update');
    if (!receipt) fail();
    const [challenge] = await tx.select().from(taskOwnershipChallenges)
      .where(eq(taskOwnershipChallenges.id, receipt.challengeId)).for('no key update');
    const [grant] = await tx.select().from(coordinationGate3ProofGrants)
      .where(eq(coordinationGate3ProofGrants.id, grantId)).for('no key update');
    if (
      !grant || !challenge || !credentialRow || !registration || !profile
      || grant.receiptId !== grantReference.receiptId
      || grant.credentialId !== grantReference.credentialId
      || grant.runtimeRegistrationId !== grantReference.runtimeRegistrationId
      || grant.profileId !== grantReference.profileId
    ) fail();
    // The public validator performs the exact complete binding checks. The
    // locks above remain held while operation executes.
    const validated = await validateGate3ProofGrant(grantId, credential);
    return operation(validated);
  });
}

export async function withGate3VerifierGrantAuthority<T>(
  grantId: string,
  operation: GrantAuthorityOperation<T>,
): Promise<T> {
  return getSharedDb().transaction(async (tx) => {
    const [grantReference] = await tx.select().from(coordinationGate3ProofGrants)
      .where(eq(coordinationGate3ProofGrants.id, grantId));
    if (!grantReference) fail();
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${'gate3-credential:' + grantReference.credentialId}, 0)
      )
    `);
    const [registration] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, grantReference.runtimeRegistrationId)).for('no key update');
    const [profile] = await tx.select().from(coordinationRuntimeProfiles)
      .where(eq(coordinationRuntimeProfiles.id, grantReference.profileId)).for('no key update');
    const [credentialRow] = await tx.select().from(coordinationRuntimeCredentials)
      .where(eq(coordinationRuntimeCredentials.id, grantReference.credentialId)).for('no key update');
    const [receipt] = await tx.select().from(taskOwnershipReceipts)
      .where(eq(taskOwnershipReceipts.id, grantReference.receiptId)).for('no key update');
    if (!receipt) fail();
    const [challenge] = await tx.select().from(taskOwnershipChallenges)
      .where(eq(taskOwnershipChallenges.id, receipt.challengeId)).for('no key update');
    const [grant] = await tx.select().from(coordinationGate3ProofGrants)
      .where(eq(coordinationGate3ProofGrants.id, grantId)).for('no key update');
    if (
      !grant || !challenge || !credentialRow || !registration || !profile
      || grant.receiptId !== grantReference.receiptId
      || grant.credentialId !== grantReference.credentialId
      || grant.runtimeRegistrationId !== grantReference.runtimeRegistrationId
      || grant.profileId !== grantReference.profileId
    ) fail();
    const validated = await validateGate3ProofGrantForVerifier(grantId);
    return operation(validated);
  });
}