import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import {
  coordinationCredentialAuditEvents,
  coordinationRuntimeCredentials,
  coordinationRuntimeRegistrations,
  coordinationRuntimeRotations,
} from '@shared/schema';
import { closeDbConnections, getSharedDb } from '../db';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import {
  completeCoordinationRuntimeReplacement,
  disableCoordinationRuntimeRegistration,
  exchangeBootstrapCredential,
  markCoordinationRuntimeReplacementReady,
  registerCoordinationRuntime,
  reissueCoordinationRuntimeBootstrap,
  resolveBrokerCredential,
  revokeRuntimeCredentials,
  rollbackCoordinationRuntimeReplacement,
  setCoordinationCredentialBrokerConcurrencyTestHook,
  stageCoordinationRuntimeReplacement,
} from '../services/coordination-credential-broker';
import { formatRollbackOutcome } from './coordination-runtime-rotation';

const hasDisposableDatabase = Boolean(
  getVerifiedCiDatabaseUrl() || process.env.COORDINATION_INBOX_DISPOSABLE_BRANCH_ID,
);
const databaseTest = hasDisposableDatabase ? test : test.skip;

function createTwoPartySnapshotBarrier(expectedPoints: string[]) {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (point: string) => {
    assert.equal(expectedPoints.includes(point), true);
    arrivals += 1;
    if (arrivals === 2) release();
    await Promise.race([
      bothArrived,
      new Promise<void>((resolve) => setTimeout(resolve, 150)),
    ]);
  };
}

const runtimeIds = [
  `credential-rotation-source-${Date.now()}`,
  `credential-rotation-replacement-${Date.now()}`,
  `credential-rotation-rollback-${Date.now()}`,
  `credential-rotation-concurrent-source-${Date.now()}`,
  `credential-rotation-concurrent-replacement-a-${Date.now()}`,
  `credential-rotation-concurrent-replacement-b-${Date.now()}`,
  `credential-rotation-terminal-source-${Date.now()}`,
  `credential-rotation-terminal-replacement-${Date.now()}`,
  `credential-rotation-ready-rollback-source-${Date.now()}`,
  `credential-rotation-ready-rollback-replacement-${Date.now()}`,
  `credential-rotation-shared-replacement-source-a-${Date.now()}`,
  `credential-rotation-shared-replacement-source-b-${Date.now()}`,
  `credential-rotation-shared-replacement-${Date.now()}`,
  `credential-reissue-repeatable-${Date.now()}`,
  `credential-reissue-metadata-${Date.now()}`,
  `credential-reissue-revoked-source-${Date.now()}`,
  `credential-reissue-revoked-replacement-${Date.now()}`,
  `credential-disable-unused-${Date.now()}`,
  `credential-disable-expired-unused-${Date.now()}`,
  `credential-disable-live-${Date.now()}`,
  `credential-disable-used-${Date.now()}`,
  `credential-disable-twice-${Date.now()}`,
  `credential-disable-rotation-source-${Date.now()}`,
  `credential-disable-rotation-replacement-${Date.now()}`,
  `credential-disable-first-use-race-${Date.now()}`,
  `credential-disable-dormant-${Date.now()}`,
  `credential-disable-dormant-recent-${Date.now()}`,
  `credential-disable-dormant-live-${Date.now()}`,
];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

after(async () => {
  if (!hasDisposableDatabase) return;
  await getSharedDb().delete(coordinationRuntimeRotations)
    .where(inArray(coordinationRuntimeRotations.sourceRuntimeId, runtimeIds));
  await getSharedDb().delete(coordinationRuntimeRegistrations)
    .where(inArray(coordinationRuntimeRegistrations.id, runtimeIds));
  await getSharedDb().delete(coordinationCredentialAuditEvents)
    .where(inArray(coordinationCredentialAuditEvents.runtimeId, runtimeIds));
  await closeDbConnections();
});

