import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { getVerifiedCiDatabaseUrl } from '../ci-database';
import {
  CoordinationProviderRegistry,
  selectNextProvider,
} from '../services/coordination-provider-adapters/registry';
import type {
  ProviderAdapterDescriptor,
  ProviderAttemptRecord,
  ProviderSelectionPolicy,
} from '../services/coordination-provider-adapters/types';
import { mapProviderFailure } from '../services/coordination-provider-failure';
import { createFreshAttempt, transitionCoordinationAttempt, resumeSameCoordinationAttempt } from '../services/coordination-attempt-service';
import {
  applyCoordinationProviderFailure,
  type ResolvedProviderFailureAuthority,
} from '../services/coordination-lifecycle-facade-service';

const limits = {
  maxRequestBytes: 16_384,
  maxResponseBytes: 16_384,
  maxIntents: 8,
  maxArgumentBytes: 4_096,
  maxInputTokens: 4_096,
  maxOutputTokens: 4_096,
};

const alpha: ProviderAdapterDescriptor = {
  provider: 'alpha',
  model: 'alpha-model',
  adapterVersion: 'fake-1',
  supportedOperations: ['generate'],
  limits,
};
const beta: ProviderAdapterDescriptor = {
  provider: 'beta',
  model: 'beta-model',
  adapterVersion: 'fake-1',
  supportedOperations: ['generate'],
  limits,
};

const registry = new CoordinationProviderRegistry()
  .register(alpha)
  .register(beta);

const policy: ProviderSelectionPolicy = {
  providerOrder: ['alpha', 'beta'],
  totalAttemptBudget: 4,
  providerAttemptBudgets: { alpha: 2, beta: 2 },
  fallbackEligibleFailureClasses: ['malformed_response'],
};

type ScriptedOutcome =
  | 'transport_interrupted'
  | 'provider_outage'
  | 'malformed_response'
  | 'safety_blocked';

/**
 * This fake is deliberately boring: it records only the provider-neutral
 * continuation identity. Provider choice remains the production registry and
 * selector, rather than a fake's private routing table.
 */
class ScriptedTwoProviderFake {
  readonly continuations = new Set<string>();
  readonly calls: Array<{ provider: string; attemptId: string; outcome: ScriptedOutcome }> = [];

  respond(provider: ProviderAdapterDescriptor, attemptId: string, outcome: ScriptedOutcome): void {
    this.calls.push({ provider: provider.provider, attemptId, outcome });
  }

  continue(attemptId: string): void {
    assert.equal(this.continuations.has(attemptId), false, 'confirmed provider continuation must not repeat');
    this.continuations.add(attemptId);
  }
}

function record(
  attemptId: string,
  provider: string,
  ordinal: number,
  classification?: string,
  terminalReason?: string,
): ProviderAttemptRecord {
  const descriptor = provider === alpha.provider ? alpha : beta;
  return {
    attemptId,
    provider,
    model: descriptor.model,
    adapterVersion: descriptor.adapterVersion,
    ordinal,
    classification,
    terminalReason,
  };
}

