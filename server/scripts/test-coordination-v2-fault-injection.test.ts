import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { canonicalizeAndHashPolicy } from "../services/coordination-policy-canonicalization";
import {
  createAttemptState,
  createCleanupState,
  createSessionState,
  type AttemptState,
  type CleanupState,
  type SessionState,
  type TransitionResult,
} from "../services/coordination-v2-types";
import { transitionAttempt } from "../services/coordination-attempt-state";
import { transitionCleanup } from "../services/coordination-cleanup-state";
import { transitionSession } from "../services/coordination-session-state";
import {
  createHostEnvelope,
  type HostBinding,
  type HostEnvelope,
} from "../services/coordination-host-protocol";
import { digestCanonical } from "../services/coordination-runtime";
import {
  runCoordinationWindowsHost,
  type CoordinationWindowsExecutionJournal,
  type CoordinationWindowsLifecycleTransport,
} from "./coordination-windows-host";
import { CoordinationHostFake } from "./coordination-host-fake";
import {
  computeCoordinationPublicMaterialDigest,
  prepareCoordinationWindowsGeneration,
  type LocalPreparationStorage,
} from "./coordination-windows-prepare";

/**
 * This suite intentionally uses only disposable in-process stores.  The
 * mutation seams under test are the injected filesystem, host, journal, and
 * transport effects; no PostgreSQL connection is opened here (and therefore
 * a shared Neon database can never be mutated by this test).
 */

type Boundary =
  | "before:session_reservation"
  | "after:session_reservation"
  | "before:local_promotion"
  | "after:local_promotion"
  | "before:attempt_creation"
  | "after:attempt_creation"
  | "before:provider_response_persistence"
  | "after:provider_response_persistence"
  | "before:host_claim"
  | "after:host_claim"
  | "before:host_mutation"
  | "after:host_mutation"
  | "before:result_persistence"
  | "after:result_persistence"
  | "before:provider_continuation"
  | "after:provider_continuation"
  | "before:completion_acceptance"
  | "after:completion_acceptance"
  | "during:server_revocation"
  | "during:local_cleanup";

type RecoveryClassification =
  | "same-attempt transport resume"
  | "fresh same-provider attempt"
  | "fresh next-provider attempt"
  | "terminal failure"
  | "terminal success"
  | "cleanup repair";

const allowedClassifications = new Set<RecoveryClassification>([
  "same-attempt transport resume",
  "fresh same-provider attempt",
  "fresh next-provider attempt",
  "terminal failure",
  "terminal success",
  "cleanup repair",
]);

const interruptionCases: ReadonlyArray<{
  readonly name: string;
  readonly boundary: Boundary;
  readonly classification: RecoveryClassification;
}> = [
  ["before session reservation", "before:session_reservation", "same-attempt transport resume"],
  ["after session reservation", "after:session_reservation", "same-attempt transport resume"],
  ["before local promotion", "before:local_promotion", "same-attempt transport resume"],
  ["after local promotion", "after:local_promotion", "same-attempt transport resume"],
  ["before attempt creation", "before:attempt_creation", "same-attempt transport resume"],
  ["after attempt creation", "after:attempt_creation", "same-attempt transport resume"],
  ["before provider response persistence", "before:provider_response_persistence", "same-attempt transport resume"],
  ["after provider response persistence", "after:provider_response_persistence", "same-attempt transport resume"],
  ["before host claim", "before:host_claim", "same-attempt transport resume"],
  ["after host claim", "after:host_claim", "same-attempt transport resume"],
  ["before host mutation", "before:host_mutation", "same-attempt transport resume"],
  ["after host mutation", "after:host_mutation", "same-attempt transport resume"],
  ["before result persistence", "before:result_persistence", "same-attempt transport resume"],
  ["after result persistence", "after:result_persistence", "same-attempt transport resume"],
  ["before provider continuation", "before:provider_continuation", "same-attempt transport resume"],
  ["after provider continuation", "after:provider_continuation", "same-attempt transport resume"],
  ["before completion acceptance", "before:completion_acceptance", "terminal success"],
  ["after completion acceptance", "after:completion_acceptance", "terminal success"],
  ["during server revocation", "during:server_revocation", "terminal failure"],
  ["during local cleanup", "during:local_cleanup", "cleanup repair"],
].map(([name, boundary, classification]) => ({ name, boundary, classification }));

class InjectedInterruption extends Error {
  constructor(readonly boundary: Boundary) {
    super(`injected:${boundary}`);
  }
}

/**
 * A fail-once controller is deliberately attached to effect seams rather than
 * to reducers.  A durable write is made before an "after" fault is thrown,
 * which models a lost acknowledgement without allowing a retry to repeat the
 * mutation.
 */
class FailOnceFaultController {
  private tripped = false;
  private observedBoundary?: Boundary;

  constructor(private readonly target: Boundary) {}

  before(boundary: Boundary): void {
    if (!this.tripped && boundary === this.target) {
      this.tripped = true;
      this.observedBoundary = boundary;
      throw new InjectedInterruption(boundary);
    }
  }

  after(boundary: Boundary): void {
    if (!this.tripped && boundary === this.target) {
      this.tripped = true;
      this.observedBoundary = boundary;
      throw new InjectedInterruption(boundary);
    }
  }

  assertTripped(): void {
    assert.equal(this.tripped, true, `fault seam was not reached: ${this.target}`);
  }

  observed(): Boundary {
    assert.ok(this.observedBoundary, "recovery classification has no observed fault");
    return this.observedBoundary;
  }
}