databaseTest('runtime bootstrap rotation drains safely, completes only after use, and rolls back fail-closed', async () => {
  const source = await registerCoordinationRuntime({
    runtimeId: runtimeIds[0],
    actor: 'luca-replit',
    displayName: 'Credential rotation source',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });
  const sourceCredential = await exchangeBootstrapCredential(runtimeIds[0], source.bootstrapToken);
  assert.equal(sourceCredential.ok, true);
  if (!sourceCredential.ok) return;

  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId: runtimeIds[0],
    replacementRuntimeId: runtimeIds[1],
    replacementDisplayName: 'Credential rotation replacement',
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  assert.equal(staged.actor, 'luca-replit');
  assert.deepEqual(staged.capabilities, ['coordination:read', 'coordination:credential:renew']);
  assert.equal(staged.tokenTtlSeconds, 60);
  assert.equal((await resolveBrokerCredential(sourceCredential.accessToken))?.runtimeId, runtimeIds[0]);
  assert.deepEqual(
    await stageCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[1],
      replacementRuntimeId: runtimeIds[2],
      replacementDisplayName: 'Forbidden nested replacement',
    }),
    { ok: false, reason: 'runtime_already_rotating' },
  );

  const replacementCredential = await exchangeBootstrapCredential(runtimeIds[1], staged.bootstrapToken);
  assert.equal(replacementCredential.ok, true);
  if (!replacementCredential.ok) return;
  assert.deepEqual(replacementCredential.credential.capabilities, sourceCredential.credential.capabilities);
  assert.deepEqual(
    await completeCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[0],
      replacementRuntimeId: runtimeIds[1],
    }),
    { ok: false, reason: 'replacement_not_ready' },
  );

  const replacementProof = await resolveBrokerCredential(replacementCredential.accessToken);
  assert.equal(replacementProof?.runtimeId, runtimeIds[1]);
  assert.ok(replacementProof);
  assert.equal((await markCoordinationRuntimeReplacementReady({
    sourceRuntimeId: runtimeIds[0],
    credential: sourceCredential.credential,
  })).ok, false, 'source credential cannot prove replacement readiness');
  assert.equal((await markCoordinationRuntimeReplacementReady({
    sourceRuntimeId: runtimeIds[0],
    credential: replacementProof,
  })).ok, true);
  assert.deepEqual(
    await completeCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[0],
      replacementRuntimeId: runtimeIds[1],
    }),
    { ok: true, actor: 'luca-replit' },
  );
  // Rotation completion revokes the source registration (see
  // completeCoordinationRuntimeReplacement). Grace-reexchange classification
  // compares the tombstone hash first, before looking at enabled/revokedAt:
  // the presented secret really is this runtime's already-consumed
  // bootstrap, so re-exchanging it reports the specific
  // bootstrap_already_consumed even though the registration has since been
  // retired by a normal, successful rotation -- distinguishing "this secret
  // was valid and used, but its runtime moved on" from a bootstrap that was
  // never valid at all. See attemptGraceBootstrapReexchange in
  // coordination-credential-broker.ts.
  const sourceReExchanged = await exchangeBootstrapCredential(runtimeIds[0], source.bootstrapToken);
  assert.equal(sourceReExchanged.ok, false);
  if (!sourceReExchanged.ok) assert.equal(sourceReExchanged.reason, 'bootstrap_already_consumed');
  assert.equal(await resolveBrokerCredential(sourceCredential.accessToken), null);
  assert.equal((await resolveBrokerCredential(replacementCredential.accessToken))?.runtimeId, runtimeIds[1]);

  const rollbackStage = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId: runtimeIds[1],
    replacementRuntimeId: runtimeIds[2],
    replacementDisplayName: 'Credential rotation rollback candidate',
  });
  assert.equal(rollbackStage.ok, true);
  if (!rollbackStage.ok) return;
  const rollbackCredential = await exchangeBootstrapCredential(runtimeIds[2], rollbackStage.bootstrapToken);
  assert.equal(rollbackCredential.ok, true);
  if (!rollbackCredential.ok) return;
  const rollbackProof = await resolveBrokerCredential(rollbackCredential.accessToken);
  assert.equal(rollbackProof?.runtimeId, runtimeIds[2]);
  assert.equal(await revokeRuntimeCredentials(runtimeIds[1], 'luca-replit'), true);
  assert.deepEqual(
    await rollbackCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[1],
      replacementRuntimeId: runtimeIds[2],
    }),
    { ok: true, actor: 'luca-replit', sourceActive: false },
  );
  assert.equal(await resolveBrokerCredential(rollbackCredential.accessToken), null);
  assert.equal(await resolveBrokerCredential(replacementCredential.accessToken), null);
  const degradedRollbackMessage = formatRollbackOutcome({
    actor: 'luca-replit',
    sourceRuntimeId: runtimeIds[1],
    replacementRuntimeId: runtimeIds[2],
    sourceActive: false,
  });
  assert.match(degradedRollbackMessage, /was not re-enabled/);
  assert.match(degradedRollbackMessage, /no runtime in this pair remains active/);
  assert.doesNotMatch(degradedRollbackMessage, /source.*remains active/i);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(inArray(coordinationCredentialAuditEvents.runtimeId, runtimeIds));
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_started' && event.success), true);
  assert.equal(auditEvents.some((event) => event.reason === 'runtime_already_rotating' && !event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_completion_failed' && !event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_ready' && event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_ready_failed' && !event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_completed' && event.success), true);
  assert.equal(auditEvents.some((event) => event.eventType === 'rotation_rolled_back' && event.success), true);
  assert.equal(
    auditEvents.some(
      (event) => event.eventType === 'rotation_rolled_back'
        && event.success
        && event.metadata?.sourceActive === false,
    ),
    true,
  );
  assert.equal(JSON.stringify(auditEvents).includes(staged.bootstrapToken), false);
  assert.equal(JSON.stringify(auditEvents).includes(rollbackStage.bootstrapToken), false);
});

