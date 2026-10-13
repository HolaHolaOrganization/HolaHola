/**
 * Local Read-only Worker v1 contracts.
 *
 * Design authority: shared-spec document bb6c6c06-7628-47d3-a71e-40d8836f4ead,
 * revision b8fe5e66-5189-4ace-ba5d-dc205ed28e31 (sha256 3f89e075...), approved
 * for "code and isolated tests only" by luca-replit (coordination event a8ff11fb).
 *
 * Every schema is strict: unknown fields are rejected and sizes are bounded.
 * This module is deliberately standalone (no server or database imports) so the
 * supervisor, routes and fixtures can all validate with the same pure functions.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const WORKER_JOB_SCHEMA = 'hh.worker.job.v1' as const;
export const WORKER_RESULT_SCHEMA = 'hh.worker.result.v1' as const;
export const WORKER_FAILURE_SCHEMA = 'hh.worker.failure.v1' as const;
export const WORKER_REJECTION_SCHEMA = 'hh.worker.rejection.v1' as const;
export const WORKER_CHARTER_SCHEMA = 'hh.worker.charter.v1' as const;

export const WORKER_REPOSITORY = 'davidwmcintosh/HolaHola' as const;
export const WORKER_JOB_KINDS = ['doc_inspect', 'code_analysis'] as const;
export const WORKER_AUTH_PROFILES = ['subscription', 'api'] as const;
export const WORKER_ADAPTERS = ['claude-cli', 'claude-cli-nofiletools'] as const;

/** Design §6.1: always denied, even when a charter omits them. */
export const WORKER_MINIMUM_DENYLIST: readonly string[] = Object.freeze([
  '.env*',
  '*.pem',
  '*.key',
  '*.pfx',
  '.claude/**',
  '.local/**',
  'attached_assets/**',
  '**/*secret*',
  '**/*credential*',
  '**/*token*',
]);

/** Design §5.8: closed failure enum. */
export const WORKER_FAILURE_CLASSES = [
  'authority_rejected', 'claim_conflict', 'authority_lost', 'authority_unknown',
  'unqualified_harness', 'harness_unavailable', 'auth_required',
  'timeout', 'cancelled', 'charter_revoked', 'window_closed', 'limit_reached',
  'schema_invalid', 'citation_mismatch', 'confinement_violation',
  'termination_unverified', 'interrupted', 'send_ambiguous', 'idempotency_conflict',
] as const;
export type WorkerFailureClass = typeof WORKER_FAILURE_CLASSES[number];

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z][a-z0-9-]{0,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|bearer\s+[A-Za-z0-9._-]{8,}|password\s*[:=]|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

const isoDate = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v), 'iso_timestamp');

// ---------------------------------------------------------------------------
// Question normalisation (design §3.1)
// ---------------------------------------------------------------------------

export type QuestionCheck = { ok: true; value: string } | { ok: false; reason: string };

/** NFC-normalises; rejects C0/C1 controls except \n and \t, and lone surrogates. */
export function normalizeWorkerQuestion(raw: unknown): QuestionCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'question_not_string' };
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) {
    return { ok: false, reason: 'question_lone_surrogate' };
  }
  const value = raw.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value)) {
    return { ok: false, reason: 'question_control_character' };
  }
  if (value.trim().length === 0) return { ok: false, reason: 'question_empty' };
  if (value.length > 4000) return { ok: false, reason: 'question_too_long' };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Path patterns (design §3.1 / §6.1). Matching itself lives in the supervisor.
// ---------------------------------------------------------------------------

