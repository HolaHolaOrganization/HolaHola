import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  coordinationCredentialAuditEvents,
  coordinationGate3ProofGrants,
  coordinationRuntimeCredentials,
  coordinationRuntimeInboxWindows,
  coordinationRuntimePackets,
  coordinationRuntimeRegistrations,
  coordinationRuntimeProfiles,
  coordinationThreads,
  taskOwnershipChallenges,
  taskOwnershipReceipts,
} from '@shared/schema';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import {
  consumedCoordinationBootstrapHash,
  designateStandingCoordinationVerifier,
  exchangeBootstrapCredential,
  registerCoordinationRuntime,
  registerCoordinationRuntimeWithBootstrapSha256,
  hashCoordinationSecret,
  renewBrokerCredential,
  resolveBrokerCredential,
  revokeBrokerCredential,
  revokeRuntimeCredentials,
  adminRevokeRuntimeCredentials,
  listCoordinationRuntimeRegistrations,
  stageCoordinationRuntimeReplacement,
} from '../services/coordination-credential-broker';
import {
  createPublicProvisioningBundle,
  type PublicProvisioningBundle,
} from '../services/antigravity-provisioning-bundle';
import {
  submitAntigravityChallenge,
  registerAntigravityRuntime,
} from './provision-antigravity-runtime';
import { createChallenge, decideChallenge, revokeReceipt, issueProofNonce, verifyProof } from '../services/founder-task-ownership-service';
import { canonicalJson } from '../services/task-ownership-service';
import { buildGate3ProofResponse } from '../routes/founder-task-ownership-routes';
import { parseOwnershipProof } from './coordination-runtime-antigravity';
import {
  issueGate3ProofGrant,
  computeGate3GrantExpiry,
  validateGate3ProofGrant,
  validateGate3ProofGrantForVerifier,
  withGate3ProofGrantAuthority,
} from '../services/coordination-gate3-proof-grant-service';

const hasDisposableDatabase = Boolean(
  getVerifiedCiDatabaseUrl() || process.env.COORDINATION_INBOX_DISPOSABLE_BRANCH_ID,
);
const databaseTest = hasDisposableDatabase ? test : test.skip;
const runtimeId = `credential-broker-${Date.now()}`;
const revocationRaceRuntimeId = `${runtimeId}-revocation-race`;
const prehashedRuntimeId = `${runtimeId}-prehashed`;
const standingVerifierRuntimeId = `${runtimeId}-standing-verifier`;
const standingVerifierWrongActorRuntimeId = `${runtimeId}-standing-verifier-wrong-actor`;
const graceReexchangeNeverUsedRuntimeId = `${runtimeId}-grace-never-used`;
const graceReexchangeUsedRuntimeId = `${runtimeId}-grace-used`;
const graceRaceRuntimeId = `${runtimeId}-grace-race`;
let operatorRuntimeId = '';
const operatorTaskRef = `operator-${Date.now()}`;

function expiredOwnershipFixtureTimes(now: Date) {
  const expiresAt = new Date(now.getTime() - 1);
  const issuedAt = new Date(expiresAt.getTime() - 1);
  return { issuedAt, expiresAt };
}

test('expired ownership fixture stays strictly ordered even in the issuance millisecond', () => {
  const issuanceAndNow = new Date('2026-01-01T00:00:00.000Z');
  const { issuedAt, expiresAt } = expiredOwnershipFixtureTimes(issuanceAndNow);
  assert.ok(issuedAt < expiresAt);
  assert.ok(expiresAt < issuanceAndNow);
  assert.equal(expiresAt.getTime() - issuedAt.getTime(), 1);
});

function runProvisioningCli(args: string[], bundle: PublicProvisioningBundle) {
  return spawnSync(
    'npx',
    ['tsx', 'server/scripts/provision-antigravity-runtime.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      input: JSON.stringify(bundle),
      timeout: 30_000,
    },
  );
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

after(async () => {
  if (!hasDisposableDatabase) return;
  await closeDbConnections();
});

databaseTest('trusted prehashed registration is strict, retry-safe, and never returns or audits secrets', async () => {
  const bootstrap = `cb_${crypto.randomBytes(32).toString('base64url')}`;
  const digest = hashCoordinationSecret(bootstrap);
  const input: Parameters<typeof registerCoordinationRuntimeWithBootstrapSha256>[0] = {
    runtimeId: prehashedRuntimeId,
    actor: 'luca-replit',
    displayName: 'Prehashed broker CI runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
    bootstrapSha256: digest,
  };

  const created = await registerCoordinationRuntimeWithBootstrapSha256(input);
  assert.equal(created.status, 'created');
  assert.equal(JSON.stringify(created).includes(digest), false);
  assert.equal(JSON.stringify(created).includes(bootstrap), false);

  const captureError = async (operation: () => Promise<unknown>): Promise<unknown> => {
    let caught: unknown;
    try {
      await operation();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'expected operation to reject');
    return caught;
  };
  const wrongDigest = await exchangeBootstrapCredential(prehashedRuntimeId, digest);
  assert.equal(wrongDigest.ok, false);
  if (!wrongDigest.ok) assert.equal(wrongDigest.reason, 'invalid_bootstrap');

  const replayed = await registerCoordinationRuntimeWithBootstrapSha256(input);
  assert.equal(replayed.status, 'replayed');
  assert.deepEqual(replayed, { ...created, status: 'replayed' });
  assert.equal((await exchangeBootstrapCredential(prehashedRuntimeId, bootstrap)).ok, true);

  for (const invalidDigest of [
    digest.toUpperCase(),
    digest.slice(0, 63),
    `${digest}0`,
    `${digest.slice(0, 63)}g`,
  ]) {
    const error = await captureError(
      () => registerCoordinationRuntimeWithBootstrapSha256({ ...input, bootstrapSha256: invalidDigest }),
    );
    assert.match(String(error), /lowercase hexadecimal SHA-256/);
    assert.equal(String(error).includes(bootstrap), false);
    assert.equal(String(error).includes(digest), false);
  }

  const conflictError = await captureError(() => registerCoordinationRuntimeWithBootstrapSha256({
      ...input,
      actor: 'luca-claude-code',
    }));
  assert.match(String(conflictError), /conflicts with an existing record/);
  assert.equal(String(conflictError).includes(bootstrap), false);
  assert.equal(String(conflictError).includes(digest), false);
  const events = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, prehashedRuntimeId));
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(bootstrap), false);
  assert.equal(events.some((event) =>
    event.eventType === 'runtime_bootstrap_consumed'
    && (event.metadata as Record<string, unknown>).approvedBootstrapSha256 === digest
  ), true);
  assert.equal(events.some((event) => event.eventType === 'runtime_registration_replayed'), true);
  assert.equal(events.some((event) => event.eventType === 'runtime_registration_rejected'), true);
});