databaseTest('concurrent stages sharing a runtime create exactly one active rotation and audit the loser', async () => {
  await registerCoordinationRuntime({
    runtimeId: runtimeIds[3],
    actor: 'luca-replit',
    displayName: 'Concurrent rotation source',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });

  setCoordinationCredentialBrokerConcurrencyTestHook(
    createTwoPartySnapshotBarrier(['stage_snapshot_read']),
  );
  const attempts = await Promise.all([
    stageCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[3],
      replacementRuntimeId: runtimeIds[4],
      replacementDisplayName: 'Concurrent replacement A',
    }),
    stageCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[3],
      replacementRuntimeId: runtimeIds[5],
      replacementDisplayName: 'Concurrent replacement B',
    }),
  ]).finally(() => {
    setCoordinationCredentialBrokerConcurrencyTestHook(undefined);
  });

  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.ok).length, 1);
  assert.equal(attempts.find((attempt) => !attempt.ok)?.reason, 'runtime_already_rotating');

  const activeRotations = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(and(
      eq(coordinationRuntimeRotations.sourceRuntimeId, runtimeIds[3]),
      inArray(coordinationRuntimeRotations.state, ['staged', 'ready']),
    ));
  assert.equal(activeRotations.length, 1);

  const winningReplacementId = activeRotations[0].replacementRuntimeId;
  assert.equal([runtimeIds[4], runtimeIds[5]].includes(winningReplacementId), true);
  const losingReplacementId = winningReplacementId === runtimeIds[4] ? runtimeIds[5] : runtimeIds[4];
  const [losingRegistration] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, losingReplacementId));
  assert.equal(losingRegistration, undefined);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeIds[3]));
  assert.equal(auditEvents.filter((event) => event.eventType === 'rotation_started' && event.success).length, 1);
  assert.equal(auditEvents.filter((event) =>
    event.eventType === 'rotation_failed'
    && !event.success
    && event.reason === 'runtime_already_rotating'
  ).length, 1);

  assert.deepEqual(
    await rollbackCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[3],
      replacementRuntimeId: winningReplacementId,
    }),
    { ok: true, actor: 'luca-replit', sourceActive: true },
  );
  const remainingActiveRotations = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(and(
      eq(coordinationRuntimeRotations.sourceRuntimeId, runtimeIds[3]),
      inArray(coordinationRuntimeRotations.state, ['staged', 'ready']),
    ));
  assert.equal(remainingActiveRotations.length, 0);
});

databaseTest('concurrent complete and rollback attempts produce one terminal outcome and audit the loser', async () => {
  await registerCoordinationRuntime({
    runtimeId: runtimeIds[6],
    actor: 'luca-replit',
    displayName: 'Concurrent terminal source',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });
  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId: runtimeIds[6],
    replacementRuntimeId: runtimeIds[7],
    replacementDisplayName: 'Concurrent terminal replacement',
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;

  const issued = await exchangeBootstrapCredential(runtimeIds[7], staged.bootstrapToken);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const proof = await resolveBrokerCredential(issued.accessToken);
  assert.ok(proof);
  assert.equal((await markCoordinationRuntimeReplacementReady({
    sourceRuntimeId: runtimeIds[6],
    credential: proof,
  })).ok, true);

  setCoordinationCredentialBrokerConcurrencyTestHook(
    createTwoPartySnapshotBarrier(['complete_snapshot_read', 'rollback_snapshot_read']),
  );
  const attempts = await Promise.all([
    completeCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[6],
      replacementRuntimeId: runtimeIds[7],
    }),
    rollbackCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[6],
      replacementRuntimeId: runtimeIds[7],
    }),
  ]).finally(() => {
    setCoordinationCredentialBrokerConcurrencyTestHook(undefined);
  });
  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.ok).length, 1);

  const [rotation] = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(eq(coordinationRuntimeRotations.id, staged.rotationId));
  assert.ok(rotation);
  assert.equal(['completed', 'rolled_back'].includes(rotation.state), true);
  assert.equal(rotation.state === 'completed', rotation.completedAt !== null);
  assert.equal(rotation.state === 'rolled_back', rotation.rolledBackAt !== null);

  const activeRotations = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(and(
      eq(coordinationRuntimeRotations.sourceRuntimeId, runtimeIds[6]),
      inArray(coordinationRuntimeRotations.state, ['staged', 'ready']),
    ));
  assert.equal(activeRotations.length, 0);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeIds[6]));
  const terminalSuccesses = auditEvents.filter((event) =>
    event.success && ['rotation_completed', 'rotation_rolled_back'].includes(event.eventType)
  );
  const terminalFailures = auditEvents.filter((event) =>
    !event.success && ['rotation_completion_failed', 'rotation_rollback_failed'].includes(event.eventType)
  );
  assert.equal(terminalSuccesses.length, 1);
  assert.equal(terminalFailures.length, 1);
});