function classifyRecoveredLocalState(
  state: DurableCoordinatorState,
  faults: FailOnceFaultController,
): RecoveryClassification {
  const boundary = faults.observed();
  if (state.session.state === "revoked") return "terminal failure";
  if (boundary === "during:local_cleanup" && state.cleanup?.status === "acknowledged") {
    return "cleanup repair";
  }
  if (boundary.endsWith("completion_acceptance")
    && state.session.state === "succeeded"
    && state.attempt?.state === "completed") {
    return "terminal success";
  }
  if (state.attempt?.ordinal === 1 && state.attempt.providerOrdinal === 1) {
    return "same-attempt transport resume";
  }
  throw new Error("unclassified_coordinator_v2_recovery");
}

type DurableEffectStore = Map<string, unknown>;

type DurableCoordinatorState = {
  effects: DurableEffectStore;
  session: SessionState;
  attempt?: AttemptState;
  cleanup?: CleanupState;
  localPrepared: boolean;
  hostStarted: Set<string>;
  hostResults: Map<string, HostEnvelope<"structured_result">>;
  hostMutations: number;
  providerContinuations: number;
  sessionReservations: number;
  localPromotions: number;
  attemptCreations: number;
  providerResponses: number;
  hostClaims: number;
  resultPersistences: number;
  completionAcceptances: number;
  revocations: number;
  cleanups: number;
};

function stateResult<State>(value: TransitionResult<State>): State {
  if (!value.ok) throw new Error(`unexpected reducer rejection: ${value.code}`);
  return value.state;
}

function commandIds(key: string): { requestId: string; eventId: string } {
  return { requestId: `fault:${key}`, eventId: `event:${key}` };
}

function createDurableState(): DurableCoordinatorState {
  return {
    effects: new Map(),
    session: createSessionState({
      sessionId: "fault-session",
      policyVersionId: "fault-policy",
      providerOrder: ["provider-a", "provider-b"],
      totalAttemptBudget: 3,
      providerAttemptBudgets: { "provider-a": 2, "provider-b": 1 },
      expiresAt: 100_000,
    }),
    localPrepared: false,
    hostStarted: new Set(),
    hostResults: new Map(),
    hostMutations: 0,
    providerContinuations: 0,
    sessionReservations: 0,
    localPromotions: 0,
    attemptCreations: 0,
    providerResponses: 0,
    hostClaims: 0,
    resultPersistences: 0,
    completionAcceptances: 0,
    revocations: 0,
    cleanups: 0,
  };
}

async function durableEffect<T>(
  state: DurableCoordinatorState,
  faults: FailOnceFaultController,
  key: string,
  boundary: Boundary | undefined,
  operation: () => Promise<T> | T,
): Promise<T> {
  const prior = state.effects.get(key);
  if (prior !== undefined) return prior as T;
  if (boundary?.startsWith("before:")) faults.before(boundary);
  const value = await operation();
  state.effects.set(key, value);
  if (boundary?.startsWith("after:")) faults.after(boundary);
  return value;
}

function storage(): LocalPreparationStorage {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>(["C:"]);
  const descendants = (path: string) => [...directories].filter((item) => item.startsWith(`${path}/`));
  return {
    inspect: (path) => ({
      exists: directories.has(path) || files.has(path),
      isDirectory: directories.has(path),
      reparseFree: true,
      aclSafe: true,
    }),
    mkdir: (path) => { directories.add(path); },
    write: (path, bytes) => { files.set(path, bytes.slice()); },
    read: (path) => files.get(path)?.slice() ?? new Uint8Array(),
    atomicReplace: (from, to) => {
      const value = files.get(from);
      if (!value) throw new Error("missing_active_temp");
      files.delete(from);
      files.set(to, value);
    },
    rename: (from, to) => {
      if (directories.has(from)) {
        directories.delete(from);
        directories.add(to);
      }
      for (const directory of descendants(from)) {
        directories.delete(directory);
        directories.add(`${to}${directory.slice(from.length)}`);
      }
      for (const [path, value] of [...files]) {
        if (path.startsWith(`${from}/`)) {
          files.delete(path);
          files.set(`${to}${path.slice(from.length)}`, value);
        }
      }
    },
    remove: (path) => {
      directories.delete(path);
      for (const directory of descendants(path)) directories.delete(directory);
      files.delete(path);
      for (const file of [...files.keys()]) {
        if (file.startsWith(`${path}/`)) files.delete(file);
      }
    },
  };
}

async function prepareLocalGeneration(
  state: DurableCoordinatorState,
  faults: FailOnceFaultController,
  localStorage: LocalPreparationStorage,
): Promise<void> {
  if (state.localPrepared) return;
  const artifacts = { "public.json": new TextEncoder().encode('{"fault":true}') };
  const reservation = {
    id: "fault-reservation",
    sessionId: state.session.sessionId,
    enrolledHostId: "fault-host",
    generationId: "fault-generation",
    reservationDigest: "1".repeat(64),
    publicMaterialDigest: computeCoordinationPublicMaterialDigest(artifacts),
    protocolVersion: 1 as const,
  };
  let promoted = false;
  let acknowledged = false;
  const result = await prepareCoordinationWindowsGeneration({
    reservation,
    root: "C:",
    activePointer: "C:/active",
    publicArtifacts: artifacts,
    secretPlaintext: new Uint8Array([1, 2, 3]),
    dependencies: {
      storage: localStorage,
      protect: () => new Uint8Array([7, 7, 7]),
      fault: {
        beforeRename: (label) => {
          if (label === "generation") faults.before("before:local_promotion");
        },
        beforeAcknowledge: () => faults.before("after:local_promotion"),
      },
      server: {
        promote: async () => { state.localPromotions += 1; promoted = true; },
        acknowledge: async () => { acknowledged = true; },
        recover: async () => ({ state: acknowledged ? "acknowledged" : promoted ? "promoted" : "preparing" }),
      },
    },
    acknowledgementRequestKey: "fault-acknowledgement",
    safePromotionEvidenceDigest: "2".repeat(64),
  });
  if (result.state === "acknowledged") state.localPrepared = true;
}