const PATH_PATTERN = z.string().min(1).max(200).refine((p) => {
  if (p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return (p.match(/\*\*/g) ?? []).length <= 2;
}, 'path_pattern_invalid');

// ---------------------------------------------------------------------------
// Result schema registry (design §3.1: a fixed in-code registry)
// ---------------------------------------------------------------------------

export const WORKER_RESULT_SCHEMAS = {
  'answer-with-citations.v1': {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings', 'citations'],
    properties: {
      summary: { type: 'string', maxLength: 4000 },
      findings: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['statement'],
          properties: { statement: { type: 'string', maxLength: 1000 } },
        },
      },
      citations: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['path', 'startLine', 'endLine'],
          properties: {
            path: { type: 'string', maxLength: 200 },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
} as const;
export type WorkerResultSchemaId = keyof typeof WORKER_RESULT_SCHEMAS;
const RESULT_SCHEMA_IDS = Object.keys(WORKER_RESULT_SCHEMAS) as [WorkerResultSchemaId, ...WorkerResultSchemaId[]];

/** Runtime shape of the registered 'answer-with-citations.v1' structured output. */
export const answerWithCitationsSchema = z.object({
  summary: z.string().max(4000),
  findings: z.array(z.object({ statement: z.string().max(1000) }).strict()).max(20),
  citations: z.array(z.object({
    path: z.string().min(1).max(200),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  }).strict().refine((c) => c.endLine >= c.startLine, 'citation_range_inverted')).max(20),
}).strict();

// ---------------------------------------------------------------------------
// Job envelope (design §3.1)
// ---------------------------------------------------------------------------

export const workerJobSchema = z.object({
  schema: z.literal(WORKER_JOB_SCHEMA),
  kind: z.enum(WORKER_JOB_KINDS),
  repository: z.literal(WORKER_REPOSITORY),
  commit: z.string().regex(HEX40),
  paths: z.array(PATH_PATTERN).min(1).max(20),
  question: z.string().min(1).max(4000),
  resultSchemaId: z.enum(RESULT_SCHEMA_IDS),
  authProfile: z.enum(WORKER_AUTH_PROFILES),
  model: z.string().regex(MODEL),
  limits: z.object({
    maxRuntimeSec: z.number().int().min(30).max(3600),
    maxApiBudgetUsd: z.number().positive().max(100).optional(),
  }).strict(),
  charterId: z.string().regex(UUID),
  charterVersion: z.number().int().min(1),
  deadline: isoDate,
}).strict();
export type WorkerJob = z.infer<typeof workerJobSchema>;

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Strict parse plus question normalisation; createdAt bounds the deadline (<= 24h). */
export function parseWorkerJob(payload: unknown, createdAt: string): ParseOutcome<WorkerJob> {
  const parsed = workerJobSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: `job_schema_invalid:${parsed.error.issues[0]?.path.join('.') || 'root'}` };
  const question = normalizeWorkerQuestion(parsed.data.question);
  if (!question.ok) return { ok: false, reason: question.reason };
  const created = Date.parse(createdAt);
  const deadline = Date.parse(parsed.data.deadline);
  if (Number.isNaN(created)) return { ok: false, reason: 'job_created_at_invalid' };
  if (deadline <= created || deadline - created > 24 * 3600_000) return { ok: false, reason: 'job_deadline_out_of_bounds' };
  if (parsed.data.authProfile === 'api' && parsed.data.limits.maxApiBudgetUsd === undefined) {
    return { ok: false, reason: 'job_api_budget_required' };
  }
  return { ok: true, value: { ...parsed.data, question: question.value } };
}

/**
 * Narrow gate for structured payloads on thread creation (design §4.3): the only
 * payload a created event may carry through the HTTP create route is a strictly
 * valid worker job, checked against the current time. Anything else is refused so
 * reserved payload kinds cannot be injected through thread creation.
 */
export function validateCreatePayload(payload: unknown, nowIso: string): ParseOutcome<WorkerJob> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'payload_not_object' };
  if ((payload as { schema?: unknown }).schema !== WORKER_JOB_SCHEMA) return { ok: false, reason: 'payload_schema_not_supported' };
  return parseWorkerJob(payload, nowIso);
}