databaseTest('rollback wins a race with replacement readiness and stale readiness is audited', async () => {
  await registerCoordinationRuntime({
    runtimeId: runtimeIds[8],
    actor: 'luca-replit',
    displayName: 'Readiness rollback race source',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });
  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId: runtimeIds[8],
    replacementRuntimeId: runtimeIds[9],
    replacementDisplayName: 'Readiness rollback race replacement',
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;

  const issued = await exchangeBootstrapCredential(runtimeIds[9], staged.bootstrapToken);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const proof = await resolveBrokerCredential(issued.accessToken);
  assert.ok(proof);

  let readinessArrived!: () => void;
  const readinessIsWaiting = new Promise<void>((resolve) => {
    readinessArrived = resolve;
  });
  let releaseReadiness!: () => void;
  const readinessMayContinue = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  setCoordinationCredentialBrokerConcurrencyTestHook(async (point) => {
    if (point !== 'ready_before_lock') return;
    readinessArrived();
    await readinessMayContinue;
  });

  const readinessAttempt = markCoordinationRuntimeReplacementReady({
    sourceRuntimeId: runtimeIds[8],
    credential: proof,
  });
  await readinessIsWaiting;
  const rollbackAttempt = await rollbackCoordinationRuntimeReplacement({
    sourceRuntimeId: runtimeIds[8],
    replacementRuntimeId: runtimeIds[9],
  });
  releaseReadiness();
  const readinessResult = await readinessAttempt.finally(() => {
    setCoordinationCredentialBrokerConcurrencyTestHook(undefined);
  });

  assert.deepEqual(rollbackAttempt, { ok: true, actor: 'luca-replit', sourceActive: true });
  assert.deepEqual(readinessResult, { ok: false, reason: 'rotation_not_staged' });
  assert.equal([rollbackAttempt, readinessResult].filter((attempt) => attempt.ok).length, 1);

  assert.equal(await resolveBrokerCredential(issued.accessToken), null);
  // The winning rollback revokes the replacement registration (mirroring the
  // completion path above), so its already-consumed bootstrap likewise
  // reports the specific bootstrap_already_consumed rather than the generic
  // invalid_bootstrap -- see the matching comment in the rotation-drain test
  // above.
  const replacementReExchanged = await exchangeBootstrapCredential(runtimeIds[9], staged.bootstrapToken);
  assert.equal(replacementReExchanged.ok, false);
  if (!replacementReExchanged.ok) assert.equal(replacementReExchanged.reason, 'bootstrap_already_consumed');

  const [rotation] = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(eq(coordinationRuntimeRotations.id, staged.rotationId));
  assert.ok(rotation);
  assert.equal(rotation.state, 'rolled_back');
  assert.ok(rotation.rolledBackAt);
  assert.equal(rotation.readyAt, null);
  assert.equal(rotation.readyCredentialId, null);

  const activeRotations = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(and(
      eq(coordinationRuntimeRotations.sourceRuntimeId, runtimeIds[8]),
      inArray(coordinationRuntimeRotations.state, ['staged', 'ready']),
    ));
  assert.equal(activeRotations.length, 0);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeIds[8]));
  assert.equal(auditEvents.filter((event) =>
    event.eventType === 'rotation_rolled_back' && event.success
  ).length, 1);
  assert.equal(auditEvents.filter((event) =>
    event.eventType === 'rotation_ready_failed'
    && !event.success
    && event.reason === 'rotation_not_staged'
  ).length, 1);
  assert.equal(auditEvents.filter((event) =>
    event.eventType === 'rotation_ready' && event.success
  ).length, 0);
});

databaseTest('concurrent sources claiming one replacement return one audited loser without a transaction error', async () => {
  await Promise.all([
    registerCoordinationRuntime({
      runtimeId: runtimeIds[10],
      actor: 'luca-replit',
      displayName: 'Shared replacement source A',
      capabilities: ['coordination:read', 'coordination:credential:renew'],
      tokenTtlSeconds: 60,
    }),
    registerCoordinationRuntime({
      runtimeId: runtimeIds[11],
      actor: 'luca-replit',
      displayName: 'Shared replacement source B',
      capabilities: ['coordination:read', 'coordination:credential:renew'],
      tokenTtlSeconds: 60,
    }),
  ]);

  setCoordinationCredentialBrokerConcurrencyTestHook(
    createTwoPartySnapshotBarrier(['stage_snapshot_read']),
  );
  const attempts = await Promise.all([
    stageCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[10],
      replacementRuntimeId: runtimeIds[12],
      replacementDisplayName: 'Shared replacement candidate',
    }),
    stageCoordinationRuntimeReplacement({
      sourceRuntimeId: runtimeIds[11],
      replacementRuntimeId: runtimeIds[12],
      replacementDisplayName: 'Shared replacement candidate',
    }),
  ]).finally(() => {
    setCoordinationCredentialBrokerConcurrencyTestHook(undefined);
  });

  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1);
  assert.equal(attempts.filter((attempt) => !attempt.ok).length, 1);
  assert.equal(attempts.find((attempt) => !attempt.ok)?.reason, 'replacement_runtime_exists');

  const activeRotations = await getSharedDb().select().from(coordinationRuntimeRotations)
    .where(and(
      eq(coordinationRuntimeRotations.replacementRuntimeId, runtimeIds[12]),
      inArray(coordinationRuntimeRotations.state, ['staged', 'ready']),
    ));
  assert.equal(activeRotations.length, 1);
  assert.equal([runtimeIds[10], runtimeIds[11]].includes(activeRotations[0].sourceRuntimeId), true);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(inArray(coordinationCredentialAuditEvents.runtimeId, [runtimeIds[10], runtimeIds[11]]));
  assert.equal(auditEvents.filter((event) => event.eventType === 'rotation_started' && event.success).length, 1);
  assert.equal(auditEvents.filter((event) =>
    event.eventType === 'rotation_failed'
    && !event.success
    && event.reason === 'replacement_runtime_exists'
  ).length, 1);

  assert.deepEqual(
    await rollbackCoordinationRuntimeReplacement({
      sourceRuntimeId: activeRotations[0].sourceRuntimeId,
      replacementRuntimeId: runtimeIds[12],
    }),
    { ok: true, actor: 'luca-replit', sourceActive: true },
  );
});

