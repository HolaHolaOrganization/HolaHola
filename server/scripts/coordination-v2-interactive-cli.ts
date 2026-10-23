/**
 * Interactive Coordinator V2 CLI for an intelligent host agent (e.g.
 * Antigravity) that drives its own reasoning between lifecycle steps instead
 * of running inside the unattended `runCoordinationWindowsHost` loop.
 *
 * Design: this module adds no new protocol authority. Every subcommand below
 * is a thin dispatch onto the exact same `CoordinationWindowsHostDependencies`
 * methods the automated M9 path (`coordination-v2-cli.ts` +
 * `runCoordinationWindowsHost`) already calls, built by the same
 * `createCoordinationV2HttpDependencyFactory`. Signing, digesting, and binding
 * validation all happen inside those unchanged methods. What this module adds
 * is purely local: persisting opaque lifecycle state to disk between separate
 * process invocations (one per subcommand, so the agent can reason between
 * steps), and redacting session credentials from anything printed to stdout.
 *
 * Subcommands: start | poll | claim | renew | submit-result | cleanup | status
 */
import { isDirectCliInvocation } from "./lib/cli-entrypoint";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createHostEnvelope,
  validateHostEnvelope,
  type HostBinding,
  type HostEnvelope,
} from "../services/coordination-host-protocol";
import { canonicalJson } from "../services/coordination-runtime";
import { parseCoordinationV2CliArgs, type CoordinationV2DependencyFactory } from "./coordination-v2-cli";
import {
  createCoordinationV2HttpDependencyFactory,
} from "./coordination-v2-http-factory";
import type {
  CoordinationWindowsBoundState,
  CoordinationWindowsHostDependencies,
  CoordinationWindowsOperatorInput,
} from "./coordination-windows-host";

// Matches coordination-host-fake.ts's own local helper exactly (same
// canonicalization source, coordination-runtime.ts). This is the digest that
// createHostEnvelope's own validatePayload will recompute and check, so
// computing it any other way here would make submit-result fail closed.
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function requestKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

export type CoordinationV2InteractiveSubcommand =
  | "start" | "poll" | "claim" | "renew" | "submit-result" | "cleanup" | "status";

const INTERACTIVE_SUBCOMMANDS = new Set<CoordinationV2InteractiveSubcommand>([
  "start", "poll", "claim", "renew", "submit-result", "cleanup", "status",
]);

export type CoordinationV2InteractiveSessionRecord = Readonly<{
  taskRef: string;
  policySelector?: string;
  state: CoordinationWindowsBoundState;
  lastOffer?: Readonly<Record<string, unknown>>;
  lastClaim?: HostEnvelope<"operation_claim">;
  updatedAt: string;
}>;

/**
 * Only ever non-secret identifiers/status. sessionToken and
 * cleanupSessionToken must never appear here — Antigravity's own transcript
 * or logs could capture this output.
 */
export type CoordinationV2InteractiveOutput = Readonly<{
  ok: boolean;
  step: CoordinationV2InteractiveSubcommand | "parse";
  taskRef: string;
  sessionId?: string;
  attemptId?: string;
  leaseId?: string;
  leaseEpoch?: number;
  action?: "operation_available" | "renew";
  offer?: Readonly<Record<string, unknown>>;
  terminalState?: string;
  cleanupAcknowledged?: boolean;
  error?: string;
}>;

function sessionDirectory(root: string): string {
  return join(root, ".coordination-v2-interactive-session");
}
function sessionPath(root: string, taskRef: string): string {
  return join(sessionDirectory(root), `${digest(taskRef)}.json`);
}

async function loadSession(root: string, taskRef: string): Promise<CoordinationV2InteractiveSessionRecord> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(root, taskRef), "utf8");
  } catch {
    throw new Error("interactive_session_not_found");
  }
  const parsed = JSON.parse(raw) as CoordinationV2InteractiveSessionRecord;
  if (!parsed || typeof parsed !== "object" || parsed.taskRef !== taskRef || !parsed.state) {
    throw new Error("interactive_session_invalid");
  }
  return parsed;
}

async function saveSession(root: string, record: CoordinationV2InteractiveSessionRecord): Promise<void> {
  const directory = sessionDirectory(root);
  await mkdir(directory, { recursive: true });
  const path = sessionPath(root, record.taskRef);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, path);
}

