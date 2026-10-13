/**
 * Local Read-only Worker v1 — supervisor orchestration (design §5).
 *
 * Wires the pure decisions (authority, claim, fence, watchdog, outbox, recovery)
 * to three ports: the ledger (HTTP), the host (git, harness, launcher) and the
 * local state store. Every remote mutation — including the claim itself — is
 * first frozen in the outbox as a complete immutable operation, and every
 * attempt of an owner write re-confirms the claim fence. --plan-only performs
 * reads only: no ledger writes, no staging, no launch.
 */
import { randomUUID } from 'node:crypto';
import {
  WORKER_FAILURE_SCHEMA, WORKER_REJECTION_SCHEMA, WORKER_RESULT_SCHEMA, assertSendablePayload, buildCompletionEvidence,
  claimKeyFor, sha256Hex, workerFailureSchema, workerResultSchema, writeKeyFor,
  type WorkerCharterBody, type WorkerFailureClass, type WorkerJob,
} from '../../../shared/worker-contracts';
import { evaluateJobAuthority, type CharterRecord } from './authority';
import {
  MONITOR_INTERVAL_MS, buildHarnessArgs, buildHarnessEnv, buildPrompt, configDigest, isAllowedImage, isQualified,
  nofiletoolsExcerpts, nofiletoolsSizeCheck, type AdapterName,
} from './adapter';
import { interpretLauncherExit, type MembersSnapshot } from './job-launcher';
import {
  checkFence, compareEventToEntry, decideClaimOutcome, decideResend, decideWatchdog, freezeOutboxEntry, isIntactOutboxEntry,
  outboxBlocksClaims, reconcileOutboxEntry, selectOwnRecoveries, type LedgerAppendResult, type OutboxEntry,
  type OutboxOperation, type RemoteRead, type ThreadEventLite,
} from './lifecycle';
import type { TreeEntry } from './paths';
import type { HarnessOutcome, StagedInput } from './staging';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type ThreadView = {
  thread: { id: string; state: string; originActor: string; intendedRecipient: string; currentOwner: string | null; latestSequence: number; sourceReference: { type?: string } | null };
  events: (ThreadEventLite & { sequence: number; actor: string; createdAt: string })[];
};

export type JobsPage = { jobs: { threadId: string; createdGlobalSequence: number }[]; nextAfter: number; complete: boolean; acceptedInWindow: number };

export interface LedgerPort {
  getCharter(id: string, version: number): Promise<RemoteRead<CharterRecord>>;
  listJobs(q: { charterId: string; charterVersion: number; after: number; limit: number }): Promise<RemoteRead<JobsPage>>;
  showThread(threadId: string): Promise<RemoteRead<ThreadView>>;
  append(threadId: string, eventType: 'accepted' | 'completed' | 'blocked' | 'comment', input: {
    expectedSequence: number; idempotencyKey: string; content: string; payload?: Record<string, unknown>; evidence?: unknown[]; recipientActor?: string;
  }): Promise<LedgerAppendResult>;
}

export type LaunchExit = { code: number | null; spawnFailed?: boolean };

export type LaunchHandle = {
  /** false when the control line could not be delivered (launcher unresponsive). */
  terminate(): boolean;
  killLauncher(): void;
  exited: Promise<LaunchExit>;
  stdout(): { text: string; overflow: boolean };
  /** §5.6 monitoring: one bounded LIST round trip; null when no well-formed reply arrived. */
  listMembers(timeoutMs: number): Promise<MembersSnapshot | null>;
};

export interface HostPort {
  now(): number;
  /** Resolves after ms; an aborted sleep may resolve early and must have no other effect. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  fetchOrigin(): Promise<boolean>;
  commitExists(commit: string): boolean;
  isAncestorOfOriginMain(commit: string): boolean;
  lsTree(commit: string): TreeEntry[] | null;
  resolveHarness(): Promise<{ path: string; version: string; sha256: string } | null>;
  stage(commit: string, files: { path: string }[]): StagedInput;
  removeStaging(dir: string): void;
  verifyStaged(staged: StagedInput): { ok: true } | { ok: false; detail: string };
  validate(stdout: string, baseline: ReadonlyMap<string, Buffer>): HarnessOutcome;
  launch(cfg: { exe: string; args: string[]; cwd: string; env: Record<string, string> }): LaunchHandle;
  env(): Record<string, string | undefined>;
}

export interface StateStore {
  instanceId(): string;
  acquireLock(runNonce: string, reclaimStale: boolean): { ok: true } | { ok: false; reason: string };
  /** Removes the lock only if it is still this run's exact record. */
  releaseLock(): { released: boolean; reason?: string };
  /** Raw persisted entries; the supervisor refuses any that are not intact. */
  outbox(): unknown[];
  saveOutbox(entry: OutboxEntry): void;
  receipt(threadId: string, kind: string, data: Record<string, unknown>): void;
  launched(key: string): boolean;
  markLaunched(key: string): void;
  scanAfter(charterId: string, version: number): number;
  saveScanAfter(charterId: string, version: number, after: number): void;
}

export type SupervisorOptions = {
  workerActor: string;
  charterId: string;
  charterVersion: number;
  planOnly: boolean;
  untilMs: number;
  maxJobs: number;
  adapter: AdapterName;
  designatedApiKey?: string;
  reclaimStaleLock?: boolean;
  log?: (line: string) => void;
};

export type SupervisorReport = {
  runNonce: string; instanceId: string; mode: 'plan-only' | 'normal';
  decisions: { threadId: string; decision: string }[];
  outcomes: { threadId: string; outcome: string }[];
  halted: string | null;
};

const JOB_INTRINSIC = new Set([
  'not_a_worker_job', 'agent_note_source_rejected', 'originator_not_allowed', 'charter_mismatch', 'kind_not_allowed',
  'model_not_allowed', 'auth_profile_not_allowed', 'runtime_exceeds_charter', 'api_budget_exceeds_charter',
  'job_predates_charter_approval', 'job_created_outside_window', 'commit_missing', 'commit_not_on_origin_main',
  'paths_no_match', 'paths_no_files', 'path_not_allowlisted', 'path_denylisted', 'path_symlink', 'path_submodule',
  'path_case_collision', 'path_file_too_large', 'staging_too_many_files', 'staging_too_large', 'deadline_passed',
]);
const isJobIntrinsic = (reason: string) => JOB_INTRINSIC.has(reason) || reason.startsWith('job_') || reason.startsWith('question_') || reason.startsWith('path_');
/** Not job-intrinsic, but permanent for this worker: the candidate never needs re-evaluation. */
const PERMANENT_FOR_WORKER = new Set(['not_addressed_to_worker', 'thread_state_not_claimable', 'thread_already_owned', 'created_event_missing']);