const binding: HostBinding = {
  policyVersionId: "fault-policy",
  sessionId: "fault-session",
  attemptId: "fault-attempt",
  enrolledHostId: "fault-host",
  transportLeaseId: "fault-lease",
  leaseEpoch: 1,
  holderInstanceId: "fault-holder",
  operation: "fault-operation",
  operationDigest: digestCanonical({ operation: "fault-operation" }),
};

function operationClaim(): HostEnvelope<"operation_claim"> {
  return createHostEnvelope("operation_claim", { binding }, {
    requestId: "fault-claim",
    correlationId: "fault-session",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
  });
}

function transportLeaseState(): Record<string, unknown> {
  return {
    sessionId: "fault-session", reservationId: "fault-reservation", generationId: "fault-generation",
    policyVersionId: "fault-policy", attemptId: "fault-attempt", enrolledHostId: "fault-host",
    leaseId: "fault-lease", leaseEpoch: 1, holderInstanceId: "fault-holder",
    binding: { sessionId: "fault-session", reservationId: "fault-reservation", generationId: "fault-generation" },
    sessionToken: "fault-session-token", cleanupSessionToken: "fault-cleanup-token",
    cleanupCredentialId: "fault-cleanup-credential",
  };
}

function acknowledgedLifecycleState(): Record<string, string> {
  return {
    sessionId: "fault-session", reservationId: "fault-reservation", generationId: "fault-generation",
    policyVersionId: "fault-policy", attemptId: "fault-attempt", enrolledHostId: "fault-host",
  };
}

async function runHost(
  state: DurableCoordinatorState,
  faults: FailOnceFaultController,
): Promise<void> {
  const claim = operationClaim();
  const journal: CoordinationWindowsExecutionJournal = {
    begin: async (key) => {
      const completed = state.hostResults.get(key);
      if (completed) return { state: "completed", result: completed };
      if (state.hostStarted.has(key)) return { state: "started", fresh: false };
      faults.before("before:host_mutation");
      state.hostStarted.add(key);
      return { state: "started", fresh: true };
    },
    complete: async (key, result) => { state.hostResults.set(key, result); },
    reconcile: async ({ claim: operation }) => {
      const value = state.effects.get("host-mutation") as Record<string, unknown> | undefined;
      if (!value) return undefined;
      const operationBinding = (operation.payload as { binding: HostBinding }).binding;
      return createHostEnvelope("structured_result", {
        binding: operationBinding,
        result: value,
        resultDigest: digestCanonical(value),
      }, {
        requestId: `${operation.requestId}:result`,
        correlationId: operation.correlationId,
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });
    },
  };
  const transport: CoordinationWindowsLifecycleTransport = {
    start: async () => ({ state: acknowledgedLifecycleState(), alreadyAcknowledged: true }),
    acquireLease: async () => ({ state: transportLeaseState() }),
    poll: async ({ state: current }) => {
      return state.effects.has("result-persistence")
        ? { state: current, action: "renew" as const }
        : { state: current, action: "operation_available" as const, offer: { offerId: "fault-offer" } };
    },
    claim: async ({ state: current }) => {
      faults.before("before:host_claim");
      const value = await durableEffect(state, faults, "host-claim", "after:host_claim", async () => {
        state.hostClaims += 1;
        return claim;
      });
      return { state: current, claim: value };
    },
    result: async ({ state: current, result }) => {
      faults.before("before:result_persistence");
      await durableEffect(state, faults, "result-persistence", "after:result_persistence", async () => {
        state.resultPersistences += 1;
        state.attempt = stateResult(transitionAttempt(state.attempt!, {
          ...commandIds("result-persistence"),
          now: 20,
          type: "result_ready",
        }));
        return result;
      });
      return { state: current };
    },
    renew: async ({ state: current }) => {
      faults.before("before:provider_continuation");
      await durableEffect(state, faults, "provider-continuation", "after:provider_continuation", async () => {
        state.providerContinuations += 1;
        state.attempt = stateResult(transitionAttempt(state.attempt!, {
          ...commandIds("provider-continuation"),
          now: 21,
          type: "provider_continuation",
        }));
        return true;
      });
      faults.before("before:completion_acceptance");
      const completion = await durableEffect(state, faults, "completion-acceptance", "after:completion_acceptance", async () => {
        state.completionAcceptances += 1;
        const session = stateResult(transitionSession(state.session, {
          ...commandIds("begin-verification"),
          now: 22,
          type: "begin_verification",
        }));
        return {
          session: stateResult(transitionSession(session, {
            ...commandIds("completion-acceptance"),
            now: 23,
            type: "accept_completion",
            evidenceDigest: "evidence-fault",
          })),
          attempt: stateResult(transitionAttempt(state.attempt!, {
            ...commandIds("attempt-complete"),
            now: 23,
            type: "complete",
            resultCode: "ok",
          })),
        };
      });
      state.session = completion.session;
      state.attempt = completion.attempt;
      return { state: current, terminalState: "succeeded" };
    },
    cleanup: async ({ state: current }) => {
      faults.before("during:local_cleanup");
      const acknowledged = await durableEffect(state, faults, "local-cleanup", undefined, async () => {
        state.cleanups += 1;
        const initial = state.cleanup ?? createCleanupState({
          sessionId: state.session.sessionId,
          terminalOutcome: "succeeded",
          terminalReason: "evidence-fault",
          requestedAt: 24,
        });
        const started = stateResult(transitionCleanup(initial, {
          ...commandIds("cleanup-start"),
          now: 24,
          type: "start",
        }));
        state.cleanup = stateResult(transitionCleanup(started, {
          ...commandIds("cleanup-acknowledge"),
          now: 25,
          type: "acknowledge",
        }));
        return true;
      });
      return { state: current, acknowledged };
    },
    maxRetries: 1,
  };
  const host = new CoordinationHostFake({
    adapter: {
      execute: async () => durableEffect(state, faults, "host-mutation", "after:host_mutation", async () => {
        state.hostMutations += 1;
        state.attempt = stateResult(transitionAttempt(state.attempt!, {
          ...commandIds("host-started"),
          now: 19,
          type: "host_started",
        }));
        return { confirmed: true };
      }),
    },
    now: () => Date.parse("2026-01-01T00:01:00.000Z"),
  });
  await runCoordinationWindowsHost(
    { taskRef: "1" },
    {
      host,
      executionJournal: journal,
      preflight: async () => ({ accepted: true }),
      now: () => Date.parse("2026-01-01T00:01:00.000Z"),
      transport,
      maxPolls: 3,
    },
  );
}

