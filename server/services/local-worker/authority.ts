/**
 * Local Read-only Worker v1 — pre-claim authority evaluation (design §5.2).
 *
 * Pure and fail-closed: every input is a snapshot gathered by the supervisor
 * (thread, created event, live charter record, git checks, server-computed
 * history, qualification). Inbox delivery, free text and backlog are never
 * consulted. The first failing condition is reported as a stable reason code.
 */
import {
  WORKER_JOB_SCHEMA, charterBodyDigest, parseWorkerJob, validateWorkerCharterBody,
  type WorkerCharterBody, type WorkerJob,
} from '../../../shared/worker-contracts';
import { selectStagingFiles, type TreeEntry } from './paths';

export type ThreadSnapshot = {
  id: string;
  state: string;
  originActor: string;
  intendedRecipient: string;
  currentOwner: string | null;
  latestSequence: number;
  sourceReference: { type?: string } | null;
};

export type CreatedEventSnapshot = { eventType: string; payload: unknown; createdAt: string };

export type CharterRecord = {
  id: string;
  version: number;
  body: unknown;
  bodyDigest: string;
  approvalState: 'draft' | 'approved' | 'revoked';
  approvedAt: string | null;
};

export type CommitCheck = { exists: boolean; isAncestorOfOriginMain: boolean; fetchedAtMs: number | null };
export type HistoryCount = { complete: boolean; acceptedInWindow: number | null };

export type AuthorityInput = {
  workerActor: string;
  nowMs: number;
  thread: ThreadSnapshot;
  created: CreatedEventSnapshot;
  charter: CharterRecord | null;
  commit: CommitCheck;
  history: HistoryCount;
  tree: readonly TreeEntry[] | null;
  /** Result of the §6.3 qualification gate for the job's adapter configuration. */
  harnessQualified: boolean;
};

export type AuthorityDecision =
  | { eligible: true; job: WorkerJob; charter: WorkerCharterBody; stagingFiles: { path: string; size: number }[] }
  | { eligible: false; reason: string };

const no = (reason: string): AuthorityDecision => ({ eligible: false, reason });

export function evaluateJobAuthority(input: AuthorityInput): AuthorityDecision {
  const { thread, created, charter, nowMs } = input;

  // 1. Addressed to this worker, unclaimed, in a claimable state.
  if (thread.intendedRecipient !== input.workerActor) return no('not_addressed_to_worker');
  if (!['created', 'delivered'].includes(thread.state)) return no('thread_state_not_claimable');
  if (thread.currentOwner !== null) return no('thread_already_owned');
  // 3. agent_note-sourced threads carry linked-outcome obligations: never worker jobs.
  if (thread.sourceReference?.type === 'agent_note') return no('agent_note_source_rejected');

  // 4. Structured job envelope on the created event.
  if (created.eventType !== 'created') return no('created_event_missing');
  const payload = created.payload as { schema?: unknown } | null;
  if (!payload || payload.schema !== WORKER_JOB_SCHEMA) return no('not_a_worker_job');
  const parsed = parseWorkerJob(payload, created.createdAt);
  if (!parsed.ok) return no(parsed.reason);
  const job = parsed.value;

  // 5. Live, approved, unrevoked charter whose stored digest matches its body.
  if (!charter) return no('charter_unavailable');
  if (charter.id !== job.charterId || charter.version !== job.charterVersion) return no('charter_mismatch');
  if (charter.approvalState !== 'approved') return no(charter.approvalState === 'revoked' ? 'charter_revoked' : 'charter_not_approved');
  const body = validateWorkerCharterBody(charter.body);
  if (!body.ok) return no(body.reason);
  if (charterBodyDigest(body.value) !== charter.bodyDigest) return no('charter_digest_mismatch');
  const c = body.value;
  if (c.workerActor !== input.workerActor) return no('charter_worker_mismatch');

  // 2. Originator (server-derived thread.originActor, never a payload field).
  if (!c.originators.includes(thread.originActor)) return no('originator_not_allowed');

  // 6. Created after approval and inside the window; now inside the window.
  const createdMs = Date.parse(created.createdAt);
  const approvedMs = charter.approvedAt ? Date.parse(charter.approvedAt) : Number.NaN;
  const windowStart = Date.parse(c.window.notBefore);
  const windowEnd = Date.parse(c.window.notAfter);
  if (!(createdMs > approvedMs)) return no('job_predates_charter_approval');
  if (createdMs < windowStart || createdMs >= windowEnd) return no('job_created_outside_window');
  if (nowMs < windowStart || nowMs >= windowEnd) return no('window_closed');

  // 7. Kind, model, profile and limits within the charter.
  if (!c.kinds.includes(job.kind)) return no('kind_not_allowed');
  if (!c.models.includes(job.model)) return no('model_not_allowed');
  if (!c.authProfiles.includes(job.authProfile)) return no('auth_profile_not_allowed');
  if (job.limits.maxRuntimeSec > c.limits.maxRuntimeSec) return no('runtime_exceeds_charter');
  if (job.authProfile === 'api' && (job.limits.maxApiBudgetUsd ?? Infinity) > c.limits.maxApiBudgetUsdPerJob) {
    return no('api_budget_exceeds_charter');
  }

  // 10. Deadline.
  if (Date.parse(job.deadline) <= nowMs) return no('deadline_passed');

  // 9. Commit present, ancestor of origin/main, fetched within one poll interval.
  if (!input.commit.exists) return no('commit_missing');
  if (!input.commit.isAncestorOfOriginMain) return no('commit_not_on_origin_main');
  if (input.commit.fetchedAtMs === null || nowMs - input.commit.fetchedAtMs > c.limits.pollIntervalSec * 1000) {
    return no('origin_fetch_stale');
  }

  // 11. Window limit from the complete server-computed history; unknown is never zero.
  if (!input.history.complete || input.history.acceptedInWindow === null) return no('history_incomplete');
  if (input.history.acceptedInWindow >= c.limits.maxJobsPerWindow) return no('limit_reached');

  // 12. Qualified executable + configuration (§6.3); empty list refuses by design.
  if (!input.harnessQualified) return no('unqualified_harness');

  // 8. Path expansion over the commit tree, then allowlist and denylists.
  if (!input.tree) return no('tree_unavailable');
  const staging = selectStagingFiles({ tree: input.tree, jobPatterns: job.paths, allowlist: c.pathAllowlist, denylist: c.pathDenylist });
  if (!staging.ok) return no(staging.reason);

  return { eligible: true, job, charter: c, stagingFiles: staging.files };
}