databaseTest('operator provisioning is two-phase, receipt-bound, atomic, and concurrent-retry safe', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = der.toString('base64url');
  const keyFingerprint = crypto.createHash('sha256').update(der).digest('hex');
  const secret = `operator-secret-${crypto.randomBytes(24).toString('hex')}`;
  const bundle = createPublicProvisioningBundle({
    runtimeId: operatorRuntimeId,
    actor: 'luca-gemini',
    credentialCapabilities: ['coordination:read', 'coordination:write', 'coordination:inbox:ack', 'coordination:credential:renew'],
    runtimeCapabilities: ['execute', 'model'],
    tokenTtlSeconds: 900,
    taskRef: '1448',
    artifactSha256: crypto.createHash('sha256').update(`${operatorTaskRef}-artifact`).digest('hex'),
    publicKey,
    keyFingerprint,
    bootstrapSha256: hashCoordinationSecret(secret),
    worktreeRealpathDigest: '1'.repeat(64),
    branch: 'luca/gemini-experiment',
    startingCommit: '2'.repeat(40),
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    adapterVersion: 'coordination-gemini-v1',
    repositoryLabel: 'HolaHola',
    worktreeLabel: 'HolaHola-antigravity',
  });
  operatorRuntimeId = bundle.runtimeId;
  const assertNoAuthority = async () => {
    assert.equal((await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId))).length, 0);
    assert.equal((await getSharedDb().select().from(coordinationRuntimeProfiles)
      .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId))).length, 0);
  };

  const [challengeCountBeforeInvalid] = await getSharedDb().select({
    count: sql<number>`count(*)::int`,
  }).from(taskOwnershipChallenges);
  await assert.rejects(
    () => submitAntigravityChallenge(bundle, undefined),
    /attempt_id_required/,
  );
  await assert.rejects(
    () => submitAntigravityChallenge(bundle, crypto.randomUUID().toUpperCase()),
    /attempt_id_invalid/,
  );
  await assert.rejects(
    () => submitAntigravityChallenge(bundle, 'a'.repeat(201)),
    /attempt_id_invalid/,
  );
  const [challengeCountAfterInvalid] = await getSharedDb().select({
    count: sql<number>`count(*)::int`,
  }).from(taskOwnershipChallenges);
  assert.equal(challengeCountAfterInvalid.count, challengeCountBeforeInvalid.count);

  const cliMissing = runProvisioningCli(['phase-a'], bundle);
  assert.equal(cliMissing.status, 1);
  assert.match(cliMissing.stderr, /antigravity_provisioning_attempt_id_required/);
  const cliMalformed = runProvisioningCli(['phase-a', '--attempt-id', 'NOT-A-UUID'], bundle);
  assert.equal(cliMalformed.status, 1);
  assert.match(cliMalformed.stderr, /antigravity_provisioning_attempt_id_invalid/);
  const cliOversized = runProvisioningCli(['phase-a', '--attempt-id', 'a'.repeat(201)], bundle);
  assert.equal(cliOversized.status, 1);
  assert.match(cliOversized.stderr, /antigravity_provisioning_attempt_id_invalid/);
  const cliAttemptId = crypto.randomUUID();
  const cliValid = runProvisioningCli(['phase-a', '--attempt-id', cliAttemptId], bundle);
  assert.equal(cliValid.status, 0, cliValid.stderr);
  const cliJsonLine = cliValid.stdout.split('\n').find((line) => line.startsWith('{'));
  assert.ok(cliJsonLine);
  const cliResult = JSON.parse(cliJsonLine);
  assert.equal(cliResult.attemptId, cliAttemptId);
  const cliPhaseB = runProvisioningCli(
    ['phase-b', '--challenge-id', cliResult.challengeId],
    bundle,
  );
  assert.equal(cliPhaseB.status, 1);
  assert.match(cliPhaseB.stderr, /antigravity_provisioning_challenge_not_approved/);
  assert.doesNotMatch(cliPhaseB.stderr, /attempt_id/);

  const phaseAAttemptId = crypto.randomUUID();
  const phaseA = await submitAntigravityChallenge(bundle, phaseAAttemptId);
  assert.equal(phaseA.bundleDigest, bundle.bundleDigest);
  assert.equal(phaseA.attemptId, phaseAAttemptId);
  const phaseARetry = await submitAntigravityChallenge(bundle, phaseAAttemptId);
  assert.equal(phaseARetry.challengeId, phaseA.challengeId);
  await getSharedDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.update(taskOwnershipChallenges)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(taskOwnershipChallenges.id, phaseA.challengeId));
  });
  await assert.rejects(
    () => decideChallenge(phaseA.challengeId, 'approved', 'expired-attempt-test'),
    /CHALLENGE_EXPIRED/,
  );
  const [expiredPhaseARow] = await getSharedDb().select().from(taskOwnershipChallenges)
    .where(eq(taskOwnershipChallenges.id, phaseA.challengeId));
  assert.equal(expiredPhaseARow.status, 'expired');
  const freshAttemptId = crypto.randomUUID();
  const freshPhaseA = await submitAntigravityChallenge(bundle, freshAttemptId);
  assert.notEqual(freshPhaseA.challengeId, phaseA.challengeId);
  const [freshPhaseARow] = await getSharedDb().select().from(taskOwnershipChallenges)
    .where(eq(taskOwnershipChallenges.id, freshPhaseA.challengeId));
  assert.equal(freshPhaseARow.status, 'pending');
  assert.equal(freshPhaseARow.taskRef, bundle.taskRef);
  assert.equal(freshPhaseARow.artifactSha256, bundle.artifactSha256);
  assert.equal(freshPhaseARow.intendedActor, bundle.actor);
  assert.equal(freshPhaseARow.coordinationActor, bundle.actor);
  assert.equal(freshPhaseARow.publicKey, bundle.publicKey);
  assert.equal(freshPhaseARow.keyFingerprint, bundle.keyFingerprint);
  assert.equal(freshPhaseARow.contextDigest, bundle.bundleDigest);
  assert.equal(
    freshPhaseARow.idempotencyKey,
    `antigravity:${bundle.bundleDigest}:${freshAttemptId}`,
  );
  const [expiredPhaseARowAfterFresh] = await getSharedDb().select().from(taskOwnershipChallenges)
    .where(eq(taskOwnershipChallenges.id, phaseA.challengeId));
  assert.deepEqual(expiredPhaseARowAfterFresh, expiredPhaseARow);
  await assert.rejects(() => registerAntigravityRuntime(bundle, freshPhaseA.challengeId), /challenge_not_approved/);
  await assertNoAuthority();

  const receipt = await decideChallenge(freshPhaseA.challengeId, 'approved', 'founder-operator-test');
  assert.ok('id' in receipt);
  await getSharedDb().execute(sql`
    CREATE FUNCTION reject_antigravity_profile_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced antigravity profile insert failure';
    END
    $$
  `);
  await getSharedDb().execute(sql`
    CREATE TRIGGER reject_antigravity_profile_insert
    BEFORE INSERT ON coordination_runtime_profiles
    FOR EACH ROW EXECUTE FUNCTION reject_antigravity_profile_insert()
  `);
  try {
    await assert.rejects(
      () => registerAntigravityRuntime(bundle, freshPhaseA.challengeId),
      /Failed query: insert into "coordination_runtime_profiles"/,
    );
    await assertNoAuthority();
  } finally {
    await getSharedDb().execute(sql`
      DROP TRIGGER IF EXISTS reject_antigravity_profile_insert
      ON coordination_runtime_profiles
    `);
    await getSharedDb().execute(sql`
      DROP FUNCTION IF EXISTS reject_antigravity_profile_insert()
    `);
  }
  const registered = await registerAntigravityRuntime(bundle, freshPhaseA.challengeId);
  assert.equal(registered.status, 'created');
  assert.equal((await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId))).length, 1);
  assert.equal((await getSharedDb().select().from(coordinationRuntimeProfiles)
    .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId))).length, 1);
  const replay = await registerAntigravityRuntime(bundle, freshPhaseA.challengeId);
  assert.equal(replay.status, 'replayed');
  const exchanged = await exchangeBootstrapCredential(operatorRuntimeId, secret);
  assert.equal(exchanged.ok, true);
  if (!exchanged.ok) return;
  const brokerCredential = await resolveBrokerCredential(exchanged.accessToken);
  assert.ok(brokerCredential);
  const renewedGrantCredential = await renewBrokerCredential(brokerCredential);
  assert.ok(renewedGrantCredential);
  const nonce = await issueProofNonce(registered.receiptId, 'luca-gemini');
  const payload = canonicalJson(nonce.signedPayload);
  const signature = crypto.sign(null, Buffer.from(payload), keys.privateKey).toString('base64url');
  const proof = await verifyProof(nonce.nonceId, signature, 'luca-gemini');
  assert.equal(proof.verified, true);
  const grant = await issueGate3ProofGrant(proof as any, renewedGrantCredential!.credential);
  assert.equal(grant.taskRef, '1448');
  assert.equal(grant.runtimeRegistrationId, operatorRuntimeId);
  assert.equal(JSON.stringify(grant).includes(secret), false);
  const syntheticIssuedAt = new Date('2026-09-11T12:00:00.000Z');
  const syntheticLateChallengeExpiry = new Date(syntheticIssuedAt.getTime() + 40_000);
  assert.equal(
    computeGate3GrantExpiry(
      syntheticIssuedAt,
      syntheticLateChallengeExpiry,
      new Date(syntheticIssuedAt.getTime() + 20 * 60_000),
      new Date(syntheticIssuedAt.getTime() + 30 * 60_000),
    ).getTime(),
    syntheticLateChallengeExpiry.getTime(),
    'late issuance must advertise no authority beyond the challenge expiry',
  );
  const routeResponse = buildGate3ProofResponse(proof as any, grant);
  assert.deepEqual(Object.keys(routeResponse).sort(), [
    'artifactSha256', 'contextDigest', 'grant', 'intendedActor', 'ok',
    'proofPayloadDigest', 'receiptId', 'taskRef', 'verified',
  ]);
  assert.equal(proof.purpose, "runtime_provisioning");
  assert.equal("purpose" in routeResponse, false, "keep the pinned Gate 3 wire contract unchanged");
  assert.deepEqual(Object.keys(routeResponse.grant).sort(), [
    'artifactSha256', 'contextDigest', 'expiresAt', 'id', 'startingCommit', 'taskRef',
  ]);
  const parsedRouteResponse = parseOwnershipProof(
    routeResponse, registered.receiptId, bundle.artifactSha256,
  );
  assert.equal(parsedRouteResponse.grant.id, grant.id);
  const [replayedGrant, concurrentGrant] = await Promise.all([
    issueGate3ProofGrant(proof as any, renewedGrantCredential!.credential),
    issueGate3ProofGrant(proof as any, renewedGrantCredential!.credential),
  ]);
  assert.equal(replayedGrant.id, grant.id);
  assert.equal(concurrentGrant.id, grant.id);
  assert.equal((await validateGate3ProofGrant(grant.id, renewedGrantCredential!.credential)).grantId, grant.id);
  assert.equal((await validateGate3ProofGrantForVerifier(grant.id)).grantId, grant.id);
  assert.equal(await renewBrokerCredential(renewedGrantCredential!.credential), null);
  const successorGrant = grant;
  await assert.rejects(() => validateGate3ProofGrant(grant.id, brokerCredential), /GATE3_PROOF_GRANT_INVALID/);
  const concurrent = await Promise.all([
    registerAntigravityRuntime(bundle, freshPhaseA.challengeId),
    registerAntigravityRuntime(bundle, freshPhaseA.challengeId),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ['replayed', 'replayed']);
  await getSharedDb().update(coordinationRuntimeProfiles)
    .set({ model: 'conflicting-model' })
    .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId));
  await assert.rejects(() => registerAntigravityRuntime(bundle, freshPhaseA.challengeId), /profile_conflict/);
  assert.equal((await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId))).length, 1);
  await getSharedDb().update(coordinationRuntimeProfiles)
    .set({ model: bundle.model })
    .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId));

  await assert.rejects(
    () => registerAntigravityRuntime({ ...bundle, bootstrapSha256: '3'.repeat(64) }, freshPhaseA.challengeId),
    /invalid_bundle/,
  );
  await assert.rejects(
    () => registerAntigravityRuntime({ ...bundle, keyFingerprint: '4'.repeat(64) }, freshPhaseA.challengeId),
    /invalid_bundle|receipt_mismatch/,
  );
  assert.equal(JSON.stringify(registered).includes(secret), false);
  const rollbackProbe = new Error('ROLLBACK_AUTHORITY_LOCK_PROBE');
  const authorityUpdateCases = [
    {
      name: 'grant',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(coordinationGate3ProofGrants).set({ revokedAt: null })
          .where(eq(coordinationGate3ProofGrants.id, successorGrant.id));
        throw rollbackProbe;
      }),
    },
    {
      name: 'receipt',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(taskOwnershipReceipts).set({ revokedAt: null })
          .where(eq(taskOwnershipReceipts.id, registered.receiptId));
        throw rollbackProbe;
      }),
    },
    {
      name: 'challenge',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(taskOwnershipChallenges).set({ status: 'approved' })
          .where(eq(taskOwnershipChallenges.id, freshPhaseA.challengeId));
        throw rollbackProbe;
      }),
    },
    {
      name: 'credential',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(coordinationRuntimeCredentials).set({ revokedAt: null })
          .where(eq(coordinationRuntimeCredentials.id, renewedGrantCredential!.credential.credentialId));
        throw rollbackProbe;
      }),
    },
    {
      name: 'registration',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(coordinationRuntimeRegistrations).set({ enabled: true })
          .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId));
        throw rollbackProbe;
      }),
    },
    {
      name: 'profile',
      run: () => getSharedDb().transaction(async (tx) => {
        await tx.update(coordinationRuntimeProfiles).set({ status: 'active' })
          .where(eq(coordinationRuntimeProfiles.id, registered.profileId));
        throw rollbackProbe;
      }),
    },
  ];
  for (const authorityCase of authorityUpdateCases) {
    const authorityEntered = deferred();
    const releaseAuthority = deferred();
    const leasedOperation = withGate3ProofGrantAuthority(
      successorGrant.id,
      renewedGrantCredential!.credential,
      async () => {
        authorityEntered.resolve();
        await releaseAuthority.promise;
        return 'completed-under-authority';
      },
    );
    await authorityEntered.promise;
    let updateSettled = false;
    const updateAttempt = authorityCase.run().then(
      () => assert.fail(`${authorityCase.name} lock probe unexpectedly committed`),
      (error) => {
        if (error !== rollbackProbe) {
          const message = String(
            (error as { cause?: { message?: string } })?.cause?.message
            ?? (error as Error)?.message
            ?? error,
          );
          if (authorityCase.name === 'receipt') {
            assert.match(message, /invalid task ownership receipt transition/);
          } else if (authorityCase.name === 'challenge') {
            assert.match(message, /invalid task ownership challenge transition/);
          } else {
            throw error;
          }
        }
        updateSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(updateSettled, false, `${authorityCase.name} update must wait for the authority lease`);
    releaseAuthority.resolve();
    assert.equal(await leasedOperation, 'completed-under-authority');
    await updateAttempt;
    assert.equal(updateSettled, true);
    assert.equal(
      (await validateGate3ProofGrant(successorGrant.id, renewedGrantCredential!.credential)).grantId,
      successorGrant.id,
    );
  }

  const [probeThread] = await getSharedDb().select().from(coordinationThreads).limit(1);
  assert.ok(probeThread);
  const probeWindowId = `gate3-fk-window-${Date.now()}`;
  const probeWindowDigest = crypto.createHash('sha256').update(probeWindowId).digest('hex');
  const [probeWindow] = await getSharedDb().insert(coordinationRuntimeInboxWindows).values({
    id: probeWindowId,
    threadId: probeThread.id,
    afterExclusive: 0,
    throughInclusive: 1,
    boundaryToken: 'gate3-fk-probe',
    orderedItemIds: [`${probeWindowId}-item`],
    boundaryDigest: probeWindowDigest,
    canonicalPayload: { kind: 'gate3-fk-probe' },
  }).returning();
  await withGate3ProofGrantAuthority(
    successorGrant.id,
    renewedGrantCredential!.credential,
    async () => {
      const packetProbe = getSharedDb().transaction(async (tx) => {
        const probeId = `gate3-fk-probe-${Date.now()}`;
        await tx.insert(coordinationRuntimePackets).values({
          id: probeId,
          profileId: registered.profileId,
          runtimeRegistrationId: operatorRuntimeId,
          version: 1,
          assignmentEventId: probeId,
          assignmentTaskId: '1448',
          assignmentThreadId: probeWindow.threadId,
          assignmentAuthor: 'luca-replit',
          expectedSequence: 1,
          supersedesClaimId: null,
          windowId: probeWindow.id,
          windowDigest: probeWindow.boundaryDigest,
          orderedInboxItemIds: [probeId],
          orderedEventIds: [probeId],
          orderedThreadIds: [probeWindow.threadId],
          inheritedPayload: [],
          envelope: {},
          canonicalPayload: {},
          digest: crypto.createHash('sha256').update(probeId).digest('hex'),
          createdAt: new Date(),
        });
        throw rollbackProbe;
      });
      await assert.rejects(
        Promise.race([
          packetProbe,
          new Promise((_, reject) => setTimeout(() => reject(new Error('FK_PACKET_INSERT_DEADLOCK')), 2_000)),
        ]),
        (error: unknown) => error === rollbackProbe,
      );
    },
  );

  const phaseBLeaseEntered = deferred();
  const releasePhaseBLease = deferred();
  const phaseBLeasedOperation = withGate3ProofGrantAuthority(
    successorGrant.id,
    renewedGrantCredential!.credential,
    async () => {
      phaseBLeaseEntered.resolve();
      await releasePhaseBLease.promise;
      return 'phase-b-overlap-complete';
    },
  );
  await phaseBLeaseEntered.promise;
  let phaseBReplaySettled = false;
  const phaseBReplay = registerAntigravityRuntime(bundle, freshPhaseA.challengeId).then((value) => {
    phaseBReplaySettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    phaseBReplaySettled,
    false,
    'Phase B replay must wait for the authority lease without deadlocking',
  );
  releasePhaseBLease.resolve();
  assert.equal(await phaseBLeasedOperation, 'phase-b-overlap-complete');
  assert.equal((await phaseBReplay).status, 'replayed');
  assert.equal(phaseBReplaySettled, true);

  const runtimeAuthorityEntered = deferred();
  const releaseRuntimeAuthority = deferred();
  const runtimeLeasedOperation = withGate3ProofGrantAuthority(
    successorGrant.id,
    renewedGrantCredential!.credential,
    async () => {
      runtimeAuthorityEntered.resolve();
      await releaseRuntimeAuthority.promise;
      return 'runtime-revocation-overlap-complete';
    },
  );
  await runtimeAuthorityEntered.promise;
  let runtimeRevocationSettled = false;
  const runtimeRevocation = revokeRuntimeCredentials(
    operatorRuntimeId,
    'luca-gemini',
  ).then((result) => {
    runtimeRevocationSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    runtimeRevocationSettled,
    false,
    'multi-row runtime revocation must wait for the authority lease without deadlocking',
  );
  releaseRuntimeAuthority.resolve();
  assert.equal(await runtimeLeasedOperation, 'runtime-revocation-overlap-complete');
  assert.equal(await runtimeRevocation, true);
  assert.equal(runtimeRevocationSettled, true);
  await assert.rejects(
    () => validateGate3ProofGrant(successorGrant.id, renewedGrantCredential!.credential),
    /GATE3_PROOF_GRANT_INVALID/,
  );
  // Restore only this disposable fixture so the remaining negative cases
  // continue to exercise challenge/receipt validation rather than short-circuit
  // on the runtime revocation proven above.
  await getSharedDb().update(coordinationRuntimeRegistrations)
    .set({ enabled: true, revokedAt: null, updatedAt: new Date() })
    .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId));
  await getSharedDb().update(coordinationRuntimeCredentials)
    .set({ revokedAt: null })
    .where(eq(coordinationRuntimeCredentials.id, renewedGrantCredential!.credential.credentialId));
  assert.equal(
    (await validateGate3ProofGrant(successorGrant.id, renewedGrantCredential!.credential)).grantId,
    successorGrant.id,
  );

  await revokeReceipt(registered.receiptId, 'founder-grant-test', 'grant lifecycle test');
  await assert.rejects(
    () => validateGate3ProofGrant(successorGrant.id, renewedGrantCredential!.credential),
    /GATE3_PROOF_GRANT_INVALID/,
  );
  await assert.rejects(
    () => validateGate3ProofGrantForVerifier(successorGrant.id),
    /GATE3_PROOF_GRANT_INVALID/,
  );

  const makeChallenge = async (suffix: string) => {
    const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
    const challengeBundle = createPublicProvisioningBundle({
      ...unsigned,
      artifactSha256: crypto.createHash('sha256').update(`${operatorTaskRef}-${suffix}`).digest('hex'),
    });
    const challenge = await submitAntigravityChallenge(challengeBundle, crypto.randomUUID());
    return challenge;
  };
  const rejected = await makeChallenge('rejected');
  await decideChallenge(rejected.challengeId, 'rejected', 'founder-operator-test');
  await assert.rejects(() => registerAntigravityRuntime(bundle, rejected.challengeId), /challenge_not_approved|receipt_mismatch/);
  const expired = await makeChallenge('expired');
  await decideChallenge(expired.challengeId, 'approved', 'founder-operator-test');
  await getSharedDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    // Keep CHECK constraints active and prove equality is rejected regardless of
    // clock speed. The savepoint confines this intentionally invalid update.
    await tx.execute(sql`SAVEPOINT equal_receipt_expiry`);
    await assert.rejects(
      () => tx.update(taskOwnershipReceipts)
        .set({ expiresAt: sql`${taskOwnershipReceipts.issuedAt}` })
        .where(eq(taskOwnershipReceipts.challengeId, expired.challengeId)),
      (error: unknown) => error instanceof Error && error.cause !== null &&
        typeof error.cause === 'object' && 'constraint' in error.cause &&
        error.cause.constraint === 'task_ownership_receipt_lifecycle',
    );
    await tx.execute(sql`ROLLBACK TO SAVEPOINT equal_receipt_expiry`);
    const { issuedAt, expiresAt } = expiredOwnershipFixtureTimes(new Date());
    // Backdate the whole synthetic interval rather than assuming the real
    // clock advanced after issuance. All lifecycle CHECK constraints still run.
    await tx.update(taskOwnershipChallenges)
      .set({ createdAt: issuedAt, decidedAt: issuedAt, expiresAt })
      .where(eq(taskOwnershipChallenges.id, expired.challengeId));
    await tx.update(taskOwnershipReceipts)
      .set({ issuedAt, approvedAt: issuedAt, expiresAt })
      .where(eq(taskOwnershipReceipts.challengeId, expired.challengeId));
  });
  await assert.rejects(() => registerAntigravityRuntime(bundle, expired.challengeId), /challenge_expired/);
  const revoked = await makeChallenge('revoked');
  const revokedReceipt = await decideChallenge(revoked.challengeId, 'approved', 'founder-operator-test');
  assert.ok('id' in revokedReceipt);
  await revokeReceipt(revokedReceipt.id, 'founder-operator-test');
  await assert.rejects(() => registerAntigravityRuntime(bundle, revoked.challengeId), /receipt_mismatch/);
  assert.equal((await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId))).length, 1);

  // A fresh bootstrap is a fresh generation, not same-runtime recovery.
  const oldRegistration = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId));
  const oldProfile = await getSharedDb().select().from(coordinationRuntimeProfiles)
    .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId));
  const secondSecret = `second-generation-${crypto.randomBytes(24).toString('hex')}`;
  const { bundleDigest: _originalBundleDigest, ...generationBase } = bundle;
  const secondBundle = createPublicProvisioningBundle({
    ...generationBase,
    bootstrapSha256: hashCoordinationSecret(secondSecret),
  });
  assert.notEqual(secondBundle.runtimeId, bundle.runtimeId);
  const secondPhaseA = await submitAntigravityChallenge(secondBundle, crypto.randomUUID());
  const secondReceipt = await decideChallenge(
    secondPhaseA.challengeId, 'approved', 'founder-second-generation-test',
  );
  assert.ok('id' in secondReceipt);
  const second = await registerAntigravityRuntime(secondBundle, secondPhaseA.challengeId);
  assert.equal(second.status, 'created');
  assert.notEqual(second.runtimeId, registered.runtimeId);
  assert.notEqual(second.profileId, registered.profileId);
  assert.deepEqual(
    await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, operatorRuntimeId)),
    oldRegistration,
  );
  assert.deepEqual(
    await getSharedDb().select().from(coordinationRuntimeProfiles)
      .where(eq(coordinationRuntimeProfiles.runtimeRegistrationId, operatorRuntimeId)),
    oldProfile,
  );
  const generationAudits = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.eventType, 'runtime_generation_provisioned'));
  assert.equal(generationAudits.length >= 2, true);
  assert.equal(generationAudits.some((row) => {
    const metadata = row.metadata as Record<string, unknown>;
    return metadata.runtimeId === second.runtimeId
      && metadata.profileId === second.profileId
      && metadata.challengeId === secondPhaseA.challengeId
      && metadata.receiptId === secondReceipt.id
      && metadata.bundleDigest === secondBundle.bundleDigest
      && metadata.registrationOutcome === 'created';
  }), true);
  assert.equal(JSON.stringify(generationAudits).includes(secondSecret), false);
  // The exact approved challenge is idempotent before bootstrap consumption.
  assert.equal(
    (await registerAntigravityRuntime(secondBundle, secondPhaseA.challengeId)).status,
    'replayed',
  );
  const secondExchanged = await exchangeBootstrapCredential(second.runtimeId, secondSecret);
  assert.equal(secondExchanged.ok, true);
  if (!secondExchanged.ok) return;
  const secondCredential = await resolveBrokerCredential(secondExchanged.accessToken);
  assert.ok(secondCredential);
  await assert.rejects(
    () => validateGate3ProofGrant(grant.id, secondCredential!.credential),
    /GATE3_PROOF_GRANT_INVALID/,
  );
  assert.equal(
    (await registerAntigravityRuntime(secondBundle, secondPhaseA.challengeId)).status,
    'replayed',
  );
  await assert.rejects(
    () => registerAntigravityRuntime(
      createPublicProvisioningBundle({
        ...generationBase,
        bootstrapSha256: hashCoordinationSecret(`third-generation-${Date.now()}`),
      }),
      secondPhaseA.challengeId,
    ),
    /challenge_not_approved|receipt_mismatch/,
  );
});