async function runCoordinatorOnce(
  state: DurableCoordinatorState,
  faults: FailOnceFaultController,
  boundary: Boundary,
  localStorage: LocalPreparationStorage,
): Promise<void> {
  if (state.session.state === "succeeded" && state.cleanup?.status === "acknowledged") return;
  if (state.session.state === "revoked") return;
  if (state.session.state === "preparing") {
    faults.before("before:session_reservation");
    const session = await durableEffect(state, faults, "session-reservation", "after:session_reservation", async () => {
      state.sessionReservations += 1;
      return stateResult(transitionSession(state.session, {
        ...commandIds("session-reservation"),
        now: 1,
        type: "preparation_ready",
      }));
    });
    state.session = session;
  }
  await prepareLocalGeneration(state, faults, localStorage);
  if (!state.attempt) {
    faults.before("before:attempt_creation");
    const created = await durableEffect(state, faults, "attempt-creation", "after:attempt_creation", async () => {
      state.attemptCreations += 1;
      const session = stateResult(transitionSession(state.session, {
        ...commandIds("attempt-creation"),
        now: 2,
        type: "start_attempt",
        provider: "provider-a",
      }));
      return {
        session,
        attempt: createAttemptState({
          attemptId: "fault-attempt",
          sessionId: state.session.sessionId,
          provider: "provider-a",
          model: "fault-model",
          adapterVersion: "fault-adapter",
          ordinal: 1,
          providerOrdinal: 1,
          createdAt: 2,
          deadline: 90_000,
        }),
      };
    });
    state.session = created.session;
    state.attempt = created.attempt;
  }
  if (state.attempt.state === "created") {
    faults.before("before:provider_response_persistence");
    const response = await durableEffect(state, faults, "provider-response-persistence", "after:provider_response_persistence", async () => {
      state.providerResponses += 1;
      let attempt = stateResult(transitionAttempt(state.attempt!, {
        ...commandIds("provider-start"),
        now: 3,
        type: "provider_started",
      }));
      attempt = stateResult(transitionAttempt(attempt, {
        ...commandIds("intent-ready"),
        now: 4,
        type: "intent_ready",
      }));
      attempt = stateResult(transitionAttempt(attempt, {
        ...commandIds("host-wait"),
        now: 5,
        type: "host_wait",
      }));
      return attempt;
    });
    state.attempt = response;
  }
  if (boundary === "during:server_revocation") {
    faults.before("during:server_revocation");
    const revoked = await durableEffect(state, faults, "server-revocation", undefined, async () => {
      state.revocations += 1;
      return stateResult(transitionSession(state.session, {
        ...commandIds("server-revocation"),
        now: 6,
        type: "revoke",
        reason: "fault-injected-revocation",
      }));
    });
    state.session = revoked;
    return;
  }
  await runHost(state, faults);
}

test("table-driven Coordinator V2 interruptions recover exactly once from durable state", async () => {
  for (const interruption of interruptionCases) {
    const state = createDurableState();
    const faults = new FailOnceFaultController(interruption.boundary);
    const localStorage = storage();

    await runCoordinatorOnce(state, faults, interruption.boundary, localStorage).catch(() => undefined);
    await runCoordinatorOnce(state, faults, interruption.boundary, localStorage).catch(() => undefined);

    faults.assertTripped();
    assert.equal(state.sessionReservations, 1, interruption.name);
    assert.equal(state.localPromotions, 1, interruption.name);
    assert.equal(state.attemptCreations, 1, interruption.name);
    assert.equal(state.providerResponses, 1, interruption.name);
    assert.ok(state.hostClaims <= 1, interruption.name);
    assert.ok(state.hostMutations <= 1, interruption.name);
    assert.ok(state.resultPersistences <= 1, interruption.name);
    assert.ok(state.providerContinuations <= 1, interruption.name);
    assert.ok(state.completionAcceptances <= 1, interruption.name);
    assert.ok(state.revocations <= 1, interruption.name);
    assert.ok(state.cleanups <= 1, interruption.name);
    if (interruption.boundary === "during:server_revocation") {
      assert.equal(state.session.state, "revoked", interruption.name);
      assert.equal(state.hostMutations, 0, interruption.name);
    } else {
      assert.equal(state.session.state, "succeeded", interruption.name);
      assert.equal(state.hostClaims, 1, interruption.name);
      assert.equal(state.hostMutations, 1, interruption.name);
      assert.equal(state.resultPersistences, 1, interruption.name);
      assert.equal(state.providerContinuations, 1, interruption.name);
      assert.equal(state.attempt?.ordinal, 1, interruption.name);
      assert.equal(state.attempt?.providerOrdinal, 1, interruption.name);
    }
    if (interruption.boundary === "during:local_cleanup") {
      assert.equal(state.cleanup?.status, "acknowledged", interruption.name);
      assert.equal(state.cleanup?.terminalOutcome, "succeeded", interruption.name);
    }
    const observedClassifications = [classifyRecoveredLocalState(state, faults)];
    assert.equal(new Set(observedClassifications).size, 1, interruption.name);
    assert.equal(observedClassifications[0], interruption.classification, interruption.name);
    assert.equal(allowedClassifications.has(observedClassifications[0]), true, interruption.name);
  }
});

