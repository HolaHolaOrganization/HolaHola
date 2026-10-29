import crypto from 'node:crypto';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  COORDINATION_ACTOR_IDS,
  COORDINATION_CREDENTIAL_CAPABILITIES,
  coordinationCredentialAuditEvents,
  coordinationRuntimeCredentials,
  coordinationRuntimeOnboardingChallenges,
  coordinationRuntimeOnboardingInvitations,
  coordinationRuntimeOnboardingRequests,
  coordinationRuntimeRegistrations,
  type CoordinationActorId,
  type CoordinationCredentialCapability,
  type CoordinationRuntimeOnboardingInvitation,
  type CoordinationRuntimeOnboardingRequest,
  type RuntimeOnboardingClientType,
  type RuntimeOnboardingState,
} from '@shared/schema';
import {
  buildRuntimeOnboardingSignedPayload,
  canonicalRuntimeOnboardingPayload,
  runtimeOnboardingApprovalPath,
  type RuntimeOnboardingInvitationInput,
  type RuntimeOnboardingInvitationView,
  type RuntimeOnboardingRequestView,
} from '@shared/runtime-onboarding';
import { COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR } from '../middleware/coordination-auth';
import { getSharedDb } from '../db';
import {
  auditRuntimeOnboardingEventInExecutor,
  adminRevokeRuntimeCredentialsInExecutor,
  mintCoordinationCredentialForOnboardingInExecutor,
  registerCoordinationRuntimeForOnboardingInExecutor,
} from './coordination-credential-broker';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 4 * 60 * 1000;
const MAX_CHALLENGES_PER_HOUR = 8;
const MAX_ACTIVE_CHALLENGES = 3;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const clientTypes = new Set<RuntimeOnboardingClientType>(['mcp-stdio', 'openai-http', 'http-cli']);
const actorIds = new Set<string>(COORDINATION_ACTOR_IDS);
const capabilityIds = new Set<string>(COORDINATION_CREDENTIAL_CAPABILITIES);

export type RuntimeOnboardingErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_AVAILABLE'
  | 'CONFLICT'
  | 'INVALID_PROOF'
  | 'FORBIDDEN'
  | 'DATABASE_UNAVAILABLE';

export class RuntimeOnboardingError extends Error {
  constructor(readonly code: RuntimeOnboardingErrorCode) {
    super(code);
    this.name = 'RuntimeOnboardingError';
  }
}

function fail(code: RuntimeOnboardingErrorCode): never {
  throw new RuntimeOnboardingError(code);
}

function canonicalRuntimeOnboardingEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    fail('INVALID_INPUT');
  }
  const hostname = endpoint.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1'
    || hostname === '[::1]' || hostname === '::1';
  const httpAllowed = process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV === 'development' && isLoopback);
  if ((endpoint.protocol !== 'https:' && !(httpAllowed && endpoint.protocol === 'http:'))
    || endpoint.username || endpoint.password || endpoint.pathname !== '/'
    || endpoint.search || endpoint.hash) {
    fail('INVALID_INPUT');
  }
  return endpoint.origin;
}

/**
 * Enrollment proofs are tied to a deliberately configured public origin. The
 * request Host header is never authority for a signed onboarding endpoint.
 * Multiple deployments sharing a database must each opt into the explicit
 * origin allowlist and still prove against their own canonical endpoint.
 */
export function trustedRuntimeOnboardingEndpoint(): string {
  const configured = process.env.COORDINATION_PUBLIC_ENDPOINT;
  if (!configured) fail('INVALID_INPUT');
  const canonical = canonicalRuntimeOnboardingEndpoint(configured);
  const allowlist = process.env.COORDINATION_RUNTIME_ONBOARDING_APPROVED_ENDPOINTS;
  if (!allowlist) return canonical;
  const approved = allowlist.split(',').map((entry) => entry.trim()).filter(Boolean)
    .map(canonicalRuntimeOnboardingEndpoint);
  if (!approved.length || !approved.includes(canonical)) fail('INVALID_INPUT');
  return canonical;
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim();
  return result && result.length <= max ? result : undefined;
}

function actorCapabilities(actor: CoordinationActorId): CoordinationCredentialCapability[] {
  const known = COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR[actor]
    ?? (actor.startsWith('luca-') ? COORDINATION_LEGACY_CAPABILITIES_BY_ACTOR['luca-replit'] : []);
  return [...known] as CoordinationCredentialCapability[];
}

function validateCapabilities(
  actor: CoordinationActorId,
  requested?: CoordinationCredentialCapability[],
): CoordinationCredentialCapability[] {
  const actorAllowed = new Set(actorCapabilities(actor));
  const safeDefault = actorCapabilities(actor).filter((value) => value !== 'coordination:runtime:admin');
  const capabilities = requested === undefined ? safeDefault : requested;
  if (!capabilities.length
    || capabilities.some((value) => !capabilityIds.has(value)
      || value === 'coordination:runtime:admin'
      || !actorAllowed.has(value))
    || new Set(capabilities).size !== capabilities.length) {
    fail('INVALID_INPUT');
  }
  return [...capabilities];
}