const MAX_DISCOVERY_PAGES = 1000;
const WATCHDOG_TICK_MS = 15_000;
const TERMINATE_WAIT_MS = 15_000;
const KILL_WAIT_MS = 15_000;
const MONITOR_LIST_TIMEOUT_MS = 1_500;
const MONITOR_EXIT_GRACE_MS = 500;
/** Two watchdog intervals without a settled authority read = no confirmed authority for 30 s (§5.6). */
const REMOTE_UNCONFIRMED_MS = 2 * 15_000;

type RemotePair = { started: number; done: boolean; value: [RemoteRead<CharterRecord>, RemoteRead<ThreadView>] | null };

/**
 * §5.6 verdict over one LIST snapshot. Snapshots are observations only: they never
 * select a kill target; any stop goes through the launcher's job-handle termination.
 * No reply, a failed job query or an unreadable member is `unknown`; a member whose
 * image is outside the approved policy is `violation`.
 */
export function judgeMembers(m: MembersSnapshot | null, harnessPath: string, systemRoot: string):
  { kind: 'ok' } | { kind: 'unknown'; reason: string } | { kind: 'violation'; images: string[] } {
  if (!m) return { kind: 'unknown', reason: 'no_reply' };
  if (!m.listOk) return { kind: 'unknown', reason: 'job_list_failed' };
  if (m.processes.some((p) => p.state === 'unknown')) return { kind: 'unknown', reason: 'member_unreadable' };
  const bad = m.processes.filter((p) => p.state === 'member' && !isAllowedImage(p.image!, harnessPath, systemRoot)).map((p) => p.image!);
  return bad.length ? { kind: 'violation', images: bad } : { kind: 'ok' };
}

type Ctx = {
  o: SupervisorOptions; ledger: LedgerPort; host: HostPort; state: StateStore;
  instanceId: string; runNonce: string; report: SupervisorReport; log: (l: string) => void;
};

