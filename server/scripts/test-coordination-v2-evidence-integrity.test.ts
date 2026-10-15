import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

/**
 * This suite deliberately does not use the application fallback database.  The
 * service imports below use the same explicit disposable target, so requiring
 * the gate's forbidden shared URL proof prevents an accidental write to the
 * shared Neon database when this test is run by hand.
 */
function disposableTarget(): string | undefined {
  const url = process.env.COORDINATION_RUNTIME_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.COORDINATION_RUNTIME_REQUIRE_DATABASE_TESTS === '1') {
      throw new Error('COORDINATION_RUNTIME_TEST_DATABASE_URL is required by the migration gate');
    }
    return undefined;
  }
  if (process.env.COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE=1 is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('COORDINATION_RUNTIME_TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Coordinator V2 evidence tests require a PostgreSQL URL');
  }
  const forbiddenSharedUrl = process.env.COORDINATION_RUNTIME_FORBIDDEN_SHARED_URL;
  if (!forbiddenSharedUrl || forbiddenSharedUrl === url) {
    throw new Error('Coordinator V2 evidence tests require proof of the shared Neon URL');
  }
  return url;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type Fixture = {
  hostId: string;
  identityId: string;
  versionId: string;
  grantId: string;
  sessionId: string;
  attemptId: string;
};

type TransportServices = typeof import('../services/coordination-transport-lease-service');
type SessionServices = typeof import('../services/coordination-session-service');
type CleanupServices = typeof import('../services/coordination-cleanup-service');

async function insertFixture(
  client: pg.Client,
  suffix: string,
  kind: string,
  base: Pick<Fixture, 'hostId' | 'identityId' | 'versionId' | 'grantId'>,
): Promise<Fixture> {
  const id = (name: string) => `evidence-integrity-${kind}-${name}-${suffix}`;
  const hex = (name: string) => digest(`${suffix}:${kind}:${name}`);
  const sessionId = id('session');
  const attemptId = id('attempt');
  const hostId = base.hostId;

  await client.query(
    `INSERT INTO coordination_v2_sessions
       (id, policy_version_id, operator_grant_id, operator_actor, task_ref,
        task_artifact_sha256, repository_identity, starting_commit, enrolled_host_id,
        requested_providers, expires_at, attempt_budget, per_provider_budgets,
        required_validations, completion_criteria, state, idempotency_key, session_digest)
     VALUES ($1,$2,$3,'operator-test',$4,$5,'repo/coordination-v2',$6,$7,
        ARRAY['test-provider'],now()+interval '2 hours',2,
        '{"test-provider":2}'::jsonb,ARRAY['typecheck'],$8::jsonb,'running',$9,$10)`,
    [
      sessionId,
      base.versionId,
      base.grantId,
      kind === 'success' ? '11' : '12',
      hex('artifact'),
      '1'.repeat(40),
      hostId,
      JSON.stringify({ requiredCompletionEvidence: ['result'] }),
      id('session-request'),
      hex('session'),
    ],
  );
  await client.query(
    `INSERT INTO coordination_v2_session_events
       (id, session_id, sequence, from_state, to_state, event_type, actor_type,
        actor_id, request_key, metadata)
     VALUES ($1,$2,1,'ready','running','attempt_started','operator','operator-test',$3,$4::jsonb)`,
    [
      id('session-event'),
      sessionId,
      id('session-event-request'),
      JSON.stringify({ fixture: true, kind }),
    ],
  );
  await client.query(
    `INSERT INTO coordination_v2_attempts
       (id, session_id, attempt_generation, provider, model, adapter_version,
        session_ordinal, provider_ordinal, state, attempt_digest, deadline_at)
     VALUES ($1,$2,$3,'test-provider','test-model','test-adapter',1,1,
        'waiting_for_host',$4,now()+interval '1 hour')`,
    [attemptId, sessionId, id('attempt-generation'), hex('attempt')],
  );
  await client.query(
    `INSERT INTO coordination_v2_attempt_events
       (id, attempt_id, sequence, from_state, to_state, event_type, actor_type,
        actor_id, request_key, metadata)
     VALUES ($1,$2,1,'created','waiting_for_host','attempt_started','operator',
        'operator-test',$3,$4::jsonb)`,
    [
      id('attempt-event'),
      attemptId,
      id('attempt-event-request'),
      JSON.stringify({ fixture: true, kind }),
    ],
  );
  return { ...base, sessionId, attemptId };
}