function validateInvitationInput(input: RuntimeOnboardingInvitationInput): {
  actor: CoordinationActorId;
  runtimeId: string;
  displayName: string;
  capabilities: CoordinationCredentialCapability[];
  provider: string | null;
  model: string | null;
  clientType: RuntimeOnboardingClientType;
} {
  const runtimeId = cleanText(input.runtimeId, 120);
  const displayName = cleanText(input.displayName, 200);
  if (!runtimeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/.test(runtimeId) || !displayName
    || !(actorIds.has(input.actor) && input.actor !== 'coordination-system')
    || (input.clientType && !clientTypes.has(input.clientType))) {
    fail('INVALID_INPUT');
  }
  const actor = input.actor as CoordinationActorId;
  const provider = input.provider === undefined ? null : cleanText(input.provider, 40);
  const model = input.model === undefined ? null : cleanText(input.model, 80);
  if ((input.provider !== undefined && !provider) || (input.model !== undefined && !model)) {
    fail('INVALID_INPUT');
  }
  return {
    actor,
    runtimeId,
    displayName,
    capabilities: validateCapabilities(actor, input.capabilities),
    provider: provider ?? null,
    model: model ?? null,
    clientType: input.clientType ?? 'mcp-stdio',
  };
}

function invitationView(row: CoordinationRuntimeOnboardingInvitation): RuntimeOnboardingInvitationView {
  return {
    id: row.id,
    actor: row.actor as CoordinationActorId,
    runtimeId: row.runtimeId,
    displayName: row.displayName,
    capabilities: row.capabilities as CoordinationCredentialCapability[],
    expiresAt: row.expiresAt.toISOString(),
    state: effectiveState(row.state, row.expiresAt),
    clientType: row.clientType,
  };
}

function effectiveState(state: RuntimeOnboardingState, expiresAt: Date): RuntimeOnboardingState {
  return expiresAt <= new Date() && ['prepared', 'requested', 'approved'].includes(state) ? 'expired' : state;
}

function requestView(
  row: CoordinationRuntimeOnboardingRequest,
): RuntimeOnboardingRequestView {
  return {
    id: row.id,
    actor: row.actor as CoordinationActorId,
    runtimeId: row.runtimeId,
    displayName: row.displayName,
    verificationCode: row.verificationCode,
    fingerprint: row.keyFingerprint,
    approvalPath: runtimeOnboardingApprovalPath(row.id),
    state: effectiveState(row.state, row.expiresAt),
    expiresAt: row.expiresAt.toISOString(),
    capabilities: row.capabilities as CoordinationCredentialCapability[],
    provider: row.provider,
    model: row.model,
  };
}