databaseTest('registerCoordinationRuntime stores provider/model, and stageCoordinationRuntimeReplacement carries them forward on rotation', async () => {
  const providerModelRuntimeId = `${runtimeId}-provider-model`;
  const providerModelReplacementRuntimeId = `${runtimeId}-provider-model-replacement`;
  const defaultProviderModelRuntimeId = `${runtimeId}-provider-model-default`;

  await registerCoordinationRuntime({
    runtimeId: providerModelRuntimeId,
    actor: 'luca-replit',
    displayName: 'Provider/model CI runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
  });
  const [stored] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, providerModelRuntimeId));
  assert.equal(stored.provider, 'anthropic');
  assert.equal(stored.model, 'claude-sonnet-4-5');

  // Omitting provider/model must leave both columns null -- no inferred
  // default, per the design's "nullable, no backfill" decision.
  await registerCoordinationRuntime({
    runtimeId: defaultProviderModelRuntimeId,
    actor: 'luca-replit',
    displayName: 'Provider/model omitted CI runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const [defaulted] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, defaultProviderModelRuntimeId));
  assert.equal(defaulted.provider, null);
  assert.equal(defaulted.model, null);

  // A rotation is the same runtime identity continuing, not a new model --
  // stageCoordinationRuntimeReplacement must carry the source's provider/model
  // forward onto the new registration row rather than leaving it blank.
  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId: providerModelRuntimeId,
    replacementRuntimeId: providerModelReplacementRuntimeId,
    replacementDisplayName: 'Provider/model rotation replacement',
  });
  assert.equal(staged.ok, true);
  const [replacement] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, providerModelReplacementRuntimeId));
  assert.equal(replacement.provider, 'anthropic');
  assert.equal(replacement.model, 'claude-sonnet-4-5');
});

