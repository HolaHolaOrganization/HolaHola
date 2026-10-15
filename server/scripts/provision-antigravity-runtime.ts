/**
 * Trusted, Replit-side Gate 3 operator provisioning.
 *
 * This is deliberately a script/service rather than an HTTP handler.  Its
 * inputs are public bundle bytes only; in particular, there is no parameter
 * which can contain a bootstrap or access credential.
 */
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { and, eq, sql } from "drizzle-orm";
import { closeDbConnections, getSharedDb } from "../db";
import {
  coordinationCredentialAuditEvents,
  coordinationGate3ProofGrants,
  coordinationRuntimeProfiles,
  coordinationRuntimeRegistrations,
  taskOwnershipChallenges,
  taskOwnershipReceipts,
} from "@shared/schema";
import {
  GATE3,
  type PublicProvisioningBundle,
  validatePublicProvisioningBundle,
} from "../services/antigravity-provisioning-bundle";
import {
  canonicalJson,
  createChallenge,
} from "../services/founder-task-ownership-service";
import {
  consumedCoordinationBootstrapHash,
  registerCoordinationRuntimeWithBootstrapSha256InExecutor,
} from "../services/coordination-credential-broker";

const MAX_BUNDLE_BYTES = 1024 * 1024;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AntigravityProvisioningError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`antigravity_provisioning_${code}`);
    this.name = "AntigravityProvisioningError";
    this.code = code;
  }
}

function checkedBundle(value: unknown): PublicProvisioningBundle {
  try {
    validatePublicProvisioningBundle(value);
  } catch {
    throw new AntigravityProvisioningError("invalid_bundle");
  }
  const bundle = value as PublicProvisioningBundle;
  if (!bundle.bundleDigest) throw new AntigravityProvisioningError("bundle_digest_required");
  return bundle;
}

/**
 * Phase A only creates the founder challenge.  Runtime and profile rows are
 * intentionally not touched here.
 */