test("logical retry classifications remain ordered and never reuse attempt authority", () => {
  const base = createSessionState({
    sessionId: "retry-session",
    policyVersionId: "retry-policy",
    providerOrder: ["provider-a", "provider-b"],
    totalAttemptBudget: 3,
    providerAttemptBudgets: { "provider-a": 2, "provider-b": 1 },
    expiresAt: 100,
    state: "ready",
  });
  const started = stateResult(transitionSession(base, {
    requestId: "retry:start",
    eventId: "retry:start:event",
    now: 1,
    type: "start_attempt",
    provider: "provider-a",
  }));
  const sameProvider = stateResult(transitionSession(started, {
    requestId: "retry:same",
    eventId: "retry:same:event",
    now: 2,
    type: "retry",
    classification: "fresh_attempt_same_provider",
    provider: "provider-a",
  }));
  assert.equal(sameProvider.attemptCount, 2);
  assert.equal(sameProvider.currentProvider, "provider-a");
  const nextProvider = stateResult(transitionSession(sameProvider, {
    requestId: "retry:next",
    eventId: "retry:next:event",
    now: 3,
    type: "retry",
    classification: "fresh_attempt_next_provider",
    provider: "provider-b",
  }));
  assert.equal(nextProvider.attemptCount, 3);
  assert.equal(nextProvider.currentProvider, "provider-b");
  assert.equal(nextProvider.attemptsByProvider["provider-a"], 2);
  assert.equal(nextProvider.attemptsByProvider["provider-b"], 1);
  assert.equal(allowedClassifications.has("fresh same-provider attempt"), true);
  assert.equal(allowedClassifications.has("fresh next-provider attempt"), true);
});

function verifiedRuntimeDatabase(): string | undefined {
  const url = process.env.COORDINATION_RUNTIME_TEST_DATABASE_URL;
  if (!url) {
    if (process.env.COORDINATION_RUNTIME_REQUIRE_DATABASE_TESTS === "1") {
      throw new Error("COORDINATION_RUNTIME_TEST_DATABASE_URL is required by the migration gate");
    }
    return undefined;
  }
  if (process.env.COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE !== "1") {
    throw new Error("COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE=1 is required for the mutation suite");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("COORDINATION_RUNTIME_TEST_DATABASE_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Coordinator V2 mutation tests require PostgreSQL");
  }
  const forbidden = process.env.COORDINATION_RUNTIME_FORBIDDEN_SHARED_URL;
  if (!forbidden || forbidden === url) {
    throw new Error("Coordinator V2 mutation tests require a distinct forbidden shared URL");
  }
  return url;
}

async function authoritativeFault<T>(
  faults: FailOnceFaultController,
  boundary: Boundary,
  operation: () => Promise<T>,
): Promise<T> {
  if (boundary.startsWith("before:") || boundary.startsWith("during:")) faults.before(boundary);
  const value = await operation();
  if (boundary.startsWith("after:")) faults.after(boundary);
  return value;
}

type DatabaseFixture = {
  readonly hostId: string;
  readonly identityId: string;
  readonly versionId: string;
  readonly grantId: string;
  readonly sessionId: string;
  readonly actorId: string;
  readonly holderInstanceId: string;
  readonly artifactDigest: string;
  readonly publicMaterialDigest: string;
};

function fixtureDigest(suffix: string, kind: string): string {
  return createHash("sha256").update(`${suffix}:${kind}`, "utf8").digest("hex");
}

async function insertAuthoritativeFixture(client: pg.Client, suffix: string): Promise<DatabaseFixture> {
  const id = (kind: string) => `coordination-fault-db-${kind}-${suffix}`;
  const actorId = "fault-db-operator";
  const hostId = id("host");
  const identityId = id("identity");
  const versionId = id("version");
  const grantId = id("grant");
  const sessionId = id("session");
  const artifactDigest = fixtureDigest(suffix, "artifact");
  const publicMaterialDigest = fixtureDigest(suffix, "public-material");
  const policy = canonicalizeAndHashPolicy({
    hostTypes: ["windows"],
    hostConstraints: {
      windowsRepositoryBranch: "main",
      windowsPublicMaterialDigest: publicMaterialDigest,
    },
    providerOrder: ["gemini"],
    sessionDurationMs: 900_000,
    totalAttemptBudget: 2,
    perProviderAttemptBudgets: { gemini: 2 },
    requiredValidationCommands: ["typecheck"],
    requiredCompletionEvidence: ["digest"],
  });
  await client.query(
    `INSERT INTO coordination_v2_host_enrollments
     (id,host_key,host_type,display_name,protocol_version,public_key,key_fingerprint,
      capabilities,enrollment_digest,enrollment_request_key,status,created_by)
     VALUES ($1,$2,'windows','Fault injection host',1,'fault-public-key',$3,
              ARRAY['preflight','prepare','poll','claim','result'],$4,$5,'active','fault-injection')`,
    [hostId, id("host-key"), fixtureDigest(suffix, "fingerprint"), fixtureDigest(suffix, "enrollment"), id("enrollment-request")],
  );
  await client.query(
    `INSERT INTO coordination_v2_policy_identities
     (id,policy_key,display_name,status,created_by)
     VALUES ($1,$2,'Fault injection policy','active','fault-injection')`,
    [identityId, id("policy-key")],
  );
  await client.query(
    `INSERT INTO coordination_v2_policy_versions
     (id,policy_identity_id,version,canonical_policy,policy_digest,approval_state,
      created_by,approved_by,approved_at)
     VALUES ($1,$2,1,$3::jsonb,$4,'approved','fault-injection','founder',now())`,
    [versionId, identityId, JSON.stringify(policy.canonicalPolicy), policy.policyDigest],
  );
  await client.query(
    `INSERT INTO coordination_v2_operator_grants
     (id,policy_identity_id,operator_actor,actions,issued_by,expires_at,grant_digest,request_key)
     VALUES ($1,$2,$3,ARRAY['launch','resume','terminate','status'],'founder',
             now()+interval '1 hour',$4,$5)`,
    [grantId, identityId, actorId, fixtureDigest(suffix, "grant"), id("grant-request")],
  );
  await client.query(
    `INSERT INTO coordination_v2_sessions
     (id,policy_version_id,operator_grant_id,operator_actor,task_ref,task_artifact_sha256,
      repository_identity,starting_commit,enrolled_host_id,requested_providers,expires_at,
      attempt_budget,per_provider_budgets,required_validations,completion_criteria,state,
      idempotency_key,session_digest)
     VALUES ($1,$2,$3,$4,'1',$5,'repo/coordination-v2-fault',$6,$7,ARRAY['gemini'],
             now()+interval '1 hour',2,'{"gemini":2}'::jsonb,ARRAY['typecheck'],$8::jsonb,
             'ready',$9,$10)`,
    [
      sessionId, versionId, grantId, actorId, artifactDigest, "a".repeat(40), hostId,
      JSON.stringify({ requiredCompletionEvidence: ["digest"] }),
      id("session-request"), fixtureDigest(suffix, "session"),
    ],
  );
  return {
    hostId, identityId, versionId, grantId, sessionId, actorId,
    holderInstanceId: id("holder"), artifactDigest, publicMaterialDigest,
  };
}