// ---------------------------------------------------------------------------
// Charter (design §3.4)
// ---------------------------------------------------------------------------

export const qualifiedHarnessSchema = z.object({
  adapter: z.enum(WORKER_ADAPTERS),
  executableSha256: z.string().regex(HEX64),
  version: z.string().min(1).max(40),
  configDigest: z.string().regex(HEX64),
  qualificationRef: z.string().min(1).max(200),
}).strict();
export type QualifiedHarness = z.infer<typeof qualifiedHarnessSchema>;

export const workerCharterBodySchema = z.object({
  schema: z.literal(WORKER_CHARTER_SCHEMA),
  workerActor: z.string().regex(ACTOR),
  host: z.string().min(1).max(64),
  originators: z.array(z.string().regex(ACTOR)).min(1).max(10),
  kinds: z.array(z.enum(WORKER_JOB_KINDS)).min(1),
  pathAllowlist: z.array(PATH_PATTERN).min(1).max(64),
  pathDenylist: z.array(PATH_PATTERN).max(64),
  authProfiles: z.array(z.enum(WORKER_AUTH_PROFILES)).min(1),
  models: z.array(z.string().regex(MODEL)).min(1).max(10),
  qualifiedHarnesses: z.array(qualifiedHarnessSchema).max(10),
  limits: z.object({
    maxJobsPerWindow: z.number().int().min(1).max(1000),
    maxRuntimeSec: z.number().int().min(30).max(3600),
    maxApiBudgetUsdPerJob: z.number().positive().max(100),
    pollIntervalSec: z.number().int().min(300).max(86_400),
  }).strict(),
  window: z.object({ notBefore: isoDate, notAfter: isoDate }).strict(),
}).strict();
export type WorkerCharterBody = z.infer<typeof workerCharterBodySchema>;

const MAX_WINDOW_MS = 30 * 24 * 3600_000;

/** Strict charter validation including the §3.4 server-side invariants. */
export function validateWorkerCharterBody(body: unknown): ParseOutcome<WorkerCharterBody> {
  const parsed = workerCharterBodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: `charter_schema_invalid:${parsed.error.issues[0]?.path.join('.') || 'root'}` };
  const c = parsed.data;
  const missing = WORKER_MINIMUM_DENYLIST.filter((d) => !c.pathDenylist.includes(d));
  if (missing.length > 0) return { ok: false, reason: 'charter_minimum_denylist_missing' };
  const start = Date.parse(c.window.notBefore);
  const end = Date.parse(c.window.notAfter);
  if (!(end > start) || end - start > MAX_WINDOW_MS) return { ok: false, reason: 'charter_window_invalid' };
  for (const list of [c.originators, c.kinds, c.authProfiles, c.models, c.pathAllowlist, c.pathDenylist]) {
    if (new Set(list as readonly string[]).size !== list.length) return { ok: false, reason: 'charter_duplicate_entry' };
  }
  return { ok: true, value: c };
}

// ---------------------------------------------------------------------------
// Result, failure, rejection payloads (design §3.2, §3.3)
// ---------------------------------------------------------------------------

const citationRecord = z.object({
  path: z.string().min(1).max(200),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  excerptSha256: z.string().regex(HEX64),
  excerpt: z.string().max(2000),
}).strict();
export type WorkerCitationRecord = z.infer<typeof citationRecord>;