export async function submitAntigravityChallenge(value: unknown, attemptIdValue: unknown): Promise<{
  challengeId: string;
  taskDigest: string;
  keyFingerprint: string;
  bundleDigest: string;
  attemptId: string;
  expiresAt: Date;
}> {
  const bundle = checkedBundle(value);
  if (typeof attemptIdValue !== "string" || attemptIdValue.length === 0) {
    throw new AntigravityProvisioningError("attempt_id_required");
  }
  if (!CANONICAL_UUID.test(attemptIdValue)) {
    throw new AntigravityProvisioningError("attempt_id_invalid");
  }
  const attemptId = attemptIdValue;
  try {
    const result = await createChallenge({
      taskRef: GATE3.taskRef,
      artifactSha256: bundle.artifactSha256,
      intendedActor: GATE3.actor,
      coordinationActor: GATE3.actor,
      publicKey: bundle.publicKey,
      keyFingerprint: bundle.keyFingerprint,
      contextDigest: bundle.bundleDigest,
       purpose: "runtime_provisioning",
      idempotencyKey: `antigravity:${bundle.bundleDigest}:${attemptId}`,
      ttlMs: 20 * 60_000,
    });
    return {
      challengeId: result.challengeId,
      taskDigest: bundle.artifactSha256,
      keyFingerprint: bundle.keyFingerprint,
      bundleDigest: bundle.bundleDigest,
      attemptId,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    if (error instanceof AntigravityProvisioningError) throw error;
    throw new AntigravityProvisioningError("challenge_failed");
  }
}

function profileMatches(row: typeof coordinationRuntimeProfiles.$inferSelect, bundle: PublicProvisioningBundle): boolean {
  return row.id === `antigravity-${bundle.bundleDigest}`
    && row.runtimeRegistrationId === bundle.runtimeId
    && row.actor === bundle.actor
    && canonicalJson(row.capabilities) === canonicalJson(bundle.runtimeCapabilities)
    && row.provider === bundle.provider
    && row.model === bundle.model
    && row.adapterVersion === bundle.adapterVersion
    && row.repositoryLabel === bundle.repositoryLabel
    && row.worktreeLabel === bundle.worktreeLabel
    && row.worktreeRealpathDigest === bundle.worktreeRealpathDigest
    && row.branch === bundle.branch
    && row.startingCommit === bundle.startingCommit
    && row.status === "active";
}

function registrationMatches(
  row: typeof coordinationRuntimeRegistrations.$inferSelect,
  bundle: PublicProvisioningBundle,
): boolean {
  return row.actor === bundle.actor
    && row.displayName === bundle.worktreeLabel
    && canonicalJson(row.capabilities) === canonicalJson(bundle.credentialCapabilities)
    && row.tokenTtlSeconds === bundle.tokenTtlSeconds
    && row.enabled
    && !row.revokedAt;
}

/**
 * Phase B rereads the challenge and the bundle, and fails closed unless the
 * founder receipt is active, unexpired, and byte-for-byte bound to the bundle.
 */
export async function registerAntigravityRuntime(value: unknown, challengeId: string): Promise<{
  runtimeId: string;
  profileId: string;
  challengeId: string;
  receiptId: string;
  bundleDigest: string;
  status: "created" | "replayed";
}> {
  const bundle = checkedBundle(value);
  if (!challengeId || challengeId.length > 200) throw new AntigravityProvisioningError("challenge_required");

  const db = getSharedDb();
  const result = await db.transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${bundle.runtimeId}, 0))
    `);
    const [registrationSnapshot] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, bundle.runtimeId));
    const bootstrapDigests = [...new Set(
      [registrationSnapshot?.bootstrapHash, bundle.bootstrapSha256].filter(
        (value): value is string => Boolean(value),
      ),
    )].sort();
    for (const digest of bootstrapDigests) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${digest}, 0))
      `);
    }
    const [existingRegistration] = await tx.select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, bundle.runtimeId))
      .for("update");
    const [existingProfile] = await tx.select().from(coordinationRuntimeProfiles)
      .where(and(
        eq(coordinationRuntimeProfiles.runtimeRegistrationId, bundle.runtimeId),
        eq(coordinationRuntimeProfiles.status, "active"),
      ))
      .for("update");
    const [receipt] = await tx.select().from(taskOwnershipReceipts)
      .where(eq(taskOwnershipReceipts.challengeId, challengeId)).for("update");
    const [fullChallenge] = await tx.select().from(taskOwnershipChallenges)
      .where(eq(taskOwnershipChallenges.id, challengeId)).for("update");
    if (!fullChallenge || !receipt || fullChallenge.status !== "approved") {
      throw new AntigravityProvisioningError("challenge_not_approved");
    }
    if (fullChallenge.expiresAt <= new Date() || receipt.expiresAt <= new Date()) {
      throw new AntigravityProvisioningError("challenge_expired");
    }
    if (receipt.status !== "active" || receipt.revokedAt
      || fullChallenge.taskRef !== bundle.taskRef
      || fullChallenge.artifactSha256 !== bundle.artifactSha256
      || fullChallenge.coordinationActor !== bundle.actor
      || fullChallenge.intendedActor !== bundle.actor
      || fullChallenge.publicKey !== bundle.publicKey
      || fullChallenge.keyFingerprint !== bundle.keyFingerprint
      || fullChallenge.contextDigest !== bundle.bundleDigest
      || fullChallenge.purpose !== "runtime_provisioning"
      || receipt.taskRef !== bundle.taskRef
      || receipt.artifactSha256 !== bundle.artifactSha256
      || receipt.intendedActor !== bundle.actor
      || receipt.publicKey !== bundle.publicKey
      || receipt.keyFingerprint !== bundle.keyFingerprint
      || receipt.contextDigest !== bundle.bundleDigest) {
      throw new AntigravityProvisioningError("receipt_mismatch");
    }
    if (existingProfile && !profileMatches(existingProfile, bundle)) {
      throw new AntigravityProvisioningError("profile_conflict");
    }
    if (existingRegistration && !existingProfile) {
      throw new AntigravityProvisioningError("profile_missing");
    }
    const registrationInput = {
      runtimeId: bundle.runtimeId,
      actor: bundle.actor as "luca-gemini",
      displayName: bundle.worktreeLabel,
      capabilities: bundle.credentialCapabilities as ("coordination:read" | "coordination:write" | "coordination:inbox:ack" | "coordination:credential:renew")[],
      tokenTtlSeconds: bundle.tokenTtlSeconds,
      bootstrapSha256: bundle.bootstrapSha256,
    };
    let registration: {
      runtimeId: string;
      actor: string;
      displayName: string;
      capabilities: string[];
      tokenTtlSeconds: number;
      status: "created" | "replayed";
    };
    const replaying = Boolean(existingRegistration);
    if (existingRegistration) {
      // A runtime ID is a generation identity, not a recovery slot. The only
      // legal second Phase B call is an exact replay of this generation.
      // Bootstrap consumption replaces the raw digest with one deterministic
      // tombstone; accepting that tombstone does not reopen bootstrap authority.
      const consumedBootstrapHash = consumedCoordinationBootstrapHash(
        bundle.runtimeId,
        bundle.bootstrapSha256,
      );
      if (!registrationMatches(existingRegistration, bundle)
        || (existingRegistration.bootstrapHash !== bundle.bootstrapSha256
          && existingRegistration.bootstrapHash !== consumedBootstrapHash)) {
        throw new AntigravityProvisioningError("replay_registration_conflict");
      }
      registration = {
        runtimeId: bundle.runtimeId,
        actor: "luca-gemini",
        displayName: bundle.worktreeLabel,
        capabilities: registrationInput.capabilities,
        tokenTtlSeconds: bundle.tokenTtlSeconds,
        status: "replayed",
      };
    } else {
      registration = await registerCoordinationRuntimeWithBootstrapSha256InExecutor(
        registrationInput,
        executor,
      );
    }
    let profileId = existingProfile?.id;
    if (!existingProfile) {
      profileId = `antigravity-${bundle.bundleDigest}`;
      await tx.insert(coordinationRuntimeProfiles).values({
        id: profileId,
        runtimeRegistrationId: bundle.runtimeId,
        actor: bundle.actor,
        capabilities: bundle.runtimeCapabilities,
        provider: bundle.provider,
        model: bundle.model,
        adapterVersion: bundle.adapterVersion,
        repositoryLabel: bundle.repositoryLabel,
        worktreeLabel: bundle.worktreeLabel,
        worktreeRealpathDigest: bundle.worktreeRealpathDigest,
        branch: bundle.branch,
        startingCommit: bundle.startingCommit,
      });
    }
    const generationMetadata = {
      runtimeId: bundle.runtimeId,
      profileId: profileId!,
      challengeId,
      receiptId: receipt.id,
      actor: bundle.actor,
      taskRef: bundle.taskRef,
      artifactSha256: bundle.artifactSha256,
      keyFingerprint: bundle.keyFingerprint,
      bundleDigest: bundle.bundleDigest,
      bootstrapSha256: bundle.bootstrapSha256,
      worktreeRealpathDigest: bundle.worktreeRealpathDigest,
      startingCommit: bundle.startingCommit,
      // The audit records the provisioning result, while a replay is not a
      // second provisioning outcome.
      registrationOutcome: "created",
    };
    const priorGenerations = await tx.select({
      id: coordinationCredentialAuditEvents.id,
      metadata: coordinationCredentialAuditEvents.metadata,
    })
      .from(coordinationCredentialAuditEvents).where(and(
        eq(coordinationCredentialAuditEvents.eventType, "runtime_generation_provisioned"),
        eq(coordinationCredentialAuditEvents.runtimeId, bundle.runtimeId),
        eq(coordinationCredentialAuditEvents.success, true),
      )).limit(2);
    if (priorGenerations.length > 1) {
      throw new AntigravityProvisioningError("generation_audit_conflict");
    }
    const [priorGeneration] = priorGenerations;
    if (priorGeneration) {
      const metadata = priorGeneration.metadata;
      if (!metadata || canonicalJson(metadata) !== canonicalJson(generationMetadata)) {
        throw new AntigravityProvisioningError("generation_audit_conflict");
      }
    } else if (replaying) {
      throw new AntigravityProvisioningError("generation_audit_missing");
    } else {
      await tx.insert(coordinationCredentialAuditEvents).values({
        eventType: "runtime_generation_provisioned",
        success: true,
        runtimeId: bundle.runtimeId,
        actor: bundle.actor,
        metadata: generationMetadata,
      });
    }
    return { registration, receiptId: receipt.id, profileId: profileId! };
  });
  return {
    runtimeId: bundle.runtimeId,
    profileId: result.profileId,
    challengeId,
    receiptId: result.receiptId,
    bundleDigest: bundle.bundleDigest,
    status: result.registration.status,
  };
}