test('scripted two-provider fallback proves transport resume, retry, order, budgets, and authority', () => {
  const fake = new ScriptedTwoProviderFake();
  const attempts: ProviderAttemptRecord[] = [];
  const generations = new Set<string>();

  const initial = selectNextProvider(attempts, policy, registry);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.equal(initial.descriptor.provider, 'alpha');
  assert.equal(initial.provenance.reason, 'initial');
  assert.deepEqual(initial.provenance.consideredProviders, ['alpha', 'beta']);
  attempts.push(record('attempt-alpha-1', initial.descriptor.provider, 1));
  generations.add(createHash('sha256').update('attempt-alpha-1').digest('hex'));
  fake.respond(alpha, 'attempt-alpha-1', 'transport_interrupted');

  const transport = mapProviderFailure({
    provider: alpha.provider,
    model: alpha.model,
    adapterVersion: alpha.adapterVersion,
    failure: { kind: 'transport_interrupted' },
  }, policy);
  assert.deepEqual(transport, {
    classification: 'resume_transport',
    reason: 'resume_transport',
    fallbackEligible: false,
  });
  fake.continue('attempt-alpha-1');
  assert.deepEqual([...fake.continuations], ['attempt-alpha-1']);
  // A transport interruption resumes the same authority; selection is not
  // consulted and therefore cannot accidentally advance to beta.
  assert.equal(attempts.length, 1);

  fake.respond(alpha, 'attempt-alpha-1', 'provider_outage');
  const logical = mapProviderFailure({
    provider: alpha.provider,
    model: alpha.model,
    adapterVersion: alpha.adapterVersion,
    failure: { kind: 'provider_outage' },
  }, policy);
  assert.equal(logical.classification, 'fresh_attempt_same_provider');
  const sameProvider = selectNextProvider([
    record('attempt-alpha-1', 'alpha', 1, 'fresh_attempt_same_provider'),
  ], policy, registry);
  assert.equal(sameProvider.ok, true);
  if (!sameProvider.ok) return;
  assert.equal(sameProvider.descriptor.provider, 'alpha');
  assert.equal(sameProvider.provenance.previousAttemptId, 'attempt-alpha-1');
  const alphaRetryGeneration = createHash('sha256')
    .update('retry:attempt-alpha-1:alpha')
    .digest('hex');
  generations.add(alphaRetryGeneration);
  assert.equal(generations.size, 2, 'logical retry has fresh attempt authority');

  const fallback = mapProviderFailure({
    provider: alpha.provider,
    model: alpha.model,
    adapterVersion: alpha.adapterVersion,
    failure: { kind: 'malformed_response' },
  }, policy);
  assert.equal(fallback.classification, 'fresh_attempt_next_provider');
  const nextProvider = selectNextProvider([
    record('attempt-alpha-1', 'alpha', 1),
    record('attempt-alpha-2', 'alpha', 2, 'terminal_failure', 'malformed_response'),
  ], policy, registry);
  assert.equal(nextProvider.ok, true);
  if (!nextProvider.ok) return;
  assert.equal(nextProvider.descriptor.provider, 'beta');
  assert.equal(nextProvider.provenance.selectedProviderOrderIndex, 1);
  assert.deepEqual(nextProvider.provenance.priorAttemptIds, ['attempt-alpha-1', 'attempt-alpha-2']);
  assert.equal(nextProvider.provenance.previousProvider, 'alpha');
  assert.equal(nextProvider.provenance.previousClassification, 'terminal_failure');
  const betaGeneration = createHash('sha256').update('retry:attempt-alpha-2:beta').digest('hex');
  assert.equal(generations.has(betaGeneration), false);
  generations.add(betaGeneration);
  assert.equal(generations.size, 3);

  const policyBudgetExhausted = selectNextProvider([
    record('a1', 'alpha', 1),
    record('a2', 'alpha', 2, 'fresh_attempt_same_provider'),
  ], policy, registry);
  assert.deepEqual(policyBudgetExhausted, { ok: false, reason: 'provider_budget_exhausted' });
  const totalBudgetExhausted = selectNextProvider([
    record('a1', 'alpha', 1),
    record('a2', 'alpha', 2, 'terminal_failure', 'malformed_response'),
    record('b1', 'beta', 3, 'terminal_failure', 'malformed_response'),
    record('b2', 'beta', 4, 'terminal_failure', 'malformed_response'),
  ], policy, registry);
  assert.deepEqual(totalBudgetExhausted, { ok: false, reason: 'attempt_budget_exhausted' });

  fake.respond(beta, 'attempt-beta-1', 'safety_blocked');
  const terminal = mapProviderFailure({
    provider: beta.provider,
    model: beta.model,
    adapterVersion: beta.adapterVersion,
    failure: { kind: 'safety_blocked' },
  }, policy);
  assert.equal(terminal.classification, 'terminal_failure');
  assert.equal(terminal.fallbackEligible, false);
  const exhaustedAfterConfirmedBeta = selectNextProvider([
    record('a1', 'alpha', 1),
    record('a2', 'alpha', 2, 'terminal_failure', 'malformed_response'),
    record('b1', 'beta', 3, 'terminal_failure', 'safety_blocked'),
  ], policy, registry);
  assert.deepEqual(exhaustedAfterConfirmedBeta, { ok: false, reason: 'provider_fallback_not_allowed' });
  assert.throws(() => fake.continue('attempt-alpha-1'), /must not repeat/);
  assert.deepEqual(fake.calls.map((call) => call.provider), ['alpha', 'alpha', 'beta']);
});

function disposableTarget(): string | undefined {
  const ciUrl = getVerifiedCiDatabaseUrl();
  if (ciUrl) return ciUrl;
  const url = process.env.COORDINATION_RUNTIME_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.COORDINATION_RUNTIME_REQUIRE_DATABASE_TESTS === '1') {
      throw new Error('COORDINATION_RUNTIME_TEST_DATABASE_URL is required by the migration gate');
    }
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('COORDINATION_RUNTIME_TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const forbiddenSharedUrl = process.env.COORDINATION_RUNTIME_FORBIDDEN_SHARED_URL;
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || process.env.COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE !== '1'
    || process.env.NEON_SHARED_DATABASE_URL !== url
    || !forbiddenSharedUrl
    || forbiddenSharedUrl === url
  ) {
    throw new Error('provider fallback mutation test refuses a shared/unverified database');
  }
  return url;
}