databaseTest('broker issues, rotates, expires from use, revokes, and audits without plaintext storage', async () => {
  const { bootstrapToken } = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-replit',
    displayName: 'Credential broker CI runtime',
    capabilities: ['coordination:read', 'coordination:credential:renew', 'coordination:credential:revoke'],
    tokenTtlSeconds: 60,
  });
  // A re-run with an already-registered --runtime-id (e.g. a copy-paste
  // retry) must surface a clear, actionable message pointing at rotation or
  // revocation -- never the raw Postgres duplicate-primary-key error. The
  // source registration is still active here, so the message must offer the
  // full, literally-runnable rotation command and must never imply that
  // revoking frees the id for reuse (it doesn't -- see
  // buildDuplicateRuntimeIdError's own doc comment).
  await assert.rejects(
    () => registerCoordinationRuntime({
      runtimeId,
      actor: 'luca-claude-code',
      displayName: 'Attempted actor rebind',
      capabilities: ['coordination:read'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /is already registered/);
      assert.match(error.message, /immutable/i);
      assert.match(error.message, /still active/i);
      assert.match(
        error.message,
        new RegExp(`npx tsx server/scripts/coordination-runtime-rotation\\.ts stage --from-runtime-id ${runtimeId} --runtime-id <new-id> --display-name`),
      );
      assert.match(error.message, /does not\s+free the id for reuse/i);
      // The exact bug the reviewer caught: revocation never deletes the row,
      // so "revoke it, then register this id again" is false and must never
      // appear, in either active-source or already-revoked wording.
      assert.doesNotMatch(error.message, /revok\w*[^.]*(?:before|then)[^.]*regist\w*[^.]*(?:this|the same)\s+id/i);
      assert.doesNotMatch(error.message, /duplicate key value/i);
      assert.doesNotMatch(error.message, /coordination_runtime_registrations_pkey/);
      return true;
    },
  );

  // Once that same registration is actually revoked, rotation is no longer a
  // valid suggestion (stageCoordinationRuntimeReplacement itself rejects a
  // revoked source with 'source_runtime_unavailable') -- the message must
  // switch to a plain "bootstrap a new id" instruction and drop the rotation
  // command entirely, never repeat the still-active wording.
  assert.equal(await revokeRuntimeCredentials(runtimeId, 'luca-replit'), true);
  await assert.rejects(
    () => registerCoordinationRuntime({
      runtimeId,
      actor: 'luca-replit',
      displayName: 'Attempted reuse after revocation',
      capabilities: ['coordination:read'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /is already registered/);
      assert.match(error.message, /immutable/i);
      assert.match(error.message, /already revoked/i);
      assert.match(error.message, /npx tsx server\/scripts\/coordination-runtime-bootstrap\.ts --runtime-id <new-id>/);
      assert.doesNotMatch(error.message, /still active/i);
      assert.doesNotMatch(error.message, /coordination-runtime-rotation\.ts stage --from-runtime-id/);
      assert.doesNotMatch(error.message, /revok\w*[^.]*(?:before|then)[^.]*regist\w*[^.]*(?:this|the same)\s+id/i);
      assert.doesNotMatch(error.message, /duplicate key value/i);
      assert.doesNotMatch(error.message, /coordination_runtime_registrations_pkey/);
      return true;
    },
  );
  // Restore so the remainder of this test still exercises an active
  // registration for exchange/renewal/audit, matching the restore pattern
  // used for operatorRuntimeId's own revocation-overlap test above.
  await getSharedDb().update(coordinationRuntimeRegistrations)
    .set({ enabled: true, revokedAt: null, updatedAt: new Date() })
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));

  const wrongBootstrap = await exchangeBootstrapCredential(runtimeId, 'wrong-bootstrap');
  assert.equal(wrongBootstrap.ok, false);
  if (!wrongBootstrap.ok) assert.equal(wrongBootstrap.reason, 'invalid_bootstrap');
  const unknownRuntime = await exchangeBootstrapCredential(`${runtimeId}-does-not-exist`, bootstrapToken);
  assert.equal(unknownRuntime.ok, false);
  if (!unknownRuntime.ok) assert.equal(unknownRuntime.reason, 'unknown_runtime');

  const issued = await exchangeBootstrapCredential(runtimeId, bootstrapToken);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(issued.credential.actor, 'luca-replit');
  assert.deepEqual(issued.credential.capabilities, [
    'coordination:read',
    'coordination:credential:renew',
    'coordination:credential:revoke',
  ]);

  // Resolve (use) the issued credential before attempting a resend below.
  // Grace re-exchange (attemptGraceBootstrapReexchange) only mints a second
  // credential when nothing issued for this runtime has ever authenticated a
  // request; resolving here first closes that window deliberately, so the
  // resend below is guaranteed to hit the always_consumed branch instead of
  // minting a second live credential out from under the rest of this test.
  const resolved = await resolveBrokerCredential(issued.accessToken);
  assert.equal(resolved?.runtimeId, runtimeId);

  // Resending the exact bootstrap that was just consumed must be classified
  // as bootstrap_already_consumed, not the generic invalid_bootstrap, so a
  // client without database access can tell "ask for a new bootstrap" apart
  // from "check the token you were given". This is the motivating case for
  // task 1557: consumption overwrites bootstrapHash with a tombstone, so a
  // naive hash-equality check alone would misclassify this as invalid.
  const reExchanged = await exchangeBootstrapCredential(runtimeId, bootstrapToken);
  assert.equal(reExchanged.ok, false);
  if (!reExchanged.ok) assert.equal(reExchanged.reason, 'bootstrap_already_consumed');

  const [registration] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.notEqual(registration.bootstrapHash, bootstrapToken);

  const [storedCredential] = await getSharedDb().select().from(coordinationRuntimeCredentials)
    .where(eq(coordinationRuntimeCredentials.id, issued.credential.credentialId));
  assert.notEqual(storedCredential.tokenHash, issued.accessToken);
  assert.equal(JSON.stringify(storedCredential).includes(issued.accessToken), false);

  const renewalAttempts = await Promise.all([
    renewBrokerCredential(issued.credential),
    renewBrokerCredential(issued.credential),
  ]);
  const successfulRenewals = renewalAttempts.filter((value) => value !== null);
  assert.equal(successfulRenewals.length, 1, 'concurrent renewal must mint exactly one successor');
  const renewed = successfulRenewals[0]!;
  assert.notEqual(renewed.accessToken, issued.accessToken);
  assert.equal(await resolveBrokerCredential(issued.accessToken), null);
  assert.equal((await resolveBrokerCredential(renewed.accessToken))?.actor, 'luca-replit');

  await revokeBrokerCredential(renewed.credential);
  assert.equal(await resolveBrokerCredential(renewed.accessToken), null);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  assert.equal(auditEvents.some((event) => event.eventType === 'issued' && event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'renewed' && event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'revoked' && event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'exchange_failed' && !event.success), true);
});