async function runTransportEvidence(
  transport: TransportServices,
  fixture: Fixture,
  suffix: string,
) {
  const common = {
    sessionId: fixture.sessionId,
    enrolledHostId: fixture.hostId,
    actorId: 'operator-test',
    holderInstanceId: `evidence-holder-${suffix}`,
  };
  const lease = await transport.acquireCoordinationTransportLease({
    ...common,
    requestKey: `evidence-acquire-${suffix}`,
    durationMs: 60_000,
  });
  const pollInput = { ...common, leaseId: lease.id, epoch: lease.epoch, requestKey: `evidence-poll-${suffix}` };
  const poll = await transport.pollCoordinationTransportWork(pollInput);
  assert.deepEqual(await transport.pollCoordinationTransportWork(pollInput), poll);
  await assert.rejects(
    transport.pollCoordinationTransportWork({
      ...pollInput,
      holderInstanceId: `${common.holderInstanceId}-changed`,
    }),
    (error: unknown) => (error as { code?: string }).code === 'LEASE_REPLAY_CONFLICT',
  );

  const claimInput = {
    ...common,
    leaseId: lease.id,
    epoch: lease.epoch,
    attemptId: fixture.attemptId,
    requestKey: `evidence-claim-${suffix}`,
  };
  const claim = await transport.claimCoordinationTransportWork(claimInput);
  assert.deepEqual(await transport.claimCoordinationTransportWork(claimInput), claim);
  const result = { ok: true, output: `canonical-result-${suffix}` };
  const resultInput = {
    ...common,
    leaseId: lease.id,
    epoch: lease.epoch,
    claimId: claim.claimId,
    requestKey: `evidence-result-${suffix}`,
    result,
  };
  const storedResult = await transport.resultCoordinationTransportWork(resultInput);
  assert.deepEqual(await transport.resultCoordinationTransportWork(resultInput), storedResult);
  await assert.rejects(
    transport.resultCoordinationTransportWork({
      ...resultInput,
      result: { ...result, output: 'changed-payload' },
    }),
    (error: unknown) => (error as { code?: string }).code === 'LEASE_REPLAY_CONFLICT',
  );
  await transport.releaseCoordinationTransportLease({
    ...common,
    leaseId: lease.id,
    epoch: lease.epoch,
    requestKey: `evidence-release-${suffix}`,
  });
  return { lease, claim, storedResult, result };
}

async function canonicalEvidence(
  client: pg.Client,
  fixture: Fixture,
  completionEventType?: string,
) {
  const rows = await client.query(
    `SELECT
       (SELECT row_to_json(s) FROM coordination_v2_sessions s WHERE s.id=$1) AS session,
       (SELECT count(*)::int FROM coordination_v2_session_events WHERE session_id=$1) AS session_events,
       (SELECT count(*)::int FROM coordination_v2_attempts WHERE session_id=$1) AS attempts,
       (SELECT count(*)::int FROM coordination_v2_attempt_events e
          JOIN coordination_v2_attempts a ON a.id=e.attempt_id WHERE a.session_id=$1) AS attempt_events,
       (SELECT count(*)::int FROM coordination_v2_transport_leases WHERE session_id=$1) AS leases,
       (SELECT count(*)::int FROM coordination_v2_transport_lease_receipts WHERE session_id=$1) AS lease_receipts,
       (SELECT count(*)::int FROM coordination_v2_transport_work_claims WHERE session_id=$1) AS claims,
       (SELECT count(*)::int FROM coordination_v2_transport_work_results WHERE session_id=$1) AS results,
       (SELECT count(*)::int FROM coordination_v2_cleanup_obligations WHERE session_id=$1) AS cleanup_obligations,
       (SELECT metadata FROM coordination_v2_session_events
          WHERE session_id=$1 AND event_type=$2 ORDER BY sequence DESC LIMIT 1) AS terminal_evidence`,
    [fixture.sessionId, completionEventType ?? 'session_failed'],
  );
  const evidence = rows.rows[0];
  assert.ok(evidence.session);
  assert.ok(evidence.session_events >= 2);
  assert.equal(evidence.attempts, 1);
  assert.ok(evidence.attempt_events >= 3);
  assert.ok(evidence.leases >= 1);
  assert.ok(evidence.lease_receipts >= 4);
  assert.equal(evidence.claims, 1);
  assert.equal(evidence.results, 1);
  assert.equal(evidence.cleanup_obligations, 4);
  assert.ok(evidence.terminal_evidence);
  return evidence;
}