test('verified disposable PostgreSQL runs real attempt services across both providers', async (context) => {
  const databaseUrl = disposableTarget();
  if (!databaseUrl) {
    context.skip('requires a verified disposable PostgreSQL URL');
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = `${Date.now()}-${randomUUID()}`;
  const id = (kind: string) => `provider-fallback-${kind}-${suffix}`;
  const digest = (kind: string) => createHash('sha256').update(`${suffix}:${kind}`).digest('hex');
  const hostId = id('host');
  const identityId = id('identity');
  const versionId = id('version');
  const grantId = id('grant');
  const sessionId = id('session');
  const actorId = 'provider-fallback-operator';
  const attemptIds: string[] = [];

  const realServices = {
    transitionCoordinationAttempt,
    resumeSameCoordinationAttempt,
    createFreshAttempt: (input: Parameters<typeof createFreshAttempt>[0]) =>
      createFreshAttempt(input, { providerRegistry: registry }),
    transitionCoordinationSession: (input: Parameters<typeof import('../services/coordination-session-service')['transitionCoordinationSession']>[0]) =>
      import('../services/coordination-session-service').then(({ transitionCoordinationSession }) =>
        transitionCoordinationSession(input)),
  };

  const authority = (attemptId: string, currentProvider: ProviderAdapterDescriptor, nextProvider?: ProviderAdapterDescriptor): ResolvedProviderFailureAuthority => ({
    sessionId,
    attemptId,
    policy,
    currentProvider,
    nextProvider,
  });

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO coordination_v2_host_enrollments
       (id,host_key,host_type,display_name,protocol_version,public_key,key_fingerprint,
         capabilities,enrollment_digest,enrollment_request_key,status,created_by)
        VALUES ($1,$2,'test','Provider fallback host',1,'test-key',$3,ARRAY['poll'],$4,$5,'active','provider-fallback')`,
       [hostId, id('host-key'), digest('host-fingerprint'), digest('host-enrollment'), id('enrollment-request')],
    );
    await client.query(
      `INSERT INTO coordination_v2_policy_identities
       (id,policy_key,display_name,status,created_by)
       VALUES ($1,$2,'Provider fallback policy','active','provider-fallback')`,
      [identityId, id('policy-key')],
    );
    await client.query(
      `INSERT INTO coordination_v2_policy_versions
       (id,policy_identity_id,version,canonical_policy,policy_digest,approval_state,
        created_by,approved_by,approved_at)
       VALUES ($1,$2,1,$3::jsonb,$4,'approved','provider-fallback','founder',now())`,
      [versionId, identityId, JSON.stringify(policy), digest('policy')],
    );
    await client.query(
      `INSERT INTO coordination_v2_operator_grants
       (id,policy_identity_id,operator_actor,actions,issued_by,expires_at,grant_digest,request_key)
       VALUES ($1,$2,$3,ARRAY['launch','resume','terminate'],'founder',
               now()+interval '1 hour',$4,$5)`,
      [grantId, identityId, actorId, digest('grant'), id('grant-key')],
    );
    await client.query(
      `INSERT INTO coordination_v2_sessions
       (id,policy_version_id,operator_grant_id,operator_actor,task_ref,task_artifact_sha256,
        repository_identity,starting_commit,enrolled_host_id,requested_providers,expires_at,
        attempt_budget,per_provider_budgets,required_validations,completion_criteria,state,
        idempotency_key,session_digest)
       VALUES ($1,$2,$3,$4,'1',$5,'repo/provider-fallback',$6,$7,ARRAY['alpha','beta'],
               now()+interval '1 hour',4,$8::jsonb,ARRAY[]::text[],'{}'::jsonb,'ready',$9,$10)`,
      [
        sessionId, versionId, grantId, actorId, digest('artifact'), 'a'.repeat(40), hostId,
        JSON.stringify(policy.providerAttemptBudgets), id('session-key'), digest('session'),
      ],
    );
    await client.query('COMMIT');

    const first = await realServices.createFreshAttempt({
      sessionId, requestKey: id('attempt-1'), actorId,
      provider: alpha.provider, model: alpha.model, adapterVersion: alpha.adapterVersion,
      attemptGeneration: digest('generation-alpha-1'),
    });
    attemptIds.push(first.id);
    assert.equal(first.created, true);
    await realServices.transitionCoordinationAttempt({
      attemptId: first.id, requestKey: id('provider-started-1'), actorId,
      command: { type: 'provider_started' },
    });
    await realServices.transitionCoordinationAttempt({
      attemptId: first.id, requestKey: id('intent-ready-1'), actorId,
      command: { type: 'intent_ready' },
    });
    await realServices.transitionCoordinationAttempt({
      attemptId: first.id, requestKey: id('host-wait-1'), actorId,
      command: { type: 'host_wait' },
    });

    const transportDecision = mapProviderFailure({
      provider: alpha.provider, model: alpha.model, adapterVersion: alpha.adapterVersion,
      failure: { kind: 'transport_interrupted' },
    }, policy);
    assert.equal(transportDecision.classification, 'resume_transport');
    const resumed = await resumeSameCoordinationAttempt({
      attemptId: first.id, requestKey: id('transport-resume'), actorId,
    });
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.state, 'waiting_for_host');

    const sameProviderDecision = mapProviderFailure({
      provider: alpha.provider, model: alpha.model, adapterVersion: alpha.adapterVersion,
      failure: { kind: 'provider_outage' },
    }, policy);
    assert.equal(sameProviderDecision.classification, 'fresh_attempt_same_provider');
    await transitionCoordinationAttempt({
      attemptId: first.id, requestKey: id('fail-alpha'), actorId,
      command: { type: 'fail', classification: 'fresh_attempt_same_provider' },
    });
    const second = await realServices.createFreshAttempt({
      sessionId, requestKey: id('attempt-2'), actorId,
      provider: alpha.provider, model: alpha.model, adapterVersion: alpha.adapterVersion,
      previousAttemptId: first.id, classification: 'fresh_attempt_same_provider',
      attemptGeneration: digest('generation-alpha-2'),
    });
    attemptIds.push(second.id);
    assert.equal(second.created, true);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.attemptGeneration, first.attemptGeneration);

    const fallbackDecision = mapProviderFailure({
      provider: alpha.provider, model: alpha.model, adapterVersion: alpha.adapterVersion,
      failure: { kind: 'malformed_response' },
    }, policy);
    assert.equal(fallbackDecision.classification, 'fresh_attempt_next_provider');
    await applyCoordinationProviderFailure(
      {
        failure: { kind: 'malformed_response' },
        sessionId, attemptId: second.id, actorId, requestKey: id('fallback-alpha-beta'),
      },
      {
        resolveProviderFailureAuthority: async () => authority(second.id, alpha, beta),
        services: realServices as any,
      },
    );
    const rows = await client.query(
      `SELECT id,attempt_generation,provider,state,previous_attempt_id,failure_classification
       FROM coordination_v2_attempts WHERE session_id=$1 ORDER BY session_ordinal`,
      [sessionId],
    );
    assert.equal(rows.rows.length, 3);
    assert.deepEqual(rows.rows.map((row) => row.provider), ['alpha', 'alpha', 'beta']);
    assert.deepEqual(rows.rows.map((row) => row.state), ['retryable_failed', 'retryable_failed', 'created']);
    assert.equal(rows.rows[2].previous_attempt_id, second.id);
    assert.equal(rows.rows[1].failure_classification, 'fresh_attempt_next_provider');
    assert.equal(new Set(rows.rows.map((row) => row.attempt_generation)).size, 3);
    assert.equal(rows.rows[0].id, first.id);
    assert.equal(rows.rows[1].id, second.id);
    assert.notEqual(rows.rows[2].id, second.id);

    await applyCoordinationProviderFailure(
      {
        failure: { kind: 'safety_blocked' },
        sessionId, attemptId: rows.rows[2].id, actorId, requestKey: id('terminal-beta'),
      },
      {
        resolveProviderFailureAuthority: async () => authority(rows.rows[2].id, beta),
        services: realServices as any,
      },
    );
    const terminalRows = await client.query(
      `SELECT s.state AS session_state, a.state AS attempt_state, a.failure_classification
       FROM coordination_v2_sessions s
       JOIN coordination_v2_attempts a ON a.session_id=s.id
       WHERE s.id=$1 ORDER BY a.session_ordinal`,
      [sessionId],
    );
    assert.equal(terminalRows.rows[0].session_state, 'failed');
    assert.equal(terminalRows.rows[2].attempt_state, 'terminal_failed');
    assert.equal(terminalRows.rows[2].failure_classification, 'terminal_failure');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    // V2 authority/evidence rows are immutable. This verified disposable
    // database owns the unique fixture until its enclosing branch/job ends.
    await client.end();
    await (await import("../db")).closeDbConnections();
  }
});