async function lockOnboardingScope(executor: ReturnType<typeof getSharedDb>, runtimeId: string) {
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${runtimeId}, 0))
  `);
  await executor.execute(sql`
    SELECT id FROM coordination_runtime_registrations WHERE id = ${runtimeId} FOR UPDATE
  `);
}

export async function prepareRuntimeOnboardingInvitation(input: {
  invitation: RuntimeOnboardingInvitationInput;
  preparedBy: CoordinationActorId;
  sourceIp?: string;
}): Promise<RuntimeOnboardingInvitationView> {
  const scope = validateInvitationInput(input.invitation);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const db = getSharedDb();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    await lockOnboardingScope(executor, scope.runtimeId);
    const [existingRuntime] = await tx.select({ id: coordinationRuntimeRegistrations.id })
      .from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, scope.runtimeId));
    const [existingInvitation] = await tx.select({ id: coordinationRuntimeOnboardingInvitations.id })
      .from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.runtimeId, scope.runtimeId));
    if (existingRuntime || existingInvitation) fail('CONFLICT');
    const [row] = await tx.insert(coordinationRuntimeOnboardingInvitations).values({
      ...scope,
      preparedByActor: input.preparedBy,
      state: 'prepared',
      expiresAt,
    }).returning();
    if (!row) fail('DATABASE_UNAVAILABLE');
    await auditRuntimeOnboardingEventInExecutor({
      eventType: 'runtime_onboarding_invite',
      success: true,
      runtimeId: scope.runtimeId,
      actor: scope.actor,
      sourceIp: input.sourceIp,
      metadata: { invitationId: row.id, preparedBy: input.preparedBy },
    }, executor);
    return invitationView(row);
  });
}

export async function submitRuntimeOnboardingRequest(input: {
  invitationId: string;
  publicKeyPem: string;
  sourceIp?: string;
}): Promise<RuntimeOnboardingRequestView & { approvalPath: string }> {
  const invitationId = cleanText(input.invitationId, 120);
  const publicKeyPem = cleanText(input.publicKeyPem, 8192);
  if (!invitationId || !publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) fail('INVALID_INPUT');
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch {
    fail('INVALID_INPUT');
  }
  if (publicKey.asymmetricKeyType !== 'rsa'
    || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    fail('INVALID_INPUT');
  }
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`;
  const now = new Date();
  const db = getSharedDb();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    await executor.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`runtime-onboarding-invitation:${invitationId}`}, 0))
    `);
    const [invitation] = await tx.select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, invitationId))
      .for('update');
    if (!invitation) fail('NOT_AVAILABLE');
    const [existingRequest] = await tx.select().from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.invitationId, invitation.id));
    if (existingRequest) {
      let storedDer: Buffer;
      try {
        storedDer = crypto.createPublicKey(existingRequest.publicKeyPem)
          .export({ type: 'spki', format: 'der' }) as Buffer;
      } catch {
        fail('CONFLICT');
      }
      const sameImmutableScope = existingRequest.invitationId === invitation.id
        && existingRequest.actor === invitation.actor
        && existingRequest.runtimeId === invitation.runtimeId
        && existingRequest.displayName === invitation.displayName
        && sameStringArray(existingRequest.capabilities, invitation.capabilities)
        && existingRequest.provider === invitation.provider
        && existingRequest.model === invitation.model;
      if (!sameImmutableScope || !storedDer.equals(der)
        || existingRequest.keyFingerprint !== fingerprint) {
        fail('CONFLICT');
      }
      await auditRuntimeOnboardingEventInExecutor({
        eventType: 'runtime_onboarding_request',
        success: true,
        runtimeId: invitation.runtimeId,
        actor: invitation.actor,
        sourceIp: input.sourceIp,
        metadata: {
          invitationId: invitation.id,
          requestId: existingRequest.id,
          fingerprint,
          idempotentReplay: true,
        },
      }, executor);
      return requestView(existingRequest);
    }
    if (invitation.state !== 'prepared' || invitation.expiresAt <= now) fail('NOT_AVAILABLE');
    const [registered] = await tx.select({ id: coordinationRuntimeRegistrations.id })
      .from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, invitation.runtimeId));
    if (registered) fail('CONFLICT');
    const verificationCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const [request] = await tx.insert(coordinationRuntimeOnboardingRequests).values({
      invitationId: invitation.id,
      actor: invitation.actor,
      runtimeId: invitation.runtimeId,
      displayName: invitation.displayName,
      capabilities: invitation.capabilities,
      provider: invitation.provider,
      model: invitation.model,
      publicKeyPem,
      keyFingerprint: fingerprint,
      verificationCode,
      state: 'requested',
      expiresAt: new Date(Math.min(invitation.expiresAt.getTime(), now.getTime() + REQUEST_TTL_MS)),
    }).returning();
    await tx.update(coordinationRuntimeOnboardingInvitations).set({
      state: 'requested',
      updatedAt: now,
    }).where(eq(coordinationRuntimeOnboardingInvitations.id, invitation.id));
    if (!request) fail('DATABASE_UNAVAILABLE');
    await auditRuntimeOnboardingEventInExecutor({
      eventType: 'runtime_onboarding_request',
      success: true,
      runtimeId: invitation.runtimeId,
      actor: invitation.actor,
      sourceIp: input.sourceIp,
      metadata: { invitationId: invitation.id, requestId: request.id, fingerprint },
    }, executor);
    return { ...requestView(request), approvalPath: runtimeOnboardingApprovalPath(request.id) };
  });
}

export async function getRuntimeOnboardingRequestStatus(requestId: string): Promise<RuntimeOnboardingRequestView> {
  const id = cleanText(requestId, 120);
  if (!id) fail('INVALID_INPUT');
  const [row] = await getSharedDb().select().from(coordinationRuntimeOnboardingRequests)
    .where(eq(coordinationRuntimeOnboardingRequests.id, id));
  if (!row) fail('NOT_FOUND');
  return requestView(row);
}

/**
 * Records server-authenticated ledger activity only after the response has
 * completed. The enrollment join excludes legacy credentials and credentials
 * belonging to another actor/runtime; the request identity is supplied by the
 * broker-authenticated request, never by the client body.
 */
export async function recordOnboardedRuntimeLedgerRead(input: {
  runtimeId: string;
  actor: CoordinationActorId;
  credentialId: string;
}): Promise<void> {
  const runtimeId = cleanText(input.runtimeId, 120);
  const credentialId = cleanText(input.credentialId, 200);
  if (!runtimeId || !credentialId || !actorIds.has(input.actor)) return;
  await getSharedDb().transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    const [enrollment] = await tx.select({
      requestId: coordinationRuntimeOnboardingRequests.id,
    }).from(coordinationRuntimeOnboardingRequests)
      .innerJoin(
        coordinationRuntimeOnboardingInvitations,
        eq(coordinationRuntimeOnboardingInvitations.id, coordinationRuntimeOnboardingRequests.invitationId),
      )
      .innerJoin(
        coordinationRuntimeRegistrations,
        eq(coordinationRuntimeRegistrations.id, coordinationRuntimeOnboardingRequests.registrationId),
      )
      .innerJoin(
        coordinationRuntimeCredentials,
        and(
          eq(coordinationRuntimeCredentials.id, credentialId),
          eq(coordinationRuntimeCredentials.runtimeId, runtimeId),
          eq(coordinationRuntimeCredentials.actor, input.actor),
        ),
      )
      .where(and(
        eq(coordinationRuntimeOnboardingRequests.runtimeId, runtimeId),
        eq(coordinationRuntimeOnboardingRequests.actor, input.actor),
        eq(coordinationRuntimeOnboardingRequests.state, 'enrolled'),
        eq(coordinationRuntimeOnboardingRequests.registrationId, runtimeId),
        eq(coordinationRuntimeOnboardingInvitations.state, 'enrolled'),
        eq(coordinationRuntimeRegistrations.id, runtimeId),
        eq(coordinationRuntimeRegistrations.actor, input.actor),
        eq(coordinationRuntimeRegistrations.enabled, true),
        isNull(coordinationRuntimeRegistrations.revokedAt),
      ))
      .limit(1);
    if (!enrollment) return;
    await auditRuntimeOnboardingEventInExecutor({
      eventType: 'runtime_onboarding_ledger_read',
      success: true,
      runtimeId,
      actor: input.actor,
      credentialId,
      metadata: { evidence: 'server_ledger_read' },
    }, executor);
  });
}

function challengeNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createRuntimeOnboardingChallenge(input: {
  requestId: string;
  purpose: 'enroll' | 'recover';
  endpoint: string;
}): Promise<{ challengeId: string; nonce: string; payload: string; expiresAt: string }> {
  const requestId = cleanText(input.requestId, 120);
  if (!requestId) fail('INVALID_INPUT');
  const normalizedEndpoint = canonicalRuntimeOnboardingEndpoint(input.endpoint);
  if (normalizedEndpoint !== trustedRuntimeOnboardingEndpoint()) fail('INVALID_INPUT');
  const now = new Date();
  const db = getSharedDb();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    const [requestSnapshot] = await tx.select({
      runtimeId: coordinationRuntimeOnboardingRequests.runtimeId,
    }).from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId));
    if (!requestSnapshot) fail('NOT_FOUND');
    await lockOnboardingScope(executor, requestSnapshot.runtimeId);
    const [request] = await tx.select().from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId))
      .for('update');
    if (!request) fail('NOT_FOUND');
    const [invitation] = await tx.select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, request.invitationId))
      .for('update');
    if (!invitation || invitation.state === 'cancelled' || invitation.state === 'denied'
      || invitation.state === 'expired' || invitation.state === 'revoked') {
      fail('NOT_AVAILABLE');
    }
    if (input.purpose === 'enroll') {
      if (invitation.expiresAt <= now || request.expiresAt <= now) fail('NOT_AVAILABLE');
      if (request.state !== 'approved' || invitation.state !== 'requested') fail('NOT_AVAILABLE');
    } else {
      if (request.state !== 'enrolled' || !request.registrationId || invitation.state !== 'enrolled') {
        fail('NOT_AVAILABLE');
      }
      const [registration] = await tx.select({
        enabled: coordinationRuntimeRegistrations.enabled,
        revokedAt: coordinationRuntimeRegistrations.revokedAt,
      }).from(coordinationRuntimeRegistrations)
        .where(eq(coordinationRuntimeRegistrations.id, request.registrationId));
      if (!registration?.enabled || registration.revokedAt) fail('NOT_AVAILABLE');
    }
    const [counts] = await tx.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${coordinationRuntimeOnboardingChallenges.consumedAt} is null and ${coordinationRuntimeOnboardingChallenges.expiresAt} > ${now})::int`,
    }).from(coordinationRuntimeOnboardingChallenges)
      .where(and(
        eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
        gt(coordinationRuntimeOnboardingChallenges.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ));
    if ((counts?.total ?? 0) >= MAX_CHALLENGES_PER_HOUR
      || (counts?.active ?? 0) >= MAX_ACTIVE_CHALLENGES) {
      fail('NOT_AVAILABLE');
    }
    const challengeId = crypto.randomUUID();
    const nonce = challengeNonce();
    const expiresAt = input.purpose === 'enroll'
      ? new Date(Math.min(
        now.getTime() + CHALLENGE_TTL_MS,
        request.expiresAt.getTime(),
        invitation.expiresAt.getTime(),
      ))
      : new Date(now.getTime() + CHALLENGE_TTL_MS);
    await tx.insert(coordinationRuntimeOnboardingChallenges).values({
      id: challengeId,
      requestId: request.id,
      purpose: input.purpose,
      nonce,
      nonceHash: crypto.createHash('sha256').update(nonce).digest('hex'),
      endpoint: normalizedEndpoint,
      expiresAt,
    });
    await auditRuntimeOnboardingEventInExecutor({
      eventType: 'runtime_onboarding_challenge',
      success: true,
      runtimeId: request.runtimeId,
      actor: request.actor,
      metadata: { requestId: request.id, challengeId, purpose: input.purpose },
    }, executor);
    const signed = buildRuntimeOnboardingSignedPayload({
      endpoint: normalizedEndpoint,
      invitationId: invitation.id,
      requestId: request.id,
      actor: request.actor as CoordinationActorId,
      runtimeId: request.runtimeId,
      fingerprint: request.keyFingerprint,
      purpose: input.purpose,
      nonce,
    });
    return {
      challengeId,
      nonce,
      payload: canonicalRuntimeOnboardingPayload(signed),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

export async function proveRuntimeOnboardingChallenge(input: {
  requestId: string;
  challengeId: string;
  signatureBase64: string;
  endpoint: string;
  sourceIp?: string;
}): Promise<{
  accessToken: string;
  credentialId: string;
  actor: CoordinationActorId;
  runtimeId: string;
  capabilities: CoordinationCredentialCapability[];
  expiresAt: string;
}> {
  const requestId = cleanText(input.requestId, 120);
  const challengeId = cleanText(input.challengeId, 120);
  const signatureBase64 = input.signatureBase64;
  if (!requestId || !challengeId || typeof signatureBase64 !== 'string'
    || signatureBase64.length > 2048 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signatureBase64)) {
    fail('INVALID_INPUT');
  }
  const signature = Buffer.from(signatureBase64, 'base64');
  const proofEndpoint = canonicalRuntimeOnboardingEndpoint(input.endpoint);
  if (proofEndpoint !== trustedRuntimeOnboardingEndpoint()) fail('INVALID_INPUT');
  const now = new Date();
  const db = getSharedDb();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    const [requestSnapshot] = await tx.select({
      runtimeId: coordinationRuntimeOnboardingRequests.runtimeId,
    }).from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId));
    if (!requestSnapshot) fail('NOT_AVAILABLE');
    // Match the broker's runtime lock order before taking request/challenge
    // row locks. This avoids a revoke-vs-recovery deadlock and serializes proof
    // with every other registration/credential lifecycle operation.
    await lockOnboardingScope(executor, requestSnapshot.runtimeId);
    const [challenge] = await tx.select().from(coordinationRuntimeOnboardingChallenges)
      .where(and(
        eq(coordinationRuntimeOnboardingChallenges.id, challengeId),
        eq(coordinationRuntimeOnboardingChallenges.requestId, requestId),
      ))
      .for('update');
    const [request] = await tx.select().from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId))
      .for('update');
    if (!challenge || !request) fail('NOT_AVAILABLE');
    const [invitation] = await tx.select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, request.invitationId))
      .for('update');
    if (!invitation || challenge.consumedAt || challenge.expiresAt <= now
      || invitation.state === 'cancelled' || invitation.state === 'revoked'
      || invitation.state === 'denied' || invitation.state === 'expired') {
      fail('NOT_AVAILABLE');
    }
    if (challenge.purpose === 'enroll') {
      if (request.expiresAt <= now || invitation.expiresAt <= now) fail('NOT_AVAILABLE');
      if (request.state !== 'approved' || invitation.state !== 'requested') fail('NOT_AVAILABLE');
    } else if (request.state !== 'enrolled' || !request.registrationId || invitation.state !== 'enrolled') {
      fail('NOT_AVAILABLE');
    }
    if (challenge.endpoint !== proofEndpoint) fail('NOT_AVAILABLE');
    const computedNonceHash = crypto.createHash('sha256').update(challenge.nonce).digest('hex');
    if (!SHA256_HEX.test(challenge.nonceHash) || computedNonceHash !== challenge.nonceHash) {
      fail('INVALID_PROOF');
    }
    const signed = buildRuntimeOnboardingSignedPayload({
      endpoint: challenge.endpoint,
      invitationId: invitation.id,
      requestId: request.id,
      actor: request.actor as CoordinationActorId,
      runtimeId: request.runtimeId,
      fingerprint: request.keyFingerprint,
      purpose: challenge.purpose,
      nonce: challenge.nonce,
    });
    let verified = false;
    try {
      verified = crypto.verify(
        'RSA-SHA256',
        Buffer.from(canonicalRuntimeOnboardingPayload(signed), 'utf8'),
        crypto.createPublicKey(request.publicKeyPem),
        signature,
      );
    } catch {
      verified = false;
    }
    if (!verified) fail('INVALID_PROOF');

    const [consumed] = await tx.update(coordinationRuntimeOnboardingChallenges)
      .set({ consumedAt: now })
      .where(and(
        eq(coordinationRuntimeOnboardingChallenges.id, challenge.id),
        isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        gt(coordinationRuntimeOnboardingChallenges.expiresAt, now),
      ))
      .returning({ id: coordinationRuntimeOnboardingChallenges.id });
    if (!consumed) fail('NOT_AVAILABLE');

    let registration: typeof coordinationRuntimeRegistrations.$inferSelect | undefined;
    if (challenge.purpose === 'enroll') {
      const [existing] = await tx.select().from(coordinationRuntimeRegistrations)
        .where(eq(coordinationRuntimeRegistrations.id, request.runtimeId))
        .for('update');
      if (existing) fail('CONFLICT');
      registration = await registerCoordinationRuntimeForOnboardingInExecutor({
        runtimeId: request.runtimeId,
        actor: request.actor as CoordinationActorId,
        displayName: request.displayName,
        capabilities: request.capabilities as CoordinationCredentialCapability[],
        provider: request.provider,
        model: request.model,
      }, executor);
      await tx.update(coordinationRuntimeOnboardingRequests).set({
        state: 'enrolled',
        registrationId: registration.id,
        updatedAt: now,
      }).where(eq(coordinationRuntimeOnboardingRequests.id, request.id));
      await tx.update(coordinationRuntimeOnboardingInvitations).set({
        state: 'enrolled',
        completedAt: now,
        completedRequestId: request.id,
        updatedAt: now,
      }).where(eq(coordinationRuntimeOnboardingInvitations.id, invitation.id));
      await tx.update(coordinationRuntimeOnboardingChallenges).set({ consumedAt: now })
        .where(and(
          eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
          isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        ));
    } else {
      if (!request.registrationId) fail('NOT_AVAILABLE');
      const [existing] = await tx.select().from(coordinationRuntimeRegistrations)
        .where(eq(coordinationRuntimeRegistrations.id, request.registrationId))
        .for('update');
      if (!existing || existing.id !== request.runtimeId || existing.actor !== request.actor
        || !existing.enabled || existing.revokedAt
        || !sameStringArray(existing.capabilities, request.capabilities)) {
        fail('NOT_AVAILABLE');
      }
      registration = existing;
      await tx.update(coordinationRuntimeCredentials).set({ revokedAt: now })
        .where(and(
          eq(coordinationRuntimeCredentials.runtimeId, request.runtimeId),
          isNull(coordinationRuntimeCredentials.revokedAt),
        ));
      await tx.update(coordinationRuntimeOnboardingChallenges).set({ consumedAt: now })
        .where(and(
          eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
          isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        ));
    }
    if (!registration) fail('DATABASE_UNAVAILABLE');
    const minted = await mintCoordinationCredentialForOnboardingInExecutor(
      registration,
      executor,
      input.sourceIp,
    );
    await auditRuntimeOnboardingEventInExecutor({
      eventType: challenge.purpose === 'enroll'
        ? 'runtime_onboarding_enrolled'
        : 'runtime_onboarding_recovered',
      success: true,
      runtimeId: request.runtimeId,
      actor: request.actor,
      sourceIp: input.sourceIp,
      metadata: { requestId: request.id, credentialId: minted.credential.credentialId },
    }, executor);
    return {
      accessToken: minted.accessToken,
      credentialId: minted.credential.credentialId,
      actor: minted.credential.actor,
      runtimeId: minted.credential.runtimeId,
      capabilities: minted.credential.capabilities,
      expiresAt: minted.credential.expiresAt.toISOString(),
    };
  });
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function decideRuntimeOnboardingRequest(input: {
  requestId: string;
  decision: 'approve' | 'deny';
  founderActor: string;
}): Promise<{ state: 'approved' | 'denied' }> {
  const requestId = cleanText(input.requestId, 120);
  if (!requestId) fail('INVALID_INPUT');
  const now = new Date();
  return getSharedDb().transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    const [requestSnapshot] = await tx.select({
      runtimeId: coordinationRuntimeOnboardingRequests.runtimeId,
    }).from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId));
    if (!requestSnapshot) fail('NOT_FOUND');
    await lockOnboardingScope(executor, requestSnapshot.runtimeId);
    const [request] = await tx.select().from(coordinationRuntimeOnboardingRequests)
      .where(eq(coordinationRuntimeOnboardingRequests.id, requestId))
      .for('update');
    if (!request) fail('NOT_FOUND');
    const [invitation] = await tx.select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, request.invitationId))
      .for('update');
    if (!invitation || request.state !== 'requested' || invitation.state !== 'requested'
      || request.expiresAt <= now || invitation.expiresAt <= now) fail('NOT_AVAILABLE');
    const state = input.decision === 'approve' ? 'approved' : 'denied';
    await tx.update(coordinationRuntimeOnboardingRequests).set({
      state,
      decisionActor: input.founderActor,
      decisionAt: now,
      updatedAt: now,
    }).where(eq(coordinationRuntimeOnboardingRequests.id, request.id));
    await auditRuntimeOnboardingEventInExecutor({
      eventType: state === 'approved'
        ? 'runtime_onboarding_approved'
        : 'runtime_onboarding_denied',
      success: true,
      runtimeId: request.runtimeId,
      actor: request.actor,
      metadata: {
        requestId: request.id,
        decisionActor: input.founderActor,
        fingerprint: request.keyFingerprint,
      },
    }, executor);
    if (state === 'denied') {
      await tx.update(coordinationRuntimeOnboardingInvitations).set({
        state: 'denied',
        updatedAt: now,
      }).where(eq(coordinationRuntimeOnboardingInvitations.id, invitation.id));
      await tx.update(coordinationRuntimeOnboardingChallenges).set({ consumedAt: now })
        .where(and(
          eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
          isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        ));
    }
    return { state };
  });
}