databaseTest('in-place bootstrap reissue is repeatable, kills only prior bootstraps, and never touches issued credentials', async () => {
  const runtimeId = runtimeIds[13];
  const source = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Reissue repeatable runtime',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });
  const firstCredential = await exchangeBootstrapCredential(runtimeId, source.bootstrapToken);
  assert.equal(firstCredential.ok, true);
  if (!firstCredential.ok) return;

  const firstReissue = await reissueCoordinationRuntimeBootstrap(runtimeId);
  assert.equal(firstReissue.ok, true);
  if (!firstReissue.ok) return;
  assert.equal(firstReissue.actor, 'luca-claude-code');
  assert.notEqual(firstReissue.bootstrapToken, source.bootstrapToken);

  // The original bootstrap stays dead after reissue. Reissue overwrites
  // bootstrapHash with a live hash of the new token rather than a tombstone
  // of the old one, so the single-slot "already consumed" comparison no
  // longer matches the old token and it reads as invalid_bootstrap instead
  // of bootstrap_already_consumed -- still correctly rejected either way.
  const staleAfterFirstReissue = await exchangeBootstrapCredential(runtimeId, source.bootstrapToken);
  assert.equal(staleAfterFirstReissue.ok, false);
  if (!staleAfterFirstReissue.ok) assert.equal(staleAfterFirstReissue.reason, 'invalid_bootstrap');
  // The freshly reissued bootstrap works.
  const secondCredential = await exchangeBootstrapCredential(runtimeId, firstReissue.bootstrapToken);
  assert.equal(secondCredential.ok, true);
  if (!secondCredential.ok) return;
  // Reissue never touched the credential issued before it ran.
  assert.equal((await resolveBrokerCredential(firstCredential.accessToken))?.runtimeId, runtimeId);

  // Reissue is repeatable: doing it again invalidates only the bootstrap, not
  // any credential issued so far.
  const secondReissue = await reissueCoordinationRuntimeBootstrap(runtimeId);
  assert.equal(secondReissue.ok, true);
  if (!secondReissue.ok) return;
  assert.notEqual(secondReissue.bootstrapToken, firstReissue.bootstrapToken);
  // Same single-slot tombstone limitation as above: the second reissue
  // overwrote bootstrapHash again, so this earlier-generation bootstrap also
  // reads as invalid_bootstrap rather than bootstrap_already_consumed.
  const staleAfterSecondReissue = await exchangeBootstrapCredential(runtimeId, firstReissue.bootstrapToken);
  assert.equal(staleAfterSecondReissue.ok, false);
  if (!staleAfterSecondReissue.ok) assert.equal(staleAfterSecondReissue.reason, 'invalid_bootstrap');
  const thirdCredential = await exchangeBootstrapCredential(runtimeId, secondReissue.bootstrapToken);
  assert.equal(thirdCredential.ok, true);
  if (!thirdCredential.ok) return;
  assert.equal((await resolveBrokerCredential(firstCredential.accessToken))?.runtimeId, runtimeId);
  assert.equal((await resolveBrokerCredential(secondCredential.accessToken))?.runtimeId, runtimeId);
  assert.equal((await resolveBrokerCredential(thirdCredential.accessToken))?.runtimeId, runtimeId);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  assert.equal(auditEvents.filter((event) => event.eventType === 'bootstrap_reissued' && event.success).length, 2);
  assert.equal(JSON.stringify(auditEvents).includes(firstReissue.bootstrapToken), false);
  assert.equal(JSON.stringify(auditEvents).includes(secondReissue.bootstrapToken), false);
});

databaseTest('bootstrap reissue records whether a live credential existed, and fails closed for unknown or revoked runtimes', async () => {
  const runtimeId = runtimeIds[14];
  await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Reissue metadata runtime',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });

  // No credential has ever been issued yet.
  const reissueWithoutCredential = await reissueCoordinationRuntimeBootstrap(runtimeId);
  assert.equal(reissueWithoutCredential.ok, true);
  if (!reissueWithoutCredential.ok) return;

  const credential = await exchangeBootstrapCredential(runtimeId, reissueWithoutCredential.bootstrapToken);
  assert.equal(credential.ok, true);

  // A live, unexpired credential now exists at the moment of the next reissue.
  const reissueWithCredential = await reissueCoordinationRuntimeBootstrap(runtimeId);
  assert.equal(reissueWithCredential.ok, true);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  const reissuedEvents = auditEvents
    .filter((event) => event.eventType === 'bootstrap_reissued' && event.success)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  assert.equal(reissuedEvents.length, 2);
  assert.equal(reissuedEvents[0].metadata?.hadActiveCredentialAtReissue, false);
  assert.equal(reissuedEvents[1].metadata?.hadActiveCredentialAtReissue, true);

  assert.deepEqual(
    await reissueCoordinationRuntimeBootstrap('credential-reissue-never-registered'),
    { ok: false, reason: 'runtime_not_found' },
  );
  const notFoundEvent = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(and(
      eq(coordinationCredentialAuditEvents.runtimeId, 'credential-reissue-never-registered'),
      eq(coordinationCredentialAuditEvents.eventType, 'bootstrap_reissue_failed'),
    ));
  assert.equal(notFoundEvent.some((event) => !event.success && event.reason === 'runtime_not_found'), true);
  await getSharedDb().delete(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, 'credential-reissue-never-registered'));
});