databaseTest(
  'exchange reports consumed_bootstrap_digest_conflict when a tombstone hash collides with another runtime\'s live bootstrap',
  async () => {
    // A genuine SHA-256 collision is computationally infeasible to construct
    // in a test, so this uses the prehashed-registration path to place a
    // second runtime's live bootstrapHash at the exact value the first
    // runtime's tombstone will occupy after consumption -- the same DB state
    // a real collision would produce, exercised through the real code path.
    const conflictSourceRuntimeId = `${runtimeId}-digest-conflict-source`;
    const conflictOwnerRuntimeId = `${runtimeId}-digest-conflict-owner`;
    const { bootstrapToken: sourceBootstrap } = await registerCoordinationRuntime({
      runtimeId: conflictSourceRuntimeId,
      actor: 'luca-replit',
      displayName: 'Digest conflict source CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });
    const futureTombstone = consumedCoordinationBootstrapHash(
      conflictSourceRuntimeId,
      hashCoordinationSecret(sourceBootstrap),
    );
    await registerCoordinationRuntimeWithBootstrapSha256({
      runtimeId: conflictOwnerRuntimeId,
      actor: 'luca-claude-code',
      displayName: 'Digest conflict owner CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
      bootstrapSha256: futureTombstone,
    });

    const conflicted = await exchangeBootstrapCredential(conflictSourceRuntimeId, sourceBootstrap);
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) assert.equal(conflicted.reason, 'consumed_bootstrap_digest_conflict');

    // The colliding owner registration must be untouched: the conflict must
    // block the source's exchange, not silently consume or alter the owner.
    const [ownerAfter] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, conflictOwnerRuntimeId));
    assert.equal(ownerAfter.bootstrapHash, futureTombstone);

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, conflictSourceRuntimeId));
    assert.equal(
      auditEvents.some((event) =>
        event.eventType === 'exchange_failed'
        && !event.success
        && event.reason === 'consumed_bootstrap_digest_conflict'
      ),
      true,
    );
  },
);