export async function cancelRuntimeOnboardingInvitation(input: {
  invitationId: string;
  actor: CoordinationActorId;
  requireOwn?: boolean;
}): Promise<boolean> {
  const id = cleanText(input.invitationId, 120);
  if (!id) fail('INVALID_INPUT');
  const now = new Date();
  return getSharedDb().transaction(async (tx) => {
    const [snapshot] = await tx.select({
      runtimeId: coordinationRuntimeOnboardingInvitations.runtimeId,
    }).from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, id));
    if (!snapshot) return false;
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    await lockOnboardingScope(executor, snapshot.runtimeId);
    const [invitation] = await tx.select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.id, id))
      .for('update');
    if (!invitation) return false;
    if (input.requireOwn && invitation.preparedByActor !== input.actor) fail('FORBIDDEN');
    if (!['prepared', 'requested', 'approved'].includes(invitation.state)) fail('NOT_AVAILABLE');
    await tx.update(coordinationRuntimeOnboardingInvitations).set({
      state: 'cancelled',
      cancelledAt: now,
      updatedAt: now,
    }).where(eq(coordinationRuntimeOnboardingInvitations.id, invitation.id));
    const requests = await tx.update(coordinationRuntimeOnboardingRequests).set({
      state: 'cancelled',
      updatedAt: now,
    }).where(and(
      eq(coordinationRuntimeOnboardingRequests.invitationId, invitation.id),
      inArray(coordinationRuntimeOnboardingRequests.state, ['requested', 'approved']),
    )).returning({ id: coordinationRuntimeOnboardingRequests.id });
    for (const request of requests) {
      await tx.update(coordinationRuntimeOnboardingChallenges).set({ consumedAt: now })
        .where(and(
          eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
          isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        ));
    }
    await auditRuntimeOnboardingEventInExecutor({
      eventType: 'runtime_onboarding_cancel',
      success: true,
      runtimeId: invitation.runtimeId,
      actor: invitation.actor,
      metadata: { invitationId: invitation.id, cancelledBy: input.actor },
    }, executor);
    return true;
  });
}