databaseTest('bootstrap reissue refuses a revoked registration', async () => {
  const sourceRuntimeId = runtimeIds[15];
  const replacementRuntimeId = runtimeIds[16];
  await registerCoordinationRuntime({
    runtimeId: sourceRuntimeId,
    actor: 'luca-claude-code',
    displayName: 'Reissue revoked source',
    capabilities: ['coordination:read', 'coordination:credential:renew'],
    tokenTtlSeconds: 60,
  });
  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId,
    replacementRuntimeId,
    replacementDisplayName: 'Reissue revoked replacement',
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  const replacementCredential = await exchangeBootstrapCredential(replacementRuntimeId, staged.bootstrapToken);
  assert.equal(replacementCredential.ok, true);
  if (!replacementCredential.ok) return;
  const replacementProof = await resolveBrokerCredential(replacementCredential.accessToken);
  assert.ok(replacementProof);
  assert.equal((await markCoordinationRuntimeReplacementReady({
    sourceRuntimeId,
    credential: replacementProof,
  })).ok, true);
  assert.deepEqual(
    await completeCoordinationRuntimeReplacement({ sourceRuntimeId, replacementRuntimeId }),
    { ok: true, actor: 'luca-claude-code' },
  );

  assert.deepEqual(
    await reissueCoordinationRuntimeBootstrap(sourceRuntimeId),
    { ok: false, reason: 'runtime_disabled_or_revoked' },
  );

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, sourceRuntimeId));
  assert.equal(
    auditEvents.some((event) =>
      event.eventType === 'bootstrap_reissue_failed'
      && !event.success
      && event.reason === 'runtime_disabled_or_revoked'
    ),
    true,
  );

  // The rejection must come from the early disabled/revoked check (run
  // right after the row is read), not from the UPDATE's own WHERE clause
  // falling through to its "no row matched" branch. Both guards enforce
  // the identical condition on the same FOR-UPDATE-locked row and so
  // return byte-identical { ok, reason } shapes -- this guardStage tag is
  // the only thing that can tell them apart, and it is what lets a
  // mutation that deletes ONLY the early check (leaving the UPDATE guard
  // standing) be caught here instead of silently passing.
  assert.equal(
    auditEvents.find((event) =>
      event.eventType === 'bootstrap_reissue_failed' && !event.success
    )?.metadata?.guardStage,
    'pre_update_check',
  );
});

databaseTest('disabling an abandoned registration that never issued a credential succeeds and is audited', async () => {
  const runtimeId = runtimeIds[17];
  const registered = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable unused runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  assert.ok(registered.bootstrapToken);

  const result = await disableCoordinationRuntimeRegistration(runtimeId);
  assert.deepEqual(result, { ok: true, actor: 'luca-claude-code' });

  const [row] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.equal(row.enabled, false);
  assert.ok(row.revokedAt);

  // The dead bootstrap can never be exchanged again once disabled.
  const exchangeAttempt = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
  assert.equal(exchangeAttempt.ok, false);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  assert.equal(
    auditEvents.some((event) => event.eventType === 'runtime_disabled' && event.success),
    true,
  );
});

databaseTest('disabling a registration whose only credential is expired and unused succeeds and revokes the leftover credential', async () => {
  const runtimeId = runtimeIds[18];
  const registered = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable expired-unused runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const credential = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
  assert.equal(credential.ok, true);
  if (!credential.ok) return;

  // Simulate natural expiry without waiting for real time to pass. lastUsedAt
  // stays null throughout -- this credential was issued but never actually
  // used to authenticate a request.
  await getSharedDb().update(coordinationRuntimeCredentials)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(coordinationRuntimeCredentials.id, credential.credential.credentialId));

  const result = await disableCoordinationRuntimeRegistration(runtimeId);
  assert.deepEqual(result, { ok: true, actor: 'luca-claude-code' });

  const [credentialRow] = await getSharedDb().select().from(coordinationRuntimeCredentials)
    .where(eq(coordinationRuntimeCredentials.id, credential.credential.credentialId));
  assert.ok(credentialRow.revokedAt, 'leftover expired credential should be revoked for hygiene');

  const [registrationRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.equal(registrationRow.enabled, false);
});

databaseTest('disabling a registration with a live unexpired credential is refused', async () => {
  const runtimeId = runtimeIds[19];
  const registered = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable live-credential runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const credential = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
  assert.equal(credential.ok, true);
  if (!credential.ok) return;

  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(runtimeId),
    { ok: false, reason: 'runtime_has_live_or_used_credential' },
  );

  // Refusal must not have touched anything: the registration stays enabled
  // and the credential keeps resolving normally.
  const [registrationRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.equal(registrationRow.enabled, true);
  assert.equal((await resolveBrokerCredential(credential.accessToken))?.runtimeId, runtimeId);

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  assert.equal(
    auditEvents.some((event) =>
      event.eventType === 'runtime_disable_failed'
      && !event.success
      && event.reason === 'runtime_has_live_or_used_credential'
    ),
    true,
  );
});