databaseTest(
  'designateStandingCoordinationVerifier is restricted to approved verifier actors and the matching registration',
  async () => {
    const { bootstrapToken } = await registerCoordinationRuntime({
      runtimeId: standingVerifierRuntimeId,
      actor: 'luca-replit',
      displayName: 'Standing verifier designation CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });
    const issued = await exchangeBootstrapCredential(standingVerifierRuntimeId, bootstrapToken);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.credential.standingVerifier, false);
    assert.equal((await resolveBrokerCredential(issued.accessToken))?.standingVerifier, false);

    // luca-gemini is never an approved verifier actor, regardless of which
    // registration it names -- rejected before any registration lookup.
    assert.equal(
      await designateStandingCoordinationVerifier(standingVerifierRuntimeId, 'luca-gemini'),
      false,
    );
    assert.equal((await resolveBrokerCredential(issued.accessToken))?.standingVerifier, false);

    // A real registration exists for a different actor than the one making
    // this call -- must not designate someone else's registration.
    await registerCoordinationRuntime({
      runtimeId: standingVerifierWrongActorRuntimeId,
      actor: 'luca-claude-code',
      displayName: 'Standing verifier wrong-actor CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });
    assert.equal(
      await designateStandingCoordinationVerifier(standingVerifierWrongActorRuntimeId, 'luca-replit'),
      false,
    );

    // Unknown runtimeId with an otherwise-approved verifier actor.
    assert.equal(
      await designateStandingCoordinationVerifier(`${standingVerifierRuntimeId}-unknown`, 'luca-replit'),
      false,
    );

    // The approved verifier actor designating its own registration succeeds,
    // and the change is visible through both the repository row and the
    // broker credential resolution path used by the runtime route layer.
    assert.equal(
      await designateStandingCoordinationVerifier(standingVerifierRuntimeId, 'luca-replit'),
      true,
    );
    const [registration] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, standingVerifierRuntimeId));
    assert.equal(registration.standingVerifier, true);
    assert.equal((await resolveBrokerCredential(issued.accessToken))?.standingVerifier, true);

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, standingVerifierRuntimeId));
    assert.equal(
      auditEvents.some((event) => event.eventType === 'standing_verifier_designated' && event.success),
      true,
    );
    assert.equal(
      auditEvents.some((event) => event.eventType === 'standing_verifier_designation_failed' && !event.success),
      true,
    );
  },
);