test("verified disposable PostgreSQL proves authoritative Coordinator V2 fault recovery", async (context) => {
  const url = verifiedRuntimeDatabase();
  if (!url) {
    context.skip("set COORDINATION_RUNTIME_TEST_DATABASE_URL and COORDINATION_RUNTIME_TEST_DATABASE_DISPOSABLE=1");
    return;
  }
  const previousNeon = process.env.NEON_SHARED_DATABASE_URL;
  const previousCi = process.env.CI;
  const previousCiDatabase = process.env.CI_DATABASE_URL;
  process.env.NEON_SHARED_DATABASE_URL = url;
  delete process.env.CI;
  delete process.env.CI_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const cases: ReadonlyArray<{ name: string; boundary: Boundary }> = [
    { name: "before reservation", boundary: "before:session_reservation" },
    { name: "after reservation", boundary: "after:session_reservation" },
    { name: "before attempt creation", boundary: "before:attempt_creation" },
    { name: "after attempt creation", boundary: "after:attempt_creation" },
    { name: "before host claim", boundary: "before:host_claim" },
    { name: "after host claim", boundary: "after:host_claim" },
    { name: "before result persistence", boundary: "before:result_persistence" },
    { name: "after result persistence", boundary: "after:result_persistence" },
    { name: "before completion acceptance", boundary: "before:completion_acceptance" },
    { name: "after completion acceptance", boundary: "after:completion_acceptance" },
    { name: "during server revocation", boundary: "during:server_revocation" },
    { name: "during local cleanup", boundary: "during:local_cleanup" },
  ];
  const [
    generation,
    sessionService,
    attemptService,
    leaseService,
    cleanupService,
  ] = await Promise.all([
    import("../services/coordination-windows-generation"),
    import("../services/coordination-session-service"),
    import("../services/coordination-attempt-service"),
    import("../services/coordination-transport-lease-service"),
    import("../services/coordination-cleanup-service"),
  ]);
  try {
    for (const testCase of cases) {
      const fixture = await insertAuthoritativeFixture(client, `${Date.now()}-${randomUUID()}`);
      const faults = new FailOnceFaultController(testCase.boundary);
      const ids = (kind: string) => `fault-db-${kind}-${fixture.sessionId}`;
      let reservation: any;
      let attempt: any;
      let lease: any;
      let claim: any;
      let result: any;
      const stage = <T>(boundary: Boundary, operation: () => Promise<T>): Promise<T> =>
        (testCase.boundary === boundary
          || (boundary.startsWith("after:")
            && testCase.boundary === `before:${boundary.slice("after:".length)}`))
          ? authoritativeFault(faults, testCase.boundary, operation)
          : operation();

      const finishCleanup = async (): Promise<void> => {
        const obligationsRows = await client.query(
          "SELECT id,kind FROM coordination_v2_cleanup_obligations WHERE session_id=$1 ORDER BY kind",
          [fixture.sessionId],
        );
        const obligations = obligationsRows.rows as Array<{ id: string; kind: string }>;
        await stage("during:local_cleanup", () =>
          cleanupService.transitionCoordinationCleanup({
            obligationId: obligations[0].id, requestKey: ids(`cleanup-start-${obligations[0].kind}`),
            actorId: fixture.actorId, command: { type: "start" },
          }));
        for (const obligation of obligations) {
          await cleanupService.transitionCoordinationCleanup({
            obligationId: obligation.id, requestKey: ids(`cleanup-${obligation.kind}`),
            actorId: fixture.actorId, command: { type: "start" },
          }).catch(() => undefined);
          await leaseService.acknowledgeCoordinationCleanup({
            sessionId: fixture.sessionId, enrolledHostId: fixture.hostId,
            holderInstanceId: fixture.holderInstanceId, actorId: fixture.actorId,
            requestKey: ids(`cleanup-ack-${obligation.kind}`),
            leaseId: lease.id, epoch: lease.epoch, obligationId: obligation.id,
            evidence: { acknowledged: true, kind: obligation.kind },
          });
        }
      };

      const runPath = async (): Promise<void> => {
        // A restart must honor durable terminal authority rather than trying
        // to reacquire launch authority. Re-read the exact service rows and
        // replay only the unresolved terminal boundary.
        const durableSession = await client.query(
          "SELECT state FROM coordination_v2_sessions WHERE id=$1", [fixture.sessionId],
        );
        if (durableSession.rows[0]?.state === "revoked") return;
        if (durableSession.rows[0]?.state === "succeeded"
          || durableSession.rows[0]?.state === "verifying") {
          const attemptRow = await client.query(
            "SELECT id FROM coordination_v2_attempts WHERE session_id=$1 ORDER BY session_ordinal LIMIT 1",
            [fixture.sessionId],
          );
          const resultRow = await client.query(
            "SELECT id,result_digest FROM coordination_v2_transport_work_results WHERE session_id=$1 LIMIT 1",
            [fixture.sessionId],
          );
          const leaseRow = await client.query(
            "SELECT id,epoch FROM coordination_v2_transport_leases WHERE session_id=$1 ORDER BY epoch DESC LIMIT 1",
            [fixture.sessionId],
          );
          attempt = { id: attemptRow.rows[0]?.id };
          result = resultRow.rows[0];
          lease = leaseRow.rows[0];
          if (testCase.boundary === "during:local_cleanup") {
            await finishCleanup();
          } else {
            await stage("after:completion_acceptance", () =>
              cleanupService.acceptCoordinationCompletion({
                sessionId: fixture.sessionId, requestKey: ids("completion"), actorId: fixture.actorId,
                evidence: [{ type: "digest", reference: result.id, digest: result.result_digest }],
              }));
          }
          return;
        }
        reservation = await stage("after:session_reservation", () =>
          generation.reserveCoordinationWindowsPreparation({
            sessionId: fixture.sessionId, actorId: fixture.actorId, reserveRequestKey: ids("reserve"),
          }));
        await generation.promoteCoordinationWindowsPreparation({
          sessionId: fixture.sessionId, actorId: fixture.actorId, reservationId: reservation.id,
          generationId: reservation.generationId, publicMaterialDigest: fixture.publicMaterialDigest,
          safePromotionEvidenceDigest: fixtureDigest(fixture.sessionId, "promotion"),
        });
        await generation.acknowledgeCoordinationWindowsPreparation({
          sessionId: fixture.sessionId, actorId: fixture.actorId, reservationId: reservation.id,
          generationId: reservation.generationId, publicMaterialDigest: fixture.publicMaterialDigest,
          protocolVersion: 1, acknowledgementRequestKey: ids("prepare-ack"),
          safePromotionEvidenceDigest: fixtureDigest(fixture.sessionId, "promotion"),
        });
        attempt = await stage("after:attempt_creation", () =>
          attemptService.createFreshAttempt({
            sessionId: fixture.sessionId, requestKey: ids("attempt"), actorId: fixture.actorId,
            provider: "gemini", model: "gemini-3-flash-preview",
            adapterVersion: "coordination-gemini-v1", attemptGeneration: fixtureDigest(fixture.sessionId, "generation"),
          }));
        for (const [kind, command] of [
          ["provider-started", { type: "provider_started" as const }],
          ["intent-ready", { type: "intent_ready" as const }],
          ["host-wait", { type: "host_wait" as const }],
        ] as const) {
          await attemptService.transitionCoordinationAttempt({
            attemptId: attempt.id, requestKey: ids(kind), actorId: fixture.actorId, command,
          });
        }
        if (testCase.boundary === "during:server_revocation") {
          await stage("during:server_revocation", () =>
            sessionService.transitionCoordinationSession({
              sessionId: fixture.sessionId, requestKey: ids("revoke"), actorId: fixture.actorId,
              command: { type: "revoke", reason: "fault-injected-revocation" },
            }));
          return;
        }
        lease = await leaseService.acquireCoordinationTransportLease({
          sessionId: fixture.sessionId, enrolledHostId: fixture.hostId,
          holderInstanceId: fixture.holderInstanceId, actorId: fixture.actorId,
          requestKey: ids("lease"), durationMs: 300_000,
        });
        await leaseService.pollCoordinationTransportWork({
          sessionId: fixture.sessionId, enrolledHostId: fixture.hostId,
          holderInstanceId: fixture.holderInstanceId, actorId: fixture.actorId,
          requestKey: ids("poll"), leaseId: lease.id, epoch: lease.epoch,
        });
        claim = await stage("after:host_claim", () =>
          leaseService.claimCoordinationTransportWork({
            sessionId: fixture.sessionId, enrolledHostId: fixture.hostId,
            holderInstanceId: fixture.holderInstanceId, actorId: fixture.actorId,
            requestKey: ids("claim"), leaseId: lease.id, epoch: lease.epoch, attemptId: attempt.id,
          }));
        result = await stage("after:result_persistence", () =>
          leaseService.resultCoordinationTransportWork({
            sessionId: fixture.sessionId, enrolledHostId: fixture.hostId,
            holderInstanceId: fixture.holderInstanceId, actorId: fixture.actorId,
            requestKey: ids("result"), leaseId: lease.id, epoch: lease.epoch,
            attemptId: attempt.id, claimId: claim.claimId,
            result: { confirmed: true, resultDigest: fixtureDigest(fixture.sessionId, "result") },
          }));
        await attemptService.transitionCoordinationAttempt({
          attemptId: attempt.id, requestKey: ids("continuation"), actorId: fixture.actorId,
          command: { type: "provider_continuation" },
        });
        await attemptService.transitionCoordinationAttempt({
          attemptId: attempt.id, requestKey: ids("complete"), actorId: fixture.actorId,
          command: { type: "complete", resultCode: "verified_host_result" },
        });
        await sessionService.transitionCoordinationSession({
          sessionId: fixture.sessionId, requestKey: ids("verification"), actorId: fixture.actorId,
          command: { type: "begin_verification" },
        });
        const completion = await stage("after:completion_acceptance", () =>
          cleanupService.acceptCoordinationCompletion({
            sessionId: fixture.sessionId, requestKey: ids("completion"), actorId: fixture.actorId,
            evidence: [{ type: "digest", reference: result.resultId, digest: result.resultDigest }],
          }));
        if (testCase.boundary === "during:local_cleanup") {
          void completion;
          await finishCleanup();
        }
      };
      await runPath().catch((error: unknown) => {
        if (!(error instanceof InjectedInterruption)) throw error;
      });
      await runPath();
      faults.assertTripped();

      const evidence = await client.query(
        `SELECT s.state, s.terminal_reason, s.session_digest,
                (SELECT state FROM coordination_v2_preparation_reservations
                   WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1) AS preparation_state,
                (SELECT state FROM coordination_v2_attempts
                   WHERE session_id=$1 ORDER BY session_ordinal LIMIT 1) AS attempt_state,
                (SELECT attempt_digest FROM coordination_v2_attempts
                   WHERE session_id=$1 ORDER BY session_ordinal LIMIT 1) AS attempt_digest,
                (SELECT state FROM coordination_v2_transport_leases
                   WHERE session_id=$1 ORDER BY epoch DESC LIMIT 1) AS lease_state,
                (SELECT count(*)::int FROM coordination_v2_attempts WHERE session_id=$1) AS attempts,
                (SELECT count(*)::int FROM coordination_v2_transport_work_claims WHERE session_id=$1) AS claims,
                (SELECT count(*)::int FROM coordination_v2_transport_work_results WHERE session_id=$1) AS results,
                (SELECT result_digest FROM coordination_v2_transport_work_results
                   WHERE session_id=$1 LIMIT 1) AS result_digest,
                (SELECT count(*)::int FROM coordination_v2_attempt_events ae
                   JOIN coordination_v2_attempts a ON a.id=ae.attempt_id
                   WHERE a.session_id=$1 AND ae.event_type='provider_continuation') AS continuations,
                (SELECT count(*)::int FROM coordination_v2_session_events
                   WHERE session_id=$1 AND event_type='completion_accepted') AS completions,
                (SELECT count(*)::int FROM coordination_v2_cleanup_obligations WHERE session_id=$1) AS obligations,
                (SELECT count(*)::int FROM coordination_v2_cleanup_obligations
                   WHERE session_id=$1 AND state='acknowledged') AS acknowledged_cleanup,
                (SELECT array_agg(event_type ORDER BY sequence)
                   FROM coordination_v2_session_events WHERE session_id=$1) AS event_order
           FROM coordination_v2_sessions s WHERE s.id=$1`,
        [fixture.sessionId],
      );
      assert.equal(evidence.rowCount, 1, testCase.name);
      const row = evidence.rows[0];
      assert.match(row.session_digest, /^[0-9a-f]{64}$/, testCase.name);
      assert.equal(row.preparation_state, "acknowledged", testCase.name);
      assert.match(row.attempt_digest, /^[0-9a-f]{64}$/, testCase.name);
      assert.equal(row.attempts, 1, testCase.name);
      assert.equal(row.completions <= 1, true, testCase.name);
      assert.equal(row.obligations, 4, testCase.name);
      let recoveredClassification: RecoveryClassification;
      if (testCase.boundary === "during:server_revocation") {
        assert.equal(row.state, "revoked", testCase.name);
        assert.equal(row.attempt_state, "cancelled", testCase.name);
        assert.equal(row.lease_state, null, testCase.name);
        assert.equal(row.claims, 0, testCase.name);
        assert.equal(row.results, 0, testCase.name);
        assert.equal(row.event_order.at(-1), "session_revoked", testCase.name);
        assert.equal(row.continuations, 0, testCase.name);
        recoveredClassification = "terminal failure";
      } else {
        assert.equal(row.state, "succeeded", testCase.name);
        assert.equal(row.claims, 1, testCase.name);
        assert.equal(row.results, 1, testCase.name);
        assert.equal(row.continuations, 1, testCase.name);
        assert.match(row.result_digest, /^[0-9a-f]{64}$/, testCase.name);
        assert.equal(row.completions, 1, testCase.name);
        assert.equal(row.event_order.at(-1), "completion_accepted", testCase.name);
        assert.equal(row.lease_state, "released", testCase.name);
        assert.equal(row.attempt_state, "completed", testCase.name);
        // Classification comes from durable terminal/evidence rows, not from
        // the injected case name. Cleanup repair preserves the succeeded
        // session while all four obligations are acknowledged.
        recoveredClassification = row.acknowledged_cleanup === 4
          ? "cleanup repair"
          : row.state === "succeeded" && row.completions === 1
            ? "terminal success"
            : "same-attempt transport resume";
      }
      assert.equal(new Set([recoveredClassification]).size, 1, testCase.name);
      assert.equal(allowedClassifications.has(recoveredClassification), true, testCase.name);
    }
  } finally {
    // This suite is restricted to a verified disposable branch. Authority and
    // evidence rows are immutable and intentionally remain until branch
    // deletion; cleanup must never mask an assertion failure.
    await client.end().catch(() => undefined);
    await (await import("../db")).closeDbConnections();
    if (previousNeon === undefined) delete process.env.NEON_SHARED_DATABASE_URL;
    else process.env.NEON_SHARED_DATABASE_URL = previousNeon;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousCiDatabase === undefined) delete process.env.CI_DATABASE_URL;
    else process.env.CI_DATABASE_URL = previousCiDatabase;
  }
});