/** Races a promise against a cancellable timer (and optionally another promise); the timer is always released. */
async function raceTimer<T>(host: HostPort, p: Promise<T>, ms: number, also?: Promise<unknown>):
  Promise<{ kind: 'value'; value: T } | { kind: 'timer' } | { kind: 'also' }> {
  const ctl = new AbortController();
  try {
    return await Promise.race([
      p.then((value) => ({ kind: 'value' as const, value })),
      host.sleep(Math.max(0, ms), ctl.signal).then(() => ({ kind: 'timer' as const })),
      ...(also ? [also.then(() => ({ kind: 'also' as const }))] : []),
    ]);
  } finally { ctl.abort(); }
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export async function runSupervisor(o: SupervisorOptions, ledger: LedgerPort, host: HostPort, state: StateStore): Promise<SupervisorReport> {
  const log = o.log ?? (() => undefined);
  const runNonce = randomUUID();
  const instanceId = state.instanceId();
  const report: SupervisorReport = { runNonce, instanceId, mode: o.planOnly ? 'plan-only' : 'normal', decisions: [], outcomes: [], halted: null };
  const ctx: Ctx = { o, ledger, host, state, instanceId, runNonce, report, log };

  const lock = state.acquireLock(runNonce, o.reclaimStaleLock === true);
  if (!lock.ok) { report.halted = `lock:${lock.reason}`; return report; }
  try {
    if (!o.planOnly) {
      const r = await reconcileOutbox(ctx);
      if (r !== 'ok') { report.halted = r; return report; }
    }
    let jobsRun = 0;
    // F1: own acceptances (successful or ambiguous) this run, and the first complete server count seen.
    let ownAccepts = 0;
    let runStartCount: number | null = null;
    while (host.now() < o.untilMs && jobsRun < o.maxJobs) {
      const charterRead = await ledger.getCharter(o.charterId, o.charterVersion);
      if (!charterRead.ok) { log(`charter read failed: ${charterRead.error}`); if (o.planOnly) break; await host.sleep(30_000); continue; }
      const charter = charterRead.value;
      const body = charter.body as WorkerCharterBody;
      const pollMs = Math.max(300, body.limits?.pollIntervalSec ?? 300) * 1000;

      if (!o.planOnly) {
        const rec = await recoverOwn(ctx);
        if (report.halted) return report;
        if (rec !== 'ok') { log('recovery scan incomplete: no claims this cycle'); await host.sleep(pollMs); continue; }
        if (blockingOutbox(state)) { report.halted = 'outbox_unresolved'; return report; }
      }

      const fetched = await host.fetchOrigin();
      const fetchedAtMs = fetched ? host.now() : null;
      const harness = await host.resolveHarness();
      const after = state.scanAfter(charter.id, charter.version);

      // F1: the complete discovery/history read finishes BEFORE any claim.
      const disc = await discover(charter.id, charter.version, after);
      if (!disc.ok) {
        report.decisions.push({ threadId: '*', decision: `history_incomplete:${disc.reason}` });
        if (o.planOnly) break;
        await host.sleep(pollMs);
        continue;
      }
      runStartCount ??= disc.acceptedInWindow;

      let firstRetry: number | null = null;
      for (const j of disc.jobs) {
        let r: 'ran' | 'terminal' | 'retry';
        if (host.now() >= o.untilMs || jobsRun >= o.maxJobs) r = 'retry';
        else r = await handleCandidate(j.threadId, disc.acceptedInWindow);
        if (report.halted) return report;
        if (r === 'ran') jobsRun += 1;
        if (r === 'retry' && firstRetry === null) firstRetry = j.createdGlobalSequence;
      }
      // Advance only past candidates that reached a terminal decision; anything transient stays discoverable.
      if (!o.planOnly) state.saveScanAfter(charter.id, charter.version, firstRetry === null ? disc.nextAfter : Math.max(after, firstRetry - 1));
      if (o.planOnly) break;
      await host.sleep(pollMs);

      // -- per-candidate handling (closure over this poll cycle's snapshots) --
      async function handleCandidate(threadId: string, discoveryCount: number): Promise<'ran' | 'terminal' | 'retry'> {
        const view = await ledger.showThread(threadId);
        if (!view.ok) { report.decisions.push({ threadId, decision: `read_failed:${view.error}` }); return 'retry'; }
        const created = view.value.events.find((e) => e.eventType === 'created');
        if (!created) { report.decisions.push({ threadId, decision: 'created_event_missing' }); return 'terminal'; }
        const jobPayload = created.payload as Partial<WorkerJob>;
        const profile = (jobPayload.authProfile as 'subscription' | 'api') ?? 'subscription';
        const qualified = harness !== null && isQualified(body.qualifiedHarnesses ?? [], o.adapter, harness.sha256, configDigest(o.adapter, profile));
        const countNow = Math.max(discoveryCount, (runStartCount ?? 0) + ownAccepts);
        const decision = evaluateJobAuthority({
          workerActor: o.workerActor, nowMs: host.now(), thread: view.value.thread,
          created: { eventType: 'created', payload: created.payload, createdAt: created.createdAt },
          charter, commit: {
            exists: typeof jobPayload.commit === 'string' && host.commitExists(jobPayload.commit),
            isAncestorOfOriginMain: typeof jobPayload.commit === 'string' && host.isAncestorOfOriginMain(jobPayload.commit),
            fetchedAtMs,
          },
          history: { complete: true, acceptedInWindow: countNow },
          tree: typeof jobPayload.commit === 'string' ? host.lsTree(jobPayload.commit) : null,
          harnessQualified: qualified,
        });
        // F-B: the no-file-tools adapter embeds staged content, so its byte bounds are part of
        // eligibility (checked on Git tree sizes before claim; a job-intrinsic refusal).
        const nofiletoolsBound = decision.eligible && o.adapter === 'claude-cli-nofiletools' ? nofiletoolsSizeCheck(decision.stagingFiles) : { ok: true as const };
        if (!decision.eligible || !nofiletoolsBound.ok) {
          const reasonCode = !decision.eligible ? decision.reason : (nofiletoolsBound as { reason: string }).reason;
          report.decisions.push({ threadId, decision: `ineligible:${reasonCode}` });
          if (isJobIntrinsic(reasonCode)) {
            if (!o.planOnly && view.value.thread.intendedRecipient === o.workerActor && ['created', 'delivered'].includes(view.value.thread.state)) {
              const r = await sendRejection(ctx, view.value, reasonCode);
              if (r === 'conflict') { report.halted = 'idempotency_conflict'; return 'terminal'; }
            }
            return 'terminal';
          }
          return PERMANENT_FOR_WORKER.has(reasonCode) ? 'terminal' : 'retry';
        }
        // F4: the harness configuration must be complete BEFORE claiming (e.g. the designated API key).
        try { buildHarnessEnv(decision.job.authProfile, host.env(), o.designatedApiKey); } catch (e) {
          const reason = (e as Error).message === 'api_profile_requires_designated_key' ? 'api_key_not_configured' : 'harness_env_invalid';
          report.decisions.push({ threadId, decision: `ineligible:${reason}` });
          return 'retry';
        }
        report.decisions.push({ threadId, decision: o.planOnly ? 'eligible(plan-only: not claimed)' : 'eligible' });
        if (o.planOnly) return 'retry';
        if (blockingOutbox(state)) { report.halted = 'outbox_unresolved'; return 'retry'; }

        // F1: a fresh complete server count immediately before this claim; unknown is never zero.
        const fresh = await ledger.listJobs({ charterId: charter.id, charterVersion: charter.version, after, limit: 1 });
        if (!fresh.ok || !Number.isSafeInteger(fresh.value.acceptedInWindow)) {
          report.decisions.push({ threadId, decision: 'ineligible:history_incomplete' });
          return 'retry';
        }
        const effective = Math.max(fresh.value.acceptedInWindow, (runStartCount ?? 0) + ownAccepts);
        if (effective >= decision.charter.limits.maxJobsPerWindow) {
          report.decisions.push({ threadId, decision: 'ineligible:limit_reached' });
          return 'retry';
        }

        const seq = view.value.thread.latestSequence;
        const claimKey = claimKeyFor(instanceId, threadId, runNonce, seq);
        const entry = freezeOutboxEntry({
          key: claimKey, threadId, op: 'accept', eventType: 'accepted', content: 'Local Read-only Worker claim',
          recipientActor: null, claimKey, evidence: [],
          payload: { instanceId, runNonce, claimKey, charterId: charter.id, charterVersion: charter.version },
        });
        state.saveOutbox(entry);
        ownAccepts += 1; // counted until proven never applied
        const claimed = await claim(entry, seq);
        if (claimed === 'not_applied') { ownAccepts -= 1; return 'retry'; }
        if (claimed !== 'launch') return claimed === 'lost' ? 'terminal' : 'retry';

        state.markLaunched(claimKey);
        const outcome = await execute(threadId, decision.job, decision.stagingFiles, claimKey, harness!, charter.version);
        report.outcomes.push({ threadId, outcome });
        if (outcome === 'termination_unverified') report.halted = 'termination_unverified';
        return 'ran';
      }

      /** F4: claim with an explicit, same-key reconciliation path; never a second launch. */
      async function claim(entry: OutboxEntry, seq: number): Promise<'launch' | 'lost' | 'not_applied' | 'unresolved'> {
        const threadId = entry.threadId;
        const r = await ledger.append(threadId, 'accepted', {
          expectedSequence: seq, idempotencyKey: entry.key, content: entry.content, payload: entry.payload as Record<string, unknown>,
        });
        if (r.ok) {
          const cmp = compareEventToEntry(entry, r.event);
          if (cmp === 'mismatch') { state.saveOutbox({ ...entry, state: 'idempotency_conflict' }); report.halted = 'claim_idempotency_conflict'; return 'unresolved'; }
          if (cmp === 'match') {
            state.saveOutbox({ ...entry, state: 'sent' });
            // The ledger returned exactly this claim: it is the fence. Launch at most once per key.
            if (state.launched(entry.key)) { report.decisions.push({ threadId, decision: 'claim:already_launched' }); return 'lost'; }
            return 'launch';
          }
          // Incomplete response: equality is unproven. Read back the committed event; unknown stays unresolved.
          return readBackClaim(entry, 'claim:response_incomplete');
        }
        const cd = decideClaimOutcome({ attemptKey: entry.key, result: r, alreadyLaunchedKeys: new Set() });
        if (cd.action === 'skip') {
          // Refused by CAS/transition/participation before insertion: proven not applied.
          state.saveOutbox({ ...entry, state: 'not_applied' });
          report.decisions.push({ threadId, decision: `claim:${cd.reason}` });
          return cd.reason === 'lost_race' ? 'not_applied' : 'lost';
        }
        if (cd.action === 'halt') {
          state.saveOutbox({ ...entry, state: 'send_ambiguous' });
          report.decisions.push({ threadId, decision: `claim:halt:${cd.reason}` });
          report.halted = `claim_${cd.reason}`;
          return 'unresolved';
        }
        return readBackClaim(entry, 'claim:committed_reply_lost');
      }

      /** Reads the thread for this exact claim key; launches only on a proven, fenced match. */
      async function readBackClaim(entry: OutboxEntry, committedLabel: string): Promise<'launch' | 'lost' | 'not_applied' | 'unresolved'> {
        const threadId = entry.threadId;
        const view = await ledger.showThread(threadId);
        const unresolved = (label: string) => {
          state.saveOutbox({ ...entry, state: 'send_ambiguous' });
          report.decisions.push({ threadId, decision: label });
          report.halted = 'claim_unresolved';
          return 'unresolved' as const;
        };
        if (!view.ok) return unresolved('claim:unresolved');
        const rec = reconcileOutboxEntry(entry, view.value.events);
        if (rec === 'unverifiable') return unresolved('claim:unverifiable');
        if (rec === 'idempotency_conflict') {
          state.saveOutbox({ ...entry, state: 'idempotency_conflict' });
          report.decisions.push({ threadId, decision: 'claim:idempotency_conflict' });
          report.halted = 'claim_idempotency_conflict';
          return 'unresolved';
        }
        if (rec === 'absent') {
          // Proven absent at this read. A late commit would leave an owned, never-launched claim,
          // which recoverOwn blocks as interrupted on a later cycle; the count stays conservative.
          state.saveOutbox({ ...entry, state: 'not_applied' });
          report.decisions.push({ threadId, decision: 'claim:proven_absent' });
          return 'unresolved';
        }
        state.saveOutbox({ ...entry, state: 'sent' });
        report.decisions.push({ threadId, decision: committedLabel });
        return launchIfFenced(entry, view.value);
      }

      async function launchIfFenced(entry: OutboxEntry, view: ThreadView): Promise<'launch' | 'lost'> {
        if (state.launched(entry.key)) { report.decisions.push({ threadId: entry.threadId, decision: 'claim:already_launched' }); return 'lost'; }
        const fence = checkFence(fenceOf(view), o.workerActor, entry.key);
        if (!fence.ok) { report.decisions.push({ threadId: entry.threadId, decision: `claim:fence_${fence.reason}` }); return 'lost'; }
        return 'launch';
      }

      async function execute(threadId: string, job: WorkerJob, files: { path: string; size: number }[], claimKey: string,
        harness: { path: string; version: string; sha256: string }, charterVersion: number): Promise<string> {
        const started = host.now();
        const deadline = { run: started + job.limits.maxRuntimeSec * 1000, job: Date.parse(job.deadline), window: Date.parse(body.window.notAfter) };
        const earliest = () => Math.min(deadline.run, deadline.job, deadline.window);
        const localStop = (): 'timeout' | 'window_closed' | null => {
          const n = host.now();
          if (n >= deadline.run || n >= deadline.job) return 'timeout';
          if (n >= deadline.window) return 'window_closed';
          return null;
        };
        let staged: StagedInput | null = null;
        let preserveStaging = false;
        const fail = (failureClass: WorkerFailureClass, stage: string, ownerWritable: boolean, detail: string = failureClass, extra: Record<string, unknown> = {}) =>
          failRun(ctx, { threadId, claimKey, started, failureClass, stage, ownerWritable, detail, extra });
        try {
          try { staged = host.stage(job.commit, files); } catch (e) {
            const msg = (e as Error).message;
            const confinement = msg === 'staging_reparse_point' || msg === 'staging_escape';
            return await fail(confinement ? 'confinement_violation' : 'harness_unavailable', 'staging', true, confinement ? msg : 'staging_failed');
          }
          let launchCfg: { exe: string; args: string[]; cwd: string; env: Record<string, string> };
          try {
            launchCfg = { exe: harness.path, args: [], cwd: staged.dir, env: buildHarnessEnv(job.authProfile, host.env(), o.designatedApiKey) };
          } catch { return await fail('harness_unavailable', 'launch', true, 'harness_config_invalid'); }
          // F-B: claude-cli-nofiletools gets ONLY the approved staged baseline content, bounded and
          // UTF-8 checked; any refusal is deterministic and nothing is truncated or read live.
          let excerpts: { path: string; text: string }[] | undefined;
          if (o.adapter === 'claude-cli-nofiletools') {
            const ex = nofiletoolsExcerpts(files, staged.baseline);
            if (!ex.ok) return await fail('harness_unavailable', 'staging', true, ex.reason);
            excerpts = ex.excerpts.map(({ path, text }) => ({ path, text }));
            state.receipt(threadId, 'nofiletools_excerpts', { claimKey, files: ex.excerpts.map(({ path, sha256 }) => ({ path, sha256 })) });
          }
          try { launchCfg.args = buildHarnessArgs(job, o.adapter, buildPrompt(job, excerpts)); } catch { return await fail('harness_unavailable', 'launch', true, 'harness_config_invalid'); }
          let h: LaunchHandle;
          try { h = host.launch(launchCfg); } catch { return await fail('harness_unavailable', 'launch', true, 'launch_failed'); }

          const exit: { done: boolean; value: LaunchExit | null } = { done: false, value: null };
          const exitedP = h.exited.then((v) => { exit.done = true; exit.value = v; return v; });
          let unknown = 0;
          let lastRemote = started;
          let remote: RemotePair | null = null;
          const systemRoot = host.env().SystemRoot ?? 'C:\\Windows';
          let stop: { failureClass: WorkerFailureClass; ownerWritable: boolean; detail?: string } | null = null;
          // F5: local deadlines are enforced by their own timer; remote reads never delay them.
          // §5.6: every MONITOR_INTERVAL_MS a bounded LIST checks every job member's image.
          while (!exit.done) {
            const ls = localStop();
            if (ls) { stop = { failureClass: ls, ownerWritable: true }; break; }
            await raceTimer(host, exitedP, Math.min(MONITOR_INTERVAL_MS, earliest() - host.now()));
            if (exit.done) break;
            const ls2 = localStop();
            if (ls2) { stop = { failureClass: ls2, ownerWritable: true }; break; }

            const mon = await raceTimer(host, h.listMembers(MONITOR_LIST_TIMEOUT_MS), MONITOR_LIST_TIMEOUT_MS, exitedP);
            if (mon.kind === 'also') break; // harness exited during the LIST
            const verdict = judgeMembers(mon.kind === 'value' ? mon.value : null, harness.path, systemRoot);
            if (verdict.kind === 'unknown') {
              // An exit racing the LIST is a normal end, not a monitoring failure.
              const grace = await raceTimer(host, exitedP, MONITOR_EXIT_GRACE_MS);
              if (grace.kind === 'value') break;
              state.receipt(threadId, 'monitor_unknown', { claimKey, reason: verdict.reason });
              stop = { failureClass: 'confinement_violation', ownerWritable: true, detail: 'monitoring_unknown' };
              break;
            }
            if (verdict.kind === 'violation') {
              state.receipt(threadId, 'monitor_violation', { claimKey, images: verdict.images });
              stop = { failureClass: 'confinement_violation', ownerWritable: true, detail: 'unexpected_image' };
              break;
            }

            // Review 58d3fcaf 1.1: remote authority checks never suspend monitoring or local
            // deadlines. At most one (serialized) read pair is in flight; its result is consumed
            // on a later tick. A pair still pending after REMOTE_UNCONFIRMED_MS means no confirmed
            // authority for that long: authority_unknown (owner write deferred, as designed).
            if (remote && remote.done) {
              const [cr, tr] = remote.value!;
              remote = null;
              const fence: RemoteRead<{ currentOwner: string | null; state: string; latestAcceptedClaimKey: string | null }> = tr.ok ? { ok: true, value: fenceOf(tr.value) } : tr;
              const wd = decideWatchdog({
                nowMs: host.now(), runDeadlineMs: deadline.run, windowEndMs: deadline.window, jobDeadlineMs: deadline.job,
                charterRead: cr.ok ? { ok: true, value: { approvalState: cr.value.approvalState } } : cr,
                threadRead: fence, consecutiveUnknown: unknown, workerActor: o.workerActor, claimKey,
              });
              if (wd.action !== 'continue') { stop = { failureClass: wd.failureClass, ownerWritable: wd.ownerWritable }; break; }
              unknown = wd.consecutiveUnknown;
            } else if (remote && host.now() - remote.started >= REMOTE_UNCONFIRMED_MS) {
              state.receipt(threadId, 'remote_read_unconfirmed', { claimKey, pendingMs: host.now() - remote.started });
              stop = { failureClass: 'authority_unknown', ownerWritable: false };
              break;
            }
            if (!remote && host.now() - lastRemote >= WATCHDOG_TICK_MS) {
              lastRemote = host.now();
              const pair: RemotePair = { started: host.now(), done: false, value: null };
              void Promise.all([ledger.getCharter(o.charterId, charterVersion), ledger.showThread(threadId)])
                .then((v) => { pair.value = v; pair.done = true; }, () => { pair.value = [{ ok: false, error: 'network' }, { ok: false, error: 'network' }]; pair.done = true; });
              remote = pair;
            }
          }

          if (stop) {
            const t = await terminateBounded(host, h, exitedP);
            if (t !== 'verified') { preserveStaging = true; return await fail('termination_unverified', 'run', false); }
            return await fail(stop.failureClass, 'run', stop.ownerWritable, stop.detail);
          }

          const ev = exit.value!;
          if (ev.spawnFailed) return await fail('harness_unavailable', 'launch', true, 'launcher_spawn_failed');
          const kind = interpretLauncherExit(ev.code);
          if (kind === 'termination_unverified') { preserveStaging = true; return await fail('termination_unverified', 'run', false, 'launcher_exit_uncertain', ev.code === null ? {} : { harnessExitCode: ev.code }); }
          if (kind === 'harness_unavailable') return await fail('harness_unavailable', 'launch', true, 'launcher_setup_failed', { harnessExitCode: ev.code });
          if (kind === 'terminated_verified') return await fail('harness_unavailable', 'run', true, 'unexpected_launcher_termination', { harnessExitCode: ev.code });

          // Review item 4: any unexpected exception while validating becomes a fenced failure, never an escape.
          let prepared: { result: Record<string, unknown>; evidence: unknown[] };
          try {
            const out = h.stdout();
            if (out.overflow) return await fail('schema_invalid', 'validate', true, 'output_too_large');
            const tree = host.verifyStaged(staged);
            if (!tree.ok) return await fail('confinement_violation', 'validate', true, tree.detail);
            const v = host.validate(out.text, staged.baseline);
            if (!v.ok) return await fail(v.failureClass, 'validate', true, v.detail);
            prepared = {
              result: {
                schema: WORKER_RESULT_SCHEMA, jobThreadId: threadId, instanceId, runNonce, claimKey, charterId: job.charterId,
                charterVersion: job.charterVersion, authProfile: job.authProfile, model: job.model, harness: 'claude-cli' as const,
                harnessVersion: harness.version, harnessSha256: harness.sha256, configDigest: configDigest(o.adapter, job.authProfile),
                answer: v.answer, citations: v.citations, costTelemetryUsd: v.costTelemetryUsd, costBasis: 'client_estimate' as const,
                durationMs: Math.max(0, host.now() - started),
              },
              evidence: buildCompletionEvidence(job.commit, v.citations),
            };
          } catch {
            return await fail('schema_invalid', 'validate', true, 'validation_exception');
          }
          return await sendResult(ctx, { threadId, claimKey, started, ...prepared });
        } finally {
          if (staged) {
            if (preserveStaging) state.receipt(threadId, 'staging_preserved', { dir: staged.dir, claimKey });
            else host.removeStaging(staged.dir);
          }
        }
      }
    }
    return report;
  } finally {
    const rel = state.releaseLock();
    if (!rel.released) log(`lock not released: ${rel.reason ?? 'unknown'}`);
  }

  async function discover(charterId: string, charterVersion: number, after: number):
    Promise<{ ok: true; jobs: JobsPage['jobs']; nextAfter: number; acceptedInWindow: number } | { ok: false; reason: string }> {
    const jobs: JobsPage['jobs'] = [];
    let cursor = after;
    let count = -1;
    for (let pages = 0; pages < MAX_DISCOVERY_PAGES; pages += 1) {
      const page = await ledger.listJobs({ charterId, charterVersion, after: cursor, limit: 50 });
      if (!page.ok) return { ok: false, reason: `page_read_${page.error}` };
      if (!Number.isSafeInteger(page.value.acceptedInWindow) || page.value.acceptedInWindow < 0) return { ok: false, reason: 'count_invalid' };
      jobs.push(...page.value.jobs);
      count = Math.max(count, page.value.acceptedInWindow);
      if (page.value.complete) return { ok: true, jobs, nextAfter: page.value.nextAfter, acceptedInWindow: count };
      if (!(page.value.nextAfter > cursor)) return { ok: false, reason: 'paging_stalled' };
      cursor = page.value.nextAfter;
    }
    return { ok: false, reason: 'paging_unbounded' };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function fenceOf(v: ThreadView) {
  return { currentOwner: v.thread.currentOwner, state: v.thread.state, latestAcceptedClaimKey: latestClaimKey(v) };
}

function latestClaimKey(v: ThreadView): string | null {
  const acc = v.events.filter((e) => e.eventType === 'accepted');
  return ((acc[acc.length - 1]?.payload ?? {}) as { claimKey?: string }).claimKey ?? null;
}

function blockingOutbox(state: StateStore): boolean {
  const raw = state.outbox();
  return raw.some((e) => !isIntactOutboxEntry(e)) || outboxBlocksClaims(raw as OutboxEntry[]);
}


type DeliverOutcome = 'sent' | 'authority_lost' | 'unresolved' | 'conflict';

/** Unproven state: an entry still awaiting its own authority keeps waiting; anything else blocks claims. */
function unresolvedState(e: OutboxEntry): OutboxEntry {
  return e.state === 'awaiting_authority' ? e : { ...e, state: 'send_ambiguous' };
}

/**
 * Delivers one frozen operation (§5.7, F3). Every attempt re-reads the thread,
 * reconciles the exact key/operation/content, and — for owner writes — re-confirms
 * the claim fence before appending. Unknown authority performs no mutation.
 */
async function deliver(ctx: Ctx, entry: OutboxEntry): Promise<DeliverOutcome> {
  const { ledger, state, host, o } = ctx;
  let e = entry;
  const ownerWrite = e.op !== 'accept' && e.op !== 'rejected';
  const abandon = (reason: string, extra: Record<string, unknown> = {}): DeliverOutcome => {
    state.saveOutbox({ ...e, state: 'abandoned_authority_lost' });
    state.receipt(e.threadId, 'authority_lost_on_send', { key: e.key, op: e.op, reason, ...extra });
    return 'authority_lost';
  };
  for (;;) {
    const view = await ledger.showThread(e.threadId);
    if (!view.ok) {
      if (view.error === 'not_participant') {
        if (ownerWrite) return abandon('not_participant');
        state.saveOutbox({ ...e, state: 'not_applied' }); // a rejection comment can no longer be written
        return 'authority_lost';
      }
      state.saveOutbox(e); // unchanged and unresolved: blocks claims, reconciled on the next start
      return 'unresolved';
    }
    const rec = reconcileOutboxEntry(e, view.value.events);
    if (rec === 'sent') { state.saveOutbox({ ...e, state: 'sent' }); return 'sent'; }
    if (rec === 'idempotency_conflict') { state.saveOutbox({ ...e, state: 'idempotency_conflict' }); return 'conflict'; }
    if (rec === 'unverifiable') { state.saveOutbox(unresolvedState(e)); return 'unresolved'; }
    if (ownerWrite) {
      const fence = checkFence(fenceOf(view.value), o.workerActor, e.claimKey!);
      if (!fence.ok) return abandon(`fence_${fence.reason}`);
    }
    const r = await ledger.append(e.threadId, e.eventType, {
      expectedSequence: view.value.thread.latestSequence, idempotencyKey: e.key, content: e.content,
      payload: e.payload as Record<string, unknown>, evidence: e.evidence, ...(e.recipientActor ? { recipientActor: e.recipientActor } : {}),
    });
    if (r.ok) {
      const cmp = compareEventToEntry(e, r.event);
      if (cmp === 'mismatch') { state.saveOutbox({ ...e, state: 'idempotency_conflict' }); return 'conflict'; }
      if (cmp === 'match') { state.saveOutbox({ ...e, state: 'sent' }); return 'sent'; }
      // Review item 3: an incomplete response never proves equality. Read back the committed event.
      const back = await ledger.showThread(e.threadId);
      const brec = back.ok ? reconcileOutboxEntry(e, back.value.events) : 'unverifiable';
      if (brec === 'sent') { state.saveOutbox({ ...e, state: 'sent' }); return 'sent'; }
      if (brec === 'idempotency_conflict') { state.saveOutbox({ ...e, state: 'idempotency_conflict' }); return 'conflict'; }
      state.saveOutbox(unresolvedState(e));
      return 'unresolved';
    }
    if (['not_participant', 'invalid_transition'].includes(r.errorCode) || r.httpStatus === 403) {
      if (ownerWrite) return abandon(r.errorCode);
      state.saveOutbox({ ...e, state: 'not_applied' });
      return 'authority_lost';
    }
    e = { ...e, attempts: e.attempts + 1 };
    const d = decideResend(r.errorCode, e.attempts);
    if (d.action === 'give_up') { state.saveOutbox({ ...e, state: 'send_ambiguous' }); return 'unresolved'; }
    state.saveOutbox(e);
    if (!d.refreshSequence) await host.sleep(1000 * e.attempts);
  }
}

async function freezeAndDeliver(ctx: Ctx, op: OutboxOperation): Promise<DeliverOutcome> {
  const entry = freezeOutboxEntry(op);
  ctx.state.saveOutbox(entry);
  return deliver(ctx, entry);
}

/** One pre-claim rejection comment per instance+thread (any earlier rejection by this instance suppresses another). */
async function sendRejection(ctx: Ctx, view: ThreadView, reason: string): Promise<DeliverOutcome | 'skipped'> {
  const prefix = `lrw.${ctx.instanceId}.${view.thread.id}.rejected`;
  if (view.events.some((ev) => ev.idempotencyKey === prefix || ev.idempotencyKey?.startsWith(`${prefix}.`))) return 'skipped';
  return freezeAndDeliver(ctx, {
    key: `${prefix}.${sha256Hex(reason).slice(0, 8)}`, threadId: view.thread.id, op: 'rejected', eventType: 'comment',
    content: `Local Read-only Worker rejected this job before claim: ${reason}`, recipientActor: view.thread.originActor,
    claimKey: null, payload: { schema: WORKER_REJECTION_SCHEMA, reasonCode: reason }, evidence: [],
  });
}

function failurePayload(ctx: Ctx, a: { threadId: string; claimKey: string; started: number; stage: string; failureClass: WorkerFailureClass; detail: string; extra?: Record<string, unknown> }) {
  return {
    schema: WORKER_FAILURE_SCHEMA, jobThreadId: a.threadId, instanceId: ctx.instanceId, runNonce: ctx.runNonce, claimKey: a.claimKey,
    stage: a.stage, failureClass: a.failureClass, detail: a.detail.slice(0, 500),
    evidence: { timings: { elapsedMs: Math.max(0, Math.trunc(ctx.host.now() - a.started)) }, ...(a.extra ?? {}) },
  };
}

/**
 * A stopped/failed run. Owner-writable failures become a validated, fenced
 * `blocked` event; otherwise (or if the failure itself is unsendable) only a
 * local receipt is kept and that thread's pending owner writes are abandoned.
 */
async function failRun(ctx: Ctx, a: { threadId: string; claimKey: string; started: number; failureClass: WorkerFailureClass; stage: string; ownerWritable: boolean; detail: string; extra: Record<string, unknown> }): Promise<string> {
  const payload = failurePayload(ctx, a);
  const valid = workerFailureSchema.safeParse(payload).success && assertSendablePayload(payload).ok;
  if (a.failureClass === 'authority_unknown' && valid) {
    // Review item 2 / §5.6: preserve the exact blocked failure bound to THIS claim; it is
    // delivered only once that claim's authority is re-confirmed (recoverOwn), else abandoned.
    ctx.state.receipt(a.threadId, a.failureClass, payload);
    ctx.state.saveOutbox({
      ...freezeOutboxEntry({
        key: writeKeyFor(ctx.instanceId, a.threadId, 'blocked', a.claimKey), threadId: a.threadId, op: 'blocked', eventType: 'blocked',
        content: 'Local Read-only Worker stopped: authority_unknown', recipientActor: null, claimKey: a.claimKey, payload, evidence: [],
      }),
      state: 'awaiting_authority',
    });
    return a.failureClass;
  }
  if (!a.ownerWritable || !valid) {
    ctx.state.receipt(a.threadId, a.failureClass, payload);
    for (const raw of ctx.state.outbox()) {
      if (isIntactOutboxEntry(raw) && raw.threadId === a.threadId && raw.claimKey === a.claimKey && raw.state === 'pending' && raw.op !== 'accept') {
        ctx.state.saveOutbox({ ...raw, state: 'abandoned_authority_lost' });
      }
    }
    return a.failureClass;
  }
  const d = await freezeAndDeliver(ctx, {
    key: writeKeyFor(ctx.instanceId, a.threadId, 'blocked', a.claimKey), threadId: a.threadId, op: 'blocked', eventType: 'blocked',
    content: `Local Read-only Worker stopped: ${a.failureClass}`, recipientActor: null, claimKey: a.claimKey, payload, evidence: [],
  });
  if (d === 'conflict') ctx.report.halted = 'idempotency_conflict';
  if (d === 'unresolved') return 'send_unresolved';
  if (d === 'authority_lost') return 'authority_lost';
  return a.failureClass;
}

/**
 * F2: a result is completed only if the full result payload is schema-valid and
 * sendable. Otherwise the job is BLOCKED with a sendable failure and no
 * completion evidence — never a completed transition carrying a failure payload.
 */
async function sendResult(ctx: Ctx, a: { threadId: string; claimKey: string; started: number; result: Record<string, unknown>; evidence: unknown[] }): Promise<string> {
  const schemaOk = workerResultSchema.safeParse(a.result).success;
  const safe = schemaOk ? assertSendablePayload({ payload: a.result, evidence: a.evidence }) : { ok: false as const, reason: 'result_schema_invalid' };
  if (!safe.ok) {
    return failRun(ctx, { threadId: a.threadId, claimKey: a.claimKey, started: a.started, failureClass: 'schema_invalid', stage: 'send', ownerWritable: true, detail: safe.reason, extra: {} });
  }
  const d = await freezeAndDeliver(ctx, {
    key: writeKeyFor(ctx.instanceId, a.threadId, 'completed', a.claimKey), threadId: a.threadId, op: 'completed', eventType: 'completed',
    content: 'Local Read-only Worker result', recipientActor: null, claimKey: a.claimKey, payload: a.result, evidence: a.evidence,
  });
  if (d === 'conflict') { ctx.report.halted = 'idempotency_conflict'; return 'idempotency_conflict'; }
  return d === 'sent' ? 'completed' : d === 'authority_lost' ? 'authority_lost' : 'send_unresolved';
}

/** F5: TERMINATE via the launcher, bounded; then kill the launcher via its own handle, bounded. Only an observed clean exit is verified. */
async function terminateBounded(host: HostPort, h: LaunchHandle, exitedP: Promise<LaunchExit>): Promise<'verified' | 'unverified'> {
  const clean = (code: number | null) => code === 0 || code === 80 || (code !== null && code >= 70 && code <= 78);
  if (h.terminate()) {
    const r = await raceTimer(host, exitedP, TERMINATE_WAIT_MS);
    if (r.kind === 'value') return clean(r.value.code) && !r.value.spawnFailed ? 'verified' : 'unverified';
  }
  h.killLauncher();
  await raceTimer(host, exitedP, KILL_WAIT_MS);
  return 'unverified';
}

// ---------------------------------------------------------------------------
// Start-of-run reconciliation and recovery
// ---------------------------------------------------------------------------

/** §5.7: every unresolved entry is reconciled before any new claim, replaying its exact frozen bytes. */
async function reconcileOutbox(ctx: Ctx): Promise<'ok' | string> {
  const { state, ledger } = ctx;
  const raw = state.outbox();
  if (raw.some((e) => !isIntactOutboxEntry(e))) return 'outbox_corrupt';
  for (const e of raw as OutboxEntry[]) {
    if (e.state === 'idempotency_conflict') return 'idempotency_conflict';
    if (e.state !== 'pending' && e.state !== 'send_ambiguous') continue;
    if (e.op === 'accept') {
      // A claim is never re-sent at start: committed -> recovery blocks it as interrupted; absent -> never applied.
      const view = await ledger.showThread(e.threadId);
      if (!view.ok) return 'outbox_unresolved';
      const rec = reconcileOutboxEntry(e, view.value.events);
      if (rec === 'idempotency_conflict') { state.saveOutbox({ ...e, state: 'idempotency_conflict' }); return 'idempotency_conflict'; }
      if (rec === 'unverifiable') return 'outbox_unresolved';
      state.saveOutbox({ ...e, state: rec === 'sent' ? 'sent' : 'not_applied' });
      continue;
    }
    const d = await deliver(ctx, { ...e, attempts: 0 });
    if (d === 'conflict') return 'idempotency_conflict';
    if (d === 'unresolved') return 'outbox_unresolved';
  }
  return blockingOutbox(state) ? 'outbox_unresolved' : 'ok';
}

/**
 * §5.9 and F4: threads this worker owns whose latest acceptance carries this
 * instanceId and that are still active have no running execution at this point
 * (execution is synchronous), so they are blocked as interrupted — including a
 * claim from THIS run whose reply was lost. Never re-executed. Threads with an
 * unresolved outbox write for that claim are left to the outbox.
 */
async function recoverOwn(ctx: Ctx): Promise<'ok' | 'incomplete'> {
  const { ledger, state, o } = ctx;
  // Review item 2: a frozen authority_unknown failure is written once its exact claim is
  // re-confirmed (deliver re-fences); a lost or superseded claim abandons it; unknown keeps waiting.
  for (const e of state.outbox().filter(isIntactOutboxEntry) as OutboxEntry[]) {
    if (e.state !== 'awaiting_authority') continue;
    const d = await deliver(ctx, e);
    if (d === 'conflict') { ctx.report.halted = 'idempotency_conflict'; return 'ok'; }
    if (d !== 'unresolved') ctx.report.outcomes.push({ threadId: e.threadId, outcome: d === 'sent' ? 'recovered_authority_unknown' : `authority_unknown_${d}` });
  }
  let after = 0;
  const candidates: { threadId: string; view: ThreadView }[] = [];
  for (let pages = 0; ; pages += 1) {
    if (pages >= MAX_DISCOVERY_PAGES) return 'incomplete';
    const page = await ledger.listJobs({ charterId: o.charterId, charterVersion: o.charterVersion, after, limit: 100 });
    if (!page.ok) return 'incomplete';
    for (const j of page.value.jobs) {
      const v = await ledger.showThread(j.threadId);
      if (v.ok) candidates.push({ threadId: j.threadId, view: v.value });
      else if (v.error !== 'not_participant') return 'incomplete';
    }
    if (page.value.complete) break;
    if (!(page.value.nextAfter > after)) return 'incomplete';
    after = page.value.nextAfter;
  }
  const own = selectOwnRecoveries(candidates.map((c) => {
    const acc = c.view.events.filter((e) => e.eventType === 'accepted');
    return { threadId: c.threadId, state: c.view.thread.state, currentOwner: c.view.thread.currentOwner, latestAcceptedPayload: (acc[acc.length - 1]?.payload ?? null) as Record<string, unknown> | null };
  }), o.workerActor, ctx.instanceId);
  const unresolved = new Set((state.outbox().filter(isIntactOutboxEntry) as OutboxEntry[])
    .filter((e) => e.op !== 'accept' && (e.state === 'pending' || e.state === 'send_ambiguous' || e.state === 'awaiting_authority')).map((e) => e.claimKey));
  for (const threadId of own) {
    const c = candidates.find((x) => x.threadId === threadId)!;
    const claimKey = latestClaimKey(c.view);
    if (!claimKey || unresolved.has(claimKey)) continue;
    const d = await freezeAndDeliver(ctx, {
      key: writeKeyFor(ctx.instanceId, threadId, 'interrupted', claimKey), threadId, op: 'interrupted', eventType: 'blocked',
      content: 'Local Read-only Worker: this claim ended without a terminal result; not re-executed', recipientActor: null, claimKey,
      payload: failurePayload(ctx, { threadId, claimKey, started: ctx.host.now(), stage: 'recovery', failureClass: 'interrupted', detail: 'interrupted' }),
      evidence: [],
    });
    if (d === 'conflict') { ctx.report.halted = 'idempotency_conflict'; return 'ok'; }
    ctx.report.outcomes.push({ threadId, outcome: d === 'sent' ? 'recovered_interrupted' : `recovery_${d}` });
  }
  return 'ok';
}