test('Coordinator V2 terminal evidence stays complete and immutable through replay and cleanup repair', async (context) => {
  const url = disposableTarget();
  if (!url) {
    context.skip('set COORDINATION_RUNTIME_TEST_DATABASE_URL and COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE=1');
    return;
  }

  /*
   * Production services intentionally read NEON_SHARED_DATABASE_URL.  The
   * migration gate supplies that variable with the disposable branch URL.
   * Bind it explicitly for focused runs too, and remove CI's localhost
   * selector so a different database can never win service selection.
   */
  const previousNeonUrl = process.env.NEON_SHARED_DATABASE_URL;
  const previousCi = process.env.CI;
  const previousCiUrl = process.env.CI_DATABASE_URL;
  process.env.NEON_SHARED_DATABASE_URL = url;
  delete process.env.CI;
  delete process.env.CI_DATABASE_URL;

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const suffix = `${Date.now()}-${randomUUID()}`;
  const id = (name: string) => `evidence-integrity-${name}-${suffix}`;
  const hex = (name: string) => digest(`${suffix}:${name}`);
  const base: Pick<Fixture, 'hostId' | 'identityId' | 'versionId' | 'grantId'> = {
    hostId: id('host'),
    identityId: id('identity'),
    versionId: id('version'),
    grantId: id('grant'),
  };
  let success: Fixture | undefined;
  let failure: Fixture | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO coordination_v2_host_enrollments
       (id,host_key,host_type,display_name,protocol_version,public_key,key_fingerprint,
         capabilities,enrollment_digest,enrollment_request_key,status,created_by)
       VALUES ($1,$2,'test','Evidence integrity host',1,'evidence-public-key',$3,
         ARRAY['poll','claim','result'],$4,$5,'active','evidence-test')`,
       [base.hostId, id('host-key'), hex('host-key'), hex('host-enrollment'), id('enrollment-request')],
    );
    await client.query(
      `INSERT INTO coordination_v2_policy_identities
       (id,policy_key,display_name,status,created_by)
       VALUES ($1,$2,'Evidence integrity policy','active','evidence-test')`,
      [base.identityId, id('policy-key')],
    );
    await client.query(
      `INSERT INTO coordination_v2_policy_versions
       (id,policy_identity_id,version,canonical_policy,policy_digest,approval_state,
        created_by,approved_by,approved_at)
       VALUES ($1,$2,1,$3::jsonb,$4,'approved','evidence-test','founder',now())`,
      [
        base.versionId,
        base.identityId,
        JSON.stringify({
          providerOrder: ['test-provider'],
          requiredCompletionEvidence: ['result'],
        }),
        hex('policy'),
      ],
    );
    await client.query(
      `INSERT INTO coordination_v2_operator_grants
       (id,policy_identity_id,operator_actor,actions,issued_by,expires_at,grant_digest,request_key)
       VALUES ($1,$2,'operator-test',ARRAY['launch','resume','terminate'],
        'founder',now()+interval '2 hours',$3,$4)`,
      [base.grantId, base.identityId, hex('grant'), id('grant-request')],
    );
    success = await insertFixture(client, suffix, 'success', base);
    failure = await insertFixture(client, suffix, 'failure', base);
    await client.query('COMMIT');

    const [transport, sessions, cleanup] = await Promise.all([
      import('../services/coordination-transport-lease-service'),
      import('../services/coordination-session-service'),
      import('../services/coordination-cleanup-service'),
    ]) as [TransportServices, SessionServices, CleanupServices];

    const successTransport = await runTransportEvidence(transport, success, 'success');
    const failureTransport = await runTransportEvidence(transport, failure, 'failure');

    const beginVerification = {
      sessionId: success.sessionId,
      requestKey: id('begin-verification'),
      actorId: 'operator-test',
      command: { type: 'begin_verification' as const },
    };
    const verifying = await sessions.transitionCoordinationSession(beginVerification);
    assert.equal(verifying.state, 'verifying');
    assert.deepEqual(
      await sessions.transitionCoordinationSession(beginVerification),
      verifying,
    );
    await assert.rejects(
      sessions.transitionCoordinationSession({
        ...beginVerification,
        command: { type: 'fail', reason: 'changed-payload', classification: 'terminal_failure' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'SESSION_REQUEST_REPLAY_CONFLICT',
    );

    const evidence = [{
      type: 'result',
      reference: successTransport.storedResult.resultId,
      digest: successTransport.storedResult.resultDigest,
    }];
    const completionInput = {
      sessionId: success.sessionId,
      actorId: 'operator-test',
      evidence,
    };
    const completionKeys = [id('completion-a'), id('completion-b')];
    const completions = await Promise.allSettled([
      cleanup.acceptCoordinationCompletion({
        ...completionInput,
        requestKey: completionKeys[0],
      }),
      cleanup.acceptCoordinationCompletion({
        ...completionInput,
        requestKey: completionKeys[1],
      }),
    ]);
    assert.equal(completions.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(completions.filter((entry) => entry.status === 'rejected').length, 1);
    const winningIndex = completions.findIndex((entry) => entry.status === 'fulfilled');
    const accepted = completions.find(
      (entry): entry is PromiseFulfilledResult<any> => entry.status === 'fulfilled',
    )!.value;
    const winningRequestKey = completionKeys[winningIndex];
    assert.equal(accepted.session.state, 'succeeded');
    assert.equal(accepted.session.terminalReason, 'completion_accepted');
    assert.equal(accepted.obligations.length, 4);
    assert.ok(accepted.obligations.every((obligation: any) =>
      obligation.terminalOutcome === 'succeeded'
      && obligation.terminalReason === 'completion_accepted'));
    assert.deepEqual(
      await cleanup.acceptCoordinationCompletion({
        ...completionInput,
        requestKey: winningRequestKey,
      }),
      accepted,
    );
    await assert.rejects(
      cleanup.acceptCoordinationCompletion({
        ...completionInput,
        requestKey: winningRequestKey,
        evidence: [{ ...evidence[0], reference: 'changed-evidence-reference' }],
      }),
      (error: unknown) => (error as { code?: string }).code === 'CLEANUP_REPLAY_CONFLICT',
    );

    const successBeforeRepair = await canonicalEvidence(client, success, 'completion_accepted');
    const successResultBeforeRepair = await client.query(
      `SELECT r.result_digest, r.result, a.state AS attempt_state,
              s.state, s.terminal_reason, s.terminal_at
         FROM coordination_v2_transport_work_results r
         JOIN coordination_v2_attempts a ON a.id=r.attempt_id
         JOIN coordination_v2_sessions s ON s.id=r.session_id
        WHERE r.session_id=$1`,
      [success.sessionId],
    );
    const releaseObligation = accepted.obligations.find((row: any) => row.kind === 'release_lease');
    assert.ok(releaseObligation);
    const ackInput = {
      sessionId: success.sessionId,
      enrolledHostId: success.hostId,
      actorId: 'operator-test',
      holderInstanceId: 'evidence-holder-success',
      leaseId: successTransport.lease.id,
      epoch: successTransport.lease.epoch,
      obligationId: releaseObligation.id,
      requestKey: id('cleanup-ack'),
      evidence: { released: true, resultId: successTransport.storedResult.resultId },
    };
    const acknowledgement = await transport.acknowledgeCoordinationCleanup(ackInput);
    assert.deepEqual(await transport.acknowledgeCoordinationCleanup(ackInput), acknowledgement);
    await assert.rejects(
      transport.acknowledgeCoordinationCleanup({
        ...ackInput,
        evidence: { released: false },
      }),
      (error: unknown) => (error as { code?: string }).code === 'LEASE_REPLAY_CONFLICT',
    );

    const successRepairObligation = accepted.obligations.find((row: any) => row.kind === 'cleanup_generation');
    assert.ok(successRepairObligation);
    const repairInput = {
      obligationId: successRepairObligation.id,
      actorId: 'operator-test',
      requestKey: id('success-cleanup-failure'),
      command: { type: 'failed' as const, code: 'cleanup_generation_unavailable' },
    };
    const repairRequired = await cleanup.transitionCoordinationCleanup(repairInput);
    assert.equal(repairRequired.state, 'repair_required');
    assert.deepEqual(await cleanup.transitionCoordinationCleanup(repairInput), repairRequired);
    await cleanup.transitionCoordinationCleanup({
      ...repairInput,
      requestKey: id('success-cleanup-retry'),
      command: { type: 'retry' },
    });
    const repaired = await cleanup.transitionCoordinationCleanup({
      ...repairInput,
      requestKey: id('success-cleanup-repair'),
      command: { type: 'start' },
    });
    assert.equal(repaired.state, 'in_progress');
    const successAfterRepair = await canonicalEvidence(client, success, 'completion_accepted');
    const successResultAfterRepair = await client.query(
      `SELECT r.result_digest, r.result, a.state AS attempt_state,
              s.state, s.terminal_reason, s.terminal_at
         FROM coordination_v2_transport_work_results r
         JOIN coordination_v2_attempts a ON a.id=r.attempt_id
         JOIN coordination_v2_sessions s ON s.id=r.session_id
        WHERE r.session_id=$1`,
      [success.sessionId],
    );
    assert.deepEqual(successAfterRepair.session, successBeforeRepair.session);
    assert.deepEqual(successAfterRepair.terminal_evidence, successBeforeRepair.terminal_evidence);
    assert.deepEqual(successResultAfterRepair.rows, successResultBeforeRepair.rows);

    const failureInput = {
      sessionId: failure.sessionId,
      requestKey: id('terminal-failure'),
      actorId: 'operator-test',
      command: { type: 'fail', reason: 'provider_failed', classification: 'terminal_failure' },
    } as const;
    const failed = await sessions.transitionCoordinationSession(failureInput);
    assert.deepEqual(await sessions.transitionCoordinationSession(failureInput), failed);
    await assert.rejects(
      sessions.transitionCoordinationSession({
        ...failureInput,
        command: { type: 'fail', reason: 'changed-failure', classification: 'terminal_failure' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'SESSION_REQUEST_REPLAY_CONFLICT',
    );
    assert.equal(failed.state, 'failed');
    assert.equal(failed.terminalReason, 'provider_failed');
    const failedBeforeRepair = await canonicalEvidence(client, failure);
    const failedResultBeforeRepair = await client.query(
      `SELECT r.result_digest, r.result, a.state AS attempt_state,
              s.state, s.terminal_reason, s.terminal_at
         FROM coordination_v2_transport_work_results r
         JOIN coordination_v2_attempts a ON a.id=r.attempt_id
         JOIN coordination_v2_sessions s ON s.id=r.session_id
        WHERE r.session_id=$1`,
      [failure.sessionId],
    );
    const failedRepairObligation = (await client.query(
      `SELECT id FROM coordination_v2_cleanup_obligations
        WHERE session_id=$1 AND kind='revoke_credentials'`,
      [failure.sessionId],
    )).rows[0];
    assert.ok(failedRepairObligation);
    await cleanup.transitionCoordinationCleanup({
      obligationId: failedRepairObligation.id,
      requestKey: id('failure-cleanup-failure'),
      actorId: 'operator-test',
      command: { type: 'failed', code: 'credential_cleanup_unavailable' },
    });
    await cleanup.transitionCoordinationCleanup({
      obligationId: failedRepairObligation.id,
      requestKey: id('failure-cleanup-retry'),
      actorId: 'operator-test',
      command: { type: 'retry' },
    });
    await cleanup.transitionCoordinationCleanup({
      obligationId: failedRepairObligation.id,
      requestKey: id('failure-cleanup-repair'),
      actorId: 'operator-test',
      command: { type: 'start' },
    });
    const failedAfterRepair = await canonicalEvidence(client, failure);
    const failedResultAfterRepair = await client.query(
      `SELECT r.result_digest, r.result, a.state AS attempt_state,
              s.state, s.terminal_reason, s.terminal_at
         FROM coordination_v2_transport_work_results r
         JOIN coordination_v2_attempts a ON a.id=r.attempt_id
         JOIN coordination_v2_sessions s ON s.id=r.session_id
        WHERE r.session_id=$1`,
      [failure.sessionId],
    );
    assert.deepEqual(failedAfterRepair.session, failedBeforeRepair.session);
    assert.deepEqual(failedAfterRepair.terminal_evidence, failedBeforeRepair.terminal_evidence);
    assert.deepEqual(failedResultAfterRepair.rows, failedResultBeforeRepair.rows);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    // V2 authority/evidence rows are immutable. The disposable branch/job
    // retains these unique fixtures until it is destroyed.
    await client.end();
    await (await import("../db")).closeDbConnections();
    if (previousNeonUrl === undefined) delete process.env.NEON_SHARED_DATABASE_URL;
    else process.env.NEON_SHARED_DATABASE_URL = previousNeonUrl;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousCiUrl === undefined) delete process.env.CI_DATABASE_URL;
    else process.env.CI_DATABASE_URL = previousCiUrl;
  }
});