export async function revokeOnboardedRuntime(input: {
  runtimeId: string;
  revokedByActor: CoordinationActorId;
  sourceIp?: string;
}): Promise<boolean> {
  const runtimeId = cleanText(input.runtimeId, 120);
  if (!runtimeId) fail('INVALID_INPUT');
  const now = new Date();
  return getSharedDb().transaction(async (tx) => {
    const executor = tx as unknown as ReturnType<typeof getSharedDb>;
    await lockOnboardingScope(executor, runtimeId);
    const revoked = await adminRevokeRuntimeCredentialsInExecutor(
      runtimeId,
      input.revokedByActor,
      executor,
      input.sourceIp,
    );
    if (!revoked) return false;
    const requests = await tx.update(coordinationRuntimeOnboardingRequests).set({
      state: 'revoked',
      updatedAt: now,
    }).where(and(
      eq(coordinationRuntimeOnboardingRequests.runtimeId, runtimeId),
      eq(coordinationRuntimeOnboardingRequests.state, 'enrolled'),
    )).returning({ id: coordinationRuntimeOnboardingRequests.id, invitationId: coordinationRuntimeOnboardingRequests.invitationId });
    for (const request of requests) {
      await tx.update(coordinationRuntimeOnboardingInvitations).set({
        state: 'revoked',
        updatedAt: now,
      }).where(eq(coordinationRuntimeOnboardingInvitations.id, request.invitationId));
      await tx.update(coordinationRuntimeOnboardingChallenges).set({ consumedAt: now })
        .where(and(
          eq(coordinationRuntimeOnboardingChallenges.requestId, request.id),
          isNull(coordinationRuntimeOnboardingChallenges.consumedAt),
        ));
    }
    return true;
  });
}