async function clearSession(root: string, taskRef: string): Promise<void> {
  await rm(sessionPath(root, taskRef), { force: true });
}

const BOUND_STATE_REQUIRED_STRINGS = [
  "sessionId", "reservationId", "generationId", "policyVersionId", "attemptId",
  "enrolledHostId", "leaseId", "holderInstanceId", "sessionToken", "cleanupSessionToken", "cleanupCredentialId",
] as const;

/** Local shape sanity check only — the server remains the real authority. */
function mergeBoundState(current: CoordinationWindowsBoundState, update: unknown): CoordinationWindowsBoundState {
  if (update === undefined) return current;
  if (!update || typeof update !== "object" || Array.isArray(update)) throw new Error("state_update_invalid");
  const merged = { ...current, ...(update as Record<string, unknown>) } as CoordinationWindowsBoundState;
  for (const key of BOUND_STATE_REQUIRED_STRINGS) {
    if (typeof merged[key] !== "string" || !(merged[key] as string)) throw new Error("state_update_invalid");
  }
  if (!Number.isSafeInteger(merged.leaseEpoch) || merged.leaseEpoch < 0) throw new Error("state_update_invalid");
  return merged;
}

function redactedState(state: CoordinationWindowsBoundState) {
  return {
    sessionId: state.sessionId,
    attemptId: state.attemptId,
    leaseId: state.leaseId,
    leaseEpoch: state.leaseEpoch,
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Bundles reserve + prepare (if the server asks for it) + re-acknowledge +
 * acquireLease into one process invocation. This mirrors
 * runCoordinationWindowsHost's own setup sequence (lines ~338-390) exactly,
 * because acquireLease is the one method that bakes the *current process's*
 * fresh holderInstanceId into the returned bound state — splitting reserve
 * and lease across two processes would silently mint two different holders.
 */
async function performStart(
  dependencies: CoordinationWindowsHostDependencies,
  input: CoordinationWindowsOperatorInput,
): Promise<{ state: CoordinationWindowsBoundState } | { terminalState: string }> {
  const started = await dependencies.transport.start(input);
  if (started.terminalState) return { terminalState: started.terminalState };
  if (started.preparation === null) throw new Error("host_unavailable");
  const hasPreparation = started.preparation !== undefined;
  if (hasPreparation && started.alreadyAcknowledged === true) throw new Error("host_unavailable");
  if (hasPreparation) {
    if (!dependencies.prepare) throw new Error("host_unavailable");
    let prepared = await dependencies.prepare(started.preparation!);
    if (prepared.state === "promoted" && prepared.recoverable) {
      prepared = await dependencies.prepare(started.preparation!);
    }
    if (prepared.state !== "acknowledged") throw new Error("preparation_failed");
  }
  let acknowledgedState: unknown;
  if (hasPreparation || started.alreadyAcknowledged !== true) {
    const acknowledged = await dependencies.transport.start(input);
    if (acknowledged.alreadyAcknowledged !== true || acknowledged.preparation !== undefined || !acknowledged.state) {
      throw new Error("host_unavailable");
    }
    acknowledgedState = acknowledged.state;
  } else {
    acknowledgedState = started.state;
  }
  const leased = await dependencies.transport.acquireLease({ state: acknowledgedState as never });
  if (leased.terminalState) return { terminalState: leased.terminalState };
  if (!leased.state) throw new Error("host_unavailable");
  return { state: leased.state as CoordinationWindowsBoundState };
}

export type CoordinationV2InteractiveCliOptions = Readonly<{
  root?: string;
  readStdin?: () => Promise<string>;
}>;

export async function runCoordinationV2InteractiveCli(
  argv: readonly string[],
  createDependencyFactory: () => Promise<CoordinationV2DependencyFactory>,
  options: CoordinationV2InteractiveCliOptions = {},
): Promise<CoordinationV2InteractiveOutput> {
  const [subcommandToken, ...rest] = argv;
  if (!subcommandToken || !INTERACTIVE_SUBCOMMANDS.has(subcommandToken as CoordinationV2InteractiveSubcommand)) {
    return { ok: false, step: "parse", taskRef: "", error: "unsupported_subcommand" };
  }
  const subcommand = subcommandToken as CoordinationV2InteractiveSubcommand;
  let parsed: ReturnType<typeof parseCoordinationV2CliArgs>;
  try {
    parsed = parseCoordinationV2CliArgs(rest);
  } catch {
    return { ok: false, step: subcommand, taskRef: "", error: "invalid_argument" };
  }
  const root = options.root ?? process.cwd();
  const input: CoordinationWindowsOperatorInput = {
    taskRef: parsed.taskRef,
    ...(parsed.policySelector ? { policySelector: parsed.policySelector } : {}),
  };

  // status is a pure local read — it must never require live credentials or
  // a network round-trip, so the dependency factory is never constructed for it.
  if (subcommand === "status") {
    try {
      const session = await loadSession(root, parsed.taskRef);
      return { ok: true, step: "status", taskRef: parsed.taskRef, ...redactedState(session.state) };
    } catch (error) {
      return { ok: false, step: "status", taskRef: parsed.taskRef, error: error instanceof Error ? error.message : "status_failed" };
    }
  }

  let dependenciesPromise: Promise<CoordinationWindowsHostDependencies> | undefined;
  const getDependencies = () => {
    dependenciesPromise ??= createDependencyFactory().then((factory) => factory(input));
    return dependenciesPromise;
  };

  try {
    if (subcommand === "start") {
      const outcome = await performStart(await getDependencies(), input);
      if ("terminalState" in outcome) {
        return { ok: false, step: "start", taskRef: parsed.taskRef, terminalState: outcome.terminalState };
      }
      await saveSession(root, {
        taskRef: parsed.taskRef, policySelector: parsed.policySelector, state: outcome.state, updatedAt: "",
      });
      return { ok: true, step: "start", taskRef: parsed.taskRef, ...redactedState(outcome.state) };
    }

    // Every other subcommand resumes a session started by an earlier process.
    const session = await loadSession(root, parsed.taskRef);

    if (subcommand === "poll") {
      const dependencies = await getDependencies();
      const polled = await dependencies.transport.poll({ state: session.state, requestKey: requestKey("interactive-poll") });
      const nextState = mergeBoundState(session.state, polled.state);
      const offer = polled.offer && typeof polled.offer === "object" && !Array.isArray(polled.offer)
        ? (polled.offer as Record<string, unknown>) : undefined;
      await saveSession(root, { ...session, state: nextState, lastOffer: offer });
      if (polled.terminalState) {
        return { ok: false, step: "poll", taskRef: parsed.taskRef, terminalState: polled.terminalState, ...redactedState(nextState) };
      }
      return {
        ok: true, step: "poll", taskRef: parsed.taskRef, ...redactedState(nextState),
        action: polled.action, ...(offer ? { offer } : {}),
      };
    }

    if (subcommand === "claim") {
      if (!session.lastOffer) return { ok: false, step: "claim", taskRef: parsed.taskRef, error: "no_offer_to_claim" };
      const dependencies = await getDependencies();
      const claimed = await dependencies.transport.claim({
        state: session.state, requestKey: requestKey("interactive-claim"), offer: session.lastOffer,
      });
      const nextState = mergeBoundState(session.state, claimed.state);
      let lastClaim: HostEnvelope<"operation_claim"> | undefined = session.lastClaim;
      if (claimed.claim !== undefined) {
        const validated = validateHostEnvelope(claimed.claim);
        if (validated.kind !== "operation_claim") throw new Error("unexpected_claim_kind");
        lastClaim = validated as HostEnvelope<"operation_claim">;
      }
      await saveSession(root, { ...session, state: nextState, lastClaim });
      if (claimed.terminalState) {
        return { ok: false, step: "claim", taskRef: parsed.taskRef, terminalState: claimed.terminalState, ...redactedState(nextState) };
      }
      return { ok: true, step: "claim", taskRef: parsed.taskRef, ...redactedState(nextState) };
    }

    if (subcommand === "renew") {
      const dependencies = await getDependencies();
      if (!dependencies.transport.renew) return { ok: false, step: "renew", taskRef: parsed.taskRef, error: "renew_unsupported" };
      const renewed = await dependencies.transport.renew({ state: session.state, requestKey: requestKey("interactive-renew") });
      const nextState = mergeBoundState(session.state, renewed.state);
      await saveSession(root, { ...session, state: nextState });
      if (renewed.terminalState) {
        return { ok: false, step: "renew", taskRef: parsed.taskRef, terminalState: renewed.terminalState, ...redactedState(nextState) };
      }
      return { ok: true, step: "renew", taskRef: parsed.taskRef, ...redactedState(nextState) };
    }

    if (subcommand === "submit-result") {
      if (!session.lastClaim) return { ok: false, step: "submit-result", taskRef: parsed.taskRef, error: "no_claim_to_submit_against" };
      const read = options.readStdin ?? readAllStdin;
      const raw = await read();
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { ok: false, step: "submit-result", taskRef: parsed.taskRef, error: "invalid_result_json" };
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, step: "submit-result", taskRef: parsed.taskRef, error: "result_must_be_object" };
      }
      const claimPayload = session.lastClaim.payload as { binding: HostBinding };
      const now = Date.now();
      // Mirrors CoordinationHostFake.execute() exactly: the claim's own
      // binding, a fresh resultDigest over the raw payload, requestId
      // chained off the claim. createHostEnvelope's own validatePayload
      // recomputes and checks this digest, so any divergence fails closed
      // right here rather than silently reaching the server.
      const innerEnvelope = createHostEnvelope("structured_result", {
        binding: claimPayload.binding,
        result: payload as Record<string, unknown>,
        resultDigest: digest(payload),
      }, {
        requestId: `${session.lastClaim.requestId}:result`,
        correlationId: session.lastClaim.correlationId,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
      });
      const dependencies = await getDependencies();
      const submitted = await dependencies.transport.result({
        state: session.state, requestKey: `interactive-result:${innerEnvelope.digest}`, result: innerEnvelope as never,
      });
      const nextState = mergeBoundState(session.state, submitted.state);
      await saveSession(root, { ...session, state: nextState });
      return {
        ok: true, step: "submit-result", taskRef: parsed.taskRef, ...redactedState(nextState),
        ...(submitted.terminalState ? { terminalState: submitted.terminalState } : {}),
      };
    }

    if (subcommand === "cleanup") {
      const dependencies = await getDependencies();
      const cleaned = await dependencies.transport.cleanup({ state: session.state, requestKey: requestKey("interactive-cleanup") });
      if (cleaned.acknowledged === true) {
        await clearSession(root, parsed.taskRef);
      } else if (cleaned.state !== undefined) {
        await saveSession(root, { ...session, state: mergeBoundState(session.state, cleaned.state) });
      }
      return {
        ok: cleaned.acknowledged === true, step: "cleanup", taskRef: parsed.taskRef,
        cleanupAcknowledged: cleaned.acknowledged === true,
        ...(cleaned.terminalState ? { terminalState: cleaned.terminalState } : {}),
      };
    }

    return { ok: false, step: subcommand, taskRef: parsed.taskRef, error: "unsupported_subcommand" };
  } catch (error) {
    return { ok: false, step: subcommand, taskRef: parsed.taskRef, error: error instanceof Error ? error.message : "interactive_cli_failure" };
  }
}

/**
 * No real Windows authority is enabled until the real dependency factory can
 * be constructed. Fail closed rather than calling the transport without host
 * lifecycle, matching coordination-v2-cli.ts's own process-boundary contract.
 */
async function main(): Promise<void> {
  const createDependencyFactory = async (): Promise<CoordinationV2DependencyFactory> => {
    if (process.platform !== "win32") throw new Error("windows_required");
    return createCoordinationV2HttpDependencyFactory();
  };
  let output: CoordinationV2InteractiveOutput;
  try {
    output = await runCoordinationV2InteractiveCli(process.argv.slice(2), createDependencyFactory);
  } catch {
    output = { ok: false, step: "parse", taskRef: "", error: "interactive_cli_crash" };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.ok ? 0 : 1;
}

if (isDirectCliInvocation("coordination-v2-interactive-cli.ts")) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, step: "parse", taskRef: "", error: "interactive_cli_crash" })}\n`);
    process.exitCode = 70;
  });
}