async function readBundle(path?: string): Promise<unknown> {
  const bytes = path ? await readFile(path) : await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    stdin.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BUNDLE_BYTES) reject(new AntigravityProvisioningError("bundle_too_large"));
      else chunks.push(chunk);
    });
    stdin.on("end", () => resolve(Buffer.concat(chunks)));
    stdin.on("error", reject);
  });
  if (bytes.length > MAX_BUNDLE_BYTES) throw new AntigravityProvisioningError("bundle_too_large");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new AntigravityProvisioningError("invalid_bundle"); }
}

if (process.argv[1]?.endsWith("provision-antigravity-runtime.ts")) {
  const phase = process.argv[2];
  const bundlePath = process.argv.includes("--bundle") ? process.argv[process.argv.indexOf("--bundle") + 1] : undefined;
  const challengeId = process.argv.includes("--challenge-id") ? process.argv[process.argv.indexOf("--challenge-id") + 1] : undefined;
  const attemptId = process.argv.includes("--attempt-id") ? process.argv[process.argv.indexOf("--attempt-id") + 1] : undefined;
  readBundle(bundlePath).then(async (bundle) => {
    if (phase === "phase-a") return submitAntigravityChallenge(bundle, attemptId);
    if (phase === "phase-b" && challengeId) return registerAntigravityRuntime(bundle, challengeId);
    throw new AntigravityProvisioningError("usage");
  })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(error instanceof AntigravityProvisioningError ? `${error.message}\n` : "antigravity_provisioning_failed\n"); process.exitCode = 1; })
    .finally(() => closeDbConnections());
}