export async function listAldenRuntimeOnboarding(): Promise<{
  invitations: RuntimeOnboardingInvitationView[];
  requests: RuntimeOnboardingRequestView[];
}> {
  const [invitations, requests] = await Promise.all([
    getSharedDb().select().from(coordinationRuntimeOnboardingInvitations)
      .where(eq(coordinationRuntimeOnboardingInvitations.preparedByActor, 'alden'))
      .orderBy(sql`${coordinationRuntimeOnboardingInvitations.createdAt} desc`)
      .limit(100),
    getSharedDb().select().from(coordinationRuntimeOnboardingRequests)
      .innerJoin(coordinationRuntimeOnboardingInvitations,
        eq(coordinationRuntimeOnboardingInvitations.id, coordinationRuntimeOnboardingRequests.invitationId))
      .where(eq(coordinationRuntimeOnboardingInvitations.preparedByActor, 'alden'))
      .orderBy(sql`${coordinationRuntimeOnboardingRequests.createdAt} desc`)
      .limit(100),
  ]);
  return {
    invitations: invitations.map(invitationView),
    requests: requests.map(({ coordination_runtime_onboarding_requests: row }) => requestView(row)),
  };
}

export async function getAldenRuntimeOnboardingStatus(invitationId: string): Promise<{
  invitation: RuntimeOnboardingInvitationView;
  request?: RuntimeOnboardingRequestView;
}> {
  const id = cleanText(invitationId, 120);
  if (!id) fail('INVALID_INPUT');
  const [rows] = await getSharedDb().select()
    .from(coordinationRuntimeOnboardingInvitations)
    .leftJoin(
      coordinationRuntimeOnboardingRequests,
      eq(coordinationRuntimeOnboardingRequests.invitationId, coordinationRuntimeOnboardingInvitations.id),
    )
    .where(and(
      eq(coordinationRuntimeOnboardingInvitations.id, id),
      eq(coordinationRuntimeOnboardingInvitations.preparedByActor, 'alden'),
    ));
  if (!rows) fail('NOT_FOUND');
  return {
    invitation: invitationView(rows.coordination_runtime_onboarding_invitations),
    ...(rows.coordination_runtime_onboarding_requests
      ? { request: requestView(rows.coordination_runtime_onboarding_requests) }
      : {}),
  };
}