databaseTest('disabling a registration whose credential was ever used is refused even after it later expires and is revoked', async () => {
  const runtimeId = runtimeIds[20];
  const registered = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable used-credential runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const credential = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
  assert.equal(credential.ok, true);
  if (!credential.ok) return;

  // Actually use the credential once, which is what sets lastUsedAt.
  assert.equal((await resolveBrokerCredential(credential.accessToken))?.runtimeId, runtimeId);

  // Now simulate it having naturally expired and been revoked well after
  // that use -- the guard must still fire on lastUsedAt alone, independent
  // of the credential's current expiry/revocation state.
  await getSharedDb().update(coordinationRuntimeCredentials)
    .set({ expiresAt: new Date(Date.now() - 1000), revokedAt: new Date() })
    .where(eq(coordinationRuntimeCredentials.id, credential.credential.credentialId));

  const result = await disableCoordinationRuntimeRegistration(runtimeId);
  assert.deepEqual(result, { ok: false, reason: 'runtime_has_live_or_used_credential' });

  const [registrationRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.equal(registrationRow.enabled, true);
});

async function usedThenExpired(runtimeId: string, lastUsedDaysAgo: number) {
  const registered = await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable dormant runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const credential = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
  assert.equal(credential.ok, true);
  if (!credential.ok) throw new Error('exchange failed');
  assert.equal((await resolveBrokerCredential(credential.accessToken))?.runtimeId, runtimeId);
  const usedAt = new Date(Date.now() - lastUsedDaysAgo * 24 * 60 * 60 * 1000);
  await getSharedDb().update(coordinationRuntimeCredentials)
    .set({ lastUsedAt: usedAt, expiresAt: new Date(usedAt.getTime() + 60_000) })
    .where(eq(coordinationRuntimeCredentials.id, credential.credential.credentialId));
  return { credentialId: credential.credential.credentialId, usedAt };
}

databaseTest('dormant mode retires a once-used registration whose last use is older than the window, and audits it', async () => {
  const runtimeId = runtimeIds[25];
  const { credentialId, usedAt } = await usedThenExpired(runtimeId, 40);

  // The default rule is unchanged: ever-used still refuses without the opt-in.
  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(runtimeId),
    { ok: false, reason: 'runtime_has_live_or_used_credential' },
  );

  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(runtimeId, undefined, { dormantDays: 30 }),
    { ok: true, actor: 'luca-claude-code' },
  );
  const [registrationRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
  assert.equal(registrationRow.enabled, false);
  assert.ok(registrationRow.revokedAt);
  const [credentialRow] = await getSharedDb().select().from(coordinationRuntimeCredentials)
    .where(eq(coordinationRuntimeCredentials.id, credentialId));
  assert.ok(credentialRow.revokedAt, 'the expired leftover credential is revoked for hygiene');

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  const disabled = auditEvents.find((event) => event.eventType === 'runtime_disabled' && event.success);
  assert.ok(disabled);
  assert.deepEqual(disabled.metadata, { dormantDays: 30, lastUsedAt: usedAt.toISOString() });
});

databaseTest('dormant mode refuses a registration used inside the window, and one with a live credential', async () => {
  const recentId = runtimeIds[26];
  await usedThenExpired(recentId, 5);
  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(recentId, undefined, { dormantDays: 30 }),
    { ok: false, reason: 'runtime_used_within_dormancy_window' },
  );
  const [recentRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(eq(coordinationRuntimeRegistrations.id, recentId));
  assert.equal(recentRow.enabled, true);

  const liveId = runtimeIds[27];
  const registered = await registerCoordinationRuntime({
    runtimeId: liveId,
    actor: 'luca-claude-code',
    displayName: 'Disable dormant live runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const credential = await exchangeBootstrapCredential(liveId, registered.bootstrapToken);
  assert.equal(credential.ok, true);
  if (!credential.ok) return;
  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(liveId, undefined, { dormantDays: 3650 }),
    { ok: false, reason: 'runtime_has_live_or_used_credential' },
  );
  assert.equal((await resolveBrokerCredential(credential.accessToken))?.runtimeId, liveId);
});

test('dormant mode rejects a window below the minimum or a non-integer before touching the database', async () => {
  for (const dormantDays of [29, 30.5, -1, Number.NaN]) {
    assert.deepEqual(
      await disableCoordinationRuntimeRegistration('never-looked-up', undefined, { dormantDays }),
      { ok: false, reason: 'invalid_dormant_days' },
    );
  }
});

databaseTest('disabling an already-disabled registration is refused, and an unknown runtime ID is refused', async () => {
  const runtimeId = runtimeIds[21];
  await registerCoordinationRuntime({
    runtimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable twice runtime',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });

  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(runtimeId),
    { ok: true, actor: 'luca-claude-code' },
  );
  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(runtimeId),
    { ok: false, reason: 'runtime_already_disabled' },
  );

  assert.deepEqual(
    await disableCoordinationRuntimeRegistration('credential-disable-never-registered'),
    { ok: false, reason: 'runtime_not_found' },
  );

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
  assert.equal(
    auditEvents.some((event) =>
      event.eventType === 'runtime_disable_failed' && !event.success && event.reason === 'runtime_already_disabled'
    ),
    true,
  );
  const notFoundEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, 'credential-disable-never-registered'));
  assert.equal(
    notFoundEvents.some((event) => !event.success && event.reason === 'runtime_not_found'),
    true,
  );
  await getSharedDb().delete(coordinationCredentialAuditEvents)
    .where(eq(coordinationCredentialAuditEvents.runtimeId, 'credential-disable-never-registered'));
});