const verifiedDisposableDatabaseTest = getVerifiedCiDatabaseUrl() ? test : test.skip;

verifiedDisposableDatabaseTest(
  'runtime revocation cannot leave an issued credential usable after an overlapping bootstrap exchange',
  async () => {
    const { bootstrapToken } = await registerCoordinationRuntime({
      runtimeId: revocationRaceRuntimeId,
      actor: 'luca-replit',
      displayName: 'Credential broker revocation race CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });
    const exchangePaused = deferred();
    const releaseExchange = deferred();

    const exchangePromise = exchangeBootstrapCredential(
      revocationRaceRuntimeId,
      bootstrapToken,
      undefined,
      {
        afterRegistrationLocked: async () => {
          exchangePaused.resolve();
          await releaseExchange.promise;
        },
      },
    );
    await exchangePaused.promise;

    const revocationPromise = revokeRuntimeCredentials(
      revocationRaceRuntimeId,
      'luca-replit',
    );
    const revocationFinishedBeforeRelease = await Promise.race([
      revocationPromise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    releaseExchange.resolve();
    const [issued, revoked] = await Promise.all([exchangePromise, revocationPromise]);
    assert.equal(
      revocationFinishedBeforeRelease,
      false,
      'runtime revocation must wait while bootstrap exchange holds the registration lock',
    );

    assert.equal(issued.ok, true, 'the lock-winning exchange should return its credential before revocation commits');
    if (!issued.ok) return;
    assert.equal(revoked, true);

    const [registration] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, revocationRaceRuntimeId));
    assert.equal(registration.enabled, false);
    assert.ok(registration.revokedAt);
    await getSharedDb().update(coordinationRuntimeCredentials)
      .set({ revokedAt: null })
      .where(eq(coordinationRuntimeCredentials.id, issued.credential.credentialId));
    assert.equal(
      await resolveBrokerCredential(issued.accessToken),
      null,
      'a credential returned by the overlapping exchange must not authenticate through a revoked registration',
    );

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, revocationRaceRuntimeId));
    assert.equal(
      auditEvents.some((event) => event.eventType === 'runtime_revoked' && event.success),
      true,
      'runtime revocation must be audited',
    );
    assert.equal(
      auditEvents.some((event) => (
        event.eventType === 'access_failed'
        && !event.success
        && event.reason === 'revoked'
        && event.credentialId === issued.credential.credentialId
      )),
      true,
      'denied use of the returned credential must be audited as revoked',
    );
  },
);

databaseTest(
  'a bootstrap that was consumed but never used to authenticate a request can be re-exchanged',
  async () => {
    const { bootstrapToken } = await registerCoordinationRuntime({
      runtimeId: graceReexchangeNeverUsedRuntimeId,
      actor: 'luca-replit',
      displayName: 'Credential broker grace re-exchange CI runtime (never used)',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });

    const first = await exchangeBootstrapCredential(graceReexchangeNeverUsedRuntimeId, bootstrapToken);
    assert.equal(first.ok, true, 'the original exchange must succeed');
    if (!first.ok) return;

    // The first credential is never resolved/used. A retry with the exact
    // same bootstrap must succeed under grace instead of failing, and must
    // mint a genuinely new credential rather than replaying the first.
    const second = await exchangeBootstrapCredential(graceReexchangeNeverUsedRuntimeId, bootstrapToken);
    assert.equal(second.ok, true, 'grace re-exchange must succeed while nothing issued has ever been used');
    if (!second.ok) return;
    assert.notEqual(second.accessToken, first.accessToken);
    assert.notEqual(second.credential.credentialId, first.credential.credentialId);

    // Grace is not a one-shot: as long as nothing issued for this runtime has
    // ever authenticated a request, the same bootstrap can be retried again.
    const third = await exchangeBootstrapCredential(graceReexchangeNeverUsedRuntimeId, bootstrapToken);
    assert.equal(third.ok, true, 'grace re-exchange must remain available across repeated unused retries');
    if (!third.ok) return;
    assert.notEqual(third.accessToken, second.accessToken);

    // A wrong secret against this same (already-consumed) registration must
    // still be rejected outright -- grace never widens what counts as proof
    // of possessing the original bootstrap.
    const wrongSecretAttempt = await exchangeBootstrapCredential(
      graceReexchangeNeverUsedRuntimeId,
      'cb_definitely-the-wrong-secret',
    );
    assert.equal(wrongSecretAttempt.ok, false);
    if (!wrongSecretAttempt.ok) assert.equal(wrongSecretAttempt.reason, 'invalid_bootstrap');

    // Using the most recently granted credential now closes the grace window.
    assert.ok(await resolveBrokerCredential(third.accessToken));
    const closedGraceAttempt = await exchangeBootstrapCredential(graceReexchangeNeverUsedRuntimeId, bootstrapToken);
    assert.equal(
      closedGraceAttempt.ok,
      false,
      'grace must stop once any issued credential has actually authenticated a request',
    );
    if (!closedGraceAttempt.ok) assert.equal(closedGraceAttempt.reason, 'bootstrap_already_consumed');

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, graceReexchangeNeverUsedRuntimeId));
    assert.equal(
      auditEvents.filter((event) => event.eventType === 'bootstrap_grace_reexchange' && event.success).length,
      2,
      'each successful grace re-exchange must be audited distinctly from the original issuance',
    );
    assert.equal(
      auditEvents.some((event) => (
        event.eventType === 'exchange_failed' && !event.success && event.reason === 'invalid_bootstrap'
      )),
      true,
      'a wrong secret must be audited as invalid_bootstrap, never as a grace attempt',
    );
    assert.equal(
      auditEvents.some((event) => (
        event.eventType === 'exchange_failed' && !event.success && event.reason === 'bootstrap_already_consumed'
      )),
      true,
      'the final exchange after first use must be audited as bootstrap_already_consumed',
    );
  },
);