export const workerResultSchema = z.object({
  schema: z.literal(WORKER_RESULT_SCHEMA),
  jobThreadId: z.string().min(1).max(64),
  instanceId: z.string().regex(UUID),
  runNonce: z.string().regex(UUID),
  claimKey: z.string().min(8).max(255),
  charterId: z.string().regex(UUID),
  charterVersion: z.number().int().min(1),
  authProfile: z.enum(WORKER_AUTH_PROFILES),
  model: z.string().regex(MODEL),
  harness: z.literal('claude-cli'),
  harnessVersion: z.string().min(1).max(40),
  harnessSha256: z.string().regex(HEX64),
  configDigest: z.string().regex(HEX64),
  answer: z.unknown(),
  citations: z.array(citationRecord).max(20),
  costTelemetryUsd: z.number().min(0).max(1000),
  costBasis: z.literal('client_estimate'),
  durationMs: z.number().int().min(0),
}).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const workerFailureSchema = z.object({
  schema: z.literal(WORKER_FAILURE_SCHEMA),
  jobThreadId: z.string().min(1).max(64),
  instanceId: z.string().regex(UUID),
  runNonce: z.string().regex(UUID),
  claimKey: z.string().min(8).max(255),
  stage: z.enum(['authority', 'claim', 'staging', 'launch', 'run', 'validate', 'send', 'recovery']),
  failureClass: z.enum(WORKER_FAILURE_CLASSES),
  detail: z.string().max(500),
  evidence: z.object({
    citationsCollected: z.array(citationRecord).max(20).optional(),
    harnessExitCode: z.number().int().optional(),
    timings: z.record(z.string().max(40), z.number().int().min(0)).refine((t) => Object.keys(t).length <= 16, 'too_many_timings'),
  }).strict(),
}).strict();
export type WorkerFailure = z.infer<typeof workerFailureSchema>;

export const workerRejectionSchema = z.object({
  schema: z.literal(WORKER_REJECTION_SCHEMA),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_:.-]{0,119}$/),
}).strict();

/** Size cap (bytes of canonical JSON) for any payload the worker writes. */
export const WORKER_PAYLOAD_MAX_BYTES = 60_000;

/** Fails when serialized size or a secret-like pattern makes a payload unsafe to send. */
export function assertSendablePayload(payload: unknown): ParseOutcome<string> {
  const json = canonicalJson(payload);
  if (Buffer.byteLength(json, 'utf8') > WORKER_PAYLOAD_MAX_BYTES) return { ok: false, reason: 'payload_too_large' };
  if (SECRET_PATTERN.test(json)) return { ok: false, reason: 'payload_secret_pattern' };
  return { ok: true, value: json };
}

// ---------------------------------------------------------------------------
// Canonical JSON and digests
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively; arrays keep order; undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical_json_non_finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Design §3.4: sha256 of the canonical JSON of the entire charter body. */
export function charterBodyDigest(body: WorkerCharterBody): string {
  return sha256Hex(canonicalJson(body));
}

// ---------------------------------------------------------------------------
// Completion evidence (design §3.5)
// ---------------------------------------------------------------------------

export type WorkerEvidenceReference = {
  type: 'commit' | 'repository_path';
  provider: 'git';
  identifier: string;
  digest?: string;
};

export function buildCompletionEvidence(commit: string, citations: readonly WorkerCitationRecord[]): WorkerEvidenceReference[] {
  if (!HEX40.test(commit)) throw new Error('evidence_commit_invalid');
  return [
    { type: 'commit', provider: 'git', identifier: commit },
    ...citations.slice(0, 20).map((c): WorkerEvidenceReference => ({
      type: 'repository_path',
      provider: 'git',
      identifier: `${WORKER_REPOSITORY}@${commit}:${c.path}#L${c.startLine}-L${c.endLine}`,
      digest: `sha256:${c.excerptSha256}`,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Idempotency keys (design §5.3, §5.4)
// ---------------------------------------------------------------------------

export function claimKeyFor(instanceId: string, threadId: string, runNonce: string, observedSequence: number): string {
  return `lrw.${instanceId}.${threadId}.accept.${runNonce}.${observedSequence}`;
}

export function writeKeyFor(instanceId: string, threadId: string, op: 'completed' | 'blocked' | 'rejected' | 'progress' | 'interrupted', claimKey: string): string {
  return `lrw.${instanceId}.${threadId}.${op}.${sha256Hex(claimKey).slice(0, 8)}`;
}