databaseTest('disabling either side of an active staged rotation is refused, including a replacement with no credential yet', async () => {
  const sourceRuntimeId = runtimeIds[22];
  const replacementRuntimeId = runtimeIds[23];
  await registerCoordinationRuntime({
    runtimeId: sourceRuntimeId,
    actor: 'luca-claude-code',
    displayName: 'Disable rotation source',
    capabilities: ['coordination:read'],
    tokenTtlSeconds: 60,
  });
  const staged = await stageCoordinationRuntimeReplacement({
    sourceRuntimeId,
    replacementRuntimeId,
    replacementDisplayName: 'Disable rotation replacement',
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;

  // The replacement has zero credentials at this point -- its bootstrap was
  // never exchanged. A credential-only guard would see nothing to protect
  // and let this through; the active-rotation guard is what has to catch it.
  const replacementCredentialCount = await getSharedDb().select().from(coordinationRuntimeCredentials)
    .where(eq(coordinationRuntimeCredentials.runtimeId, replacementRuntimeId));
  assert.equal(replacementCredentialCount.length, 0);

  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(sourceRuntimeId),
    { ok: false, reason: 'runtime_has_active_rotation' },
  );
  assert.deepEqual(
    await disableCoordinationRuntimeRegistration(replacementRuntimeId),
    { ok: false, reason: 'runtime_has_active_rotation' },
  );

  const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
    .where(inArray(coordinationCredentialAuditEvents.runtimeId, [sourceRuntimeId, replacementRuntimeId]));
  const failedEvents = auditEvents.filter((event) =>
    event.eventType === 'runtime_disable_failed' && !event.success && event.reason === 'runtime_has_active_rotation'
  );
  assert.equal(failedEvents.length, 2);
  assert.equal(failedEvents.every((event) => typeof event.metadata?.conflictingRotationId === 'string'), true);

  // Neither registration was touched by the refused attempts.
  const registrationRows = await getSharedDb().select().from(coordinationRuntimeRegistrations)
    .where(inArray(coordinationRuntimeRegistrations.id, [sourceRuntimeId, replacementRuntimeId]));
  assert.equal(registrationRows.every((row) => row.enabled === true), true);
});

databaseTest(
  'disable cannot succeed while a credential is completing its first authenticated use',
  async () => {
    const runtimeId = runtimeIds[24];
    const registered = await registerCoordinationRuntime({
      runtimeId,
      actor: 'luca-claude-code',
      displayName: 'Disable-vs-first-use race runtime',
      capabilities: ['coordination:read'],
      tokenTtlSeconds: 60,
    });
    const credential = await exchangeBootstrapCredential(runtimeId, registered.bootstrapToken);
    assert.equal(credential.ok, true);
    if (!credential.ok) return;

    // resolveBrokerCredential has already confirmed this credential is valid
    // and not expired -- the runtime really is authenticating -- but has not
    // yet committed lastUsedAt. A plain (non-locking) read from disable at
    // this exact instant would still see lastUsedAt = null and the old
    // expiry, and could wrongly conclude there is nothing live to protect.
    const resolvePaused = deferred();
    const releaseResolve = deferred();
    setCoordinationCredentialBrokerConcurrencyTestHook(async (point) => {
      if (point !== 'resolve_credential_before_use_update') return;
      resolvePaused.resolve();
      await releaseResolve.promise;
    });

    const resolvePromise = resolveBrokerCredential(credential.accessToken);
    await resolvePaused.promise;

    const disablePromise = disableCoordinationRuntimeRegistration(runtimeId);
    const disableFinishedBeforeRelease = await Promise.race([
      disablePromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    releaseResolve.resolve();
    const [resolved, disableResult] = await Promise.all([resolvePromise, disablePromise]);
    setCoordinationCredentialBrokerConcurrencyTestHook(undefined);

    assert.equal(
      disableFinishedBeforeRelease,
      false,
      'disable must wait while a concurrent credential resolution holds the runtime advisory lock',
    );
    assert.equal(
      resolved?.runtimeId,
      runtimeId,
      'the in-flight resolution legitimately authenticated before disable ran',
    );
    assert.deepEqual(disableResult, { ok: false, reason: 'runtime_has_live_or_used_credential' });

    // The registration that just authenticated must not have been disabled.
    const [registrationRow] = await getSharedDb().select().from(coordinationRuntimeRegistrations)
      .where(eq(coordinationRuntimeRegistrations.id, runtimeId));
    assert.equal(registrationRow.enabled, true);

    const auditEvents = await getSharedDb().select().from(coordinationCredentialAuditEvents)
      .where(eq(coordinationCredentialAuditEvents.runtimeId, runtimeId));
    assert.equal(
      auditEvents.some((event) =>
        event.eventType === 'runtime_disable_failed'
        && !event.success
        && event.reason === 'runtime_has_live_or_used_credential'
      ),
      true,
    );
  },
);