databaseTest(
  'a bootstrap cannot be re-exchanged once the very first issued credential has authenticated a request',
  async () => {
    const { bootstrapToken } = await registerCoordinationRuntime({
      runtimeId: graceReexchangeUsedRuntimeId,
      actor: 'luca-replit',
      displayName: 'Credential broker grace re-exchange CI runtime (used)',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });

    const issued = await exchangeBootstrapCredential(graceReexchangeUsedRuntimeId, bootstrapToken);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.ok(
      await resolveBrokerCredential(issued.accessToken),
      'the issued credential must authenticate normally',
    );

    const reexchangeAfterUse = await exchangeBootstrapCredential(graceReexchangeUsedRuntimeId, bootstrapToken);
    assert.equal(
      reexchangeAfterUse.ok,
      false,
      'a bootstrap must stay burned once its credential has actually authenticated a request',
    );
    if (!reexchangeAfterUse.ok) assert.equal(reexchangeAfterUse.reason, 'bootstrap_already_consumed');

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, graceReexchangeUsedRuntimeId));
    assert.equal(
      auditEvents.some((event) => (
        event.eventType === 'exchange_failed'
        && !event.success
        && event.reason === 'bootstrap_already_consumed'
      )),
      true,
    );
    assert.equal(
      auditEvents.some((event) => event.eventType === 'bootstrap_grace_reexchange'),
      false,
      'grace must never fire once a credential has been used',
    );
  },
);

verifiedDisposableDatabaseTest(
  'a credential racing its first use against a concurrent grace re-exchange never leaves both authorized',
  async () => {
    const { bootstrapToken } = await registerCoordinationRuntime({
      runtimeId: graceRaceRuntimeId,
      actor: 'luca-replit',
      displayName: 'Credential broker grace race CI runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });

    const first = await exchangeBootstrapCredential(graceRaceRuntimeId, bootstrapToken);
    assert.ok(first, 'the original exchange must succeed');

    const exchangePaused = deferred();
    const releaseExchange = deferred();

    // Re-presenting the same (now-consumed) bootstrap takes the grace path.
    // Pause it right after it takes the runtime's advisory lock -- the exact
    // lock resolveBrokerCredential now takes before marking a never-used
    // credential as used -- so the two operations are proven mutually
    // exclusive instead of merely sequential by accident.
    const gracePromise = exchangeBootstrapCredential(
      graceRaceRuntimeId,
      bootstrapToken,
      undefined,
      {
        afterRegistrationLocked: async () => {
          exchangePaused.resolve();
          await releaseExchange.promise;
        },
      },
    );
    await exchangePaused.promise;

    const resolvePromise = resolveBrokerCredential(first.accessToken);
    const resolveFinishedBeforeRelease = await Promise.race([
      resolvePromise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    releaseExchange.resolve();
    const [grace, resolved] = await Promise.all([gracePromise, resolvePromise]);

    assert.equal(
      resolveFinishedBeforeRelease,
      false,
      'the racing first use must wait while grace re-exchange holds the runtime advisory lock',
    );
    assert.ok(grace, 'grace must succeed: nothing had authenticated yet when it took the lock');
    assert.notEqual(grace.credential.credentialId, first.credential.credentialId);
    assert.equal(
      resolved,
      null,
      'the racing first use must fail once grace has revoked the credential it superseded',
    );

    // The credential grace minted remains independently usable afterward,
    // and the one it superseded stays dead -- exactly one survives the race.
    assert.ok(await resolveBrokerCredential(grace.accessToken));
    assert.equal(await resolveBrokerCredential(first.accessToken), null);

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, graceRaceRuntimeId));
    assert.equal(
      auditEvents.some((event) => (
        event.eventType === 'access_failed'
        && !event.success
        && event.reason === 'revoked'
        && event.credentialId === first.credential.credentialId
      )),
      true,
      'the credential grace revoked out from under the racing first use must be audited as revoked',
    );
    const graceEvent = auditEvents.find((event) => event.eventType === 'bootstrap_grace_reexchange');
    assert.ok(graceEvent, 'the successful grace re-exchange must be audited');
    assert.equal(
      (graceEvent.metadata as Record<string, unknown>).priorUnusedCredentialsRevoked,
      1,
      'the grace audit event must record that it revoked the one superseded credential',
    );
  },
);

databaseTest('adminRevokeRuntimeCredentials revokes across actors; listCoordinationRuntimeRegistrations exposes no secrets', async () => {
  const adminRuntimeId = `${runtimeId}-admin-revoke`;
  await registerCoordinationRuntime({
    runtimeId: adminRuntimeId,
    actor: 'luca-antigravity',
    displayName: 'Admin-revoke CI runtime',
    capabilities: ['coordination:read', 'coordination:write'],
    provider: 'test-provider',
    model: 'test-model',
  });

  // Self-service revocation must refuse an actor that does not own the
  // runtime -- this is the exact restriction adminRevokeRuntimeCredentials
  // is meant to bypass under the founder-granted coordination:runtime:admin
  // capability (alden/david onboarding or offboarding a DIFFERENT actor's
  // runtime, e.g. a Luca hat).
  assert.equal(await revokeRuntimeCredentials(adminRuntimeId, 'alden'), false);

  const listedBeforeRevoke = await listCoordinationRuntimeRegistrations();
  const beforeEntry = listedBeforeRevoke.find((entry) => entry.runtimeId === adminRuntimeId);
  assert.ok(beforeEntry, 'the new registration must appear in the listing');
  assert.equal(beforeEntry?.actor, 'luca-antigravity');
  assert.equal(beforeEntry?.enabled, true);
  assert.equal(beforeEntry?.revokedAt, null);
  assert.equal(beforeEntry?.provider, 'test-provider');
  assert.equal(beforeEntry?.model, 'test-model');
  // Non-secret listing: no bootstrap hash, credential id, or access token
  // material of any kind.
  assert.equal('bootstrapHash' in (beforeEntry as object), false);
  assert.equal(JSON.stringify(listedBeforeRevoke).match(/bootstrapHash|accessToken|credentialId/i), null);

  assert.equal(await adminRevokeRuntimeCredentials('unknown-runtime-id-that-does-not-exist', 'alden'), false);

  assert.equal(await adminRevokeRuntimeCredentials(adminRuntimeId, 'alden'), true);

  const listedAfterRevoke = await listCoordinationRuntimeRegistrations();
  const afterEntry = listedAfterRevoke.find((entry) => entry.runtimeId === adminRuntimeId);
  assert.ok(afterEntry);
  assert.equal(afterEntry?.enabled, false);
  assert.ok(afterEntry?.revokedAt);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, adminRuntimeId));
  const adminRevocationEvent = auditEvents.find((event) => (
    event.eventType === 'runtime_revoked' && event.success
  ));
  assert.ok(adminRevocationEvent, 'the admin revocation must be audited as runtime_revoked');
  assert.equal(adminRevocationEvent?.actor, 'luca-antigravity');
  assert.equal((adminRevocationEvent?.metadata as Record<string, unknown> | null)?.revokedBy, 'alden');
});