export async function getRuntimeOnboardingAdminView(): Promise<{
  actors: { id: CoordinationActorId; capabilities: CoordinationCredentialCapability[] }[];
  invitations: Record<string, unknown>[];
  requests: RuntimeOnboardingRequestView[];
  runtimes: Record<string, unknown>[];
}> {
  const [invitations, requests, runtimes, ledgerReadEvidence] = await Promise.all([
    getSharedDb().select().from(coordinationRuntimeOnboardingInvitations)
      .orderBy(sql`${coordinationRuntimeOnboardingInvitations.createdAt} desc`).limit(200),
    getSharedDb().select().from(coordinationRuntimeOnboardingRequests)
      .orderBy(sql`${coordinationRuntimeOnboardingRequests.createdAt} desc`).limit(200),
    getSharedDb().select({
      runtimeId: coordinationRuntimeRegistrations.id,
      actor: coordinationRuntimeRegistrations.actor,
      displayName: coordinationRuntimeRegistrations.displayName,
      capabilities: coordinationRuntimeRegistrations.capabilities,
      provider: coordinationRuntimeRegistrations.provider,
      model: coordinationRuntimeRegistrations.model,
      enabled: coordinationRuntimeRegistrations.enabled,
      revokedAt: coordinationRuntimeRegistrations.revokedAt,
      credentialExpiresAt: sql<Date | null>`(
        select max(c.expires_at) from ${coordinationRuntimeCredentials} c
        where c.runtime_id = ${coordinationRuntimeRegistrations.id}
          and c.central_grant_id is null
          and c.actor = ${coordinationRuntimeRegistrations.actor}
          and c.revoked_at is null
      )`.mapWith(coordinationRuntimeCredentials.expiresAt),
    }).from(coordinationRuntimeRegistrations).limit(500),
    getSharedDb().select({
      runtimeId: coordinationCredentialAuditEvents.runtimeId,
      actor: coordinationCredentialAuditEvents.actor,
      authenticatedLedgerAt: sql<Date | null>`max(${coordinationCredentialAuditEvents.createdAt})`
        .mapWith(coordinationCredentialAuditEvents.createdAt),
    }).from(coordinationCredentialAuditEvents)
      .where(and(
        eq(coordinationCredentialAuditEvents.eventType, 'runtime_onboarding_ledger_read'),
        eq(coordinationCredentialAuditEvents.success, true),
      ))
      .groupBy(
        coordinationCredentialAuditEvents.runtimeId,
        coordinationCredentialAuditEvents.actor,
      ),
  ]);
  const ledgerReadEvidenceByRuntime = new Map<string, Date>();
  for (const evidence of ledgerReadEvidence) {
    if (evidence.runtimeId && evidence.actor && evidence.authenticatedLedgerAt) {
      ledgerReadEvidenceByRuntime.set(
        `${evidence.runtimeId}\0${evidence.actor}`,
        evidence.authenticatedLedgerAt,
      );
    }
  }
  const actors = COORDINATION_ACTOR_IDS.filter((id) => id !== 'coordination-system')
    .map((id) => ({
      id,
      capabilities: actorCapabilities(id).filter((capability) => capability !== 'coordination:runtime:admin'),
    }));
  return {
    actors,
    invitations: invitations.map((row) => ({
      ...invitationView(row),
      preparedBy: row.preparedByActor,
    })),
    requests: requests.map(requestView),
    runtimes: runtimes.map((row) => ({
      runtimeId: row.runtimeId,
      actor: row.actor,
      displayName: row.displayName,
      capabilities: row.capabilities,
      provider: row.provider,
      model: row.model,
      enabled: row.enabled,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
      connectionEvidence: (() => {
        const authenticatedLedgerAt = ledgerReadEvidenceByRuntime.get(`${row.runtimeId}\0${row.actor}`);
        return {
          authenticatedLedgerAt: authenticatedLedgerAt?.toISOString() ?? null,
          evidence: authenticatedLedgerAt ? 'server_ledger_read' as const : null,
        };
      })(),
    })),
  };
}

export function runtimeOnboardingApprovalLink(requestId: string): string {
  return runtimeOnboardingApprovalPath(requestId);
}